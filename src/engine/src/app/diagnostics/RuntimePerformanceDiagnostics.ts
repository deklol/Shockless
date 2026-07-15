import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LingoList, LingoPropList, type LingoValue } from "@director/values";
import type { FrameStutterDiagnostics } from "../FrameStutterDiagnostics";

export interface RollingPhaseStats {
  readonly count: number;
  readonly lastMs: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface CopyTraceStats {
  readonly total: number;
  readonly journaled: number;
  readonly directCopyCandidates: number;
  readonly staged: number;
}

export interface CopyTraceEvent {
  readonly destW: number;
  readonly destH: number;
  readonly srcW: number;
  readonly srcH: number;
  readonly destRect: string;
  readonly sourceRect: string;
  readonly ink: number | undefined;
  readonly journaled: boolean;
  readonly directCopyCandidate: boolean;
  readonly staged: boolean;
}

export interface CopyTraceFilter {
  readonly destW?: number;
  readonly destH?: number;
  readonly srcW?: number;
  readonly srcH?: number;
  readonly ink?: number | "any";
  readonly limit?: number;
}

export function createRollingTimings(limit: number): {
  readonly values: readonly number[];
  add(value: number): void;
  summary(): RollingPhaseStats;
} {
  const values: number[] = [];
  return {
    values,
    add(value): void {
      if (!Number.isFinite(value) || value < 0) return;
      values.push(value);
      if (values.length > limit) values.splice(0, values.length - limit);
    },
    summary(): RollingPhaseStats {
      if (values.length === 0) return { count: 0, lastMs: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
      const sorted = [...values].sort((left, right) => left - right);
      const rounded = (value: number): number => Math.round(value * 100) / 100;
      const percentile = (rank: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1))] ?? 0;
      return {
        count: values.length,
        lastMs: rounded(values[values.length - 1] ?? 0),
        averageMs: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
        p50Ms: rounded(percentile(0.5)),
        p95Ms: rounded(percentile(0.95)),
        maxMs: rounded(sorted[sorted.length - 1] ?? 0),
      };
    },
  };
}

export function createCopyTraceStats(): {
  record(info: Pick<CopyTraceEvent, "journaled" | "directCopyCandidate" | "staged">): void;
  total(): CopyTraceStats;
  lastSecond(now: number): CopyTraceStats;
} {
  const empty = (): CopyTraceStats => ({ total: 0, journaled: 0, directCopyCandidates: 0, staged: 0 });
  const add = (stats: CopyTraceStats, info: Pick<CopyTraceEvent, "journaled" | "directCopyCandidate" | "staged">): CopyTraceStats => ({
    total: stats.total + 1,
    journaled: stats.journaled + (info.journaled ? 1 : 0),
    directCopyCandidates: stats.directCopyCandidates + (info.directCopyCandidate ? 1 : 0),
    staged: stats.staged + (info.staged ? 1 : 0),
  });
  let total = empty();
  let current = empty();
  let previous = empty();
  let currentStartedAt = performance.now();
  return {
    record(info): void {
      total = add(total, info);
      current = add(current, info);
    },
    total: () => total,
    lastSecond(now): CopyTraceStats {
      if (now - currentStartedAt >= 1_000) {
        previous = current;
        current = empty();
        currentStartedAt = now;
      }
      return previous;
    },
  };
}

export function installSourcePerfTrace(
  runtime: Runtime,
  diagnostics: FrameStutterDiagnostics,
  log?: (level: "info" | "error" | "put", message: string) => void,
): void {
  const originalCallMethod = runtime.callMethod.bind(runtime);
  const activeFrames: Array<{ childMs: number }> = [];
  let depth = 0;
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (!diagnostics.isEnabled()) return originalCallMethod(receiver, method, args);
    const start = performance.now();
    const frame = { childMs: 0 };
    activeFrames.push(frame);
    depth += 1;
    try {
      return originalCallMethod(receiver, method, args);
    } finally {
      const currentDepth = depth;
      activeFrames.pop();
      try {
        const elapsed = performance.now() - start;
        const parent = activeFrames[activeFrames.length - 1];
        if (parent) parent.childMs += elapsed;
        const selfMs = Math.max(0, elapsed - frame.childMs);
        const target =
          receiver instanceof ScriptInstance
            ? receiver.module.scriptName
            : receiver instanceof LingoPropList
              ? "propList"
              : receiver instanceof LingoList
                ? "list"
                : typeof receiver;
        const roundedElapsed = Math.round(elapsed * 100) / 100;
        diagnostics.recordRuntimeCall({
          atMs: Math.round(performance.now()),
          elapsedMs: roundedElapsed,
          selfMs: Math.round(selfMs * 100) / 100,
          depth: currentDepth,
          target,
          method,
          stack: runtime.callStack.slice(-8),
        });
        if (log && roundedElapsed >= diagnostics.threshold()) {
          log("info", `[perf] ${target}.${method} ${roundedElapsed.toFixed(1)}ms depth=${currentDepth}`);
        }
      } finally {
        depth -= 1;
      }
    }
  };
}
