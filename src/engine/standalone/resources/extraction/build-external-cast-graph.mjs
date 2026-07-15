#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  directorMemberNumber,
  readDirectorCastMetadata,
  readProjectorRaysJson,
} from "./director-cast-metadata.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const extractionSummaryPath = path.resolve(args.summary ?? "generated/extraction/projectorrays-summary.json");
const externalFieldsPath = path.resolve(args.externalFields ?? "generated/runtime-data/external-fields.json");
const outputPath = path.resolve(args.out ?? "generated/runtime-data/external-cast-graph.json");

if (!existsSync(extractionSummaryPath)) {
  throw new Error(`ProjectorRays extraction summary not found: ${relative(extractionSummaryPath)}`);
}

if (!existsSync(externalFieldsPath)) {
  throw new Error(`External field index not found: ${relative(externalFieldsPath)}`);
}

const extractionSummary = JSON.parse(readFileSync(extractionSummaryPath, "utf8"));
const externalFields = JSON.parse(readFileSync(externalFieldsPath, "utf8"));
const releases = [];
const representedReleaseKeys = new Set();

for (const fieldRelease of externalFields.releases) {
  if (args.version && fieldRelease.versionId !== args.version) {
    continue;
  }

  const releaseSummary = extractionSummary.releases.find((entry) => matchesReleaseSummary(entry, fieldRelease.versionId));
  if (!releaseSummary) {
    throw new Error(`No ProjectorRays release summary found for external field version ${fieldRelease.versionId}`);
  }

  const releaseGraph = buildReleaseCastGraph(fieldRelease, releaseSummary);
  releases.push(releaseGraph);
  representedReleaseKeys.add(releaseSummaryKey(releaseSummary));
}

for (const releaseSummary of extractionSummary.releases) {
  if (representedReleaseKeys.has(releaseSummaryKey(releaseSummary))) {
    continue;
  }

  const versionId = dynamicVersionIdForRelease(releaseSummary);
  if (args.version && !matchesReleaseSummary(releaseSummary, args.version) && versionId !== args.version) {
    continue;
  }

  const dynamicReleaseGraph = buildDynamicReleaseCastGraph(releaseSummary, versionId);
  if (!dynamicReleaseGraph) {
    continue;
  }

  releases.push(dynamicReleaseGraph);
  representedReleaseKeys.add(releaseSummaryKey(releaseSummary));
}

function matchesReleaseSummary(entry, versionId) {
  if (entry.sourceRelease === versionId || entry.release === versionId) {
    return true;
  }

  if (versionId === "release14" && entry.sourceRelease === "14.1_b8") {
    return true;
  }

  return false;
}

function dynamicVersionIdForRelease(releaseSummary) {
  if (releaseSummary.sourceRelease === "14.1_b8") {
    return "release14";
  }

  return releaseSummary.sourceRelease ?? releaseSummary.release;
}

function releaseSummaryKey(releaseSummary) {
  return `${releaseSummary.release}:${releaseSummary.outputRoot}`;
}

if (releases.length === 0) {
  throw new Error(`No external field release matched version filter: ${args.version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/build-external-cast-graph.mjs",
      extractionSummaryPath: relative(extractionSummaryPath),
      externalFieldsPath: relative(externalFieldsPath),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Built external cast graph for ${releases.length} release(s)`);
console.log(`External cast graph: ${relative(outputPath)}`);

function buildReleaseCastGraph(fieldRelease, releaseSummary) {
  const variableField = fieldRelease.fields.find((field) => field.name === "external_variables.txt");
  if (!variableField) {
    throw new Error(`${fieldRelease.versionId} has no external_variables.txt field`);
  }

  const castEntries = readReferencedCastEntries(variableField.properties, releaseSummary);
  const casts = castEntries.map((castName, index) => buildCastEntry(releaseSummary, index + 1, castName));

  return {
    versionId: fieldRelease.versionId,
    release: releaseSummary.release,
    sourceId: fieldRelease.sourceId,
    variableSourcePath: variableField.sourcePath,
    casts,
    unresolved: casts
      .filter((cast) => !cast.resolved)
      .map((cast) => ({
        order: cast.order,
        name: cast.name,
        expectedSourcePath: cast.expectedSourcePath,
        expectedExtractionRoot: cast.expectedExtractionRoot
      }))
  };
}

function buildDynamicReleaseCastGraph(releaseSummary, versionId) {
  const castEntries = readDynamicExtractedCastEntries(releaseSummary);
  if (castEntries.length === 0) {
    return undefined;
  }

  const casts = castEntries.map((castName, index) => buildCastEntry(releaseSummary, index + 1, castName));

  return {
    versionId,
    release: releaseSummary.release,
    sourceId: `${releaseSummary.sourceRelease ?? releaseSummary.release}-projectorrays-dynamic`,
    castDiscoverySource: "projectorrays-extracted-cast-directories",
    casts,
    unresolved: casts
      .filter((cast) => !cast.resolved)
      .map((cast) => ({
        order: cast.order,
        name: cast.name,
        expectedSourcePath: cast.expectedSourcePath,
        expectedExtractionRoot: cast.expectedExtractionRoot
      }))
  };
}

function readSequentialCastEntries(properties) {
  const castEntries = [];
  for (let index = 1; ; index++) {
    const value = properties[`cast.entry.${index}`];
    if (typeof value !== "string" || value.length === 0) {
      break;
    }

    castEntries.push(value);
  }

  return castEntries;
}

function readReferencedCastEntries(properties, releaseSummary) {
  const castEntries = readSequentialCastEntries(properties);
  const seen = new Set(castEntries.map(normalizeName));

  for (const key of Object.keys(properties).sort()) {
    if (!key.startsWith("room.cast.")) {
      continue;
    }

    for (const castName of readCastListValue(properties[key])) {
      const normalized = normalizeName(castName);
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      castEntries.push(castName);
    }
  }

  for (const castName of readDynamicExtractedCastEntries(releaseSummary)) {
    const normalized = normalizeName(castName);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    castEntries.push(castName);
  }

  return castEntries;
}

function readDynamicExtractedCastEntries(releaseSummary) {
  const releaseRoot = path.resolve(releaseSummary.outputRoot);
  if (!existsSync(releaseRoot)) {
    return [];
  }

  return readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((castName) => {
      const chunksRoot = path.join(releaseRoot, castName, "chunks");
      if (!existsSync(chunksRoot)) {
        return false;
      }

      return readdirSync(chunksRoot).some((fileName) => fileName.startsWith("CAS_-") && fileName.endsWith(".json"));
    })
    .sort((left, right) => left.localeCompare(right));
}

function readCastListValue(value) {
  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  return [trimmed];
}

function normalizeName(value) {
  return String(value).trim().toLowerCase();
}

function buildCastEntry(releaseSummary, order, castName) {
  const releaseRoot = path.resolve(releaseSummary.outputRoot);
  const artifact = findCastSourceArtifact(releaseRoot, castName);
  const extractionRoot = artifact
    ? path.join(releaseRoot, artifact.extractionRoot)
    : path.join(releaseRoot, castName);
  const sourcePath = artifact
    ? path.resolve("client", artifact.sourcePath)
    : findCompiledCastPath(releaseSummary.release, castName);
  const resolved = existsSync(extractionRoot);
  const castData = resolved ? readMembers(extractionRoot) : undefined;
  const members = castData?.members ?? [];

  return {
    order,
    name: castName,
    expectedSourcePath: relative(sourcePath),
    sourceExists: existsSync(sourcePath),
    expectedExtractionRoot: relative(extractionRoot),
    ...(artifact ? { extractionSourcePath: artifact.sourcePath } : {}),
    resolved,
    ...(castData
      ? {
          minMember: castData.metadata.minMember,
          maxMember: castData.metadata.maxMember,
          memberSlotCount: castData.metadata.slotCount,
          sourceConfigPath: relative(castData.metadata.sourceConfigPath),
        }
      : {}),
    memberCount: members.length,
    memberTypes: countMemberTypes(members),
    members
  };
}

function findCastSourceArtifact(releaseRoot, castName) {
  const indexPath = path.join(releaseRoot, "source-artifacts.json");
  if (!existsSync(indexPath)) return undefined;

  const index = readProjectorRaysJson(indexPath);
  const normalizedCastName = normalizeName(castName);
  const candidates = (index.artifacts ?? []).filter(
    (artifact) => artifact.kind === "cast" && normalizeName(artifact.stem) === normalizedCastName,
  );
  if (candidates.length === 0) return undefined;

  return candidates.sort((left, right) => {
    const extensionRank = (extension) => extension === ".cct" ? 0 : extension === ".cst" ? 1 : 2;
    return extensionRank(left.extension) - extensionRank(right.extension)
      || String(left.sourcePath).localeCompare(String(right.sourcePath));
  })[0];
}

function findCompiledCastPath(release, castName) {
  const directPath = path.resolve("tmp/compiled-clients", release, release, `${castName}.cct`);
  if (existsSync(directPath)) {
    return directPath;
  }

  const releaseRoot = path.resolve("tmp/compiled-clients", release);
  if (!existsSync(releaseRoot)) {
    return directPath;
  }

  const stack = [releaseRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === `${castName.toLowerCase()}.cct`) {
        return entryPath;
      }
    }
  }

  return directPath;
}

function readMembers(castRoot) {
  const chunksRoot = path.join(castRoot, "chunks");
  const metadata = readDirectorCastMetadata(chunksRoot);
  const castRegistries = readOptionalChunkJsonFiles(chunksRoot, "CAS_");
  const primaryRegistry = castRegistries[0];
  if (!primaryRegistry?.json?.memberIDs) {
    return { metadata, members: [] };
  }

  const members = [];
  const seenChunkIds = new Set();

  primaryRegistry.json.memberIDs.forEach((chunkId, index) => {
    addCastRegistryMember(members, seenChunkIds, chunksRoot, primaryRegistry.fileName, chunkId, index, metadata, false);
  });

  for (const registry of castRegistries.slice(1)) {
    for (let index = 0; index < registry.json.memberIDs.length; index += 1) {
      addCastRegistryMember(members, seenChunkIds, chunksRoot, registry.fileName, registry.json.memberIDs[index], index, metadata, true);
    }
  }

  return { metadata, members };
}

function addCastRegistryMember(members, seenChunkIds, chunksRoot, registryFileName, chunkId, index, metadata, supplementalRegistry) {
    if (!chunkId) {
      return;
    }

    if (seenChunkIds.has(chunkId)) {
      return;
    }
    seenChunkIds.add(chunkId);

    const memberNumber = directorMemberNumber(index, metadata);
    const memberChunkPath = path.join(chunksRoot, `CASt-${chunkId}.json`);
    if (!existsSync(memberChunkPath)) {
      members.push({
        number: memberNumber,
        name: `missing CASt-${chunkId}`,
        type: "unknown",
        memberChunkId: chunkId,
        sourceRegistry: registryFileName,
        ...(supplementalRegistry ? { supplementalRegistry: true } : {})
      });
      return;
    }

    const memberChunk = readProjectorRaysJson(memberChunkPath);
    members.push({
      number: memberNumber,
      name: memberChunk.info?.name || undefined,
      type: mapMemberType(memberChunk.type),
      memberChunkId: chunkId,
      sourceRegistry: registryFileName,
      ...(supplementalRegistry ? { supplementalRegistry: true } : {})
    });
}

function countMemberTypes(members) {
  const counts = {};
  for (const member of members) {
    counts[member.type] = (counts[member.type] ?? 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function mapMemberType(type) {
  switch (type) {
    case 1:
      return "bitmap";
    case 3:
      return "text";
    case 4:
      return "palette";
    case 6:
      return "sound";
    case 8:
      return "shape";
    case 11:
      return "script";
    default:
      return "unknown";
  }
}

function readFirstOptionalChunkJson(chunksRoot, fourCCPrefix) {
  return readOptionalChunkJsonFiles(chunksRoot, fourCCPrefix)[0]?.json;
}

function readOptionalChunkJsonFiles(chunksRoot, fourCCPrefix) {
  if (!existsSync(chunksRoot)) {
    return [];
  }

  return readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith(`${fourCCPrefix}-`) && entry.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      json: readProjectorRaysJson(path.join(chunksRoot, fileName))
    }));
}

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--summary":
        parsed.summary = requireNext(rawArgs, ++index, arg);
        break;
      case "--external-fields":
        parsed.externalFields = requireNext(rawArgs, ++index, arg);
        break;
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--version":
        parsed.version = requireNext(rawArgs, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireNext(rawArgs, index, flag) {
  const value = rawArgs[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
