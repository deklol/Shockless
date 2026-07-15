#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "engine.config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const version = args.version ?? "release306";
const sourceRoot = args.sourceRoot ? path.resolve(args.sourceRoot) : undefined;
const graphPath = path.resolve(
  args.externalCastGraph ?? path.join(config.runtimeDataRoot, `external-cast-graph.${version}.json`),
);
const existingTextPath = path.resolve(
  args.externalCastTextFields ?? path.join(config.runtimeDataRoot, `external-cast-text-fields.${version}.json`),
);
const outputPath = path.resolve(
  args.out ?? path.join(repoRoot, "generated", "runtime-data", `external-cast-text-fields-supplement.${version}.json`),
);

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const existingTextFields = JSON.parse(readFileSync(existingTextPath, "utf8"));
const releases = [];

for (const graphRelease of graph.releases ?? []) {
  if (graphRelease.versionId !== version) continue;
  const existingRelease = (existingTextFields.releases ?? []).find((release) => release.versionId === graphRelease.versionId);
  releases.push(recoverRelease(graphRelease, existingRelease?.fields ?? []));
}

if (releases.length === 0) {
  throw new Error(`No release found for ${version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/recover-external-cast-text-fields.mjs",
      externalCastGraphPath: relative(graphPath),
      externalCastTextFieldsPath: relative(existingTextPath),
      reason:
        "Supplements unkeyed external STXT text members that ProjectorRays exposes in the cast graph but the donor text-field index could not key through KEY* entries.",
      releases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const count = releases.reduce((total, release) => total + release.fields.length, 0);
console.log(`Recovered ${count} external cast text field(s)`);
console.log(`Supplement written: ${relative(outputPath)}`);

function recoverRelease(graphRelease, existingFields) {
  const fields = [];
  const existingByCast = groupBy(existingFields, (field) => normalizeName(field.castName));

  for (const cast of graphRelease.casts ?? []) {
    if (!cast.resolved) continue;
    const recovered = recoverCast(graphRelease, cast, existingByCast.get(normalizeName(cast.name)) ?? []);
    fields.push(...recovered);
  }

  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    sourceId: graphRelease.sourceId,
    fields: fields.sort((left, right) => {
      if (left.castOrder !== right.castOrder) return left.castOrder - right.castOrder;
      return left.member - right.member;
    }),
  };
}

function recoverCast(graphRelease, cast, existingFields) {
  const chunksRoot = path.join(resolveCastExtractionRoot(cast), "chunks");
  if (!existsSync(chunksRoot)) return [];

  const usedSections = new Set(existingFields.map((field) => Number(field.textSectionId)).filter(Number.isFinite));
  const usedNames = new Set(existingFields.map((field) => normalizeName(field.memberName)));
  const graphMembers = (cast.members ?? []).filter((member) => member.type === "text" && member.name);
  const graphMissing = graphMembers.filter((member) => !usedNames.has(normalizeName(member.name)));
  const chunks = readStxtChunks(chunksRoot).filter((chunk) => !usedSections.has(chunk.sectionId));
  const recovered = [];
  const claim = (member, chunk, note) => {
    if (!member || !chunk || usedSections.has(chunk.sectionId) || usedNames.has(normalizeName(member.name))) return false;
    recovered.push(createTextFieldEntry(graphRelease, cast, member, chunk, note));
    usedSections.add(chunk.sectionId);
    usedNames.add(normalizeName(member.name));
    return true;
  };

  for (const member of graphMissing) {
    const chunk = findChunkForGraphMember(member, chunks, usedSections, graphMissing);
    claim(member, chunk, "graph-member-recovery");
  }

  const patternNames = new Set([
    ...patternListNames(existingFields),
    ...patternListNames(recovered),
  ]);
  let nextSyntheticMember = Math.max(
    0,
    ...(cast.members ?? []).map((member) => Number(member.number)).filter(Number.isFinite),
    ...existingFields.map((field) => Number(field.member)).filter(Number.isFinite),
    ...recovered.map((field) => Number(field.member)).filter(Number.isFinite),
  ) + 1;

  for (const chunk of chunks) {
    if (usedSections.has(chunk.sectionId)) continue;
    const memberName = patternMemberNameFromText(chunk.text, patternNames);
    if (!memberName || usedNames.has(normalizeName(memberName))) continue;
    const member = {
      number: nextSyntheticMember++,
      name: memberName,
      type: "text",
      memberChunkId: chunk.sectionId,
    };
    claim(member, chunk, "source-referenced-pattern-recovery");
  }

  return recovered;
}

function findChunkForGraphMember(member, chunks, usedSections, allMissingMembers) {
  const memberName = normalizeName(member.name);
  const unused = chunks.filter((chunk) => !usedSections.has(chunk.sectionId));

  if (memberName === "memberalias.index") {
    return unused.find((chunk) => hasMarker(chunk.text, "#alias") && /\bclass\s*=/i.test(chunk.text));
  }

  if (memberName === "variable.index") {
    return unused.find((chunk) => hasMarker(chunk.text, "#variables"));
  }

  const layoutIdentity = layoutIdentityForMember(memberName, unused);
  if (layoutIdentity) return layoutIdentity;

  if (memberName.endsWith(".room")) {
    const missingRooms = allMissingMembers.filter((entry) => normalizeName(entry.name).endsWith(".room"));
    const layoutChunks = unused.filter((chunk) => layoutIdentityFromText(chunk.text)?.kind === "room");
    if (missingRooms.length === 1 && layoutChunks.length === 1) return layoutChunks[0];
  }

  if (memberName.endsWith(".props")) {
    const propsChunks = unused.filter((chunk) => isPropsText(chunk.text));
    if (propsChunks.length === 0) return undefined;
    if (memberName.startsWith("left_")) return propsChunks.sort(comparePropsByZShift)[0];
    if (memberName.startsWith("right_")) return propsChunks.sort(comparePropsByZShift).at(-1);
    if (propsChunks.length === 1) return propsChunks[0];
  }

  if (memberName.startsWith("wallpattern_") || memberName.startsWith("floorpattern_")) {
    return unused.find((chunk) => patternMemberCandidates(chunk.text).includes(memberName));
  }

  return undefined;
}

function layoutIdentityForMember(memberName, chunks) {
  return chunks.find((chunk) => {
    const identity = layoutIdentityFromText(chunk.text);
    return identity ? `${identity.name}.${identity.kind}` === memberName : false;
  });
}

function layoutIdentityFromText(text) {
  const kindMatch = text.match(/<\s*(window|room|visual)\s*>/i);
  if (!kindMatch) return undefined;
  const nameTag = text.match(/<\s*name\s*>[\s\S]*?<\s*\/\s*name\s*>/i)?.[0];
  const name = nameTag?.match(/"([^"]+)"/)?.[1]?.trim().toLowerCase();
  if (!name) return undefined;
  return { kind: kindMatch[1].toLowerCase(), name };
}

function patternListNames(fields) {
  const names = [];
  for (const field of fields) {
    const name = normalizeName(field.memberName);
    if (name !== "wallpattern_patterns" && name !== "floorpattern_patterns") continue;
    for (const line of String(field.text ?? "").split(/\r\n?|\n/)) {
      const trimmed = normalizeName(line);
      if (trimmed.startsWith("wallpattern_") || trimmed.startsWith("floorpattern_")) {
        names.push(trimmed);
      }
    }
  }
  return names;
}

function patternMemberNameFromText(text, allowedNames) {
  for (const candidate of patternMemberCandidates(text)) {
    if (allowedNames.has(candidate)) return candidate;
  }
  return undefined;
}

function patternMemberCandidates(text) {
  const firstLine = text.split(/\r\n?|\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return [];
  const parts = firstLine.split(",").map((part) => part.trim().toLowerCase());
  if (parts.length < 5 || !/^\d+$/.test(parts[0] ?? "")) return [];
  const mode = parts[0];
  const token = (parts[1] ?? "").replace(/^catalog_/, "");
  const candidates = [];

  if (token.startsWith("wall_")) {
    const suffix = token.slice("wall_".length);
    candidates.push(`wallpattern_${suffix}`);
    const withoutTrailingDigits = suffix.replace(/\d+$/, "");
    if (withoutTrailingDigits && withoutTrailingDigits !== suffix) {
      candidates.push(`wallpattern_${withoutTrailingDigits}`);
    }
    if (suffix === "white") candidates.push("wallpattern_plain");
  }

  if (token.startsWith("floor_")) {
    const suffix = token.slice("floor_".length);
    if (suffix === "basic" && mode === "0") candidates.push("floorpattern_plain");
    if (suffix === "basic" && mode === "2") candidates.push("floorpattern_wood");
    candidates.push(`floorpattern_${suffix}`);
    const withoutTrailingDigits = suffix.replace(/\d+$/, "");
    if (withoutTrailingDigits && withoutTrailingDigits !== suffix) {
      candidates.push(`floorpattern_${withoutTrailingDigits}`);
    }
  }

  return [...new Set(candidates.map(normalizeName).filter(Boolean))];
}

function isPropsText(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("[") && trimmed.includes("#") && trimmed.includes(":");
}

function comparePropsByZShift(left, right) {
  return firstNumber(left.text) - firstNumber(right.text);
}

function firstNumber(text) {
  const match = text.match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function hasMarker(text, marker) {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.trim().toLowerCase())
    .includes(marker.toLowerCase());
}

function createTextFieldEntry(graphRelease, cast, member, chunk, note) {
  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    castName: cast.name,
    castOrder: cast.order,
    member: member.number,
    memberChunkId: member.memberChunkId,
    memberName: member.name,
    memberType: member.type,
    textSectionId: chunk.sectionId,
    textChunkPath: relative(chunk.filePath),
    textLength: chunk.textLength,
    styleTrailingBytes: chunk.styleTrailingBytes,
    recovery: note,
    text: chunk.text,
    properties: parseFieldProperties(chunk.text),
  };
}

function readStxtChunks(chunksRoot) {
  return readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith("STXT-") && entry.endsWith(".bin"))
    .map((entry) => {
      const sectionId = Number.parseInt(entry.slice("STXT-".length, -".bin".length), 10);
      const filePath = path.join(chunksRoot, entry);
      const parsed = parseStxtChunk(filePath);
      return {
        sectionId,
        filePath,
        ...parsed,
      };
    })
    .filter((entry) => Number.isFinite(entry.sectionId))
    .sort((left, right) => left.sectionId - right.sectionId);
}

function parseStxtChunk(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 12) {
    throw new Error(`STXT chunk is too short: ${relative(filePath)}`);
  }
  const textOffset = bytes.readUInt32BE(0);
  const textLength = bytes.readUInt32BE(4);
  if (textOffset < 12 || textOffset + textLength > bytes.length) {
    throw new Error(
      `Invalid STXT text bounds in ${relative(filePath)}: offset ${textOffset}, length ${textLength}, file ${bytes.length}`,
    );
  }
  return {
    textLength,
    styleTrailingBytes: bytes.length - textOffset - textLength,
    text: bytes.subarray(textOffset, textOffset + textLength).toString("latin1"),
  };
}

function parseFieldProperties(text) {
  const properties = {};
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) properties[key] = value;
  }
  return Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)));
}

function resolveCastExtractionRoot(cast) {
  const expected = String(cast.expectedExtractionRoot ?? "");
  if (expected && path.isAbsolute(expected)) return expected;

  const fromCwd = expected ? path.resolve(expected) : "";
  if (fromCwd && existsSync(fromCwd)) return fromCwd;

  const normalized = expected.replaceAll("\\", "/");
  if (sourceRoot) {
    const fromSourceRoot = path.join(sourceRoot, normalized);
    if (existsSync(fromSourceRoot)) return fromSourceRoot;
  }

  const releaseNeedle = `/${version}/`;
  const releaseIndex = normalized.toLowerCase().indexOf(releaseNeedle.toLowerCase());
  if (releaseIndex >= 0 && config.originsSourceRoot) {
    const relativeToRelease = normalized.slice(releaseIndex + releaseNeedle.length);
    return path.join(config.originsSourceRoot, relativeToRelease);
  }

  if (config.originsSourceRoot) {
    return path.join(config.originsSourceRoot, String(cast.name ?? ""));
  }

  return path.join(repoRoot, String(cast.name ?? ""));
}

function groupBy(values, keyOf) {
  const map = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return map;
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.(cct|cst)$/i, "");
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--version":
        parsed.version = requireNext(rawArgs, ++index, arg);
        break;
      case "--external-cast-graph":
        parsed.externalCastGraph = requireNext(rawArgs, ++index, arg);
        break;
      case "--external-cast-text-fields":
        parsed.externalCastTextFields = requireNext(rawArgs, ++index, arg);
        break;
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--source-root":
        parsed.sourceRoot = requireNext(rawArgs, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireNext(rawArgs, index, flag) {
  const value = rawArgs[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
