import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const keyEntryCache = new Map();
const orphanBitdCache = new Map();
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

export function resolveBitmapBitdSource(chunksRoot, memberChunkId, bitmap) {
  const keyEntry = readDirectorKeyEntries(chunksRoot).find(
    (entry) => entry.castID === memberChunkId && entry.fourCC === "BITD",
  );
  if (keyEntry) {
    return bitdSource(chunksRoot, keyEntry.sectionID, "key", 1, [keyEntry.sectionID]);
  }

  const expectedBytes = expectedBitmapSourceBytes(bitmap);
  if (expectedBytes <= 0) {
    return undefined;
  }

  const duplicateKeyed = keyedSameNameBitmapDuplicate(chunksRoot, memberChunkId, bitmap, expectedBytes);
  if (duplicateKeyed) {
    return bitdSource(
      chunksRoot,
      duplicateKeyed.sectionID,
      "keyed-same-name-bitmap-member",
      duplicateKeyed.candidateCount,
      duplicateKeyed.candidateSectionIds,
    );
  }

  const candidates = orphanBitdEntries(chunksRoot).filter((entry) => bitdMatchesExpectedBytes(entry, expectedBytes));
  if (candidates.length !== 1) {
    const casOrdered = casOrderedOrphanCandidate(chunksRoot, memberChunkId, expectedBytes, candidates);
    if (casOrdered) {
      return bitdSource(
        chunksRoot,
        casOrdered.sectionID,
        `${casOrdered.sourceKind}-${casOrdered.rawBytes === expectedBytes ? "raw" : "packbits"}-exact-length`,
        candidates.length,
        candidates.map((entry) => entry.sectionID),
      );
    }

    const numericSeriesOrdered = casNumericSeriesOrphanCandidate(chunksRoot, memberChunkId);
    if (numericSeriesOrdered) {
      return bitdSource(
        chunksRoot,
        numericSeriesOrdered.sectionID,
        `${numericSeriesOrdered.sourceKind}-${numericSeriesOrdered.rawBytes === expectedBytes ? "raw" : "packbits"}-exact-length`,
        numericSeriesOrdered.candidateCount,
        numericSeriesOrdered.candidateSectionIds,
      );
    }

    const variantRunOrdered = casVariantRunOrphanCandidate(chunksRoot, memberChunkId);
    if (variantRunOrdered) {
      return bitdSource(
        chunksRoot,
        variantRunOrdered.sectionID,
        `${variantRunOrdered.sourceKind}-${variantRunOrdered.rawBytes === expectedBytes ? "raw" : "packbits"}-exact-length`,
        variantRunOrdered.candidateCount,
        variantRunOrdered.candidateSectionIds,
      );
    }

    return candidates.length > 0
      ? {
          kind: "orphan-ambiguous",
          candidateCount: candidates.length,
          candidateSectionIds: candidates.map((entry) => entry.sectionID),
        }
      : undefined;
  }

  return bitdSource(
    chunksRoot,
    candidates[0].sectionID,
    candidates[0].rawBytes === expectedBytes ? "orphan-raw-exact-length" : "orphan-packbits-exact-length",
    candidates.length,
    candidates.map((entry) => entry.sectionID),
  );
}

export function readDirectorKeyEntries(chunksRoot) {
  const cacheKey = path.resolve(chunksRoot);
  const cached = keyEntryCache.get(cacheKey);
  if (cached) return cached;

  if (!existsSync(chunksRoot)) {
    keyEntryCache.set(cacheKey, []);
    return [];
  }

  const entries = [];
  const seen = new Set();
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^KEY_.*\.json$/i.test(entry)).sort()) {
    try {
      const json = JSON.parse(readFileSync(path.join(chunksRoot, fileName), "utf8"));
      for (const entry of json.entries ?? []) {
        addKeyEntry(entries, seen, Number(entry.sectionID), Number(entry.castID), String(entry.fourCC ?? ""));
      }
    } catch {
      // Some ProjectorRays KEY JSON dumps contain raw escaped control bytes.
      // The binary KEY chunk remains the authoritative source below.
    }
  }
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^KEY_.*\.bin$/i.test(entry)).sort()) {
    const bytes = readFileSync(path.join(chunksRoot, fileName));
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

  keyEntryCache.set(cacheKey, entries);
  return entries;
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

export function expectedBitmapSourceBytes(bitmap) {
  const width = Math.max(0, Number(bitmap?.width) || 0);
  const height = Math.max(0, Number(bitmap?.height) || 0);
  const bitDepth = Math.max(0, Number(bitmap?.bitDepth) || 0);
  const pitch = Math.max(0, Number(bitmap?.pitch) || Math.ceil((width * bitDepth) / 8));
  return pitch * height;
}

export function recoverBitmapMetadataFromCastOrder(chunksRoot, memberChunkId) {
  const targetInfo = readCastMemberInfo(chunksRoot, memberChunkId);
  const targetSeries = numericMemberSeries(targetInfo?.name);
  if (targetInfo?.type !== 1 || !targetSeries) return undefined;

  for (const registry of readCastRegistries(chunksRoot)) {
    const registryMemberIds = registry.memberIDs ?? [];
    const registryIndex = registryMemberIds.indexOf(memberChunkId);
    if (registryIndex < 0) continue;

    const seriesMembers = [];
    for (const id of registryMemberIds) {
      const info = readCastMemberInfo(chunksRoot, id);
      const series = numericMemberSeries(info?.name);
      if (info?.type !== 1 || !series || series.prefix !== targetSeries.prefix) continue;
      seriesMembers.push({
        memberChunkId: id,
        registryIndex: registryMemberIds.indexOf(id),
        info,
        bitmap: readCastBitmapMetadata(chunksRoot, id),
      });
    }

    const malformedMembers = seriesMembers.filter((member) => expectedBitmapSourceBytes(member.bitmap) <= 0);
    if (!malformedMembers.some((member) => member.memberChunkId === memberChunkId)) continue;

    const validGroups = new Map();
    for (const member of seriesMembers) {
      const expectedBytes = expectedBitmapSourceBytes(member.bitmap);
      if (expectedBytes <= 0) continue;
      const key = bitmapGeometryKey(member.bitmap);
      const group = validGroups.get(key) ?? { bitmap: member.bitmap, members: [] };
      group.members.push(member);
      validGroups.set(key, group);
    }

    const plans = [];
    for (const group of validGroups.values()) {
      const expectedBytes = expectedBitmapSourceBytes(group.bitmap);
      const candidates = orphanBitdEntries(chunksRoot).filter((entry) => bitdMatchesExpectedBytes(entry, expectedBytes));
      const clusters = sameSizedCandidateClusters(candidates);
      const clusterWithMalformed = clusters.find(
        (cluster) => cluster.length === group.members.length + malformedMembers.length,
      );
      const clusterWithoutMalformed = clusters.find((cluster) => cluster.length === group.members.length);
      if (!clusterWithMalformed || clusterWithoutMalformed) continue;
      plans.push({ group, cluster: clusterWithMalformed });
    }

    if (plans.length !== 1) continue;

    const plan = plans[0];
    const orderedMembers = [...plan.group.members, ...malformedMembers].sort(
      (left, right) => left.registryIndex - right.registryIndex,
    );
    const recoveredIndex = orderedMembers.findIndex((member) => member.memberChunkId === memberChunkId);
    if (recoveredIndex < 0 || recoveredIndex >= plan.cluster.length) continue;

    return {
      ...plan.group.bitmap,
      metadataSource: "cas-order-recovered-neighbor-bitmap",
      recoveredFromMemberChunkIds: plan.group.members.map((member) => member.memberChunkId),
      recoveredSeriesPrefix: targetSeries.prefix,
    };
  }

  return undefined;
}

export function packBitsDecodedLength(source) {
  let sourceOffset = 0;
  let decodedBytes = 0;
  while (sourceOffset < source.length) {
    const control = source[sourceOffset++] ?? 0;
    if (control < 0x80) {
      const count = control + 1;
      if (sourceOffset + count > source.length) {
        return { decodedBytes, valid: false };
      }
      sourceOffset += count;
      decodedBytes += count;
    } else if (control > 0x80) {
      if (sourceOffset >= source.length) {
        return { decodedBytes, valid: false };
      }
      sourceOffset += 1;
      decodedBytes += 257 - control;
    }
  }
  return { decodedBytes, valid: sourceOffset === source.length };
}

function orphanBitdEntries(chunksRoot) {
  const cacheKey = path.resolve(chunksRoot);
  const cached = orphanBitdCache.get(cacheKey);
  if (cached) return cached;

  if (!existsSync(chunksRoot)) {
    orphanBitdCache.set(cacheKey, []);
    return [];
  }

  const claimedBitdSectionIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "BITD")
      .map((entry) => entry.sectionID),
  );
  const entries = [];
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^BITD-\d+\.bin$/i.test(entry)).sort(numericChunkSort)) {
    const sectionID = Number(fileName.match(/^BITD-(\d+)\.bin$/i)?.[1] ?? 0);
    if (!sectionID || claimedBitdSectionIds.has(sectionID)) continue;
    const bitdPath = path.join(chunksRoot, fileName);
    const source = readFileSync(bitdPath);
    const packBits = packBitsDecodedLength(source);
    entries.push({
      sectionID,
      bitdPath,
      rawBytes: source.length,
      packBitsBytes: packBits.decodedBytes,
      packBitsValid: packBits.valid,
    });
  }

  orphanBitdCache.set(cacheKey, entries);
  return entries;
}

function bitdMatchesExpectedBytes(entry, expectedBytes) {
  return entry.rawBytes === expectedBytes || (entry.rawBytes < expectedBytes && entry.packBitsValid && entry.packBitsBytes === expectedBytes);
}

function keyedSameNameBitmapDuplicate(chunksRoot, memberChunkId, bitmap, expectedBytes) {
  const targetInfo = readCastMemberInfo(chunksRoot, memberChunkId);
  const targetName = normalizedMemberName(targetInfo?.name);
  if (targetInfo?.type !== 1 || targetName === "") return undefined;

  const bitdKeyEntries = readDirectorKeyEntries(chunksRoot).filter((entry) => entry.fourCC === "BITD");
  if (bitdKeyEntries.length === 0) return undefined;

  const keyedByCastId = new Map();
  for (const entry of bitdKeyEntries) {
    const existing = keyedByCastId.get(entry.castID);
    if (!existing) {
      keyedByCastId.set(entry.castID, [entry]);
    } else {
      existing.push(entry);
    }
  }

  const candidates = [];
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^CASt-\d+\.json$/i.test(entry)).sort(numericChunkSort)) {
    const otherMemberChunkId = Number(fileName.match(/^CASt-(\d+)\.json$/i)?.[1] ?? 0);
    if (!otherMemberChunkId || otherMemberChunkId === memberChunkId) continue;

    const info = readCastMemberInfo(chunksRoot, otherMemberChunkId);
    if (info?.type !== 1 || normalizedMemberName(info.name) !== targetName) continue;

    const otherBitmap = readCastBitmapMetadata(chunksRoot, otherMemberChunkId);
    if (!sameBitmapSourceGeometry(bitmap, otherBitmap, expectedBytes)) continue;

    for (const keyEntry of keyedByCastId.get(otherMemberChunkId) ?? []) {
      candidates.push(keyEntry);
    }
  }

  const uniqueSectionIds = [...new Set(candidates.map((entry) => entry.sectionID))].sort((left, right) => left - right);
  if (uniqueSectionIds.length !== 1) return undefined;

  return {
    sectionID: uniqueSectionIds[0],
    candidateCount: candidates.length,
    candidateSectionIds: uniqueSectionIds,
  };
}

function sameBitmapSourceGeometry(left, right, expectedBytes) {
  if (!left || !right) return false;
  if (expectedBitmapSourceBytes(right) !== expectedBytes) return false;
  if (Number(left.width) !== Number(right.width)) return false;
  if (Number(left.height) !== Number(right.height)) return false;
  if (Number(left.bitDepth) !== Number(right.bitDepth)) return false;
  if (Number(left.pitch) !== Number(right.pitch)) return false;
  if (Number(left.regPoint?.x ?? 0) !== Number(right.regPoint?.x ?? 0)) return false;
  if (Number(left.regPoint?.y ?? 0) !== Number(right.regPoint?.y ?? 0)) return false;
  return true;
}

function casOrderedOrphanCandidate(chunksRoot, memberChunkId, expectedBytes, candidates) {
  if (candidates.length < 2) return undefined;

  const clusters = sameSizedCandidateClusters(candidates);
  const registries = readCastRegistries(chunksRoot);
  for (const registry of registries) {
    const sameSizedMembers = sameSizedUnkeyedBitmapMembers(chunksRoot, registry, expectedBytes);
    const memberIndex = sameSizedMembers.findIndex((member) => member.memberChunkId === memberChunkId);
    if (memberIndex < 0) continue;
    const coherence = casOrderBitmapGroupCoherence(sameSizedMembers);
    if (!coherence) continue;

    const exactCluster = clusters.find((cluster) => cluster.length === sameSizedMembers.length);
    const rankedCandidates = exactCluster;
    if (!rankedCandidates || memberIndex >= rankedCandidates.length) continue;
    return {
      ...rankedCandidates[memberIndex],
      sourceKind: casOrderSourceKind(coherence),
    };
  }

  return undefined;
}

function casNumericSeriesOrphanCandidate(chunksRoot, memberChunkId) {
  const keyedBitdChunkIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "BITD")
      .map((entry) => entry.castID),
  );

  for (const registry of readCastRegistries(chunksRoot)) {
    const entries = (registry.memberIDs ?? []).map((id, registryIndex) => {
      if (!id || keyedBitdChunkIds.has(id) || readCastMemberType(chunksRoot, id) !== 1) return undefined;
      const info = readCastMemberInfo(chunksRoot, id);
      const series = numericMemberSeries(info?.name);
      const bitmap = readCastBitmapMetadata(chunksRoot, id) ?? recoverBitmapMetadataFromCastOrder(chunksRoot, id);
      const expectedBytes = expectedBitmapSourceBytes(bitmap);
      if (!series || !bitmap || expectedBytes <= 0) return undefined;
      return { registryIndex, memberChunkId: id, series, expectedBytes };
    });

    const targetIndex = entries.findIndex((entry) => entry?.memberChunkId === memberChunkId);
    const target = targetIndex >= 0 ? entries[targetIndex] : undefined;
    if (!target) continue;

    let start = targetIndex;
    while (start > 0 && entries[start - 1]?.series.prefix === target.series.prefix) start -= 1;
    let end = targetIndex;
    while (end + 1 < entries.length && entries[end + 1]?.series.prefix === target.series.prefix) end += 1;

    const run = entries.slice(start, end + 1);
    if (run.length < 2 || run.some((entry) => !entry)) continue;
    if (!run.every((entry, index) => index === 0 || entry.series.index === run[index - 1].series.index + 1)) continue;

    const windows = matchingOrphanCandidateRunWindows(chunksRoot, run.map((entry) => entry.expectedBytes));
    if (windows.length !== 1) continue;

    const targetRunIndex = targetIndex - start;
    const window = windows[0];
    return {
      ...window[targetRunIndex],
      sourceKind: "orphan-cas-numeric-series-order",
      candidateCount: window.length,
      candidateSectionIds: window.map((entry) => entry.sectionID),
    };
  }

  return undefined;
}

function casVariantRunOrphanCandidate(chunksRoot, memberChunkId) {
  const keyedBitdChunkIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "BITD")
      .map((entry) => entry.castID),
  );

  for (const registry of readCastRegistries(chunksRoot)) {
    const entries = [];
    for (const [registryIndex, id] of (registry.memberIDs ?? []).entries()) {
      if (!id || keyedBitdChunkIds.has(id) || readCastMemberType(chunksRoot, id) !== 1) {
        entries.push(undefined);
        continue;
      }

      const info = readCastMemberInfo(chunksRoot, id);
      const variantKey = variantRunKey(info?.name);
      const bitmap = readCastBitmapMetadata(chunksRoot, id) ?? recoverBitmapMetadataFromCastOrder(chunksRoot, id);
      if (!variantKey || !bitmap || expectedBitmapSourceBytes(bitmap) <= 0) {
        entries.push(undefined);
        continue;
      }

      entries.push({
        registryIndex,
        memberChunkId: id,
        name: info?.name ?? "",
        variantKey,
        bitmap,
        expectedBytes: expectedBitmapSourceBytes(bitmap),
      });
    }

    const targetIndex = entries.findIndex((entry) => entry?.memberChunkId === memberChunkId);
    const target = targetIndex >= 0 ? entries[targetIndex] : undefined;
    if (!target) continue;

    let start = targetIndex;
    while (start > 0 && entries[start - 1]?.variantKey === target.variantKey) start -= 1;
    let end = targetIndex;
    while (end + 1 < entries.length && entries[end + 1]?.variantKey === target.variantKey) end += 1;

    const run = entries.slice(start, end + 1);
    if (run.length < 4 || run.some((entry) => !entry)) continue;

    const expectedSequence = run.map((entry) => entry.expectedBytes);
    const windows = matchingOrphanCandidateRunWindows(chunksRoot, expectedSequence);
    if (windows.length !== 1) continue;

    const targetRunIndex = targetIndex - start;
    const window = windows[0];
    return {
      ...window[targetRunIndex],
      sourceKind: "orphan-cas-variant-run-order",
      candidateCount: window.length,
      candidateSectionIds: window.map((entry) => entry.sectionID),
    };
  }

  return undefined;
}

function matchingOrphanCandidateRunWindows(chunksRoot, expectedSequence) {
  const windows = [];
  for (const cluster of sameSizedCandidateClusters(orphanBitdEntries(chunksRoot))) {
    if (cluster.length < expectedSequence.length) continue;
    for (let offset = 0; offset + expectedSequence.length <= cluster.length; offset += 1) {
      const window = cluster.slice(offset, offset + expectedSequence.length);
      if (window.every((entry, index) => bitdMatchesExpectedBytes(entry, expectedSequence[index]))) {
        windows.push(window);
      }
    }
  }
  return windows;
}

function variantRunKey(name) {
  const normalized = normalizedMemberName(name).replace(/[\s.-]+/g, "_").replace(/_+/g, "_");
  const match = normalized.match(/_(\d+)_/);
  return match ? match[1] : "";
}

function sameSizedCandidateClusters(candidates) {
  const sorted = [...candidates].sort(compareBitdSectionId);
  const clusters = [];
  let current = [];
  for (const candidate of sorted) {
    const previous = current[current.length - 1];
    if (previous && candidate.sectionID - previous.sectionID >= 64) {
      clusters.push(current);
      current = [];
    }
    current.push(candidate);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function sameSizedUnkeyedBitmapMembers(chunksRoot, registry, expectedBytes) {
  const keyedBitdChunkIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "BITD")
      .map((entry) => entry.castID),
  );
  const members = [];
  for (const [registryIndex, memberChunkId] of (registry.memberIDs ?? []).entries()) {
    if (!memberChunkId || keyedBitdChunkIds.has(memberChunkId)) continue;
    if (readCastMemberType(chunksRoot, memberChunkId) !== 1) continue;
    const bitmap = readCastBitmapMetadata(chunksRoot, memberChunkId) ?? recoverBitmapMetadataFromCastOrder(chunksRoot, memberChunkId);
    if (!bitmap) continue;
    if (expectedBitmapSourceBytes(bitmap) !== expectedBytes) continue;
    members.push({
      registryIndex,
      memberChunkId,
      name: readCastMemberInfo(chunksRoot, memberChunkId)?.name ?? "",
    });
  }
  return members;
}

function casOrderBitmapGroupCoherence(members) {
  if (members.length < 2) return false;
  const series = members.map((member) => numericMemberSeries(member.name));
  if (!series.some((entry) => !entry)) {
    const prefixes = new Set(series.map((entry) => entry.prefix));
    if (prefixes.size === 1) return "numeric-series";
  }
  if (members.length >= 3 && areRoomBackgroundMembers(members)) {
    return "room-background-series";
  }
  if (areAdjacentRegistryMembers(members) && haveSharedMeaningfulNameStem(members)) {
    return "contiguous-name-series";
  }
  return false;
}

function casOrderSourceKind(coherence) {
  if (coherence === "numeric-series") return "orphan-cas-order";
  if (coherence === "room-background-series") return "orphan-cas-room-background-order";
  return "orphan-cas-contiguous-name-order";
}

function areAdjacentRegistryMembers(members) {
  const ordered = [...members].sort((left, right) => left.registryIndex - right.registryIndex);
  return ordered.every((member, index) => index === 0 || member.registryIndex === ordered[index - 1].registryIndex + 1);
}

function haveSharedMeaningfulNameStem(members) {
  const stems = members.map((member) => normalizedMemberStem(member.name)).filter(Boolean);
  if (stems.length !== members.length) return false;
  const first = stems[0];
  if (stems.every((stem) => stem === first)) return first.length >= 8;

  const sharedPrefix = longestSharedPrefix(stems);
  return (
    sharedPrefix.length >= 8 &&
    stems.every((stem) => {
      const suffix = stem.slice(sharedPrefix.length);
      return suffix === "" || /^[a-z]$/i.test(suffix);
    })
  );
}

function longestSharedPrefix(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let length = 0;
    const limit = Math.min(prefix.length, value.length);
    while (length < limit && prefix[length] === value[length]) length += 1;
    prefix = prefix.slice(0, length);
    if (!prefix) break;
  }
  return prefix;
}

function areRoomBackgroundMembers(members) {
  return members.every((member) => /(?:^|[_\s.-])bg$/i.test(normalizedMemberName(member.name)));
}

function normalizedMemberStem(name) {
  const normalized = normalizedMemberName(name).replace(/[\s.-]+/g, "_").replace(/_+/g, "_");
  if (!normalized) return "";
  const sideStem = normalized
    .replace(/^(left|right|top|bottom|center|front|back)(wall|floor|door|window|side)?_/i, "")
    .replace(/_(left|right|top|bottom|center|front|back)$/i, "");
  const variantStem = sideStem.replace(/_(nohotel|hotelonwall|hotel|withhotel|withouthotel)$/i, "");
  const numericStem = variantStem.replace(/_\d+$/i, "");
  return numericStem.length >= 8 ? numericStem : variantStem;
}

function readCastMemberInfo(chunksRoot, memberChunkId) {
  const jsonPath = path.join(chunksRoot, `CASt-${memberChunkId}.json`);
  if (!existsSync(jsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    return {
      type: parsed.type,
      name: parsed.info?.name ?? parsed.name ?? "",
    };
  } catch {
    return undefined;
  }
}

function normalizedMemberName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function numericMemberSeries(name) {
  const match = String(name ?? "").match(/^(.*?)(\d+)$/);
  if (!match) return undefined;
  return {
    prefix: match[1].toLowerCase(),
    index: Number(match[2]),
  };
}

function bitmapGeometryKey(bitmap) {
  return [
    bitmap.width,
    bitmap.height,
    bitmap.bitDepth,
    bitmap.pitch,
    bitmap.paletteCastLib ?? 0,
    bitmap.paletteMemberNumber ?? bitmap.paletteId ?? 0,
  ].join(":");
}

function readCastRegistries(chunksRoot) {
  if (!existsSync(chunksRoot)) return [];
  const registries = [];
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^CAS_.*\.json$/i.test(entry)).sort(numericChunkSort)) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(chunksRoot, fileName), "utf8"));
      if (Array.isArray(parsed.memberIDs)) registries.push(parsed);
    } catch {
      // Ignore malformed auxiliary registry dumps; the direct KEY and exact
      // orphan paths still cover normal assets.
    }
  }
  return registries;
}

function readCastMemberType(chunksRoot, memberChunkId) {
  const jsonPath = path.join(chunksRoot, `CASt-${memberChunkId}.json`);
  if (!existsSync(jsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")).type;
  } catch {
    return undefined;
  }
}

function readCastBitmapMetadata(chunksRoot, memberChunkId) {
  const memberPath = path.join(chunksRoot, `CASt-${memberChunkId}.bin`);
  if (!existsSync(memberPath)) return undefined;
  const chunk = readFileSync(memberPath);
  if (chunk.length < 12) return undefined;
  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (chunk.length < offset + specificDataLen || specificDataLen < 10) return undefined;
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

function compareBitdSectionId(left, right) {
  return left.sectionID - right.sectionID;
}

function bitdSource(chunksRoot, sectionID, kind, candidateCount, candidateSectionIds) {
  const bitdPath = path.join(chunksRoot, `BITD-${sectionID}.bin`);
  return {
    kind,
    sectionID,
    bitdPath,
    bitdExists: existsSync(bitdPath),
    bitdBytes: existsSync(bitdPath) ? statSync(bitdPath).size : 0,
    candidateCount,
    candidateSectionIds,
  };
}

function numericChunkSort(left, right) {
  const leftId = Number(left.match(/-(\d+)\./)?.[1] ?? 0);
  const rightId = Number(right.match(/-(\d+)\./)?.[1] ?? 0);
  return leftId - rightId || left.localeCompare(right);
}
