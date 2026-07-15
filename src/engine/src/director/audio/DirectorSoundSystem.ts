import { CastMember } from "../members";
import * as ops from "../ops";
import {
  LINGO_VOID,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoVoid,
  isNumber,
  numberOf,
  type LingoObjectLike,
  type LingoValue,
} from "../values";
import type { DirectorAudioClock } from "./clock";
import { SoundChannelRef } from "./DirectorSoundChannel";
import {
  DIRECTOR_SOUND_CHANNEL_COUNT,
  DIRECTOR_SOUND_LEVEL_MAX,
  type DirectorSoundBackend,
  type DirectorSoundChannelSnapshot,
  type DirectorSoundEntry,
  type DirectorSoundEntryResolver,
} from "./types";

const MEMBER = LingoSymbol.for("member");
const START_TIME = LingoSymbol.for("startTime");
const END_TIME = LingoSymbol.for("endTime");
const LOOP_COUNT = LingoSymbol.for("loopCount");
const LOOP_START_TIME = LingoSymbol.for("loopStartTime");
const LOOP_END_TIME = LingoSymbol.for("loopEndTime");
const PRELOAD_TIME = LingoSymbol.for("preLoadTime");
const DEFAULT_QUEUE_PRELOAD_MS = 1500;

export interface DirectorSoundSystemOptions {
  readonly findMember: (value: LingoValue) => CastMember | null;
  readonly backend: DirectorSoundBackend;
  readonly clock: DirectorAudioClock;
  readonly reportError: (message: string, error?: unknown) => void;
}

/** Director's global `_sound` object and its fixed set of eight channels. */
export class DirectorSoundSystem implements DirectorSoundEntryResolver {
  readonly object = new DirectorSoundRef(this);
  private readonly channels: SoundChannelRef[];
  private enabled = true;
  private level = DIRECTOR_SOUND_LEVEL_MAX;
  private keepDevice = true;
  private mixMedia = true;

  constructor(private readonly options: DirectorSoundSystemOptions) {
    this.channels = Array.from(
      { length: DIRECTOR_SOUND_CHANNEL_COUNT },
      (_, index) => new SoundChannelRef(index + 1, this, options.backend, options.clock, options.reportError),
    );
    this.applyMasterGain();
  }

  channel(value: LingoValue): SoundChannelRef {
    const number = directorInteger(value, 0);
    if (number < 1 || number > DIRECTOR_SOUND_CHANNEL_COUNT) {
      throw new RangeError(`Director sound channel must be 1-${DIRECTOR_SOUND_CHANNEL_COUNT}, received ${number}`);
    }
    return this.channels[number - 1]!;
  }

  resolve(value: LingoValue, queued: boolean): DirectorSoundEntry | null {
    const source = value instanceof LingoPropList ? value : null;
    const memberValue = source ? source.getaProp(MEMBER, ops.lingoKeyEquals) : value;
    const member =
      memberValue instanceof CastMember
        ? memberValue
        : memberValue instanceof LingoSymbol
          ? this.options.findMember(memberValue.name)
          : memberValue instanceof LingoVoid
            ? null
            : this.options.findMember(memberValue);
    if (!member || !member.sound) {
      this.options.reportError(`Director sound entry has no extracted sound member: ${ops.stringOf(memberValue)}`);
      return null;
    }

    const duration = Math.max(0, member.sound.durationMs);
    const startTimeMs = clampTime(soundOption(source, START_TIME, 0), 0, duration);
    const endTimeMs = clampTime(soundOption(source, END_TIME, duration), startTimeMs, duration);
    const explicitLoopCount = hasSoundOption(source, LOOP_COUNT);
    const loopCount = Math.max(
      0,
      directorInteger(soundOptionValue(source, LOOP_COUNT), !explicitLoopCount && member.soundLoop ? 0 : 1),
    );
    const mediaLoopStartMs = samplePositionToMilliseconds(member.sound.loopStart, member.sound.sampleRate);
    const mediaLoopEndMs = samplePositionToMilliseconds(member.sound.loopEnd, member.sound.sampleRate);
    const loopStartTimeMs = clampTime(
      soundOption(source, LOOP_START_TIME, member.soundLoop && mediaLoopStartMs !== null ? mediaLoopStartMs : startTimeMs),
      startTimeMs,
      endTimeMs,
    );
    const loopEndTimeMs = clampTime(
      soundOption(source, LOOP_END_TIME, member.soundLoop && mediaLoopEndMs !== null ? mediaLoopEndMs : endTimeMs),
      loopStartTimeMs,
      endTimeMs,
    );
    const preloadTimeMs = Math.max(
      0,
      directorInteger(soundOptionValue(source, PRELOAD_TIME), queued ? DEFAULT_QUEUE_PRELOAD_MS : 0),
    );
    const normalized = LingoPropList.fromPairs([
      [MEMBER, member],
      [START_TIME, startTimeMs],
      [END_TIME, endTimeMs],
      [LOOP_COUNT, loopCount],
      [LOOP_START_TIME, loopStartTimeMs],
      [LOOP_END_TIME, loopEndTimeMs],
      [PRELOAD_TIME, preloadTimeMs],
    ]);

    return {
      source: normalized,
      member,
      media: member.sound,
      startTimeMs,
      endTimeMs,
      loopCount,
      loopStartTimeMs,
      loopEndTimeMs,
      preloadTimeMs,
    };
  }

  update(): void {
    for (const channel of this.channels) channel.update();
  }

  async resume(): Promise<void> {
    await this.options.backend.resume();
  }

  dispose(): void {
    for (const channel of this.channels) channel.dispose();
    this.options.backend.dispose();
  }

  snapshot(): readonly DirectorSoundChannelSnapshot[] {
    return this.channels.map((channel) => channel.snapshot());
  }

  get soundEnabled(): number {
    return this.enabled ? 1 : 0;
  }

  set soundEnabled(value: number) {
    this.enabled = value !== 0;
    this.applyMasterGain();
  }

  get soundLevel(): number {
    return this.level;
  }

  set soundLevel(value: number) {
    this.level = clampInteger(value, 0, DIRECTOR_SOUND_LEVEL_MAX);
    this.applyMasterGain();
  }

  get soundKeepDevice(): number {
    return this.keepDevice ? 1 : 0;
  }

  set soundKeepDevice(value: number) {
    this.keepDevice = value !== 0;
  }

  get soundMixMedia(): number {
    return this.mixMedia ? 1 : 0;
  }

  set soundMixMedia(value: number) {
    this.mixMedia = value !== 0;
  }

  get soundDevice(): string {
    return this.options.backend.deviceName;
  }

  get soundDeviceList(): LingoList {
    return new LingoList([this.options.backend.deviceName]);
  }

  setSoundDevice(value: LingoValue): boolean {
    return ops.stringOf(value).toLowerCase() === this.options.backend.deviceName.toLowerCase();
  }

  private applyMasterGain(): void {
    this.options.backend.setMasterGain(this.enabled ? this.level / DIRECTOR_SOUND_LEVEL_MAX : 0);
  }
}

/** Stable Lingo facade returned by the `_sound` global. */
export class DirectorSoundRef implements LingoObjectLike {
  readonly lingoType = "_sound";

  constructor(readonly system: DirectorSoundSystem) {}

  lingoToString(): string {
    return "_sound";
  }
}

function soundOption(source: LingoPropList | null, key: LingoSymbol, fallback: number): number {
  return directorNumber(soundOptionValue(source, key), fallback);
}

function soundOptionValue(source: LingoPropList | null, key: LingoSymbol): LingoValue {
  return source?.getaProp(key, ops.lingoKeyEquals) ?? LINGO_VOID;
}

function hasSoundOption(source: LingoPropList | null, key: LingoSymbol): boolean {
  return source !== null && !(source.findPos(key, ops.lingoKeyEquals) instanceof LingoVoid);
}

function samplePositionToMilliseconds(sample: number | null, sampleRate: number): number | null {
  if (sample === null || sampleRate <= 0) return null;
  return (sample / sampleRate) * 1_000;
}

function directorNumber(value: LingoValue, fallback: number): number {
  if (value instanceof LingoVoid) return fallback;
  if (isNumber(value)) {
    const number = numberOf(value);
    return Number.isFinite(number) ? number : fallback;
  }
  const number = Number(ops.stringOf(value));
  return Number.isFinite(number) ? number : fallback;
}

function directorInteger(value: LingoValue, fallback: number): number {
  return Math.round(directorNumber(value, fallback));
}

function clampTime(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
