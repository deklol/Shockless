import type { AvatarInterpolationDiagnostics } from "../habbo/user/AvatarInterpolationPresenter";
import type { SourceWindowPresentationBudgetDiagnostics } from "../render/SourceWindowPresentationBudget";
import type { AvatarMotionDiagnostics } from "../habbo/user/AvatarMotionPresentation";

export type FrameStutterPhase =
  | "browserRaf"
  | "movieTick"
  | "prepareText"
  | "rendererSync"
  | "appRender"
  | "mixed";

export interface FrameStutterSample {
  readonly atMs: number;
  readonly rafDeltaMs: number;
  readonly movieTickMs: number;
  readonly prepareTextMs: number;
  readonly rendererSyncMs: number;
  readonly appRenderMs: number;
  readonly dominantPhase: FrameStutterPhase;
  readonly sourceWindowCount: number;
  readonly sourceWindowChannelCount: number;
  readonly avatarInterpolation: AvatarInterpolationDiagnostics;
  readonly roomMotion: AvatarMotionDiagnostics;
  readonly sourceWindowBudget: SourceWindowPresentationBudgetDiagnostics;
}

export interface SlowRuntimeCallSample {
  readonly atMs: number;
  readonly elapsedMs: number;
  readonly selfMs: number;
  readonly depth: number;
  readonly target: string;
  readonly method: string;
  readonly stack: readonly string[];
}

export interface RuntimeCallAggregate {
  readonly target: string;
  readonly method: string;
  readonly stack: readonly string[];
  readonly count: number;
  readonly totalMs: number;
  readonly selfMs: number;
  readonly averageMs: number;
  readonly averageSelfMs: number;
  readonly maxMs: number;
}

export interface FrameStutterDiagnosticsState {
  readonly enabled: boolean;
  readonly thresholdMs: number;
  readonly samples: readonly FrameStutterSample[];
  readonly slowRuntimeCalls: readonly SlowRuntimeCallSample[];
  readonly runtimeCallAggregates: readonly RuntimeCallAggregate[];
}

export class FrameStutterDiagnostics {
  private enabled = false;
  private thresholdMs = 34;
  private samples: FrameStutterSample[] = [];
  private slowRuntimeCalls: SlowRuntimeCallSample[] = [];
  private runtimeCallAggregates = new Map<
    string,
    {
      target: string;
      method: string;
      stack: readonly string[];
      count: number;
      totalMs: number;
      selfMs: number;
      maxMs: number;
    }
  >();

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  threshold(): number {
    return this.thresholdMs;
  }

  setThresholdMs(thresholdMs: number): void {
    if (Number.isFinite(thresholdMs) && thresholdMs >= 1) this.thresholdMs = Math.max(1, Math.min(250, thresholdMs));
  }

  clear(): void {
    this.samples = [];
    this.slowRuntimeCalls = [];
    this.runtimeCallAggregates.clear();
  }

  record(sample: FrameStutterSample): void {
    if (!this.enabled) return;
    const longFrame =
      sample.rafDeltaMs >= this.thresholdMs ||
      sample.movieTickMs >= this.thresholdMs ||
      sample.prepareTextMs >= this.thresholdMs ||
      sample.rendererSyncMs >= this.thresholdMs ||
      sample.appRenderMs >= this.thresholdMs;
    if (!longFrame) return;
    this.samples.push(sample);
    if (this.samples.length > 120) this.samples = this.samples.slice(-120);
  }

  recordRuntimeCall(sample: SlowRuntimeCallSample): void {
    if (!this.enabled) return;
    const stack = sample.stack.slice(-6);
    const key = `${sample.target}\0${sample.method}\0${stack.join("\0")}`;
    const aggregate = this.runtimeCallAggregates.get(key);
    if (aggregate) {
      aggregate.count += 1;
      aggregate.totalMs += sample.elapsedMs;
      aggregate.selfMs += sample.selfMs;
      aggregate.maxMs = Math.max(aggregate.maxMs, sample.elapsedMs);
    } else if (this.runtimeCallAggregates.size < 512) {
      this.runtimeCallAggregates.set(key, {
        target: sample.target,
        method: sample.method,
        stack,
        count: 1,
        totalMs: sample.elapsedMs,
        selfMs: sample.selfMs,
        maxMs: sample.elapsedMs,
      });
    }
    if (sample.elapsedMs >= this.thresholdMs) {
      this.slowRuntimeCalls.push(sample);
      if (this.slowRuntimeCalls.length > 160) this.slowRuntimeCalls = this.slowRuntimeCalls.slice(-160);
    }
  }

  state(): FrameStutterDiagnosticsState {
    const runtimeCallAggregates = [...this.runtimeCallAggregates.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 80)
      .map((entry) => ({
        target: entry.target,
        method: entry.method,
        stack: [...entry.stack],
        count: entry.count,
        totalMs: Math.round(entry.totalMs * 100) / 100,
        selfMs: Math.round(entry.selfMs * 100) / 100,
        averageMs: Math.round((entry.totalMs / Math.max(1, entry.count)) * 100) / 100,
        averageSelfMs: Math.round((entry.selfMs / Math.max(1, entry.count)) * 100) / 100,
        maxMs: Math.round(entry.maxMs * 100) / 100,
      }));
    return {
      enabled: this.enabled,
      thresholdMs: this.thresholdMs,
      samples: this.samples.map((sample) => ({ ...sample })),
      slowRuntimeCalls: this.slowRuntimeCalls.map((sample) => ({ ...sample, stack: [...sample.stack] })),
      runtimeCallAggregates,
    };
  }
}

export function classifyFrameStutterPhase(sample: {
  readonly rafDeltaMs: number;
  readonly movieTickMs: number;
  readonly prepareTextMs: number;
  readonly rendererSyncMs: number;
  readonly appRenderMs: number;
}): FrameStutterPhase {
  const phases = [
    ["movieTick", sample.movieTickMs],
    ["prepareText", sample.prepareTextMs],
    ["rendererSync", sample.rendererSyncMs],
    ["appRender", sample.appRenderMs],
  ] as const;
  const measuredTotal = phases.reduce((sum, [, value]) => sum + Math.max(0, value), 0);
  let dominantPhase: FrameStutterPhase = "movieTick";
  let dominantMs = sample.movieTickMs;
  for (const [phase, value] of phases) {
    if (value <= dominantMs) continue;
    dominantPhase = phase;
    dominantMs = value;
  }
  if (sample.rafDeltaMs >= 34 && measuredTotal < sample.rafDeltaMs * 0.35) return "browserRaf";
  if (dominantMs >= 34 || dominantMs >= measuredTotal * 0.5) return dominantPhase;
  return "mixed";
}
