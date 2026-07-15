import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { appCacheRoot, defaultExtractionToolsRoot, portableClientsRoot } from "../main/profilePaths.js";
import { ProfileStore } from "../main/profileStore.js";
import { validateRuntimeReadiness } from "../main/profileImporter.js";
import { profileValidationReportPath, validateProfileContract } from "../main/profileValidator.js";
import type { RuntimeProfile } from "../common/types.js";

type SkippedVisualRefresh = {
  readonly visualName: string;
  readonly existingAssetCount: number;
  readonly refreshedAssetCount: number;
  readonly reason: string;
};

const args = parseArgs(process.argv.slice(2));
const cacheRoot = firstArg(args["cache-root"] ?? args.cacheRoot) ?? appCacheRoot(process.env.APPDATA ?? process.cwd());
const clientsRoot = firstArg(args["clients-root"] ?? args.clientsRoot) ?? portableClientsRoot();
const profileLocator = firstArg(args.profile ?? args["profile-id"] ?? args.profileId);
const profileRootArg = firstArg(args["profile-root"] ?? args.profileRoot);
const explicitVisuals = asArray(args.visual).map(String);
const dryRun = args["dry-run"] === "1";

if (!profileLocator && !profileRootArg) {
  throw new Error("Usage: npm run profile:refresh-visuals -- --profile <id> [--visual <name>] [--dry-run]\n   or: npm run profile:refresh-visuals -- --profile-root <path> [--visual <name>] [--dry-run]");
}

const { store, profile, profileRoot } = loadProfile(cacheRoot, clientsRoot, profileLocator, profileRootArg);
const runtimeDataRoot = join(profileRoot, profile.paths.runtimeData);
const assetsRoot = join(profileRoot, profile.paths.assets);
const extractedRoot = join(profileRoot, profile.paths.extracted);
const scriptsRoot = join(profileRoot, profile.paths.scripts);
const currentReport = validateProfileContract({
  versionId: profile.versionId,
  runtimeDataRoot,
  assetsRoot,
  scriptsRoot,
  extractedRoot,
  runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
});
const targetVisuals = explicitVisuals.length > 0 ? explicitVisuals : refreshableVisualNames(currentReport);

if (targetVisuals.length === 0) {
  writeFileSync(profileValidationReportPath(profileRoot), `${JSON.stringify(currentReport, null, 2)}\n`, "utf8");
  const runtime = validateRuntimeReadiness(runtimeDataRoot, profile.versionId, assetsRoot, extractedRoot, {
    validateAssetContents: true,
    validateRuntimeDataContents: true,
    runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
    profileValidation: currentReport,
  });
  persistProfileRuntime(store, profileRoot, profile, runtime);
  console.log("No partial visual layout gaps found.");
  process.exit(0);
}

console.log(JSON.stringify({ profileId: profile.id, profileRoot, targetVisuals: targetVisuals.length, dryRun }, null, 2));
for (const visual of targetVisuals.slice(0, 20)) {
  console.log(`- ${visual}`);
}
if (targetVisuals.length > 20) {
  console.log(`- ... ${targetVisuals.length - 20} more`);
}
if (dryRun) process.exit(0);

const version = profile.versionId;
const tempRoot = join(profileRoot, `.refresh-visual-assets-${Date.now()}`);
const tempOut = join(tempRoot, `visual-bitmap-assets.${version}.json`);
mkdirSync(tempRoot, { recursive: true });

const toolPath = join(defaultExtractionToolsRoot(), "build-visual-bitmap-assets.mjs");
const toolArgs = [
  toolPath,
  "--version",
  version,
  "--source-root",
  extractedRoot,
  "--runtime-data-root",
  runtimeDataRoot,
  "--asset-root",
  join(assetsRoot, "visual-bitmaps"),
  "--asset-path-base",
  assetsRoot,
  "--out",
  tempOut,
  ...targetVisuals.flatMap((visual) => ["--visual", visual]),
];
const result = spawnSync(process.execPath, toolArgs, {
  cwd: profileRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1" },
  encoding: "utf8",
});
if (result.status !== 0) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  throw new Error(`Visual asset refresh failed (${result.status ?? "signal"}): ${basename(toolPath)}${output ? `\n${output}` : ""}`);
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const visualAssetPath = join(runtimeDataRoot, `visual-bitmap-assets.${version}.json`);
const backupPath = `${visualAssetPath}.bak-${Date.now()}`;
copyFileSync(visualAssetPath, backupPath);
const merged = mergeVisualBitmapAssets(readJson(visualAssetPath), readJson(tempOut), new Set(targetVisuals.map(normalizeName)));
const skippedRegressiveVisualRefreshes = arrayOfRecords(
  (merged as Record<string, unknown>).skippedRegressiveVisualRefreshes,
).map((entry) => String(entry.visualName ?? entry.name ?? ""));
const tempMergedPath = `${visualAssetPath}.tmp-${Date.now()}`;
writeFileSync(tempMergedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
renameSync(tempMergedPath, visualAssetPath);

const refreshedReport = validateProfileContract({
  versionId: profile.versionId,
  runtimeDataRoot,
  assetsRoot,
  scriptsRoot,
  extractedRoot,
  runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
});
writeFileSync(profileValidationReportPath(profileRoot), `${JSON.stringify(refreshedReport, null, 2)}\n`, "utf8");

const runtime = validateRuntimeReadiness(runtimeDataRoot, profile.versionId, assetsRoot, extractedRoot, {
  validateAssetContents: true,
  validateRuntimeDataContents: true,
  runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
  profileValidation: refreshedReport,
});
persistProfileRuntime(store, profileRoot, profile, runtime);

console.log(JSON.stringify({
  refreshedVisuals: targetVisuals.length,
  backupPath,
  ready: refreshedReport.ready,
  warnings: refreshedReport.issues.filter((issue) => issue.severity === "warning").length,
  visualLayoutGaps: refreshedReport.diagnostics.visualLayoutClosure.partialLayouts,
  directRecoverable: refreshedReport.checks.find((check) => check.name === "visual-layout-source-recovery")?.counts?.directRecoverable ?? 0,
  ...(skippedRegressiveVisualRefreshes.length > 0 ? { skippedRegressiveVisualRefreshes } : {}),
}, null, 2));

function refreshableVisualNames(report: ReturnType<typeof validateProfileContract>): string[] {
  const names = new Set<string>();
  for (const gap of report.diagnostics.visualLayoutClosure.gaps) {
    if (gap.missingBitmapReferences.length > 0) {
      names.add(gap.visualName);
    }
  }
  return [...names].sort();
}

function mergeVisualBitmapAssets(existingRaw: unknown, refreshedRaw: unknown, refreshedVisualNames: Set<string>): unknown {
  const existing = existingRaw as Record<string, unknown>;
  const refreshed = refreshedRaw as Record<string, unknown>;
  const existingRelease = firstRelease(existing);
  const refreshedRelease = firstRelease(refreshed);
  const mergedRelease = { ...existingRelease };
  const existingUnsupported = arrayOfRecords(existingRelease.unsupported);
  const refreshedUnsupported = arrayOfRecords(refreshedRelease.unsupported);
  const existingVisuals = arrayOfRecords(existingRelease.visuals);
  const refreshedVisuals = arrayOfRecords(refreshedRelease.visuals);
  const existingVisualsByName = new Map(existingVisuals.map((visual) => [normalizeName(visual.visualName ?? visual.memberName), visual]));
  const refreshedUnsupportedNames = new Set(refreshedUnsupported.map((entry) => normalizeName(entry.layoutName ?? entry.visualName ?? entry.memberName)));
  const skippedRegressiveVisualRefreshes = refreshedVisuals.reduce<SkippedVisualRefresh[]>((skipped, visual) => {
      const visualName = normalizeName(visual.visualName ?? visual.memberName);
      const existingVisual = existingVisualsByName.get(visualName);
      if (!existingVisual || !refreshedUnsupportedNames.has(visualName)) return skipped;
      const existingAssetCount = arrayLength(existingVisual.assetIds);
      const refreshedAssetCount = arrayLength(visual.assetIds);
      if (existingAssetCount <= refreshedAssetCount) return skipped;
      skipped.push({
        visualName,
        existingAssetCount,
        refreshedAssetCount,
        reason: "refreshed visual had fewer materialized assets and unsupported entries",
      });
      return skipped;
    }, []);
  const skippedNames = new Set(skippedRegressiveVisualRefreshes.map((entry) => normalizeName(entry.visualName)));
  const assetsById = new Map<string, Record<string, unknown>>();
  for (const asset of arrayOfRecords(existingRelease.assets)) assetsById.set(String(asset.id ?? ""), asset);
  for (const asset of arrayOfRecords(refreshedRelease.assets)) assetsById.set(String(asset.id ?? ""), asset);
  const unsupported = [
    ...existingUnsupported.filter((entry) => !refreshedVisualNames.has(normalizeName(entry.layoutName)) || skippedNames.has(normalizeName(entry.layoutName))),
    ...refreshedUnsupported.filter((entry) => !skippedNames.has(normalizeName(entry.layoutName))),
  ];
  const visuals = [
    ...existingVisuals.filter((entry) => !refreshedVisualNames.has(normalizeName(entry.visualName ?? entry.memberName)) || skippedNames.has(normalizeName(entry.visualName ?? entry.memberName))),
    ...refreshedVisuals.filter((entry) => !skippedNames.has(normalizeName(entry.visualName ?? entry.memberName))),
  ].sort((left, right) => normalizeName(left.visualName ?? left.memberName).localeCompare(normalizeName(right.visualName ?? right.memberName)));

  mergedRelease.assets = [...assetsById.values()].filter((asset) => asset.id).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  mergedRelease.assetCount = (mergedRelease.assets as unknown[]).length;
  mergedRelease.unsupported = unsupported;
  mergedRelease.unsupportedCount = unsupported.length;
  mergedRelease.visuals = visuals;
  mergedRelease.visualCount = visuals.length;

  return {
    ...existing,
    generatedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
    refreshedVisuals: [...refreshedVisualNames].sort(),
    ...(skippedRegressiveVisualRefreshes.length > 0 ? { skippedRegressiveVisualRefreshes } : {}),
    releases: [mergedRelease],
  };
}

function firstRelease(raw: Record<string, unknown>): Record<string, unknown> {
  const releases = raw.releases;
  if (Array.isArray(releases)) return (releases[0] as Record<string, unknown>) ?? {};
  if (releases && typeof releases === "object") {
    return (Object.values(releases as Record<string, unknown>)[0] as Record<string, unknown>) ?? {};
  }
  return {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[]) : [];
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function loadProfile(
  cacheRootValue: string,
  clientsRootValue: string,
  profileId: string | undefined,
  profileRootValue: string | undefined,
): { store: ProfileStore | null; profile: RuntimeProfile; profileRoot: string } {
  if (profileRootValue) {
    const root = resolve(profileRootValue);
    return { store: null, profile: readProfile(join(root, "profile.json")), profileRoot: root };
  }
  const store = new ProfileStore(cacheRootValue, {
    profilesRoot: clientsRootValue,
    legacyProfilesRoot: join(cacheRootValue, "profiles"),
  });
  const profile = profileId ? store.read(profileId) : null;
  if (!profile || !profileId) throw new Error(`Profile not found: ${profileId ?? ""}`);
  return { store, profile, profileRoot: store.profileRoot(profileId) ?? join(store.profilesRoot, profileId) };
}

function readProfile(path: string): RuntimeProfile {
  if (!existsSync(path)) throw new Error(`profile.json not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeProfile;
}

function persistProfileRuntime(
  store: ProfileStore | null,
  profileRoot: string,
  profile: RuntimeProfile,
  runtime: RuntimeProfile["runtime"],
): void {
  const updated = { ...profile, runtime };
  if (store) {
    store.write(profileRoot, updated);
    return;
  }
  const profilePath = join(profileRoot, "profile.json");
  const tempPath = `${profilePath}.tmp-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  renameSync(tempPath, profilePath);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstArg(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function parseArgs(raw: string[]): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = raw[index + 1];
    const value = !next || next.startsWith("--") ? "1" : next;
    if (next && !next.startsWith("--")) index += 1;
    if (key === "visual") {
      const existing = parsed[key];
      parsed[key] = [...asArray(existing), value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}
