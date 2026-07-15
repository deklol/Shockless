import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AppReliabilityEvent,
  AppReliabilityState,
  RendererHeartbeat,
  RuntimeHealthReport,
} from "../shared/window-api.js";

const EVENT_LIMIT = 160;
const DEFAULT_RECOVERY_COOLDOWN_MS = 60_000;

export class ReliabilityDiagnostics {
  private readonly events: AppReliabilityEvent[] = [];
  private sequence = 0;
  private lastRendererHeartbeat: RendererHeartbeat | null = null;
  private lastRuntimeHealth: RuntimeHealthReport | null = null;
  private recoveryInProgress = false;
  private recoveryAttemptCount = 0;
  private recoveryLastAttemptAt: string | null = null;
  private recoveryLastAttemptMs = Number.NEGATIVE_INFINITY;
  private recoveryLastReason: string | null = null;
  private recoveryLastOutcome: "pending" | "recovered" | "failed" | null = null;

  constructor(
    private readonly logRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(
    scope: AppReliabilityEvent["scope"],
    type: string,
    severity: AppReliabilityEvent["severity"],
    details: Readonly<Record<string, unknown>> = {},
  ): AppReliabilityEvent {
    const at = this.now().toISOString();
    const event: AppReliabilityEvent = {
      sequence: ++this.sequence,
      at,
      scope,
      type,
      severity,
      details: sanitizeRecord(details),
    };
    this.events.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    this.append(event);
    return event;
  }

  rendererHeartbeat(heartbeat: RendererHeartbeat): void {
    this.lastRendererHeartbeat = sanitizeHeartbeat(heartbeat);
  }

  runtimeHealth(report: RuntimeHealthReport): void {
    const next = sanitizeRuntimeHealth(report);
    const previous = this.lastRuntimeHealth;
    this.lastRuntimeHealth = next;
    if (
      previous?.scope === next.scope &&
      previous?.clientId === next.clientId &&
      previous?.state === next.state &&
      JSON.stringify(previous.details ?? {}) === JSON.stringify(next.details ?? {})
    ) {
      return;
    }
    const severity = /lost|gone|failed|unresponsive/i.test(next.state) ? "error" : /restored|recovered/i.test(next.state) ? "info" : "warning";
    this.record(next.scope, next.state, severity, {
      clientId: next.clientId,
      ...(next.details ?? {}),
    });
  }

  beginRecovery(reason: string, cooldownMs = DEFAULT_RECOVERY_COOLDOWN_MS): boolean {
    const now = this.now();
    const nowMs = now.getTime();
    if (this.recoveryInProgress || nowMs - this.recoveryLastAttemptMs < cooldownMs) return false;
    this.recoveryInProgress = true;
    this.recoveryAttemptCount += 1;
    this.recoveryLastAttemptAt = now.toISOString();
    this.recoveryLastAttemptMs = nowMs;
    this.recoveryLastReason = reason;
    this.recoveryLastOutcome = "pending";
    this.record("application", "recovery-started", "warning", { reason, attempt: this.recoveryAttemptCount });
    return true;
  }

  finishRecovery(outcome: "recovered" | "failed", details: Readonly<Record<string, unknown>> = {}): void {
    this.recoveryInProgress = false;
    this.recoveryLastOutcome = outcome;
    this.record("application", `recovery-${outcome}`, outcome === "recovered" ? "info" : "error", {
      reason: this.recoveryLastReason,
      attempt: this.recoveryAttemptCount,
      ...details,
    });
  }

  rendererHeartbeatAgeMs(nowMs = this.now().getTime()): number | null {
    if (!this.lastRendererHeartbeat) return null;
    const heartbeatMs = Date.parse(this.lastRendererHeartbeat.at);
    return Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  }

  state(): AppReliabilityState {
    return {
      events: this.events.map((event) => ({ ...event, details: { ...event.details } })),
      lastRendererHeartbeat: this.lastRendererHeartbeat ? { ...this.lastRendererHeartbeat } : null,
      lastRuntimeHealth: this.lastRuntimeHealth
        ? { ...this.lastRuntimeHealth, details: this.lastRuntimeHealth.details ? { ...this.lastRuntimeHealth.details } : undefined }
        : null,
      recovery: {
        inProgress: this.recoveryInProgress,
        attemptCount: this.recoveryAttemptCount,
        lastAttemptAt: this.recoveryLastAttemptAt,
        lastReason: this.recoveryLastReason,
        lastOutcome: this.recoveryLastOutcome,
      },
      logPath: this.logPath(),
    };
  }

  private append(event: AppReliabilityEvent): void {
    try {
      mkdirSync(this.logRoot, { recursive: true });
      appendFileSync(this.logPath(), `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Reliability logging must never become a new application failure mode.
    }
  }

  private logPath(): string {
    const day = this.now().toISOString().slice(0, 10);
    return join(this.logRoot, `reliability-${day}.jsonl`);
  }
}

function sanitizeHeartbeat(heartbeat: RendererHeartbeat): RendererHeartbeat {
  return {
    at: validIso(heartbeat.at),
    visibilityState: sanitizeText(heartbeat.visibilityState),
    selectedClientId: positiveIntOrNull(heartbeat.selectedClientId),
    mountedGameViews: Math.max(0, Math.trunc(Number(heartbeat.mountedGameViews) || 0)),
  };
}

function sanitizeRuntimeHealth(report: RuntimeHealthReport): RuntimeHealthReport {
  return {
    at: validIso(report.at),
    scope: report.scope === "engine-renderer" ? "engine-renderer" : "game-webview",
    clientId: positiveIntOrNull(report.clientId),
    state: sanitizeText(report.state),
    details: report.details ? sanitizeRecord(report.details) : undefined,
  };
}

function sanitizeRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [sanitizeText(key), sanitizeValue(value)]));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeRecord(value as Readonly<Record<string, unknown>>);
  return String(value ?? "");
}

function sanitizeText(value: unknown): string {
  return String(value ?? "")
    .slice(0, 2_000)
    .replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, "[email]")
    .replace(/([?&](?:password|ticket|token|secret|email)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(password|ticket|token|secret)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]");
}

function validIso(value: unknown): string {
  const text = String(value ?? "");
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : new Date(0).toISOString();
}

function positiveIntOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
