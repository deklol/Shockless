import { LingoList, LingoPropList, LINGO_VOID, type LingoObjectLike, type LingoValue } from "../values";
import type { DirectorAudioClock } from "./clock";
import {
  directorSoundBreakLoopDurationMs,
  directorSoundDurationMs,
  directorSoundTimelinePosition,
} from "./playbackTimeline";
import {
  DIRECTOR_SOUND_PAN_MAX,
  DIRECTOR_SOUND_PAN_MIN,
  DIRECTOR_SOUND_VOLUME_MAX,
  type DirectorSoundBackend,
  type DirectorSoundChannelSnapshot,
  type DirectorSoundEntry,
  type DirectorSoundEntryResolver,
  type DirectorSoundStatus,
} from "./types";

interface DirectorSoundFade {
  readonly from: number;
  readonly to: number;
  readonly startedAtMs: number;
  readonly durationMs: number;
}

export class SoundChannelRef implements LingoObjectLike {
  readonly lingoType = "instance";
  private queueEntries: DirectorSoundEntry[] = [];
  private current: DirectorSoundEntry | null = null;
  private state: DirectorSoundStatus = 0;
  private startedAtMs = 0;
  private elapsedBeforeStartMs = 0;
  private forcedEndElapsedMs: number | null = null;
  private token = 0;
  private pendingPreloads = 0;
  private preloadGeneration = 0;
  private lockedSampleRate = 0;
  private lockedChannelCount = 0;
  private lockedSampleSize = 0;
  private channelVolume = DIRECTOR_SOUND_VOLUME_MAX;
  private lastNonzeroVolume = DIRECTOR_SOUND_VOLUME_MAX;
  private channelPan = 0;
  private pendingPan: number | null = null;
  private fade: DirectorSoundFade | null = null;

  constructor(
    public readonly number: number,
    private readonly entries: DirectorSoundEntryResolver,
    private readonly backend: DirectorSoundBackend,
    private readonly clock: DirectorAudioClock,
    private readonly reportError: (message: string, error?: unknown) => void,
  ) {
    this.backend.setChannelVolume(number, this.channelVolume);
    this.backend.setChannelPan(number, this.channelPan);
  }

  get status(): DirectorSoundStatus {
    this.update();
    return this.state;
  }

  get member(): LingoValue {
    this.update();
    return this.current?.member ?? LINGO_VOID;
  }

  get volume(): number {
    this.updateFade();
    return Math.round(this.channelVolume);
  }

  set volume(value: number) {
    this.setVolume(value);
  }

  get pan(): number {
    this.updateFade();
    return this.channelPan;
  }

  set pan(value: number) {
    const next = clamp(Math.round(value), DIRECTOR_SOUND_PAN_MIN, DIRECTOR_SOUND_PAN_MAX);
    if (this.fade) {
      this.pendingPan = next;
      return;
    }
    this.channelPan = next;
    this.backend.setChannelPan(this.number, next);
  }

  get elapsedTime(): number {
    this.update();
    return Math.round(this.currentElapsedMs());
  }

  get startTime(): number {
    return Math.round(this.current?.startTimeMs ?? 0);
  }

  get endTime(): number {
    return Math.round(this.current?.endTimeMs ?? 0);
  }

  get loopCount(): number {
    return this.current?.loopCount ?? 0;
  }

  get loopStartTime(): number {
    return Math.round(this.current?.loopStartTimeMs ?? 0);
  }

  get loopEndTime(): number {
    return Math.round(this.current?.loopEndTimeMs ?? 0);
  }

  get loopsRemaining(): number {
    if (!this.current) return 0;
    return directorSoundTimelinePosition(this.current, this.currentElapsedMs()).loopsRemaining;
  }

  get sampleCount(): number {
    return this.current?.media.sampleCount ?? 0;
  }

  get sampleRate(): number {
    return this.lockedSampleRate;
  }

  get channelCount(): number {
    return this.lockedChannelCount;
  }

  get sampleSize(): number {
    return this.lockedSampleSize;
  }

  get preLoadTime(): number {
    return this.current?.preloadTimeMs ?? 0;
  }

  setPlayList(list: LingoValue): number {
    const generation = ++this.preloadGeneration;
    this.queueEntries = [];
    this.pendingPreloads = 0;
    if (!this.current) this.releaseFormatLock();
    if (list instanceof LingoList) {
      for (const value of list.items) {
        const entry = this.entries.resolve(value, true);
        if (entry) this.enqueue(entry, generation);
      }
    }
    this.syncBackendQueue();
    this.syncIdleState();
    return 1;
  }

  getPlayList(): LingoList {
    return new LingoList(this.queueEntries.map((entry) => duplicatePropList(entry.source)));
  }

  play(item: LingoValue = LINGO_VOID): number {
    if (item !== LINGO_VOID) {
      const entry = this.entries.resolve(item, false);
      if (!entry) return 0;
      this.begin(entry, 0);
      return 1;
    }
    if (this.current && this.state === 4) {
      this.startBackend(this.current, this.elapsedBeforeStartMs);
      return 1;
    }
    if (this.current && (this.state === 1 || this.state === 3)) return 1;
    const next = this.queueEntries.shift();
    if (!next) {
      this.syncIdleState();
      return 0;
    }
    this.begin(next, 0);
    return 1;
  }

  queue(item: LingoValue): number {
    const entry = this.entries.resolve(item, true);
    if (!entry) return 0;
    this.enqueue(entry);
    return 1;
  }

  pause(): number {
    this.update();
    if (!this.current || (this.state !== 1 && this.state !== 3)) return 0;
    this.elapsedBeforeStartMs = this.currentElapsedMs();
    this.token += 1;
    this.backend.stop(this.number);
    this.state = 4;
    return 1;
  }

  rewind(): number {
    if (!this.current) return 0;
    const paused = this.state === 4;
    this.elapsedBeforeStartMs = 0;
    this.forcedEndElapsedMs = null;
    this.token += 1;
    this.backend.stop(this.number);
    if (paused) {
      this.state = 4;
    } else {
      this.startBackend(this.current, 0);
    }
    return 1;
  }

  playNext(): number {
    this.token += 1;
    this.backend.stop(this.number);
    this.current = null;
    this.elapsedBeforeStartMs = 0;
    this.forcedEndElapsedMs = null;
    const next = this.queueEntries.shift();
    if (next) {
      this.begin(next, 0);
      return 1;
    }
    this.releaseFormatLock();
    this.syncIdleState();
    return 0;
  }

  breakLoop(): number {
    this.update();
    if (!this.current) return 0;
    const elapsed = this.currentElapsedMs();
    if (this.current.loopCount === 1 || this.forcedEndElapsedMs !== null) return 1;
    const position = directorSoundTimelinePosition(this.current, elapsed);
    this.forcedEndElapsedMs = elapsed + directorSoundBreakLoopDurationMs(this.current, elapsed);
    const backendEntry: DirectorSoundEntry = {
      ...this.current,
      startTimeMs: position.mediaTimeMs,
      loopCount: 1,
      loopStartTimeMs: position.mediaTimeMs,
      loopEndTimeMs: this.current.endTimeMs,
    };
    this.token += 1;
    this.backend.stop(this.number);
    this.startBackend(backendEntry, 0, elapsed);
    return 1;
  }

  stop(): number {
    this.token += 1;
    this.backend.stop(this.number);
    this.current = null;
    this.elapsedBeforeStartMs = 0;
    this.forcedEndElapsedMs = null;
    this.releaseFormatLock();
    this.syncIdleState();
    return 1;
  }

  isBusy(): number {
    this.update();
    return this.current && this.state === 3 ? 1 : 0;
  }

  fadeIn(durationMs = 1000): number {
    const target = this.lastNonzeroVolume || DIRECTOR_SOUND_VOLUME_MAX;
    this.channelVolume = 0;
    this.backend.setChannelVolume(this.number, 0);
    return this.beginFade(target, durationMs);
  }

  fadeOut(durationMs = 1000): number {
    if (this.channelVolume > 0) this.lastNonzeroVolume = this.channelVolume;
    return this.beginFade(0, durationMs);
  }

  fadeTo(volume: number, durationMs = 1000): number {
    return this.beginFade(volume, durationMs);
  }

  update(): void {
    this.updateFade();
    if (!this.current || this.state !== 3) return;
    let elapsed = this.currentElapsedMs();
    let duration = this.forcedEndElapsedMs ?? directorSoundDurationMs(this.current);
    while (this.current && Number.isFinite(duration) && elapsed >= duration) {
      const overrunMs = Math.max(0, elapsed - duration);
      const next = this.queueEntries.shift();
      if (!next) {
        this.completeSequence(this.token);
        return;
      }
      this.current = next;
      this.forcedEndElapsedMs = null;
      this.elapsedBeforeStartMs = 0;
      this.startedAtMs = this.clock.nowMs() - overrunMs;
      this.state = 3;
      this.syncBackendQueue();
      elapsed = overrunMs;
      duration = directorSoundDurationMs(next);
    }
  }

  snapshot(): DirectorSoundChannelSnapshot {
    this.update();
    return {
      number: this.number,
      status: this.state,
      memberName: this.current?.member.name ?? null,
      elapsedTime: this.elapsedTime,
      startTime: this.startTime,
      endTime: this.endTime,
      loopCount: this.loopCount,
      loopStartTime: this.loopStartTime,
      loopEndTime: this.loopEndTime,
      loopsRemaining: this.loopsRemaining,
      sampleCount: this.sampleCount,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      sampleSize: this.sampleSize,
      volume: this.volume,
      pan: this.pan,
      queued: this.queueEntries.length,
    };
  }

  dispose(): void {
    this.preloadGeneration += 1;
    this.pendingPreloads = 0;
    this.queueEntries = [];
    this.stop();
  }

  lingoToString(): string {
    return `(sound ${this.number})`;
  }

  private enqueue(entry: DirectorSoundEntry, generation = this.preloadGeneration): void {
    this.queueEntries.push(entry);
    this.lockFormat(entry);
    this.pendingPreloads += 1;
    if (!this.current) this.state = 1;
    void this.backend.preload(entry).then(
      () => this.finishPreload(generation),
      (error) => {
        if (generation !== this.preloadGeneration) return;
        this.reportError(`sound ${this.number} preload failed for ${entry.member.name}`, error);
        this.finishPreload(generation);
      },
    );
    this.syncBackendQueue();
  }

  private finishPreload(generation: number): void {
    if (generation !== this.preloadGeneration) return;
    this.pendingPreloads = Math.max(0, this.pendingPreloads - 1);
    this.syncIdleState();
  }

  private begin(entry: DirectorSoundEntry, elapsedMs: number): void {
    this.token += 1;
    this.backend.stop(this.number);
    this.current = entry;
    this.forcedEndElapsedMs = null;
    this.lockFormat(entry);
    this.startBackend(entry, elapsedMs);
  }

  private startBackend(entry: DirectorSoundEntry, elapsedMs: number, publicElapsedMs = elapsedMs): void {
    const requestToken = ++this.token;
    this.elapsedBeforeStartMs = Math.max(0, publicElapsedMs);
    this.state = 1;
    this.backend.play({
      channelNumber: this.number,
      token: requestToken,
      entry,
      queuedEntries: [...this.queueEntries],
      elapsedMs: Math.max(0, elapsedMs),
      volume: this.channelVolume,
      pan: this.channelPan,
      onStarted: () => {
        if (requestToken !== this.token || !this.current) return;
        this.startedAtMs = this.clock.nowMs();
        this.state = 3;
      },
      onEnded: () => this.completeSequence(requestToken),
      onError: (error) => {
        if (requestToken !== this.token) return;
        this.reportError(`sound ${this.number} playback failed for ${entry.member.name}`, error);
        this.completeSequence(requestToken);
      },
      onQueueError: (failedEntry, error) => {
        if (requestToken !== this.token) return;
        const index = this.queueEntries.indexOf(failedEntry);
        if (index < 0) return;
        this.queueEntries.splice(index, 1);
        this.reportError(`sound ${this.number} queued playback failed for ${failedEntry.member.name}`, error);
        this.syncBackendQueue();
      },
    });
  }

  private completeSequence(requestToken: number): void {
    if (requestToken !== this.token || !this.current) return;
    this.token += 1;
    this.backend.stop(this.number);
    this.current = null;
    this.queueEntries = [];
    this.elapsedBeforeStartMs = 0;
    this.forcedEndElapsedMs = null;
    this.releaseFormatLock();
    this.syncIdleState();
  }

  private syncBackendQueue(): void {
    if (!this.current || (this.state !== 1 && this.state !== 3)) return;
    this.backend.syncQueue(this.number, this.token, [...this.queueEntries]);
  }

  private currentElapsedMs(): number {
    if (!this.current) return 0;
    if (this.state === 3) {
      return this.elapsedBeforeStartMs + Math.max(0, this.clock.nowMs() - this.startedAtMs);
    }
    return this.elapsedBeforeStartMs;
  }

  private setVolume(value: number): void {
    this.fade = null;
    const next = clamp(Math.round(value), 0, DIRECTOR_SOUND_VOLUME_MAX);
    this.channelVolume = next;
    if (next > 0) this.lastNonzeroVolume = next;
    this.backend.setChannelVolume(this.number, next);
    this.applyPendingPan();
  }

  private beginFade(target: number, durationMs: number): number {
    this.updateFade();
    const to = clamp(Math.round(target), 0, DIRECTOR_SOUND_VOLUME_MAX);
    const duration = Math.max(0, Math.round(durationMs));
    if (to > 0) this.lastNonzeroVolume = to;
    if (duration === 0) {
      this.setVolume(to);
      return 1;
    }
    this.fade = {
      from: this.channelVolume,
      to,
      startedAtMs: this.clock.nowMs(),
      durationMs: duration,
    };
    this.backend.setChannelVolume(this.number, to, duration);
    return 1;
  }

  private updateFade(): void {
    const fade = this.fade;
    if (!fade) return;
    const progress = clamp((this.clock.nowMs() - fade.startedAtMs) / fade.durationMs, 0, 1);
    this.channelVolume = fade.from + (fade.to - fade.from) * progress;
    if (progress < 1) return;
    this.channelVolume = fade.to;
    this.fade = null;
    this.applyPendingPan();
  }

  private applyPendingPan(): void {
    if (this.pendingPan === null) return;
    this.channelPan = this.pendingPan;
    this.pendingPan = null;
    this.backend.setChannelPan(this.number, this.channelPan);
  }

  private lockFormat(entry: DirectorSoundEntry): void {
    if (this.lockedSampleRate !== 0) return;
    this.lockedSampleRate = entry.media.sampleRate;
    this.lockedChannelCount = entry.media.channels;
    this.lockedSampleSize = entry.media.sampleSize ?? 0;
  }

  private releaseFormatLock(): void {
    this.lockedSampleRate = 0;
    this.lockedChannelCount = 0;
    this.lockedSampleSize = 0;
  }

  private syncIdleState(): void {
    if (this.current) return;
    if (this.pendingPreloads > 0) this.state = 1;
    else if (this.queueEntries.length > 0) this.state = 2;
    else this.state = 0;
  }
}

function duplicatePropList(source: LingoPropList): LingoPropList {
  return LingoPropList.fromPairs(source.keys.map((key, index) => [key, source.values[index] ?? LINGO_VOID]));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
