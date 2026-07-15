export const UPDATE_REPOSITORY_OWNER = "deklol";
export const UPDATE_REPOSITORY_NAME = "Shockless";
export const UPDATE_MANIFEST_ASSET_NAME = "update.json";
export const UPDATE_PLATFORM = "win32-x64";
export const MAX_UPDATE_BYTES = 750 * 1024 * 1024;
export const INSTALLER_MANAGED_PLUGIN_ROOTS = ["plugins/_premade-modules"] as const;
export const INSTALLER_RETIRED_PLUGIN_ROOTS = ["plugins/welcome-message"] as const;

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "skipped"
  | "unavailable"
  | "error";

export interface UpdateReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly channel: "stable";
  readonly platform: typeof UPDATE_PLATFORM;
  readonly assetName: string;
  readonly sha256: string;
  readonly size: number;
  readonly releaseUrl: string;
  readonly publishedAt?: string;
  readonly notes?: string;
  readonly minimumAppVersion?: string;
}

export interface UpdateReleaseInfo extends UpdateReleaseManifest {
  readonly tagName: string;
  readonly assetUrl: string;
  readonly manifestUrl: string;
}

export interface AppUpdateProgress {
  readonly bytesReceived: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface AppUpdateState {
  readonly status: AppUpdateStatus;
  readonly currentVersion: string;
  readonly lastCheckedAt: string | null;
  readonly skippedVersion: string | null;
  readonly available: UpdateReleaseInfo | null;
  readonly progress: AppUpdateProgress | null;
  readonly stagedPath: string | null;
  readonly message: string;
  readonly error: string | null;
}

export interface ManifestValidationResult {
  readonly ok: boolean;
  readonly manifest: UpdateReleaseManifest | null;
  readonly message: string;
}

export function emptyUpdateState(currentVersion: string, skippedVersion: string | null = null): AppUpdateState {
  return {
    status: "idle",
    currentVersion,
    lastCheckedAt: null,
    skippedVersion,
    available: null,
    progress: null,
    stagedPath: null,
    message: "Update checker idle.",
    error: null,
  };
}

export function compareAppVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const width = Math.max(a.parts.length, b.parts.length, 3);
  for (let index = 0; index < width; index += 1) {
    const leftPart = a.parts[index] ?? 0;
    const rightPart = b.parts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease !== b.prerelease) return a.prerelease > b.prerelease ? 1 : -1;
  return 0;
}

export function isNewerAppVersion(candidate: string, current: string): boolean {
  return compareAppVersions(candidate, current) > 0;
}

export function updatePercent(bytesReceived: number, totalBytes: number): number {
  if (!Number.isFinite(bytesReceived) || !Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((bytesReceived / totalBytes) * 100)));
}

export function validateUpdateManifest(input: unknown, expectedPlatform = UPDATE_PLATFORM): ManifestValidationResult {
  if (!isRecord(input)) return invalidManifest("Update manifest is not an object.");
  if (input.schemaVersion !== 1) return invalidManifest("Update manifest schemaVersion must be 1.");
  if (input.channel !== "stable") return invalidManifest("Only stable update manifests are accepted.");
  if (input.platform !== expectedPlatform) return invalidManifest(`Update platform must be ${expectedPlatform}.`);

  const version = cleanString(input.version);
  const assetName = cleanString(input.assetName);
  const sha256 = cleanString(input.sha256).toLowerCase();
  const releaseUrl = cleanString(input.releaseUrl);
  const publishedAt = cleanOptionalString(input.publishedAt);
  const notes = cleanOptionalString(input.notes);
  const minimumAppVersion = cleanOptionalString(input.minimumAppVersion);
  const size = Number(input.size);

  if (!version || !/^[vV]?\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(version)) {
    return invalidManifest("Update version is missing or invalid.");
  }
  if (!assetName || /[\\/:*?"<>|]/.test(assetName) || !assetName.toLowerCase().endsWith(".zip")) {
    return invalidManifest("Update assetName must be a portable zip file name.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) return invalidManifest("Update sha256 must be a 64-character hex digest.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_BYTES) {
    return invalidManifest(`Update size must be between 1 byte and ${MAX_UPDATE_BYTES} bytes.`);
  }
  if (!isSafeHttpsUrl(releaseUrl, "github.com")) return invalidManifest("Update releaseUrl must be a GitHub HTTPS URL.");
  if (minimumAppVersion && !/^[vV]?\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(minimumAppVersion)) {
    return invalidManifest("Update minimumAppVersion is invalid.");
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      version,
      channel: "stable",
      platform: expectedPlatform as typeof UPDATE_PLATFORM,
      assetName,
      sha256,
      size,
      releaseUrl,
      ...(publishedAt ? { publishedAt } : {}),
      ...(notes ? { notes } : {}),
      ...(minimumAppVersion ? { minimumAppVersion } : {}),
    },
    message: "Update manifest is valid.",
  };
}

export function isSafeHttpsUrl(value: string, expectedHost?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (expectedHost && url.hostname.toLowerCase() !== expectedHost.toLowerCase()) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateSafeZipEntryName(name: string): { readonly ok: boolean; readonly message: string } {
  const normalized = String(name ?? "").replaceAll("\\", "/");
  if (!normalized.trim()) return { ok: false, message: "Zip entry name is empty." };
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return { ok: false, message: `Zip entry uses an absolute path: ${name}` };
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    return { ok: false, message: `Zip entry attempts to leave the update directory: ${name}` };
  }
  if (parts.some((part) => /[\x00-\x1f]/.test(part))) {
    return { ok: false, message: `Zip entry contains control characters: ${name}` };
  }
  return { ok: true, message: "Zip entry path is safe." };
}

export function publicUpdatePathIsForbidden(relativePath: string): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/").map((part) => part.toLowerCase()).filter(Boolean);
  if (parts.includes("clients")) return true;
  const name = parts[parts.length - 1] ?? "";
  return name === "goal.md" || name === "multiclient-accounts.txt" || name === ".env" || name.startsWith(".env.");
}

export function portableInstallPathIsPreserved(relativePath: string): boolean {
  const first = relativePath.replaceAll("\\", "/").split("/").find(Boolean)?.toLowerCase() ?? "";
  return first === "clients" || first === "data";
}

export function installerManagedPluginPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  return INSTALLER_MANAGED_PLUGIN_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function installerRetiredPluginPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  return INSTALLER_RETIRED_PLUGIN_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function parseVersion(version: string): { readonly parts: readonly number[]; readonly prerelease: string } {
  const normalized = version.trim().replace(/^[vV]/, "");
  const [withoutBuild] = normalized.split("+", 1);
  const [numeric, prerelease = ""] = withoutBuild.split("-", 2);
  return {
    parts: numeric.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }),
    prerelease,
  };
}

function invalidManifest(message: string): ManifestValidationResult {
  return { ok: false, manifest: null, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanOptionalString(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  return cleaned || undefined;
}
