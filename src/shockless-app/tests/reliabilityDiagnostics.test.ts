import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReliabilityDiagnostics } from "../src/main/reliabilityDiagnostics.js";

test("reliability diagnostics bound events, redact private text, and persist JSONL", () => {
  const root = mkdtempSync(join(tmpdir(), "shockless-reliability-"));
  let nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const diagnostics = new ReliabilityDiagnostics(root, () => new Date(nowMs));
  try {
    diagnostics.record("main-renderer", "test", "error", {
      url: "https://example.test/?token=private-token&email=user@example.test",
      password: "password=plain-text",
    });
    for (let index = 0; index < 170; index += 1) {
      diagnostics.record("application", `event-${index}`, "info", { index });
    }
    const state = diagnostics.state();
    assert.equal(state.events.length, 160);
    const log = readFileSync(state.logPath, "utf8");
    assert.doesNotMatch(log, /private-token|user@example\.test|plain-text/);
    assert.match(log, /\[redacted\]|\[email\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reliability recovery is single-flight and cooldown bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "shockless-reliability-"));
  let nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const diagnostics = new ReliabilityDiagnostics(root, () => new Date(nowMs));
  try {
    assert.equal(diagnostics.beginRecovery("renderer-crashed"), true);
    assert.equal(diagnostics.beginRecovery("renderer-crashed"), false);
    diagnostics.finishRecovery("recovered");
    assert.equal(diagnostics.beginRecovery("renderer-crashed"), false);
    nowMs += 60_001;
    assert.equal(diagnostics.beginRecovery("renderer-crashed"), true);
    diagnostics.finishRecovery("failed", { reason: "synthetic" });
    assert.deepEqual(diagnostics.state().recovery, {
      inProgress: false,
      attemptCount: 2,
      lastAttemptAt: "2026-07-10T00:01:00.001Z",
      lastReason: "renderer-crashed",
      lastOutcome: "failed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderer heartbeat and repeated runtime health remain queryable without log spam", () => {
  const root = mkdtempSync(join(tmpdir(), "shockless-reliability-"));
  let nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const diagnostics = new ReliabilityDiagnostics(root, () => new Date(nowMs));
  try {
    diagnostics.rendererHeartbeat({
      at: new Date(nowMs).toISOString(),
      visibilityState: "hidden",
      selectedClientId: 2,
      mountedGameViews: 1,
    });
    const health = {
      at: new Date(nowMs).toISOString(),
      scope: "engine-renderer" as const,
      clientId: 2,
      state: "context-healthy",
      details: { backend: "WebGLRenderer" },
    };
    diagnostics.runtimeHealth(health);
    diagnostics.runtimeHealth({ ...health, at: new Date(nowMs + 1_000).toISOString() });
    nowMs += 6_000;
    assert.equal(diagnostics.rendererHeartbeatAgeMs(), 6_000);
    assert.equal(diagnostics.state().events.filter((event) => event.type === "context-healthy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
