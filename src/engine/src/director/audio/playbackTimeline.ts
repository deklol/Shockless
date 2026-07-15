import type { DirectorSoundEntry } from "./types";

export interface DirectorSoundTimelinePosition {
  readonly mediaTimeMs: number;
  readonly loopsRemaining: number;
  readonly complete: boolean;
}

export function directorSoundDurationMs(entry: DirectorSoundEntry): number {
  if (entry.loopCount === 0) return Number.POSITIVE_INFINITY;
  const base = Math.max(0, entry.endTimeMs - entry.startTimeMs);
  const loop = Math.max(0, entry.loopEndTimeMs - entry.loopStartTimeMs);
  return base + Math.max(0, entry.loopCount - 1) * loop;
}

/** Elapsed playback time at which the final non-looping tail begins. */
export function directorSoundTailStartElapsedMs(entry: DirectorSoundEntry): number {
  const introDuration = Math.max(0, entry.loopEndTimeMs - entry.startTimeMs);
  if (entry.loopCount === 0) return Number.POSITIVE_INFINITY;
  const loopDuration = Math.max(0, entry.loopEndTimeMs - entry.loopStartTimeMs);
  return introDuration + Math.max(0, entry.loopCount - 1) * loopDuration;
}

export function directorSoundTimelinePosition(
  entry: DirectorSoundEntry,
  elapsedMs: number,
): DirectorSoundTimelinePosition {
  const elapsed = Math.max(0, elapsedMs);
  const introDuration = Math.max(0, entry.loopEndTimeMs - entry.startTimeMs);
  const loopDuration = Math.max(0, entry.loopEndTimeMs - entry.loopStartTimeMs);
  if (elapsed < introDuration || loopDuration === 0) {
    const mediaTimeMs = Math.min(entry.endTimeMs, entry.startTimeMs + elapsed);
    return {
      mediaTimeMs,
      loopsRemaining: entry.loopCount === 0 ? 0 : Math.max(0, entry.loopCount - 1),
      complete: mediaTimeMs >= entry.endTimeMs && entry.loopCount !== 0,
    };
  }

  const afterIntro = elapsed - introDuration;
  if (entry.loopCount === 0) {
    return {
      mediaTimeMs: entry.loopStartTimeMs + (afterIntro % loopDuration),
      loopsRemaining: 0,
      complete: false,
    };
  }

  const repeatCount = Math.max(0, entry.loopCount - 1);
  const repeatedDuration = repeatCount * loopDuration;
  if (afterIntro < repeatedDuration) {
    const completedRepeats = Math.floor(afterIntro / loopDuration);
    return {
      mediaTimeMs: entry.loopStartTimeMs + (afterIntro % loopDuration),
      loopsRemaining: Math.max(0, repeatCount - completedRepeats - 1),
      complete: false,
    };
  }

  const tailElapsed = afterIntro - repeatedDuration;
  const mediaTimeMs = Math.min(entry.endTimeMs, entry.loopEndTimeMs + tailElapsed);
  return {
    mediaTimeMs,
    loopsRemaining: 0,
    complete: mediaTimeMs >= entry.endTimeMs,
  };
}

export function directorSoundRemainingMs(entry: DirectorSoundEntry, elapsedMs: number): number {
  const duration = directorSoundDurationMs(entry);
  return Number.isFinite(duration) ? Math.max(0, duration - Math.max(0, elapsedMs)) : duration;
}

/** Remaining duration after Director's breakLoop() exits the current loop. */
export function directorSoundBreakLoopDurationMs(entry: DirectorSoundEntry, elapsedMs: number): number {
  const position = directorSoundTimelinePosition(entry, elapsedMs);
  return Math.max(0, entry.endTimeMs - position.mediaTimeMs);
}
