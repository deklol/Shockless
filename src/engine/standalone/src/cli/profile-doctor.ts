import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appCacheRoot, portableClientsRoot } from "../main/profilePaths.js";
import { ProfileStore } from "../main/profileStore.js";
import { profileValidationReportPath, summarizeProfileValidation, validateProfileContract } from "../main/profileValidator.js";
import type { RuntimeProfile } from "../common/types.js";

const args = parseArgs(process.argv.slice(2));
const cacheRoot = args["cache-root"] ?? args.cacheRoot ?? appCacheRoot(process.env.APPDATA ?? process.cwd());
const clientsRoot = args["clients-root"] ?? args.clientsRoot ?? portableClientsRoot();
const profileLocator = args.profile ?? args["profile-id"] ?? args.profileId;
const profileRootArg = args["profile-root"] ?? args.profileRoot;
const writeReport = args.write === "1" || args["write-report"] === "1";

if (!profileLocator && !profileRootArg) {
  throw new Error("Usage: npm run profile:doctor -- --profile <id> [--cache-root <path>] [--write-report]\n   or: npm run profile:doctor -- --profile-root <path> [--write-report]");
}

const { profile, profileRoot } = loadProfile(cacheRoot, clientsRoot, profileLocator, profileRootArg);
const report = validateProfileContract({
  versionId: profile.versionId,
  runtimeDataRoot: join(profileRoot, profile.paths.runtimeData),
  assetsRoot: join(profileRoot, profile.paths.assets),
  scriptsRoot: join(profileRoot, profile.paths.scripts),
  extractedRoot: join(profileRoot, profile.paths.extracted),
  runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
});
if (writeReport) {
  writeFileSync(profileValidationReportPath(profileRoot), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const summary = summarizeProfileValidation(report);
console.log(JSON.stringify({ profileId: profile.id, profileRoot, ...summary }, null, 2));
for (const check of report.checks) {
  console.log(`[${check.state}] ${check.name}: ${check.summary}`);
}
if (report.issues.length > 0) {
  console.log("Issues:");
  for (const issue of report.issues) {
    console.log(`- ${issue.severity} ${issue.code}: ${issue.message}${issue.count !== undefined ? ` (${issue.count})` : ""}`);
    for (const sample of issue.sample?.slice(0, 5) ?? []) {
      console.log(`  ${sample}`);
    }
  }
}
if (
  report.diagnostics.soundInventory.declared > 0 ||
  report.diagnostics.unsupportedBitmapRecords.total > 0 ||
  report.diagnostics.visualLayoutClosure.gaps.length > 0
) {
  console.log("Compiler diagnostics:");
  if (report.diagnostics.soundInventory.declared > 0) {
    const sound = report.diagnostics.soundInventory;
    console.log(
      `- Director sound inventory: ${sound.extracted}/${sound.declared} extracted, ` +
      `${sound.unsupported} unsupported, ${sound.missing} missing, ${sound.invalidMetadata} invalid`,
    );
    if (sound.byContainer.length > 0) {
      console.log(`  containers: ${sound.byContainer.map((entry) => `${entry.name}=${entry.count}`).join(", ")}`);
    }
    if (sound.byCodec.length > 0) {
      console.log(`  codecs: ${sound.byCodec.map((entry) => `${entry.name}=${entry.count}`).join(", ")}`);
    }
    for (const sample of sound.samples.slice(0, 8)) console.log(`  ${sample}`);
  }
  if (report.diagnostics.unsupportedBitmapRecords.total > 0) {
    console.log(`- unsupported bitmap records: ${report.diagnostics.unsupportedBitmapRecords.total}`);
    for (const reason of report.diagnostics.unsupportedBitmapRecords.byReason.slice(0, 5)) {
      console.log(`  ${reason.count}x ${reason.reason}`);
      for (const sample of reason.samples.slice(0, 2)) {
        console.log(`    ${sample}`);
      }
    }
  }
  if (report.diagnostics.visualLayoutClosure.gaps.length > 0) {
    const closure = report.diagnostics.visualLayoutClosure;
    console.log(`- visual layout gaps: ${closure.partialLayouts} partial, ${closure.exteriorPartialLayouts} exterior/Horizon, ${closure.unresolvedReferenceCount} unresolved reference(s)`);
    for (const gap of closure.gaps.slice(0, 8)) {
      console.log(`  ${gap.visualName}: ${gap.materializedAssetCount}/${gap.bitmapElementCount} materialized, ${gap.missingBitmapReferences.length} missing bitmap reference(s)`);
      for (const missing of gap.missingBitmapReferences.slice(0, 3)) {
        const recovery = missing.sourceRecovery?.sectionID
          ? ` -> BITD-${missing.sourceRecovery.sectionID}`
          : missing.sourceRecovery?.candidateCount
            ? ` -> ${missing.sourceRecovery.candidateCount} candidate(s)`
            : "";
        console.log(`    ${missing.castName}#${missing.member} ${missing.memberName} (${missing.reason}${recovery})`);
      }
      for (const unresolved of gap.unresolvedReferences.slice(0, 2)) {
        console.log(`    unresolved ${unresolved}`);
      }
    }
  }
}
process.exitCode = report.ready ? 0 : 1;

function loadProfile(
  cacheRootValue: string,
  clientsRootValue: string,
  profileId: string | undefined,
  profileRootValue: string | undefined,
): { profile: RuntimeProfile; profileRoot: string } {
  if (profileRootValue) {
    const profileRoot = resolve(profileRootValue);
    const profile = readProfile(join(profileRoot, "profile.json"));
    return { profile, profileRoot };
  }

  const store = new ProfileStore(cacheRootValue, {
    profilesRoot: clientsRootValue,
    legacyProfilesRoot: join(cacheRootValue, "profiles"),
  });
  const profile = profileId ? store.read(profileId) : null;
  if (!profile || !profileId) {
    throw new Error(`Profile not found: ${profileId ?? ""}`);
  }
  return { profile, profileRoot: store.profileRoot(profileId) ?? join(store.profilesRoot, profileId) };
}

function readProfile(path: string): RuntimeProfile {
  if (!existsSync(path)) throw new Error(`profile.json not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeProfile;
}

function parseArgs(raw: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
