import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileImportProgress, ProfileImportStage, ProfileImportStageState } from "../shared/window-api.js";
import { appDataStorePath } from "./appDataPaths.js";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const activeImportChildren = new Set<ChildProcess>();
let importCleanupHooksRegistered = false;

export interface ProfileImportRunnerResult {
  readonly profileRoot: string;
  readonly profileId: string | null;
  readonly ready: boolean | null;
  readonly logPath: string;
}

interface RuntimeProfileOutput {
  readonly id?: string;
  readonly profileRoot?: string;
  readonly runtime?: {
    readonly ready?: boolean;
    readonly validation?: {
      readonly fidelityComplete?: boolean;
      readonly warningCount?: number;
    };
  };
}

export type ProfileImportProgressSink = (progress: ProfileImportProgress) => void;

export function stopActiveProfileImports(): void {
  for (const child of [...activeImportChildren]) {
    killChildTree(child);
    activeImportChildren.delete(child);
  }
}

const IMPORT_STAGES: readonly ProfileImportStage[] = [
  "validate",
  "sanitize",
  "projectorrays",
  "index-casts",
  "text-fields",
  "materialize-bitmaps",
  "generate-scripts",
  "validate-profile",
];

const STAGE_END_PERCENT: Record<ProfileImportStage, number> = {
  validate: 8,
  sanitize: 18,
  projectorrays: 38,
  "index-casts": 50,
  "text-fields": 62,
  "materialize-bitmaps": 76,
  "generate-scripts": 90,
  "validate-profile": 100,
};

export async function runPlayableProfileImport(options: {
  readonly appDataPath: string;
  readonly clientRoot: string;
  readonly jobId?: string;
  readonly sourceName?: string;
  readonly versionCheckBuild?: number | null;
  readonly onProgress?: ProfileImportProgressSink;
}): Promise<ProfileImportRunnerResult> {
  const cliPath = resolveProfileImportCli();
  if (!cliPath) {
    throw new Error(profileImportCliMissingMessage());
  }

  const clientsRoot = habbpyClientsRoot(options.appDataPath);
  const cacheRoot = habbpyImportCacheRoot(options.appDataPath);
  const logPath = profileImportLogPath(options.appDataPath);
  const jobId = options.jobId ?? `profile-import-${Date.now()}`;
  const sourceName = options.sourceName ?? basename(resolve(options.clientRoot));
  const startedAt = Date.now();
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(clientsRoot, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  const args = [
    cliPath,
    "--client-root",
    resolve(options.clientRoot),
    "--cache-root",
    cacheRoot,
    "--clients-root",
    clientsRoot,
    "--resizable",
    "1",
  ];
  if (Number.isInteger(options.versionCheckBuild) && Number(options.versionCheckBuild) > 0) {
    args.push("--versionCheckBuild", String(options.versionCheckBuild));
  }
  if (process.env.SHOCKLESS_IMPORT_SKIP_PROJECTORRAYS === "1") {
    args.push("--skip-projectorrays");
  }

  emitProfileImportProgress(options.onProgress, {
    jobId,
    sourceName,
    stage: "validate",
    state: "running",
    message: "Starting profile import",
    detail: sourceName,
    percent: 1,
    elapsedMs: 0,
    logPath,
  });

  let lastProgress: ProfileImportProgress | null = {
    jobId,
    sourceName,
    stage: "validate",
    state: "running",
    message: "Starting profile import",
    detail: sourceName,
    percent: 1,
    elapsedMs: 0,
    logPath,
    updatedAt: new Date().toISOString(),
  };
  let lastImporterOutputAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!lastProgress || lastProgress.state !== "running") return;
    const now = Date.now();
    if (now - lastImporterOutputAt < 2_000) return;
    const progress = heartbeatProgress(lastProgress, {
      startedAt,
      lastImporterOutputAt,
      now,
    });
    lastProgress = progress;
    emitProfileImportProgress(options.onProgress, progress);
  }, 2_000);

  const progressFromLine = (line: string) => {
    const parsed = parseProfileImportProgressLine(line, {
      jobId,
      sourceName,
      startedAt,
      logPath,
      selectedRoot: resolve(options.clientRoot),
    });
    if (!parsed) return;
    lastImporterOutputAt = Date.now();
    const progress = monotonicRunningProgress(parsed, lastProgress);
    lastProgress = progress;
    emitProfileImportProgress(options.onProgress, progress);
  };

  let result: { stdout: string };
  try {
    result = await runNodeCli(process.execPath, args, logPath, progressFromLine);
  } finally {
    clearInterval(heartbeat);
  }
  const parsed = parseProfileImportJson(result.stdout);
  if (!parsed.profileRoot) {
    throw new Error(`Profile importer completed without returning a profile root. See ${logPath}`);
  }
  const hasFidelityWarnings = parsed.runtime?.ready !== false && parsed.runtime?.validation?.fidelityComplete === false;
  const fidelityWarningCount = Math.max(0, Number(parsed.runtime?.validation?.warningCount) || 0);
  emitProfileImportProgress(options.onProgress, {
    jobId,
    sourceName,
    stage: "validate-profile",
    state: parsed.runtime?.ready === false || hasFidelityWarnings ? "warning" : "done",
    message:
      parsed.runtime?.ready === false
        ? "Profile imported with runtime warnings"
        : hasFidelityWarnings
          ? "Profile ready with fidelity warnings"
          : "Profile ready",
    detail: hasFidelityWarnings
      ? `${fidelityWarningCount.toLocaleString()} unresolved source extraction warning(s); see profile-validation-report.json`
      : typeof parsed.id === "string"
        ? parsed.id
        : sourceName,
    percent: 100,
    elapsedMs: Date.now() - startedAt,
    logPath,
  });
  return {
    profileRoot: resolve(parsed.profileRoot),
    profileId: typeof parsed.id === "string" ? parsed.id : null,
    ready: typeof parsed.runtime?.ready === "boolean" ? parsed.runtime.ready : null,
    logPath,
  };
}

export function habbpyClientsRoot(appDataPath: string): string {
  const configured = firstNonEmpty(process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT, process.env.SHOCKLESS_CLIENTS_ROOT);
  if (configured) return resolve(configured);
  const portableRoot = detectPortableRoot();
  if (portableRoot) return join(portableRoot, "clients");
  return appDataStorePath(appDataPath, "clients");
}

export function habbpyImportCacheRoot(appDataPath: string): string {
  const configured = firstNonEmpty(process.env.SHOCKLESS_IMPORT_CACHE_ROOT);
  return configured ? resolve(configured) : appDataStorePath(appDataPath, "import-cache");
}

export function resolveProfileImportCli(): string | null {
  const configured = resolveExistingFile(process.env.SHOCKLESS_PROFILE_IMPORT_CLI);
  if (configured) return configured;

  const packagedResourcesPath = detectPackagedResourcesPath();
  if (packagedResourcesPath) {
    return resolveExistingFile(
      join(packagedResourcesPath, "engine", "standalone", "dist", "main", "cli", "profile-import.js"),
    );
  }

  return profileImportCliCandidatePaths().map(resolveExistingFile).find((candidate): candidate is string => Boolean(candidate)) ?? null;
}

export function profileImportCliMissingMessage(): string {
  const checked = profileImportCliCandidatePaths().slice(0, 8).join("; ");
  return [
    "Shockless profile importer was not found.",
    "Use the packaged portable release, or build the local Shockless standalone importer before importing clients from source.",
    "From the Shockless source root, run: npm --prefix engine/standalone run compile",
    "Then run: npm run package:portable",
    "Advanced: set SHOCKLESS_PROFILE_IMPORT_CLI to the built standalone/dist/main/cli/profile-import.js.",
    `Checked: ${checked}`,
  ].join(" ");
}

function profileImportCliCandidatePaths(): readonly string[] {
  return [
    resolve(MAIN_DIR, "..", "..", "..", "..", "engine", "standalone", "dist", "main", "cli", "profile-import.js"),
    process.env.SHOCKLESS_ENGINE_ROOT
      ? join(process.env.SHOCKLESS_ENGINE_ROOT, "standalone", "dist", "main", "cli", "profile-import.js")
      : undefined,
    resolve(process.cwd(), "engine", "standalone", "dist", "main", "cli", "profile-import.js"),
    ...ancestorSiblingCandidates("engine", "standalone", "dist", "main", "cli", "profile-import.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function runNodeCli(
  command: string,
  args: readonly string[],
  logPath: string,
  onStdoutLine?: (line: string) => void,
): Promise<{ stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const log = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    writeLogLine(log, `started ${new Date().toISOString()}`);
    const child = spawn(command, args, {
      env: {
        ...process.env,
        SHOCKLESS_IMPORT_PROGRESS: "jsonl",
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeImportChildren.add(child);
    registerImportCleanupHooks();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      log.write(text);
      stdoutLineBuffer = consumeLines(stdoutLineBuffer + text, (line) => onStdoutLine?.(line));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      log.write(text);
    });
    child.on("error", (error) => {
      activeImportChildren.delete(child);
      writeLogLine(log, `failed ${new Date().toISOString()} ${error.message}`);
      log.end();
      reject(error);
    });
    child.on("close", (code) => {
      activeImportChildren.delete(child);
      if (stdoutLineBuffer.trim()) onStdoutLine?.(stdoutLineBuffer.trim());
      writeLogLine(log, `exited ${new Date().toISOString()} code=${code ?? 1}`);
      log.end();
      if (code === 0) {
        resolveRun({ stdout });
        return;
      }
      const failure = processFailureSummary(stderr);
      reject(new Error(`Profile importer failed with exit code ${code ?? 1}. ${failure ? `${failure} ` : ""}See ${logPath}`));
    });
  });
}

function killChildTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (!result.error) return;
  }
  child.kill("SIGKILL");
}

function registerImportCleanupHooks(): void {
  if (importCleanupHooksRegistered) return;
  importCleanupHooksRegistered = true;
  process.once("exit", () => {
    stopActiveProfileImports();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stopActiveProfileImports();
      scheduleSignalExit(signalExitCode(signal));
    });
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function scheduleSignalExit(code: number): void {
  setImmediate(() => process.exit(code));
}

function processFailureSummary(stderr: string): string {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const errorIndex = lines.findIndex((line) =>
    /^(?:Error(?:\s+\[[^\]]+])?:|Cannot find package|Extraction tool failed)/i.test(line),
  );
  const selected = errorIndex >= 0 ? lines.slice(errorIndex, errorIndex + 10) : lines.slice(-8);
  return selected
    .filter((line) => !/^at\s+/.test(line) && !/^node:internal\//.test(line) && line !== "^")
    .slice(0, 6)
    .join(" ");
}

function consumeLines(text: string, onLine: (line: string) => void): string {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) onLine(line);
  return rest;
}

function parseProfileImportProgressLine(
  line: string,
  options: {
    readonly jobId: string;
    readonly sourceName: string;
    readonly startedAt: number;
    readonly logPath: string;
    readonly selectedRoot: string;
  },
): ProfileImportProgress | null {
  const structuredPrefix = "@shockless-import-progress ";
  const trimmed = line.trim();
  if (trimmed.startsWith(structuredPrefix)) {
    try {
      const parsed = JSON.parse(trimmed.slice(structuredPrefix.length)) as Partial<ProfileImportProgress>;
      const stage = parsed.stage as ProfileImportStage;
      const state = parsed.state as ProfileImportStageState;
      if (!IMPORT_STAGES.includes(stage) || !["pending", "running", "done", "warning", "failed", "skipped"].includes(state)) {
        return null;
      }
      const detail = parsed.detail ? sanitizeImportDetail(parsed.detail, options.selectedRoot, options.sourceName) : undefined;
      return {
        jobId: options.jobId,
        sourceName: options.sourceName,
        stage,
        state,
        message: typeof parsed.message === "string" && parsed.message.trim() ? parsed.message : "Working",
        ...(detail ? { detail } : {}),
        percent: finiteProgressNumber(parsed.percent, progressPercent(stage, state, parsed.current, parsed.total)),
        ...(finiteOptionalNumber(parsed.current) !== undefined ? { current: finiteOptionalNumber(parsed.current) } : {}),
        ...(finiteOptionalNumber(parsed.total) !== undefined ? { total: finiteOptionalNumber(parsed.total) } : {}),
        ...(finiteOptionalNumber(parsed.bytesProcessed) !== undefined ? { bytesProcessed: finiteOptionalNumber(parsed.bytesProcessed) } : {}),
        ...(finiteOptionalNumber(parsed.bytesTotal) !== undefined ? { bytesTotal: finiteOptionalNumber(parsed.bytesTotal) } : {}),
        ...(finiteOptionalNumber(parsed.workers) !== undefined ? { workers: finiteOptionalNumber(parsed.workers) } : {}),
        ...(finiteOptionalNumber(parsed.cacheHits) !== undefined ? { cacheHits: finiteOptionalNumber(parsed.cacheHits) } : {}),
        ...(finiteOptionalNumber(parsed.cacheMisses) !== undefined ? { cacheMisses: finiteOptionalNumber(parsed.cacheMisses) } : {}),
        ...(finiteOptionalNumber(parsed.reusedBytes) !== undefined ? { reusedBytes: finiteOptionalNumber(parsed.reusedBytes) } : {}),
        ...(finiteOptionalNumber(parsed.etaMs) !== undefined ? { etaMs: finiteOptionalNumber(parsed.etaMs) } : {}),
        elapsedMs: finiteOptionalNumber(parsed.elapsedMs) ?? Date.now() - options.startedAt,
        logPath: options.logPath,
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
  const match = /^\[(?<state>pending|running|done|warning|failed|skipped)]\s+(?<stage>[a-z-]+):\s+(?<body>.*)$/i.exec(line.trim());
  if (!match?.groups) return null;
  const stage = match.groups.stage as ProfileImportStage;
  const state = match.groups.state as ProfileImportStageState;
  if (!IMPORT_STAGES.includes(stage)) return null;
  const parsedBody = splitProgressBody(match.groups.body ?? "");
  const detail = parsedBody.detail ? sanitizeImportDetail(parsedBody.detail, options.selectedRoot, options.sourceName) : undefined;
  const counts = parseCountFromDetail(detail);
  return {
    jobId: options.jobId,
    sourceName: options.sourceName,
    stage,
    state,
    message: parsedBody.message || "Working",
    ...(detail ? { detail } : {}),
    percent: progressPercent(stage, state, counts.current, counts.total),
    ...(counts.current !== undefined ? { current: counts.current } : {}),
    ...(counts.total !== undefined ? { total: counts.total } : {}),
    elapsedMs: Date.now() - options.startedAt,
    logPath: options.logPath,
    updatedAt: new Date().toISOString(),
  };
}

function splitProgressBody(body: string): { readonly message: string; readonly detail?: string } {
  const trimmed = body.trim();
  const detailMatch = /^(?<message>.*?)\s+\((?<detail>[^()]*)\)$/.exec(trimmed);
  if (!detailMatch?.groups) return { message: trimmed };
  return {
    message: detailMatch.groups.message.trim(),
    detail: detailMatch.groups.detail.trim(),
  };
}

function sanitizeImportDetail(detail: string, selectedRoot: string, sourceName: string): string {
  const normalizedSelected = resolve(selectedRoot);
  const normalizedDetail = resolve(detail);
  if (normalizedDetail === normalizedSelected) return sourceName;
  return detail.replaceAll(normalizedSelected, sourceName);
}

function parseCountFromDetail(detail: string | undefined): { readonly current?: number; readonly total?: number } {
  if (!detail) return {};
  const match = /(?<current>\d[\d,]*)\s*\/\s*(?<total>\d[\d,]*)/.exec(detail);
  if (!match?.groups) {
    const writtenMatch = /(?:at least\s+)?(?<current>\d[\d,]*)\s+(?:external\s+)?PNG file\(s\) written/i.exec(detail);
    if (!writtenMatch?.groups) return {};
    const current = Number(writtenMatch.groups.current.replace(/,/g, ""));
    return Number.isFinite(current) ? { current } : {};
  }
  const current = Number(match.groups.current.replace(/,/g, ""));
  const total = Number(match.groups.total.replace(/,/g, ""));
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return {};
  return { current, total };
}

function progressPercent(
  stage: ProfileImportStage,
  state: ProfileImportStageState,
  current: number | undefined,
  total: number | undefined,
): number {
  const stageIndex = IMPORT_STAGES.indexOf(stage);
  const previousStage = stageIndex > 0 ? IMPORT_STAGES[stageIndex - 1] : null;
  const start = previousStage ? STAGE_END_PERCENT[previousStage] : 0;
  const end = STAGE_END_PERCENT[stage];
  if (state === "done" || state === "warning" || state === "skipped") return end;
  if (state === "failed") return Math.max(start, Math.min(end, end - 1));
  if (current !== undefined && total !== undefined && total > 0) {
    return Math.max(start, Math.min(end, start + ((end - start) * current) / total));
  }
  return Math.max(start + 1, Math.min(end - 1, start + Math.max(1, (end - start) * 0.35)));
}

function monotonicRunningProgress(progress: ProfileImportProgress, previous: ProfileImportProgress | null): ProfileImportProgress {
  void previous;
  return progress;
}

function heartbeatProgress(
  progress: ProfileImportProgress,
  options: {
    readonly startedAt: number;
    readonly lastImporterOutputAt: number;
    readonly now: number;
  },
): ProfileImportProgress {
  const end = STAGE_END_PERCENT[progress.stage];
  const idleMs = Math.max(0, options.now - options.lastImporterOutputAt);
  const baseDetailText = baseProgressDetail(progress.detail);
  const baseDetail = baseDetailText ? `${baseDetailText}; ` : "";
  return {
    ...progress,
    detail: `${baseDetail}still working, no new importer output for ${formatImportElapsed(idleMs)}`,
    percent: Math.min(end, progress.percent),
    elapsedMs: Math.max(0, options.now - options.startedAt),
    updatedAt: new Date(options.now).toISOString(),
  };
}

function finiteOptionalNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function finiteProgressNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : fallback;
}

function baseProgressDetail(detail: string | undefined): string {
  return detail?.replace(/;\s*still working, no new importer output for \d+:\d{2}$/i, "").trim() ?? "";
}

function formatImportElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function emitProfileImportProgress(
  onProgress: ProfileImportProgressSink | undefined,
  progress: Omit<ProfileImportProgress, "updatedAt"> & { readonly updatedAt?: string },
): void {
  onProgress?.({
    ...progress,
    updatedAt: progress.updatedAt ?? new Date().toISOString(),
  });
}

function parseProfileImportJson(stdout: string): RuntimeProfileOutput {
  const starts = [...stdout.matchAll(/(?:^|\r?\n)\{/g)].map((match) => match.index! + (stdout[match.index!] === "{" ? 0 : 1));
  for (const start of starts.reverse()) {
    try {
      const parsed = JSON.parse(stdout.slice(start)) as RuntimeProfileOutput;
      if (typeof parsed.profileRoot === "string") return parsed;
    } catch {
      // Keep looking for the final pretty-printed JSON object.
    }
  }
  return {};
}

function profileImportLogPath(appDataPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return appDataStorePath(appDataPath, "logs", `profile-import-${stamp}.log`);
}

function detectPortableRoot(): string | null {
  const resourcesPath = detectPackagedResourcesPath();
  return resourcesPath ? dirname(resourcesPath) : null;
}

function detectPackagedResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  const resolved = resolve(resourcesPath);
  if (
    existsSync(join(resolved, "app", "package.json")) ||
    existsSync(join(resolved, "engine", "dist", "index.html")) ||
    existsSync(join(resolved, "engine", "standalone", "package.json"))
  ) {
    return resolved;
  }
  return null;
}

function ancestorSiblingCandidates(...parts: readonly string[]): readonly string[] {
  const starts = new Set([process.cwd(), process.execPath ? dirname(process.execPath) : process.cwd(), MAIN_DIR]);
  const candidates = new Set<string>();
  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      candidates.add(join(current, ...parts));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...candidates];
}

function resolveExistingFile(path: string | undefined | null): string | null {
  if (!path) return null;
  const resolved = resolve(path);
  try {
    return existsSync(resolved) && statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function writeLogLine(log: WriteStream, text: string): void {
  log.write(`[shockless profile-import] ${text}\n`);
}
