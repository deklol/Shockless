import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { appCacheRoot, defaultExtractionToolsRoot, portableClientsRoot } from "../main/profilePaths.js";
import { ProfileStore } from "../main/profileStore.js";
import { validateRuntimeReadiness } from "../main/profileImporter.js";
import { profileValidationReportPath, validateProfileContract } from "../main/profileValidator.js";
import type { RuntimeProfile } from "../common/types.js";

const args = parseArgs(process.argv.slice(2));
const cacheRoot = firstArg(args["cache-root"] ?? args.cacheRoot) ?? appCacheRoot(process.env.APPDATA ?? process.cwd());
const clientsRoot = firstArg(args["clients-root"] ?? args.clientsRoot) ?? portableClientsRoot();
const profileLocator = firstArg(args.profile ?? args["profile-id"] ?? args.profileId);
const profileRootArg = firstArg(args["profile-root"] ?? args.profileRoot);
const explicitCasts = asArray(args.cast).map(String);
const dryRun = args["dry-run"] === "1";
const forceCastRefresh = args["force-cast-refresh"] === "1" || args.forceCastRefresh === "1";
const batchSize = positiveInteger(firstArg(args["batch-size"] ?? args.batchSize), 1);
const childTimeoutMs = positiveInteger(firstArg(args["timeout-ms"] ?? args.timeoutMs), 180_000);

if (!profileLocator && !profileRootArg) {
  throw new Error(
    "Usage: npm run profile:refresh-external-bitmaps -- --profile <id> [--cast <cast>] [--force-cast-refresh 1] [--dry-run]\n" +
      "   or: npm run profile:refresh-external-bitmaps -- --profile-root <path> [--cast <cast>] [--dry-run]",
  );
}
if (forceCastRefresh && explicitCasts.length === 0) {
  throw new Error("--force-cast-refresh requires at least one explicit --cast so broad profile refreshes stay intentional.");
}

const { store, profile, profileRoot } = loadProfile(cacheRoot, clientsRoot, profileLocator, profileRootArg);
const runtimeDataRoot = join(profileRoot, profile.paths.runtimeData);
const assetsRoot = join(profileRoot, profile.paths.assets);
const extractedRoot = join(profileRoot, profile.paths.extracted);
const scriptsRoot = join(profileRoot, profile.paths.scripts);
const version = profile.versionId;
const externalBitmapPath = join(runtimeDataRoot, `external-bitmap-assets.${version}.json`);
const existingIndex = readJson(externalBitmapPath);
const existingRelease = firstRelease(existingIndex);
const explicitCastNames = new Set(explicitCasts.map(normalizeName));
const targetMembers = forceCastRefresh
  ? allExternalMembersForCasts(existingRelease, explicitCastNames)
  : recoverableExternalMembers(existingRelease).filter(
      (member) => explicitCastNames.size === 0 || explicitCastNames.has(normalizeName(member.castName)),
    );
const targetCasts = uniqueNames(targetMembers.map((member) => member.castName));
const targetMemberKeys = new Set(targetMembers.map(externalMemberKey));

if (targetMembers.length === 0) {
  console.log(forceCastRefresh ? "No external bitmap members matched explicit casts." : "No external bitmap members matched now-supported recovery reasons.");
  process.exit(0);
}

console.log(JSON.stringify({ profileId: profile.id, profileRoot, targetCasts: targetCasts.length, targetMembers: targetMembers.length, forceCastRefresh, batchSize, childTimeoutMs, dryRun }, null, 2));
for (const cast of targetCasts.slice(0, 30)) console.log(`- ${cast}`);
if (targetCasts.length > 30) console.log(`- ... ${targetCasts.length - 30} more`);
if (dryRun) process.exit(0);

const tempRoot = join(profileRoot, `.refresh-external-assets-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });

const refreshedIndexes: unknown[] = [];
const toolPath = join(defaultExtractionToolsRoot(), "decode-external-cast-bitmaps.mjs");
for (let index = 0; index < targetCasts.length; index += batchSize) {
  const batch = targetCasts.slice(index, index + batchSize);
  const tempOut = join(tempRoot, `external-bitmap-assets.${version}.${Math.floor(index / batchSize)}.json`);
  console.log(`Refreshing external bitmap cast batch ${Math.floor(index / batchSize) + 1}/${Math.ceil(targetCasts.length / batchSize)}: ${batch.join(", ")}`);
  const toolArgs = [
    toolPath,
    "--external-cast-graph",
    join(runtimeDataRoot, `external-cast-graph.${version}.json`),
    "--movie-manifest",
    join(runtimeDataRoot, `${version}-projectorrays-manifest.json`),
    "--out",
    tempOut,
    "--asset-root",
    join(assetsRoot, "external-bitmaps"),
    "--asset-path-base",
    assetsRoot,
    "--version",
    version,
    ...batch.flatMap((cast) => ["--cast", cast]),
  ];
  const result = spawnSync(process.execPath, toolArgs, {
    cwd: profileRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1" },
    encoding: "utf8",
    timeout: childTimeoutMs,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`External bitmap refresh failed (${result.status ?? result.signal ?? "signal"}): ${basename(toolPath)}${output ? `\n${output}` : ""}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  refreshedIndexes.push(readJson(tempOut));
}

const merged = mergeExternalBitmapAssets(existingIndex, refreshedIndexes, targetMemberKeys, {
  requireImprovement: !forceCastRefresh,
  replaceTouchedKeys: forceCastRefresh,
});
const existingStats = releaseStats(existingRelease);
const mergedStats = releaseStats(firstRelease(merged));
if (!forceCastRefresh && mergedStats.unsupported > existingStats.unsupported) {
  throw new Error(`Refusing to replace external bitmap index: unsupported records increased ${existingStats.unsupported} -> ${mergedStats.unsupported}`);
}
if (!forceCastRefresh && mergedStats.assets < existingStats.assets) {
  throw new Error(`Refusing to replace external bitmap index: asset records decreased ${existingStats.assets} -> ${mergedStats.assets}`);
}

const backupPath = `${externalBitmapPath}.bak-${Date.now()}`;
copyFileSync(externalBitmapPath, backupPath);
const tempMergedPath = `${externalBitmapPath}.tmp-${Date.now()}`;
writeFileSync(tempMergedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
renameSync(tempMergedPath, externalBitmapPath);

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
store?.write(profileRoot, { ...profile, runtime });

console.log(JSON.stringify({
  refreshedCasts: targetCasts.length,
  backupPath,
  ready: refreshedReport.ready,
  unsupportedBefore: existingStats.unsupported,
  unsupportedAfter: mergedStats.unsupported,
  assetsBefore: existingStats.assets,
  assetsAfter: mergedStats.assets,
}, null, 2));

function recoverableExternalMembers(release: Record<string, unknown>): Array<{ castName: string; memberName: string }> {
  const members = new Map<string, { castName: string; memberName: string }>();
  for (const entry of arrayOfRecords(release.unsupported)) {
    const reason = String(entry.reason ?? "");
    if (!isNowSupportedReason(reason)) continue;
    const castName = String(entry.castName ?? "").trim();
    const memberName = String(entry.memberName ?? "").trim();
    if (castName && memberName) members.set(externalMemberKey({ castName, memberName }), { castName, memberName });
  }
  return [...members.values()].sort((left, right) => externalMemberKey(left).localeCompare(externalMemberKey(right)));
}

function allExternalMembersForCasts(release: Record<string, unknown>, castNames: Set<string>): Array<{ castName: string; memberName: string }> {
  const members = new Map<string, { castName: string; memberName: string }>();
  for (const asset of arrayOfRecords(release.assets)) {
    if (!castNames.has(normalizeName(asset.castName))) continue;
    const castName = String(asset.castName ?? "").trim();
    const memberName = String(asset.memberName ?? "").trim();
    if (castName && memberName) members.set(externalMemberKey({ castName, memberName }), { castName, memberName });
  }
  for (const entry of arrayOfRecords(release.unsupported)) {
    if (!castNames.has(normalizeName(entry.castName))) continue;
    const castName = String(entry.castName ?? "").trim();
    const memberName = String(entry.memberName ?? "").trim();
    if (castName && memberName) members.set(externalMemberKey({ castName, memberName }), { castName, memberName });
  }
  return [...members.values()].sort((left, right) => externalMemberKey(left).localeCompare(externalMemberKey(right)));
}

function isNowSupportedReason(reason: string): boolean {
  return (
    /bitmap bit depth (16|32) is not decoded by this extractor/i.test(reason) ||
    /palette -10[12] did not resolve/i.test(reason)
  );
}

function mergeExternalBitmapAssets(
  existingRaw: unknown,
  refreshedRaws: unknown[],
  refreshedMemberKeys: Set<string>,
  options: { requireImprovement: boolean; replaceTouchedKeys: boolean },
): unknown {
  const existing = existingRaw as Record<string, unknown>;
  const existingRelease = firstRelease(existing);
  const refreshedAssets: Record<string, unknown>[] = [];
  const refreshedUnsupported: Record<string, unknown>[] = [];
  const refreshedPalettes: Record<string, unknown>[] = [];
  const refreshedCastNames = new Set([...refreshedMemberKeys].map((key) => key.split(":")[0]).filter(Boolean));

  for (const refreshedRaw of refreshedRaws) {
    const refreshedRelease = firstRelease(refreshedRaw);
    for (const asset of arrayOfRecords(refreshedRelease.assets)) {
      if (refreshedMemberKeys.has(externalMemberKey(asset))) {
        refreshedAssets.push(asset);
      }
    }
    for (const entry of arrayOfRecords(refreshedRelease.unsupported)) {
      if (refreshedMemberKeys.has(externalMemberKey(entry))) {
        refreshedUnsupported.push(entry);
      }
    }
    for (const palette of arrayOfRecords(refreshedRelease.palettes)) {
      if (refreshedCastNames.has(normalizeName(palette.castName))) {
        refreshedPalettes.push(palette);
      }
    }
  }

  const existingTargetAssets = arrayOfRecords(existingRelease.assets).filter((asset) => refreshedMemberKeys.has(externalMemberKey(asset)));
  const existingTargetUnsupported = arrayOfRecords(existingRelease.unsupported).filter((entry) => refreshedMemberKeys.has(externalMemberKey(entry)));
  if (options.requireImprovement && refreshedUnsupported.length >= existingTargetUnsupported.length && refreshedAssets.length <= existingTargetAssets.length) {
    throw new Error("Refusing to replace external bitmap index: targeted refresh did not improve asset or unsupported counts");
  }

  const mergedRelease = { ...existingRelease };
  const recoveredKeys = new Set(refreshedAssets.map(externalMemberKey));
  const recoveredAssetIds = new Set(refreshedAssets.map((asset) => String(asset.id ?? "")).filter(Boolean));
  const refreshedUnsupportedToMerge = options.replaceTouchedKeys ? [] : refreshedUnsupported;
  const refreshedUnsupportedKeys = new Set(refreshedUnsupportedToMerge.map(externalMemberKey));
  const touchedKeys = new Set([...recoveredKeys, ...refreshedUnsupportedKeys]);
  const assets = [
    ...arrayOfRecords(existingRelease.assets).filter((asset) => {
      const id = String(asset.id ?? "");
      return id ? !recoveredAssetIds.has(id) : !recoveredKeys.has(externalMemberKey(asset));
    }),
    ...refreshedAssets,
  ].sort(compareExternalAssets);
  const unsupported = [
    ...arrayOfRecords(existingRelease.unsupported).filter((entry) => !touchedKeys.has(externalMemberKey(entry))),
    ...refreshedUnsupportedToMerge,
  ].sort(compareUnsupported);
  const palettes = dedupePalettes([
    ...arrayOfRecords(existingRelease.palettes).filter((palette) => !refreshedCastNames.has(normalizeName(palette.castName))),
    ...refreshedPalettes,
  ]).sort(comparePalettes);

  mergedRelease.assets = assets;
  mergedRelease.assetCount = assets.length;
  mergedRelease.palettes = palettes;
  mergedRelease.paletteCount = palettes.length;
  mergedRelease.unsupported = unsupported;
  mergedRelease.unsupportedCount = unsupported.length;
  mergedRelease.castCount = new Set(assets.map((asset) => normalizeName(asset.castName))).size;

  return {
    ...existing,
    generatedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
    refreshedExternalBitmapMembers: [...refreshedMemberKeys].sort(),
    releases: [mergedRelease],
  };
}

function externalMemberKey(asset: { castName?: unknown; memberName?: unknown }): string {
  return `${normalizeName(asset.castName)}:${normalizeName(asset.memberName)}`;
}

function compareExternalAssets(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const castCompare = normalizeName(left.castName).localeCompare(normalizeName(right.castName));
  if (castCompare !== 0) return castCompare;
  return Number(left.member ?? 0) - Number(right.member ?? 0);
}

function compareUnsupported(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const castCompare = normalizeName(left.castName).localeCompare(normalizeName(right.castName));
  if (castCompare !== 0) return castCompare;
  return normalizeName(left.memberName).localeCompare(normalizeName(right.memberName));
}

function dedupePalettes(palettes: Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const palette of palettes) {
    byKey.set(paletteKey(palette), palette);
  }
  return [...byKey.values()];
}

function paletteKey(palette: Record<string, unknown>): string {
  return `${normalizeName(palette.castName)}:${Number(palette.member ?? 0)}:${normalizeName(palette.name)}`;
}

function comparePalettes(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const castCompare = normalizeName(left.castName).localeCompare(normalizeName(right.castName));
  if (castCompare !== 0) return castCompare;
  return Number(left.member ?? 0) - Number(right.member ?? 0);
}

function releaseStats(release: Record<string, unknown>): { assets: number; unsupported: number } {
  return {
    assets: Number(release.assetCount ?? arrayOfRecords(release.assets).length),
    unsupported: Number(release.unsupportedCount ?? arrayOfRecords(release.unsupported).length),
  };
}

function firstRelease(raw: unknown): Record<string, unknown> {
  const record = raw as Record<string, unknown>;
  const releases = record.releases;
  if (Array.isArray(releases)) return (releases[0] as Record<string, unknown>) ?? {};
  if (releases && typeof releases === "object") {
    return (Object.values(releases as Record<string, unknown>)[0] as Record<string, unknown>) ?? {};
  }
  return {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[]) : [];
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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function uniqueNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstArg(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    if (key === "cast") {
      const existing = parsed[key];
      parsed[key] = [...asArray(existing), value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}
