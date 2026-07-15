#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readDirectorKeyEntries } from "./director-bitd-recovery.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const layoutKind = args.layoutKind ?? "window";
const externalCastGraphPath = path.resolve(args.externalCastGraph ?? "generated/runtime-data/external-cast-graph.json");
const externalCastTextFieldsPath = path.resolve(args.externalCastTextFields ?? "generated/runtime-data/external-cast-text-fields.json");
const outputPath = path.resolve(args.out ?? defaultOutputPath(layoutKind));

if (layoutKind !== "window" && layoutKind !== "visual") {
  throw new Error(`Unsupported layout kind: ${layoutKind}`);
}

if (!existsSync(externalCastGraphPath)) {
  throw new Error(`External cast graph not found: ${relative(externalCastGraphPath)}`);
}

if (!existsSync(externalCastTextFieldsPath)) {
  throw new Error(`External cast text field index not found: ${relative(externalCastTextFieldsPath)}`);
}

const externalCastGraph = JSON.parse(readFileSync(externalCastGraphPath, "utf8"));
const externalCastTextFields = JSON.parse(readFileSync(externalCastTextFieldsPath, "utf8"));
const releases = [];

for (const textRelease of externalCastTextFields.releases) {
  if (args.version && textRelease.versionId !== args.version) {
    continue;
  }

  const graphRelease = externalCastGraph.releases.find((entry) => entry.versionId === textRelease.versionId);
  if (!graphRelease) {
    throw new Error(`No external cast graph release found for ${textRelease.versionId}`);
  }

  releases.push(buildReleaseLayoutIndex(graphRelease, textRelease, layoutKind));
}

if (releases.length === 0) {
  throw new Error(`No external cast release matched version filter: ${args.version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/build-external-cast-window-layout-index.mjs",
      layoutKind,
      externalCastGraphPath: relative(externalCastGraphPath),
      externalCastTextFieldsPath: relative(externalCastTextFieldsPath),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Built external cast ${layoutKind} layout index for ${releases.length} release(s)`);
console.log(`External cast ${layoutKind} layout index: ${relative(outputPath)}`);

function buildReleaseLayoutIndex(graphRelease, textRelease, kind) {
  const context = createReleaseContext(graphRelease, textRelease);
  const layouts = textRelease.fields
    .filter((field) => isLayoutField(field, kind))
    .map((field) => parseLayoutField(context, field, kind))
    .sort((left, right) => {
      if (left.castOrder !== right.castOrder) {
        return left.castOrder - right.castOrder;
      }

      return left.member - right.member;
    });

  const base = {
    versionId: textRelease.versionId,
    release: textRelease.release,
    sourceId: textRelease.sourceId,
    bitmapReferenceCount: layouts.reduce((count, layout) => count + layout.bitmapReferences.length, 0),
    unresolvedReferenceCount: layouts.reduce((count, layout) => count + layout.unresolvedReferences.length, 0)
  };

  if (kind === "visual") {
    return {
      ...base,
      visualCount: layouts.length,
      visuals: layouts
    };
  }

  return {
    ...base,
    windowCount: layouts.length,
    windows: layouts
  };
}

function createReleaseContext(graphRelease, textRelease) {
  const memberMatchesByName = new Map();
  const memberMatchesByWhitespaceNormalizedName = new Map();
  const textFieldsByCastAndMember = new Map();

  for (const cast of graphRelease.casts) {
    if (!cast.resolved) {
      continue;
    }

    for (const member of cast.members) {
      if (!member.name) {
        continue;
      }

      const match = {
        castName: cast.name,
        castOrder: cast.order,
        member: member.number,
        memberChunkId: member.memberChunkId,
        memberName: member.name,
        memberType: member.type,
        extractionRoot: cast.expectedExtractionRoot
      };
      const existing = memberMatchesByName.get(member.name) ?? [];
      existing.push(match);
      memberMatchesByName.set(member.name, existing);

      const normalizedMemberName = whitespaceNormalizedMemberName(member.name);
      if (normalizedMemberName) {
        const normalizedExisting = memberMatchesByWhitespaceNormalizedName.get(normalizedMemberName) ?? [];
        normalizedExisting.push(match);
        memberMatchesByWhitespaceNormalizedName.set(normalizedMemberName, normalizedExisting);
      }
    }
  }

  for (const matches of [...memberMatchesByName.values(), ...memberMatchesByWhitespaceNormalizedName.values()]) {
    matches.sort((left, right) => {
      if (left.castOrder !== right.castOrder) {
        return left.castOrder - right.castOrder;
      }

      return left.member - right.member;
    });
  }

  for (const field of textRelease.fields) {
    textFieldsByCastAndMember.set(`${field.castName}:${field.member}`, field);
  }

  return {
    graphRelease,
    textRelease,
    memberMatchesByName,
    memberMatchesByWhitespaceNormalizedName,
    textFieldsByCastAndMember
  };
}

function parseLayoutField(context, field, kind) {
  const elements = parseWindowElements(field.text).map((element, index) => resolveElement(context, field, element, index));
  const rect = parseRect(field.text);
  const normalizedRect = normalizeRect(rect);
  const clientRect = parseClientRect(field.text);
  const border = parseBorder(field.text, normalizedRect, clientRect);
  const roomData = kind === "visual" ? parseFirstPropertyListTag(field.text, "roomdata") : undefined;
  const bitmapReferences = uniqueReferences(
    elements
      .filter((element) => element.media === "bitmap" && element.resolvedMember?.memberType === "bitmap")
      .map((element) => element.resolvedMember)
  );
  const unresolvedReferences = elements
    .filter((element) => element.unresolvedReason)
    .map((element) => ({
      elementIndex: element.index,
      memberName: element.memberName,
      media: element.media,
      reason: element.unresolvedReason
    }));

  const layoutName = parseTagValue(field.text, "name") ?? stripLayoutSuffix(field.memberName, kind);

  return {
    versionId: field.versionId,
    release: field.release,
    castName: field.castName,
    castOrder: field.castOrder,
    member: field.member,
    memberChunkId: field.memberChunkId,
    memberName: field.memberName,
    ...(kind === "visual" ? { visualName: layoutName } : { windowName: layoutName }),
    textChunkPath: field.textChunkPath,
    elementCount: elements.length,
    rect,
    ...(normalizedRect ? { normalizedRect } : {}),
    ...(border ? { border } : {}),
    ...(clientRect ? { clientRect } : {}),
    ...(roomData ? { roomData } : {}),
    bounds: computeElementBounds(elements),
    bitmapReferences,
    unresolvedReferences,
    elements
  };
}

function resolveElement(context, field, element, index) {
  const memberName = typeof element.properties.member === "string" ? element.properties.member : undefined;
  const media = typeof element.properties.media === "string" ? element.properties.media : undefined;
  const memberLookup = memberName ? findMemberMatches(context, memberName) : { matches: [] };
  const matches = memberLookup.matches;
  const preferredMatch = choosePreferredMatch(matches, media, field.castName);
  const resolvedMember = preferredMatch ? resolveMemberReference(context, preferredMatch) : undefined;

  return {
    index,
    memberName,
    media,
    locH: numberProperty(element.properties.locH),
    locV: numberProperty(element.properties.locV),
    width: numberProperty(element.properties.width),
    height: numberProperty(element.properties.height),
    ink: numberProperty(element.properties.ink),
    blend: numberProperty(element.properties.blend),
    locZ: numberProperty(element.properties.locZ),
    active: booleanLikeProperty(element.properties.active ?? element.properties.Active),
    palette: stringProperty(element.properties.palette),
    type: stringProperty(element.properties.type),
    id: stringProperty(element.properties.id),
    model: stringProperty(element.properties.model),
    key: stringProperty(element.properties.key),
    stretch: stringProperty(element.properties.strech ?? element.properties.stretch),
    properties: element.properties,
    ...(memberLookup.reason ? { memberNameResolution: memberLookup.reason } : {}),
    ...(matches.length > 1
      ? {
          candidateMembers: matches.map((match) => ({
            castName: match.castName,
            castOrder: match.castOrder,
            member: match.member,
            memberChunkId: match.memberChunkId,
            memberType: match.memberType
          }))
        }
      : {}),
    ...(resolvedMember ? { resolvedMember } : {}),
    ...(!resolvedMember && memberName && media === "bitmap" ? { unresolvedReason: "bitmap member name did not resolve to a bitmap cast member" } : {}),
    ...(!resolvedMember && memberName && media === "field" ? { unresolvedReason: "field element is runtime text/localization, not a cast asset" } : {})
  };
}

function findMemberMatches(context, memberName) {
  const exact = context.memberMatchesByName.get(memberName) ?? [];
  if (exact.length > 0) {
    return { matches: exact };
  }

  const normalizedName = whitespaceNormalizedMemberName(memberName);
  if (!normalizedName || normalizedName === memberName) {
    return { matches: [] };
  }

  const normalized = context.memberMatchesByWhitespaceNormalizedName.get(normalizedName) ?? [];
  return normalized.length > 0
    ? { matches: normalized, reason: "whitespace-normalized-member-name" }
    : { matches: [] };
}

function choosePreferredMatch(matches, media, preferredCastName) {
  if (matches.length === 0) {
    return undefined;
  }

  const castMatches = preferredCastName
    ? matches.filter((match) => normalizeCastName(match.castName) === normalizeCastName(preferredCastName))
    : [];
  const candidates = castMatches.length > 0 ? castMatches : matches;

  if (media === "bitmap") {
    return candidates.find((match) => match.memberType === "bitmap") ?? candidates[0];
  }

  if (media === "field") {
    return candidates.find((match) => match.memberType === "text") ?? candidates[0];
  }

  return candidates[0];
}

function normalizeCastName(value) {
  return String(value).trim().toLowerCase();
}

function whitespaceNormalizedMemberName(value) {
  return String(value).replace(/\s+/g, "");
}

function resolveMemberReference(context, match) {
  const castRoot = path.resolve(match.extractionRoot);
  const chunksRoot = path.join(castRoot, "chunks");
  const memberChunkPath = path.join(chunksRoot, `CASt-${match.memberChunkId}.bin`);
  const base = {
    castName: match.castName,
    castOrder: match.castOrder,
    member: match.member,
    memberChunkId: match.memberChunkId,
    memberName: match.memberName,
    memberType: match.memberType,
    memberChunkPath: relative(memberChunkPath),
    memberChunkExists: existsSync(memberChunkPath)
  };

  if (match.memberType === "bitmap") {
    return {
      ...base,
      bitmap: readBitmapAssetMetadata(chunksRoot, memberChunkPath, match.memberChunkId)
    };
  }

  const textField = context.textFieldsByCastAndMember.get(`${match.castName}:${match.member}`);
  if (textField) {
    return {
      ...base,
      text: {
        textChunkPath: textField.textChunkPath,
        textLength: textField.textLength
      }
    };
  }

  return base;
}

function readBitmapAssetMetadata(chunksRoot, memberChunkPath, memberChunkId) {
  const keyEntries = readDirectorKeyEntries(chunksRoot);
  const bitdEntry = keyEntries.find((entry) => entry.castID === memberChunkId && entry.fourCC === "BITD");
  const thumbEntry = keyEntries.find((entry) => entry.castID === memberChunkId && entry.fourCC === "Thum");
  const bitdPath = bitdEntry ? path.join(chunksRoot, `BITD-${bitdEntry.sectionID}.bin`) : undefined;
  const thumbPath = thumbEntry ? findChunkBinBySection(chunksRoot, thumbEntry.sectionID) : undefined;

  return {
    ...parseBitmapInfo(memberChunkPath),
    ...(bitdEntry
      ? {
          bitdSectionId: bitdEntry.sectionID,
          bitdPath: relative(bitdPath),
          bitdExists: existsSync(bitdPath),
          bitdBytes: existsSync(bitdPath) ? statSync(bitdPath).size : 0
        }
      : { bitdExists: false, bitdBytes: 0 }),
    ...(thumbEntry
      ? {
          thumbnailSectionId: thumbEntry.sectionID,
          thumbnailPath: thumbPath ? relative(thumbPath) : undefined,
          thumbnailExists: thumbPath ? existsSync(thumbPath) : false
        }
      : {})
  };
}

function parseBitmapInfo(memberChunkPath) {
  if (!existsSync(memberChunkPath)) {
    return {
      metadataSource: "missing-cast-member-chunk",
      width: 0,
      height: 0,
      bitDepth: 0,
      pitch: 0,
      paletteId: 0,
      paletteCastLib: 0,
      regPoint: { x: 0, y: 0 },
      initialRect: { top: 0, left: 0, bottom: 0, right: 0 },
      alphaThreshold: 0,
      useAlpha: false
    };
  }

  const chunk = readFileSync(memberChunkPath);
  if (chunk.length < 12) {
    throw new Error(`CASt chunk is too short: ${relative(memberChunkPath)}`);
  }

  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (chunk.length < offset + specificDataLen || specificDataLen < 10) {
    return {
      metadataSource: "cast-member-specific-data-too-short",
      width: 0,
      height: 0,
      bitDepth: 0,
      pitch: 0,
      paletteId: 0,
      paletteCastLib: 0,
      regPoint: { x: 0, y: 0 },
      initialRect: { top: 0, left: 0, bottom: 0, right: 0 },
      alphaThreshold: 0,
      useAlpha: false
    };
  }

  const data = chunk.subarray(offset, offset + specificDataLen);
  const rawPitch = data.readUInt16BE(0);
  const top = data.readInt16BE(2);
  const left = data.readInt16BE(4);
  const bottom = data.readInt16BE(6);
  const right = data.readInt16BE(8);
  const alphaThreshold = data.length > 10 ? data.readUInt8(10) : 0;
  const regY = data.length >= 20 ? data.readInt16BE(18) : 0;
  const regX = data.length >= 22 ? data.readInt16BE(20) : 0;
  const updateFlags = data.length > 22 ? data.readUInt8(22) : 0;
  const hasColorImageFlag = (rawPitch & 0x8000) !== 0;

  return {
    metadataSource: "projectorrays-cast-member-chunk",
    width: right - left,
    height: bottom - top,
    bitDepth: hasColorImageFlag && data.length > 23 ? data.readUInt8(23) : 1,
    pitch: rawPitch & 0x3fff,
    paletteCastLib: hasColorImageFlag && data.length >= 26 ? data.readInt16BE(24) : 0,
    paletteId: hasColorImageFlag && data.length >= 28 ? data.readInt16BE(26) - 1 : 0,
    regPoint: { x: regX, y: regY },
    initialRect: { top, left, bottom, right },
    alphaThreshold,
    useAlpha: (updateFlags & 0x10) !== 0
  };
}

function parseWindowElements(text) {
  return findBracketedPropertyLists(text).map((raw) => ({
    properties: parsePropertyList(raw)
  }));
}

function findBracketedPropertyLists(text) {
  const lists = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      if (depth === 0) {
        start = index;
      }
      depth++;
      continue;
    }

    if (char === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        lists.push(text.slice(start + 1, index));
        start = -1;
      }
    }
  }

  return lists.filter((entry) => entry.includes("#member:"));
}

function parsePropertyList(raw) {
  const properties = {};
  for (const entry of splitTopLevel(raw, ",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      continue;
    }

    const key = entry.slice(0, separator).trim().replace(/^#/, "");
    const value = parsePropertyValue(entry.slice(separator + 1).trim());
    if (key) {
      properties[key] = value;
    }
  }

  return Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)));
}

function splitTopLevel(source, separator) {
  const result = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[" || char === "(") {
      depth++;
      continue;
    }

    if ((char === "]" || char === ")") && depth > 0) {
      depth--;
      continue;
    }

    if (char === separator && depth === 0) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }

  result.push(source.slice(start).trim());
  return result.filter(Boolean);
}

function parsePropertyValue(rawValue) {
  if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
    return rawValue.slice(1, -1);
  }

  if (rawValue.startsWith("#")) {
    return rawValue.slice(1);
  }

  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }

  return rawValue;
}

function computeElementBounds(elements) {
  const located = elements.filter((element) => {
    return typeof element.locH === "number" && typeof element.locV === "number" && typeof element.width === "number" && typeof element.height === "number";
  });

  if (located.length === 0) {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  const left = Math.min(...located.map((element) => element.locH));
  const top = Math.min(...located.map((element) => element.locV));
  const right = Math.max(...located.map((element) => element.locH + element.width));
  const bottom = Math.max(...located.map((element) => element.locV + element.height));

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function uniqueReferences(references) {
  const seen = new Set();
  const unique = [];
  for (const reference of references) {
    const key = `${reference.castName}:${reference.member}:${reference.memberChunkId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(reference);
  }

  return unique.sort((left, right) => {
    if (left.castOrder !== right.castOrder) {
      return left.castOrder - right.castOrder;
    }

    return left.member - right.member;
  });
}

function isLayoutField(field, kind) {
  const suffix = `.${kind}`;
  const tag = `<${kind}>`;
  if (kind === "visual" && (field.memberName.endsWith(".room") || field.text.includes("<room>"))) {
    return true;
  }

  return field.memberName.endsWith(suffix) || field.text.includes(tag);
}

function parseTagValue(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}>\\s*"([^"]+)"`, "i"));
  return match?.[1];
}

function parseRect(text) {
  const match = text.match(/<rect>[\s\S]*?\[([^\]]+)\]/i);
  if (!match?.[1]) {
    return undefined;
  }

  const values = match[1]
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));

  return values.length === 4 ? values : undefined;
}

function normalizeRect(rect) {
  if (!rect) {
    return undefined;
  }

  return [0, 0, rect[2] - rect[0], rect[3] - rect[1]];
}

function parseBorder(text, normalizedRect, clientRect) {
  const explicit = parseNumberListTag(text, "border");
  if (explicit) {
    return explicit;
  }

  if (normalizedRect && clientRect) {
    return [
      clientRect[0],
      clientRect[1],
      normalizedRect[2] - clientRect[2],
      normalizedRect[3] - clientRect[3]
    ];
  }

  return [0, 0, 0, 0];
}

function parseClientRect(text) {
  const tag = extractTagBody(text, "clientrect");
  if (!tag) {
    return undefined;
  }

  const rectMatch = tag.match(/rect\(([^)]+)\)/i);
  if (rectMatch?.[1]) {
    return parseFourNumberList(rectMatch[1]);
  }

  const listMatch = tag.match(/\[([^\]]+)\]/);
  return listMatch?.[1] ? parseFourNumberList(listMatch[1]) : undefined;
}

function parseNumberListTag(text, tagName) {
  const body = extractTagBody(text, tagName);
  if (!body) {
    return undefined;
  }

  const match = body.match(/\[([^\]]+)\]/);
  return match?.[1] ? parseFourNumberList(match[1]) : undefined;
}

function parseFirstPropertyListTag(text, tagName) {
  const body = extractTagBody(text, tagName);
  if (!body) {
    return undefined;
  }

  const match = body.match(/\[([^\]]+)\]/);
  return match?.[1] ? parsePropertyList(match[1]) : undefined;
}

function extractTagBody(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  return match?.[1];
}

function parseFourNumberList(source) {
  const values = source
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));

  return values.length === 4 ? values : undefined;
}

function stripLayoutSuffix(memberName, kind) {
  const suffix = `.${kind}`;
  if (kind === "visual" && memberName.endsWith(".room")) {
    return memberName.slice(0, -".room".length);
  }

  return memberName.endsWith(suffix) ? memberName.slice(0, -suffix.length) : memberName;
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

function findChunkBinBySection(chunksRoot, sectionId) {
  if (!existsSync(chunksRoot)) {
    return undefined;
  }

  const suffix = `-${sectionId}.bin`;
  const fileName = readdirSync(chunksRoot).find((entry) => entry.endsWith(suffix));
  return fileName ? path.join(chunksRoot, fileName) : undefined;
}

function stringProperty(value) {
  return typeof value === "string" ? value : undefined;
}

function numberProperty(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanLikeProperty(value) {
  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return value !== "" && value !== "0";
  }

  return undefined;
}

function defaultOutputPath(kind) {
  return kind === "visual"
    ? "generated/runtime-data/external-cast-visual-layout-index.json"
    : "generated/runtime-data/external-cast-window-layout-index.json";
}

function relative(filePath) {
  if (!filePath) {
    return undefined;
  }

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
      case "--external-cast-text-fields":
        parsed.externalCastTextFields = requireNext(rawArgs, ++index, arg);
        break;
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--layout-kind":
        parsed.layoutKind = requireNext(rawArgs, ++index, arg);
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
