#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readDirectorKeyEntries, recoverBitmapMetadataFromCastOrder, resolveBitmapBitdSource } from "./director-bitd-recovery.mjs";
import { createArtifactProgress } from "./import-progress.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const externalCastGraphPath = path.resolve(args.externalCastGraph ?? "generated/runtime-data/external-cast-graph.json");
const externalCastTextFieldsPath = path.resolve(args.externalCastTextFields ?? "generated/runtime-data/external-cast-text-fields.json");
const outputPath = path.resolve(args.out ?? "generated/runtime-data/button-bitmap-assets.json");
const assetRoot = path.resolve(args.assetRoot ?? "generated/assets/button-bitmaps");
const assetPathBase = path.resolve(args.assetPathBase ?? (args.assetRoot ? assetRoot : projectRoot));
const artifactProgress = createArtifactProgress("button-bitmaps");

if (!existsSync(externalCastGraphPath)) {
  throw new Error(`External cast graph not found: ${relative(externalCastGraphPath)}`);
}

if (!existsSync(externalCastTextFieldsPath)) {
  throw new Error(`External cast text fields not found: ${relative(externalCastTextFieldsPath)}`);
}

const externalCastGraph = JSON.parse(readFileSync(externalCastGraphPath, "utf8"));
const externalCastTextFields = JSON.parse(readFileSync(externalCastTextFieldsPath, "utf8"));
const releases = [];

for (const textFieldRelease of externalCastTextFields.releases) {
  if (args.version && textFieldRelease.versionId !== args.version) {
    continue;
  }

  const graphRelease = externalCastGraph.releases.find((entry) => entry.versionId === textFieldRelease.versionId);
  if (!graphRelease) {
    throw new Error(`No external cast graph release found for ${textFieldRelease.versionId}`);
  }

  releases.push(decodeRelease(graphRelease, textFieldRelease));
}

if (releases.length === 0) {
  throw new Error(`No button bitmap release matched version filter: ${args.version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/decode-button-element-bitmaps.mjs",
      externalCastGraphPath: relative(externalCastGraphPath),
      externalCastTextFieldsPath: relative(externalCastTextFieldsPath),
      assetRoot: assetRelative(assetRoot),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

const artifactTotals = artifactProgress.finish();

console.log(`Decoded button element bitmaps for ${releases.length} release(s)`);
console.log(`Wrote ${artifactTotals.outputFiles} PNG file(s), ${artifactTotals.outputBytes} byte(s)`);
console.log(`Button bitmap asset index: ${relative(outputPath)}`);

function decodeRelease(graphRelease, textFieldRelease) {
  const graphCastsByName = new Map(graphRelease.casts.map((cast) => [normalizeName(cast.name), cast]));
  const membersByName = buildMemberNameIndex(graphRelease);
  const assetsByKey = new Map();
  const unsupported = [];
  const sourceMissing = [];
  const elements = [];

  for (const field of textFieldRelease.fields.filter((entry) => entry.memberName.toLowerCase().endsWith(".element"))) {
    const stateSpecs = parseButtonElementStates(field);
    if (stateSpecs.length === 0) {
      unsupported.push({
        elementName: field.memberName,
        memberName: field.memberName,
        reason: "button element text did not contain parseable state member specs"
      });
      continue;
    }

    const states = [];
    for (const stateSpec of stateSpecs) {
      const parts = {};
      for (const partName of ["left", "middle", "right", "top", "bar", "lift", "bottom"]) {
        const partSpec = stateSpec.members[partName];
        if (!partSpec) {
          continue;
        }

        const memberMatch = resolveButtonPartMember(membersByName, field.castName, partSpec.memberName);
        if (!memberMatch) {
          sourceMissing.push({
            elementName: field.memberName,
            memberName: partSpec.memberName,
            reason: "source-authored button part name does not exist in the extracted cast graph"
          });
          continue;
        }

        const key = `${memberMatch.castName}:${memberMatch.member}`;
        let asset = assetsByKey.get(key);
        if (!asset) {
          asset = decodeButtonBitmap(graphCastsByName, graphRelease, field, memberMatch, unsupported);
          if (!asset) {
            continue;
          }
          assetsByKey.set(key, asset);
        }

        parts[partName] = {
          assetId: asset.id,
          castName: asset.castName,
          member: asset.member,
          memberName: asset.memberName,
          width: asset.width,
          height: asset.height,
          ...(partSpec.flipH ? { flipH: true } : {}),
          ...(partSpec.flipV ? { flipV: true } : {}),
          ...(partSpec.rotate !== undefined ? { rotate: partSpec.rotate } : {})
        };
      }

      states.push({
        state: stateSpec.state,
        parts,
        text: stateSpec.text
      });
    }

    elements.push({
      memberName: field.memberName,
      castName: field.castName,
      castOrder: field.castOrder,
      member: field.member,
      memberChunkId: field.memberChunkId,
      textChunkPath: field.textChunkPath,
      states
    });
  }

  const assets = [...assetsByKey.values()].sort((left, right) => {
    if (left.castOrder !== right.castOrder) {
      return left.castOrder - right.castOrder;
    }
    return left.member - right.member;
  });

  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    sourceId: graphRelease.sourceId,
    elementCount: elements.length,
    assetCount: assets.length,
    unsupportedCount: unsupported.length,
    sourceMissingCount: sourceMissing.length,
    elements,
    assets,
    sourceMissing,
    unsupported
  };
}

function parseButtonElementStates(field) {
  return findTopLevelPropertyLists(field.text)
    .map((raw) => {
      const state = /#state:\s*#?([a-z0-9_]+)/i.exec(raw)?.[1];
      if (!state) {
        return undefined;
      }

      return {
        state,
        members: {
          left: parseButtonPart(raw, "left"),
          middle: parseButtonPart(raw, "middle"),
          right: parseButtonPart(raw, "right"),
          top: parseButtonPart(raw, "top"),
          bar: parseButtonPart(raw, "bar"),
          lift: parseButtonPart(raw, "lift"),
          bottom: parseButtonPart(raw, "bottom")
        },
        text: parseButtonTextSpec(raw)
      };
    })
    .filter(Boolean);
}

function parseButtonPart(raw, partName) {
  const match = new RegExp(`#${partName}:\\s*\\[([^\\]]+)\\]`, "i").exec(raw);
  if (!match) {
    return undefined;
  }

  const body = match[1] ?? "";
  const memberName = /#member:\s*"([^"]+)"/i.exec(body)?.[1];
  if (!memberName) {
    return undefined;
  }

  return {
    memberName,
    cast: numberFromMatch(/#cast:\s*(-?\d+)/i.exec(body)),
    flipH: truthyLingoValue(/#flipH:\s*([^,\]]+)/i.exec(body)?.[1]),
    flipV: truthyLingoValue(/#flipV:\s*([^,\]]+)/i.exec(body)?.[1]),
    rotate: numberFromMatch(/#rotate:\s*(-?\d+)/i.exec(body))
  };
}

function parseButtonTextSpec(raw) {
  const match = /#text:\s*\[([^\]]+)\]/i.exec(raw);
  const body = match?.[1] ?? "";
  return {
    font: stringFromMatch(/#font:\s*"([^"]+)"/i.exec(body)) ?? "vb",
    fontSize: numberFromMatch(/#fontSize:\s*(-?\d+)/i.exec(body)) ?? 9,
    fontStyle: stringFromMatch(/#fontStyle:\s*"?#?([^",\]]+)/i.exec(body)) ?? "plain",
    alignment: stringFromMatch(/#alignment:\s*#?([^,\]]+)/i.exec(body)) ?? "center",
    color: stringFromMatch(/#color:\s*"([^"]+)"/i.exec(body)) ?? "#000000",
    bgColor: stringFromMatch(/#bgColor:\s*"([^"]+)"/i.exec(body)) ?? "#FFFFFF",
    boxType: stringFromMatch(/#boxType:\s*#?([^,\]]+)/i.exec(body)) ?? "adjust",
    marginH: numberFromMatch(/#marginH:\s*(-?\d+)/i.exec(body)) ?? 0,
    marginV: numberFromMatch(/#marginV:\s*(-?\d+)/i.exec(body)) ?? 0,
    marginBottom: numberFromMatch(/#marginBottom:\s*(-?\d+)/i.exec(body)) ?? 0
  };
}

function findTopLevelPropertyLists(text) {
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

  return lists.filter((entry) => entry.includes("#state:"));
}

function buildMemberNameIndex(graphRelease) {
  const index = new Map();
  for (const cast of graphRelease.casts) {
    if (!cast.resolved) {
      continue;
    }

    for (const member of cast.members) {
      if (!member.name) {
        continue;
      }

      const key = normalizeName(member.name);
      const matches = index.get(key) ?? [];
      matches.push({
        castName: cast.name,
        castOrder: cast.order,
        extractionRoot: cast.expectedExtractionRoot,
        member: member.number,
        memberChunkId: member.memberChunkId,
        memberName: member.name,
        memberType: member.type
      });
      index.set(key, matches);
    }
  }
  return index;
}

function resolveButtonPartMember(membersByName, preferredCastName, memberName) {
  const matches = membersByName.get(normalizeName(memberName)) ?? [];
  return matches.find((match) => match.castName === preferredCastName && match.memberType === "bitmap")
    ?? matches.find((match) => match.memberType === "bitmap")
    ?? undefined;
}

function decodeButtonBitmap(graphCastsByName, graphRelease, field, match, unsupported) {
  const cast = graphCastsByName.get(normalizeName(match.castName));
  if (!cast) {
    unsupported.push({
      elementName: field.memberName,
      memberName: match.memberName,
      reason: `cast ${match.castName} did not resolve`
    });
    return undefined;
  }

  const chunksRoot = path.resolve(match.extractionRoot, "chunks");
  const memberChunkPath = path.join(chunksRoot, `CASt-${match.memberChunkId}.bin`);
  const bitmap = readBitmapAssetMetadata(chunksRoot, memberChunkPath, match.memberChunkId);
  if (![1, 2, 4, 8, 16, 32].includes(bitmap.bitDepth)) {
    unsupported.push({
      elementName: field.memberName,
      memberName: match.memberName,
      reason: `bitmap bit depth ${bitmap.bitDepth} is not decoded by this extractor`
    });
    return undefined;
  }

  if (!bitmap.bitdPath || !existsSync(path.resolve(bitmap.bitdPath))) {
    unsupported.push({
      elementName: field.memberName,
      memberName: match.memberName,
      reason: "BITD path is missing"
    });
    return undefined;
  }

  const palette = bitmap.bitDepth <= 8
    ? resolvePalette(graphCastsByName, match.castName, "interface palette", bitmap.paletteId)
    : undefined;
  if (bitmap.bitDepth <= 8 && !palette) {
    unsupported.push({
      elementName: field.memberName,
      memberName: match.memberName,
      reason: `palette ${bitmap.paletteId} did not resolve`
    });
    return undefined;
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const pitch = bitmap.pitch > 0 ? bitmap.pitch : Math.ceil(width * bitmap.bitDepth / 8);
  const bitdPath = path.resolve(bitmap.bitdPath);
  const source = readFileSync(bitdPath);
  const expectedSourceBytes = pitch * height;
  const isPackBitsCompressed = source.length < expectedSourceBytes;
  const decodedSource = isPackBitsCompressed ? decompressPackBits(source, expectedSourceBytes) : source.subarray(0, expectedSourceBytes);
  const paletteIndices = Buffer.alloc(width * height);
  const rgba = Buffer.alloc(width * height * 4);

  if (bitmap.bitDepth === 32) {
    decode32BitRgba(decodedSource, rgba, width, height, pitch, bitmap.useAlpha, isPackBitsCompressed);
  } else if (bitmap.bitDepth === 16) {
    decode16BitRgb555(decodedSource, rgba, width, height, isPackBitsCompressed);
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const paletteIndex = readPaletteIndex(decodedSource, bitmap.bitDepth, pitch, x, y);
        paletteIndices[y * width + x] = paletteIndex;
        const color = palette.colors[paletteIndex] ?? { r: 0, g: 0, b: 0 };
        const destIndex = (y * width + x) * 4;
        rgba[destIndex] = color.r;
        rgba[destIndex + 1] = color.g;
        rgba[destIndex + 2] = color.b;
        rgba[destIndex + 3] = 255;
      }
    }
  }

  const assetDir = path.join(assetRoot, graphRelease.versionId, match.castName);
  mkdirSync(assetDir, { recursive: true });
  const pngPath = path.join(assetDir, `${pad(match.member, 3)}-${slugify(match.memberName)}.png`);
  writePng(pngPath, width, height, rgba);
  const ink36PngPath = bitmap.bitDepth <= 8 ? path.join(assetDir, `${pad(match.member, 3)}-${slugify(match.memberName)}-ink36.png`) : undefined;
  if (ink36PngPath) {
    writePng(ink36PngPath, width, height, applyPaletteIndexColorKey(rgba, paletteIndices, 0));
  }
  const ink8PngPath = bitmap.bitDepth <= 8 ? path.join(assetDir, `${pad(match.member, 3)}-${slugify(match.memberName)}-ink8.png`) : undefined;
  if (ink8PngPath) {
    writePng(ink8PngPath, width, height, applyExactWhiteMatteCoverage(rgba));
  }

  return {
    id: `${graphRelease.versionId}:${match.castName}:${match.member}`,
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    castName: match.castName,
    castOrder: match.castOrder,
    member: match.member,
    memberChunkId: match.memberChunkId,
    memberName: match.memberName,
    mediaType: "bitmap",
    pixelFormat: "rgba8888",
    alphaPolicy: bitmap.bitDepth === 32 && bitmap.useAlpha ? "native-32-bit-alpha" : "opaque-source-colors-director-ink-applies-later",
    width,
    height,
    bitDepth: bitmap.bitDepth,
    pitch,
    regPoint: bitmap.regPoint,
    initialRect: bitmap.initialRect,
    sourceBitdPath: bitmap.bitdPath,
    sourceBitdBytes: statSync(bitdPath).size,
    sourceMemberChunkPath: relative(memberChunkPath),
    paletteName: palette?.name ?? `direct${bitmap.bitDepth}`,
    paletteCastName: palette?.castName ?? `direct${bitmap.bitDepth}`,
    paletteMember: palette?.member ?? 0,
    paletteChunkPath: palette?.chunkPath ?? "",
    paletteColorCount: palette?.colors.length ?? 0,
    pngPath: assetRelative(pngPath),
    pngBytes: statSync(pngPath).size,
    ...(bitmap.bitDepth <= 8 && palette ? { paletteColors: palette.colors.map(rgbInt) } : {}),
    ...(bitmap.bitDepth <= 8 ? { paletteIndexData: paletteIndices.toString("base64") } : {}),
    ...(ink36PngPath && ink8PngPath ? { inkAssetPaths: {
      "36": assetRelative(ink36PngPath),
      "8": assetRelative(ink8PngPath)
    } } : {}),
    ...(ink36PngPath ? { ink36PngBytes: statSync(ink36PngPath).size } : {}),
    ...(ink36PngPath ? { ink36AlphaPolicy: "palette-index-0-transparent" } : {}),
    ...(ink8PngPath ? { ink8PngBytes: statSync(ink8PngPath).size } : {}),
    ...(ink8PngPath ? { ink8AlphaPolicy: "exact-white-transparent" } : {})
  };
}

function readBitmapAssetMetadata(chunksRoot, memberChunkPath, memberChunkId) {
  const parsed = parseBitmapInfo(memberChunkPath);
  const bitmap = parsed.bitDepth > 0 ? parsed : (recoverBitmapMetadataFromCastOrder(chunksRoot, memberChunkId) ?? parsed);
  const bitdSource = resolveBitmapBitdSource(chunksRoot, memberChunkId, bitmap);
  const bitdPath = bitdSource?.bitdPath;

  return {
    ...bitmap,
    ...(typeof bitdSource?.sectionID === "number"
      ? {
          bitdSectionId: bitdSource.sectionID,
          bitdPath: relative(bitdPath),
          bitdExists: bitdSource.bitdExists,
          bitdBytes: bitdSource.bitdBytes,
          bitdSource: bitdSource.kind,
          ...(bitdSource.kind.startsWith("orphan-")
            ? {
                orphanCandidateCount: bitdSource.candidateCount,
                orphanCandidateSectionIds: bitdSource.candidateSectionIds
              }
            : {})
        }
      : {
          bitdExists: false,
          bitdBytes: 0,
          ...(bitdSource?.kind === "orphan-ambiguous"
            ? {
                bitdSource: bitdSource.kind,
                orphanCandidateCount: bitdSource.candidateCount,
                orphanCandidateSectionIds: bitdSource.candidateSectionIds
              }
            : {})
        })
  };
}

function parseBitmapInfo(memberChunkPath) {
  if (!existsSync(memberChunkPath)) {
    return zeroBitmapMetadata("missing-cast-member-chunk");
  }

  const chunk = readFileSync(memberChunkPath);
  if (chunk.length < 12) {
    throw new Error(`CASt chunk is too short: ${relative(memberChunkPath)}`);
  }

  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (chunk.length < offset + specificDataLen || specificDataLen < 10) {
    return zeroBitmapMetadata("cast-member-specific-data-too-short");
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

function zeroBitmapMetadata(metadataSource) {
  return {
    metadataSource,
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

function resolvePalette(graphCastsByName, preferredCastName, paletteName, paletteId) {
  const builtIn = resolveBuiltInPalette(paletteName, paletteId);
  if (builtIn) {
    return builtIn;
  }

  const casts = [...graphCastsByName.values()].filter((cast) => cast.resolved);
  const preferredCasts = [
    ...casts.filter((cast) => cast.name === preferredCastName),
    ...casts.filter((cast) => cast.name !== preferredCastName)
  ];

  if (paletteName) {
    const normalized = normalizeName(paletteName);
    for (const cast of preferredCasts) {
      const member = cast.members.find((entry) => entry.type === "palette" && normalizeName(entry.name ?? "") === normalized);
      if (member) {
        return readPalette(cast, member);
      }
    }
    return undefined;
  }

  // Numeric CASt palette references are resolved by
  // director-palette-reference.mjs in the bitmap materializers. Button parts
  // reach this path with an explicit source-authored palette name only.
  if (typeof paletteId === "number" && paletteId >= 0) {
    return undefined;
  }

  return undefined;
}

function resolveBuiltInPalette(paletteName, paletteId) {
  const normalized = normalizeName(paletteName ?? "");
  if (normalized === "systemmac" || paletteId === -1) {
    return {
      castName: "builtin",
      member: 0,
      memberChunkId: 0,
      name: "systemMac",
      sectionId: 0,
      chunkPath: "builtin/systemMac",
      colors: createSystemMacPalette()
    };
  }

  if (normalized === "grayscale" || paletteId === -3) {
    return {
      castName: "builtin",
      member: 0,
      memberChunkId: 0,
      name: "grayscale",
      sectionId: 0,
      chunkPath: "builtin/grayscale",
      colors: createGrayscalePalette()
    };
  }

  return undefined;
}

function readPalette(cast, member) {
  const chunksRoot = path.resolve(cast.expectedExtractionRoot, "chunks");
  const clutEntry = readDirectorKeyEntries(chunksRoot).find(
    (entry) => entry.castID === member.memberChunkId && entry.fourCC === "CLUT",
  );
  if (!clutEntry) {
    return undefined;
  }

  const chunkPath = path.join(chunksRoot, `CLUT-${clutEntry.sectionID}.bin`);
  if (!existsSync(chunkPath)) {
    return undefined;
  }

  const bytes = readFileSync(chunkPath);
  const colors = [];
  for (let offset = 0; offset + 5 < bytes.length; offset += 6) {
    colors.push({
      r: toByte(bytes.readUInt16BE(offset)),
      g: toByte(bytes.readUInt16BE(offset + 2)),
      b: toByte(bytes.readUInt16BE(offset + 4))
    });
  }

  return {
    castName: cast.name,
    member: member.number,
    memberChunkId: member.memberChunkId,
    name: member.name,
    sectionId: clutEntry.sectionID,
    chunkPath: relative(chunkPath),
    colors
  };
}

function createSystemMacPalette() {
  const colors = [];
  const cube = [255, 204, 153, 102, 51, 0];
  for (const r of cube) {
    for (const g of cube) {
      for (const b of cube) {
        if (r === 0 && g === 0 && b === 0) {
          continue;
        }
        colors.push({ r, g, b });
      }
    }
  }

  const ramps = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const r of ramps) {
    colors.push({ r, g: 0, b: 0 });
  }
  for (const g of ramps) {
    colors.push({ r: 0, g, b: 0 });
  }
  for (const b of ramps) {
    colors.push({ r: 0, g: 0, b });
  }
  for (const value of ramps) {
    colors.push({ r: value, g: value, b: value });
  }
  colors.push({ r: 0, g: 0, b: 0 });
  return colors;
}

function createGrayscalePalette() {
  return Array.from({ length: 256 }, (_, index) => {
    const value = 255 - index;
    return { r: value, g: value, b: value };
  });
}

function readPaletteIndex(source, bitDepth, pitch, x, y) {
  const rowOffset = y * pitch;
  switch (bitDepth) {
    case 1: {
      const byte = source[rowOffset + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      return bit;
    }
    case 2: {
      const byte = source[rowOffset + (x >> 2)] ?? 0;
      const value = (byte >> (6 - ((x & 3) * 2))) & 0x03;
      return value;
    }
    case 4: {
      const byte = source[rowOffset + (x >> 1)] ?? 0;
      const value = (x & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
      return value;
    }
    case 8:
      return source[rowOffset + x] ?? 0;
    default:
      return 0;
  }
}

function decode32BitRgba(source, rgba, width, height, pitch, useAlpha, isPackBitsCompressed) {
  if (isPackBitsCompressed) {
    for (let offset = 0; offset + 3 < source.length && offset < rgba.length; offset += 4) {
      rgba[offset] = source[offset + 1] ?? 0;
      rgba[offset + 1] = source[offset + 2] ?? 0;
      rgba[offset + 2] = source[offset + 3] ?? 0;
      rgba[offset + 3] = useAlpha ? (source[offset] ?? 255) : 255;
    }
    return;
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * pitch;
    for (let x = 0; x < width; x++) {
      const src = rowOffset + x * 4;
      const dest = (y * width + x) * 4;
      rgba[dest] = source[src + 1] ?? 0;
      rgba[dest + 1] = source[src + 2] ?? 0;
      rgba[dest + 2] = source[src + 3] ?? 0;
      rgba[dest + 3] = useAlpha ? (source[src] ?? 255) : 255;
    }
  }
}

function decode16BitRgb555(source, rgba, width, height, isPackBitsCompressed) {
  const pixelCount = width * height;
  if (isPackBitsCompressed) {
    for (let index = 0; index < pixelCount; index++) {
      const high = source[index] ?? 0;
      const low = source[index + pixelCount] ?? 0;
      writeRgb555(rgba, index, (high << 8) | low);
    }
    return;
  }

  for (let index = 0; index < pixelCount; index++) {
    writeRgb555(rgba, index, source.readUInt16BE(index * 2));
  }
}

function writeRgb555(rgba, pixelIndex, value) {
  const dest = pixelIndex * 4;
  rgba[dest] = expand5Bit((value >> 10) & 0x1f);
  rgba[dest + 1] = expand5Bit((value >> 5) & 0x1f);
  rgba[dest + 2] = expand5Bit(value & 0x1f);
  rgba[dest + 3] = 255;
}

function expand5Bit(value) {
  return (value << 3) | (value >> 2);
}

function applyPaletteIndexColorKey(rgba, paletteIndices, transparentIndex) {
  const output = Buffer.from(rgba);
  for (let index = 0; index < paletteIndices.length; index++) {
    if (paletteIndices[index] === transparentIndex) {
      output[index * 4 + 3] = 0;
    }
  }
  return output;
}

function applyExactWhiteMatteCoverage(rgba) {
  const output = Buffer.from(rgba);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] === 0) continue;
    if (output[offset] === 255 && output[offset + 1] === 255 && output[offset + 2] === 255) {
      output[offset + 3] = 0;
    } else {
      output[offset + 3] = 255;
    }
  }

  return output;
}

function writePng(filePath, width, height, rgba) {
  const bytes = encodePngRgba(width, height, rgba);
  writeFileSync(filePath, bytes);
  artifactProgress.record(bytes.length);
}

function encodePngRgba(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function decompressPackBits(source, expectedBytes) {
  const output = Buffer.alloc(expectedBytes);
  let sourceOffset = 0;
  let outputOffset = 0;

  while (sourceOffset < source.length && outputOffset < expectedBytes) {
    const control = source[sourceOffset++];
    if (control <= 127) {
      const count = control + 1;
      for (let index = 0; index < count && outputOffset < expectedBytes && sourceOffset < source.length; index++) {
        output[outputOffset++] = source[sourceOffset++];
      }
    } else if (control === 128) {
      continue;
    } else {
      const count = 257 - control;
      const value = source[sourceOffset++] ?? 0;
      for (let index = 0; index < count && outputOffset < expectedBytes; index++) {
        output[outputOffset++] = value;
      }
    }
  }

  return output;
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

function normalizeName(value) {
  return String(value).toLowerCase();
}

function numberFromMatch(match) {
  return match ? Number(match[1]) : undefined;
}

function truthyLingoValue(value) {
  if (value === undefined) {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "#true";
}

function stringFromMatch(match) {
  return match?.[1]?.trim();
}

function toByte(value) {
  return Math.max(0, Math.min(255, Math.round(value / 257)));
}

function rgbInt(color) {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}

function assetRelative(filePath) {
  return path.relative(assetPathBase, filePath).replaceAll(path.sep, "/");
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--version") {
      parsed.version = argv[++index];
    } else if (arg === "--external-cast-graph") {
      parsed.externalCastGraph = argv[++index];
    } else if (arg === "--external-cast-text-fields") {
      parsed.externalCastTextFields = argv[++index];
    } else if (arg === "--out") {
      parsed.out = argv[++index];
    } else if (arg === "--asset-root") {
      parsed.assetRoot = argv[++index];
    } else if (arg === "--asset-path-base") {
      parsed.assetPathBase = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}
