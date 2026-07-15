import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function standaloneRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", ".."), resolve(here, "..", "..", ".."), resolve(process.cwd())];
  return candidates.find(isStandaloneRoot) ?? resolve(here, "..", "..");
}

export function repoRootFromStandalone(): string {
  return resolve(standaloneRoot(), "..");
}

export function engineRootForRuntime(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedEngineRoot = resourcesPath ? join(resourcesPath, "engine") : "";
  if (packagedEngineRoot && existsSync(packagedEngineRoot)) return packagedEngineRoot;
  return repoRootFromStandalone();
}

export function resourcePath(...parts: string[]): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedResources = resourcesPath ? join(resourcesPath, ...parts) : "";
  if (packagedResources && existsSync(packagedResources)) return packagedResources;
  return join(standaloneRoot(), "resources", ...parts);
}

export function defaultProjectorRaysExe(): string {
  // Only a Windows build of ProjectorRays is bundled today. Other platforms
  // resolve to a platform-suffixed binary in the same resources folder (so
  // future bundled builds are picked up automatically) and can always point
  // SHOCKLESS_PROJECTORRAYS_PATH at a locally built binary.
  const override = process.env.SHOCKLESS_PROJECTORRAYS_PATH;
  if (override) return override;
  const candidates =
    process.platform === "win32"
      ? ["shockless-projectorrays-0.2.0.exe", "projectorrays-0.2.0.exe"]
      : [
          `projectorrays-0.2.0-${process.platform}-${process.arch}`,
          `projectorrays-0.2.0-${process.platform}`,
          "projectorrays",
        ];
  for (const name of candidates) {
    const candidate = resourcePath("projectorrays", name);
    if (existsSync(candidate)) return candidate;
  }
  return resourcePath("projectorrays", candidates[0]!);
}

export function projectorRaysSupportsShocklessProfile(executable: string): boolean {
  if (!existsSync(executable)) return false;
  const manifestPath = join(dirname(executable), "shockless-projectorrays.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      protocol?: unknown;
      binary?: unknown;
      sha256?: unknown;
      capabilities?: unknown;
    };
    if (manifest.schemaVersion !== 1 || manifest.protocol !== "shockless-profile-v1") return false;
    if (manifest.binary !== basename(executable) || typeof manifest.sha256 !== "string") return false;
    if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.includes("runtime-artifacts-only")) return false;
    const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
    return actual === manifest.sha256.toLowerCase();
  } catch {
    return false;
  }
}

export function defaultRelayScript(): string {
  return resourcePath("relay", "origins-relay.mjs");
}

export function defaultExtractionToolsRoot(): string {
  return resourcePath("extraction");
}

export function defaultProfileScriptCompiler(): string {
  return resourcePath("compiler", "profile-script-compiler.mjs");
}

export function appCacheRoot(appDataPath: string): string {
  return join(appDataPath, "ShocklessEngine");
}

export function portableClientsRoot(baseRoot = standaloneRoot()): string {
  return join(baseRoot, "clients");
}

function isStandaloneRoot(candidate: string): boolean {
  return existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "resources"));
}
