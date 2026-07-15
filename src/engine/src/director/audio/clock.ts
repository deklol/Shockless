export interface DirectorAudioClock {
  nowMs(): number;
}

export class SystemDirectorAudioClock implements DirectorAudioClock {
  nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}

/** Deterministic clock for headless runtime and audio contract tests. */
export class ManualDirectorAudioClock implements DirectorAudioClock {
  constructor(private timeMs = 0) {}

  nowMs(): number {
    return this.timeMs;
  }

  set(timeMs: number): void {
    this.timeMs = Math.max(0, timeMs);
  }

  advance(deltaMs: number): void {
    this.set(this.timeMs + Math.max(0, deltaMs));
  }
}
