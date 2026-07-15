import type { FurniMetadataSnapshot, RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import type { RuntimeInventoryItemSummary } from "../../engineRuntime";
import { compactValue } from "../common/model";
import { furniDisplayName, furniInfoForClass, furniInfoForObject } from "../room/items";
import { packetFieldMap, parsedCount } from "./fields";
import { emptyPacketInventoryState, type InventoryDisplayRow, type PacketInventoryItem, type PacketInventoryState } from "./types";

export function packetInventoryStateFromEntries(
  entries: readonly RelayLogEntry[],
  startIndex = 0,
  initialState: PacketInventoryState = emptyPacketInventoryState,
): PacketInventoryState {
  const itemsByKey = new globalThis.Map<string, PacketInventoryItem>();
  for (const item of initialState.items) {
    itemsByKey.set(item.key, item);
  }
  let lastSourceLine = initialState.lastSourceLine;

  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER") continue;
    const fields = packetFieldMap(entry);
    if (entry.header === 140) {
      const count = parsedCount(fields.get("inventoryItemCount"));
      if (count === null) continue;
      for (let row = 1; row <= count; row += 1) {
        const item = packetInventoryItemFromPrefix(fields, `inventoryItem ${row}`, entry.lineNumber);
        if (item) itemsByKey.set(item.key, item);
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 99) {
      const key = packetInventoryKey(fields.get("inventoryRemove raw") ?? "", fields.get("inventoryRemove id") ?? "");
      if (key) itemsByKey.delete(key);
      lastSourceLine = entry.lineNumber;
    }
  }

  const items = [...itemsByKey.values()].sort((left, right) => {
    if (left.inventoryKind !== right.inventoryKind) return left.inventoryKind.localeCompare(right.inventoryKind);
    return left.className.localeCompare(right.className);
  });
  return {
    items,
    totalCount: items.length,
    floorCount: items.filter((item) => item.inventoryKind === "floor").length,
    wallCount: items.filter((item) => item.inventoryKind === "wall").length,
    lastSourceLine,
  };
}

export let packetInventoryStateCache:
  | {
      readonly logPath: string;
      readonly entryCount: number;
      readonly totalLines: number;
      readonly state: PacketInventoryState;
    }
  | null = null;

export function packetInventoryStateFromRelayLog(snapshot: RelayLogSnapshot | null): PacketInventoryState {
  if (!snapshot || snapshot.entries.length === 0) {
    packetInventoryStateCache = null;
    return emptyPacketInventoryState;
  }
  if (
    packetInventoryStateCache &&
    packetInventoryStateCache.logPath === snapshot.logPath &&
    packetInventoryStateCache.entryCount <= snapshot.entries.length &&
    packetInventoryStateCache.totalLines <= snapshot.totalLines
  ) {
    const state = packetInventoryStateFromEntries(snapshot.entries, packetInventoryStateCache.entryCount, packetInventoryStateCache.state);
    packetInventoryStateCache = {
      logPath: snapshot.logPath,
      entryCount: snapshot.entries.length,
      totalLines: snapshot.totalLines,
      state,
    };
    return state;
  }
  const state = packetInventoryStateFromEntries(snapshot.entries);
  packetInventoryStateCache = {
    logPath: snapshot.logPath,
    entryCount: snapshot.entries.length,
    totalLines: snapshot.totalLines,
    state,
  };
  return state;
}

export function packetInventoryItemFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketInventoryItem | null {
  const itemId = compactValue(fields.get(`${prefix} id`));
  const rawId = fields.get(`${prefix} rawId`) ?? "";
  const itemIdValue = compactValue(fields.get(`${prefix} idValue`));
  const key = packetInventoryKey(rawId, itemId);
  if (!key && itemIdValue === "-") return null;
  return {
    key: key || `value:${itemIdValue}`,
    itemId,
    rawId,
    itemIdValue,
    slotId: compactValue(fields.get(`${prefix} slotId`)),
    objectId: compactValue(fields.get(`${prefix} objectId`)),
    itemType: compactValue(fields.get(`${prefix} type`)),
    inventoryKind: compactValue(fields.get(`${prefix} kind`)),
    className: compactValue(fields.get(`${prefix} class`)),
    size: compactValue(fields.get(`${prefix} size`)),
    colors: compactValue(fields.get(`${prefix} colors`)),
    data: compactValue(fields.get(`${prefix} data`)),
    head: compactValue(fields.get(`${prefix} head`)),
    body: compactValue(fields.get(`${prefix} body`)),
    meta: compactValue(fields.get(`${prefix} meta`)),
    headTokens: compactValue(fields.get(`${prefix} headTokens`)),
    bodyTokens: compactValue(fields.get(`${prefix} bodyTokens`)),
    metaTokens: compactValue(fields.get(`${prefix} metaTokens`)),
    sourceLine,
  };
}

export function packetInventoryKey(rawId: string, displayId: string): string {
  if (rawId.length > 0) return `raw:${rawId}`;
  const cleanDisplayId = compactValue(displayId);
  return cleanDisplayId === "-" ? "" : `id:${cleanDisplayId}`;
}

export function packetInventorySearchText(item: PacketInventoryItem): string {
  return [
    item.itemId,
    item.itemIdValue,
    item.slotId,
    item.objectId,
    item.itemType,
    item.inventoryKind,
    item.className,
    item.size,
    item.colors,
    item.data,
    item.headTokens,
    item.bodyTokens,
    item.metaTokens,
  ]
    .join(" ")
    .toLowerCase();
}

export function packetInventoryTitle(item: PacketInventoryItem, metadata: FurniMetadataSnapshot | null): string {
  return compactValue(furniInfoForClass(metadata, item.className)?.name ?? item.className);
}

export function packetInventoryMeta(item: PacketInventoryItem): string {
  const parts = [
    `inv ${item.itemId !== "-" ? item.itemId : item.itemIdValue}`,
    item.objectId !== "-" ? `obj ${item.objectId}` : "",
    item.slotId !== "-" ? `slot ${item.slotId}` : "",
    item.size !== "-" ? `size ${item.size}` : "",
    item.colors !== "-" ? `colors ${item.colors}` : "",
  ].filter(Boolean);
  return parts.join(" / ");
}

export function runtimeInventoryDisplayRow(item: RuntimeInventoryItemSummary, metadata: FurniMetadataSnapshot | null): InventoryDisplayRow {
  const title = inventoryItemTitle(item, metadata);
  const meta = inventoryItemMeta(item);
  const detailRows = [
    { label: "Kind", value: inventoryKindLabel(item.inventoryKind) },
    { label: "Inv ID", value: compactValue(item.itemId) },
    { label: "Object ID", value: compactValue(item.objectId) },
    { label: "Slot", value: compactValue(item.slotId) },
    { label: "Class", value: compactValue(item.className) },
    { label: "Name", value: title },
    { label: "Size", value: compactValue(item.size) },
    { label: "Colors", value: compactValue(item.colors) },
    { label: "Data", value: compactValue(item.data) },
  ];
  return {
    key: `runtime:${item.rowId}`,
    kind: inventoryKindLabel(item.inventoryKind),
    title,
    meta,
    detailRows,
    searchText: [title, meta, item.inventoryKind, item.itemId, item.objectId, item.slotId, item.className, item.colors, item.data].join(" ").toLowerCase(),
  };
}

export function packetInventoryDisplayRow(item: PacketInventoryItem, metadata: FurniMetadataSnapshot | null): InventoryDisplayRow {
  const title = packetInventoryTitle(item, metadata);
  const meta = packetInventoryMeta(item);
  const detailRows = [
    { label: "Kind", value: inventoryKindLabel(item.inventoryKind) },
    { label: "Inv ID", value: item.itemId },
    { label: "ID Value", value: item.itemIdValue },
    { label: "Slot", value: item.slotId },
    { label: "Object ID", value: item.objectId },
    { label: "Class", value: item.className },
    { label: "Name", value: title },
    { label: "Size", value: item.size },
    { label: "Colors", value: item.colors },
    { label: "Data", value: item.data },
    { label: "Head Tokens", value: item.headTokens },
    { label: "Body Tokens", value: item.bodyTokens },
    { label: "Meta Tokens", value: item.metaTokens },
    { label: "Packet Line", value: String(item.sourceLine) },
  ];
  return {
    key: `packet:${item.key}`,
    kind: inventoryKindLabel(item.inventoryKind),
    title,
    meta,
    detailRows,
    searchText: [title, meta, packetInventorySearchText(item)].join(" ").toLowerCase(),
  };
}

export function inventoryKindLabel(kind: string): string {
  if (kind === "floor") return "Floor";
  if (kind === "wall") return "Wall";
  return compactValue(kind);
}

export function inventoryItemTitle(item: RuntimeInventoryItemSummary, metadata: FurniMetadataSnapshot | null = null): string {
  return furniDisplayName(metadata, item);
}

export function inventoryItemMeta(item: RuntimeInventoryItemSummary): string {
  const parts = [
    `inv ${compactValue(item.itemId)}`,
    item.objectId !== undefined ? `obj ${compactValue(item.objectId)}` : "",
    item.slotId !== undefined ? `slot ${compactValue(item.slotId)}` : "",
    item.size ? `size ${item.size}` : "",
    item.colors ? `colors ${item.colors}` : "",
  ].filter(Boolean);
  return parts.join(" / ");
}
