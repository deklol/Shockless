export interface DirectorTickRunContext {
  readonly scheduledAtMs: number;
  readonly rafNowMs: number;
  readonly tickIndex: number;
}

export interface DirectorTickRunResult {
  readonly ticks: number;
  readonly movieTickMs: number;
  readonly tickDeltas: readonly number[];
  readonly tickJitters: readonly number[];
  readonly backlogMs: number;
  readonly resynced: boolean;
}

export interface DirectorTickSchedulerDiagnostics {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxTicksPerRaf: number;
  readonly maxBudgetMs: number;
  readonly maxBacklogMs: number;
  readonly ticksLastRaf: number;
  readonly droppedTicks: number;
  readonly resyncCount: number;
  readonly backlogMs: number;
}

export interface DirectorTickSchedulerOptions {
  readonly enabled: boolean;
  readonly maxTicksPerRaf: number;
  readonly maxBudgetMs: number;
  readonly maxBacklogMs: number;
  readonly toleranceMs?: number;
}

const DEFAULT_TOLERANCE_MS = 0.25;

export class DirectorTickScheduler {
  private readonly enabled: boolean;
  private readonly maxTicksPerRaf: number;
  private readonly maxBudgetMs: number;
  private readonly maxBacklogMs: number;
  private readonly toleranceMs: number;
  private nextTickAtMs = 0;
  private lastScheduledTickAtMs = 0;
  private intervalMs = 0;
  private ticksLastRaf = 0;
  private droppedTicks = 0;
  private resyncCount = 0;
  private backlogMs = 0;

  constructor(options: DirectorTickSchedulerOptions) {
    this.enabled = options.enabled;
    this.maxTicksPerRaf = Math.max(1, Math.min(8, Math.trunc(options.maxTicksPerRaf)));
    this.maxBudgetMs = Math.max(1, Math.min(100, Math.trunc(options.maxBudgetMs)));
    this.maxBacklogMs = Math.max(16, Math.min(2_000, Math.trunc(options.maxBacklogMs)));
    this.toleranceMs = Math.max(0, Math.min(5, options.toleranceMs ?? DEFAULT_TOLERANCE_MS));
  }

  run(
    nowMs: number,
    intervalMs: number,
    runTick: (context: DirectorTickRunContext) => number,
  ): DirectorTickRunResult {
    const interval = normalizeInterval(intervalMs);
    if (this.nextTickAtMs <= 0 || Math.abs(interval - this.intervalMs) > 0.001) {
      this.reset(nowMs, interval);
    }

    const tickDeltas: number[] = [];
    const tickJitters: number[] = [];
    let ticks = 0;
    let movieTickMs = 0;
    let resynced = false;

    if (nowMs + this.toleranceMs < this.nextTickAtMs) {
      this.ticksLastRaf = 0;
      this.backlogMs = Math.max(0, nowMs - this.nextTickAtMs);
      return { ticks, movieTickMs, tickDeltas, tickJitters, backlogMs: this.backlogMs, resynced };
    }

    const frameBudgetStart = performance.now();
    const maxTicks = this.enabled ? this.maxTicksPerRaf : 1;
    while (nowMs + this.toleranceMs >= this.nextTickAtMs && ticks < maxTicks) {
      if (ticks > 0 && performance.now() - frameBudgetStart >= this.maxBudgetMs) break;

      const scheduledAtMs = this.nextTickAtMs;
      if (this.lastScheduledTickAtMs > 0) {
        const tickDelta = scheduledAtMs - this.lastScheduledTickAtMs;
        tickDeltas.push(tickDelta);
        tickJitters.push(Math.abs(tickDelta - interval));
      }

      movieTickMs += Math.max(0, runTick({ scheduledAtMs, rafNowMs: nowMs, tickIndex: ticks }));
      ticks += 1;
      this.lastScheduledTickAtMs = scheduledAtMs;
      this.nextTickAtMs += interval;
    }

    const remainingBacklogMs = nowMs - this.nextTickAtMs;
    if (remainingBacklogMs > this.maxBacklogMs || (!this.enabled && remainingBacklogMs > interval * 2)) {
      const missed = Math.max(0, Math.floor(remainingBacklogMs / interval));
      this.droppedTicks += missed;
      this.resyncCount += 1;
      this.nextTickAtMs = nowMs + interval;
      this.lastScheduledTickAtMs = nowMs;
      resynced = true;
    }

    this.ticksLastRaf = ticks;
    this.backlogMs = Math.max(0, nowMs - this.nextTickAtMs);
    return { ticks, movieTickMs, tickDeltas, tickJitters, backlogMs: this.backlogMs, resynced };
  }

  diagnostics(): DirectorTickSchedulerDiagnostics {
    return {
      enabled: this.enabled,
      intervalMs: round2(this.intervalMs),
      maxTicksPerRaf: this.maxTicksPerRaf,
      maxBudgetMs: this.maxBudgetMs,
      maxBacklogMs: this.maxBacklogMs,
      ticksLastRaf: this.ticksLastRaf,
      droppedTicks: this.droppedTicks,
      resyncCount: this.resyncCount,
      backlogMs: round2(this.backlogMs),
    };
  }

  private reset(nowMs: number, intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.nextTickAtMs = nowMs + intervalMs;
    this.lastScheduledTickAtMs = 0;
    this.ticksLastRaf = 0;
    this.backlogMs = 0;
  }
}

function normalizeInterval(intervalMs: number): number {
  return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000 / 24;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
