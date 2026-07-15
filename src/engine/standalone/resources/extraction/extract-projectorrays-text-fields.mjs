#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readDirectorKeyEntries } from "./director-bitd-recovery.mjs";
import { directorMemberNumber, readDirectorCastMetadata } from "./director-cast-metadata.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const extractionSummaryPath = path.resolve(args.summary ?? "generated/extraction/projectorrays-summary.json");
const manifestRoot = path.resolve(args.manifestRoot ?? "generated/runtime-data");
const outputPath = path.resolve(args.out ?? "generated/runtime-data/projectorrays-text-fields.json");

if (!existsSync(extractionSummaryPath)) {
  throw new Error(`ProjectorRays extraction summary not found: ${extractionSummaryPath}`);
}

const extractionSummary = JSON.parse(readFileSync(extractionSummaryPath, "utf8"));
const releases = [];

for (const releaseSummary of extractionSummary.releases) {
  if (args.release && releaseSummary.release !== args.release) {
    continue;
  }

  releases.push(extractReleaseTextFields(releaseSummary));
}

if (releases.length === 0) {
  throw new Error(`No ProjectorRays releases matched release filter: ${args.release}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      extractionSummaryPath: relative(extractionSummaryPath),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Extracted text fields for ${releases.length} ProjectorRays release(s)`);
console.log(`Text field index: ${relative(outputPath)}`);

function extractReleaseTextFields(releaseSummary) {
  const releaseRoot = path.resolve(releaseSummary.outputRoot);
  const entryMovieRoot = path.join(releaseRoot, entryMovieStem(releaseSummary.entryMovie));
  const manifestPath = path.join(manifestRoot, `${releaseSummary.release}-projectorrays-manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing generated manifest for ${releaseSummary.release}: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fields = [];

  for (const cast of manifest.casts) {
    const castRoot = resolveCastRoot(releaseRoot, entryMovieRoot, cast);
    if (!castRoot) {
      continue;
    }

    const chunksRoot = path.join(castRoot, "chunks");
    const castMetadata = readDirectorCastMetadata(chunksRoot);
    const castRegistry = readFirstOptionalChunkJson(chunksRoot, "CAS_");
    const keyEntries = readDirectorKeyEntries(chunksRoot);
    if (!castRegistry?.memberIDs || keyEntries.length === 0) {
      continue;
    }

    const textChunksByMemberChunkId = new Map(
      keyEntries
        .filter((entry) => entry.fourCC === "STXT")
        .map((entry) => [entry.castID, entry.sectionID])
    );

    castRegistry.memberIDs.forEach((memberChunkId, memberIndex) => {
      if (!memberChunkId) {
        return;
      }

      const textSectionId = textChunksByMemberChunkId.get(memberChunkId);
      if (!textSectionId) {
        return;
      }

      const memberChunkPath = path.join(chunksRoot, `CASt-${memberChunkId}.json`);
      const textChunkPath = path.join(chunksRoot, `STXT-${textSectionId}.bin`);
      if (!existsSync(memberChunkPath) || !existsSync(textChunkPath)) {
        return;
      }

      const memberChunk = JSON.parse(readFileSync(memberChunkPath, "utf8"));
      const parsedText = parseStxtChunk(textChunkPath);
      const memberNumber = directorMemberNumber(memberIndex, castMetadata);
      const memberName = memberChunk.info?.name || `member ${memberNumber}`;

      fields.push({
        castLib: cast.number,
        castName: cast.name,
        member: memberNumber,
        memberChunkId,
        memberName,
        textSectionId,
        textChunkPath: relative(textChunkPath),
        textLength: parsedText.textLength,
        styleTrailingBytes: parsedText.styleTrailingBytes,
        text: parsedText.text,
        properties: parseFieldProperties(parsedText.text)
      });
    });
  }

  return {
    release: releaseSummary.release,
    fields: fields.sort((left, right) => left.castLib - right.castLib || left.member - right.member)
  };
}

function parseStxtChunk(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 12) {
    throw new Error(`STXT chunk is too short: ${filePath}`);
  }

  const textOffset = bytes.readUInt32BE(0);
  const textLength = bytes.readUInt32BE(4);
  if (textOffset < 12 || textOffset + textLength > bytes.length) {
    throw new Error(`Invalid STXT text bounds in ${filePath}: offset ${textOffset}, length ${textLength}, file ${bytes.length}`);
  }

  return {
    textLength,
    styleTrailingBytes: bytes.length - textOffset - textLength,
    text: bytes.subarray(textOffset, textOffset + textLength).toString("latin1")
  };
}

function parseFieldProperties(text) {
  const properties = {};
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      properties[key] = value;
    }
  }

  return Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)));
}

function resolveCastRoot(releaseRoot, entryMovieRoot, cast) {
  if (cast.number === 1 && existsSync(entryMovieRoot)) {
    return entryMovieRoot;
  }

  const candidates = [
    stemFromDirectorPath(cast.fileName),
    cast.name,
    normalizeCastDirectoryName(cast.name)
  ].filter(Boolean);

  for (const candidate of candidates) {
    const candidateRoot = path.join(releaseRoot, candidate);
    if (existsSync(candidateRoot)) {
      return candidateRoot;
    }
  }

  return undefined;
}

function readFirstOptionalChunkJson(chunksRoot, fourCCPrefix) {
  if (!existsSync(chunksRoot)) {
    return undefined;
  }

  const fileName = readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith(`${fourCCPrefix}-`) && entry.endsWith(".json"))
    .sort()[0];

  return fileName ? readProjectorRaysJson(path.join(chunksRoot, fileName)) : undefined;
}

function readProjectorRaysJson(filePath) {
  const source = readFileSync(filePath, "utf8");
  return JSON.parse(source.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1"));
}

function stemFromDirectorPath(filePath) {
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : undefined;
  return fileName ? fileName.replace(/\.[^.]+$/, "") : undefined;
}

function normalizeCastDirectoryName(name) {
  return name ? name.replace(/\s+\d+$/, "") : undefined;
}

function entryMovieStem(entryMovie) {
  const relativePath = entryMovie?.relativePath;
  if (!relativePath) {
    return "habbo";
  }

  return path.basename(relativePath).replace(/\.[^.]+$/, "");
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
      case "--manifest-root":
        parsed.manifestRoot = requireNext(rawArgs, ++index, arg);
        break;
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--release":
        parsed.release = requireNext(rawArgs, ++index, arg);
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
