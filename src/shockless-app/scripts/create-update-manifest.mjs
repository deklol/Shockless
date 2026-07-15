import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const zipArg = valueAfter("--zip") ?? args.find((arg) => !arg.startsWith("--"));
if (!zipArg) {
  console.error("Usage: node scripts/create-update-manifest.mjs --zip <portable-zip> [--version <version>] [--release-url <url>]");
  process.exit(1);
}

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8"));
const zipPath = resolve(zipArg);
const zipStat = await stat(zipPath);
if (!zipStat.isFile()) throw new Error(`Update asset is not a file: ${zipPath}`);
const version = (valueAfter("--version") ?? packageJson.version ?? "").trim();
if (!version) throw new Error("Version is missing. Pass --version or set package.json version.");
const releaseUrl = (valueAfter("--release-url") ?? `https://github.com/deklol/Shockless/releases/tag/v${stripLeadingV(version)}`).trim();
const sha256 = await sha256File(zipPath);
const manifest = {
  schemaVersion: 1,
  version: stripLeadingV(version),
  channel: "stable",
  platform: "win32-x64",
  assetName: basename(zipPath),
  sha256,
  size: zipStat.size,
  releaseUrl,
  publishedAt: new Date().toISOString(),
  notes: "See the GitHub release notes for this build.",
};
const outputDir = dirname(zipPath);
await writeFile(resolve(outputDir, "update.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDir, "SHA256SUMS.txt"), `${sha256}  ${basename(zipPath)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, updateJson: resolve(outputDir, "update.json"), sha256, size: zipStat.size }, null, 2));

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function stripLeadingV(version) {
  return version.replace(/^[vV]/, "");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
