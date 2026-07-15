import type { RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import { runtimeItemRows } from "../../../engine-adapter/shocklessSessionAdapter";
import type { EngineRuntimeSnapshot, RuntimeObjectSummary } from "../../engineRuntime";
import { compactValue, finiteNumber } from "../common/model";
import { objectNumericId, runtimeObjectNumericIds, type ItemRow } from "../room/items";
import { signedPair } from "../room/wallPlacement";
import { packetFieldMap, parsedCount } from "./fields";
import {
  emptyPacketActiveObjectState, emptyPacketWallItemState,
type PacketActiveObject, type PacketActiveObjectState, type PacketWallItem, type PacketWallItemState,
} from "./types";

export function packetWallItemStateFromEntries(
  entries: readonly RelayLogEntry[],
  startIndex = 0,
  initialState: PacketWallItemState = emptyPacketWallItemState,
): PacketWallItemState {
  const itemsByKey = new globalThis.Map<string, PacketWallItem>();
  for (const item of initialState.items) {
    itemsByKey.set(item.key, item);
  }
  let lastSourceLine = initialState.lastSourceLine;

  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER") continue;
    const fields = packetFieldMap(entry);
    if (entry.header === 45) {
      const count = parsedCount(fields.get("wallItemCount"));
      if (count === null) continue;
      itemsByKey.clear();
      for (let row = 1; row <= count; row += 1) {
        const item = packetWallItemFromPrefix(fields, `wallItem ${row}`, entry.lineNumber);
        if (item) itemsByKey.set(item.key, item);
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 85) {
      const item = packetWallItemFromPrefix(fields, "wallItemUpdate", entry.lineNumber);
      if (item) itemsByKey.set(item.key, item);
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 84) {
      const itemId = compactValue(fields.get("wallItemRemove id"));
      if (itemId !== "-") itemsByKey.delete(`wall:${itemId}`);
      lastSourceLine = entry.lineNumber;
    }
  }

  const items = [...itemsByKey.values()].sort((left, right) => Number(left.itemId) - Number(right.itemId));
  return { items, itemCount: items.length, lastSourceLine };
}

export let packetWallItemStateCache:
  | {
      readonly logPath: string;
      readonly entryCount: number;
      readonly totalLines: number;
      readonly state: PacketWallItemState;
    }
  | null = null;

export function packetWallItemStateFromRelayLog(snapshot: RelayLogSnapshot | null): PacketWallItemState {
  if (!snapshot || snapshot.entries.length === 0) {
    packetWallItemStateCache = null;
    return emptyPacketWallItemState;
  }
  if (
    packetWallItemStateCache &&
    packetWallItemStateCache.logPath === snapshot.logPath &&
    packetWallItemStateCache.entryCount <= snapshot.entries.length &&
    packetWallItemStateCache.totalLines <= snapshot.totalLines
  ) {
    const state = packetWallItemStateFromEntries(snapshot.entries, packetWallItemStateCache.entryCount, packetWallItemStateCache.state);
    packetWallItemStateCache = {
      logPath: snapshot.logPath,
      entryCount: snapshot.entries.length,
      totalLines: snapshot.totalLines,
      state,
    };
    return state;
  }
  const state = packetWallItemStateFromEntries(snapshot.entries);
  packetWallItemStateCache = {
    logPath: snapshot.logPath,
    entryCount: snapshot.entries.length,
    totalLines: snapshot.totalLines,
    state,
  };
  return state;
}

export function packetWallItemFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketWallItem | null {
  const itemId = compactValue(fields.get(`${prefix} id`));
  if (itemId === "-") return null;
  return {
    key: `wall:${itemId}`,
    itemId,
    className: compactValue(fields.get(`${prefix} class`)),
    ownerName: compactValue(fields.get(`${prefix} owner`)),
    wall: compactValue(fields.get(`${prefix} wall`)),
    local: compactValue(fields.get(`${prefix} local`)),
    orientation: compactValue(fields.get(`${prefix} orientation`)),
    rawLocation: compactValue(fields.get(`${prefix} rawLocation`)),
    data: compactValue(fields.get(`${prefix} data`)),
    state: compactValue(fields.get(`${prefix} state`)),
    sourceLine,
  };
}

export function packetWallItemRow(item: PacketWallItem): ItemRow {
  const object: RuntimeObjectSummary = {
    id: item.itemId,
    objectId: item.itemId,
    className: item.className,
    name: item.className,
    ownerName: item.ownerName,
    wall: item.wall,
    local: item.local,
    orientation: item.orientation,
    rawLocation: item.rawLocation,
    state: item.state !== "-" ? item.state : item.data,
    type: "wall",
  };
  return {
    key: `packet-wall:${item.itemId}`,
    kind: "wall",
    label: "Wall",
    source: `relay.ITEMS.line.${item.sourceLine}`,
    item: object,
  };
}

export function packetActiveObjectStateFromEntries(
  entries: readonly RelayLogEntry[],
  startIndex = 0,
  initialState: PacketActiveObjectState = emptyPacketActiveObjectState,
): PacketActiveObjectState {
  const itemsByKey = new globalThis.Map<string, PacketActiveObject>();
  for (const item of initialState.items) {
    itemsByKey.set(item.key, item);
  }
  const removedObjectIds = new globalThis.Set<string>(initialState.removedObjectIds);
  let lastSourceLine = initialState.lastSourceLine;

  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER") continue;
    const fields = packetFieldMap(entry);
    if (entry.header === 32) {
      const count = parsedCount(fields.get("floorObjectCount"));
      if (count === null) continue;
      itemsByKey.clear();
      removedObjectIds.clear();
      for (let row = 1; row <= count; row += 1) {
        const item = packetActiveObjectFromPrefix(fields, `floorObject ${row}`, entry.lineNumber);
        if (item) itemsByKey.set(item.key, item);
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 93) {
      const item = packetActiveObjectFromPrefix(fields, "activeObjectAdd", entry.lineNumber);
      if (item) {
        itemsByKey.set(item.key, item);
        removedObjectIds.delete(item.objectId);
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 95) {
      const item = packetActiveObjectFromPrefix(fields, "floorObjectUpdate", entry.lineNumber);
      if (item) {
        itemsByKey.set(item.key, item);
        removedObjectIds.delete(item.objectId);
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 94) {
      const objectId = compactValue(fields.get("activeObjectRemove id"));
      if (objectId !== "-") {
        itemsByKey.delete(`active:${objectId}`);
        removedObjectIds.add(objectId);
      }
      lastSourceLine = entry.lineNumber;
    }
  }

  const items = [...itemsByKey.values()].sort((left, right) => Number(left.objectId) - Number(right.objectId));
  return { items, itemCount: items.length, removedObjectIds: [...removedObjectIds], lastSourceLine };
}

export function packetActiveObjectFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketActiveObject | null {
  const objectId = compactValue(fields.get(`${prefix} id`));
  if (objectId === "-") return null;
  const tile = signedPair(fields.get(`${prefix} tile`));
  if (!tile) return null;
  const z = compactValue(fields.get(`${prefix} tile`)).split(",").slice(2).join(",").trim();
  const direction = finiteNumber(fields.get(`${prefix} direction`)) ?? 0;
  return {
    key: `active:${objectId}`,
    objectId,
    className: compactValue(fields.get(`${prefix} class`)),
    x: tile.x,
    y: tile.y,
    z,
    direction: Math.trunc(direction),
    size: compactValue(fields.get(`${prefix} size`)),
    rawPosition: compactValue(fields.get(`${prefix} rawPosition`)),
    state: compactValue(fields.get(`${prefix} state`)),
    runtimeData: compactValue(fields.get(`${prefix} runtime`)),
    stuffData: compactValue(fields.get(`${prefix} stuff`)),
    trailingData: compactValue(fields.get(`${prefix} trailing`)),
    sourceLine,
  };
}

export function packetActiveObjectRow(item: PacketActiveObject): ItemRow {
  const object: RuntimeObjectSummary = {
    id: item.objectId,
    objectId: item.objectId,
    className: item.className,
    name: item.className,
    x: item.x,
    y: item.y,
    z: item.z,
    direction: item.direction,
    rawLocation: item.rawPosition,
    state: item.state !== "-" ? item.state : item.runtimeData !== "-" ? item.runtimeData : item.stuffData,
    type: "floor",
  };
  return {
    key: `packet-active:${item.objectId}`,
    kind: "floor",
    label: "Floor",
    source: `relay.ACTIVEOBJECTS.line.${item.sourceLine}`,
    item: object,
  };
}

export function mergeRuntimeAndPacketItemRows(
  snapshot: EngineRuntimeSnapshot | null,
  packetRows: readonly ItemRow[] = [],
): readonly ItemRow[] {
  const rows = [...runtimeItemRows(snapshot)];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.key);
    for (const id of runtimeObjectNumericIds(row.item)) {
      seen.add(`object:${id}`);
    }
  }
  for (const row of packetRows) {
    const ids = runtimeObjectNumericIds(row.item);
    if (seen.has(row.key) || ids.some((id) => seen.has(`object:${id}`))) continue;
    rows.push(row);
    seen.add(row.key);
    for (const id of ids) {
      seen.add(`object:${id}`);
    }
  }
  return rows;
}
