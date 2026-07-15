import type { CastMember } from "../members";
import type { LingoPropList, LingoValue } from "../values";
import type { DirectorSoundMedia } from "./media";

export const DIRECTOR_SOUND_CHANNEL_COUNT = 8;
export const DIRECTOR_SOUND_VOLUME_MAX = 255;
export const DIRECTOR_SOUND_LEVEL_MAX = 7;
export const DIRECTOR_SOUND_PAN_MIN = -100;
export const DIRECTOR_SOUND_PAN_MAX = 100;

export type DirectorSoundStatus = 0 | 1 | 2 | 3 | 4;

export interface DirectorSoundEntry {
  readonly source: LingoPropList;
  readonly member: CastMember;
  readonly media: DirectorSoundMedia;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly loopCount: number;
  readonly loopStartTimeMs: number;
  readonly loopEndTimeMs: number;
  readonly preloadTimeMs: number;
}

export interface DirectorSoundEntryResolver {
  resolve(value: LingoValue, queued: boolean): DirectorSoundEntry | null;
}

export interface DirectorSoundPlaybackRequest {
  readonly channelNumber: number;
  readonly token: number;
  readonly entry: DirectorSoundEntry;
  /** Director-visible playlist entries that follow the active sound. The
   * backend may schedule these ahead of time, but the channel remains the
   * authority for observable playlist and timing state. */
  readonly queuedEntries: readonly DirectorSoundEntry[];
  readonly elapsedMs: number;
  readonly volume: number;
  readonly pan: number;
  readonly onStarted: () => void;
  readonly onEnded: () => void;
  readonly onError: (error: unknown) => void;
  readonly onQueueError: (entry: DirectorSoundEntry, error: unknown) => void;
}

export interface DirectorSoundBackend {
  readonly kind: string;
  readonly deviceName: string;
  /** Backend render clock when one exists. Reading this must not create or
   * resume an audio device. */
  currentTimeMs?(): number | null;
  preload(entry: DirectorSoundEntry): Promise<void>;
  play(request: DirectorSoundPlaybackRequest): void;
  /** Replace the future schedule for an active request without interrupting
   * the sound currently being rendered. */
  syncQueue(channelNumber: number, token: number, queuedEntries: readonly DirectorSoundEntry[]): void;
  stop(channelNumber: number): void;
  setChannelVolume(channelNumber: number, volume: number, rampMs?: number): void;
  setChannelPan(channelNumber: number, pan: number): void;
  setMasterGain(gain: number): void;
  resume(): Promise<void>;
  dispose(): void;
}

export interface DirectorSoundChannelSnapshot {
  readonly number: number;
  readonly status: DirectorSoundStatus;
  readonly memberName: string | null;
  readonly elapsedTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly loopCount: number;
  readonly loopStartTime: number;
  readonly loopEndTime: number;
  readonly loopsRemaining: number;
  readonly sampleCount: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly sampleSize: number;
  readonly volume: number;
  readonly pan: number;
  readonly queued: number;
}
