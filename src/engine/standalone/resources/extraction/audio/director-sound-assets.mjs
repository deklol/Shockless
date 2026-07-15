import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDirectorKeyEntries } from "../director-bitd-recovery.mjs";
import {
  createPcmWave,
  parseDirectorEdimSound,
  parseDirectorSndSound,
  sha256,
} from "./director-sound-formats.mjs";

const SOUND_FOURCCS = new Set(["ediM", "snd "]);

class SoundExtractionError extends Error {
  constructor(code, message, source) {
    super(message);
    this.name = "SoundExtractionError";
    this.code = code;
    this.source = source;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const version = requiredArg(args, "version");
  const runtimeDataRoot = path.resolve(requiredArg(args, "runtime-data-root"));
  const result = buildDirectorSoundAssets({
    profileRoot: process.cwd(),
    version,
    manifestPath: args.manifest ?? path.join(runtimeDataRoot, `${version}-projectorrays-manifest.json`),
    externalCastGraphPath: args["external-cast-graph"] ?? path.join(runtimeDataRoot, `external-cast-graph.${version}.json`),
    runtimeDataRoot,
    assetsRoot: requiredArg(args, "asset-root"),
    assetPathBase: args["asset-path-base"] ?? requiredArg(args, "asset-root"),
    outputPath: args.out ?? path.join(runtimeDataRoot, `sound-assets.${version}.json`),
  });
  console.log(`Materialized ${result.soundCount.toLocaleString()} Director sound asset(s).`);
  console.log(`Sound index: ${path.relative(process.cwd(), args.out ?? path.join(runtimeDataRoot, `sound-assets.${version}.json`))}`);
}

export function buildDirectorSoundAssets(options) {
  const profileRoot = path.resolve(options.profileRoot ?? process.cwd());
  const manifestPath = path.resolve(options.manifestPath);
  const runtimeDataRoot = path.resolve(options.runtimeDataRoot ?? path.dirname(manifestPath));
  const assetsRoot = path.resolve(options.assetsRoot);
  const assetPathBase = path.resolve(options.assetPathBase ?? assetsRoot);
  const version = String(options.version);
  const outputPath = path.resolve(options.outputPath ?? path.join(runtimeDataRoot, `sound-assets.${version}.json`));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const externalCastGraphPath = path.resolve(
    options.externalCastGraphPath ?? path.join(runtimeDataRoot, `external-cast-graph.${version}.json`),
  );
  const externalCastGraph = existsSync(externalCastGraphPath)
    ? JSON.parse(readFileSync(externalCastGraphPath, "utf8"))
    : null;
  const records = [];
  const unsupported = [];
  const diagnostics = [];
  const soundMembers = reconcileSoundMembers(
    movieSoundMembers(manifest),
    externalSoundMembers(externalCastGraph, version),
  );

  for (const entry of soundMembers) {
      const { cast, member, castName, sourceKind } = entry;
      const identity = soundIdentity(version, cast, member, castName, profileRoot, sourceKind);
      try {
        const source = resolveSoundSource(profileRoot, { ...member, sourceMemberChunkPath: entry.sourceMemberChunkPath }, castName);
        const sourceBytes = readFileSync(source.path);
        const parsed = source.fourCC === "ediM"
          ? parseDirectorEdimSound(sourceBytes, `${castName}:${member.name ?? member.number}`)
          : parseDirectorSndSound(sourceBytes, `${castName}:${member.name ?? member.number}`);
        const extension = parsed.codec === "mp3" ? "mp3" : "wav";
        const outputBytes = parsed.codec === "mp3" ? Buffer.from(parsed.payload) : createPcmWave(parsed);
        const fileName = `${String(member.number).padStart(4, "0")}-${safeName(member.name ?? `sound-${member.number}`)}.${extension}`;
        const outputFile = path.join(assetsRoot, version, safeName(castName), fileName);
        mkdirSync(path.dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, outputBytes);
        const assetPath = relativePosix(assetPathBase, outputFile);

        const record = {
          ...identity,
          mediaType: "sound",
          container: parsed.container,
          codec: parsed.codec,
          sampleRate: parsed.sampleRate,
          channels: parsed.channels,
          sampleSize: parsed.sampleSize,
          sampleCount: parsed.sampleCount,
          durationMs: parsed.durationMs,
          loopStart: parsed.loopStart,
          loopEnd: parsed.loopEnd,
          assetPath,
          assetBytes: outputBytes.length,
          assetSha256: sha256(outputBytes),
          source: {
            fourCC: source.fourCC,
            sectionId: source.sectionId,
            path: relativePosix(profileRoot, source.path),
            bytes: sourceBytes.length,
            sha256: sha256(sourceBytes),
            payloadOffset: parsed.payloadOffset ?? null,
          },
          director: parsed.directorHeader ?? null,
        };
        records.push(record);
        member.assetPath = assetPath;
        member.sound = {
          container: record.container,
          codec: record.codec,
          sampleRate: record.sampleRate,
          channels: record.channels,
          sampleSize: record.sampleSize,
          sampleCount: record.sampleCount,
          durationMs: record.durationMs,
          loopStart: record.loopStart,
          loopEnd: record.loopEnd,
          assetPath: record.assetPath,
          assetSha256: record.assetSha256,
          sourceFourCC: source.fourCC,
        };
        if ((parsed.trailingBytes ?? 0) > 0) {
          diagnostics.push({
            severity: "info",
            code: "source-trailing-bytes",
            id: record.id,
            bytes: parsed.trailingBytes,
          });
        }
      } catch (error) {
        const failure = soundFailure(error);
        unsupported.push({
          ...identity,
          mediaType: "sound",
          code: failure.code,
          reason: failure.reason,
          source: failure.source ?? null,
        });
      }
  }

  const declaredCount = soundMembers.length;
  if (records.length + unsupported.length !== declaredCount) {
    throw new Error(
      `Sound inventory accounted for ${records.length + unsupported.length} of ${declaredCount} declared sound members.`,
    );
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (externalCastGraph) {
    writeFileSync(externalCastGraphPath, `${JSON.stringify(externalCastGraph, null, 2)}\n`, "utf8");
  }
  const index = {
    schemaVersion: 3,
    generator: "director-sound-assets.mjs",
    versionId: version,
    release: version,
    manifestPath: relativePosix(profileRoot, manifestPath),
    assetRoot: relativePosix(profileRoot, assetsRoot),
    declaredSoundCount: declaredCount,
    movieSoundCount: soundMembers.filter((entry) => entry.sourceKind === "movie").length,
    externalSoundCount: soundMembers.filter((entry) => entry.sourceKind === "external").length,
    soundCount: records.length,
    unsupportedCount: unsupported.length,
    diagnostics,
    unsupported,
    sounds: records,
  };
  writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

function movieSoundMembers(manifest) {
  const entries = [];
  for (const cast of [...(manifest.casts ?? [])].sort((a, b) => Number(a.number) - Number(b.number))) {
    const castName = String(cast.name ?? `cast-${cast.number}`);
    for (const member of [...(cast.members ?? [])].sort((a, b) => Number(a.number) - Number(b.number))) {
      if (member.type !== "sound") continue;
      entries.push({ cast, member, castName, sourceKind: "movie", sourceMemberChunkPath: member.sourceMemberChunkPath });
    }
  }
  return entries;
}

function externalSoundMembers(graph, version) {
  if (!graph) return [];
  const releases = Array.isArray(graph.releases) ? graph.releases : Object.values(graph.releases ?? {});
  const matching = releases.filter((release) => {
    const identity = String(release?.versionId ?? release?.release ?? "");
    return identity.length === 0 || identity === version;
  });
  const entries = [];
  for (const release of matching) {
    const casts = [...(release?.casts ?? [])].sort(
      (left, right) => Number(left.order) - Number(right.order) || String(left.name ?? "").localeCompare(String(right.name ?? "")),
    );
    for (const cast of casts) {
      const castName = String(cast.name ?? `external-cast-${cast.order}`);
      for (const member of [...(cast.members ?? [])].sort((a, b) => Number(a.number) - Number(b.number))) {
        if (member.type !== "sound") continue;
        const extractionRoot = String(cast.expectedExtractionRoot ?? "").replace(/\\/g, "/").replace(/\/$/, "");
        const sourceMemberChunkPath = extractionRoot && Number.isInteger(member.memberChunkId)
          ? `${extractionRoot}/chunks/CASt-${member.memberChunkId}.json`
          : null;
        entries.push({
          cast: { ...cast, number: cast.order },
          member,
          castName,
          sourceKind: "external",
          sourceMemberChunkPath,
        });
      }
    }
  }
  return entries;
}

function reconcileSoundMembers(movieMembers, externalMembers) {
  const movieByKey = new Map();
  for (const entry of movieMembers) {
    const key = soundMemberKey(entry.castName, entry.member.number);
    const matches = movieByKey.get(key) ?? [];
    matches.push(entry);
    movieByKey.set(key, matches);
  }

  const uniqueExternal = [];
  for (const entry of externalMembers) {
    const key = soundMemberKey(entry.castName, entry.member.number);
    const matches = movieByKey.get(key) ?? [];
    if (matches.length === 0) {
      uniqueExternal.push(entry);
      continue;
    }
    if (matches.length > 1) {
      throw new Error(
        `External sound ${entry.castName}#${entry.member.number} matches ${matches.length} movie cast members.`,
      );
    }
    assertMatchingSoundDeclarations(matches[0], entry);
    delete entry.member.sound;
    delete entry.member.assetPath;
  }
  return [...movieMembers, ...uniqueExternal];
}

function assertMatchingSoundDeclarations(movieEntry, externalEntry) {
  const movieName = normalizedDirectorName(movieEntry.member.name);
  const externalName = normalizedDirectorName(externalEntry.member.name);
  const movieChunk = Number(movieEntry.member.memberChunkId);
  const externalChunk = Number(externalEntry.member.memberChunkId);
  if (movieName !== externalName || movieChunk !== externalChunk) {
    throw new Error(
      `Conflicting Director sound declarations for ${externalEntry.castName}#${externalEntry.member.number}: ` +
      `movie=${movieEntry.member.name ?? ""}/CASt-${movieEntry.member.memberChunkId ?? "?"}, ` +
      `external=${externalEntry.member.name ?? ""}/CASt-${externalEntry.member.memberChunkId ?? "?"}.`,
    );
  }
}

function soundMemberKey(castName, memberNumber) {
  return `${normalizedDirectorName(castName)}:${Number(memberNumber)}`;
}

function normalizedDirectorName(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

function soundIdentity(version, cast, member, castName, profileRoot, sourceKind = "movie") {
  const castOrder = Number(cast.number ?? cast.order);
  return {
    id: sourceKind === "external"
      ? `${version}:external:${castOrder}:${safeName(castName)}:${member.number}`
      : `${version}:${castOrder}:${member.number}`,
    versionId: version,
    release: version,
    sourceKind,
    castName,
    castOrder,
    member: Number(member.number),
    memberChunkId: Number.isInteger(member.memberChunkId) ? Number(member.memberChunkId) : null,
    memberName: String(member.name ?? ""),
    sourceMemberChunkPath: member.sourceMemberChunkPath
      ? relativePosix(profileRoot, path.resolve(profileRoot, member.sourceMemberChunkPath))
      : null,
  };
}

function soundFailure(error) {
  if (error instanceof SoundExtractionError) {
    return { code: error.code, reason: error.message, source: error.source };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { code: "unsupported-sound-resource", reason };
}

function resolveSoundSource(profileRoot, member, castName) {
  if (!Number.isInteger(member.memberChunkId) || !member.sourceMemberChunkPath) {
    throw new SoundExtractionError(
      "missing-sound-source-identity",
      `${castName}:${member.name ?? member.number}: sound member lacks source chunk identity.`,
    );
  }
  const memberPath = path.resolve(profileRoot, member.sourceMemberChunkPath);
  const chunksRoot = path.dirname(memberPath);
  const associations = readDirectorKeyEntries(chunksRoot)
    .filter((entry) => entry.castID === member.memberChunkId && SOUND_FOURCCS.has(entry.fourCC))
    .map((entry) => ({
      ...entry,
      path: locateChunk(chunksRoot, entry.fourCC, entry.sectionID),
    }))
    .filter((entry) => entry.path !== null);
  if (associations.length === 0) {
    throw new SoundExtractionError(
      "missing-linked-sound-resource",
      `${castName}:${member.name ?? member.number}: no existing ediM or snd resource is linked by KEY.`,
    );
  }
  if (associations.length > 1) {
    const sources = associations.map((entry) => `${entry.fourCC}-${entry.sectionID}`).join(", ");
    throw new SoundExtractionError(
      "ambiguous-linked-sound-resource",
      `${castName}:${member.name ?? member.number}: multiple sound resources are present (${sources}); selection is [UNKNOWN].`,
      { candidates: associations.map((entry) => ({ fourCC: entry.fourCC, sectionId: entry.sectionID })) },
    );
  }
  return {
    fourCC: associations[0].fourCC,
    sectionId: associations[0].sectionID,
    path: associations[0].path,
  };
}

function locateChunk(chunksRoot, fourCC, sectionId) {
  for (const fileName of [`${fourCC}-${sectionId}.bin`, `${fourCC}_${sectionId}.bin`]) {
    const candidate = path.join(chunksRoot, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function safeName(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "unnamed";
}

function relativePosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) throw new Error(`Missing required --${key} argument.`);
  return value;
}
