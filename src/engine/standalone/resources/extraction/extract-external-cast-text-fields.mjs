#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readDirectorKeyEntries } from "./director-bitd-recovery.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const externalCastGraphPath = path.resolve(args.externalCastGraph ?? "generated/runtime-data/external-cast-graph.json");
const outputPath = path.resolve(args.out ?? "generated/runtime-data/external-cast-text-fields.json");

if (!existsSync(externalCastGraphPath)) {
  throw new Error(`External cast graph not found: ${relative(externalCastGraphPath)}`);
}

const externalCastGraph = JSON.parse(readFileSync(externalCastGraphPath, "utf8"));
const releases = [];

for (const graphRelease of externalCastGraph.releases) {
  if (args.version && graphRelease.versionId !== args.version) {
    continue;
  }

  releases.push(extractReleaseTextFields(graphRelease));
}

if (releases.length === 0) {
  throw new Error(`No external cast graph release matched version filter: ${args.version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/extract-external-cast-text-fields.mjs",
      externalCastGraphPath: relative(externalCastGraphPath),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Extracted external cast text fields for ${releases.length} release(s)`);
console.log(`External cast text field index: ${relative(outputPath)}`);

function extractReleaseTextFields(graphRelease) {
  const fields = [];

  for (const cast of graphRelease.casts) {
    if (!cast.resolved) {
      continue;
    }

    fields.push(...extractCastTextFields(graphRelease, cast));
  }

  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    sourceId: graphRelease.sourceId,
    fields: fields.sort((left, right) => {
      if (left.castOrder !== right.castOrder) {
        return left.castOrder - right.castOrder;
      }

      return left.member - right.member;
    })
  };
}

function extractCastTextFields(graphRelease, cast) {
  const castRoot = path.resolve(cast.expectedExtractionRoot);
  const chunksRoot = path.join(castRoot, "chunks");
  const keyEntries = readDirectorKeyEntries(chunksRoot);
  const textSectionByMemberChunkId = new Map(
    keyEntries
      .filter((entry) => entry.fourCC === "STXT")
      .map((entry) => [entry.castID, entry.sectionID])
  );
  const fields = [];
  const usedTextSectionIds = new Set();
  const fieldNames = new Set();

  for (const member of cast.members) {
    const textSectionId = textSectionByMemberChunkId.get(member.memberChunkId);
    if (!textSectionId) {
      continue;
    }

    const textChunkPath = path.join(chunksRoot, `STXT-${textSectionId}.bin`);
    if (!existsSync(textChunkPath)) {
      continue;
    }

    const parsedText = parseStxtChunk(textChunkPath);
    fields.push(createTextFieldEntry(graphRelease, cast, member, textSectionId, textChunkPath, parsedText));
    usedTextSectionIds.add(textSectionId);
    fieldNames.add(String(member.name ?? `member ${member.number}`).toLowerCase());
  }

  const textMembersByName = textMembersByLowercaseName(cast);
  const stxtChunks = existsSync(chunksRoot)
    ? readStxtChunks(chunksRoot).filter((chunk) => !usedTextSectionIds.has(chunk.sectionId))
    : [];

  fields.push(
    ...recoverUnkeyedLayoutTextFields(
      graphRelease,
      cast,
      stxtChunks,
      usedTextSectionIds,
      fieldNames,
      textMembersByName
    )
  );
  fields.push(
    ...recoverUnkeyedPatternTextFields(
      graphRelease,
      cast,
      stxtChunks,
      usedTextSectionIds,
      fieldNames,
      textMembersByName
    )
  );

  return fields;
}

function createTextFieldEntry(graphRelease, cast, member, textSectionId, textChunkPath, parsedText) {
  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    castName: cast.name,
    castOrder: cast.order,
    member: member.number,
    memberChunkId: member.memberChunkId,
    memberName: member.name ?? `member ${member.number}`,
    memberType: member.type,
    textSectionId,
    textChunkPath: relative(textChunkPath),
    textLength: parsedText.textLength,
    styleTrailingBytes: parsedText.styleTrailingBytes,
    text: parsedText.text,
    properties: parseFieldProperties(parsedText.text)
  };
}

function textMembersByLowercaseName(cast) {
  return new Map(
    cast.members
      .filter((member) => member.type === "text" && member.name)
      .map((member) => [member.name.toLowerCase(), member])
  );
}

function recoverUnkeyedLayoutTextFields(
  graphRelease,
  cast,
  stxtChunks,
  usedTextSectionIds,
  fieldNames,
  textMembersByName
) {
  const recovered = [];

  for (const chunk of stxtChunks) {
    if (usedTextSectionIds.has(chunk.sectionId)) {
      continue;
    }

    const layoutIdentity = layoutIdentityFromText(chunk.parsedText.text);
    if (!layoutIdentity) {
      continue;
    }

    const memberName = layoutMemberName(layoutIdentity);
    if (!memberName || fieldNames.has(memberName)) {
      continue;
    }

    const member = textMembersByName.get(memberName);
    if (!member) {
      continue;
    }

    recovered.push(createTextFieldEntry(graphRelease, cast, member, chunk.sectionId, chunk.filePath, chunk.parsedText));
    usedTextSectionIds.add(chunk.sectionId);
    fieldNames.add(memberName);
  }

  return recovered;
}

function layoutIdentityFromText(text) {
  const kindMatch = text.match(/<\s*(window|room|visual)\s*>/i);
  if (!kindMatch) {
    return undefined;
  }

  const name = parseLayoutName(text);
  if (!name) {
    return undefined;
  }

  return {
    kind: kindMatch[1].toLowerCase(),
    name
  };
}

function parseLayoutName(text) {
  const nameTag = text.match(/<\s*name\s*>[\s\S]*?<\s*\/\s*name\s*>/i)?.[0];
  return nameTag?.match(/"([^"]+)"/)?.[1]?.trim().toLowerCase();
}

function layoutMemberName(layoutIdentity) {
  if (layoutIdentity.kind === "room") {
    return `${layoutIdentity.name}.room`;
  }

  return `${layoutIdentity.name}.${layoutIdentity.kind}`;
}

function recoverUnkeyedPatternTextFields(
  graphRelease,
  cast,
  stxtChunks,
  usedTextSectionIds,
  fieldNames,
  textMembersByName
) {
  const patternLists = [];
  const recovered = [];

  for (const family of ["wallpattern", "floorpattern"]) {
    const listFieldName = `${family}_patterns`;
    const listMember = textMembersByName.get(listFieldName);
    if (!listMember) {
      continue;
    }

    const listChunk = stxtChunks.find((chunk) => isPatternListText(chunk.parsedText.text, family));
    if (!listChunk) {
      continue;
    }

    const names = patternListNames(listChunk.parsedText.text, family);
    if (names.length === 0) {
      continue;
    }

    patternLists.push({
      family,
      names: new Set(names)
    });

    if (!fieldNames.has(listFieldName)) {
      recovered.push(createTextFieldEntry(graphRelease, cast, listMember, listChunk.sectionId, listChunk.filePath, listChunk.parsedText));
      usedTextSectionIds.add(listChunk.sectionId);
      fieldNames.add(listFieldName);
    }
  }

  if (patternLists.length === 0) {
    return recovered;
  }

  for (const chunk of stxtChunks) {
    if (usedTextSectionIds.has(chunk.sectionId)) {
      continue;
    }

    const memberName = patternFieldNameFromText(chunk.parsedText.text, patternLists);
    if (!memberName || fieldNames.has(memberName)) {
      continue;
    }

    const member = textMembersByName.get(memberName) ?? {
      number: 100000 + chunk.sectionId,
      memberChunkId: chunk.sectionId,
      name: memberName,
      type: "text"
    };
    recovered.push(createTextFieldEntry(graphRelease, cast, member, chunk.sectionId, chunk.filePath, chunk.parsedText));
    usedTextSectionIds.add(chunk.sectionId);
    fieldNames.add(memberName);
  }

  return recovered;
}

function readStxtChunks(chunksRoot) {
  return readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith("STXT-") && entry.endsWith(".bin"))
    .map((entry) => {
      const sectionId = Number.parseInt(entry.slice("STXT-".length, -".bin".length), 10);
      const filePath = path.join(chunksRoot, entry);
      return {
        sectionId,
        filePath,
        parsedText: parseStxtChunk(filePath)
      };
    })
    .filter((entry) => Number.isFinite(entry.sectionId))
    .sort((left, right) => left.sectionId - right.sectionId);
}

function isPatternListText(text, family) {
  const lines = patternListNames(text, family);
  return lines.length > 1;
}

function patternListNames(text, family) {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${family}_`) && !line.includes(","));
}

function patternFieldNameFromText(text, patternLists) {
  const firstLine = text.split(/\r\n?|\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return undefined;
  }

  const parts = firstLine.split(",").map((part) => part.trim().toLowerCase());
  if (parts.length < 5 || !/^\d+$/.test(parts[0] ?? "")) {
    return undefined;
  }

  const paletteToken = (parts[1] ?? "").replace(/^catalog_/, "");
  for (const patternList of patternLists) {
    const candidates = patternFieldCandidates(patternList.family, paletteToken);
    for (const candidate of candidates) {
      if (patternList.names.has(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function patternFieldCandidates(family, paletteToken) {
  const prefix = family === "wallpattern" ? "wall_" : "floor_";
  if (!paletteToken.startsWith(prefix)) {
    return [];
  }

  const suffix = paletteToken.slice(prefix.length);
  const candidates = [`${family}_${suffix}`];
  const withoutTrailingDigits = suffix.replace(/\d+$/, "");
  if (withoutTrailingDigits && withoutTrailingDigits !== suffix) {
    candidates.push(`${family}_${withoutTrailingDigits}`);
  }

  if (family === "wallpattern" && suffix === "white") {
    candidates.push("wallpattern_plain");
  }
  if (family === "floorpattern" && suffix === "basic") {
    candidates.push("floorpattern_plain");
  }

  return candidates;
}

function parseStxtChunk(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 12) {
    throw new Error(`STXT chunk is too short: ${relative(filePath)}`);
  }

  const textOffset = bytes.readUInt32BE(0);
  const textLength = bytes.readUInt32BE(4);
  if (textOffset < 12 || textOffset + textLength > bytes.length) {
    throw new Error(`Invalid STXT text bounds in ${relative(filePath)}: offset ${textOffset}, length ${textLength}, file ${bytes.length}`);
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

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--external-cast-graph":
        parsed.externalCastGraph = requireNext(rawArgs, ++index, arg);
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
