import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeProfile } from "../common/types.js";
import {
  profileSoundAssetsAreCurrent,
  refreshProfileSoundAssets,
} from "../main/profileSoundMaintenance.js";

const args = parseArgs(process.argv.slice(2));
const profileRootArg = args["profile-root"] ?? args.profileRoot;
const force = args.force === "1";
if (!profileRootArg) {
  throw new Error("Usage: npm run profile:refresh-sounds -- --profile-root <path> [--force 1]");
}

const profileRoot = resolve(profileRootArg);
const profilePath = join(profileRoot, "profile.json");
if (!existsSync(profilePath)) throw new Error(`profile.json not found: ${profilePath}`);
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as RuntimeProfile;
const wasCurrent = profileSoundAssetsAreCurrent(profileRoot, profile);
const result = refreshProfileSoundAssets(profileRoot, profile, { force });
console.log(JSON.stringify({ profileId: profile.id, profileRoot, wasCurrent, ...result }, null, 2));

function parseArgs(raw: readonly string[]): Record<string, string> {
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
