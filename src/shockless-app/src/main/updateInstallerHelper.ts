import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { INSTALLER_RETIRED_PLUGIN_ROOTS, installerManagedPluginPath, portableInstallPathIsPreserved } from "../shared/update.js";
import { APP_EXECUTABLE_NAME } from "../shared/branding.js";
import { LEGACY_APP_EXECUTABLE_NAMES } from "../shared/legacyCompatibility.js";

interface UpdateInstallPlan {
  readonly schemaVersion: 1;
  readonly installDir: string;
  readonly stagedPayloadRoot: string;
  readonly backupDir: string;
  readonly logPath: string;
  readonly appExePath: string;
  readonly parentPid: number;
  readonly relaunch: boolean;
}

const REQUIRED_PAYLOAD_FILE_GROUPS = [
  [APP_EXECUTABLE_NAME, ...LEGACY_APP_EXECUTABLE_NAMES],
  ["resources/app/package.json"],
  ["resources/app/dist/main/main/main.js"],
  ["resources/app/dist/main/main/updateInstallerHelper.js"],
  ["resources/engine/dist/index.html"],
  ["resources/relay/origins-relay.mjs"],
];
const PROCESS_DRAIN_TIMEOUT_MS = 15_000;
const PROCESS_FORCE_TIMEOUT_MS = 15_000;
const FILE_RETRY_TIMEOUT_MS = 60_000;
const FILE_RETRY_DELAY_MS = 500;

interface InstallProcess {
  readonly pid: number;
  readonly name: string;
  readonly executablePath: string;
}

void main().catch((error) => {
  try {
    const plan = readPlan(process.argv[2] ?? "");
    log(plan, `FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  } catch {
    // At this point there is no reliable log path.
  }
  process.exit(1);
});

async function main(): Promise<void> {
  const plan = readPlan(process.argv[2] ?? "");
  log(plan, "Installer helper started.");
  validatePlan(plan);
  await waitForProcessExit(plan.parentPid, 60_000);
  await waitForInstallDirectoryProcesses(plan, PROCESS_DRAIN_TIMEOUT_MS);
  const remaining = listInstallDirectoryProcesses(plan);
  if (remaining.length > 0) {
    log(plan, `Terminating ${remaining.length} stale install process(es): ${remaining.map((entry) => `${entry.name}:${entry.pid}`).join(", ")}`);
    terminateProcesses(plan, remaining);
    await waitForInstallDirectoryProcesses(plan, PROCESS_FORCE_TIMEOUT_MS);
  }
  installStagedUpdate(plan);
  log(plan, "Install complete.");
  if (plan.relaunch) relaunch(plan);
}

function readPlan(planPath: string): UpdateInstallPlan {
  if (!planPath) throw new Error("Missing updater install plan path.");
  const parsed = JSON.parse(readFileSync(planPath, "utf8")) as UpdateInstallPlan;
  return parsed;
}

function validatePlan(plan: UpdateInstallPlan): void {
  if (plan.schemaVersion !== 1) throw new Error("Unsupported install plan schema.");
  const installDir = resolve(plan.installDir);
  const stagedPayloadRoot = resolve(plan.stagedPayloadRoot);
  const appExePath = resolve(plan.appExePath);
  assertInside(installDir, appExePath);
  if (!existsSync(installDir) || !statSync(installDir).isDirectory()) throw new Error(`Install directory is missing: ${installDir}`);
  if (!existsSync(stagedPayloadRoot) || !statSync(stagedPayloadRoot).isDirectory()) throw new Error(`Staged payload is missing: ${stagedPayloadRoot}`);
  for (const alternatives of REQUIRED_PAYLOAD_FILE_GROUPS) {
    if (!alternatives.some((file) => existsSync(join(stagedPayloadRoot, file)))) {
      throw new Error(`Staged payload is missing one of: ${alternatives.join(", ")}.`);
    }
  }
}

function installStagedUpdate(plan: UpdateInstallPlan): void {
  const installDir = resolve(plan.installDir);
  const stagedPayloadRoot = resolve(plan.stagedPayloadRoot);
  const backupDir = resolve(plan.backupDir);
  const backedUp = new Set<string>();
  const added = new Set<string>();
  mkdirSync(backupDir, { recursive: true });

  try {
    for (const entry of readdirSync(installDir, { withFileTypes: true })) {
      const rel = entry.name;
      if (portableInstallPathIsPreserved(rel)) continue;
      if (rel.toLowerCase() === "plugins") continue;
      backupAndRemove(installDir, backupDir, rel, backedUp, plan);
    }

    for (const entry of readdirSync(stagedPayloadRoot, { withFileTypes: true })) {
      const rel = entry.name;
      if (portableInstallPathIsPreserved(rel)) continue;
      if (rel.toLowerCase() === "plugins") continue;
      copyEntry(stagedPayloadRoot, installDir, backupDir, rel, backedUp, added, plan);
    }

    removeRetiredBundledPlugins(installDir, backupDir, backedUp, plan);
    installBundledPlugins(stagedPayloadRoot, installDir, backupDir, backedUp, added, plan);
  } catch (error) {
    rollback(installDir, backupDir, backedUp, added, plan, error);
    throw error;
  }
}

function installBundledPlugins(
  stagedPayloadRoot: string,
  installDir: string,
  backupDir: string,
  backedUp: Set<string>,
  added: Set<string>,
  plan: UpdateInstallPlan,
): void {
  const stagedPlugins = join(stagedPayloadRoot, "plugins");
  if (!existsSync(stagedPlugins)) return;
  mkdirSync(join(installDir, "plugins"), { recursive: true });
  for (const entry of readdirSync(stagedPlugins, { withFileTypes: true })) {
    const rel = `plugins/${entry.name}`;
    if (!installerManagedPluginPath(rel)) continue;
    copyEntry(stagedPayloadRoot, installDir, backupDir, rel, backedUp, added, plan);
  }
}

function removeRetiredBundledPlugins(
  installDir: string,
  backupDir: string,
  backedUp: Set<string>,
  plan: UpdateInstallPlan,
): void {
  for (const relativePath of INSTALLER_RETIRED_PLUGIN_ROOTS) {
    backupAndRemove(installDir, backupDir, relativePath, backedUp, plan);
  }
}

function backupAndRemove(root: string, backupRoot: string, relativePath: string, backedUp: Set<string>, plan: UpdateInstallPlan): void {
  assertSafeRelativePath(relativePath);
  const source = join(root, relativePath);
  if (!existsSync(source)) return;
  const backup = join(backupRoot, relativePath);
  mkdirSync(dirname(backup), { recursive: true });
  withFileSystemRetry(plan, `backup ${relativePath}`, () => cpSync(source, backup, { recursive: true, force: true }));
  withFileSystemRetry(plan, `remove ${relativePath}`, () => rmSync(source, { recursive: true, force: true }));
  backedUp.add(relativePath);
}

function copyEntry(
  sourceRoot: string,
  targetRoot: string,
  backupRoot: string,
  relativePath: string,
  backedUp: Set<string>,
  added: Set<string>,
  plan: UpdateInstallPlan,
): void {
  assertSafeRelativePath(relativePath);
  const source = join(sourceRoot, relativePath);
  const target = join(targetRoot, relativePath);
  if (existsSync(target) && !backedUp.has(relativePath)) {
    backupAndRemove(targetRoot, backupRoot, relativePath, backedUp, plan);
  } else if (!existsSync(target)) {
    added.add(relativePath);
  }
  mkdirSync(dirname(target), { recursive: true });
  withFileSystemRetry(plan, `copy ${relativePath}`, () => cpSync(source, target, { recursive: true, force: true }));
}

function rollback(
  installDir: string,
  backupDir: string,
  backedUp: Set<string>,
  added: Set<string>,
  plan: UpdateInstallPlan,
  originalError: unknown,
): void {
  log(plan, `Install failed; rolling back. ${originalError instanceof Error ? originalError.message : String(originalError)}`);
  for (const rel of [...added].reverse()) {
    withFileSystemRetry(plan, `rollback remove ${rel}`, () => rmSync(join(installDir, rel), { recursive: true, force: true }));
  }
  for (const rel of [...backedUp].reverse()) {
    const backup = join(backupDir, rel);
    const target = join(installDir, rel);
    withFileSystemRetry(plan, `rollback clear ${rel}`, () => rmSync(target, { recursive: true, force: true }));
    if (existsSync(backup)) {
      mkdirSync(dirname(target), { recursive: true });
      withFileSystemRetry(plan, `rollback restore ${rel}`, () => cpSync(backup, target, { recursive: true, force: true }));
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processIsRunning(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForInstallDirectoryProcesses(plan: UpdateInstallPlan, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const processes = listInstallDirectoryProcesses(plan);
    if (processes.length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

function listInstallDirectoryProcesses(plan: UpdateInstallPlan): readonly InstallProcess[] {
  if (process.platform !== "win32") return [];
  const installDir = resolve(plan.installDir);
  const script = `
$installDir = ${powershellString(installDir)}
$currentPid = ${process.pid}
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $currentPid -and (
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  )
} | Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}, @{Name='name';Expression={[string]$_.Name}}, @{Name='executablePath';Expression={[string]$_.ExecutablePath}} | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    log(plan, `Could not enumerate install processes: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
    return [];
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .map((row) => ({
        pid: Number(row.pid),
        name: typeof row.name === "string" ? row.name : "process",
        executablePath: typeof row.executablePath === "string" ? row.executablePath : "",
      }))
      .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== process.pid);
  } catch (error) {
    log(plan, `Could not parse install process list: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function terminateProcesses(plan: UpdateInstallPlan, processes: readonly InstallProcess[]): void {
  for (const entry of processes) {
    if (entry.pid === process.pid) continue;
    const result = spawnSync("taskkill.exe", ["/PID", String(entry.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) continue;
    log(plan, `Failed to terminate ${entry.name}:${entry.pid}: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function withFileSystemRetry(plan: UpdateInstallPlan, label: string, operation: () => void): void {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    try {
      operation();
      return;
    } catch (error) {
      if (!isTransientFileSystemError(error) || Date.now() - startedAt >= FILE_RETRY_TIMEOUT_MS) throw error;
      if (attempt === 0 || attempt % 10 === 0) {
        log(plan, `Waiting for file lock during ${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      attempt += 1;
      sleepSync(FILE_RETRY_DELAY_MS);
    }
  }
}

function isTransientFileSystemError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function relaunch(plan: UpdateInstallPlan): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(plan.appExePath, [], {
    cwd: plan.installDir,
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

function assertSafeRelativePath(relativePath: string): void {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe installer path: ${relativePath}`);
  }
}

function assertInside(parent: string, target: string): void {
  const normalizedParent = resolve(parent);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedParent && !normalizedTarget.startsWith(normalizedParent + sep)) {
    throw new Error(`Refusing path outside ${normalizedParent}: ${normalizedTarget}`);
  }
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function log(plan: UpdateInstallPlan, message: string): void {
  mkdirSync(dirname(plan.logPath), { recursive: true });
  appendFileSync(plan.logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}
