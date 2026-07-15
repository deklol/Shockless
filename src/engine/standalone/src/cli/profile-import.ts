import { join } from "node:path";
import { appCacheRoot, portableClientsRoot } from "../main/profilePaths.js";
import { ProfileImporter } from "../main/profileImporter.js";

const args = parseArgs(process.argv.slice(2));
const clientRoot = args["client-root"] ?? args.clientRoot;
if (!clientRoot) {
  throw new Error("Usage: npm run profile:import -- --client-root <compiled-folder> [--cache-root <path>] [--skip-projectorrays]");
}

const cacheRoot = args["cache-root"] ?? args.cacheRoot ?? appCacheRoot(process.env.APPDATA ?? process.cwd());
const clientsRoot = args["clients-root"] ?? args.clientsRoot ?? portableClientsRoot();
const importer = new ProfileImporter({
  cacheRoot,
  profilesRoot: clientsRoot,
  legacyProfilesRoot: join(cacheRoot, "profiles"),
  runProjectorRays: args["skip-projectorrays"] !== "1" && args.skipProjectorrays !== "1",
});

const profile = await importer.importProfile(
  {
    clientRoot,
    fixedStage: args.resizable !== "1",
    resizablePresentation: args.resizable === "1",
    versionCheckBuild: args.versionCheckBuild ? Number(args.versionCheckBuild) : undefined,
  },
  (progress) => {
    if (process.env.SHOCKLESS_IMPORT_PROGRESS === "jsonl") {
      console.log(`@shockless-import-progress ${JSON.stringify(progress)}`);
    } else {
      console.log(`[${progress.state}] ${progress.stage}: ${progress.message}${progress.detail ? ` (${progress.detail})` : ""}`);
    }
  },
);

console.log(JSON.stringify(profile, null, 2));

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
