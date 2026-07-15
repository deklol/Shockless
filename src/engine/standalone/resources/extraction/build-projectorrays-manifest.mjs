#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { deflateSync } from "node:zlib";
import { readDirectorKeyEntries, recoverBitmapMetadataFromCastOrder, resolveBitmapBitdSource } from "./director-bitd-recovery.mjs";
import {
  directorMemberNumber,
  readDirectorCastMetadata,
  readProjectorRaysJson,
} from "./director-cast-metadata.mjs";
import { resolveDirectorBitmapPalette } from "./director-palette-reference.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const extractionSummaryPath = path.resolve(args.summary ?? "generated/extraction/projectorrays-summary.json");
const outputRoot = path.resolve(args.outputRoot ?? "generated/runtime-data");
const bitmapAssetRoot = path.resolve(args.bitmapAssetRoot ?? "generated/assets/projectorrays-score-bitmaps");

if (!existsSync(extractionSummaryPath)) {
  throw new Error(`ProjectorRays extraction summary not found: ${extractionSummaryPath}`);
}

mkdirSync(outputRoot, { recursive: true });

const extractionSummary = JSON.parse(readFileSync(extractionSummaryPath, "utf8"));
const manifestSummaries = [];

for (const releaseSummary of extractionSummary.releases) {
  if (args.release && releaseSummary.release !== args.release) {
    continue;
  }

  for (const spec of manifestSpecsForRelease(releaseSummary)) {
    const built = buildManifest(releaseSummary, spec);
    const manifestFileName = `${spec.manifestKey}-projectorrays-manifest.json`;
    const manifestPath = path.join(outputRoot, manifestFileName);
    writeFileSync(manifestPath, `${JSON.stringify(built.manifest, null, 2)}\n`, "utf8");

    manifestSummaries.push({
      release: spec.manifestKey,
      sourceRelease: releaseSummary.release,
      movie: spec.movieStem,
      manifestPath: relative(manifestPath),
      ...built.summary
    });
  }
}

if (manifestSummaries.length === 0) {
  throw new Error(`No ProjectorRays releases matched release filter: ${args.release}`);
}

const summaryPath = path.join(outputRoot, "projectorrays-manifest-summary.json");
writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      extractionSummaryPath: relative(extractionSummaryPath),
      manifests: manifestSummaries
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Built ${manifestSummaries.length} ProjectorRays runtime manifest(s)`);
console.log(`Manifest summary: ${relative(summaryPath)}`);

function manifestSpecsForRelease(releaseSummary) {
  const entryStem = entryMovieStem(releaseSummary.entryMovie);
  const specs = [
    {
      manifestKey: releaseSummary.release,
      movieStem: entryStem,
      name: `${releaseSummary.release} ProjectorRays Extract`
    }
  ];

  if (releaseSummary.release === "release1_roseau_dcr0910") {
    specs.push({
      manifestKey: `${releaseSummary.release}-habbo_entry`,
      movieStem: "habbo_entry",
      name: `${releaseSummary.release} habbo_entry ProjectorRays Extract`
    }, {
      manifestKey: `${releaseSummary.release}-gf_private`,
      movieStem: "gf_private",
      name: `${releaseSummary.release} gf_private ProjectorRays Extract`
    });
  }

  return specs;
}

function buildManifest(releaseSummary, spec) {
  const releaseRoot = path.resolve(releaseSummary.outputRoot);
  const entryMovieRoot = path.join(releaseRoot, spec.movieStem);
  const chunksRoot = path.join(entryMovieRoot, "chunks");
  const drcf = readFirstChunkJson(chunksRoot, "DRCF");
  const mcsl = readFirstChunkJson(chunksRoot, "MCsL");
  const scoreChunkPath = findFirstChunkBin(chunksRoot, "VWSC");
  const markerChunkPath = findFirstChunkBin(chunksRoot, "VWLB");
  const parsedScore = scoreChunkPath ? parseVwscScore(scoreChunkPath) : undefined;
  const parsedMarkers = markerChunkPath ? parseVwlbMarkers(markerChunkPath) : undefined;
  const unsupportedRawChunks = collectRawChunkInfo(chunksRoot, ["VWSC", "VWFI", "VWLB", "Sord", "FXmp", "BITD", "XTRl"]);

  const castSourcesByNumber = new Map();
  const casts = mcsl.entries.map((entry, index) => {
    const castNumber = index + 1;
    const castSource = resolveCastSource(releaseRoot, entryMovieRoot, entry, castNumber);
    if (castSource) {
      castSourcesByNumber.set(castNumber, castSource);
    }

    return {
      number: castNumber,
      name: entry.name || `castLib ${castNumber}`,
      fileName: normalizeDirectorFileName(entry.filePath),
      preloadMode: positiveOrUndefined(entry.preloadSettings),
      ...(castSource ? castRange(castSource) : {}),
      members: castSource ? readMembers(castSource, releaseSummary.release, castNumber) : []
    };
  });

  const stageWidth = Math.max(1, (drcf.movieRight ?? 0) - (drcf.movieLeft ?? 0));
  const stageHeight = Math.max(1, (drcf.movieBottom ?? 0) - (drcf.movieTop ?? 0));
  const frameRate = drcf.frameRate > 0 ? drcf.frameRate : 1;

  const scoreBehaviors = buildScoreBehaviors(parsedScore);
  const scoreFrames = buildScoreFrames(parsedScore);
  const recordedFrameSpriteHints = applyRecordedFrameSpriteHints(casts, scoreFrames);
  const unresolvedScoreReferences = ensureScoreReferencedMembers(casts, scoreFrames, scoreBehaviors);
  const scoreReferencedAssets = enrichScoreReferencedAssets(casts, castSourcesByNumber, scoreFrames, scoreBehaviors, spec);

  const manifest = {
    id: `${spec.manifestKey}-projectorrays`,
    name: spec.name,
    stage: {
      width: stageWidth,
      height: stageHeight,
      backgroundColor: stageColor(drcf)
    },
    director: {
      defaultPalette: readDirectorCastMetadata(chunksRoot).defaultPalette,
    },
    casts,
    score: {
      frameRate,
      markers: parsedMarkers && parsedMarkers.length > 0 ? parsedMarkers : [{ name: "start", frame: 1 }],
      behaviors: scoreBehaviors,
      frames: scoreFrames
    },
    extraction: {
      source: "ProjectorRays",
      release: releaseSummary.release,
      movie: spec.movieStem,
      outputRoot: releaseSummary.outputRoot,
      scoreStatus: parsedScore
        ? "parsed-vwsc-frame-count-and-visible-sprites-behavior-intervals-metadata-only"
        : "placeholder-empty-frame-missing-vwsc",
      score: parsedScore
        ? {
            chunkPath: relative(scoreChunkPath),
            header: parsedScore.header,
            frameHeader: parsedScore.frameHeader,
            visibleSpriteRecords: parsedScore.visibleSprites.length,
            rawNonEmptyChannelRecords: parsedScore.rawNonEmptyChannels.length,
            behaviorIntervals: parsedScore.behaviorIntervals,
            recordedFrameSpriteHints
          }
        : undefined,
      markers: markerChunkPath
        ? {
            chunkPath: relative(markerChunkPath),
            status: parsedMarkers ? "parsed-vwlb-marker-table" : "unparsed-vwlb-marker-table",
            count: parsedMarkers?.length ?? 0
          }
        : undefined,
      unresolvedScoreReferences,
      scoreReferencedAssets,
      unsupportedRawChunks
    }
  };

  const memberCounts = casts.map((cast) => cast.members.length);
  const members = memberCounts.reduce((total, count) => total + count, 0);
  const scriptMembers = casts
    .flatMap((cast) => cast.members)
    .filter((member) => member.type === "script").length;

  return {
    manifest,
    summary: {
      stage: manifest.stage,
      frameRate,
      castLibraries: casts.length,
      members,
      scriptMembers,
      bitmapMembers: casts.flatMap((cast) => cast.members).filter((member) => member.type === "bitmap").length,
      scoreFrameCount: manifest.score.frames.length,
      visibleSpriteRecords: parsedScore?.visibleSprites.length ?? 0,
      behaviorIntervals: parsedScore?.behaviorIntervals.length ?? 0,
      unsupportedRawChunks
    }
  };
}

function entryMovieStem(entryMovie) {
  const relativePath = entryMovie?.relativePath;
  if (!relativePath) {
    return "habbo";
  }

  return path.basename(relativePath).replace(/\.[^.]+$/, "");
}

function buildScoreFrames(parsedScore) {
  if (!parsedScore || parsedScore.frameHeader.frameCount <= 0) {
    return [
      {
        index: 1,
        sprites: []
      }
    ];
  }

  const spritesByFrame = new Map();
  for (const sprite of parsedScore.visibleSprites) {
    const frameSprites = spritesByFrame.get(sprite.frame) ?? [];
    frameSprites.push({
      channel: Math.max(1, sprite.channel),
      member: {
        castLib: sprite.castLib,
        member: sprite.castMember
      },
      loc: {
        x: sprite.posX,
        y: sprite.posY
      },
      width: positiveOrUndefined(sprite.width),
      height: positiveOrUndefined(sprite.height),
      visible: true,
      ink: sprite.ink,
      blend: sprite.blend,
      ...scoreSpriteColorProps(sprite)
    });
    spritesByFrame.set(sprite.frame, frameSprites);
  }

  return Array.from({ length: parsedScore.frameHeader.frameCount }, (_, frameIndex) => ({
    index: frameIndex + 1,
    sprites: (spritesByFrame.get(frameIndex + 1) ?? []).sort((left, right) => left.channel - right.channel)
  }));
}

function buildScoreBehaviors(parsedScore) {
  if (!parsedScore) {
    return [];
  }

  return parsedScore.behaviorIntervals.flatMap((interval) =>
    interval.behaviors.map((behavior) => {
      const propertyList = behavior.propertiesEntry !== undefined
        ? parseVwscBehaviorPropertyListEntry(parsedScore.entries[behavior.propertiesEntry])
        : undefined;
      return {
        startFrame: Math.max(1, interval.startFrame),
        endFrame: Math.max(1, interval.endFrame),
        channel: Math.max(0, interval.channel),
        script: {
          castLib: behavior.castLib,
          member: behavior.member
        },
        ...(propertyList ? { properties: propertyList.properties, propertiesEntry: behavior.propertiesEntry } : {})
      };
    })
  );
}

function applyRecordedFrameSpriteHints(casts, frames) {
  const hints = collectRecordedFrameSpriteHints(casts);
  if (hints.length === 0) {
    return { sourceFields: 0, hints: 0, appliedBlendHints: 0 };
  }

  const hintsBySpriteKey = new Map();
  for (const hint of hints) {
    const key = recordedFrameSpriteHintKey(hint);
    const existing = hintsBySpriteKey.get(key);
    if (!existing) {
      hintsBySpriteKey.set(key, hint);
    }
  }

  let appliedBlendHints = 0;
  for (const frame of frames) {
    for (const sprite of frame.sprites) {
      const key = recordedFrameSpriteHintKey({
        castLib: sprite.member.castLib,
        member: sprite.member.member,
        locX: sprite.loc.x,
        locY: sprite.loc.y,
        width: sprite.width,
        height: sprite.height,
        ink: sprite.ink
      });
      const hint = hintsBySpriteKey.get(key);
      if (!hint || !Number.isFinite(hint.blend)) {
        continue;
      }

      if (sprite.blend !== hint.blend) {
        sprite.blend = hint.blend;
        appliedBlendHints += 1;
      }
    }
  }

  return {
    sourceFields: new Set(hints.map((hint) => hint.sourceMember)).size,
    hints: hints.length,
    appliedBlendHints
  };
}

function collectRecordedFrameSpriteHints(casts) {
  const castsByName = new Map(casts.map((cast) => [String(cast.name ?? "").toLowerCase(), cast]));
  const hints = [];
  for (const cast of casts) {
    for (const member of cast.members) {
      if (!member.name?.endsWith(".recorded") || typeof member.text !== "string") {
        continue;
      }

      hints.push(...parseRecordedFrameSpriteHints(member.name, member.text, castsByName));
    }
  }
  return hints;
}

function parseRecordedFrameSpriteHints(sourceMember, text, castsByName) {
  const lines = text.split(/\r?\n|\r/g);
  const castNames = [];
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (line === "*") {
      index += 1;
      break;
    }
    if (line.length > 0) {
      castNames.push(line.includes(".") ? line.slice(0, line.indexOf(".")) : line);
    }
  }

  const hints = [];
  while (index < lines.length) {
    let sprInfo = "";
    while (index < lines.length && sprInfo.length < 2) {
      sprInfo = lines[index]?.trim() ?? "";
      index += 1;
    }
    if (sprInfo.length < 2) {
      break;
    }
    index += 1;

    const parts = sprInfo.split("/");
    if (parts.length < 11) {
      continue;
    }

    const castName = castNames[parseIntStrict(parts[1]) - 1];
    const cast = castName ? castsByName.get(castName.toLowerCase()) : undefined;
    if (!cast) {
      continue;
    }

    hints.push({
      sourceMember,
      castLib: cast.number,
      member: parseIntStrict(parts[0]),
      locX: parseIntStrict(parts[2]),
      locY: parseIntStrict(parts[3]),
      ink: parseIntStrict(parts[5]),
      blend: parseIntStrict(parts[8]),
      width: parseIntStrict(parts[9]),
      height: parseIntStrict(parts[10])
    });
  }
  return hints.filter((hint) =>
    Number.isInteger(hint.member)
    && Number.isInteger(hint.locX)
    && Number.isInteger(hint.locY)
    && Number.isInteger(hint.ink)
    && Number.isInteger(hint.blend)
    && Number.isInteger(hint.width)
    && Number.isInteger(hint.height)
  );
}

function recordedFrameSpriteHintKey(hint) {
  return [
    hint.castLib,
    hint.member,
    hint.locX,
    hint.locY,
    hint.width ?? "",
    hint.height ?? "",
    hint.ink
  ].join(":");
}

function parseIntStrict(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return NaN;
  }
  return Number.parseInt(trimmed, 10);
}

function ensureScoreReferencedMembers(casts, frames, behaviors) {
  const castsByNumber = new Map(casts.map((cast) => [cast.number, cast]));
  const memberRefsByCast = new Map();
  const unresolved = [];

  for (const cast of casts) {
    memberRefsByCast.set(cast.number, new Set(cast.members.map((member) => member.number)));
  }

  for (const frame of frames) {
    for (const sprite of frame.sprites) {
      addReferencedMember(castsByNumber, memberRefsByCast, unresolved, sprite.member, "score-sprite");
    }
  }

  for (const behavior of behaviors) {
    addReferencedMember(castsByNumber, memberRefsByCast, unresolved, behavior.script, "score-behavior");
  }

  for (const cast of casts) {
    cast.members.sort((left, right) => left.number - right.number);
  }

  return unresolved.sort((left, right) =>
    left.castLib - right.castLib || left.member - right.member || left.source.localeCompare(right.source)
  );
}

function enrichScoreReferencedAssets(casts, castSourcesByNumber, frames, behaviors, spec) {
  const castsByNumber = new Map(casts.map((cast) => [cast.number, cast]));
  const referenced = new Map();
  const unsupported = [];
  let decodedBitmapCount = 0;
  let decodedTextCount = 0;

  for (const frame of frames) {
    for (const sprite of frame.sprites) {
      const castLib = sprite.member.castLib;
      const member = sprite.member.member;
      if (Number.isInteger(castLib) && Number.isInteger(member)) {
        referenced.set(`${castLib}:${member}`, { castLib, member });
      }
    }
  }

  const dynamicRefs = collectDynamicBehaviorBitmapMemberRefs(casts, behaviors);
  for (const ref of dynamicRefs) {
    referenced.set(`${ref.castLib}:${ref.member}`, ref);
  }

  const recordedFrameRefs = collectRecordedFrameBitmapMemberRefs(casts);
  for (const ref of recordedFrameRefs) {
    referenced.set(`${ref.castLib}:${ref.member}`, ref);
  }

  for (const ref of referenced.values()) {
    const cast = castsByNumber.get(ref.castLib);
    const member = cast?.members.find((candidate) => candidate.number === ref.member);
    if (!cast || !member) {
      continue;
    }

    if (member.type === "bitmap") {
      const result = decodeScoreBitmapMember(casts, castSourcesByNumber, cast, member, spec, unsupported);
      if (result) {
        decodedBitmapCount++;
      }
    } else if ((member.type === "text" || member.type === "field") && typeof member.text === "string") {
      decodedTextCount++;
    }
  }

  return {
    source: "score-visible-sprite-and-behavior-member-references",
    decodedBitmapCount,
    decodedTextCount,
    dynamicBehaviorBitmapRefs: dynamicRefs.length,
    recordedFrameBitmapRefs: recordedFrameRefs.length,
    unsupported
  };
}

function collectRecordedFrameBitmapMemberRefs(casts) {
  const castsByNumber = new Map(casts.map((cast) => [cast.number, cast]));
  const castNumbersByName = new Map(casts.map((cast) => [normalizeName(cast.name ?? ""), cast.number]));
  const refs = new Map();

  for (const cast of casts) {
    for (const recordedMember of cast.members) {
      if ((recordedMember.type !== "text" && recordedMember.type !== "field") || typeof recordedMember.text !== "string") {
        continue;
      }
      if (!recordedMember.name?.toLowerCase().endsWith(".recorded")) {
        continue;
      }

      for (const ref of parseRecordedFrameMemberRefs(recordedMember.text, castNumbersByName)) {
        const member = castsByNumber.get(ref.castLib)?.members.find((candidate) => candidate.number === ref.member);
        if (member?.type !== "bitmap") {
          continue;
        }
        refs.set(`${ref.castLib}:${ref.member}`, {
          ...ref,
          source: `recorded-frame:${cast.name ?? cast.number}:${recordedMember.name}`
        });
      }
    }
  }

  return [...refs.values()];
}

function parseRecordedFrameMemberRefs(text, castNumbersByName) {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const castRefs = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]?.trim() ?? "";
    lineIndex += 1;
    if (line === "*") {
      break;
    }
    if (line.length === 0) {
      continue;
    }
    const castLib = castNumbersByName.get(normalizeName(line));
    if (castLib !== undefined) {
      castRefs.push(castLib);
    }
  }

  const refs = [];
  while (lineIndex < lines.length) {
    const spriteLine = lines[lineIndex]?.trim() ?? "";
    if (!spriteLine) {
      lineIndex += 1;
      continue;
    }
    lineIndex += 2;
    const items = spriteLine.split("/");
    if (items.length < 2) {
      continue;
    }
    const member = Number.parseInt(items[0] ?? "", 10);
    const castIndex = Number.parseInt(items[1] ?? "", 10);
    const castLib = castRefs[castIndex - 1];
    if (Number.isInteger(member) && member > 0 && Number.isInteger(castLib) && castLib > 0) {
      refs.push({ castLib, member });
    }
  }

  return refs;
}

function collectDynamicBehaviorBitmapMemberRefs(casts, behaviors) {
  const allBitmapMembers = casts.flatMap((cast) =>
    cast.members
      .filter((member) => member.type === "bitmap" && typeof member.name === "string")
      .map((member) => ({ castLib: cast.number, member: member.number, name: member.name }))
  );
  const bitmapMembersByName = new Map(allBitmapMembers.map((member) => [member.name.toLowerCase(), member]));
  const refs = new Map();

  for (const behavior of behaviors) {
    const scriptMember = casts
      .find((cast) => cast.number === behavior.script.castLib)
      ?.members.find((member) => member.number === behavior.script.member);
    if (!scriptMember?.assetPath) {
      continue;
    }

    const sourcePath = path.resolve(scriptMember.assetPath);
    if (!existsSync(sourcePath)) {
      continue;
    }

    const source = readFileSync(sourcePath, "utf8");
    if (!/sprite\s*\([^)]*\)\.member\s*=/i.test(source)) {
      continue;
    }

    for (const candidateName of dynamicMemberNameCandidates(source, allBitmapMembers, bitmapMembersByName)) {
      const candidate = bitmapMembersByName.get(candidateName.toLowerCase());
      if (candidate) {
        refs.set(`${candidate.castLib}:${candidate.member}`, {
          castLib: candidate.castLib,
          member: candidate.member,
          source: "score-behavior-dynamic-member"
        });
      }
    }
  }

  return [...refs.values()];
}

function dynamicMemberNameCandidates(source, allBitmapMembers, bitmapMembersByName) {
  const candidates = new Set();
  const usesConcatenatedMemberName = /sprite\s*\([^)]*\)\.member\s*=[^\r\n]*&/i.test(source);
  const stringLiterals = [...source.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => typeof value === "string" && value.length > 0);

  for (const literal of stringLiterals) {
    if (bitmapMembersByName.has(literal.toLowerCase())) {
      candidates.add(literal);
    }

    if (!usesConcatenatedMemberName) {
      continue;
    }

    const lowerPrefix = literal.toLowerCase();
    for (const member of allBitmapMembers) {
      const lowerName = member.name.toLowerCase();
      if (lowerName.startsWith(lowerPrefix) && /^\d+$/.test(lowerName.slice(lowerPrefix.length))) {
        candidates.add(member.name);
      }
    }
  }

  return candidates;
}

function decodeScoreBitmapMember(casts, castSourcesByNumber, cast, member, spec, unsupported) {
  const castSource = castSourcesByNumber.get(cast.number);
  if (!castSource || !member.memberChunkId) {
    unsupported.push({
      castLib: cast.number,
      member: member.number,
      memberName: member.name,
      reason: "missing-cast-source-or-member-chunk-id"
    });
    return undefined;
  }

  const chunksRoot = castSource.chunksRoot;
  const memberChunkPath = path.join(chunksRoot, `CASt-${member.memberChunkId}.bin`);
  const bitmap = readBitmapAssetMetadata(chunksRoot, memberChunkPath, member.memberChunkId);
  applyBitmapMemberGeometry(member, bitmap, memberChunkPath);
  if (![1, 2, 4, 8, 32].includes(bitmap.bitDepth)) {
    unsupported.push({
      castLib: cast.number,
      member: member.number,
      memberName: member.name,
      reason: `bitmap bit depth ${bitmap.bitDepth} is not decoded`
    });
    return undefined;
  }

  if (!bitmap.bitdPath || !existsSync(path.resolve(bitmap.bitdPath))) {
    unsupported.push({
      castLib: cast.number,
      member: member.number,
      memberName: member.name,
      reason: "BITD path is missing"
    });
    return undefined;
  }

  const paletteReference = bitmap.bitDepth === 32
    ? undefined
    : resolveDirectorBitmapPalette({
        sourceCast: cast,
        bitmap,
        movieCastsByNumber: new Map(casts.map((entry) => [entry.number, entry])),
        readPalette: (targetCast, targetMember) => readPalette(castSourcesByNumber, targetCast, targetMember),
      });
  const palette = paletteReference?.palette;
  if (bitmap.bitDepth !== 32 && !palette) {
    unsupported.push({
      castLib: cast.number,
      member: member.number,
      memberName: member.name,
      reason: `palette castLib=${bitmap.paletteCastLib} member=${bitmap.paletteMemberNumber} did not resolve (${paletteReference?.resolution ?? "unknown"})`
    });
    return undefined;
  }

  const width = Math.max(1, bitmap.width);
  const height = Math.max(1, bitmap.height);
  const pitch = bitmap.pitch > 0 ? bitmap.pitch : Math.ceil(width * bitmap.bitDepth / 8);
  const bitdPath = path.resolve(bitmap.bitdPath);
  const source = readFileSync(bitdPath);
  const expectedSourceBytes = pitch * height;
  const isPackBitsCompressed = source.length < expectedSourceBytes;
  const decodedSource = isPackBitsCompressed ? decompressPackBits(source, expectedSourceBytes) : source.subarray(0, expectedSourceBytes);
  const rgba = Buffer.alloc(width * height * 4);

  if (bitmap.bitDepth === 32) {
    decode32BitRgba(decodedSource, rgba, width, height, pitch, bitmap.useAlpha, isPackBitsCompressed);
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const paletteIndex = readPaletteIndex(decodedSource, bitmap.bitDepth, pitch, x, y);
        const color = palette.colors[paletteIndex] ?? { r: 0, g: 0, b: 0 };
        const destIndex = (y * width + x) * 4;
        rgba[destIndex] = color.r;
        rgba[destIndex + 1] = color.g;
        rgba[destIndex + 2] = color.b;
        rgba[destIndex + 3] = 255;
      }
    }
  }

  const assetDir = path.join(bitmapAssetRoot, spec.manifestKey, `cast-${pad(cast.number, 2)}-${slugify(cast.name ?? "cast")}`);
  mkdirSync(assetDir, { recursive: true });
  const pngPath = path.join(assetDir, `${pad(member.number, 4)}-${slugify(member.name ?? "member")}.png`);
  writeFileSync(pngPath, encodePngRgba(width, height, rgba));

  member.assetPath = relative(pngPath);
  member.sourceBitdPath = bitmap.bitdPath;

  return member;
}

function applyBitmapMemberGeometry(member, bitmap, memberChunkPath) {
  const width = Math.max(0, bitmap.width);
  const height = Math.max(0, bitmap.height);
  if (width > 0) {
    member.width = width;
  }
  if (height > 0) {
    member.height = height;
  }
  member.regPoint = bitmap.regPoint;
  member.sourceMemberChunkPath = relative(memberChunkPath);
}

function addReferencedMember(castsByNumber, memberRefsByCast, unresolved, ref, source) {
  const castLib = ref?.castLib;
  const member = ref?.member;
  if (!Number.isInteger(castLib) || castLib <= 0 || !Number.isInteger(member) || member <= 0) {
    return;
  }

  let cast = castsByNumber.get(castLib);
  if (!cast) {
    cast = {
      number: castLib,
      name: `score-referenced castLib ${castLib}`,
      members: []
    };
    castsByNumber.set(castLib, cast);
    casts.push(cast);
    memberRefsByCast.set(castLib, new Set());
    unresolved.push({ castLib, member: 0, source, reason: "missing-cast-library" });
  }

  const memberRefs = memberRefsByCast.get(castLib);
  if (memberRefs.has(member)) {
    return;
  }

  cast.members.push({
    number: member,
    name: `score-referenced member ${castLib}:${member}`,
    type: "unknown"
  });
  memberRefs.add(member);
  unresolved.push({ castLib, member, source, reason: "missing-cast-member" });
}

function resolveCastSource(releaseRoot, entryMovieRoot, entry, castNumber) {
  if (castNumber === 1 && existsSync(entryMovieRoot)) {
    return {
      root: entryMovieRoot,
      chunksRoot: path.join(entryMovieRoot, "chunks"),
      scriptsRoot: path.join(entryMovieRoot, "casts"),
      castRegistry: readCastRegistryForEntry(path.join(entryMovieRoot, "chunks"), entry)
    };
  }

  const fileStem = stemFromDirectorPath(entry.filePath);
  const candidates = [fileStem, entry.name, normalizeCastDirectoryName(entry.name)].filter(Boolean);
  for (const candidate of candidates) {
    const candidateRoot = path.join(releaseRoot, candidate);
    if (existsSync(candidateRoot)) {
      return {
        root: candidateRoot,
        chunksRoot: path.join(candidateRoot, "chunks"),
        scriptsRoot: path.join(candidateRoot, "casts"),
        castRegistry: readCastRegistryForEntry(path.join(candidateRoot, "chunks"), entry)
      };
    }
  }

  const linkedCastScriptsRoot = entry.name ? path.join(entryMovieRoot, "casts", entry.name) : undefined;
  if (linkedCastScriptsRoot && existsSync(linkedCastScriptsRoot)) {
    return {
      root: entryMovieRoot,
      chunksRoot: path.join(entryMovieRoot, "chunks"),
      scriptsRoot: linkedCastScriptsRoot,
      castRegistry: readCastRegistryForEntry(path.join(entryMovieRoot, "chunks"), entry)
    };
  }

  return undefined;
}

function readCastRegistryForEntry(chunksRoot, entry) {
  const keyEntries = readDirectorKeyEntries(chunksRoot);
  const sectionId = keyEntries.find((candidate) =>
    candidate.castID === entry.id && typeof candidate.fourCC === "string" && candidate.fourCC.startsWith("CAS")
  )?.sectionID;
  if (Number.isInteger(sectionId)) {
    const registryPath = path.join(chunksRoot, `CAS_-${sectionId}.json`);
    if (existsSync(registryPath)) {
      return readProjectorRaysJson(registryPath);
    }
  }

  return readFirstOptionalChunkJson(chunksRoot, "CAS_");
}

function readMembers(castSource, release, castNumber) {
  const chunksRoot = castSource.chunksRoot;
  const metadata = readDirectorCastMetadata(chunksRoot);
  const castRegistry = castSource.castRegistry;
  const keyChunk = { entries: readDirectorKeyEntries(chunksRoot) };
  const fontMap = readFontMap(chunksRoot);
  if (!castRegistry?.memberIDs) {
    return [];
  }

  const members = [];
  castRegistry.memberIDs.forEach((chunkId, index) => {
    if (!chunkId) {
      return;
    }

    const memberNumber = directorMemberNumber(index, metadata);
    const memberChunkPath = path.join(chunksRoot, `CASt-${chunkId}.json`);
    if (!existsSync(memberChunkPath)) {
      members.push({
        number: memberNumber,
        name: `missing CASt-${chunkId}`,
        type: "unknown"
      });
      return;
    }

    const memberChunk = JSON.parse(readFileSync(memberChunkPath, "utf8"));
    const memberType = mapMemberType(memberChunk.type);
    const member = {
      number: memberNumber,
      name: memberChunk.info?.name || undefined,
      type: memberType,
      memberChunkId: chunkId,
      sourceMemberChunkPath: relative(memberChunkPath)
    };

    const scriptPath = memberType === "script"
      ? findScriptDump(castSource.scriptsRoot, memberNumber, memberChunk.member?.scriptType)
      : undefined;
    if (scriptPath) {
      member.assetPath = relative(scriptPath);
    }

    const text = readMemberText(chunksRoot, keyChunk, chunkId, fontMap);
    const xmedText = !text && (memberType === "text" || memberType === "field")
      ? readMemberXmedText(chunksRoot, keyChunk, chunkId)
      : undefined;
    if ((memberType === "text" || memberType === "field") && (text || xmedText)) {
      const sourceText = text ?? xmedText;
      member.text = sourceText.text;
      if (sourceText.textChunkPath) {
        member.textChunkPath = sourceText.textChunkPath;
      }
      if (sourceText.xmedChunkPath) {
        member.xmedChunkPath = sourceText.xmedChunkPath;
      }
      member.fontSize = sourceText.fontSize ?? 9;
      member.lineHeight = sourceText.lineHeight ?? Math.max(10, (sourceText.fontSize ?? 9) + 1);
      member.wordWrap = sourceText.wordWrap ?? true;
      if (sourceText.fontFamily) {
        member.fontFamily = sourceText.fontFamily;
      }
      if (sourceText.fontWeight) {
        member.fontWeight = sourceText.fontWeight;
      }
      if (sourceText.textAlign) {
        member.textAlign = sourceText.textAlign;
      }
      if (sourceText.color) {
        member.color = sourceText.color;
      }
      if (sourceText.underline) {
        member.underline = sourceText.underline;
      }
      if (sourceText.textSpans?.length) {
        member.textSpans = sourceText.textSpans;
      }
    } else if (memberType === "field" && member.name?.trim()) {
      member.text = member.name;
      member.fontSize = 9;
      member.lineHeight = 10;
      member.wordWrap = true;
    }

    if (memberType === "shape") {
      const shape = readMemberShape(chunksRoot, chunkId);
      if (shape) {
        member.width = shape.width;
        member.height = shape.height;
        member.shapeType = shape.shapeType;
        member.shapeFillType = shape.fillType;
        member.shapeLineThickness = shape.lineThickness;
        member.shapeLineDirection = shape.lineDirection;
        member.shapeForeColorIndex = shape.foreColorIndex;
        member.shapeBackColorIndex = shape.backColorIndex;
        if (shape.fillType !== 0) {
          member.color = shape.color;
        } else {
          member.borderColor = shape.color;
          member.borderWidth = Math.max(0, shape.lineThickness - 1);
        }
      }
    }

    members.push(member);
  });

  return members;
}

function castRange(castSource) {
  const metadata = readDirectorCastMetadata(castSource.chunksRoot);
  return {
    minMember: metadata.minMember,
    maxMember: metadata.maxMember,
    memberSlotCount: metadata.slotCount,
    sourceConfigPath: relative(metadata.sourceConfigPath),
  };
}

function findScriptDump(scriptsRoot, memberNumber, scriptType) {
  if (!existsSync(scriptsRoot)) {
    return undefined;
  }

  const scriptKind = scriptTypeName(scriptType);
  const exactName = `${scriptKind} ${memberNumber}.ls`;
  const titledPrefix = `${scriptKind} ${memberNumber} -`;
  return walkFiles(scriptsRoot).find((filePath) => {
    const fileName = path.basename(filePath);
    return path.extname(fileName).toLowerCase() === ".ls"
      && (fileName === exactName || fileName.startsWith(titledPrefix));
  });
}

function scriptTypeName(scriptType) {
  switch (scriptType) {
    case 1:
      return "BehaviorScript";
    case 3:
      return "MovieScript";
    case 7:
      return "ParentScript";
    default:
      return "UnknownScript";
  }
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
    case 15:
      return "field";
    default:
      return "unknown";
  }
}

function readMemberText(chunksRoot, keyChunk, memberChunkId, fontMap) {
  const textSectionId = keyChunk?.entries?.find((entry) => entry.castID === memberChunkId && entry.fourCC === "STXT")?.sectionID;
  if (!textSectionId) {
    return undefined;
  }

  const textChunkPath = path.join(chunksRoot, `STXT-${textSectionId}.bin`);
  if (!existsSync(textChunkPath)) {
    return undefined;
  }

  const bytes = readFileSync(textChunkPath);
  if (bytes.length < 12) {
    return undefined;
  }

  const textOffset = readI32(bytes, 0);
  const textLength = readI32(bytes, 4);
  if (textOffset < 12 || textLength < 0 || textOffset + textLength > bytes.length) {
    return undefined;
  }

  return {
    textChunkPath: relative(textChunkPath),
    text: bytes.subarray(textOffset, textOffset + textLength).toString("latin1"),
    ...readMemberFieldInfo(chunksRoot, memberChunkId),
    ...readStxtStyle(bytes, textOffset + textLength, fontMap)
  };
}

function readMemberFieldInfo(chunksRoot, memberChunkId) {
  const memberChunkPath = path.join(chunksRoot, `CASt-${memberChunkId}.bin`);
  if (!existsSync(memberChunkPath)) {
    return {};
  }

  const bytes = readFileSync(memberChunkPath);
  if (bytes.length < 40) {
    return {};
  }

  const infoLength = readU32(bytes, 4);
  const dataLength = readU32(bytes, 8);
  const offset = 12 + infoLength;
  if (dataLength !== 28 || offset + dataLength > bytes.length) {
    return {};
  }

  const data = bytes.subarray(offset, offset + dataLength);
  const alignment = data.readInt16BE(4);
  return {
    ...(alignment === 1 ? { textAlign: "center" } : {}),
    ...(alignment === -1 ? { textAlign: "right" } : {})
  };
}

function readStxtStyle(bytes, styleOffset, fontMap) {
  if (styleOffset < 0 || bytes.length < styleOffset + 16) {
    return {};
  }

  const runCount = readU16(bytes, styleOffset);
  if (runCount <= 0) {
    return {};
  }

  const firstRunOffset = styleOffset + 2;
  if (bytes.length < firstRunOffset + 17) {
    return {};
  }

  const fontId = readU16(bytes, firstRunOffset + 8);
  const fontStyle = readU8(bytes, firstRunOffset + 10);
  const fontSize = normalizeDirectorStageFontSize(readU16(bytes, firstRunOffset + 12));
  const red = readU8(bytes, firstRunOffset + 14);
  const green = readU8(bytes, firstRunOffset + 16);
  const blue = readU8(bytes, firstRunOffset + 18);
  const fontName = fontMap.get(fontId);
  const result = {};

  if (fontSize >= 6 && fontSize <= 72) {
    result.fontSize = fontSize;
    result.lineHeight = Math.max(10, fontSize + 1);
  }

  if (fontName) {
    result.fontFamily = directorFontFamily(fontName);
  }

  if (isBoldDirectorFont(fontName) || (fontStyle & 1) === 1) {
    result.fontWeight = "700";
  }

  if (firstRunOffset + 16 < bytes.length) {
    result.color = rgb(red, green, blue);
  }

  return result;
}

function readFontMap(chunksRoot) {
  const fontMap = new Map();
  if (!existsSync(chunksRoot)) {
    return fontMap;
  }

  for (const fileName of readdirSync(chunksRoot).filter((entry) => entry.startsWith("Fmap-") && entry.endsWith(".bin")).sort()) {
    const bytes = readFileSync(path.join(chunksRoot, fileName));
    for (const [fontId, fontName] of parseFmapFontNames(bytes)) {
      if (!fontMap.has(fontId)) {
        fontMap.set(fontId, fontName);
      }
    }
  }

  return fontMap;
}

function parseFmapFontNames(bytes) {
  const fonts = new Map();
  if (bytes.length < 40) {
    return fonts;
  }

  const mapLength = readU32(bytes, 0);
  const namesStart = 8 + mapLength;
  if (mapLength <= 0 || namesStart < 8 || namesStart >= bytes.length) {
    return fonts;
  }

  const entriesUsed = readU32(bytes, 16);
  const entriesStart = 36;
  for (let index = 0; index < entriesUsed; index += 1) {
    const entryOffset = entriesStart + index * 8;
    if (entryOffset + 8 > bytes.length) {
      break;
    }

    const nameOffset = readU32(bytes, entryOffset);
    const fontId = readU16(bytes, entryOffset + 6);
    const namePosition = namesStart + nameOffset;
    if (namePosition + 4 > bytes.length) {
      continue;
    }

    const nameLength = readU32(bytes, namePosition);
    const nameStart = namePosition + 4;
    if (nameLength <= 0 || nameStart + nameLength > bytes.length) {
      continue;
    }

    const fontName = bytes.subarray(nameStart, nameStart + nameLength).toString("latin1").replace(/\0+$/g, "");
    if (fontName) {
      fonts.set(fontId, fontName);
    }
  }

  return fonts;
}

function readMemberXmedText(chunksRoot, keyChunk, memberChunkId) {
  const xmedSectionId = keyChunk?.entries?.find((entry) => entry.castID === memberChunkId && entry.fourCC === "XMED")?.sectionID;
  if (!xmedSectionId) {
    return undefined;
  }

  const xmedChunkPath = path.join(chunksRoot, `XMED-${xmedSectionId}.bin`);
  if (!existsSync(xmedChunkPath)) {
    return undefined;
  }

  const bytes = readFileSync(xmedChunkPath);
  const parsed = parseXmedText(bytes);
  if (!parsed?.text) {
    return undefined;
  }

  return {
    xmedChunkPath: relative(xmedChunkPath),
    ...parsed
  };
}

function parseXmedText(bytes) {
  if (!bytes || bytes.length < 10) {
    return undefined;
  }

  const ascii = asciiWithDots(bytes);
  const text = extractXmedText(bytes, ascii);
  if (typeof text !== "string") {
    return undefined;
  }

  const fontName = extractXmedFontName(bytes, ascii);
  const fontSize = normalizeXmedFontSizeForDirector(extractXmedFontSize(bytes, ascii), fontName);
  const textAlign = extractXmedTextAlign(bytes, ascii);
  const color = extractXmedColor(bytes, ascii);
  const styleInfo = extractXmedStyleInfo(bytes, text.length);

  return {
    text,
    fontSize,
    lineHeight: Math.max(10, fontSize + 1),
    wordWrap: true,
    ...(fontName ? { fontFamily: directorFontFamily(fontName) } : {}),
    ...(isBoldDirectorFont(fontName) || styleInfo?.fontWeight === "700" ? { fontWeight: "700" } : {}),
    ...(textAlign ? { textAlign } : {}),
    ...(styleInfo?.color ?? color ? { color: styleInfo?.color ?? color } : {}),
    ...(styleInfo?.underline === true ? { underline: true } : {}),
    ...(styleInfo?.textSpans?.length ? { textSpans: styleInfo.textSpans } : {})
  };
}

function normalizeXmedFontSizeForDirector(fontSize, fontName) {
  if (!/volter/i.test(fontName ?? "")) {
    return fontSize;
  }

  return normalizeDirectorStageFontSize(fontSize);
}

function normalizeDirectorStageFontSize(fontSize) {
  return fontSize === 10 ? 9 : fontSize;
}

function extractXmedText(bytes, ascii) {
  const tagIndex = ascii.indexOf("0002");
  if (tagIndex >= 0) {
    const tagged = extractXmedCountCommaText(bytes, tagIndex + 4);
    if (tagged !== undefined) {
      return tagged;
    }
  }

  for (let index = 0; index < bytes.length - 5; index++) {
    if (bytes[index] === 0x00 && tryXmedTextStart(bytes, index + 1)) {
      return extractXmedCountCommaText(bytes, index + 1);
    }
  }

  return undefined;
}

function extractXmedCountCommaText(bytes, startPosition) {
  for (let index = startPosition; index < bytes.length - 2; index++) {
    if (bytes[index] === 0x00) {
      return extractXmedTextAt(bytes, index + 1);
    }
    if (tryXmedTextStart(bytes, index)) {
      return extractXmedTextAt(bytes, index);
    }
  }

  return undefined;
}

function tryXmedTextStart(bytes, position) {
  let commaIndex = -1;
  for (let index = position; index < Math.min(position + 10, bytes.length); index++) {
    const value = bytes[index];
    if (value === 0x2c) {
      commaIndex = index;
      break;
    }
    if (!isHexByte(value)) {
      return false;
    }
  }

  return commaIndex > position && commaIndex + 1 < bytes.length && bytes[commaIndex + 1] !== 0x03;
}

function extractXmedTextAt(bytes, position) {
  let commaIndex = -1;
  for (let index = position; index < Math.min(position + 10, bytes.length); index++) {
    if (bytes[index] === 0x2c) {
      commaIndex = index;
      break;
    }
    if (!isHexByte(bytes[index])) {
      return undefined;
    }
  }

  if (commaIndex < 0) {
    return undefined;
  }

  let end = bytes.length;
  for (let index = commaIndex + 1; index < bytes.length; index++) {
    if (bytes[index] === 0x03) {
      end = index;
      break;
    }
  }

  return decodeMacRoman(bytes.subarray(commaIndex + 1, end));
}

function extractXmedFontName(bytes, ascii) {
  const sectionIndex = ascii.indexOf("0008");
  if (sectionIndex < 0) {
    return undefined;
  }

  const names = [];
  for (let index = sectionIndex + 20; index < bytes.length - 8; index++) {
    if (bytes[index] === 0x03 && bytes[index + 1] === 0x30 && bytes[index + 2] === 0x30 && bytes[index + 3] === 0x30) {
      break;
    }
    if (bytes[index] !== 0x00 || bytes[index + 1] !== 0x34 || bytes[index + 2] !== 0x30 || bytes[index + 3] !== 0x2c) {
      continue;
    }

    const length = bytes[index + 4] ?? 0;
    if (length <= 0 || length >= 64 || index + 5 + length > bytes.length) {
      continue;
    }

    const name = decodeMacRoman(bytes.subarray(index + 5, index + 5 + length)).trim();
    if (name) {
      names.push(name);
    }
    index += 67;
  }

  return names.find((name) => /volter/i.test(name))
    ?? names.find((name) => !/^geneva$/i.test(name))
    ?? names[0];
}

function extractXmedFontSize(bytes, ascii) {
  const sectionIndex = findXmedSection(ascii, "0006");
  if (sectionIndex < 0) {
    return 9;
  }

  const start = sectionIndex + 20;
  const end = xmedSectionEnd(bytes, ascii, sectionIndex, start);
  const counts = new Map();
  for (let index = start; index < end - 6; index++) {
    if (bytes[index] !== 0x02) {
      continue;
    }
    let cursor = index + 1;
    let hexValue = "";
    while (cursor < end && isHexByte(bytes[cursor])) {
      hexValue += String.fromCharCode(bytes[cursor]);
      cursor++;
    }
    if (hexValue.length < 5 || !hexValue.endsWith("0000") || bytes[cursor] !== 0x02) {
      continue;
    }
    const size = Number.parseInt(hexValue.slice(0, -4), 16);
    if (Number.isInteger(size) && size >= 6 && size <= 72) {
      counts.set(size, (counts.get(size) ?? 0) + 1);
    }
  }

  let bestSize = 9;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount || (count === bestCount && size < bestSize)) {
      bestSize = size;
      bestCount = count;
    }
  }
  return bestSize;
}

function extractXmedTextAlign(bytes, ascii) {
  const sectionIndex = findXmedSection(ascii, "0005");
  if (sectionIndex < 0) {
    return undefined;
  }

  const start = sectionIndex + 20;
  for (let index = start; index < Math.min(start + 30, bytes.length - 1); index++) {
    if (bytes[index] !== 0x01) {
      continue;
    }

    const value = parseHexByteRun(bytes, index + 1);
    if (value === 2) {
      return "right";
    }
    if (value === 1) {
      return "center";
    }
    return "left";
  }

  return undefined;
}

function extractXmedColor(bytes, ascii) {
  const sectionIndex = findXmedSection(ascii, "0003");
  if (sectionIndex < 0) {
    return undefined;
  }

  const raw = extractXmedCountCommaText(bytes, sectionIndex + 4);
  if (!raw) {
    return undefined;
  }

  const parts = raw.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  return rgb(parts[0], parts[1], parts[2]);
}

function extractXmedStyleInfo(bytes, textLength) {
  const sections = parseXmedSections(bytes);
  const styleSection = sections.get(0x0006);
  if (!styleSection) {
    return undefined;
  }

  const styles = parseXmedStyles(styleSection);
  if (!styles.length) {
    return undefined;
  }

  const charRuns = parseXmedStyleRuns(sections.get(0x0004));
  const activeRuns = charRuns.length
    ? charRuns
    : [{ position: 0, styleIndex: 0 }];
  const firstStyle = styles[activeRuns[0]?.styleIndex ?? 0] ?? styles[0];
  const textSpans = [];

  for (let index = 0; index < activeRuns.length; index += 1) {
    const run = activeRuns[index];
    const nextRun = activeRuns[index + 1];
    const style = styles[run.styleIndex];
    if (!style?.underline) {
      continue;
    }

    const start = Math.max(0, Math.min(textLength, run.position));
    const end = Math.max(start, Math.min(textLength, nextRun?.position ?? textLength));
    if (end > start) {
      textSpans.push({ start, end, underline: true });
    }
  }

  return {
    ...(firstStyle?.color ? { color: firstStyle.color } : {}),
    ...(firstStyle?.bold ? { fontWeight: "700" } : {}),
    ...(textSpans.length === 1 && textSpans[0].start === 0 && textSpans[0].end >= textLength ? { underline: true } : {}),
    ...(textSpans.length ? { textSpans } : {})
  };
}

function parseXmedSections(bytes) {
  const sections = new Map();
  let offset = 0;
  while (offset + 20 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 20).toString("latin1");
    if (!/^[0-9a-fA-F]{20}$/.test(header)) {
      break;
    }

    const key = Number.parseInt(header.slice(0, 4), 16);
    const length = Number.parseInt(header.slice(4, 12), 16);
    offset += 20;
    if (!Number.isFinite(length) || length < 0 || offset + length > bytes.length) {
      break;
    }

    sections.set(key, bytes.subarray(offset, offset + length));
    offset += length;
  }

  return sections;
}

function parseXmedStyleRuns(bytes) {
  if (!bytes?.length) {
    return [];
  }

  const packer = new XmedPackedNumberReader(bytes);
  const runs = [];
  while (packer.remaining() >= 2) {
    const position = packer.unpackNumber();
    if (packer.remaining() < 1) {
      break;
    }
    const styleIndex = packer.unpackNumber();
    if (position >= 0 && styleIndex >= 0) {
      runs.push({ position, styleIndex });
    }
  }

  return runs;
}

function parseXmedStyles(bytes) {
  const packer = new XmedPackedNumberReader(bytes);
  const declaredCount = packer.unpackNumber();
  const styles = [];
  let styleIndex = 0;
  while (styleIndex < 100 && packer.remaining() > 4) {
    const style = parseXmedStyle(packer);
    if (!style) {
      break;
    }
    styles.push(style);
    styleIndex += 1;
  }

  if (declaredCount === 0) {
    return styles.map((style) => ({ ...style, fontSize: 0 }));
  }

  return styles;
}

function parseXmedStyle(packer) {
  const read = () => packer.remaining() >= 1 ? packer.unpackNumber() : undefined;
  const fontIndex = read();
  if (fontIndex === undefined) {
    return undefined;
  }

  read();
  read();
  const fontSize = read();
  read();
  read();
  read();
  read();
  read();

  const foreColorValues = [];
  for (let index = 0; index < 4; index += 1) {
    const value = read();
    if (value === undefined) {
      return undefined;
    }
    foreColorValues.push(value);
  }

  for (let index = 0; index < 4; index += 1) {
    if (read() === undefined) {
      return undefined;
    }
  }

  for (let index = 0; index < 11; index += 1) {
    read();
  }

  read();
  packer.unpackRefcon(262145);
  read();

  for (let index = 0; index < 8; index += 1) {
    read();
  }

  const styleFlags = [];
  for (let index = 0; index < 32 && packer.remaining() >= 1; index += 1) {
    styleFlags.push(packer.unpackNumber());
  }

  read();
  for (let index = 0; index < 4; index += 1) {
    read();
  }
  read();

  return {
    color: rgb(
      (foreColorValues[0] ?? 0) >> 8,
      (foreColorValues[1] ?? 0) >> 8,
      (foreColorValues[2] ?? 0) >> 8
    ),
    fontSize,
    bold: styleFlags[0] === 1,
    italic: styleFlags[1] === 1,
    underline: styleFlags[2] === 1
  };
}

function XmedPackedNumberReader(bytes) {
  this.bytes = bytes;
  this.offset = 0;
  this.lastValue = 0;
  this.repeatCount = 0;

  this.remaining = () => Math.max(0, this.bytes.length - this.offset);

  this.unpackNumber = () => {
    if (this.repeatCount > 0) {
      this.repeatCount -= 1;
      return this.lastValue;
    }

    if (this.offset >= this.bytes.length) {
      return 0;
    }

    const control = this.bytes[this.offset];
    this.offset += 1;
    let value = 0;

    if ((control & 0x80) !== 0) {
      value = this.lastValue;
      if ((control & 0x40) !== 0 && this.offset < this.bytes.length) {
        this.repeatCount = Math.max(0, this.bytes[this.offset] - 1);
        this.offset += 1;
      }
    } else {
      const start = this.offset;
      while (this.offset < this.bytes.length && isHexOrMinus(this.bytes[this.offset])) {
        this.offset += 1;
      }

      if (this.offset > start) {
        let text = this.bytes.subarray(start, this.offset).toString("latin1");
        const negative = text.startsWith("-");
        if (negative) {
          text = text.slice(1);
        }
        const parsed = Number.parseInt(text, 16);
        value = Number.isFinite(parsed) ? (negative ? -parsed : parsed) : 0;
      }

      if ((control & 0x0f) === 1) {
        value &= 0xffff;
      }
    }

    this.lastValue = value;
    return value;
  };

  this.unpackRefcon = (documentVersion) => {
    if (documentVersion === 65547) {
      if (this.offset < this.bytes.length && this.bytes[this.offset] === 0) {
        this.offset += 1;
        this.unpackNumber();
      }
      return 0;
    }

    return this.unpackNumber();
  };
}

function isHexOrMinus(value) {
  return isHexByte(value) || value === 0x2d;
}

function findXmedSection(ascii, tag) {
  let searchStart = 0;
  while (searchStart < ascii.length) {
    const index = ascii.indexOf(tag, searchStart);
    if (index < 0) {
      return -1;
    }

    if (index === 0 || ascii[index - 1] === ".") {
      return index;
    }

    searchStart = index + 1;
  }

  return -1;
}

function xmedSectionEnd(bytes, ascii, sectionIndex, fallbackStart) {
  const lenHex = ascii.slice(sectionIndex + 4, sectionIndex + 12);
  const length = /^[0-9a-fA-F]+$/.test(lenHex) ? Number.parseInt(lenHex, 16) : 0;
  if (length > 0) {
    return Math.min(bytes.length, fallbackStart + length);
  }

  for (let index = fallbackStart; index < bytes.length - 4; index++) {
    if (bytes[index] === 0x03 && bytes[index + 1] === 0x30 && bytes[index + 2] === 0x30 && bytes[index + 3] === 0x30) {
      return index;
    }
  }

  return bytes.length;
}

function parseHexByteRun(bytes, position) {
  let text = "";
  while (position < bytes.length && isHexByte(bytes[position])) {
    text += String.fromCharCode(bytes[position]);
    position++;
  }
  return text ? Number.parseInt(text, 16) : 0;
}

function asciiWithDots(bytes) {
  return Array.from(bytes, (value) => value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : ".").join("");
}

function decodeMacRoman(bytes) {
  return new TextDecoder("macintosh").decode(bytes);
}

function isHexByte(value) {
  return (value >= 0x30 && value <= 0x39)
    || (value >= 0x41 && value <= 0x46)
    || (value >= 0x61 && value <= 0x66);
}

function directorFontFamily(fontName) {
  const normalized = normalizeName(fontName);
  if (normalized.includes("volter")) {
    return "\"Volter Goldfish\", Verdana, Arial, Helvetica, sans-serif";
  }
  if (normalized.includes("verdana")) {
    return "Verdana, Arial, Helvetica, sans-serif";
  }
  if (normalized.includes("geneva")) {
    return "Geneva, Arial, Helvetica, sans-serif";
  }
  return `${JSON.stringify(fontName)}, Arial, Helvetica, sans-serif`;
}

function isBoldDirectorFont(fontName) {
  return Boolean(fontName && /bold/i.test(fontName));
}

function readMemberShape(chunksRoot, memberChunkId) {
  const memberChunkPath = path.join(chunksRoot, `CASt-${memberChunkId}.bin`);
  if (!existsSync(memberChunkPath)) {
    return undefined;
  }

  const chunk = readFileSync(memberChunkPath);
  if (chunk.length < 29) {
    return undefined;
  }

  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (specificDataLen < 17 || offset + specificDataLen > chunk.length) {
    return undefined;
  }

  const data = chunk.subarray(offset, offset + specificDataLen);
  const shapeTypeRaw = data.readUInt16BE(0);
  const rectTop = data.readInt16BE(2);
  const rectLeft = data.readInt16BE(4);
  const rectBottom = data.readInt16BE(6);
  const rectRight = data.readInt16BE(8);
  const foreColorIndex = data.readUInt8(12);
  const backColorIndex = data.readUInt8(13);
  const fillType = data.readUInt8(14);
  const lineThickness = data.readUInt8(15);
  const lineDirection = data.readUInt8(16);

  return {
    shapeType: shapeTypeName(shapeTypeRaw),
    rect: { top: rectTop, left: rectLeft, bottom: rectBottom, right: rectRight },
    width: Math.max(1, rectRight - rectLeft),
    height: Math.max(1, rectBottom - rectTop),
    foreColorIndex,
    backColorIndex,
    fillType,
    lineThickness,
    lineDirection,
    color: directorPaletteIndexColor(foreColorIndex),
    backColor: directorPaletteIndexColor(backColorIndex)
  };
}

function shapeTypeName(value) {
  switch (value) {
    case 0x0001:
      return "rect";
    case 0x0002:
      return "ovalRect";
    case 0x0003:
      return "oval";
    case 0x0008:
      return "line";
    default:
      return "unknown";
  }
}

function directorPaletteIndexColor(index) {
  const palette = createSystemMacPalette();
  const color = palette[Math.max(0, Math.min(255, index))] ?? { r: 0, g: 0, b: 0 };
  return rgb(color.r, color.g, color.b);
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
    return zeroBitmapMetadata("cast-member-chunk-too-short");
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
    paletteId: 0,
    paletteMemberNumber: 0,
    paletteCastLib: 0,
    regPoint: { x: 0, y: 0 },
    initialRect: { top: 0, left: 0, bottom: 0, right: 0 },
    alphaThreshold: 0,
    useAlpha: false
  };
}

function readPalette(castSourcesByNumber, cast, member) {
  const castSource = castSourcesByNumber.get(cast.number);
  if (!castSource || !member.memberChunkId) {
    return undefined;
  }

  const keyChunk = { entries: readDirectorKeyEntries(castSource.chunksRoot) };
  const clutEntry = keyChunk?.entries?.find((entry) => entry.castID === member.memberChunkId && entry.fourCC === "CLUT");
  if (!clutEntry) {
    return undefined;
  }

  const chunkPath = path.join(castSource.chunksRoot, `CLUT-${clutEntry.sectionID}.bin`);
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

function collectRawChunkInfo(chunksRoot, fourCCPrefixes) {
  return readdirSync(chunksRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
    .filter((entry) => fourCCPrefixes.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => {
      const filePath = path.join(chunksRoot, entry.name);
      return {
        fileName: entry.name,
        path: relative(filePath),
        sizeBytes: statSync(filePath).size
      };
    })
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function parseVwscScore(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 24) {
    return undefined;
  }

  let position = 0;
  const header = {
    totalLength: readI32(bytes, position),
    unk1: readI32(bytes, position + 4),
    unk2: readI32(bytes, position + 8),
    entryCount: readI32(bytes, position + 12),
    unk3: readI32(bytes, position + 16),
    entrySizeSum: readI32(bytes, position + 20)
  };
  position += 24;

  if (header.entryCount < 0 || header.entryCount > 100000 || bytes.length < position + (header.entryCount + 1) * 4) {
    return undefined;
  }

  const offsets = [];
  for (let index = 0; index <= header.entryCount; index++) {
    offsets.push(readI32(bytes, position));
    position += 4;
  }

  for (let index = 0; index < offsets.length - 1; index++) {
    if (offsets[index] > offsets[index + 1]) {
      return undefined;
    }
  }

  const entries = [];
  for (let index = 0; index < header.entryCount; index++) {
    const length = offsets[index + 1] - offsets[index];
    if (length < 0 || position + length > bytes.length) {
      return undefined;
    }

    entries.push(bytes.subarray(position, position + length));
    position += length;
  }

  const frameData = entries[0] ? parseVwscFrameData(entries[0]) : undefined;
  if (!frameData) {
    return {
      header,
      entries,
      frameHeader: { frameCount: 0, framesVersion: 0, spriteRecordSize: 0, numChannels: 0, displayedChannels: 0 },
      visibleSprites: [],
      rawNonEmptyChannels: [],
      behaviorIntervals: parseVwscBehaviorIntervals(entries)
    };
  }

  return {
    header,
    entries,
    frameHeader: frameData.frameHeader,
    visibleSprites: frameData.visibleSprites,
    rawNonEmptyChannels: frameData.rawNonEmptyChannels,
    behaviorIntervals: parseVwscBehaviorIntervals(entries)
  };
}

function parseVwscFrameData(data) {
  if (data.length < 20) {
    return undefined;
  }

  let position = 0;
  const actualLength = readI32(data, position);
  const unk1 = readI32(data, position + 4);
  const frameCount = readI32(data, position + 8);
  const framesVersion = readU16(data, position + 12);
  const spriteRecordSize = readU16(data, position + 14);
  const numChannels = readU16(data, position + 16);
  const displayedChannels = readU16(data, position + 18);
  position += 20;

  const frameSize = spriteRecordSize * numChannels;
  const totalSize = frameSize * frameCount;
  if (frameCount <= 0 || spriteRecordSize < 20 || numChannels <= 0 || totalSize <= 0 || totalSize > 50_000_000) {
    return undefined;
  }

  const channelData = Buffer.alloc(totalSize);
  let frameIndex = 0;
  while (position < data.length && frameIndex < frameCount) {
    if (position + 2 > data.length) {
      break;
    }

    const recordLength = readU16(data, position);
    position += 2;
    if (recordLength === 0) {
      break;
    }

    if (frameIndex > 0) {
      const previousOffset = (frameIndex - 1) * frameSize;
      const currentOffset = frameIndex * frameSize;
      channelData.copy(channelData, currentOffset, previousOffset, previousOffset + frameSize);
    }

    const recordEnd = position + recordLength - 2;
    while (position + 4 <= recordEnd) {
      const channelSize = readU16(data, position);
      const channelOffset = readU16(data, position + 2);
      position += 4;

      if (channelSize <= 0 || position + channelSize > recordEnd) {
        break;
      }

      const destinationOffset = frameIndex * frameSize + channelOffset;
      if (destinationOffset + channelSize <= channelData.length) {
        data.copy(channelData, destinationOffset, position, position + channelSize);
      }
      position += channelSize;
    }

    position = recordEnd;
    frameIndex++;
  }

  const visibleSprites = [];
  const rawNonEmptyChannels = [];
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const channelOffset = frame * frameSize + channel * spriteRecordSize;
      if (channelOffset + 20 > channelData.length) {
        continue;
      }

      const sprite = readVwscChannelData(channelData, channelOffset, spriteRecordSize, frame + 1, channel);
      if (isVwscChannelEmpty(sprite)) {
        continue;
      }

      rawNonEmptyChannels.push(sprite);
      if (sprite.castLib > 0 && sprite.castMember > 0 && sprite.spriteType > 0) {
        visibleSprites.push(sprite);
      }
    }
  }

  return {
    frameHeader: {
      actualLength,
      unk1,
      frameCount,
      framesVersion,
      spriteRecordSize,
      numChannels,
      displayedChannels
    },
    visibleSprites,
    rawNonEmptyChannels
  };
}

function readVwscChannelData(bytes, offset, spriteRecordSize, frame, channel) {
  const spriteType = readU8(bytes, offset);
  const inkByte = readU8(bytes, offset + 1);
  const base = {
    frame,
    channel,
    spriteType,
    ink: inkByte & 0x3f,
    trails: (inkByte >> 6) & 1,
    stretch: (inkByte >> 7) & 1,
    foreColor: readU8(bytes, offset + 2),
    backColor: readU8(bytes, offset + 3),
    castLib: readU16(bytes, offset + 4),
    castMember: readU16(bytes, offset + 6),
    unk1: readU16(bytes, offset + 8),
    unk2: readU16(bytes, offset + 10),
    posY: readI16(bytes, offset + 12),
    posX: readI16(bytes, offset + 14),
    height: readU16(bytes, offset + 16),
    width: readU16(bytes, offset + 18),
    colorFlag: 0,
    blendByte: 0,
    blend: 100,
    foreColorG: 0,
    backColorG: 0,
    foreColorB: 0,
    backColorB: 0
  };

  if (spriteRecordSize >= 24) {
    base.colorFlag = (readU8(bytes, offset + 20) & 0xf0) >> 4;
    base.blendByte = readU8(bytes, offset + 21);
    base.blend = normalizeVwscBlend(base.ink, base.blendByte);
  }

  if (spriteRecordSize >= 28) {
    base.foreColorG = readU8(bytes, offset + 24);
    base.backColorG = readU8(bytes, offset + 25);
    base.foreColorB = readU8(bytes, offset + 26);
    base.backColorB = readU8(bytes, offset + 27);
  }

  return base;
}

function normalizeVwscBlend(_ink, value) {
  if (value <= 0) {
    return 100;
  }

  return Math.max(0, Math.min(100, Math.round(((255 - value) * 100) / 255)));
}

function scoreSpriteColorProps(sprite) {
  const props = {};
  if ((sprite.colorFlag & 0x1) !== 0) {
    props.fgColor = rgbHex(sprite.foreColor, sprite.foreColorG, sprite.foreColorB);
  }
  if ((sprite.colorFlag & 0x2) !== 0) {
    props.bgColor = rgbHex(sprite.backColor, sprite.backColorG, sprite.backColorB);
  }

  return props;
}

function rgbHex(red, green, blue) {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}

function hexByte(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function isVwscChannelEmpty(sprite) {
  return sprite.spriteType === 0
    && sprite.ink === 0
    && sprite.foreColor === 0
    && sprite.backColor === 0
    && sprite.castLib === 0
    && sprite.castMember === 0
    && sprite.posX === 0
    && sprite.posY === 0
    && sprite.width === 0
    && sprite.height === 0;
}

function parseVwscBehaviorIntervals(entries) {
  const intervals = [];
  let index = 2;

  while (index < entries.length) {
    const entry = entries[index];
    if (!entry || entry.length === 0) {
      index++;
      continue;
    }

    if (entry.length >= 44 && entry.length <= 52) {
      const primary = {
        startFrame: readI32(entry, 0),
        endFrame: readI32(entry, 4),
        unk0: readI32(entry, 8),
        unk1: readI32(entry, 12),
        channel: readI32(entry, 16),
        unk2: readU16(entry, 20),
        unk3: readI32(entry, 22),
        unk4: readU16(entry, 26),
        unk5: readI32(entry, 28),
        unk6: readI32(entry, 32),
        unk7: readI32(entry, 36),
        unk8: readI32(entry, 40)
      };

      let secondaryIndex = index + 1;
      const behaviors = [];
      while (secondaryIndex < entries.length) {
        const secondary = entries[secondaryIndex];
        if (!secondary || secondary.length < 8 || secondary.length % 8 !== 0) {
          break;
        }

        let foundBehavior = false;
        for (let offset = 0; offset < secondary.length; offset += 8) {
          const castLib = readU16(secondary, offset);
          const member = readU16(secondary, offset + 2);
          const unk0 = readI32(secondary, offset + 4);
          if (castLib > 0 && member > 0) {
            behaviors.push({
              castLib,
              member,
              unk0,
              ...(isVwscBehaviorPropertyEntry(entries[unk0]) ? { propertiesEntry: unk0 } : {})
            });
            foundBehavior = true;
          }
        }

        if (!foundBehavior) {
          break;
        }

        secondaryIndex++;
      }

      if (behaviors.length === 0) {
        intervals.push({ ...primary, behaviors: [] });
      } else {
        intervals.push(...behaviors.map((behavior) => ({ ...primary, behaviors: [behavior] })));
      }

      index = secondaryIndex;
      continue;
    }

    index++;
  }

  return intervals;
}

function isVwscBehaviorPropertyEntry(entry) {
  if (!entry || entry.length === 0) {
    return false;
  }

  const text = stripTrailingNulls(entry.toString("utf8")).trim();
  return text.startsWith("[#") && text.endsWith("]");
}

function parseVwscBehaviorPropertyListEntry(entry) {
  if (!isVwscBehaviorPropertyEntry(entry)) {
    return undefined;
  }

  const text = stripTrailingNulls(entry.toString("utf8")).trim();
  const body = text.slice(1, -1);
  const properties = {};
  for (const part of splitLingoListItems(body)) {
    const separator = part.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const rawKey = part.slice(0, separator).trim();
    const key = rawKey.startsWith("#") ? rawKey.slice(1) : rawKey;
    if (!key) {
      continue;
    }

    properties[key] = parseLingoPropertyValue(part.slice(separator + 1).trim());
  }

  return Object.keys(properties).length > 0 ? { properties, raw: text } : undefined;
}

function splitLingoListItems(value) {
  const items = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      inString = !inString;
      current += char;
      continue;
    }

    if (char === "," && !inString) {
      items.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    items.push(current.trim());
  }

  return items;
}

function parseLingoPropertyValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  if (value.startsWith("#")) {
    return value;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if (value.toUpperCase() === "TRUE") {
    return true;
  }

  if (value.toUpperCase() === "FALSE") {
    return false;
  }

  return value;
}

function stripTrailingNulls(value) {
  return value.replace(/\0+$/g, "");
}

function parseVwlbMarkers(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 4) {
    return undefined;
  }

  const count = readU16(bytes, 0);
  const tableStart = 2;
  const tableBytes = count * 4;
  const namesLengthOffset = tableStart + tableBytes;
  const namesStart = namesLengthOffset + 4;
  if (count <= 0 || namesStart > bytes.length) {
    return undefined;
  }

  const namesLength = readI32(bytes, namesLengthOffset);
  if (namesLength < 0 || namesStart + namesLength > bytes.length) {
    return undefined;
  }

  const names = bytes.subarray(namesStart, namesStart + namesLength).toString("latin1");
  const markers = [];
  for (let index = 0; index < count; index++) {
    const entryOffset = tableStart + (index * 4);
    const frame = readU16(bytes, entryOffset);
    const nameOffset = readU16(bytes, entryOffset + 2);
    const nextNameOffset = index + 1 < count
      ? readU16(bytes, tableStart + ((index + 1) * 4) + 2)
      : names.length;
    if (frame <= 0 || nameOffset < 0 || nameOffset >= names.length || nextNameOffset < nameOffset) {
      return undefined;
    }

    const name = names.slice(nameOffset, nextNameOffset).trim();
    if (name.length > 0) {
      markers.push({ name, frame });
    }
  }

  return markers;
}

function findFirstChunkBin(chunksRoot, fourCCPrefix) {
  if (!existsSync(chunksRoot)) {
    return undefined;
  }

  const fileName = readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith(`${fourCCPrefix}-`) && entry.endsWith(".bin"))
    .sort()[0];

  return fileName ? path.join(chunksRoot, fileName) : undefined;
}

function readFirstChunkJson(chunksRoot, fourCCPrefix) {
  const chunk = readFirstOptionalChunkJson(chunksRoot, fourCCPrefix);
  if (!chunk) {
    throw new Error(`Missing ${fourCCPrefix} JSON chunk under ${chunksRoot}`);
  }

  return chunk;
}

function readFirstOptionalChunkJson(chunksRoot, fourCCPrefix) {
  if (!existsSync(chunksRoot)) {
    return undefined;
  }

  const fileName = readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith(`${fourCCPrefix}-`) && entry.endsWith(".json"))
    .sort()[0];

  if (!fileName) {
    return undefined;
  }

  return readProjectorRaysJson(path.join(chunksRoot, fileName));
}

function stageColor(drcf) {
  if (drcf.D7stageColorIsRGB) {
    return rgb(drcf.D7stageColorR ?? 0, drcf.D7stageColorG ?? 0, drcf.D7stageColorB ?? 0);
  }

  return "#000000";
}

function rgb(red, green, blue) {
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function hex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function toByte(value) {
  return Math.max(0, Math.min(255, Math.round(value / 257)));
}

function readU8(bytes, offset) {
  return bytes[offset] ?? 0;
}

function readU16(bytes, offset) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readI16(bytes, offset) {
  const unsigned = readU16(bytes, offset);
  return unsigned > 0x7fff ? unsigned - 0x10000 : unsigned;
}

function readI32(bytes, offset) {
  return ((bytes[offset] ?? 0) << 24)
    | ((bytes[offset + 1] ?? 0) << 16)
    | ((bytes[offset + 2] ?? 0) << 8)
    | (bytes[offset + 3] ?? 0);
}

function readU32(bytes, offset) {
  return (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)) >>> 0;
}

function positiveOrUndefined(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeDirectorFileName(filePath) {
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : undefined;
  return fileName || undefined;
}

function stemFromDirectorPath(filePath) {
  const fileName = normalizeDirectorFileName(filePath);
  return fileName ? fileName.replace(/\.[^.]+$/, "") : undefined;
}

function normalizeCastDirectoryName(name) {
  return name ? name.replace(/\s+\d+$/, "") : undefined;
}

function normalizeName(value) {
  return String(value).toLowerCase();
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
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
      case "--output-root":
        parsed.outputRoot = requireNext(rawArgs, ++index, arg);
        break;
      case "--bitmap-asset-root":
        parsed.bitmapAssetRoot = requireNext(rawArgs, ++index, arg);
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
