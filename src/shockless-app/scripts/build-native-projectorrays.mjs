import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = resolveEngineRoot(workspace);
const sourceRoot = join(engineRoot, "native", "projectorrays");
const outputName = "shockless-projectorrays-0.2.0.exe";
const builtBinary = join(sourceRoot, "shockless-projectorrays.exe");
const resourceRoot = join(engineRoot, "standalone", "resources", "projectorrays");
const stagedBinary = join(resourceRoot, outputName);
const manifestPath = join(resourceRoot, "shockless-projectorrays.json");
const upstreamCommit = "8a3d3b4211575170276fc6be350b6b52e96d4750";

const bash = findMsysBash();
const sourcePosix = toMsysPath(sourceRoot);
await run(bash, [
  "-lc",
  `export PATH=/ucrt64/bin:/usr/bin:$PATH; cd '${sourcePosix}'; make clean >/dev/null 2>&1 || true; make -j$(nproc) release BINARY=shockless-projectorrays.exe GIT_SHA=${upstreamCommit.slice(0, 8)}`,
]);

if (!existsSync(builtBinary)) throw new Error(`Native build did not produce ${builtBinary}`);
await mkdir(resourceRoot, { recursive: true });
await cp(builtBinary, stagedBinary, { force: true });

const binarySha256 = await sha256File(stagedBinary);
const sourceSha256 = await fingerprintSource(sourceRoot);
const manifest = {
  schemaVersion: 1,
  protocol: "shockless-profile-v1",
  upstream: {
    repository: "https://github.com/ProjectorRays/ProjectorRays",
    version: "0.2.0",
    commit: upstreamCommit,
    license: "MPL-2.0",
  },
  binary: outputName,
  sha256: binarySha256,
  sourceSha256,
  capabilities: ["deterministic-source-order", "exact-progress", "runtime-artifacts-only"],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ binary: relative(workspace, stagedBinary), manifest: relative(workspace, manifestPath), ...manifest }, null, 2));

function resolveEngineRoot(appRoot) {
  for (const candidate of [join(appRoot, "engine"), resolve(appRoot, "..", "engine")]) {
    if (existsSync(join(candidate, "native", "projectorrays", "Makefile"))) return candidate;
  }
  throw new Error("Shockless ProjectorRays source was not found in engine/native/projectorrays.");
}

function findMsysBash() {
  const roots = [
    process.env.MSYS2_ROOT,
    process.env.SystemDrive ? join(process.env.SystemDrive, "msys64") : undefined,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, "usr", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("MSYS2 bash was not found. Set MSYS2_ROOT to the official MSYS2 installation directory.");
}

function toMsysPath(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error(`Cannot convert path for MSYS2: ${value}`);
  return `/${match[1].toLowerCase()}/${match[2]}`;
}

async function fingerprintSource(root) {
  const files = [];
  await walk(root, root, files);
  const hash = createHash("sha256");
  for (const path of files.sort((a, b) => a.localeCompare(b))) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function walk(root, current, output) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name.endsWith(".o") || entry.name.endsWith(".exe")) continue;
    if (current === join(root, "fontmaps") && entry.name.endsWith(".h")) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile()) output.push(path);
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: workspace, env: { ...process.env, CHERE_INVOKING: "1", MSYSTEM: "UCRT64" }, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
