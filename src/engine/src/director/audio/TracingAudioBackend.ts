import type { DirectorAudioClock } from "./clock";
import type {
  DirectorSoundBackend,
  DirectorSoundEntry,
  DirectorSoundPlaybackRequest,
} from "./types";

export interface DirectorAudioTraceContext {
  readonly profileId?: string;
}

export interface DirectorAudioTraceEntry {
  readonly castName: string;
  readonly castNumber: number;
  readonly memberNumber: number;
  readonly memberSlot: number;
  readonly memberName: string;
  readonly container: string;
  readonly codec: string;
  readonly sourceFourCC: string | null;
  readonly assetPath: string;
}

export interface DirectorAudioTraceEvent {
  readonly sequence: number;
  readonly monotonicMs: number;
  readonly backendTimeMs: number | null;
  readonly profileId: string | null;
  readonly backend: string;
  readonly operation: string;
  readonly channelNumber?: number;
  readonly token?: number;
  readonly entry?: DirectorAudioTraceEntry;
  readonly queuedEntries?: DirectorAudioTraceEntry[];
  readonly elapsedMs?: number;
  readonly volume?: number;
  readonly pan?: number;
  readonly rampMs?: number;
  readonly gain?: number;
  readonly error?: string;
}

type TraceEventInput = Omit<
  DirectorAudioTraceEvent,
  "sequence" | "monotonicMs" | "backendTimeMs" | "profileId" | "backend"
>;

/** Bounded, disabled-by-default diagnostics. It records backend boundaries
 * without participating in Director channel state or browser scheduling. */
export class DirectorAudioTraceBuffer {
  private enabled = false;
  private sequence = 0;
  private context: DirectorAudioTraceContext = {};
  private readonly events: DirectorAudioTraceEvent[] = [];

  constructor(
    private readonly clock: DirectorAudioClock,
    private readonly capacity = 2_048,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setContext(context: DirectorAudioTraceContext): void {
    this.context = { ...context };
  }

  clear(): void {
    this.events.length = 0;
  }

  snapshot(): readonly DirectorAudioTraceEvent[] {
    return this.events.map((event) => ({
      ...event,
      entry: event.entry ? { ...event.entry } : undefined,
      queuedEntries: event.queuedEntries?.map((entry) => ({ ...entry })),
    }));
  }

  exportJson(): string {
    return `${JSON.stringify({ schemaVersion: 1, events: this.snapshot() }, null, 2)}\n`;
  }

  record(backend: DirectorSoundBackend, event: TraceEventInput): void {
    if (!this.enabled) return;
    this.sequence += 1;
    this.events.push({
      sequence: this.sequence,
      monotonicMs: this.clock.nowMs(),
      backendTimeMs: backend.currentTimeMs?.() ?? null,
      profileId: this.context.profileId ?? null,
      backend: backend.kind,
      ...event,
    });
    const overflow = this.events.length - this.capacity;
    if (overflow > 0) this.events.splice(0, overflow);
  }
}

/** Transparent backend decorator used by both Web Audio and virtual/headless
 * playback. All Director-visible state remains owned by SoundChannelRef. */
export class TracingAudioBackend implements DirectorSoundBackend {
  readonly kind: string;
  readonly deviceName: string;

  constructor(
    private readonly backend: DirectorSoundBackend,
    private readonly trace: DirectorAudioTraceBuffer,
  ) {
    this.kind = backend.kind;
    this.deviceName = backend.deviceName;
  }

  currentTimeMs(): number | null {
    return this.backend.currentTimeMs?.() ?? null;
  }

  async preload(entry: DirectorSoundEntry): Promise<void> {
    this.record({ operation: "preload", entry: describeEntry(entry) });
    try {
      await this.backend.preload(entry);
      this.record({ operation: "preload-complete", entry: describeEntry(entry) });
    } catch (error) {
      this.record({ operation: "preload-error", entry: describeEntry(entry), error: errorText(error) });
      throw error;
    }
  }

  play(request: DirectorSoundPlaybackRequest): void {
    this.record({
      operation: "play",
      channelNumber: request.channelNumber,
      token: request.token,
      entry: describeEntry(request.entry),
      queuedEntries: request.queuedEntries.map(describeEntry),
      elapsedMs: request.elapsedMs,
      volume: request.volume,
      pan: request.pan,
    });
    this.backend.play({
      ...request,
      onStarted: () => {
        this.record({
          operation: "started",
          channelNumber: request.channelNumber,
          token: request.token,
          entry: describeEntry(request.entry),
        });
        request.onStarted();
      },
      onEnded: () => {
        this.record({
          operation: "ended",
          channelNumber: request.channelNumber,
          token: request.token,
          entry: describeEntry(request.entry),
        });
        request.onEnded();
      },
      onError: (error) => {
        this.record({
          operation: "play-error",
          channelNumber: request.channelNumber,
          token: request.token,
          entry: describeEntry(request.entry),
          error: errorText(error),
        });
        request.onError(error);
      },
      onQueueError: (entry, error) => {
        this.record({
          operation: "queue-error",
          channelNumber: request.channelNumber,
          token: request.token,
          entry: describeEntry(entry),
          error: errorText(error),
        });
        request.onQueueError(entry, error);
      },
    });
  }

  syncQueue(channelNumber: number, token: number, queuedEntries: readonly DirectorSoundEntry[]): void {
    this.record({
      operation: "sync-queue",
      channelNumber,
      token,
      queuedEntries: queuedEntries.map(describeEntry),
    });
    this.backend.syncQueue(channelNumber, token, queuedEntries);
  }

  stop(channelNumber: number): void {
    this.record({ operation: "stop", channelNumber });
    this.backend.stop(channelNumber);
  }

  setChannelVolume(channelNumber: number, volume: number, rampMs = 0): void {
    this.record({ operation: "volume", channelNumber, volume, rampMs });
    this.backend.setChannelVolume(channelNumber, volume, rampMs);
  }

  setChannelPan(channelNumber: number, pan: number): void {
    this.record({ operation: "pan", channelNumber, pan });
    this.backend.setChannelPan(channelNumber, pan);
  }

  setMasterGain(gain: number): void {
    this.record({ operation: "master-gain", gain });
    this.backend.setMasterGain(gain);
  }

  async resume(): Promise<void> {
    this.record({ operation: "resume" });
    try {
      await this.backend.resume();
      this.record({ operation: "resume-complete" });
    } catch (error) {
      this.record({ operation: "resume-error", error: errorText(error) });
      throw error;
    }
  }

  dispose(): void {
    this.record({ operation: "dispose" });
    this.backend.dispose();
  }

  private record(event: TraceEventInput): void {
    this.trace.record(this.backend, event);
  }
}

function describeEntry(entry: DirectorSoundEntry): DirectorAudioTraceEntry {
  return {
    castName: entry.member.castName,
    castNumber: entry.member.castNumber,
    memberNumber: entry.member.number,
    memberSlot: entry.member.slotNumber,
    memberName: entry.member.name,
    container: entry.media.container,
    codec: entry.media.codec,
    sourceFourCC: entry.media.sourceFourCC ?? null,
    assetPath: entry.media.assetPath,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
