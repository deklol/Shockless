import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WebContents } from "electron";
import {
  emptyUpdateState,
  INSTALLER_MANAGED_PLUGIN_ROOTS,
  INSTALLER_RETIRED_PLUGIN_ROOTS,
  installerManagedPluginPath,
  installerRetiredPluginPath,
  isNewerAppVersion,
  isSafeHttpsUrl,
  MAX_UPDATE_BYTES,
  portableInstallPathIsPreserved,
  publicUpdatePathIsForbidden,
  UPDATE_MANIFEST_ASSET_NAME,
  UPDATE_PLATFORM,
  UPDATE_REPOSITORY_NAME,
  UPDATE_REPOSITORY_OWNER,
  updatePercent,
  validateUpdateManifest,
  type AppUpdateProgress,
  type AppUpdateState,
  type UpdateReleaseInfo,
  type UpdateReleaseManifest,
} from "../shared/update.js";
import { errorMessage } from "../shared/errors.js";
import { APP_EXECUTABLE_NAME, APP_PORTABLE_DIR_NAME } from "../shared/branding.js";
import { LEGACY_APP_EXECUTABLE_NAMES, LEGACY_APP_PORTABLE_DIR_NAMES } from "../shared/legacyCompatibility.js";
import { appDataStorePath, firstExistingAppDataStorePath } from "./appDataPaths.js";

const GITHUB_API_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY_OWNER}/${UPDATE_REPOSITORY_NAME}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10_000;
const PROGRESS_EMIT_INTERVAL_MS = 150;
const INSTALLER_START_TIMEOUT_MS = 5_000;
const UPDATE_STATE_FILE = "update-state.json";
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".txt", ".xml", ".yml", ".yaml"]);
const PRIVATE_ENDPOINT_ENV_NAME = ["HABBPY", "V4", "DISCORD", "WEB" + "HOOK", "URL"].join("_");
const FORBIDDEN_RELEASE_TEXT_PATTERNS = [
  /discord(?:app)?\.com\/api\/webhooks/i,
  new RegExp(PRIVATE_ENDPOINT_ENV_NAME, "i"),
  /[A-Z]:[\\/](?:Users[\\/]dekky|habbo|habbpy|slopwave)/i,
  /C:[\\/]Users[\\/]dekky/i,
  /F:[\\/](?:habbo|habbpy|slopwave)/i,
];

type FetchLike = typeof fetch;

interface UpdateManagerOptions {
  readonly appDataPath: string;
  readonly currentVersion: string;
  readonly installDir: string;
  readonly executablePath: string;
  readonly isPackaged: boolean;
  readonly fetchImpl?: FetchLike;
}

interface PersistedUpdateState {
  readonly skippedVersion?: string;
}

interface GitHubReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
}

interface GitHubReleaseResponse {
  readonly tag_name?: unknown;
  readonly html_url?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly published_at?: unknown;
  readonly assets?: unknown;
}

export interface StagedUpdateValidation {
  readonly ok: boolean;
  readonly payloadRoot: string | null;
  readonly message: string;
}

export interface UpdateInstallPlan {
  readonly schemaVersion: 1;
  readonly installDir: string;
  readonly stagedPayloadRoot: string;
  readonly backupDir: string;
  readonly logPath: string;
  readonly appExePath: string;
  readonly parentPid: number;
  readonly relaunch: boolean;
  readonly managedPluginRoots: readonly string[];
  readonly retiredPluginRoots: readonly string[];
}

interface InstallerLaunchResult {
  readonly ok: boolean;
  readonly message: string;
}

export class UpdateManager {
  private state: AppUpdateState;
  private readonly fetchImpl: FetchLike;
  private readonly listeners = new Set<WebContents>();

  constructor(private readonly options: UpdateManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const persisted = readPersistedState(this.statePathForRead());
    this.state = emptyUpdateState(options.currentVersion, persisted.skippedVersion ?? null);
  }

  addListener(contents: WebContents): void {
    if (contents.isDestroyed()) return;
    this.listeners.add(contents);
    contents.once("destroyed", () => this.listeners.delete(contents));
  }

  snapshot(): AppUpdateState {
    return this.state;
  }

  async checkForUpdates(options: { readonly silent?: boolean } = {}): Promise<AppUpdateState> {
    if (this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "installing") return this.state;
    this.setState({
      status: "checking",
      progress: null,
      error: null,
      message: "Checking GitHub releases...",
    });

    try {
      const release = await this.fetchLatestRelease();
      if (!release) {
        this.setState({
          status: "up-to-date",
          lastCheckedAt: new Date().toISOString(),
          available: null,
          message: "No public update release is available yet.",
        });
        return this.state;
      }
      if (!isNewerAppVersion(release.version, this.options.currentVersion)) {
        this.setState({
          status: "up-to-date",
          lastCheckedAt: new Date().toISOString(),
          available: release,
          message: `Shockless Engine is up to date (${this.options.currentVersion}).`,
        });
        return this.state;
      }
      if (this.state.skippedVersion === release.version) {
        this.setState({
          status: "skipped",
          lastCheckedAt: new Date().toISOString(),
          available: release,
          message: `Update ${release.version} is skipped.`,
        });
        return this.state;
      }
      this.setState({
        status: "available",
        lastCheckedAt: new Date().toISOString(),
        available: release,
        message: `Update ${release.version} is available.`,
      });
    } catch (error) {
      this.setState({
        status: options.silent ? "unavailable" : "error",
        lastCheckedAt: new Date().toISOString(),
        available: null,
        error: errorMessage(error),
        message: options.silent ? "Update check unavailable. The app can still be used normally." : `Update check failed: ${errorMessage(error)}`,
      });
    }
    return this.state;
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    const available = this.state.available;
    if (!available) return this.checkForUpdates({ silent: false });
    if (!isNewerAppVersion(available.version, this.options.currentVersion)) return this.state;

    const updateRoot = this.updateRoot(available.version);
    const zipPath = join(updateRoot, available.assetName);
    const partialPath = `${zipPath}.partial`;
    const stageRoot = join(updateRoot, "stage");
    await mkdir(updateRoot, { recursive: true });
    await rm(partialPath, { force: true });
    await rm(zipPath, { force: true });
    await rm(stageRoot, { recursive: true, force: true });

    this.setState({
      status: "downloading",
      progress: { bytesReceived: 0, totalBytes: available.size, percent: 0 },
      stagedPath: null,
      error: null,
      message: `Downloading ${available.assetName}...`,
    });

    try {
      await this.downloadFile(available.assetUrl, partialPath, available.size);
      const actualSha256 = await sha256File(partialPath);
      if (actualSha256 !== available.sha256) {
        throw new Error(`Update checksum mismatch. Expected ${available.sha256}, received ${actualSha256}.`);
      }
      await renamePortableFile(partialPath, zipPath);
      await extractUpdateZip(zipPath, stageRoot);
      const staged = await validateStagedUpdatePayload(stageRoot);
      if (!staged.ok || !staged.payloadRoot) throw new Error(staged.message);

      this.setState({
        status: "downloaded",
        progress: { bytesReceived: available.size, totalBytes: available.size, percent: 100 },
        stagedPath: staged.payloadRoot,
        message: `Update ${available.version} is ready to install.`,
      });
    } catch (error) {
      await rm(partialPath, { force: true });
      this.setState({
        status: "error",
        error: errorMessage(error),
        message: `Update download failed: ${errorMessage(error)}`,
      });
    }
    return this.state;
  }

  async installDownloadedUpdate(): Promise<AppUpdateState> {
    if (this.state.status !== "downloaded" || !this.state.available || !this.state.stagedPath) {
      return {
        ...this.state,
        status: "error",
        error: "No downloaded update is ready to install.",
        message: "Download an update before installing.",
      };
    }
    if (!this.options.isPackaged) {
      this.setState({
        status: "error",
        error: "Restart install is only available from the packaged portable app.",
        message: "Run the packaged portable app to install downloaded updates.",
      });
      return this.state;
    }

    const staged = await validateStagedUpdatePayload(this.state.stagedPath);
    if (!staged.ok || !staged.payloadRoot) {
      this.setState({
        status: "error",
        error: staged.message,
        message: staged.message,
      });
      return this.state;
    }

    const planPath = await this.writeInstallPlan(this.state.available, staged.payloadRoot);
    const installerScriptPath = await this.writeInstallerScript(this.state.available);
    const installLogPath = join(this.updateRoot(this.state.available.version), "install.log");
    await appendFile(
      installLogPath,
      `${new Date().toISOString()} Launching external updater installer ${installerScriptPath}\n`,
      "utf8",
    );

    const launcherScriptPath = await this.writeInstallerLauncherScript(this.state.available);
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherScriptPath,
        "-InstallerScriptPath",
        installerScriptPath,
        "-PlanPath",
        planPath,
        "-LogPath",
        installLogPath,
        "-WorkingDirectory",
        this.updateRoot(this.state.available.version),
      ],
      {
        cwd: this.updateRoot(this.state.available.version),
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const launch = await waitForInstallerReady(child, installLogPath);
    if (!launch.ok) {
      this.setState({
        status: "error",
        error: launch.message,
        message: `Updater installer did not start: ${launch.message}`,
      });
      return this.state;
    }
    child.unref();
    this.setState({
      status: "installing",
      message: "Restarting to install the downloaded update...",
      error: null,
    });
    return this.state;
  }

  async skipUpdate(version: string): Promise<AppUpdateState> {
    const clean = version.trim();
    const skippedVersion = clean || this.state.available?.version || null;
    await writePersistedState(this.statePath(), { skippedVersion: skippedVersion ?? undefined });
    this.setState({
      status: skippedVersion && this.state.available?.version === skippedVersion ? "skipped" : this.state.status,
      skippedVersion,
      message: skippedVersion ? `Update ${skippedVersion} is skipped.` : "No update version is skipped.",
    });
    return this.state;
  }

  private async fetchLatestRelease(): Promise<UpdateReleaseInfo | null> {
    const release = await this.fetchJson<GitHubReleaseResponse>(GITHUB_API_RELEASE_URL);
    if (release.draft === true || release.prerelease === true) return null;
    const tagName = cleanString(release.tag_name);
    const releaseUrl = cleanString(release.html_url);
    if (!tagName || !isSafeHttpsUrl(releaseUrl, "github.com")) throw new Error("GitHub latest release response is missing tag/html URL.");
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifestAsset = assets.find((asset): asset is GitHubReleaseAsset =>
      isRecord(asset) && cleanString(asset.name) === UPDATE_MANIFEST_ASSET_NAME,
    );
    const manifestUrl = cleanString(manifestAsset?.browser_download_url);
    if (!isSafeHttpsUrl(manifestUrl, "github.com")) throw new Error("Latest release does not contain a valid update.json asset.");

    const manifestValidation = validateUpdateManifest(await this.fetchJson<unknown>(manifestUrl), UPDATE_PLATFORM);
    if (!manifestValidation.ok || !manifestValidation.manifest) throw new Error(manifestValidation.message);
    const manifest = manifestValidation.manifest;
    const asset = assets.find((entry): entry is GitHubReleaseAsset =>
      isRecord(entry) && cleanString(entry.name) === manifest.assetName,
    );
    const assetUrl = cleanString(asset?.browser_download_url);
    if (!isSafeHttpsUrl(assetUrl, "github.com")) throw new Error(`Release asset is missing or invalid: ${manifest.assetName}`);
    if (Number(asset?.size) !== manifest.size) throw new Error(`Release asset size does not match ${UPDATE_MANIFEST_ASSET_NAME}.`);
    return {
      ...manifest,
      tagName,
      assetUrl,
      manifestUrl,
      publishedAt: manifest.publishedAt ?? (cleanString(release.published_at) || undefined),
      releaseUrl,
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchWithTimeout(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Shockless-Engine/${this.options.currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status} ${response.statusText}).`);
    return response.json() as Promise<T>;
  }

  private async downloadFile(url: string, destination: string, expectedBytes: number): Promise<void> {
    const response = await this.fetchWithTimeout(url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": `Shockless-Engine/${this.options.currentVersion}`,
      },
    });
    if (!response.ok) throw new Error(`Release asset download failed (${response.status} ${response.statusText}).`);
    const length = Number(response.headers.get("content-length") ?? expectedBytes);
    if (!Number.isFinite(length) || length <= 0 || length > MAX_UPDATE_BYTES) throw new Error("Release asset size is invalid.");
    if (length !== expectedBytes) throw new Error("Release asset content length does not match update manifest.");
    if (!response.body) throw new Error("Release asset response did not contain a body.");

    let bytesReceived = 0;
    let lastEmit = 0;
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytesReceived += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS || bytesReceived === expectedBytes) {
          lastEmit = now;
          this.setProgress(bytesReceived, expectedBytes);
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), progress, createWriteStream(destination));
    if (bytesReceived !== expectedBytes) throw new Error(`Downloaded ${bytesReceived} bytes, expected ${expectedBytes}.`);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private setProgress(bytesReceived: number, totalBytes: number): void {
    const progress: AppUpdateProgress = {
      bytesReceived,
      totalBytes,
      percent: updatePercent(bytesReceived, totalBytes),
    };
    this.setState({ progress, message: `Downloading update... ${progress.percent}%` });
  }

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const contents of [...this.listeners]) {
      if (contents.isDestroyed()) {
        this.listeners.delete(contents);
        continue;
      }
      contents.send("shockless:update-state", this.state);
    }
  }

  private async writeInstallPlan(update: UpdateReleaseInfo, stagedPayloadRoot: string): Promise<string> {
    const root = this.updateRoot(update.version);
    await mkdir(root, { recursive: true });
    const backupDir = join(root, "backup");
    const plan: UpdateInstallPlan = {
      schemaVersion: 1,
      installDir: this.options.installDir,
      stagedPayloadRoot,
      backupDir,
      logPath: join(root, "install.log"),
      appExePath: join(this.options.installDir, stagedPayloadExecutableName(stagedPayloadRoot) ?? APP_EXECUTABLE_NAME),
      parentPid: process.pid,
      relaunch: true,
      managedPluginRoots: [...INSTALLER_MANAGED_PLUGIN_ROOTS],
      retiredPluginRoots: [...INSTALLER_RETIRED_PLUGIN_ROOTS],
    };
    const planPath = join(root, "install-plan.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return planPath;
  }

  private async writeInstallerScript(update: UpdateReleaseInfo): Promise<string> {
    const scriptPath = join(this.updateRoot(update.version), "install-update.ps1");
    await writeFile(scriptPath, buildPowerShellInstallerScript(), "utf8");
    return scriptPath;
  }

  private async writeInstallerLauncherScript(update: UpdateReleaseInfo): Promise<string> {
    const scriptPath = join(this.updateRoot(update.version), "launch-update.ps1");
    await writeFile(scriptPath, buildPowerShellInstallerLauncherScript(), "utf8");
    return scriptPath;
  }

  private updateRoot(version: string): string {
    return appDataStorePath(this.options.appDataPath, "updates", safeVersionDir(version));
  }

  private statePath(): string {
    return appDataStorePath(this.options.appDataPath, "updates", UPDATE_STATE_FILE);
  }

  private statePathForRead(): string {
    return firstExistingAppDataStorePath(this.options.appDataPath, "updates", UPDATE_STATE_FILE);
  }
}

async function waitForInstallerReady(child: ReturnType<typeof spawn>, logPath: string): Promise<InstallerLaunchResult> {
  let childError: string | null = null;
  let childExitCode: number | null | undefined;
  let childExitSignal: NodeJS.Signals | null | undefined;
  child.once("error", (error) => {
    childError = errorMessage(error);
  });
  child.once("exit", (code, signal) => {
    childExitCode = code;
    childExitSignal = signal;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < INSTALLER_START_TIMEOUT_MS) {
    const text = await readFile(logPath, "utf8").catch(() => "");
    if (text.includes("External updater installer ready.")) return { ok: true, message: "Updater installer ready." };
    const failedLine = text.split(/\r?\n/).find((line) => line.includes("FAILED:"));
    if (failedLine) return { ok: false, message: failedLine };
    if (childError) return { ok: false, message: childError };
    if (childExitCode !== undefined && childExitCode !== 0) {
      return { ok: false, message: `updater launcher exited before ready (code=${childExitCode ?? "-"} signal=${childExitSignal ?? "-"})` };
    }
    await delay(100);
  }

  const launcherStatus = childExitCode !== undefined ? " The launcher exited cleanly, but the installer did not report readiness." : "";
  return { ok: false, message: `No ready marker was written to ${logPath} within ${INSTALLER_START_TIMEOUT_MS}ms.${launcherStatus}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function validateStagedUpdatePayload(stageRoot: string): Promise<StagedUpdateValidation> {
  const root = await resolveStagedPayloadRoot(stageRoot);
  if (!root) return { ok: false, payloadRoot: null, message: "Staged update does not contain a portable Shockless root." };
  const required = [
    [APP_EXECUTABLE_NAME, ...LEGACY_APP_EXECUTABLE_NAMES],
    ["resources/app/package.json"],
    ["resources/app/dist/main/main/main.js"],
    ["resources/app/dist/main/main/updateInstallerHelper.js"],
    ["resources/engine/dist/index.html"],
    ["resources/relay/origins-relay.mjs"],
  ];
  for (const alternatives of required) {
    if (!alternatives.some((file) => existsSync(join(root, file)))) {
      return { ok: false, payloadRoot: null, message: `Staged update is missing ${alternatives.join(" or ")}.` };
    }
  }
  const leakedText: string[] = [];
  for await (const filePath of walkFiles(root)) {
    const rel = relative(root, filePath);
    if (publicUpdatePathIsForbidden(rel)) return { ok: false, payloadRoot: null, message: `Staged update contains forbidden path ${rel}.` };
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const fileStat = await stat(filePath);
    if (fileStat.size > 1024 * 1024) continue;
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (FORBIDDEN_RELEASE_TEXT_PATTERNS.some((pattern) => pattern.test(text))) leakedText.push(rel);
  }
  if (leakedText.length > 0) {
    return { ok: false, payloadRoot: null, message: `Staged update contains private/local text needle(s): ${leakedText.join(", ")}.` };
  }
  return { ok: true, payloadRoot: root, message: "Staged update payload is valid." };
}

export async function extractUpdateZip(zipPath: string, destination: string): Promise<void> {
  const script = `
$ErrorActionPreference = "Stop"
$ZipPath = ${powershellString(zipPath)}
$Destination = ${powershellString(destination)}
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$destFull = [System.IO.Path]::GetFullPath($Destination)
$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  foreach ($entry in $zip.Entries) {
    $name = [string]$entry.FullName
    $normalized = $name.Replace("\\", "/")
    if ([string]::IsNullOrWhiteSpace($normalized)) { throw "Zip entry name is empty." }
    if ($normalized.StartsWith("/") -or $normalized -match "^[A-Za-z]:") { throw "Zip entry uses an absolute path: $name" }
    if ($normalized.Split("/") -contains "..") { throw "Zip entry attempts to leave the update directory: $name" }
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destFull, $name))
    if ($target -ne $destFull -and -not $target.StartsWith($destFull + [System.IO.Path]::DirectorySeparatorChar)) {
      throw "Zip entry resolves outside destination: $name"
    }
  }
} finally {
  $zip.Dispose()
}
[System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
`;
  await runPowershell(script);
}

export function buildPowerShellInstallerLauncherScript(): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerScriptPath,

  [Parameter(Mandatory = $true)]
  [string]$PlanPath,

  [Parameter(Mandatory = $true)]
  [string]$LogPath,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory
)

$ErrorActionPreference = "Stop"

function Write-LauncherLog([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  $logDir = [System.IO.Path]::GetDirectoryName($LogPath)
  if (-not [string]::IsNullOrWhiteSpace($logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value "$((Get-Date).ToUniversalTime().ToString("o")) $Message" -Encoding UTF8
}

function ConvertTo-CommandLineArgument([string]$Value) {
  if ($null -eq $Value) { return '""' }
  $escaped = $Value.Replace('"', '\"')
  if ($escaped.Length -eq 0 -or $escaped -match '\s') {
    return '"' + $escaped + '"'
  }
  return $escaped
}

try {
  Write-LauncherLog "External updater launcher started."
  if (-not (Test-Path -LiteralPath $InstallerScriptPath -PathType Leaf)) { throw "Installer script is missing: $InstallerScriptPath" }
  if (-not (Test-Path -LiteralPath $PlanPath -PathType Leaf)) { throw "Install plan is missing: $PlanPath" }
  if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw "Working directory is missing: $WorkingDirectory" }
  $arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $InstallerScriptPath,
    "-PlanPath",
    $PlanPath,
    "-LogPath",
    $LogPath
  )
  $argumentText = ($arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " "
  Start-Process -FilePath "powershell.exe" -ArgumentList $argumentText -WindowStyle Hidden -WorkingDirectory $WorkingDirectory | Out-Null
  Write-LauncherLog "External updater installer process launched."
} catch {
  Write-LauncherLog "FAILED: updater launcher could not start installer: $($_.Exception.ToString())"
  exit 1
}
exit 0
`;
}

export function buildPowerShellInstallerScript(): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$PlanPath,

  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$ProcessDrainTimeoutMs = 15000
$ProcessForceTimeoutMs = 15000
$ParentWaitTimeoutMs = 60000
$FileRetryTimeoutMs = 60000
$FileRetryDelayMs = 500

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Write-InstallLog([object]$Plan, [string]$Message) {
  $logPath = [string]$Plan.logPath
  Write-LogPath $logPath $Message
}

function Write-BootstrapLog([string]$Message) {
  Write-LogPath $LogPath $Message
}

function Write-LogPath([string]$logPath, [string]$Message) {
  if ([string]::IsNullOrWhiteSpace($logPath)) { return }
  $logDir = [System.IO.Path]::GetDirectoryName($logPath)
  if (-not [string]::IsNullOrWhiteSpace($logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  Add-Content -LiteralPath $logPath -Value "$((Get-Date).ToUniversalTime().ToString("o")) $Message" -Encoding UTF8
}

function Assert-SafeRelativePath([string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/")
  if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized.StartsWith("/") -or $normalized -match "^[A-Za-z]:" -or ($normalized.Split("/") -contains "..")) {
    throw "Unsafe installer path: $RelativePath"
  }
}

function Assert-Inside([string]$Parent, [string]$Target) {
  $parentFull = Get-FullPath $Parent
  $targetFull = Get-FullPath $Target
  $separator = [System.IO.Path]::DirectorySeparatorChar
  if ($targetFull -ne $parentFull -and -not $targetFull.StartsWith($parentFull + $separator, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw ("Refusing path outside " + $parentFull + ": " + $targetFull)
  }
}

function Join-SafePath([string]$Root, [string]$RelativePath) {
  Assert-SafeRelativePath $RelativePath
  $rootFull = Get-FullPath $Root
  $target = Get-FullPath ([System.IO.Path]::Combine($rootFull, $RelativePath))
  Assert-Inside $rootFull $target
  return $target
}

function Get-Plan([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "Missing updater install plan path." }
  if (-not (Test-Path -LiteralPath $Path)) { throw "Updater install plan does not exist: $Path" }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Validate-Plan([object]$Plan) {
  if ([int]$Plan.schemaVersion -ne 1) { throw "Unsupported update install plan schema." }
  $installDir = Get-FullPath ([string]$Plan.installDir)
  $stagedPayloadRoot = Get-FullPath ([string]$Plan.stagedPayloadRoot)
  $appExePath = Get-FullPath ([string]$Plan.appExePath)
  Assert-Inside $installDir $appExePath
  if (-not (Test-Path -LiteralPath $installDir -PathType Container)) { throw "Install directory is missing: $installDir" }
  if (-not (Test-Path -LiteralPath $stagedPayloadRoot -PathType Container)) { throw "Staged update payload is missing: $stagedPayloadRoot" }
  $requiredFileGroups = @(
    @("Shockless.exe", "Habbpy v4.exe"),
    @("resources/app/package.json"),
    @("resources/app/dist/main/main/main.js"),
    @("resources/app/dist/main/main/updateInstallerHelper.js"),
    @("resources/engine/dist/index.html"),
    @("resources/relay/origins-relay.mjs")
  )
  foreach ($group in $requiredFileGroups) {
    $found = $false
    foreach ($file in @($group)) {
      $target = Join-SafePath $stagedPayloadRoot $file
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $found = $true
        break
      }
    }
    if (-not $found) { throw "Staged update is missing one of: $([string]::Join(', ', @($group)))." }
  }
}

function Test-PreservedInstallPath([string]$RelativePath) {
  $parts = @($RelativePath.Replace("\", "/").Split("/") | Where-Object { $_ })
  if ($parts.Count -eq 0) { return $false }
  $first = [string]$parts[0]
  return [string]::Equals($first, "clients", [System.StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($first, "data", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ManagedPluginRoots([object]$Plan) {
  $roots = @()
  if ($Plan.PSObject.Properties.Name -contains "managedPluginRoots") {
    foreach ($root in @($Plan.managedPluginRoots)) {
      $clean = ([string]$root).Replace("\", "/").Trim("/")
      if (-not [string]::IsNullOrWhiteSpace($clean)) { $roots += $clean.ToLowerInvariant() }
    }
  }
  if ($roots.Count -eq 0) {
    $roots = @("plugins/_premade-modules")
  }
  return $roots
}

function Get-RetiredPluginRoots([object]$Plan) {
  $roots = @()
  if ($Plan.PSObject.Properties.Name -contains "retiredPluginRoots") {
    foreach ($root in @($Plan.retiredPluginRoots)) {
      $clean = ([string]$root).Replace("\", "/").Trim("/")
      if (-not [string]::IsNullOrWhiteSpace($clean)) { $roots += $clean }
    }
  }
  if ($roots.Count -eq 0) {
    $roots = @("plugins/welcome-message")
  }
  return $roots
}

function Test-ManagedPluginPath([object]$Plan, [string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/").Trim("/").ToLowerInvariant()
  foreach ($root in Get-ManagedPluginRoots $Plan) {
    if ($normalized -eq $root -or $normalized.StartsWith($root + "/", [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Invoke-WithRetry([object]$Plan, [string]$Label, [scriptblock]$Operation) {
  $startedAt = Get-Date
  $attempt = 0
  while ($true) {
    try {
      & $Operation
      return
    } catch {
      $elapsedMs = ((Get-Date) - $startedAt).TotalMilliseconds
      if ($elapsedMs -ge $FileRetryTimeoutMs) { throw }
      if ($attempt -eq 0 -or ($attempt % 10) -eq 0) {
        Write-InstallLog $Plan ("Waiting for file lock during " + $Label + ": " + $_.Exception.Message)
      }
      $attempt += 1
      Start-Sleep -Milliseconds $FileRetryDelayMs
    }
  }
}

function Remember-Path([hashtable]$Table, [string]$RelativePath) {
  $Table[$RelativePath.ToLowerInvariant()] = $RelativePath
}

function Test-Remembered([hashtable]$Table, [string]$RelativePath) {
  return $Table.ContainsKey($RelativePath.ToLowerInvariant())
}

function Get-ReversedRememberedPaths([hashtable]$Table) {
  $values = @($Table.Values)
  for ($index = $values.Count - 1; $index -ge 0; $index -= 1) {
    $values[$index]
  }
}

function Backup-AndRemove([object]$Plan, [string]$Root, [string]$BackupRoot, [string]$RelativePath, [hashtable]$BackedUp) {
  $source = Join-SafePath $Root $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { return }
  $backup = Join-SafePath $BackupRoot $RelativePath
  $backupParent = [System.IO.Path]::GetDirectoryName($backup)
  if (-not [string]::IsNullOrWhiteSpace($backupParent)) {
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  }
  Invoke-WithRetry $Plan "backup $RelativePath" { Copy-Item -LiteralPath $source -Destination $backup -Recurse -Force }
  Invoke-WithRetry $Plan "remove $RelativePath" { Remove-Item -LiteralPath $source -Recurse -Force }
  Remember-Path $BackedUp $RelativePath
}

function Copy-InstallEntry([object]$Plan, [string]$SourceRoot, [string]$TargetRoot, [string]$BackupRoot, [string]$RelativePath, [hashtable]$BackedUp, [hashtable]$Added) {
  $source = Join-SafePath $SourceRoot $RelativePath
  $target = Join-SafePath $TargetRoot $RelativePath
  if (Test-Path -LiteralPath $target) {
    if (-not (Test-Remembered $BackedUp $RelativePath)) {
      Backup-AndRemove $Plan $TargetRoot $BackupRoot $RelativePath $BackedUp
    }
  } else {
    Remember-Path $Added $RelativePath
  }
  $targetParent = [System.IO.Path]::GetDirectoryName($target)
  if (-not [string]::IsNullOrWhiteSpace($targetParent)) {
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
  }
  Invoke-WithRetry $Plan "copy $RelativePath" { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
}

function Install-BundledPlugins([object]$Plan, [string]$StagedPayloadRoot, [string]$InstallDir, [string]$BackupDir, [hashtable]$BackedUp, [hashtable]$Added) {
  $stagedPlugins = Join-SafePath $StagedPayloadRoot "plugins"
  if (-not (Test-Path -LiteralPath $stagedPlugins -PathType Container)) { return }
  New-Item -ItemType Directory -Path (Join-SafePath $InstallDir "plugins") -Force | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $stagedPlugins -Force) {
    $relativePath = "plugins/$($entry.Name)"
    if (-not (Test-ManagedPluginPath $Plan $relativePath)) { continue }
    Copy-InstallEntry $Plan $StagedPayloadRoot $InstallDir $BackupDir $relativePath $BackedUp $Added
  }
}

function Remove-RetiredBundledPlugins([object]$Plan, [string]$InstallDir, [string]$BackupDir, [hashtable]$BackedUp) {
  foreach ($relativePath in Get-RetiredPluginRoots $Plan) {
    Backup-AndRemove $Plan $InstallDir $BackupDir $relativePath $BackedUp
  }
}

function Rollback-Install([object]$Plan, [string]$InstallDir, [string]$BackupDir, [hashtable]$BackedUp, [hashtable]$Added, [object]$OriginalError) {
  Write-InstallLog $Plan "Install failed; rolling back. $($OriginalError.Exception.Message)"
  foreach ($relativePath in Get-ReversedRememberedPaths $Added) {
    $target = Join-SafePath $InstallDir $relativePath
    Invoke-WithRetry $Plan "rollback remove $relativePath" {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
  }
  foreach ($relativePath in Get-ReversedRememberedPaths $BackedUp) {
    $backup = Join-SafePath $BackupDir $relativePath
    $target = Join-SafePath $InstallDir $relativePath
    Invoke-WithRetry $Plan "rollback clear $relativePath" {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
    if (Test-Path -LiteralPath $backup) {
      $targetParent = [System.IO.Path]::GetDirectoryName($target)
      if (-not [string]::IsNullOrWhiteSpace($targetParent)) {
        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
      }
      Invoke-WithRetry $Plan "rollback restore $relativePath" { Copy-Item -LiteralPath $backup -Destination $target -Recurse -Force }
    }
  }
}

function Test-PlanProcess([object]$Plan, [object]$ProcessInfo) {
  if ($null -eq $ProcessInfo) { return $false }
  $installDir = Get-FullPath ([string]$Plan.installDir)
  $appExePath = Get-FullPath ([string]$Plan.appExePath)
  $exe = [string]$ProcessInfo.ExecutablePath
  $command = [string]$ProcessInfo.CommandLine
  if (-not [string]::IsNullOrWhiteSpace($exe) -and [string]::Equals((Get-FullPath $exe), $appExePath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  if (-not [string]::IsNullOrWhiteSpace($exe) -and $exe.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  if (-not [string]::IsNullOrWhiteSpace($command) -and $command.IndexOf($installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  return $false
}

function Wait-ForProcessExit([object]$Plan, [int]$ProcessId, [int]$TimeoutMs) {
  if ($ProcessId -le 0) { return }
  $first = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $first) { return }
  if (-not (Test-PlanProcess $Plan $first)) {
    Write-InstallLog $Plan "Parent PID $ProcessId no longer belongs to this portable install; skipping parent wait."
    return
  }
  $startedAt = Get-Date
  while (((Get-Date) - $startedAt).TotalMilliseconds -lt $TimeoutMs) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    if (-not (Test-PlanProcess $Plan $process)) {
      Write-InstallLog $Plan "Parent PID $ProcessId was reused by another process; continuing install."
      return
    }
    Start-Sleep -Milliseconds 250
  }
  Write-InstallLog $Plan "Timed out waiting for parent process $ProcessId to exit."
}

function Get-InstallDirectoryProcesses([object]$Plan) {
  $installDir = Get-FullPath ([string]$Plan.installDir)
  $currentPid = $PID
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $currentPid -and (
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and $_.CommandLine.IndexOf($installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    )
  })
}

function Wait-ForInstallDirectoryProcesses([object]$Plan, [int]$TimeoutMs) {
  $startedAt = Get-Date
  while (((Get-Date) - $startedAt).TotalMilliseconds -lt $TimeoutMs) {
    $processes = @(Get-InstallDirectoryProcesses $Plan)
    if ($processes.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
}

function Stop-InstallDirectoryProcesses([object]$Plan) {
  $processes = @(Get-InstallDirectoryProcesses $Plan)
  if ($processes.Count -eq 0) { return }
  Write-InstallLog $Plan "Terminating $($processes.Count) stale install process(es): $(($processes | ForEach-Object { "$($_.Name):$($_.ProcessId)" }) -join ", ")"
  foreach ($process in $processes) {
    try {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
    } catch {
      Write-InstallLog $Plan "Failed to terminate $($process.Name):$($process.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Install-StagedUpdate([object]$Plan) {
  $installDir = Get-FullPath ([string]$Plan.installDir)
  $stagedPayloadRoot = Get-FullPath ([string]$Plan.stagedPayloadRoot)
  $backupDir = Get-FullPath ([string]$Plan.backupDir)
  $backedUp = @{}
  $added = @{}

  if (Test-Path -LiteralPath $backupDir) {
    Invoke-WithRetry $Plan "clear previous backup" { Remove-Item -LiteralPath $backupDir -Recurse -Force }
  }
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  try {
    foreach ($entry in Get-ChildItem -LiteralPath $installDir -Force) {
      $relativePath = $entry.Name
      if (Test-PreservedInstallPath $relativePath) { continue }
      if ([string]::Equals($relativePath, "plugins", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      Backup-AndRemove $Plan $installDir $backupDir $relativePath $backedUp
    }

    foreach ($entry in Get-ChildItem -LiteralPath $stagedPayloadRoot -Force) {
      $relativePath = $entry.Name
      if (Test-PreservedInstallPath $relativePath) { continue }
      if ([string]::Equals($relativePath, "plugins", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      Copy-InstallEntry $Plan $stagedPayloadRoot $installDir $backupDir $relativePath $backedUp $added
    }

    Remove-RetiredBundledPlugins $Plan $installDir $backupDir $backedUp
    Install-BundledPlugins $Plan $stagedPayloadRoot $installDir $backupDir $backedUp $added
  } catch {
    Rollback-Install $Plan $installDir $backupDir $backedUp $added $_
    throw
  }
}

function Restart-App([object]$Plan) {
  if ($Plan.relaunch -ne $true) { return }
  $appExePath = Get-FullPath ([string]$Plan.appExePath)
  $installDir = Get-FullPath ([string]$Plan.installDir)
  if (-not (Test-Path -LiteralPath $appExePath -PathType Leaf)) {
    Write-InstallLog $Plan "Updated app executable is missing; not relaunching: $appExePath"
    return
  }
  Start-Process -FilePath $appExePath -WorkingDirectory $installDir | Out-Null
}

$plan = $null
try {
  Write-BootstrapLog "External updater bootstrap started."
  $plan = Get-Plan $PlanPath
  Write-InstallLog $plan "External updater installer started."
  Validate-Plan $plan
  Write-InstallLog $plan "External updater installer ready."
  Wait-ForProcessExit $plan ([int]$plan.parentPid) $ParentWaitTimeoutMs
  Wait-ForInstallDirectoryProcesses $plan $ProcessDrainTimeoutMs
  Stop-InstallDirectoryProcesses $plan
  Wait-ForInstallDirectoryProcesses $plan $ProcessForceTimeoutMs
  Install-StagedUpdate $plan
  Write-InstallLog $plan "Install complete."
  Restart-App $plan
} catch {
  if ($null -ne $plan) {
    Write-InstallLog $plan "FAILED: $($_.Exception.ToString())"
  } else {
    Write-BootstrapLog "FAILED before plan: $($_.Exception.ToString())"
  }
  exit 1
}
exit 0
`;
}

function readPersistedState(filePath: string): PersistedUpdateState {
  try {
    const parsed = JSON.parse(readFileSyncUtf8(filePath)) as PersistedUpdateState;
    return { skippedVersion: typeof parsed.skippedVersion === "string" ? parsed.skippedVersion : undefined };
  } catch {
    return {};
  }
}

async function writePersistedState(filePath: string, state: PersistedUpdateState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readFileSyncUtf8(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function renamePortableFile(from: string, to: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

async function resolveStagedPayloadRoot(stageRoot: string): Promise<string | null> {
  const direct = resolve(stageRoot);
  if (payloadRootHasAppExe(direct)) return direct;
  for (const dirName of [APP_PORTABLE_DIR_NAME, ...LEGACY_APP_PORTABLE_DIR_NAMES]) {
    const named = join(direct, dirName);
    if (payloadRootHasAppExe(named)) return named;
  }
  const entries = await readdir(direct, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    const child = join(direct, directories[0].name);
    if (payloadRootHasAppExe(child)) return child;
  }
  return null;
}

function payloadRootHasAppExe(root: string): boolean {
  return Boolean(stagedPayloadExecutableName(root));
}

function stagedPayloadExecutableName(root: string): string | null {
  return [APP_EXECUTABLE_NAME, ...LEGACY_APP_EXECUTABLE_NAMES].find((fileName) => existsSync(join(root, fileName))) ?? null;
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(filePath);
    else if (entry.isFile()) yield filePath;
  }
}

async function runPowershell(script: string): Promise<void> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeVersionDir(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "update";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replaceableInstallerPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("../")) return false;
  if (portableInstallPathIsPreserved(normalized)) return false;
  if (normalized.split("/")[0]?.toLowerCase() === "plugins") {
    return installerManagedPluginPath(normalized) || installerRetiredPluginPath(normalized);
  }
  return true;
}
