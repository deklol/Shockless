import {
  directorSoundDurationMs,
  directorSoundTailStartElapsedMs,
  directorSoundTimelinePosition,
} from "./playbackTimeline";
import {
  DIRECTOR_SOUND_PAN_MAX,
  DIRECTOR_SOUND_VOLUME_MAX,
  type DirectorSoundBackend,
  type DirectorSoundEntry,
  type DirectorSoundPlaybackRequest,
} from "./types";

interface WebAudioScheduledEntry {
  readonly entry: DirectorSoundEntry;
  readonly startAt: number;
  readonly endAt: number;
  readonly sources: AudioBufferSourceNode[];
  readonly finalSource: AudioBufferSourceNode | null;
}

interface WebAudioChannelState {
  readonly generation: number;
  readonly token: number;
  readonly request: DirectorSoundPlaybackRequest;
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  readonly scheduled: WebAudioScheduledEntry[];
  syncRevision: number;
}

interface PendingWebAudioQueue {
  readonly token: number;
  readonly entries: readonly DirectorSoundEntry[];
  readonly revision: number;
}

export interface WebAudioBackendOptions {
  readonly contextFactory?: () => AudioContext;
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

/** Production backend. Director timing remains in DirectorSoundChannel; this
 * class owns only browser decoding, node scheduling, and audible mixing. */
export class WebAudioBackend implements DirectorSoundBackend {
  readonly kind = "web-audio";
  readonly deviceName = "Web Audio";
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterGain = 1;
  private readonly generations = new Map<number, number>();
  private readonly channels = new Map<number, WebAudioChannelState>();
  private readonly pendingQueues = new Map<number, PendingWebAudioQueue>();
  private readonly decodeCache = new Map<string, Promise<AudioBuffer>>();
  private readonly volumes = new Map<number, number>();
  private readonly pans = new Map<number, number>();

  constructor(private readonly options: WebAudioBackendOptions = {}) {}

  currentTimeMs(): number | null {
    return this.context ? this.context.currentTime * 1_000 : null;
  }

  async preload(entry: DirectorSoundEntry): Promise<void> {
    await this.decode(entry);
  }

  play(request: DirectorSoundPlaybackRequest): void {
    this.stop(request.channelNumber);
    const generation = this.nextGeneration(request.channelNumber);
    this.pendingQueues.set(request.channelNumber, {
      token: request.token,
      entries: [...request.queuedEntries],
      revision: 0,
    });
    void this.start(request, generation).catch((error) => {
      if (generation !== this.generationFor(request.channelNumber)) return;
      this.stop(request.channelNumber);
      request.onError(error);
    });
  }

  syncQueue(channelNumber: number, token: number, queuedEntries: readonly DirectorSoundEntry[]): void {
    const previous = this.pendingQueues.get(channelNumber);
    const revision = previous?.token === token ? previous.revision + 1 : 1;
    const snapshot: PendingWebAudioQueue = { token, entries: [...queuedEntries], revision };
    this.pendingQueues.set(channelNumber, snapshot);
    const state = this.channels.get(channelNumber);
    if (!state || state.token !== token) return;
    state.syncRevision = revision;
    if (queuedEntries.length > 0) this.clearFinalCompletion(state);
    void this.synchronizeFuture(state, snapshot).catch((error) => {
      if (this.channels.get(channelNumber) !== state || state.syncRevision !== revision) return;
      state.request.onError(error);
    });
  }

  stop(channelNumber: number): void {
    this.nextGeneration(channelNumber);
    this.pendingQueues.delete(channelNumber);
    const state = this.channels.get(channelNumber);
    if (!state) return;
    this.channels.delete(channelNumber);
    for (const scheduled of state.scheduled) this.stopScheduledEntry(scheduled);
    state.gain.disconnect();
    state.pan.disconnect();
  }

  setChannelVolume(channelNumber: number, volume: number, rampMs = 0): void {
    const normalized = clamp(volume, 0, DIRECTOR_SOUND_VOLUME_MAX);
    this.volumes.set(channelNumber, normalized);
    const state = this.channels.get(channelNumber);
    const context = this.context;
    if (!state || !context) return;
    const gain = normalized / DIRECTOR_SOUND_VOLUME_MAX;
    state.gain.gain.cancelScheduledValues(context.currentTime);
    state.gain.gain.setValueAtTime(state.gain.gain.value, context.currentTime);
    if (rampMs > 0) {
      state.gain.gain.linearRampToValueAtTime(gain, context.currentTime + rampMs / 1000);
    } else {
      state.gain.gain.setValueAtTime(gain, context.currentTime);
    }
  }

  setChannelPan(channelNumber: number, pan: number): void {
    const normalized = clamp(pan, -DIRECTOR_SOUND_PAN_MAX, DIRECTOR_SOUND_PAN_MAX);
    this.pans.set(channelNumber, normalized);
    const state = this.channels.get(channelNumber);
    const context = this.context;
    if (!state || !context) return;
    state.pan.pan.setValueAtTime(normalized / DIRECTOR_SOUND_PAN_MAX, context.currentTime);
  }

  setMasterGain(gain: number): void {
    this.masterGain = clamp(gain, 0, 1);
    if (this.master && this.context) {
      this.master.gain.setValueAtTime(this.masterGain, this.context.currentTime);
    }
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  dispose(): void {
    for (const channelNumber of [...this.channels.keys()]) this.stop(channelNumber);
    this.generations.clear();
    this.pendingQueues.clear();
    this.decodeCache.clear();
    const context = this.context;
    this.context = null;
    this.master = null;
    if (context && context.state !== "closed") void context.close();
  }

  private async start(request: DirectorSoundPlaybackRequest, generation: number): Promise<void> {
    const [context, buffer] = await Promise.all([this.playbackContext(), this.decode(request.entry)]);
    if (generation !== this.generationFor(request.channelNumber) || this.channels.has(request.channelNumber)) return;

    const initialQueue = this.pendingQueues.get(request.channelNumber);

    const gain = context.createGain();
    const pan = context.createStereoPanner();
    gain.gain.setValueAtTime(
      (this.volumes.get(request.channelNumber) ?? request.volume) / DIRECTOR_SOUND_VOLUME_MAX,
      context.currentTime,
    );
    pan.pan.setValueAtTime(
      (this.pans.get(request.channelNumber) ?? request.pan) / DIRECTOR_SOUND_PAN_MAX,
      context.currentTime,
    );
    gain.connect(pan);
    pan.connect(this.ensureMaster());
    const state: WebAudioChannelState = {
      generation,
      token: request.token,
      request,
      gain,
      pan,
      scheduled: [],
      syncRevision: initialQueue?.revision ?? 0,
    };
    this.channels.set(request.channelNumber, state);

    let scheduleAt = context.currentTime;
    const current = this.scheduleEntry(request.entry, request.elapsedMs, buffer, scheduleAt, context, gain);
    if (!current) {
      this.stop(request.channelNumber);
      request.onStarted();
      request.onEnded();
      return;
    }
    state.scheduled.push(current);
    request.onStarted();

    const latest = this.pendingQueues.get(request.channelNumber);
    if (latest && latest.token === request.token) {
      state.syncRevision = latest.revision;
      if (latest.entries.length === 0) this.bindFinalCompletion(state);
      void this.synchronizeFuture(state, latest).catch((error) => {
        if (this.channels.get(request.channelNumber) !== state) return;
        request.onError(error);
      });
    } else {
      this.bindFinalCompletion(state);
    }
  }

  private scheduleEntry(
    entry: DirectorSoundEntry,
    elapsedMs: number,
    buffer: AudioBuffer,
    when: number,
    context: AudioContext,
    gain: GainNode,
  ): WebAudioScheduledEntry | null {
    const elapsed = Math.max(0, elapsedMs);
    const position = directorSoundTimelinePosition(entry, elapsed);
    if (position.complete) return null;
    const offset = clamp(position.mediaTimeMs / 1000, 0, buffer.duration);
    const end = clamp(entry.endTimeMs / 1000, offset, buffer.duration);
    const sources: AudioBufferSourceNode[] = [];

    if (entry.loopCount === 0) {
      const source = this.createSource(buffer, gain, sources, context);
      source.loop = true;
      source.loopStart = clamp(entry.loopStartTimeMs / 1000, 0, buffer.duration);
      source.loopEnd = clamp(entry.loopEndTimeMs / 1000, source.loopStart, buffer.duration);
      source.start(when, offset);
      return { entry, startAt: when, endAt: Number.POSITIVE_INFINITY, sources, finalSource: null };
    }

    const totalDuration = directorSoundDurationMs(entry);
    if (elapsed >= totalDuration) return null;
    const tailStart = directorSoundTailStartElapsedMs(entry);
    const tailDurationSeconds = Math.max(0, (entry.endTimeMs - entry.loopEndTimeMs) / 1000);
    const loopDurationSeconds = Math.max(0, (entry.loopEndTimeMs - entry.loopStartTimeMs) / 1000);
    const endAt = when + Math.max(0, totalDuration - elapsed) / 1000;
    if (entry.loopCount > 1 && loopDurationSeconds > 0 && elapsed < tailStart) {
      const loopSource = this.createSource(buffer, gain, sources, context);
      loopSource.loop = true;
      loopSource.loopStart = clamp(entry.loopStartTimeMs / 1000, 0, buffer.duration);
      loopSource.loopEnd = clamp(entry.loopEndTimeMs / 1000, loopSource.loopStart, buffer.duration);
      const tailAt = when + (tailStart - elapsed) / 1000;
      loopSource.start(when, offset);
      loopSource.stop(tailAt);
      if (tailDurationSeconds <= 0) {
        return { entry, startAt: when, endAt, sources, finalSource: loopSource };
      }
      const tailSource = this.createSource(buffer, gain, sources, context);
      tailSource.start(tailAt, loopSource.loopEnd, tailDurationSeconds);
      return { entry, startAt: when, endAt, sources, finalSource: tailSource };
    }

    const source = this.createSource(buffer, gain, sources, context);
    const duration = Math.max(0, end - offset);
    if (duration <= 0) return null;
    source.start(when, offset, duration);
    return { entry, startAt: when, endAt, sources, finalSource: source };
  }

  private createSource(
    buffer: AudioBuffer,
    gain: GainNode,
    sources: AudioBufferSourceNode[],
    context: AudioContext,
  ): AudioBufferSourceNode {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    sources.push(source);
    return source;
  }

  private async synchronizeFuture(state: WebAudioChannelState, pending: PendingWebAudioQueue): Promise<void> {
    if (state.token !== pending.token || this.channels.get(state.request.channelNumber) !== state) return;
    const decoded = await Promise.all(
      pending.entries.map(async (entry) => {
        try {
          return { entry, buffer: await this.decode(entry) } as const;
        } catch (error) {
          state.request.onQueueError(entry, error);
          return { entry, buffer: null } as const;
        }
      }),
    );
    if (
      state.token !== pending.token ||
      state.syncRevision !== pending.revision ||
      this.channels.get(state.request.channelNumber) !== state
    ) {
      return;
    }

    const context = this.ensureContext();
    const now = context.currentTime;
    const currentIndex = activeScheduledIndex(state.scheduled, now);
    const keepThrough = currentIndex >= 0 ? currentIndex : Math.max(0, state.scheduled.length - 1);
    const current = state.scheduled[keepThrough];
    if (!current) return;
    const existingFuture = state.scheduled.slice(keepThrough + 1).map((scheduled) => scheduled.entry);
    if (sameEntries(existingFuture, pending.entries)) return;

    for (const scheduled of state.scheduled.splice(keepThrough + 1)) this.stopScheduledEntry(scheduled);
    let scheduleAt = current.endAt;
    for (const item of decoded) {
      if (!Number.isFinite(scheduleAt)) continue;
      const intendedStart = scheduleAt;
      const intendedEnd = intendedStart + directorSoundDurationMs(item.entry) / 1_000;
      scheduleAt = intendedEnd;
      if (!item.buffer) continue;
      const elapsedMs = Math.max(0, (now - intendedStart) * 1_000);
      const scheduled = this.scheduleEntry(
        item.entry,
        elapsedMs,
        item.buffer,
        Math.max(intendedStart, now),
        context,
        state.gain,
      );
      if (!scheduled) continue;
      state.scheduled.push(scheduled);
    }
    this.bindFinalCompletion(state);
  }

  private bindFinalCompletion(state: WebAudioChannelState): void {
    this.clearFinalCompletion(state);
    const final = state.scheduled[state.scheduled.length - 1];
    if (!final?.finalSource || !Number.isFinite(final.endAt)) return;
    if (this.context && final.endAt <= this.context.currentTime) {
      queueMicrotask(() => this.completeState(state));
      return;
    }
    final.finalSource.onended = () => this.completeState(state);
  }

  private clearFinalCompletion(state: WebAudioChannelState): void {
    for (const scheduled of state.scheduled) {
      if (scheduled.finalSource) scheduled.finalSource.onended = null;
    }
  }

  private completeState(state: WebAudioChannelState): void {
    if (this.channels.get(state.request.channelNumber) !== state) return;
    this.channels.delete(state.request.channelNumber);
    this.pendingQueues.delete(state.request.channelNumber);
    for (const scheduled of state.scheduled) {
      for (const source of scheduled.sources) source.disconnect();
    }
    state.gain.disconnect();
    state.pan.disconnect();
    state.request.onEnded();
  }

  private stopScheduledEntry(scheduled: WebAudioScheduledEntry): void {
    for (const source of scheduled.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // An already-ended AudioBufferSourceNode cannot be stopped twice.
      }
      source.disconnect();
    }
  }

  private async decode(entry: DirectorSoundEntry): Promise<AudioBuffer> {
    const key = entry.media.assetSha256 || entry.media.assetUrl;
    let promise = this.decodeCache.get(key);
    if (!promise) {
      promise = this.decodeUrl(entry.media.assetUrl);
      this.decodeCache.set(key, promise);
      void promise.catch(() => this.decodeCache.delete(key));
    }
    return promise;
  }

  private async decodeUrl(url: string): Promise<AudioBuffer> {
    if (!url) throw new Error("Director sound asset URL is empty");
    const bytes = this.options.fetchBytes
      ? await this.options.fetchBytes(url)
      : await fetchBytes(url);
    return this.ensureContext().decodeAudioData(bytes.slice(0));
  }

  private async playbackContext(): Promise<AudioContext> {
    const context = this.ensureContext();
    // Scheduling against a suspended context is valid and preserves the
    // Director channel state until a trusted input event resumes audio.
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    const factory = this.options.contextFactory ?? defaultAudioContextFactory;
    this.context = factory();
    this.master = this.context.createGain();
    this.master.gain.setValueAtTime(this.masterGain, this.context.currentTime);
    this.master.connect(this.context.destination);
    return this.context;
  }

  private ensureMaster(): GainNode {
    this.ensureContext();
    return this.master!;
  }

  private generationFor(channelNumber: number): number {
    return this.generations.get(channelNumber) ?? 0;
  }

  private nextGeneration(channelNumber: number): number {
    const generation = this.generationFor(channelNumber) + 1;
    this.generations.set(channelNumber, generation);
    return generation;
  }
}

function defaultAudioContextFactory(): AudioContext {
  const Constructor = globalThis.AudioContext;
  if (!Constructor) throw new Error("Web Audio is unavailable in this runtime");
  return new Constructor({ latencyHint: "interactive" });
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Director sound fetch failed: HTTP ${response.status} ${url}`);
  return response.arrayBuffer();
}

function activeScheduledIndex(entries: readonly WebAudioScheduledEntry[], now: number): number {
  const epsilon = 0.005;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.startAt <= now + epsilon && entry.endAt > now - epsilon) return index;
  }
  return -1;
}

function sameEntries(left: readonly DirectorSoundEntry[], right: readonly DirectorSoundEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
