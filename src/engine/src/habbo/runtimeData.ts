import type { CastManifests } from "../director/members";
import type { DirectorSoundManifestMedia } from "../director/audio/media";

export type RuntimeDataRelease = {
  fields?: unknown[];
  assets?: unknown[];
  palettes?: unknown[];
  visuals?: VisualLayoutRecord[];
  casts?: ExternalCastRecord[];
};

export type RuntimeDataFile = {
  releases?: RuntimeDataRelease[] | Record<string, RuntimeDataRelease>;
};

export type VisualMemberRecord = {
  castName?: string;
  castOrder?: number;
  member?: number;
  memberName?: string;
  memberType?: string;
  mediaType?: string;
  memberChunkId?: number;
  memberChunkPath?: string;
  bitmap?: {
    width?: number;
    height?: number;
    bitDepth?: number;
    pitch?: number;
    regPoint?: { x?: number; y?: number };
    initialRect?: { top?: number; left?: number; bottom?: number; right?: number };
  };
};

export type VisualElementRecord = VisualMemberRecord & {
  resolvedMember?: VisualMemberRecord;
};

export type VisualLayoutRecord = VisualMemberRecord & {
  bitmapReferences?: VisualMemberRecord[];
  elements?: VisualElementRecord[];
};

export type GeneratedScriptRecord = {
  castFile?: string;
  scriptType?: string | null;
  memberNumber?: number | null;
  memberName?: string | null;
  module?: {
    scriptName?: string | null;
    scriptType?: string | null;
  };
};

export type BitmapPaletteSource = CastManifests["bitmaps"][number] & {
  paletteCastName?: string;
  paletteMember?: number;
  paletteName?: string;
  paletteColors?: number[];
};

export type ExternalCastRecord = {
  order?: number;
  name?: string;
  resolved?: boolean;
  members?: {
    number?: number;
    name?: string;
    type?: string;
    memberChunkId?: number;
    sourceRegistry?: string;
    supplementalRegistry?: boolean;
    sound?: DirectorSoundManifestMedia;
  }[];
};

export function firstRelease(raw: RuntimeDataFile): RuntimeDataRelease {
  const releases = raw.releases;
  if (!releases) return {};
  if (Array.isArray(releases)) return releases[0] ?? {};
  const key = Object.keys(releases)[0];
  return key ? releases[key] ?? {} : {};
}

export function releaseArray<T>(raw: RuntimeDataFile, key: keyof RuntimeDataRelease): T[] {
  const value = firstRelease(raw)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export function allReleaseArray<T>(raw: RuntimeDataFile, key: keyof RuntimeDataRelease): T[] {
  const releases = raw.releases;
  if (!releases) return [];
  const values = Array.isArray(releases) ? releases : Object.values(releases);
  return values.flatMap((release) => {
    const value = release[key];
    return Array.isArray(value) ? (value as T[]) : [];
  });
}

export function palettesFromBitmapAssets(bitmaps: BitmapPaletteSource[]): NonNullable<CastManifests["palettes"]> {
  const palettes = new Map<string, NonNullable<CastManifests["palettes"]>[number]>();
  for (const bitmap of bitmaps) {
    if (!Array.isArray(bitmap.paletteColors) || bitmap.paletteColors.length === 0) continue;
    const castName = bitmap.paletteCastName || bitmap.castName;
    const member = Number(bitmap.paletteMember);
    if (!castName || !Number.isFinite(member) || member <= 0) continue;
    const key = `${normalizeName(castName)}|${member}`;
    if (palettes.has(key)) continue;
    palettes.set(key, {
      castName,
      castOrder: bitmap.castOrder,
      member,
      memberName: bitmap.paletteName || `palette-${member}`,
      colors: bitmap.paletteColors,
    });
  }
  return [...palettes.values()];
}

export function mergeDirectorBitmapAssets(
  externalBitmaps: BitmapPaletteSource[],
  visualBitmaps: CastManifests["bitmaps"],
): CastManifests["bitmaps"] {
  const externalSlots = new Set(externalBitmaps.map((bitmap) => bitmapSlotKey(bitmap.castName, bitmap.member)));
  const merged: CastManifests["bitmaps"] = [...externalBitmaps];

  for (const bitmap of visualBitmaps) {
    if (externalSlots.has(bitmapSlotKey(bitmap.castName, bitmap.member))) {
      continue;
    }

    if (
      typeof bitmap.sourceBitmapMember === "number" &&
      externalSlots.has(bitmapSlotKey(bitmap.castName, bitmap.sourceBitmapMember))
    ) {
      const { sourceBitmapMember: _sourceBitmapMember, ...withoutSourceAlias } = bitmap;
      merged.push(withoutSourceAlias);
      continue;
    }

    merged.push(bitmap);
  }

  return merged;
}

export function externalMembersFromVisuals(
  visuals: VisualLayoutRecord[],
): NonNullable<CastManifests["externalMembers"]> {
  const members = new Map<string, NonNullable<CastManifests["externalMembers"]>[number]>();
  const add = (
    entry: VisualMemberRecord,
    fallback: Pick<VisualMemberRecord, "castName" | "castOrder"> = {},
  ): void => {
    const castName = entry.castName ?? fallback.castName;
    if (!castName || typeof entry.member !== "number") return;
    const member = {
      castName,
      castOrder: entry.castOrder ?? fallback.castOrder,
      member: entry.member,
      memberName: entry.memberName,
      memberType: entry.memberType,
      mediaType: entry.mediaType,
      identitySource: "visual" as const,
    };
    const key = `${castName.toLowerCase()}|${member.member}`;
    const existing = members.get(key);
    members.set(key, mergeExternalMemberIdentity(existing, member));
  };

  for (const visual of visuals) {
    add({ ...visual, memberType: visual.memberType ?? "text" });
    for (const reference of visual.bitmapReferences ?? []) {
      add(reference, { castName: visual.castName, castOrder: visual.castOrder });
    }
    for (const element of visual.elements ?? []) {
      if (element.resolvedMember) {
        add(element.resolvedMember, { castName: visual.castName, castOrder: visual.castOrder });
      }
    }
  }
  return [...members.values()];
}

export function externalMembersFromCastGraph(
  casts: ExternalCastRecord[],
): NonNullable<CastManifests["externalMembers"]> {
  const members = new Map<string, NonNullable<CastManifests["externalMembers"]>[number]>();

  for (const cast of casts) {
    if (!cast.name || !cast.members) continue;
    for (const member of cast.members) {
      if (typeof member.number !== "number") continue;
      const key = `${normalizeName(cast.name)}|${member.number}`;
      const next = {
        castName: cast.name,
        castOrder: cast.order,
        member: member.number,
        memberName: member.name,
        memberType: member.type,
        ...(member.sound ? { sound: member.sound } : {}),
        identitySource: "castGraph" as const,
        supplementalRegistry: member.supplementalRegistry,
      };
      members.set(key, mergeExternalMemberIdentity(members.get(key), next));
    }
  }

  return [...members.values()];
}

function mergeExternalMemberIdentity(
  existing: NonNullable<CastManifests["externalMembers"]>[number] | undefined,
  incoming: NonNullable<CastManifests["externalMembers"]>[number],
): NonNullable<CastManifests["externalMembers"]>[number] {
  if (!existing) return incoming;

  const existingName = existing.memberName ?? "";
  const incomingName = incoming.memberName ?? "";
  const existingType = (existing.memberType ?? existing.mediaType ?? "").toLowerCase();
  const incomingType = (incoming.memberType ?? incoming.mediaType ?? "").toLowerCase();
  const existingSource = String((existing as { identitySource?: string }).identitySource ?? "");
  const incomingSource = String((incoming as { identitySource?: string }).identitySource ?? "");
  const incomingIsVisual = incomingSource === "visual";
  const existingIsVisual = existingSource === "visual";
  if (
    Boolean((incoming as { supplementalRegistry?: boolean }).supplementalRegistry) &&
    incomingType === "bitmap" &&
    incomingName.length === 0 &&
    existingType === "bitmap"
  ) {
    return {
      ...existing,
      ...incoming,
      memberName: undefined,
      memberType: incoming.memberType ?? existing.memberType,
      mediaType: incoming.mediaType ?? existing.mediaType,
    };
  }
  const namesConflict =
    existingName.length > 0 && incomingName.length > 0 && existingName.toLowerCase() !== incomingName.toLowerCase();
  const preserveIncomingIdentity =
    incomingIsVisual ||
    (!existingIsVisual &&
      incomingName.length > 0 &&
      existingName.length > 0 &&
      existingType === incomingType &&
      incomingType === "bitmap" &&
      Boolean((incoming as { supplementalRegistry?: boolean }).supplementalRegistry));
  const preserveExistingIdentity =
    !preserveIncomingIdentity &&
    (namesConflict ||
      (existingName.length > 0 && (existingType === "text" || existingType === "field") && incomingType === "bitmap"));
  if (preserveExistingIdentity) {
    return {
      ...incoming,
      ...existing,
      castOrder: existing.castOrder ?? incoming.castOrder,
      memberName: existing.memberName,
      memberType: existing.memberType ?? incoming.memberType,
      mediaType: existing.mediaType ?? incoming.mediaType,
    };
  }

  return {
    ...existing,
    ...incoming,
    memberName: incoming.memberName ?? existing.memberName,
    memberType: incoming.memberType ?? existing.memberType,
    mediaType: incoming.mediaType ?? existing.mediaType,
  };
}

export function externalMembersFromGeneratedScripts(
  scripts: GeneratedScriptRecord[],
): NonNullable<CastManifests["externalMembers"]> {
  const members = new Map<string, NonNullable<CastManifests["externalMembers"]>[number]>();

  for (const script of scripts) {
    const castName = script.castFile;
    const member = script.memberNumber;
    if (!castName || typeof member !== "number") continue;

    const memberName = script.memberName ?? script.module?.scriptName ?? undefined;
    const scriptType = script.scriptType ?? script.module?.scriptType;
    if (!memberName || !scriptType || scriptType === "unknown") continue;

    members.set(`${castName.toLowerCase()}|${member}`, {
      castName,
      member,
      memberName,
      memberType: "script",
    });
  }

  return [...members.values()];
}

function normalizeName(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\.(cct|cst)$/i, "");
}

function bitmapSlotKey(castName: string | undefined, member: number | undefined): string {
  return `${normalizeName(castName)}|${Number(member)}`;
}
