import type { EngineRuntimeSnapshot, RuntimeObjectSummary } from "../renderer/engineRuntime";
import type { AccountSummary, EngineStatus, RoomSummary } from "../shared/session";

export interface RuntimeItemRow {
  readonly key: string;
  readonly kind: "floor" | "passive" | "wall";
  readonly label: string;
  readonly source: string;
  readonly item: RuntimeObjectSummary;
}

export interface ShocklessSessionSummary {
  readonly roomReady: boolean;
  readonly visitorRoomKey: string;
  readonly visitorRoomName: string;
  readonly engine: Partial<EngineStatus>;
  readonly room: Partial<RoomSummary>;
  readonly account: Partial<AccountSummary>;
  readonly itemRows: readonly RuntimeItemRow[];
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export function compactRuntimeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (typeof value === "object") return "-";
  return String(value);
}

function propListValue(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  const sourceRecord = source as Record<string, unknown>;
  const direct = sourceRecord[key] ?? sourceRecord[key.replace(/^#/, "")];
  if (direct !== undefined) return direct;
  const entries = (source as { readonly entries?: readonly { readonly key?: unknown; readonly value?: unknown }[] }).entries;
  if (!Array.isArray(entries)) return undefined;
  const normalized = key.toLowerCase();
  const match = entries.find((entry) => String(entry.key ?? "").toLowerCase() === normalized);
  return match?.value;
}

export function runtimeRoomProp(snapshot: EngineRuntimeSnapshot | null, key: string): unknown {
  return (
    propListValue(snapshot?.roomEntryState?.lastroom, key) ??
    propListValue(snapshot?.roomEntryState?.roomComponent?.pSaveData, key)
  );
}

export function runtimeFps(snapshot: EngineRuntimeSnapshot | null): number | null {
  // Prefer the recent (lag-reflecting) frame rate; fall back to the older lifetime metrics.
  return numberOrNull(
    snapshot?.performanceStats?.currentFps ??
      snapshot?.performanceStats?.rafPerSecond ??
      snapshot?.performanceStats?.rafRate,
  );
}

export function runtimeTickRate(snapshot: EngineRuntimeSnapshot | null): number | null {
  return numberOrNull(
    snapshot?.performanceStats?.directorTicksPerSecond ??
      snapshot?.performanceStats?.directorTickRate ??
      snapshot?.performanceStats?.frameTempo,
  );
}

export function runtimeRoomId(snapshot: EngineRuntimeSnapshot | null): string {
  const candidates = [
    runtimeRoomProp(snapshot, "#flatId"),
    runtimeRoomProp(snapshot, "#id"),
    snapshot?.roomEntryState?.roomComponent?.pReportRoomId,
    snapshot?.roomReady?.roomId,
    snapshot?.roomEntryState?.roomReady?.roomId,
    snapshot?.roomEntryState?.roomComponent?.pRoomId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const text = String(candidate).trim();
    if (text) return text;
  }
  return "-";
}

export function runtimeRoomOwner(snapshot: EngineRuntimeSnapshot | null): string {
  return compactRuntimeValue(runtimeRoomProp(snapshot, "#owner"));
}

export function runtimeRoomType(snapshot: EngineRuntimeSnapshot | null): RoomSummary["type"] {
  const raw = [
    runtimeRoomProp(snapshot, "#type"),
    snapshot?.roomReady?.roomType,
    snapshot?.roomEntryState?.roomReady?.roomType,
  ]
    .map(compactRuntimeValue)
    .join(" ")
    .toLowerCase();
  if (raw.includes("private")) return "private";
  if (raw.includes("public")) return "public";
  if (snapshot?.roomEntryState?.lastroom === "Entry") return "hotel-view";
  if ((snapshot?.roomReady?.ready || snapshot?.roomEntryState?.roomReady?.ready) && /^\d+$/.test(runtimeRoomId(snapshot))) {
    return "private";
  }
  if ((snapshot?.roomReady?.ready || snapshot?.roomEntryState?.roomReady?.ready) && runtimeRoomOwner(snapshot) !== "-") {
    return "private";
  }
  return "unknown";
}

export function runtimeRoomName(snapshot: EngineRuntimeSnapshot | null): string {
  if (!snapshot?.hasEngine) return "No room";
  const sourceName = compactRuntimeValue(runtimeRoomProp(snapshot, "#name"));
  if (sourceName !== "-") return sourceName;
  if (snapshot.roomReady?.ready || snapshot.roomEntryState?.roomReady?.ready) {
    const roomId = runtimeRoomId(snapshot);
    return roomId === "-" ? "Room ready" : `Room ${roomId}`;
  }
  if (snapshot.editableFields.length >= 2) return "Login screen";
  if (snapshot.roomEntryState?.lastroom === "Entry") return "Hotel view";
  return "Engine ready";
}

export function runtimeLocation(snapshot: EngineRuntimeSnapshot | null): string {
  if (!snapshot?.hasEngine) return "Loading Shockless";
  if (snapshot.roomReady?.ready || snapshot.roomEntryState?.roomReady?.ready) return runtimeRoomName(snapshot);
  if (snapshot.editableFields.length >= 2) return "Login screen";
  if (snapshot.roomEntryState?.lastroom === "Entry") return "Hotel view";
  const entryState = snapshot.roomEntryState?.entryState?.state;
  return entryState ? `Entry ${entryState}` : "Engine ready";
}

export function runtimeRoomReady(snapshot: EngineRuntimeSnapshot | null): boolean {
  return Boolean(snapshot?.roomReady?.ready ?? snapshot?.roomEntryState?.roomReady?.ready);
}

function objectKey(prefix: string, item: RuntimeObjectSummary, index: number): string {
  return `${prefix}:${compactRuntimeValue(item.objectId ?? item.id ?? index)}`;
}

export function runtimeItemRows(snapshot: EngineRuntimeSnapshot | null): readonly RuntimeItemRow[] {
  const active = snapshot?.roomObjects?.activeObjects ?? [];
  const passive = snapshot?.roomObjects?.passiveObjects ?? [];
  const wall = snapshot?.roomObjects?.wallItems ?? [];
  return [
    ...active.map((item, index) => ({
      key: objectKey("floor", item, index),
      kind: "floor" as const,
      label: "Floor",
      source: "roomObjects.activeObjects",
      item,
    })),
    ...passive.map((item, index) => ({
      key: objectKey("passive", item, index),
      kind: "passive" as const,
      label: "Passive",
      source: "roomObjects.passiveObjects",
      item,
    })),
    ...wall.map((item, index) => ({
      key: objectKey("wall", item, index),
      kind: "wall" as const,
      label: "Wall",
      source: "roomObjects.wallItems",
      item,
    })),
  ];
}

export function runtimeEngineStatus(snapshot: EngineRuntimeSnapshot): Partial<EngineStatus> {
  return {
    running: snapshot.hasEngine,
    embedded: true,
    location: runtimeLocation(snapshot),
    fps: runtimeFps(snapshot),
    tickRate: runtimeTickRate(snapshot),
    errors: snapshot.errors,
  };
}

export function runtimeRoomSummary(snapshot: EngineRuntimeSnapshot): Partial<RoomSummary> {
  const counts = snapshot.roomObjects?.counts;
  const users = snapshot.userState?.roomUserCount ?? counts?.users ?? 0;
  const activeObjects = counts?.activeObjects ?? 0;
  const passiveObjects = counts?.passiveObjects ?? 0;
  return {
    id: runtimeRoomId(snapshot),
    name: runtimeRoomName(snapshot),
    owner: runtimeRoomOwner(snapshot),
    type: runtimeRoomType(snapshot),
    users,
    floorItems: activeObjects + passiveObjects,
    wallItems: counts?.wallItems ?? 0,
  };
}

export function runtimeAccountSummary(snapshot: EngineRuntimeSnapshot): Partial<AccountSummary> {
  const sessionName = compactRuntimeValue(snapshot.userState?.sessionUserName);
  const selfUser =
    snapshot.userState?.users.find((user) => String(user.rowId) === "0") ??
    snapshot.userState?.users.find((user) => user.name === snapshot.userState?.sessionUserName);
  const badge = compactRuntimeValue(selfUser?.badgeCode);
  return {
    ...(sessionName !== "-" ? { name: sessionName } : {}),
    ...(badge !== "-" ? { badge } : {}),
  };
}

export function summarizeRuntimeSnapshot(snapshot: EngineRuntimeSnapshot): ShocklessSessionSummary {
  const roomReady = runtimeRoomReady(snapshot);
  return {
    roomReady,
    visitorRoomKey: roomReady ? `${runtimeRoomType(snapshot)}:${runtimeRoomId(snapshot)}` : "",
    visitorRoomName: roomReady ? runtimeRoomName(snapshot) : "-",
    engine: runtimeEngineStatus(snapshot),
    room: runtimeRoomSummary(snapshot),
    account: runtimeAccountSummary(snapshot),
    itemRows: runtimeItemRows(snapshot),
  };
}
