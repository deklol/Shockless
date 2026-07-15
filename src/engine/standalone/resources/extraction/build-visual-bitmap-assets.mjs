#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recoverBitmapMetadataFromCastOrder, resolveBitmapBitdSource } from "./director-bitd-recovery.mjs";
import { decodeDirectorJpegMedia, resolveDirectorBitmapMediaSource } from "./director-bitmap-media.mjs";
import { createDirectorBuiltInPalette } from "./director-built-in-palettes.mjs";
import { paletteProvenance, resolveDirectorBitmapPalette } from "./director-palette-reference.mjs";
import { createArtifactProgress } from "./import-progress.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const configPath = path.join(repoRoot, "engine.config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const version = normalizeVersion(args.version ?? "release306");
const sourceRoot = path.resolve(args.sourceRoot ?? config.originsSourceRoot ?? ".");
const runtimeDataRoot = path.resolve(args.runtimeDataRoot ?? config.runtimeDataRoot ?? ".");
const outPath = path.resolve(args.out ?? path.join(repoRoot, "generated/runtime-data", `visual-bitmap-assets.${version}.json`));
const assetRoot = path.resolve(args.assetRoot ?? path.join(repoRoot, "generated/assets/visual-bitmaps"));
const assetPathBase = path.resolve(args.assetPathBase ?? (args.assetRoot ? assetRoot : repoRoot));
const visualFilters = new Set((args.visuals ?? []).map(normalizeName));
const artifactProgress = createArtifactProgress("visual-bitmaps");
const MAX_PLAUSIBLE_KEY_ID = 0x00ffffff;
const KNOWN_BINARY_KEY_FOURCCS = new Set([
  "ALFA",
  "BITD",
  "CASt",
  "CAS*",
  "CLUT",
  "ediM",
  "KEY*",
  "LctX",
  "Lnam",
  "Lscr",
  "Lctx",
  "STXT",
  "Thum",
  "VWSC",
  "XMED",
  "Xtra",
  "snd ",
  "sndH",
  "sndS",
]);
const DIRECTOR_BUILT_IN_MEMBER_BY_NAME = new Map([
  ["systemmac", -1],
  ["rainbow", -2],
  ["grayscale", -3],
  ["pastels", -4],
  ["vivid", -5],
  ["ntsc", -6],
  ["metallic", -7],
  ["systemwindir4", -101],
  ["systemwin", -102],
]);

const visualIndex = readJson(path.join(runtimeDataRoot, `external-cast-visual-layout-index.${version}.json`));
const castGraph = readJson(path.join(runtimeDataRoot, `external-cast-graph.${version}.json`));
const visualRelease = releaseFor(visualIndex, version);
const graphRelease = releaseFor(castGraph, version);
const graphCastsByName = new Map((graphRelease.casts ?? []).map((cast) => [normalizeName(cast.name), cast]));
const movieManifestPath = path.join(runtimeDataRoot, `${version}-projectorrays-manifest.json`);
const movieManifest = existsSync(movieManifestPath) ? readJson(movieManifestPath) : undefined;
const movieCastsByNumber = new Map((movieManifest?.casts ?? []).map((cast) => [cast.number, cast]));
const decodedByKey = new Map();
const unsupported = [];
const visuals = [];

for (const visual of visualRelease.visuals ?? []) {
  if (visualFilters.size > 0 && !visualFilters.has(normalizeName(visual.visualName ?? visual.memberName))) {
    continue;
  }
  visuals.push(decodeVisual(visual));
}

const release = {
  versionId: visualRelease.versionId ?? version,
  release: visualRelease.release ?? version,
  sourceId: visualRelease.sourceId,
  assetCount: decodedByKey.size,
  unsupportedCount: unsupported.length,
  palettes: collectPalettes(),
  assets: [...decodedByKey.values()].sort((left, right) => left.id.localeCompare(right.id)),
  unsupported,
  visualCount: visuals.length,
  visuals,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/build-visual-bitmap-assets.mjs",
      sourceRoot: repoRelative(sourceRoot),
      runtimeDataRoot: repoRelative(runtimeDataRoot),
      assetRoot: repoRelative(assetRoot),
      ...(visualFilters.size > 0 ? { visualFilters: [...visualFilters].sort() } : {}),
      releases: [release],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const artifactTotals = artifactProgress.finish();

console.log(`Decoded ${decodedByKey.size} ${version} visual bitmap asset(s)`);
console.log(`Wrote ${artifactTotals.outputFiles} PNG file(s), ${artifactTotals.outputBytes} byte(s)`);
console.log(`Unsupported visual bitmap entries: ${unsupported.length}`);
console.log(`Visual bitmap asset index: ${repoRelative(outPath)}`);

function decodeVisual(visual) {
  const bitmapElements = (visual.elements ?? []).filter((element) => element.media === "bitmap" && element.resolvedMember);
  const sourceHints = visualSourceSectionHints(bitmapElements);
  const assetIds = [];
  for (const element of bitmapElements) {
    const logical = element.resolvedMember;
    const variant = bitmapAssetVariantSuffix(element);
    const key = `${normalizeName(logical.castName)}:${logical.member}${variant ? `:${variant}` : ""}`;
    if (!decodedByKey.has(key)) {
      const decoded = decodeElement(visual, element, logical, variant, sourceHints);
      if (decoded) decodedByKey.set(key, decoded);
    }
    const asset = decodedByKey.get(key);
    if (asset) assetIds.push(asset.id);
  }
  return {
    memberName: visual.memberName,
    visualName: visual.visualName,
    textChunkPath: visual.textChunkPath,
    elementCount: visual.elementCount,
    bitmapElementCount: bitmapElements.length,
    assetIds,
  };
}

function decodeElement(visual, element, logical, variant, sourceHints) {
  const source = chooseBitmapSource(logical, element, sourceHints);
  if (!source) {
    unsupported.push(unsupportedEntry(visual, logical, "no same-release BITD source resolved"));
    return undefined;
  }

  const { member, bitmap, palette } = source;
  if (![1, 2, 4, 8, 16, 32].includes(bitmap.bitDepth)) {
    unsupported.push(unsupportedEntry(visual, logical, `bitmap bit depth ${bitmap.bitDepth} is not decoded`));
    return undefined;
  }

  const sourcePath = bitmap.mediaPath ?? bitmap.bitdPath;
  const isJpegMedia = bitmap.mediaFormat === "jpeg";
  if (!sourcePath || !existsSync(sourcePath)) {
    unsupported.push(unsupportedEntry(visual, logical, isJpegMedia ? "ediM media path is missing" : "BITD path is missing"));
    return undefined;
  }

  if (bitmap.bitDepth <= 8 && !palette && !isJpegMedia) {
    unsupported.push(unsupportedEntry(visual, logical, `palette ${element.palette ?? bitmap.paletteId} did not resolve`));
    return undefined;
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const pitch = bitmap.pitch > 0 ? bitmap.pitch : Math.ceil((width * bitmap.bitDepth) / 8);
  const paletteIndices = Buffer.alloc(width * height);
  let rgba = Buffer.alloc(width * height * 4);

  if (isJpegMedia) {
    const decodedJpeg = decodeDirectorJpegMedia(sourcePath, width, height, bitmap.alphaPath);
    if (!decodedJpeg) {
      unsupported.push(unsupportedEntry(visual, logical, "ediM JPEG media did not decode to the bitmap dimensions"));
      return undefined;
    }
    rgba = decodedJpeg;
  } else {
    const sourceBytes = readFileSync(sourcePath);
    const expectedBytes = pitch * height;
    const compressed = sourceBytes.length < expectedBytes;
    const decodedSource = compressed ? decompressPackBits(sourceBytes, expectedBytes) : sourceBytes.subarray(0, expectedBytes);

    if (bitmap.bitDepth === 32) {
      decode32BitRgba(decodedSource, rgba, width, height, pitch, bitmap.useAlpha, compressed);
    } else if (bitmap.bitDepth === 16) {
      decode16BitRgb555(decodedSource, rgba, width, height, compressed);
    } else {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const paletteIndex = readPaletteIndex(decodedSource, bitmap.bitDepth, pitch, x, y);
          paletteIndices[y * width + x] = paletteIndex;
          const color = palette.colors[paletteIndex] ?? { r: 0, g: 0, b: 0 };
          const dest = (y * width + x) * 4;
          rgba[dest] = color.r;
          rgba[dest + 1] = color.g;
          rgba[dest + 2] = color.b;
          rgba[dest + 3] = 255;
        }
      }
    }
  }

  const assetDir = path.join(assetRoot, version, logical.castName);
  const stem = `${pad(logical.member, 3)}-${slugify(logical.memberName)}${variant ? `-${variant}` : ""}`;
  const pngPath = path.join(assetDir, `${stem}.png`);
  mkdirSync(assetDir, { recursive: true });
  writePng(pngPath, width, height, rgba);

  const inkAssetPaths = {};
  const inkMetadata = {};
  if (bitmap.bitDepth <= 8) {
    const ink36PngPath = path.join(assetDir, `${stem}-ink36.png`);
    writePng(ink36PngPath, width, height, applyPaletteIndexColorKey(rgba, paletteIndices, 0));
    inkAssetPaths["36"] = assetRelative(ink36PngPath);
    inkMetadata.ink36PngBytes = statSync(ink36PngPath).size;
    inkMetadata.ink36AlphaPolicy = "palette-index-0-transparent";

    const ink8PngPath = path.join(assetDir, `${stem}-ink8.png`);
    writePng(ink8PngPath, width, height, applyExactWhiteMatteCoverage(rgba));
    inkAssetPaths["8"] = assetRelative(ink8PngPath);
    inkMetadata.ink8PngBytes = statSync(ink8PngPath).size;
    inkMetadata.ink8AlphaPolicy = "exact-white-transparent";
  }

  return {
    id: `${version}:${logical.castName}:${logical.member}${variant ? `:${variant}` : ""}`,
    versionId: version,
    release: visualRelease.release ?? version,
    castName: logical.castName,
    castOrder: logical.castOrder,
    member: logical.member,
    memberChunkId: logical.memberChunkId,
    memberName: logical.memberName,
    mediaType: "bitmap",
    pixelFormat: "rgba8888",
    alphaPolicy: bitmap.bitDepth === 32 && bitmap.useAlpha ? "native-32-bit-alpha" : "opaque-source-colors-director-ink-applies-later",
    width,
    height,
    bitDepth: bitmap.bitDepth,
    pitch,
    regPoint: bitmap.regPoint,
    initialRect: bitmap.initialRect,
    ...(bitmap.bitdPath && bitmap.mediaFormat !== "jpeg" ? { sourceBitdPath: sourceRelative(bitmap.bitdPath), sourceBitdBytes: statSync(bitmap.bitdPath).size } : {}),
    ...(bitmap.mediaPath
      ? {
          sourceMediaPath: sourceRelative(bitmap.mediaPath),
          sourceMediaFourCC: bitmap.mediaFourCC,
          sourceMediaFormat: bitmap.mediaFormat,
          sourceMediaBytes: statSync(bitmap.mediaPath).size,
        }
      : {}),
    ...(bitmap.alphaPath ? { sourceAlphaPath: sourceRelative(bitmap.alphaPath), sourceAlphaBytes: statSync(bitmap.alphaPath).size } : {}),
    sourceMemberChunkPath: sourceRelative(bitmap.memberChunkPath),
    sourceBitmapMember: member.member,
    sourceBitmapMemberChunkId: member.memberChunkId,
    paletteName: palette?.name ?? `direct${bitmap.bitDepth}`,
    ...(variant ? { layoutPaletteName: element.palette } : {}),
    paletteCastName: palette?.castName ?? `direct${bitmap.bitDepth}`,
    paletteMember: palette?.member ?? 0,
    paletteChunkPath: palette?.chunkPath ?? "",
    paletteColorCount: palette?.colors.length ?? 0,
    ...(palette?.paletteProvenance ?? {}),
    ...(palette?.layoutPaletteResolution ? { layoutPaletteResolution: palette.layoutPaletteResolution } : {}),
    ...(palette?.layoutPaletteSourceCast ? { layoutPaletteSourceCast: palette.layoutPaletteSourceCast } : {}),
    ...(Number.isInteger(palette?.layoutPaletteSourceMember) ? { layoutPaletteSourceMember: palette.layoutPaletteSourceMember } : {}),
    ...(palette ? { paletteColors: palette.colors.map(rgbInt) } : {}),
    ...(bitmap.bitDepth <= 8 ? { paletteIndexData: paletteIndices.toString("base64") } : {}),
    pngPath: assetRelative(pngPath),
    pngBytes: statSync(pngPath).size,
    ...(Object.keys(inkAssetPaths).length > 0 ? { inkAssetPaths } : {}),
    ...inkMetadata,
  };
}

function chooseBitmapSource(logical, element, sourceHints) {
  const exact = exactResolvedBitmapSource(logical, element);
  if (exact) return exact;

  const cast = graphCastsByName.get(normalizeName(logical.castName));
  if (!cast) return undefined;

  const candidates = [];
  addCandidate(candidates, cast, logical);
  for (const candidate of element.candidateMembers ?? []) addCandidate(candidates, cast, candidate);
  for (const member of cast.members ?? []) {
    if (member.type === "bitmap" && normalizeName(member.name) === normalizeName(logical.memberName)) {
      addCandidate(candidates, cast, member);
    }
  }

  let viable = collectViableBitmapSources(candidates, logical, element);
  if (viable.length === 0) {
    const visualRecovered = ambiguousVisualSiblingBitmapSource(logical, element, sourceHints);
    if (visualRecovered) return visualRecovered;

    viable = collectViableBitmapSources(orphanBitmapCandidates(cast, logical), logical, element);
  }

  viable.sort((left, right) => right.score - left.score || left.member.member - right.member.member);
  return viable[0];
}

function visualSourceSectionHints(bitmapElements) {
  const hints = [];
  const seen = new Set();
  for (const element of bitmapElements) {
    const logical = element.resolvedMember;
    if (!logical?.castName || typeof logical.memberChunkId !== "number") continue;
    const bitmap = readBitmapMetadata(logical.castName, logical.memberChunkId);
    if (!bitmap?.bitdPath || !bitmap.bitdSectionId || bitmap.bitdSource === "orphan-ambiguous") continue;
    const key = `${normalizeName(logical.castName)}:${logical.member}:${bitmap.bitdSectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      castName: logical.castName,
      member: logical.member,
      memberName: logical.memberName,
      sectionId: bitmap.bitdSectionId,
      tokens: memberNameTokens(logical.memberName),
    });
  }
  return hints;
}

function ambiguousVisualSiblingBitmapSource(logical, element, sourceHints) {
  if (!logical?.castName || typeof logical.memberChunkId !== "number") return undefined;
  const bitmap = readBitmapMetadata(logical.castName, logical.memberChunkId);
  if (bitmap?.bitdSource !== "orphan-ambiguous" || !Array.isArray(bitmap.orphanCandidateSectionIds)) return undefined;
  const chunksRoot = castChunksRoot(logical.castName);
  const relatedHints = relatedVisualSourceHints(logical.memberName, sourceHints);
  if (relatedHints.length === 0) return undefined;

  const ranked = bitmap.orphanCandidateSectionIds
    .map((sectionId) => {
      const bitdPath = path.join(chunksRoot, `BITD-${sectionId}.bin`);
      if (!existsSync(bitdPath)) return undefined;
      return {
        sectionId,
        bitdPath,
        distance: Math.min(...relatedHints.map((hint) => Math.abs(sectionId - hint.sectionId))),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance || left.sectionId - right.sectionId);

  if (ranked.length === 0) return undefined;
  if (ranked.length > 1 && ranked[0].distance === ranked[1].distance) return undefined;

  const palette = bitmap.bitDepth <= 8 ? resolvePalette(logical.castName, element.palette, bitmap) : undefined;
  if (bitmap.bitDepth <= 8 && !palette) return undefined;

  return {
    member: {
      castName: logical.castName,
      castOrder: logical.castOrder,
      member: logical.member,
      memberChunkId: logical.memberChunkId,
      memberName: logical.memberName,
      memberType: logical.memberType,
    },
    bitmap: {
      ...bitmap,
      bitdSectionId: ranked[0].sectionId,
      bitdPath: ranked[0].bitdPath,
      bitdSource: "orphan-visual-sibling-section-proximity",
    },
    palette,
    score: Number.MAX_SAFE_INTEGER - 1,
  };
}

function relatedVisualSourceHints(memberName, sourceHints) {
  const tokens = memberNameTokens(memberName);
  if (tokens.length === 0) return [];
  return sourceHints.filter((hint) => hint.tokens.some((token) => tokens.includes(token)));
}

function memberNameTokens(value) {
  const ignored = new Set([
    "a",
    "an",
    "the",
    "bg",
    "background",
    "front",
    "back",
    "layer",
    "floor",
    "mainfloor",
    "room",
    "color",
    "elements",
    "element",
    "left",
    "right",
    "top",
    "bottom",
    "center",
    "nohotel",
    "hotelonwall",
  ]);
  return [
    ...new Set(
      normalizeName(value)
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !ignored.has(token) && !/^\d+$/.test(token)),
    ),
  ];
}

function exactResolvedBitmapSource(logical, element) {
  const bitmapInfo = logical.bitmap;
  if (!bitmapInfo?.bitdPath) return undefined;

  const bitdPath = resolveExtractedPath(bitmapInfo.bitdPath);
  const memberChunkPath = resolveExtractedPath(logical.memberChunkPath ?? bitmapInfo.memberChunkPath);
  if (!bitdPath || !existsSync(bitdPath)) return undefined;
  if (!memberChunkPath || !existsSync(memberChunkPath)) return undefined;

  const bitmap = {
    width: bitmapInfo.width,
    height: bitmapInfo.height,
    bitDepth: bitmapInfo.bitDepth,
    pitch: bitmapInfo.pitch,
    paletteCastLib: bitmapInfo.paletteCastLib,
    paletteMemberNumber: bitmapInfo.paletteMemberNumber,
    paletteId: bitmapInfo.paletteId,
    regPoint: bitmapInfo.regPoint,
    initialRect: bitmapInfo.initialRect,
    alphaThreshold: bitmapInfo.alphaThreshold,
    useAlpha: bitmapInfo.useAlpha,
    memberChunkPath,
    bitdSectionId: bitmapInfo.bitdSectionId,
    bitdPath,
    bitdSource: bitmapInfo.metadataSource ?? "resolved-visual-member",
  };
  if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0) {
    return undefined;
  }
  if (![1, 2, 4, 8, 16, 32].includes(bitmap.bitDepth)) return undefined;

  const palette = bitmap.bitDepth <= 8 ? resolvePalette(logical.castName, element.palette, bitmap) : undefined;
  if (bitmap.bitDepth <= 8 && !palette) return undefined;

  return {
    member: {
      castName: logical.castName,
      castOrder: logical.castOrder,
      member: logical.member,
      memberChunkId: logical.memberChunkId,
      memberName: logical.memberName,
      memberType: logical.memberType,
    },
    bitmap,
    palette,
    score: Number.MAX_SAFE_INTEGER,
  };
}

function collectViableBitmapSources(candidates, logical, element) {
  const seen = new Set();
  const viable = [];
  for (const member of candidates) {
    const key = `${member.castName}:${member.member}:${member.memberChunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bitmap = readBitmapMetadata(member.castName, member.memberChunkId);
    if (!bitmap || !bitmap.bitdPath || !existsSync(bitmap.bitdPath)) continue;
    if (![1, 2, 4, 8, 16, 32].includes(bitmap.bitDepth)) continue;
    const palette = bitmap.bitDepth <= 8 ? resolvePalette(member.castName, element.palette, bitmap) : undefined;
    viable.push({
      member,
      bitmap,
      palette,
      score: bitmapSourceScore(logical, member, bitmap, element, palette),
    });
  }
  return viable;
}

function orphanBitmapCandidates(cast, logical) {
  const chunksRoot = castChunksRoot(cast.name);
  return readKeyEntries(chunksRoot)
    .filter((entry) => entry.fourCC === "BITD")
    .map((entry) => {
      const memberName = readCastMemberName(path.join(chunksRoot, `CASt-${entry.castID}.json`));
      if (normalizeName(memberName) !== normalizeName(logical.memberName)) return undefined;
      return {
        castName: logical.castName ?? cast.name,
        castOrder: logical.castOrder ?? cast.order,
        member: logical.member,
        memberChunkId: entry.castID,
        memberName,
        memberType: "bitmap",
        orphanBitmapSource: true,
      };
    })
    .filter(Boolean);
}

function addCandidate(candidates, cast, entry) {
  const number = entry.member ?? entry.number;
  const graphMember = (cast.members ?? []).find((member) => member.number === number);
  const memberChunkId = entry.memberChunkId ?? graphMember?.memberChunkId;
  if (typeof number !== "number" || typeof memberChunkId !== "number") return;
  candidates.push({
    castName: entry.castName ?? cast.name,
    castOrder: entry.castOrder ?? cast.order,
    member: number,
    memberChunkId,
    memberName: entry.memberName ?? graphMember?.name,
    memberType: entry.memberType ?? graphMember?.type,
  });
}

function bitmapSourceScore(logical, member, bitmap, element, palette) {
  let score = 0;
  if (member.member === logical.member) score += 100;
  if (normalizeName(member.memberName) === normalizeName(logical.memberName)) score += 30;
  if (bitmap.width === logical.bitmap?.width && bitmap.height === logical.bitmap?.height) score += 20;
  if (palette) score += 20;
  if (typeof element.palette === "string" && element.palette.trim()) score += 10;
  return score;
}

function readBitmapMetadata(castName, memberChunkId) {
  const chunksRoot = castChunksRoot(castName);
  const memberChunkPath = path.join(chunksRoot, `CASt-${memberChunkId}.bin`);
  if (!existsSync(memberChunkPath)) return undefined;
  const parsed = parseBitmapInfo(memberChunkPath);
  const bitmap = parsed.bitDepth > 0 ? parsed : (recoverBitmapMetadataFromCastOrder(chunksRoot, memberChunkId) ?? parsed);
  const bitdSource = resolveBitmapBitdSource(chunksRoot, memberChunkId, bitmap);
  const mediaSource = bitdSource ? undefined : resolveDirectorBitmapMediaSource(chunksRoot, memberChunkId);
  return {
    ...bitmap,
    memberChunkPath,
    bitdSectionId: bitdSource?.sectionID ?? mediaSource?.sectionID,
    bitdPath: bitdSource?.bitdPath ?? mediaSource?.mediaPath,
    bitdSource: bitdSource?.kind ?? mediaSource?.kind,
    ...(mediaSource
      ? {
          mediaPath: mediaSource.mediaPath,
          mediaFourCC: mediaSource.fourCC,
          mediaFormat: mediaSource.format,
          mediaSectionId: mediaSource.sectionID,
          alphaPath: mediaSource.alphaPath,
          alphaSectionId: mediaSource.alphaSectionID,
        }
      : {}),
    ...(bitdSource?.kind === "orphan-ambiguous"
      ? {
          orphanCandidateCount: bitdSource.candidateCount,
          orphanCandidateSectionIds: bitdSource.candidateSectionIds,
        }
      : {}),
  };
}


function parseBitmapInfo(memberChunkPath) {
  const chunk = readFileSync(memberChunkPath);
  if (chunk.length < 12) return zeroBitmapMetadata();
  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (chunk.length < offset + specificDataLen || specificDataLen < 10) return zeroBitmapMetadata();

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
    width: right - left,
    height: bottom - top,
    bitDepth: hasColorImageFlag && data.length > 23 ? data.readUInt8(23) : 1,
    pitch: rawPitch & 0x3fff,
    paletteCastLib: hasColorImageFlag && data.length >= 26 ? data.readInt16BE(24) : 0,
    paletteMemberNumber: hasColorImageFlag && data.length >= 28 ? data.readInt16BE(26) : 0,
    paletteId: hasColorImageFlag && data.length >= 28 ? data.readInt16BE(26) - 1 : 0,
    regPoint: { x: regX, y: regY },
    initialRect: { top, left, bottom, right },
    alphaThreshold,
    useAlpha: (updateFlags & 0x10) !== 0,
  };
}

function zeroBitmapMetadata() {
  return {
    width: 0,
    height: 0,
    bitDepth: 0,
    pitch: 0,
    paletteMemberNumber: 0,
    paletteId: 0,
    paletteCastLib: 0,
    regPoint: { x: 0, y: 0 },
    initialRect: { top: 0, left: 0, bottom: 0, right: 0 },
    alphaThreshold: 0,
    useAlpha: false,
  };
}

function resolvePalette(preferredCastName, paletteName, bitmap) {
  const preferredCast = graphCastsByName.get(normalizeName(preferredCastName));
  if (!preferredCast) return undefined;

  const nativeReference = resolveDirectorBitmapPalette({
    sourceCast: preferredCast,
    bitmap,
    movieCastsByNumber,
    readPalette: readExactPaletteForCast,
  });
  const nativePalette = nativeReference.palette
    ? { ...nativeReference.palette, paletteProvenance: paletteProvenance(nativeReference) }
    : undefined;

  if (!paletteName) return nativePalette;

  const builtIn = resolveBuiltInPalette(paletteName);
  if (builtIn) {
    return { ...builtIn, layoutPaletteResolution: "exact-built-in" };
  }

  const casts = orderedPaletteLookupCasts(preferredCastName);

  for (const cast of casts) {
    const byGraph = findGraphPalette(cast, paletteName, undefined);
    if (byGraph) return { ...byGraph, layoutPaletteResolution: "exact-palette-member" };
    const recovered = findChunkPalette(cast, paletteName);
    if (recovered) return { ...recovered, layoutPaletteResolution: "exact-palette-member" };
    const bitmapPalette = findBitmapMemberPalette(cast, paletteName);
    if (bitmapPalette) return bitmapPalette;
  }

  // The layout assignment is executed later by Lingo. A missing member name
  // cannot make the source bitmap undecodable; Director still has the
  // bitmap's authored CASt palette before that runtime assignment occurs.
  return nativePalette
    ? { ...nativePalette, layoutPaletteResolution: "runtime-unresolved-member" }
    : undefined;
}

function orderedPaletteLookupCasts(preferredCastName) {
  const preferred = normalizeName(preferredCastName);
  return [...graphCastsByName.values()]
    .filter((cast) => cast.resolved)
    .sort((left, right) => {
      const leftPreferred = normalizeName(left.name) === preferred ? 0 : 1;
      const rightPreferred = normalizeName(right.name) === preferred ? 0 : 1;
      return leftPreferred - rightPreferred || Number(left.order ?? 0) - Number(right.order ?? 0);
    });
}

function findBitmapMemberPalette(cast, paletteName) {
  const normalizedPalette = normalizeName(paletteName);
  const member = (cast.members ?? []).find(
    (entry) => entry.type === "bitmap" && normalizeName(entry.name) === normalizedPalette,
  );
  if (!member) return undefined;

  const bitmap = readBitmapMetadata(cast.name, member.memberChunkId);
  if (!bitmap || bitmap.bitDepth > 8) return undefined;
  const reference = resolveDirectorBitmapPalette({
    sourceCast: cast,
    bitmap,
    movieCastsByNumber,
    readPalette: readExactPaletteForCast,
  });
  if (!reference.palette) return undefined;
  return {
    ...reference.palette,
    paletteProvenance: paletteProvenance(reference),
    layoutPaletteResolution: "exact-bitmap-palette",
    layoutPaletteSourceCast: cast.name,
    layoutPaletteSourceMember: member.number,
  };
}

function readExactPaletteForCast(cast, member) {
  const chunksRoot = cast.expectedExtractionRoot
    ? path.resolve(cast.expectedExtractionRoot, "chunks")
    : cast.sourceConfigPath
      ? path.dirname(path.resolve(cast.sourceConfigPath))
      : castChunksRoot(cast.name);
  const clutEntry = readKeyEntries(chunksRoot).find(
    (entry) => entry.castID === member.memberChunkId && entry.fourCC === "CLUT",
  );
  if (!clutEntry) return undefined;
  return readPaletteFromMember(cast.name, member.number, member.memberChunkId, member.name, clutEntry, chunksRoot);
}

function collectPalettes() {
  const palettes = [];
  const seen = new Set();
  for (const cast of graphRelease.casts ?? []) {
    if (!cast.name || !cast.resolved) continue;
    for (const member of cast.members ?? []) {
      if (member.type !== "palette" || typeof member.number !== "number") continue;
      const palette =
        readPaletteFromMember(cast.name, member.number, member.memberChunkId, member.name) ??
        orphanPaletteForMember(cast, member);
      if (!palette) continue;
      const key = `${normalizeName(cast.name)}:${member.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      palettes.push({
        castName: cast.name,
        castOrder: cast.order,
        member: member.number,
        memberChunkId: member.memberChunkId,
        memberName: member.name,
        colorCount: palette.colors.length,
        colors: palette.colors.map(rgbInt),
      });
    }
  }
  return palettes.sort((left, right) => normalizeName(left.castName).localeCompare(normalizeName(right.castName)) || left.member - right.member);
}

function orphanPaletteForMember(cast, member) {
  const chunksRoot = castChunksRoot(cast.name);
  for (const entry of readKeyEntries(chunksRoot).filter((candidate) => candidate.fourCC === "CLUT")) {
    const memberName = readCastMemberName(path.join(chunksRoot, `CASt-${entry.castID}.json`));
    if (normalizeName(memberName) !== normalizeName(member.name)) continue;
    return readPaletteFromMember(cast.name, member.number, entry.castID, member.name, entry);
  }
  return undefined;
}

function rgbInt(color) {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function findGraphPalette(cast, paletteName, paletteId) {
  const normalizedPalette = normalizeName(paletteName);
  const members = cast.members ?? [];
  const byName = normalizedPalette
    ? members.find((entry) => entry.type === "palette" && normalizeName(entry.name) === normalizedPalette)
    : undefined;
  const byNumber = typeof paletteId === "number" && paletteId >= 0
    ? members.find((entry) => entry.type === "palette" && entry.number === paletteId + 1)
    : undefined;

  for (const member of [byName, byNumber]) {
    if (!member) continue;
    const palette = readPaletteFromMember(cast.name, member.number, member.memberChunkId, member.name);
    if (palette) return palette;
  }
  return undefined;
}

function findChunkPalette(cast, paletteName) {
  const normalizedPalette = normalizeName(paletteName);
  if (!normalizedPalette) return undefined;
  const chunksRoot = castChunksRoot(cast.name);
  if (!existsSync(chunksRoot)) return undefined;
  const keyEntries = readKeyEntries(chunksRoot).filter((entry) => entry.fourCC === "CLUT");
  for (const entry of keyEntries) {
    const memberName = readCastMemberName(path.join(chunksRoot, `CASt-${entry.castID}.json`));
    if (normalizeName(memberName) !== normalizedPalette) continue;
    const palette = readPaletteFromMember(cast.name, entry.castID, entry.castID, memberName, entry);
    if (palette) return palette;
  }
  return undefined;
}

function readPaletteFromMember(castName, memberNumber, memberChunkId, memberName, knownEntry, knownChunksRoot) {
  const chunksRoot = knownChunksRoot ?? castChunksRoot(castName);
  const clutEntry = knownEntry ?? readKeyEntries(chunksRoot).find((entry) => entry.castID === memberChunkId && entry.fourCC === "CLUT");
  if (!clutEntry) return undefined;
  const chunkPath = path.join(chunksRoot, `CLUT-${clutEntry.sectionID}.bin`);
  if (!existsSync(chunkPath)) return undefined;
  const bytes = readFileSync(chunkPath);
  const colors = [];
  for (let offset = 0; offset + 5 < bytes.length; offset += 6) {
    colors.push({
      r: toByte(bytes.readUInt16BE(offset)),
      g: toByte(bytes.readUInt16BE(offset + 2)),
      b: toByte(bytes.readUInt16BE(offset + 4)),
    });
  }
  return {
    castName,
    member: memberNumber,
    memberChunkId,
    name: memberName,
    sectionId: clutEntry.sectionID,
    chunkPath: sourceRelative(chunkPath),
    colors,
  };
}

function readCastMemberName(jsonPath) {
  if (!existsSync(jsonPath)) return "";
  return readJson(jsonPath).info?.name ?? "";
}

function resolveBuiltInPalette(paletteName) {
  const normalized = normalizeName(paletteName);
  const member = DIRECTOR_BUILT_IN_MEMBER_BY_NAME.get(normalized);
  return member === undefined ? undefined : createDirectorBuiltInPalette(member);
}

function readKeyEntries(chunksRoot) {
  if (!existsSync(chunksRoot)) return [];
  const entries = [];
  const seen = new Set();
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^KEY_.*\.json$/i.test(entry)).sort()) {
    try {
      const json = readJson(path.join(chunksRoot, fileName));
      for (const entry of json.entries ?? []) {
        addKeyEntry(entries, seen, Number(entry.sectionID), Number(entry.castID), String(entry.fourCC ?? ""));
      }
    } catch {
      // Some ProjectorRays KEY JSON dumps contain raw escaped control bytes.
      // The binary KEY chunk remains the authoritative source below.
    }
  }
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^KEY_.*\.bin$/i.test(entry)).sort()) {
    readBinaryKeyEntries(path.join(chunksRoot, fileName), entries, seen);
  }
  return entries;
}

function readBinaryKeyEntries(keyPath, entries, seen) {
  const bytes = readFileSync(keyPath);
  for (let offset = 12; offset + 12 <= bytes.length; offset += 12) {
    const fourCC = bytes.subarray(offset + 8, offset + 12).toString("latin1");
    addBinaryKeyEntry(entries, seen, bytes.readUInt32BE(offset), bytes.readUInt32BE(offset + 4), fourCC);
    addBinaryKeyEntry(
      entries,
      seen,
      bytes.readUInt32LE(offset),
      bytes.readUInt32LE(offset + 4),
      reverseFourCC(fourCC),
    );
  }
}

function addKeyEntry(entries, seen, sectionID, castID, fourCC) {
  if (!sectionID || !castID || !fourCC || fourCC === "\x00\x00\x00\x00") return;
  const key = `${sectionID}:${castID}:${fourCC}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push({ sectionID, castID, fourCC });
}

function addBinaryKeyEntry(entries, seen, sectionID, castID, fourCC) {
  if (!isPlausibleKeyId(sectionID) || !isPlausibleKeyId(castID)) return;
  if (!KNOWN_BINARY_KEY_FOURCCS.has(fourCC)) return;
  addKeyEntry(entries, seen, sectionID, castID, fourCC);
}

function isPlausibleKeyId(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_KEY_ID;
}

function reverseFourCC(value) {
  return [...value].reverse().join("");
}

function castChunksRoot(castName) {
  return path.join(sourceRoot, castName, "chunks");
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

function decode32BitRgba(source, rgba, width, height, pitch, useAlpha, compressed) {
  const scanWidth = Math.max(width, Math.floor((pitch * 8) / 32));
  for (let y = 0; y < height; y += 1) {
    const lineOffset = y * pitch;
    for (let x = 0; x < width; x += 1) {
      const dest = (y * width + x) * 4;
      if (compressed) {
        const alphaIndex = lineOffset + x;
        const redIndex = lineOffset + scanWidth + x;
        const greenIndex = lineOffset + scanWidth * 2 + x;
        const blueIndex = lineOffset + scanWidth * 3 + x;
        rgba[dest] = source[redIndex] ?? 0;
        rgba[dest + 1] = source[greenIndex] ?? 0;
        rgba[dest + 2] = source[blueIndex] ?? 0;
        rgba[dest + 3] = useAlpha ? source[alphaIndex] ?? 255 : 255;
      } else {
        const sourceIndex = lineOffset + x * 4;
        rgba[dest] = source[sourceIndex + 1] ?? 0;
        rgba[dest + 1] = source[sourceIndex + 2] ?? 0;
        rgba[dest + 2] = source[sourceIndex + 3] ?? 0;
        rgba[dest + 3] = useAlpha ? source[sourceIndex] ?? 255 : 255;
      }
    }
  }
}

function decode16BitRgb555(source, rgba, width, height, compressed) {
  const rowBytes = width * 2;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const color = compressed
        ? (((source[rowStart + x] ?? 0) << 8) | (source[rowStart + width + x] ?? 0))
        : (((source[rowStart + x * 2] ?? 0) << 8) | (source[rowStart + x * 2 + 1] ?? 0));
      const dest = (y * width + x) * 4;
      rgba[dest] = expand5Bit((color >> 10) & 0x1f);
      rgba[dest + 1] = expand5Bit((color >> 5) & 0x1f);
      rgba[dest + 2] = expand5Bit(color & 0x1f);
      rgba[dest + 3] = 255;
    }
  }
}

function expand5Bit(value) {
  return (value << 3) | (value >> 2);
}

function decompressPackBits(source, expectedBytes) {
  const output = Buffer.alloc(expectedBytes);
  let sourceOffset = 0;
  let outputOffset = 0;
  while (sourceOffset < source.length && outputOffset < expectedBytes) {
    const control = source[sourceOffset++] ?? 0;
    if (control < 0x80) {
      const count = control + 1;
      for (let index = 0; index < count && sourceOffset < source.length && outputOffset < expectedBytes; index += 1) {
        output[outputOffset++] = source[sourceOffset++] ?? 0;
      }
    } else if (control > 0x80) {
      const count = 257 - control;
      const value = source[sourceOffset++] ?? 0;
      for (let index = 0; index < count && outputOffset < expectedBytes; index += 1) {
        output[outputOffset++] = value;
      }
    }
  }
  return output;
}

function applyPaletteIndexColorKey(rgba, paletteIndices, transparentIndex) {
  const output = Buffer.from(rgba);
  for (let index = 0; index < paletteIndices.length; index += 1) {
    if (paletteIndices[index] === transparentIndex) output[index * 4 + 3] = 0;
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
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bitmapAssetVariantSuffix(element) {
  const palette = typeof element.palette === "string" ? element.palette.trim() : "";
  const normalized = normalizeName(palette);
  if (!normalized || normalized === "interface palette" || DIRECTOR_BUILT_IN_MEMBER_BY_NAME.has(normalized)) {
    return "";
  }
  return slugify(palette);
}

function unsupportedEntry(visual, member, reason) {
  return {
    layoutName: visual.visualName ?? visual.memberName,
    memberName: member.memberName,
    member: member.member,
    memberChunkId: member.memberChunkId,
    reason,
  };
}

function releaseFor(data, wantedVersion) {
  const releases = Array.isArray(data.releases) ? data.releases : Object.values(data.releases ?? {});
  const release = releases.find((entry) => entry.versionId === wantedVersion || entry.release === wantedVersion) ?? releases[0];
  if (!release) throw new Error(`No release data found for ${wantedVersion}`);
  return release;
}

function readJson(filePath) {
  const source = readFileSync(filePath, "utf8");
  return JSON.parse(source.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1"));
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function assetRelative(filePath) {
  return path.relative(assetPathBase, filePath).replace(/\\/g, "/");
}

function sourceRelative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function resolveExtractedPath(value) {
  if (!value) return undefined;
  const raw = String(value);
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  candidates.push(path.resolve(process.cwd(), raw));
  candidates.push(path.resolve(repoRoot, raw));
  candidates.push(path.resolve(sourceRoot, raw));
  const normalized = raw.replace(/\\/g, "/");
  const marker = "/projectorrays/";
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) {
    candidates.push(path.resolve(sourceRoot, normalized.slice(markerIndex + marker.length)));
  }
  if (normalized.toLowerCase().startsWith("extracted/projectorrays/")) {
    candidates.push(path.resolve(sourceRoot, normalized.slice("extracted/projectorrays/".length)));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeVersion(value) {
  const text = String(value);
  return /^release/i.test(text) ? text : `release${text}`;
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-z0-9_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function toByte(value) {
  return Math.max(0, Math.min(255, Math.round(value / 257)));
}

function parseArgs(rawArgs) {
  const parsed = { visuals: [] };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--version":
        parsed.version = requireNext(rawArgs, ++index, arg);
        break;
      case "--source-root":
        parsed.sourceRoot = requireNext(rawArgs, ++index, arg);
        break;
      case "--runtime-data-root":
        parsed.runtimeDataRoot = requireNext(rawArgs, ++index, arg);
        break;
      case "--asset-root":
        parsed.assetRoot = requireNext(rawArgs, ++index, arg);
        break;
      case "--asset-path-base":
        parsed.assetPathBase = requireNext(rawArgs, ++index, arg);
        break;
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--visual":
      case "--only-visual":
        parsed.visuals.push(requireNext(rawArgs, ++index, arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireNext(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}
