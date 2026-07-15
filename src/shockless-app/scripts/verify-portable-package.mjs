import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowLocalClients = args.includes("--allow-local-clients");
const strictNoClients = args.includes("--strict-no-clients");
const portableArg = args.find((arg) => !arg.startsWith("--"));
const portableRoot = resolve(portableArg ?? join(workspace, "dist", "portable", "Shockless"));
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".txt"]);
const premadeModuleIds = readPremadeModuleIds(join(portableRoot, "plugins", "_premade-modules"));
const requiredFiles = [
  "README.txt",
  "resources/app/package.json",
  "resources/app/dist/main/main/main.js",
  "resources/app/dist/main/main/profileImportRunner.js",
  "resources/app/dist/main/main/shocklessEmbed.js",
  "resources/app/dist/main/main/updateInstallerHelper.js",
  "resources/app/dist/plugins/template/plugin.js",
  ...premadeModuleIds.flatMap((id) => [`plugins/_premade-modules/${id}/plugin.js`]),
  "docs/index.html",
  "docs/plugin-api.html",
  "public/fonts/volter/volter-goldfish.woff2",
  "public/fonts/volter/volter-bold-goldfish.woff2",
  "resources/engine/dist/index.html",
  "resources/engine/standalone/package.json",
  "resources/engine/standalone/dist/main/cli/profile-import.js",
  "resources/engine/standalone/resources/projectorrays/projectorrays-0.2.0.exe",
  "resources/engine/standalone/resources/projectorrays/shockless-projectorrays-0.2.0.exe",
  "resources/engine/standalone/resources/projectorrays/shockless-projectorrays.json",
  "resources/engine/standalone/resources/compiler/profile-script-compiler.mjs",
  "resources/engine/standalone/resources/extraction/build-projectorrays-manifest.mjs",
  "resources/engine/standalone/resources/extraction/decode-external-cast-bitmaps-parallel.mjs",
  "resources/engine/standalone/resources/extraction/import-progress.mjs",
  "resources/engine/standalone/resources/extraction/import-worker-policy.mjs",
  "resources/engine/standalone/resources/extraction/node_modules/jpeg-js/package.json",
  "resources/engine/standalone/resources/extraction/node_modules/jpeg-js/index.js",
  "resources/relay/origins-relay.mjs",
  "resources/relay/shockwave-codec.mjs",
  "resources/relay/bobba-crypto.mjs",
];
const requiredFileAlternatives = [
  ["Shockless.exe", "Habbpy v4.exe"],
  ["resources/app/dist/plugins/template/shockless.plugin.json", "resources/app/dist/plugins/template/habbpy.plugin.json"],
  ["resources/app/dist/plugins/template/README.md", "resources/app/dist/plugins/template/README.txt"],
  ["plugins/_premade-modules/README.md", "plugins/_premade-modules/README.txt"],
  ["docs/plugin-authoring.md", "docs/plugin-authoring.html"],
  ["docs/plugin-api-reference.md", "docs/plugin-api.html"],
  ["docs/backtick-console-commands.md", "docs/console-commands.html"],
  ["docs/multi-account-sessions.md", "docs/multi-client.html"],
  ...premadeModuleIds.flatMap((id) => [
    [`plugins/_premade-modules/${id}/shockless.plugin.json`, `plugins/_premade-modules/${id}/habbpy.plugin.json`],
    [`plugins/_premade-modules/${id}/README.md`, `plugins/_premade-modules/${id}/README.txt`],
  ]),
];
const forbiddenFileNames = new Set(["goal.md", "multiclient-accounts.txt"]);
const forbiddenPluginPaths = privatePluginIds().flatMap((id) => [
  `plugins/_premade-modules/${id}`,
  `plugins/${id}`,
  `resources/app/dist/plugins/${id}`,
]);
const forbiddenTextPatterns = [
  /[A-Z]:[\\/](?:Users[\\/]dekky|habbo|habbpy|slopwave)/i,
  /C:[\\/]Users[\\/]dekky/i,
  /F:[\\/](?:habbo|habbpy|slopwave)/i,
];

if (!existsSync(portableRoot) || !statSync(portableRoot).isDirectory()) {
  fail(`Portable root is missing: ${portableRoot}`);
}

const missing = [
  ...requiredFiles.filter((file) => !fileExists(join(portableRoot, file))),
  ...requiredFileAlternatives
    .filter((alternatives) => !alternatives.some((file) => fileExists(join(portableRoot, file))))
    .map((alternatives) => alternatives.join(" or ")),
];
if (missing.length > 0) {
  fail(`Portable package is missing required file(s): ${missing.join(", ")}`);
}

verifyOptimizedExtractor(join(portableRoot, "resources", "engine", "standalone", "resources", "projectorrays"));

const copiedForbiddenPluginPaths = forbiddenPluginPaths.filter((entry) => pathExists(join(portableRoot, entry)));
const copiedForbiddenFiles = [];
const copiedClientPaths = [];
const leakedText = [];
let standaloneResourceFileCount = 0;
let standaloneResourceBytes = 0;

if (pathExists(join(portableRoot, "clients"))) {
  copiedClientPaths.push("clients");
}

for (const filePath of walk(portableRoot)) {
  const name = basename(filePath);
  const relativePath = relative(portableRoot, filePath);
  if (relativePath.split(/[\\/]/).some((part) => part.toLowerCase() === "clients")) {
    copiedClientPaths.push(relativePath);
  }
  if (forbiddenFileNames.has(name.toLowerCase())) {
    copiedForbiddenFiles.push(relativePath);
  }
  if (filePath.includes(`${join("resources", "engine", "standalone", "resources")}`)) {
    standaloneResourceFileCount += 1;
    standaloneResourceBytes += statSync(filePath).size;
  }
  if (!textExtensions.has(extname(filePath).toLowerCase())) continue;
  const text = readFileSync(filePath, "utf8");
  for (const pattern of forbiddenTextPatterns) {
    if (pattern.test(text)) {
      leakedText.push(relativePath);
      break;
    }
  }
}

if (copiedForbiddenPluginPaths.length > 0) {
  fail(`Portable package copied private/dev-only plugin path(s): ${copiedForbiddenPluginPaths.join(", ")}`);
}
if (copiedForbiddenFiles.length > 0) {
  fail(`Portable package copied private local file(s): ${copiedForbiddenFiles.join(", ")}`);
}
if (copiedClientPaths.length > 0 && !allowLocalClients) {
  fail(`Portable package copied imported/decompiled client profile path(s): ${copiedClientPaths.slice(0, 20).join(", ")}`);
}
if (strictNoClients && copiedClientPaths.length > 0) {
  fail(`Portable package must not contain imported/decompiled client profile path(s): ${copiedClientPaths.slice(0, 20).join(", ")}`);
}
if (leakedText.length > 0) {
  fail(`Portable package contains local absolute path needle(s): ${leakedText.join(", ")}`);
}
if (standaloneResourceFileCount < 10 || standaloneResourceBytes < 1_000_000) {
  fail("Portable package does not contain the expected standalone importer resource payload.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      portableRoot: relative(workspace, portableRoot),
      requiredFiles: requiredFiles.length + requiredFileAlternatives.length,
      standaloneResourceFileCount,
      standaloneResourceBytes,
      forbiddenPluginPathsCopied: copiedForbiddenPluginPaths.length,
      forbiddenFilesCopied: copiedForbiddenFiles.length,
      clientPathsCopied: copiedClientPaths.length,
      clientPathsAllowed: allowLocalClients,
      localAbsolutePathNeedles: leakedText.length,
    },
    null,
    2,
  ),
);

function pathExists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function fileExists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readPremadeModuleIds(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function privatePluginIds() {
  return String(process.env.SHOCKLESS_PRIVATE_PLUGIN_IDS ?? "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9-]{1,64}$/i.test(entry));
}

function* walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(filePath);
    } else if (entry.isFile()) {
      yield filePath;
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function verifyOptimizedExtractor(root) {
  const manifestPath = join(root, "shockless-projectorrays.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Optimized ProjectorRays manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.schemaVersion !== 1 || manifest?.protocol !== "shockless-profile-v1") {
    fail("Optimized ProjectorRays manifest uses an unsupported protocol.");
  }
  const binaryPath = join(root, String(manifest.binary ?? ""));
  if (!fileExists(binaryPath)) fail("Optimized ProjectorRays manifest references a missing binary.");
  const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actual !== String(manifest.sha256 ?? "").toLowerCase()) {
    fail("Optimized ProjectorRays binary does not match its SHA-256 manifest.");
  }
}
