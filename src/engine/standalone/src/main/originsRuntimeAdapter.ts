import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGINS_MINIMUM_BUILD_NUMBER } from "../common/types.js";

export const ORIGINS_PLAYABLE_BASELINE = {
  versionId: "origins",
} as const;

const FALLBACK_EXECUTABLE_SCRIPT_VERSIONS = ["release306"] as const;

export function isPlayableOriginsBaseline(versionId: string): boolean {
  const build = originsBuildNumber(versionId);
  return build !== null && build >= minimumOriginsBuildNumber();
}

export function unsupportedOriginsProfileReason(versionId: string): string {
  return `${versionId} imported, but Play needs a supported Origins build, complete generated data/assets, and executable generated scripts for that profile.`;
}

export function minimumOriginsBuildNumber(): number {
  return ORIGINS_MINIMUM_BUILD_NUMBER;
}

export function requiredRuntimeDataFiles(versionId: string): string[] {
  return [
    `${versionId}-projectorrays-manifest.json`,
    `projectorrays-text-fields.${versionId}.json`,
    `external-cast-text-fields.${versionId}.json`,
    `external-bitmap-assets.${versionId}.json`,
    `visual-bitmap-assets.${versionId}.json`,
    `external-cast-visual-layout-index.${versionId}.json`,
    `external-cast-graph.${versionId}.json`,
    `sound-assets.${versionId}.json`,
  ];
}

export function optionalRuntimeDataFiles(versionId: string): string[] {
  return [
    `button-bitmap-assets.${versionId}.json`,
    `external-cast-text-fields-supplement.${versionId}.json`,
    `external-cast-window-layout-index.${versionId}.json`,
    `external-fields.${versionId}.json`,
  ];
}

export function assetIndexFiles(versionId: string): string[] {
  return [
    ...bitmapAssetIndexFiles(versionId),
    ...soundAssetIndexFiles(versionId),
  ];
}

export function bitmapAssetIndexFiles(versionId: string): string[] {
  return [
    `external-bitmap-assets.${versionId}.json`,
    `visual-bitmap-assets.${versionId}.json`,
    `button-bitmap-assets.${versionId}.json`,
  ];
}

export function soundAssetIndexFiles(versionId: string): string[] {
  return [`sound-assets.${versionId}.json`];
}

export function supportedExecutableScriptVersions(): readonly string[] {
  return FALLBACK_EXECUTABLE_SCRIPT_VERSIONS;
}

export function hasBundledExecutableScripts(versionId: string, supportedVersions: readonly string[] = supportedExecutableScriptVersions()): boolean {
  const normalized = versionId.trim().toLowerCase();
  return supportedVersions.map((version) => version.trim().toLowerCase()).includes(normalized);
}

export function missingExecutableScriptsReason(versionId: string): string {
  return (
    `${versionId} imported successfully, but this packaged engine does not include executable generated scripts for ${versionId}. ` +
    `Re-import the compiled client with the current standalone so the profile-local executable script registry is generated before Play is enabled.`
  );
}

export function detectEngineExecutableScriptVersions(engineRoot: string): readonly string[] {
  const manifestVersions = readExecutableScriptManifest(engineRoot);
  if (manifestVersions.length > 0) return manifestVersions;

  const sourceVersions = discoverSourceExecutableScriptVersions(engineRoot);
  if (sourceVersions.length > 0) return sourceVersions;

  return supportedExecutableScriptVersions();
}

function readExecutableScriptManifest(engineRoot: string): string[] {
  for (const manifestPath of [
    join(engineRoot, "origins-executable-scripts.json"),
    join(engineRoot, "dist", "origins-executable-scripts.json"),
  ]) {
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { versions?: unknown };
      return normalizeExecutableVersions(raw.versions);
    } catch {
      continue;
    }
  }
  return [];
}

function discoverSourceExecutableScriptVersions(engineRoot: string): string[] {
  const versions = new Set<string>();
  if (existsSync(join(engineRoot, "generated", "scripts", "registry.ts"))) {
    versions.add("release306");
  }
  return sortExecutableVersions([...versions]);
}

function normalizeExecutableVersions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return sortExecutableVersions(
    [...new Set(value.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => /^release\d+$/.test(entry)))],
  );
}

function sortExecutableVersions(versions: string[]): string[] {
  return versions.sort((left, right) => {
    const leftBuild = Number(/^release(\d+)$/i.exec(left)?.[1] ?? 0);
    const rightBuild = Number(/^release(\d+)$/i.exec(right)?.[1] ?? 0);
    if (leftBuild !== rightBuild) return leftBuild - rightBuild;
    return left.localeCompare(right);
  });
}

function originsBuildNumber(versionId: string): number | null {
  const match = /^release(\d+)$/i.exec(versionId.trim());
  if (!match?.[1]) return null;
  const build = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(build) ? build : null;
}
