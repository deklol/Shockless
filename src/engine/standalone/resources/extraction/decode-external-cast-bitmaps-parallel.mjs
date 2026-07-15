#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { importWorkerPolicy } from "./import-worker-policy.mjs";

const args = parseArgs(process.argv.slice(2));
const decoderPath = fileURLToPath(new URL("./decode-external-cast-bitmaps.mjs", import.meta.url));
const graphPath = path.resolve(required(args.externalCastGraph, "--external-cast-graph"));
const outputPath = path.resolve(required(args.out, "--out"));
const assetRoot = path.resolve(required(args.assetRoot, "--asset-root"));
const assetPathBase = path.resolve(required(args.assetPathBase, "--asset-path-base"));
const movieManifestPath = args.movieManifest ? path.resolve(args.movieManifest) : undefined;
const version = required(args.version, "--version");
const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const graphRelease = graph.releases.find((entry) => entry.versionId === version);
if (!graphRelease) throw new Error(`No external cast graph release matched ${version}`);

const jobs = graphRelease.casts
  .filter((cast) => cast.resolved)
  .map((cast) => ({ cast, weight: cast.members.filter((member) => member.type === "bitmap").length }))
  .filter((job) => job.weight > 0);
const policy = importWorkerPolicy(assetRoot, jobs.length);
console.log(`External bitmap workers: ${policy.workers} (${policy.storage}; cpu ${policy.cpuCap}, memory ${policy.memoryCap}, storage ${policy.storageCap})`);

if (policy.workers === 1) {
  await runChild([decoderPath, ...decoderArgs(args, outputPath, jobs.map((job) => job.cast.name))], (progress) => {
    console.log(`@shockless-tool-progress ${JSON.stringify({ phase: "external-bitmaps", ...progress, workers: 1 })}`);
  });
  process.exit(0);
}

const shards = partitionJobs(jobs, policy.workers);
const tempRoot = path.join(path.dirname(outputPath), `.external-bitmaps-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
const progressByShard = new Map();
const emitAggregate = createAggregateProgressEmitter(progressByShard, shards.length);
try {
  await Promise.all(
    shards.map((shard, index) => {
      const partialPath = path.join(tempRoot, `shard-${String(index).padStart(2, "0")}.json`);
      shard.outputPath = partialPath;
      return runChild([decoderPath, ...decoderArgs(args, partialPath, shard.jobs.map((job) => job.cast.name))], (progress) => {
        progressByShard.set(index, progress);
        emitAggregate(false);
      });
    }),
  );
  emitAggregate(true);
  mergeOutputs(shards, outputPath, graphPath, assetRoot, assetPathBase, version);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function decoderArgs(options, out, casts) {
  return [
    "--external-cast-graph", graphPath,
    ...(movieManifestPath ? ["--movie-manifest", movieManifestPath] : []),
    "--out", out,
    "--asset-root", assetRoot,
    "--asset-path-base", assetPathBase,
    "--version", version,
    ...casts.flatMap((cast) => ["--cast", cast]),
  ];
}

function partitionJobs(sourceJobs, count) {
  const shards = Array.from({ length: count }, () => ({ jobs: [], weight: 0, outputPath: "" }));
  for (const job of [...sourceJobs].sort((left, right) => right.weight - left.weight || compare(left.cast.name, right.cast.name))) {
    const shard = [...shards].sort((left, right) => left.weight - right.weight || shards.indexOf(left) - shards.indexOf(right))[0];
    shard.jobs.push(job);
    shard.weight += job.weight;
  }
  return shards.filter((shard) => shard.jobs.length > 0);
}

function runChild(argv, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer = consumeLines(`${lineBuffer}${text}`, (line) => {
        const progress = parseProgress(line);
        if (progress) onProgress(progress);
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`External bitmap worker failed (${code ?? 1}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function mergeOutputs(shards, outPath, sourceGraphPath, outputAssetsRoot, pathBase, releaseVersion) {
  const partials = shards.map((shard) => JSON.parse(readFileSync(shard.outputPath, "utf8")));
  const releases = partials.map((partial) => partial.releases[0]);
  const first = releases[0];
  const assets = releases.flatMap((release) => release.assets ?? []).sort(compareCastMember);
  const palettes = releases.flatMap((release) => release.palettes ?? []).sort(compareCastMember);
  const sourceEmpty = releases.flatMap((release) => release.sourceEmpty ?? []).sort(compareCastMember);
  const unsupported = releases.flatMap((release) => release.unsupported ?? []).sort(compareCastMember);
  const mergedRelease = {
    ...first,
    versionId: releaseVersion,
    castCount: new Set(assets.map((asset) => asset.castName)).size,
    assetCount: assets.length,
    sourceEmptyCount: sourceEmpty.length,
    unsupportedCount: unsupported.length,
    assets,
    palettes,
    sourceEmpty,
    unsupported,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/decode-external-cast-bitmaps.mjs",
      externalCastGraphPath: portable(path.relative(process.cwd(), sourceGraphPath)),
      assetRoot: portable(path.relative(pathBase, outputAssetsRoot)),
      releases: [mergedRelease],
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Decoded ${assets.length} external bitmap asset(s) with ${shards.length} worker(s)`);
}

function compareCastMember(left, right) {
  return Number(left.castOrder ?? 0) - Number(right.castOrder ?? 0) || Number(left.member ?? 0) - Number(right.member ?? 0);
}

function createAggregateProgressEmitter(progressByShard, workerCount) {
  let lastEmittedAt = 0;
  return (force) => {
    const now = Date.now();
    if (!force && now - lastEmittedAt < 250) return;
    lastEmittedAt = now;
    let outputFiles = 0;
    let outputBytes = 0;
    for (const progress of progressByShard.values()) {
      outputFiles += progress.outputFiles;
      outputBytes += progress.outputBytes;
    }
    console.log(`@shockless-tool-progress ${JSON.stringify({ phase: "external-bitmaps", outputFiles, outputBytes, workers: workerCount })}`);
  };
}

function parseProgress(line) {
  const prefix = "@shockless-tool-progress ";
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(prefix.length));
    const outputFiles = Number(parsed.outputFiles);
    const outputBytes = Number(parsed.outputBytes);
    return Number.isSafeInteger(outputFiles) && outputFiles >= 0 && Number.isSafeInteger(outputBytes) && outputBytes >= 0
      ? { outputFiles, outputBytes }
      : undefined;
  } catch {
    return undefined;
  }
}

function consumeLines(text, onLine) {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) onLine(line);
  return remainder;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--external-cast-graph") parsed.externalCastGraph = value;
    else if (arg === "--movie-manifest") parsed.movieManifest = value;
    else if (arg === "--out") parsed.out = value;
    else if (arg === "--asset-root") parsed.assetRoot = value;
    else if (arg === "--asset-path-base") parsed.assetPathBase = value;
    else if (arg === "--version") parsed.version = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function required(value, flag) {
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function portable(value) {
  return value.replaceAll("\\", "/");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
