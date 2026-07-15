import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const CURRENT_SOUND_ASSET_SCHEMA = 3;
const activeMaintenance = new Map<string, Promise<ProfileAudioMaintenanceResult>>();

export interface ProfileAudioMaintenanceResult {
  readonly current: boolean;
  readonly updated: boolean;
  readonly message: string;
}

export function ensureProfileAudioCurrent(profileRoot: string): Promise<ProfileAudioMaintenanceResult> {
  const resolvedRoot = resolve(profileRoot);
  const active = activeMaintenance.get(resolvedRoot);
  if (active) return active;
  const maintenance = maintainProfileAudio(resolvedRoot).finally(() => {
    if (activeMaintenance.get(resolvedRoot) === maintenance) activeMaintenance.delete(resolvedRoot);
  });
  activeMaintenance.set(resolvedRoot, maintenance);
  return maintenance;
}

export function profileNeedsAudioMaintenance(profileRoot: string): boolean {
  const profile = readProfileIdentity(profileRoot);
  if (!profile) return false;
  const soundIndexPath = join(
    profileRoot,
    profile.runtimeDataPath,
    `sound-assets.${profile.versionId}.json`,
  );
  if (!existsSync(soundIndexPath)) return true;
  try {
    const index = JSON.parse(readFileSync(soundIndexPath, "utf8")) as { schemaVersion?: unknown };
    return Number(index.schemaVersion) < CURRENT_SOUND_ASSET_SCHEMA;
  } catch {
    return true;
  }
}

async function maintainProfileAudio(profileRoot: string): Promise<ProfileAudioMaintenanceResult> {
  if (!profileNeedsAudioMaintenance(profileRoot)) {
    return { current: true, updated: false, message: "Director sound profile data is current." };
  }
  const cliPath = resolveProfileSoundRefreshCli();
  if (!cliPath) {
    throw new Error(
      "The selected profile needs a Director sound metadata upgrade, but the bundled profile sound maintenance tool was not found. " +
        "Build the standalone engine resources and package Shockless again.",
    );
  }
  await runMaintenanceCli(cliPath, profileRoot);
  if (profileNeedsAudioMaintenance(profileRoot)) {
    throw new Error("Director sound profile maintenance completed without producing the current sound metadata schema.");
  }
  return {
    current: false,
    updated: true,
    message: "Director sound profile data was upgraded from the profile's extracted source data.",
  };
}

function resolveProfileSoundRefreshCli(): string | null {
  const configured = process.env.SHOCKLESS_PROFILE_SOUND_REFRESH_CLI?.trim();
  if (configured && existsSync(configured)) return resolve(configured);

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath
      ? join(resourcesPath, "engine", "standalone", "dist", "main", "cli", "profile-refresh-sounds.js")
      : undefined,
    resolve(MAIN_DIR, "..", "..", "..", "..", "engine", "standalone", "dist", "main", "cli", "profile-refresh-sounds.js"),
    process.env.SHOCKLESS_ENGINE_ROOT
      ? join(process.env.SHOCKLESS_ENGINE_ROOT, "standalone", "dist", "main", "cli", "profile-refresh-sounds.js")
      : undefined,
    resolve(process.cwd(), "engine", "standalone", "dist", "main", "cli", "profile-refresh-sounds.js"),
    ...ancestorCandidates("engine", "standalone", "dist", "main", "cli", "profile-refresh-sounds.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function runMaintenanceCli(cliPath: string, profileRoot: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, "--profile-root", profileRoot], {
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const detail = `${stdout}${stderr}`.trim();
      reject(
        new Error(
          `Director sound profile maintenance failed (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : "."}`,
        ),
      );
    });
  });
}

function readProfileIdentity(profileRoot: string): {
  readonly versionId: string;
  readonly runtimeDataPath: string;
} | null {
  const profilePath = join(profileRoot, "profile.json");
  if (!existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
      versionId?: unknown;
      paths?: { runtimeData?: unknown };
    };
    if (typeof profile.versionId !== "string" || typeof profile.paths?.runtimeData !== "string") return null;
    return { versionId: profile.versionId, runtimeDataPath: profile.paths.runtimeData };
  } catch {
    return null;
  }
}

function ancestorCandidates(...parts: readonly string[]): readonly string[] {
  const candidates = new Set<string>();
  for (const start of [process.cwd(), process.execPath ? dirname(process.execPath) : process.cwd()]) {
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
