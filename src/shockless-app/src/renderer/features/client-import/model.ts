import type { ProfileImportProgress, ProfileImportStage } from "../../../shared/window-api";

export const PROFILE_IMPORT_STAGES: readonly ProfileImportStage[] = [
  "validate",
  "sanitize",
  "projectorrays",
  "index-casts",
  "text-fields",
  "materialize-bitmaps",
  "generate-scripts",
  "validate-profile",
];

export const PROFILE_IMPORT_STAGE_LABELS: Record<ProfileImportStage, string> = {
  validate: "Validate folder",
  sanitize: "Copy client",
  projectorrays: "Decompile",
  "index-casts": "Index casts",
  "text-fields": "Extract text",
  "materialize-bitmaps": "Prepare assets",
  "generate-scripts": "Prepare scripts",
  "validate-profile": "Validate profile",
};

export interface ProfileImportUiState {
  readonly running: boolean;
  readonly jobId: string | null;
  readonly sourceName: string;
  readonly startedAt: number | null;
  readonly latest: ProfileImportProgress | null;
  readonly entries: readonly ProfileImportProgress[];
  readonly events: readonly ProfileImportProgress[];
  readonly message: string;
}

export const emptyProfileImportUiState: ProfileImportUiState = {
  running: false,
  jobId: null,
  sourceName: "",
  startedAt: null,
  latest: null,
  entries: [],
  events: [],
  message: "",
};

export function pendingProfileImportUiState(): ProfileImportUiState {
  const now = Date.now();
  return {
    running: true,
    jobId: null,
    sourceName: "",
    startedAt: now,
    latest: {
      jobId: "pending-folder",
      sourceName: "",
      stage: "validate",
      state: "running",
      message: "Waiting for folder selection",
      detail: "Choose a compiled Habbo client folder or existing Shockless profile",
      percent: 0,
      elapsedMs: 0,
      logPath: null,
      updatedAt: new Date(now).toISOString(),
    },
    entries: [],
    events: [],
    message: "Waiting for folder selection.",
  };
}

export function profileImportUiWithProgress(current: ProfileImportUiState, progress: ProfileImportProgress): ProfileImportUiState {
  const sameJob = !current.jobId || current.jobId === progress.jobId || current.jobId === "pending-folder";
  const baseEntries = sameJob ? current.entries : [];
  const entries = [...baseEntries.filter((entry) => entry.stage !== progress.stage), progress].sort(
    (left, right) => PROFILE_IMPORT_STAGES.indexOf(left.stage) - PROFILE_IMPORT_STAGES.indexOf(right.stage),
  );
  const baseEvents = sameJob ? current.events : [];
  const events = [...baseEvents, progress].slice(-24);
  const terminal = progress.stage === "validate-profile" && (progress.state === "done" || progress.state === "warning" || progress.state === "failed");
  return {
    running: !terminal,
    jobId: progress.jobId,
    sourceName: progress.sourceName,
    startedAt: current.startedAt ?? Date.now() - (progress.elapsedMs ?? 0),
    latest: progress,
    entries,
    events,
    message: progress.message,
  };
}

export function profileImportUiFinished(current: ProfileImportUiState, message: string, failed: boolean): ProfileImportUiState {
  const latest = current.latest;
  const skipped = /cancel/i.test(message);
  if (!latest) {
    return {
      ...emptyProfileImportUiState,
      message,
    };
  }
  const finalProgress: ProfileImportProgress = {
    ...latest,
    stage: failed ? "validate-profile" : latest.stage,
    state: failed ? "failed" : skipped ? "skipped" : latest.state === "running" ? "done" : latest.state,
    message: failed ? "Import failed" : message,
    detail: failed || skipped ? message : latest.detail,
    percent: failed || skipped ? Math.max(0, latest.percent) : Math.max(latest.percent, 100),
    elapsedMs: latest.elapsedMs ?? (current.startedAt ? Date.now() - current.startedAt : undefined),
    updatedAt: new Date().toISOString(),
  };
  return {
    ...current,
    running: false,
    latest: finalProgress,
    entries: [...current.entries.filter((entry) => entry.stage !== finalProgress.stage), finalProgress].sort(
      (left, right) => PROFILE_IMPORT_STAGES.indexOf(left.stage) - PROFILE_IMPORT_STAGES.indexOf(right.stage),
    ),
    events: [...current.events, finalProgress].slice(-24),
    message,
  };
}

export function profileImportStageEntry(entries: readonly ProfileImportProgress[], stage: ProfileImportStage): ProfileImportProgress | undefined {
  return entries.find((entry) => entry.stage === stage);
}

export function formatImportElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatImportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function profileImportMetricText(progress: ProfileImportProgress | null | undefined): string[] {
  if (!progress) return [];
  const metrics: string[] = [];
  if (progress.bytesProcessed !== undefined) {
    metrics.push(progress.bytesTotal !== undefined
      ? `${formatImportBytes(progress.bytesProcessed)} / ${formatImportBytes(progress.bytesTotal)}`
      : `${formatImportBytes(progress.bytesProcessed)} written`);
  }
  if (progress.workers !== undefined) metrics.push(`${progress.workers} worker${progress.workers === 1 ? "" : "s"}`);
  if ((progress.cacheHits ?? 0) > 0) metrics.push("Cache hit");
  if ((progress.cacheMisses ?? 0) > 0) metrics.push("Cache miss");
  if ((progress.reusedBytes ?? 0) > 0) metrics.push(`${formatImportBytes(progress.reusedBytes!)} reused`);
  return metrics;
}

export function profileImportStatusLabel(state: ProfileImportUiState): string {
  if (state.running) return "Running";
  if (state.latest?.state === "failed") return "Failed";
  if (state.latest?.state === "warning") return "Imported with warnings";
  if (state.latest?.state === "done") return "Complete";
  return "Idle";
}
