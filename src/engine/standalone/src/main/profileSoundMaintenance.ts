import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { RuntimeProfile } from "../common/types.js";
import { validateRuntimeReadiness } from "./profileImporter.js";
import { defaultExtractionToolsRoot } from "./profilePaths.js";
import {
  profileValidationReportPath,
  validateProfileContract,
} from "./profileValidator.js";

export const DIRECTOR_SOUND_ASSET_SCHEMA_VERSION = 3;

export interface ProfileSoundMaintenanceResult {
  readonly current: boolean;
  readonly updated: boolean;
  readonly soundCount: number;
  readonly movieSoundCount: number;
  readonly externalSoundCount: number;
  readonly backupPath: string | null;
}

interface SoundAssetIndex {
  readonly schemaVersion?: unknown;
  readonly soundCount?: unknown;
  readonly movieSoundCount?: unknown;
  readonly externalSoundCount?: unknown;
  readonly unsupportedCount?: unknown;
}

export function profileSoundAssetsAreCurrent(profileRoot: string, profile: RuntimeProfile): boolean {
  const index = readSoundAssetIndex(profileRoot, profile);
  return Number(index?.schemaVersion) >= DIRECTOR_SOUND_ASSET_SCHEMA_VERSION;
}

export function refreshProfileSoundAssets(
  profileRoot: string,
  profile: RuntimeProfile,
  options: {
    readonly extractionToolsRoot?: string;
    readonly force?: boolean;
    readonly timeoutMs?: number;
  } = {},
): ProfileSoundMaintenanceResult {
  const currentIndex = readSoundAssetIndex(profileRoot, profile);
  if (!options.force && Number(currentIndex?.schemaVersion) >= DIRECTOR_SOUND_ASSET_SCHEMA_VERSION) {
    return resultFromIndex(currentIndex, true, false, null);
  }

  const version = profile.versionId;
  const runtimeDataRoot = join(profileRoot, profile.paths.runtimeData);
  const assetsRoot = join(profileRoot, profile.paths.assets);
  const extractedRoot = join(profileRoot, profile.paths.extracted);
  const scriptsRoot = join(profileRoot, profile.paths.scripts);
  const manifestPath = join(runtimeDataRoot, `${version}-projectorrays-manifest.json`);
  const externalCastGraphPath = join(runtimeDataRoot, `external-cast-graph.${version}.json`);
  const soundAssetPath = join(runtimeDataRoot, `sound-assets.${version}.json`);
  const toolPath = join(
    options.extractionToolsRoot ?? defaultExtractionToolsRoot(),
    "audio",
    "director-sound-assets.mjs",
  );
  for (const requiredPath of [manifestPath, externalCastGraphPath, toolPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Cannot refresh Director sound assets because a required source file is missing: ${requiredPath}`);
    }
  }

  const tempRoot = join(profileRoot, `.refresh-sound-assets-${Date.now()}`);
  const tempIndexPath = join(tempRoot, `sound-assets.${version}.json`);
  mkdirSync(tempRoot, { recursive: true });
  let backupPath: string | null = null;
  try {
    const toolArgs = [
      toolPath,
      "--version",
      version,
      "--manifest",
      manifestPath,
      "--external-cast-graph",
      externalCastGraphPath,
      "--runtime-data-root",
      runtimeDataRoot,
      "--asset-root",
      join(assetsRoot, "sounds"),
      "--asset-path-base",
      assetsRoot,
      "--out",
      tempIndexPath,
    ];
    const processResult = spawnSync(process.execPath, toolArgs, {
      cwd: profileRoot,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      encoding: "utf8",
      timeout: options.timeoutMs ?? 180_000,
      windowsHide: true,
    });
    if (processResult.status !== 0) {
      const output = `${processResult.stdout ?? ""}${processResult.stderr ?? ""}`.trim();
      throw new Error(
        `Director sound asset refresh failed (${processResult.status ?? processResult.signal ?? "signal"}): ` +
          `${basename(toolPath)}${output ? `\n${output}` : ""}`,
      );
    }

    const refreshedIndex = readJson<SoundAssetIndex>(tempIndexPath);
    assertNonRegressiveSoundIndex(currentIndex, refreshedIndex);
    if (existsSync(soundAssetPath)) {
      backupPath = `${soundAssetPath}.bak-${Date.now()}`;
      copyFileSync(soundAssetPath, backupPath);
    }
    const replacementPath = `${soundAssetPath}.tmp-${Date.now()}`;
    copyFileSync(tempIndexPath, replacementPath);
    renameSync(replacementPath, soundAssetPath);

    const report = validateProfileContract({
      versionId: version,
      runtimeDataRoot,
      assetsRoot,
      scriptsRoot,
      extractedRoot,
      runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
    });
    const sound = report.diagnostics.soundInventory;
    if (sound.unsupported > 0 || sound.missing > 0 || sound.invalidMetadata > 0 || sound.extracted !== sound.declared) {
      if (backupPath) copyFileSync(backupPath, soundAssetPath);
      throw new Error(
        `Refusing Director sound profile upgrade: ${sound.extracted}/${sound.declared} extracted, ` +
          `${sound.unsupported} unsupported, ${sound.missing} missing, ${sound.invalidMetadata} invalid.`,
      );
    }

    writeFileSync(profileValidationReportPath(profileRoot), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const runtime = validateRuntimeReadiness(runtimeDataRoot, version, assetsRoot, extractedRoot, {
      validateAssetContents: true,
      validateRuntimeDataContents: true,
      runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
      profileValidation: report,
    });
    persistProfile(profileRoot, { ...profile, runtime });
    return resultFromIndex(refreshedIndex, false, true, backupPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function readSoundAssetIndex(profileRoot: string, profile: RuntimeProfile): SoundAssetIndex | null {
  const path = join(profileRoot, profile.paths.runtimeData, `sound-assets.${profile.versionId}.json`);
  return existsSync(path) ? readJson<SoundAssetIndex>(path) : null;
}

function assertNonRegressiveSoundIndex(
  current: SoundAssetIndex | null,
  refreshed: SoundAssetIndex,
): void {
  const refreshedSchema = Number(refreshed.schemaVersion) || 0;
  const refreshedSounds = nonNegativeInteger(refreshed.soundCount);
  const currentSounds = nonNegativeInteger(current?.soundCount);
  const refreshedUnsupported = nonNegativeInteger(refreshed.unsupportedCount);
  const currentUnsupported = nonNegativeInteger(current?.unsupportedCount);
  if (refreshedSchema < DIRECTOR_SOUND_ASSET_SCHEMA_VERSION) {
    throw new Error(
      `Refusing Director sound profile upgrade: extractor emitted schema ${refreshedSchema}, expected at least ${DIRECTOR_SOUND_ASSET_SCHEMA_VERSION}.`,
    );
  }
  if (refreshedSounds < currentSounds) {
    throw new Error(
      `Refusing Director sound profile upgrade: sound records decreased ${currentSounds} -> ${refreshedSounds}.`,
    );
  }
  if (refreshedUnsupported > currentUnsupported) {
    throw new Error(
      `Refusing Director sound profile upgrade: unsupported records increased ${currentUnsupported} -> ${refreshedUnsupported}.`,
    );
  }
}

function resultFromIndex(
  index: SoundAssetIndex | null,
  current: boolean,
  updated: boolean,
  backupPath: string | null,
): ProfileSoundMaintenanceResult {
  return {
    current,
    updated,
    soundCount: nonNegativeInteger(index?.soundCount),
    movieSoundCount: nonNegativeInteger(index?.movieSoundCount),
    externalSoundCount: nonNegativeInteger(index?.externalSoundCount),
    backupPath,
  };
}

function persistProfile(profileRoot: string, profile: RuntimeProfile): void {
  const profilePath = join(profileRoot, "profile.json");
  const tempPath = `${profilePath}.tmp-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  renameSync(tempPath, profilePath);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
