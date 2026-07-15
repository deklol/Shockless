#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readDirectorKeyEntries, recoverBitmapMetadataFromCastOrder, resolveBitmapBitdSource } from "./director-bitd-recovery.mjs";
import { decodeDirectorJpegMedia, resolveDirectorBitmapMediaSource } from "./director-bitmap-media.mjs";
import { createDirectorSystemWinPalette } from "./director-built-in-palettes.mjs";
import { paletteProvenance, resolveDirectorBitmapPalette } from "./director-palette-reference.mjs";
import { createArtifactProgress } from "./import-progress.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const externalCastGraphPath = path.resolve(args.externalCastGraph ?? "generated/runtime-data/external-cast-graph.json");
const outputPath = path.resolve(args.out ?? "generated/runtime-data/external-bitmap-assets.json");
const assetRoot = path.resolve(args.assetRoot ?? "generated/assets/external-bitmaps");
const assetPathBase = path.resolve(args.assetPathBase ?? (args.assetRoot ? assetRoot : projectRoot));
const castFilters = new Set(args.casts.map(normalizeName));
const memberFilters = new Set(args.members.map(normalizeName));
const movieManifestPath = args.movieManifest ? path.resolve(args.movieManifest) : undefined;
const artifactProgress = createArtifactProgress("external-bitmaps");

if (!existsSync(externalCastGraphPath)) {
  throw new Error(`External cast graph not found: ${relative(externalCastGraphPath)}`);
}

const externalCastGraph = JSON.parse(readFileSync(externalCastGraphPath, "utf8"));
const movieManifest = movieManifestPath && existsSync(movieManifestPath)
  ? JSON.parse(readFileSync(movieManifestPath, "utf8"))
  : undefined;
const movieCastsByNumber = new Map((movieManifest?.casts ?? []).map((cast) => [cast.number, cast]));
const releases = [];

for (const graphRelease of externalCastGraph.releases) {
  if (args.version && graphRelease.versionId !== args.version) {
    continue;
  }

  releases.push(decodeRelease(graphRelease));
}

if (releases.length === 0) {
  throw new Error(`No external bitmap release matched version filter: ${args.version}`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/decode-external-cast-bitmaps.mjs",
      externalCastGraphPath: relative(externalCastGraphPath),
      assetRoot: assetRelative(assetRoot),
      releases
    },
    null,
    2
  )}\n`,
  "utf8"
);

const artifactTotals = artifactProgress.finish();

console.log(`Decoded external bitmap assets for ${releases.length} release(s)`);
console.log(`Wrote ${artifactTotals.outputFiles} PNG file(s), ${artifactTotals.outputBytes} byte(s)`);
console.log(`External bitmap asset index: ${relative(outputPath)}`);

function decodeRelease(graphRelease) {
  const graphCastsByName = new Map(graphRelease.casts.map((cast) => [normalizeName(cast.name), cast]));
  const assets = [];
  const palettes = [];
  const unsupported = [];
  const sourceEmpty = [];

  for (const cast of graphRelease.casts) {
    if (!cast.resolved || (castFilters.size > 0 && !castFilters.has(normalizeName(cast.name)))) {
      continue;
    }

    for (const palette of readCastPalettes(cast)) {
      palettes.push(serializedPaletteRecord(cast, palette));
    }

    for (const member of cast.members) {
      if (member.type !== "bitmap") {
        continue;
      }
      if (memberFilters.size > 0 && !memberFilters.has(normalizeName(member.name ?? fallbackMemberName(member)))) {
        continue;
      }

      const asset = decodeBitmap(graphCastsByName, graphRelease, cast, member, unsupported, sourceEmpty);
      if (asset) {
        assets.push(asset);
      }
    }
  }

  assets.sort((left, right) => {
    if (left.castOrder !== right.castOrder) {
      return left.castOrder - right.castOrder;
    }
    return left.member - right.member;
  });

  return {
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    sourceId: graphRelease.sourceId,
    castCount: new Set(assets.map((asset) => asset.castName)).size,
    assetCount: assets.length,
    sourceEmptyCount: sourceEmpty.length,
    unsupportedCount: unsupported.length,
    assets,
    palettes,
    sourceEmpty,
    unsupported
  };
}

function readCastPalettes(cast) {
  const palettes = [];
  const seen = new Set();
  for (const member of cast.members) {
    if (member.type !== "palette") continue;
    const palette = readPalette(cast, member);
    if (!palette) continue;
    const key = `${normalizeName(palette.castName)}:${palette.member}:${normalizeName(palette.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    palettes.push(palette);
  }
  return palettes;
}

function serializedPaletteRecord(cast, palette) {
  return {
    castName: palette.castName,
    castOrder: cast.order,
    member: palette.member,
    memberChunkId: palette.memberChunkId,
    memberName: palette.name,
    name: palette.name,
    colorCount: palette.colors.length,
    colors: palette.colors.map(rgbInt),
    sectionId: palette.sectionId,
    chunkPath: palette.chunkPath,
  };
}

function decodeBitmap(graphCastsByName, graphRelease, cast, member, unsupported, sourceEmpty) {
  const chunksRoot = path.resolve(cast.expectedExtractionRoot, "chunks");
  const memberChunkPath = path.join(chunksRoot, `CASt-${member.memberChunkId}.bin`);
  const bitmap = readBitmapAssetMetadata(chunksRoot, memberChunkPath, member.memberChunkId);
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    sourceEmpty.push(bitmapDiagnostic(cast, member, bitmap, "source-authored-empty-bitmap"));
    return undefined;
  }
  if (![1, 2, 4, 8, 16, 32].includes(bitmap.bitDepth)) {
    unsupported.push(bitmapDiagnostic(cast, member, bitmap, `bitmap bit depth ${bitmap.bitDepth} is not decoded by this extractor`));
    return undefined;
  }

  const hasBitd = Boolean(bitmap.bitdPath && existsSync(path.resolve(bitmap.bitdPath)));
  const hasMedia = Boolean(bitmap.mediaPath && existsSync(path.resolve(bitmap.mediaPath)));
  if (!hasBitd && !hasMedia) {
    unsupported.push(bitmapDiagnostic(cast, member, bitmap, "Director bitmap media path is missing"));
    return undefined;
  }

  const indexedSource = hasBitd && bitmap.bitDepth <= 8;
  const paletteReference = indexedSource
    ? resolveDirectorBitmapPalette({
        sourceCast: cast,
        bitmap,
        movieCastsByNumber,
        readPalette: readExactPalette,
      })
    : undefined;
  const palette = paletteReference?.palette;
  if (indexedSource && !palette) {
    unsupported.push(bitmapDiagnostic(
      cast,
      member,
      bitmap,
      `palette castLib=${bitmap.paletteCastLib} member=${bitmap.paletteMemberNumber} did not resolve (${paletteReference?.resolution ?? "unknown"})`,
    ));
    return undefined;
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const pitch = bitmap.pitch > 0 ? bitmap.pitch : Math.ceil(width * bitmap.bitDepth / 8);
  const sourcePath = path.resolve(bitmap.mediaPath ?? bitmap.bitdPath);
  const source = readFileSync(sourcePath);
  const paletteIndices = Buffer.alloc(width * height);
  let rgba;

  if (bitmap.mediaFormat === "jpeg") {
    rgba = decodeDirectorJpegMedia(sourcePath, width, height, bitmap.alphaPath);
    if (!rgba) {
      unsupported.push(bitmapDiagnostic(cast, member, bitmap, "Director ediM JPEG media did not decode at the authored dimensions"));
      return undefined;
    }
  } else {
    const expectedSourceBytes = pitch * height;
    const isPackBitsCompressed = source.length < expectedSourceBytes;
    const decodedSource = isPackBitsCompressed ? decompressPackBits(source, expectedSourceBytes) : source.subarray(0, expectedSourceBytes);
    rgba = Buffer.alloc(width * height * 4);
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
  }

  const assetDir = path.join(assetRoot, graphRelease.versionId, cast.name);
  mkdirSync(assetDir, { recursive: true });
  const pngPath = path.join(assetDir, `${pad(member.number, 4)}-${slugify(member.name ?? fallbackMemberName(member))}.png`);
  writePng(pngPath, width, height, rgba);
  const ink36PngPath = indexedSource ? path.join(assetDir, `${pad(member.number, 4)}-${slugify(member.name ?? fallbackMemberName(member))}-ink36.png`) : undefined;
  if (ink36PngPath) {
    writePng(ink36PngPath, width, height, applyPaletteIndexColorKey(rgba, paletteIndices, 0));
  }
  const ink8PngPath = indexedSource ? path.join(assetDir, `${pad(member.number, 4)}-${slugify(member.name ?? fallbackMemberName(member))}-ink8.png`) : undefined;
  if (ink8PngPath) {
    writePng(ink8PngPath, width, height, applyExactWhiteMatteCoverage(rgba));
  }
  const paletteRemapAssetPaths = !indexedSource
    ? {}
    : createPaletteRemapAssetPaths(
      graphCastsByName,
      cast,
      member,
      assetDir,
      paletteIndices,
      width,
      height
    );

  return {
    id: `${graphRelease.versionId}:${cast.name}:${member.number}`,
    versionId: graphRelease.versionId,
    release: graphRelease.release,
    castName: cast.name,
    castOrder: cast.order,
    member: member.number,
    memberChunkId: member.memberChunkId,
    memberName: member.name ?? "",
    mediaType: "bitmap",
    pixelFormat: "rgba8888",
    alphaPolicy: bitmap.mediaFormat === "jpeg"
      ? (bitmap.alphaPath ? "jpeg-with-director-alfa" : "opaque-jpeg")
      : (bitmap.bitDepth === 32 && bitmap.useAlpha ? "native-32-bit-alpha" : "opaque-source-colors-director-ink-applies-later"),
    width,
    height,
    bitDepth: bitmap.bitDepth,
    pitch,
    regPoint: bitmap.regPoint,
    initialRect: bitmap.initialRect,
    ...(hasBitd ? { sourceBitdPath: bitmap.bitdPath, sourceBitdBytes: statSync(sourcePath).size } : {}),
    ...(hasMedia ? {
      sourceMediaPath: bitmap.mediaPath,
      sourceMediaBytes: statSync(sourcePath).size,
      sourceMediaFourCC: bitmap.mediaFourCC,
      sourceMediaFormat: bitmap.mediaFormat,
      sourceAlphaPath: bitmap.alphaPath,
    } : {}),
    sourceMemberChunkPath: relative(memberChunkPath),
    paletteName: palette?.name ?? `direct${bitmap.bitDepth}`,
    paletteCastName: palette?.castName ?? `direct${bitmap.bitDepth}`,
    paletteMember: palette?.member ?? 0,
    paletteChunkPath: palette?.chunkPath ?? "",
    paletteColorCount: palette?.colors.length ?? 0,
    ...(paletteReference ? paletteProvenance(paletteReference) : {}),
    pngPath: assetRelative(pngPath),
    pngBytes: statSync(pngPath).size,
    ...(indexedSource && palette ? { paletteColors: palette.colors.map(rgbInt) } : {}),
    ...(indexedSource ? { paletteIndexData: paletteIndices.toString("base64") } : {}),
    ...(ink36PngPath && ink8PngPath ? { inkAssetPaths: {
      "36": assetRelative(ink36PngPath),
      "8": assetRelative(ink8PngPath)
    } } : {}),
    ...(Object.keys(paletteRemapAssetPaths).length > 0 ? { paletteRemapAssetPaths } : {}),
    ...(ink36PngPath ? { ink36PngBytes: statSync(ink36PngPath).size } : {}),
    ...(ink36PngPath ? { ink36AlphaPolicy: "palette-index-0-transparent" } : {}),
    ...(ink8PngPath ? { ink8PngBytes: statSync(ink8PngPath).size } : {}),
    ...(ink8PngPath ? { ink8AlphaPolicy: "exact-white-transparent" } : {})
  };
}

function bitmapDiagnostic(cast, member, bitmap, reason) {
  return {
    castName: cast.name,
    castOrder: cast.order,
    member: member.number,
    memberChunkId: member.memberChunkId,
    memberName: member.name ?? "",
    width: bitmap.width,
    height: bitmap.height,
    bitDepth: bitmap.bitDepth,
    pitch: bitmap.pitch,
    metadataSource: bitmap.metadataSource ?? "cast-member-specific-data",
    bitdSource: bitmap.bitdSource ?? "none",
    orphanCandidateCount: bitmap.orphanCandidateCount ?? 0,
    orphanCandidateSectionIds: bitmap.orphanCandidateSectionIds ?? [],
    reason,
  };
}

function createPaletteRemapAssetPaths(graphCastsByName, cast, member, assetDir, paletteIndices, width, height) {
  const palettes = resolvePaletteRemapsForBitmap(graphCastsByName, cast, member);
  const result = {};
  for (const palette of palettes) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < paletteIndices.length; index++) {
      const color = palette.colors[paletteIndices[index]] ?? { r: 0, g: 0, b: 0 };
      const destIndex = index * 4;
      rgba[destIndex] = color.r;
      rgba[destIndex + 1] = color.g;
      rgba[destIndex + 2] = color.b;
      rgba[destIndex + 3] = 255;
    }

    const basePath = path.join(assetDir, `${pad(member.number, 4)}-${slugify(member.name ?? fallbackMemberName(member))}-${slugify(palette.name)}`);
    const pngPath = `${basePath}.png`;
    const ink36PngPath = `${basePath}-ink36.png`;
    const ink8PngPath = `${basePath}-ink8.png`;
    writePng(pngPath, width, height, rgba);
    writePng(ink36PngPath, width, height, applyPaletteIndexColorKey(rgba, paletteIndices, 0));
    writePng(ink8PngPath, width, height, applyExactWhiteMatteCoverage(rgba));
    result[palette.name] = {
      source: assetRelative(pngPath),
      "36": assetRelative(ink36PngPath),
      "8": assetRelative(ink8PngPath),
      "8MatteColor": "#ffffff"
    };
  }
  return result;
}

function rgbInt(color) {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function writePng(filePath, width, height, rgba) {
  const bytes = encodePngRgba(width, height, rgba);
  writeFileSync(filePath, bytes);
  artifactProgress.record(bytes.length);
}

function resolvePaletteRemapsForBitmap(graphCastsByName, cast, member) {
  const normalizedCastName = normalizeName(cast.name);
  const normalizedMemberName = normalizeName(member.name ?? "");

  if (normalizedCastName === "hh_cat_gfx_all" && normalizedMemberName.startsWith("catalog_spaces_wall")) {
    return resolvePalettesByPrefix(cast, "catalog_wall_");
  }

  if (normalizedCastName === "hh_cat_gfx_all" && normalizedMemberName.startsWith("catalog_spaces_floor")) {
    return resolvePalettesByPrefix(cast, "catalog_floor_");
  }

  if (normalizeName(cast.name) !== "hh_navigator") {
    return [];
  }

  const navigatorInfoIconMembers = new Set([
    "door_closed",
    "door_open",
    "door_password",
    "nav_ico_def_fav",
    "nav_ico_def_gr",
    "nav_ico_def_own",
    "nav_ico_def_pr",
    "nav_ico_def_src"
  ]);
  if (!navigatorInfoIconMembers.has(normalizeName(member.name))) {
    return [];
  }

  // Navigator Window Interface Class feeds these members into dynamic 8-bit
  // image buffers; keep palette-index color available instead of only the
  // member's baked palette colors.
  const navPalette = resolvePalette(graphCastsByName, cast.name, "nav_ui_palette", undefined);
  return navPalette ? [navPalette] : [];
}

function resolvePalettesByPrefix(cast, prefix) {
  const normalizedPrefix = normalizeName(prefix);
  const palettes = [];
  const seen = new Set();
  for (const member of cast.members) {
    if (member.type !== "palette" || !normalizeName(member.name ?? "").startsWith(normalizedPrefix)) {
      continue;
    }

    const palette = readPalette(cast, member);
    if (!palette || seen.has(normalizeName(palette.name))) {
      continue;
    }

    palettes.push(palette);
    seen.add(normalizeName(palette.name));
  }
  return palettes;
}

function readBitmapAssetMetadata(chunksRoot, memberChunkPath, memberChunkId) {
  const parsed = parseBitmapInfo(memberChunkPath);
  const bitmap = parsed.bitDepth > 0 ? parsed : (recoverBitmapMetadataFromCastOrder(chunksRoot, memberChunkId) ?? parsed);
  const bitdSource = resolveBitmapBitdSource(chunksRoot, memberChunkId, bitmap);
  const mediaSource = bitdSource?.bitdExists ? undefined : resolveDirectorBitmapMediaSource(chunksRoot, memberChunkId);
  const bitdPath = bitdSource?.bitdPath;

  return {
    ...bitmap,
    ...(mediaSource
      ? {
          mediaPath: relative(mediaSource.mediaPath),
          mediaFourCC: mediaSource.fourCC,
          mediaFormat: mediaSource.format,
          mediaSectionId: mediaSource.sectionID,
          mediaSource: mediaSource.kind,
          ...(mediaSource.alphaPath ? {
            alphaPath: relative(mediaSource.alphaPath),
            alphaSectionId: mediaSource.alphaSectionID,
          } : {}),
        }
      : {}),
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
    paletteMemberNumber: hasColorImageFlag && data.length >= 28 ? data.readInt16BE(26) : 0,
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
    paletteMemberNumber: 0,
    paletteId: 0,
    paletteCastLib: 0,
    regPoint: { x: 0, y: 0 },
    initialRect: { top: 0, left: 0, bottom: 0, right: 0 },
    alphaThreshold: 0,
    useAlpha: false
  };
}

function resolvePalette(graphCastsByName, preferredCastName, paletteName, paletteId, options = {}) {
  const builtIn = resolveBuiltInPalette(paletteName, paletteId);
  if (builtIn) {
    return builtIn;
  }

  const casts = [...graphCastsByName.values()].filter((cast) => cast.resolved);
  const allowFallback = options.allowFallback !== false;
  const preferredCastMatches = casts.filter((cast) => normalizeName(cast.name) === normalizeName(preferredCastName));
  const preferredCasts = [
    ...preferredCastMatches,
    ...(allowFallback ? casts.filter((cast) => normalizeName(cast.name) !== normalizeName(preferredCastName)) : [])
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

  if (typeof paletteId === "number" && paletteId >= 0) {
    return undefined;
  }

  return undefined;
}

function expectedPaletteColorCount(bitDepth) {
  if (bitDepth > 0 && bitDepth <= 8) return 2 ** bitDepth;
  return 0;
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

  if (normalized === "systemwin" || normalized === "systemwindir4" || paletteId === -101 || paletteId === -102) {
    const name = normalized === "systemwindir4" || paletteId === -101 ? "systemWinDir4" : "systemWin";
    return {
      castName: "builtin",
      member: 0,
      memberChunkId: 0,
      name,
      sectionId: 0,
      chunkPath: `builtin/${name}`,
      colors: createDirectorSystemWinPalette(name)
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

function readPalette(cast, member, recovery = {}) {
  const chunksRoot = castChunksRoot(cast);
  const clutEntry =
    readDirectorKeyEntries(chunksRoot).find((entry) => entry.castID === member.memberChunkId && entry.fourCC === "CLUT") ??
    sameNamePaletteClutEntry(chunksRoot, member) ??
    nearestOrphanPaletteClutEntry(chunksRoot, recovery);
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

function readExactPalette(cast, member) {
  const chunksRoot = castChunksRoot(cast);
  const clutEntry = readDirectorKeyEntries(chunksRoot).find(
    (entry) => entry.castID === member.memberChunkId && entry.fourCC === "CLUT",
  );
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
    castName: cast.name,
    member: member.number,
    memberChunkId: member.memberChunkId,
    name: member.name,
    sectionId: clutEntry.sectionID,
    chunkPath: relative(chunkPath),
    colors,
  };
}

function castChunksRoot(cast) {
  if (cast.expectedExtractionRoot) {
    return path.resolve(cast.expectedExtractionRoot, "chunks");
  }
  if (cast.sourceConfigPath) {
    return path.dirname(path.resolve(cast.sourceConfigPath));
  }
  throw new Error(`Cast ${cast.name ?? cast.number ?? "unknown"} has no extracted source root`);
}

function nearestOrphanPaletteClutEntry(chunksRoot, recovery) {
  const nearSectionId = Number(recovery.nearSectionId);
  const expectedBytes = Number(recovery.expectedColorCount) > 0 ? Number(recovery.expectedColorCount) * 6 : 0;
  if (!Number.isFinite(nearSectionId) || nearSectionId <= 0 || expectedBytes <= 0) return undefined;

  const claimedClutSectionIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "CLUT")
      .map((entry) => entry.sectionID),
  );
  const candidates = readdirSync(chunksRoot)
    .filter((entry) => /^CLUT-\d+\.bin$/i.test(entry))
    .map((fileName) => {
      const sectionID = Number(fileName.match(/^CLUT-(\d+)\.bin$/i)?.[1] ?? 0);
      const chunkPath = path.join(chunksRoot, fileName);
      return { sectionID, chunkPath };
    })
    .filter((entry) => entry.sectionID > 0 && !claimedClutSectionIds.has(entry.sectionID))
    .filter((entry) => existsSync(entry.chunkPath) && statSync(entry.chunkPath).size === expectedBytes)
    .map((entry) => ({ ...entry, distance: Math.abs(entry.sectionID - nearSectionId) }))
    .filter((entry) => entry.distance <= 32)
    .sort((left, right) => left.distance - right.distance || left.sectionID - right.sectionID);

  if (candidates.length === 0) return undefined;
  if (candidates.length > 1 && candidates[0].distance === candidates[1].distance) return undefined;
  return {
    sectionID: candidates[0].sectionID,
    castID: 0,
    fourCC: "CLUT",
    source: "orphan-nearest-clut-to-bitmap-section",
  };
}

function sameNamePaletteClutEntry(chunksRoot, member) {
  const targetName = normalizeName(member.name ?? "");
  if (!targetName) return undefined;

  const clutEntriesByCastId = new Map();
  for (const entry of readDirectorKeyEntries(chunksRoot).filter((candidate) => candidate.fourCC === "CLUT")) {
    const existing = clutEntriesByCastId.get(entry.castID);
    if (!existing) {
      clutEntriesByCastId.set(entry.castID, [entry]);
    } else {
      existing.push(entry);
    }
  }

  const candidates = [];
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^CASt-\d+\.json$/i.test(entry)).sort(numericChunkSort)) {
    const memberChunkId = Number(fileName.match(/^CASt-(\d+)\.json$/i)?.[1] ?? 0);
    if (!memberChunkId || memberChunkId === member.memberChunkId) continue;
    let parsed;
    try {
      parsed = readProjectorRaysJson(path.join(chunksRoot, fileName));
    } catch {
      continue;
    }
    if (parsed.type !== 4 || normalizeName(parsed.info?.name ?? parsed.name ?? "") !== targetName) continue;
    candidates.push(...(clutEntriesByCastId.get(memberChunkId) ?? []));
  }

  const uniqueSections = [...new Map(candidates.map((entry) => [entry.sectionID, entry])).values()]
    .sort((left, right) => left.sectionID - right.sectionID);
  if (uniqueSections.length === 1) {
    return uniqueSections[0];
  }

  return identicalClutEntries(chunksRoot, uniqueSections) ? uniqueSections[0] : undefined;
}

function identicalClutEntries(chunksRoot, entries) {
  if (entries.length < 2) return false;
  let first;
  for (const entry of entries) {
    const chunkPath = path.join(chunksRoot, `CLUT-${entry.sectionID}.bin`);
    if (!existsSync(chunkPath)) return false;
    const bytes = readFileSync(chunkPath);
    if (!first) {
      first = bytes;
      continue;
    }
    if (!first.equals(bytes)) return false;
  }
  return true;
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
  // ProjectorRays exposes compressed Director 32-bit BITD as planar channels,
  // while uncompressed rows in newer casts are interleaved ARGB.
  const scanWidth = Math.max(width, Math.floor((pitch * 8) / 32));
  for (let y = 0; y < height; y++) {
    const lineOffset = y * pitch;
    for (let x = 0; x < width; x++) {
      const destIndex = (y * width + x) * 4;
      if (isPackBitsCompressed) {
        const alphaIndex = lineOffset + x;
        const redIndex = lineOffset + scanWidth + x;
        const greenIndex = lineOffset + (scanWidth * 2) + x;
        const blueIndex = lineOffset + (scanWidth * 3) + x;
        rgba[destIndex] = source[redIndex] ?? 0;
        rgba[destIndex + 1] = source[greenIndex] ?? 0;
        rgba[destIndex + 2] = source[blueIndex] ?? 0;
        rgba[destIndex + 3] = useAlpha ? source[alphaIndex] ?? 255 : 255;
      } else {
        const sourceIndex = lineOffset + (x * 4);
        rgba[destIndex] = source[sourceIndex + 1] ?? 0;
        rgba[destIndex + 1] = source[sourceIndex + 2] ?? 0;
        rgba[destIndex + 2] = source[sourceIndex + 3] ?? 0;
        rgba[destIndex + 3] = useAlpha ? source[sourceIndex] ?? 255 : 255;
      }
    }
  }
}

function decode16BitRgb555(source, rgba, width, height, isPackBitsCompressed) {
  const rowBytes = width * 2;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const color = isPackBitsCompressed
        ? (((source[rowStart + x] ?? 0) << 8) | (source[rowStart + width + x] ?? 0))
        : (((source[rowStart + x * 2] ?? 0) << 8) | (source[rowStart + x * 2 + 1] ?? 0));
      const destIndex = (y * width + x) * 4;
      rgba[destIndex] = expand5Bit((color >> 10) & 0x1f);
      rgba[destIndex + 1] = expand5Bit((color >> 5) & 0x1f);
      rgba[destIndex + 2] = expand5Bit(color & 0x1f);
      rgba[destIndex + 3] = 255;
    }
  }
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

function toByte(value) {
  return Math.max(0, Math.min(255, Math.round(value / 257)));
}

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}

function assetRelative(filePath) {
  return path.relative(assetPathBase, filePath).replaceAll(path.sep, "/");
}

function numericChunkSort(left, right) {
  const leftId = Number(left.match(/-(\d+)\./)?.[1] ?? 0);
  const rightId = Number(right.match(/-(\d+)\./)?.[1] ?? 0);
  return leftId - rightId || left.localeCompare(right);
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
}

function fallbackMemberName(member) {
  return `member-${pad(member.number, 4)}`;
}

function parseArgs(argv) {
  const parsed = { casts: [], members: [] };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--version") {
      parsed.version = argv[++index];
    } else if (arg === "--cast") {
      parsed.casts.push(argv[++index]);
    } else if (arg === "--member") {
      parsed.members.push(argv[++index]);
    } else if (arg === "--external-cast-graph") {
      parsed.externalCastGraph = argv[++index];
    } else if (arg === "--movie-manifest") {
      parsed.movieManifest = argv[++index];
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
