import { runtimeItemRows, type RuntimeItemRow } from "../../../engine-adapter/shocklessSessionAdapter";
import type { FurniMetadataSnapshot } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeObjectSummary, RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, finiteNumber, userDisplayName } from "../common/model";
import { adjacentTileForItem, userTile, workingTileNearSelf, workingTilesNearSelf } from "../gardening/spatial";
import { cleanInteger, cleanPositiveInt } from "./permissions";
import { mergeRuntimeAndPacketItemRows } from "../packets/roomObjects";
import {
  isFishingAreaObject, isPlantLikeObject, itemRowMeta, itemRowSearchText, itemRowTile, itemRowTitle, objectNumericId, objectTitle,
  runtimeObjectNumericIds, tileKey, type ItemRow,
} from "../room/items";
import { signedPair, wallMoverLocation, wallOrientation, type WallMoverLocation } from "../room/wallPlacement";

export function pluginWalkTargetFromSnapshot(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  metadata: FurniMetadataSnapshot | null,
): { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string } | null {
  const rows = runtimeItemRows(snapshot).filter((row) => row.kind !== "wall" && itemRowTile(row));
  if (rows.length === 0) return null;

  const selectorRecord = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const idCandidate = finiteNumber(
    selectorRecord.objectId ??
      selectorRecord.itemId ??
      selectorRecord.id ??
      (typeof selector === "number" || (typeof selector === "string" && /^\d+$/.test(selector.trim())) ? selector : null),
  );
  if (idCandidate !== null) {
    const targetId = Math.trunc(idCandidate);
    const idMatch = rows.find((row) => runtimeObjectNumericIds(row.item).includes(targetId));
    const resolved = pluginWalkTargetFromRow(idMatch, metadata);
    if (resolved) return resolved;
  }

  const textSelector = firstNonEmptyText([
    typeof selector === "string" ? selector : "",
    selectorRecord.name,
    selectorRecord.className,
    selectorRecord.query,
    selectorRecord.text,
    selectorRecord.key,
  ]);
  if (!textSelector) return null;

  const normalized = textSelector.toLowerCase();
  const exact = selectorRecord.exact === true;
  const textMatch = rows.find((row) => {
    const exactCandidates = [
      row.key,
      row.item.className,
      row.item.name,
      itemRowTitle(row, metadata),
      objectTitle(row.item),
      ...runtimeObjectNumericIds(row.item).map(String),
    ].map((value) => compactValue(value).toLowerCase());
    if (exact) return exactCandidates.includes(normalized);
    return itemRowSearchText(row, metadata).includes(normalized) || exactCandidates.some((candidate) => candidate.includes(normalized));
  });
  return pluginWalkTargetFromRow(textMatch, metadata);
}

export function pluginWalkTargetFromRow(
  row: ItemRow | null | undefined,
  metadata: FurniMetadataSnapshot | null,
): { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string } | null {
  const tile = itemRowTile(row);
  if (!row || !tile) return null;
  return {
    x: tile.x,
    y: tile.y,
    furniId: objectNumericId(row.item) ?? 0,
    label: `${itemRowTitle(row, metadata)} (${compactValue(row.item.className ?? row.key)})`,
  };
}

export function pluginWalkTargetFromUser(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  options: Record<string, unknown> = {},
): { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string } | null {
  const users = snapshot?.userState?.users ?? [];
  if (users.length === 0) return null;

  const sessionName = snapshot?.userState?.sessionUserName ?? null;
  const selectorRecord = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const textSelector = firstNonEmptyText([
    typeof selector === "string" || typeof selector === "number" ? selector : "",
    selectorRecord.name,
    selectorRecord.username,
    selectorRecord.userName,
    selectorRecord.accountId,
    selectorRecord.userId,
    selectorRecord.roomIndex,
    selectorRecord.rowId,
    selectorRecord.id,
    selectorRecord.query,
    selectorRecord.text,
    selectorRecord.key,
    selectorRecord.self === true ? sessionName : "",
  ]);
  if (!textSelector) return null;

  const normalized = textSelector.toLowerCase();
  const exact = selectorRecord.exact !== false;
  const target = users.find((user) => {
    const candidates = [
      userDisplayName(user, sessionName),
      user.name,
      user.accountId,
      user.roomIndex,
      user.rowId,
      user.id,
      user.objectId,
      user.objectClass,
      user.className,
    ].map((value) => compactValue(value).trim()).filter((value) => value && value !== "-");
    const normalizedCandidates = candidates.map((value) => value.toLowerCase());
    if (exact) return normalizedCandidates.includes(normalized);
    return normalizedCandidates.some((candidate) => candidate === normalized || candidate.includes(normalized));
  });
  const tile = userTile(target);
  if (!target || !tile) return null;

  const offsetRecord = options.offset && typeof options.offset === "object" ? (options.offset as Record<string, unknown>) : {};
  const selectorOffset = selectorRecord.offset && typeof selectorRecord.offset === "object" ? (selectorRecord.offset as Record<string, unknown>) : {};
  const dx = cleanInteger(options.dx ?? options.offsetX ?? offsetRecord.x ?? selectorRecord.dx ?? selectorRecord.offsetX ?? selectorOffset.x, 0);
  const dy = cleanInteger(options.dy ?? options.offsetY ?? offsetRecord.y ?? selectorRecord.dy ?? selectorRecord.offsetY ?? selectorOffset.y, 0);
  const idLabel = compactValue(target.accountId ?? target.roomIndex ?? target.rowId);
  return {
    x: tile.x + dx,
    y: tile.y + dy,
    furniId: 0,
    label: `${userDisplayName(target, sessionName)} (${idLabel})`,
  };
}

export function pluginFindItemRows(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  metadata: FurniMetadataSnapshot | null,
  kind: "floor" | "wall" | "all" = "all",
): readonly ItemRow[] {
  const rows = runtimeItemRows(snapshot).filter((row) => {
    if (kind === "floor") return row.kind !== "wall";
    if (kind === "wall") return row.kind === "wall";
    return true;
  });
  if (pluginSelectorIsEmpty(selector)) return rows;
  return rows.filter((row) => pluginItemRowMatchesSelector(row, selector, metadata));
}

export function pluginSelectorIsEmpty(selector: unknown): boolean {
  if (selector === null || selector === undefined || selector === "") return true;
  if (typeof selector !== "object") return false;
  return Object.keys(selector as Record<string, unknown>).length === 0;
}

export function pluginItemRowMatchesSelector(row: ItemRow, selector: unknown, metadata: FurniMetadataSnapshot | null): boolean {
  const selectorRecord = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const idCandidate = finiteNumber(
    selectorRecord.objectId ??
      selectorRecord.itemId ??
      selectorRecord.id ??
      (typeof selector === "number" || (typeof selector === "string" && /^\d+$/.test(selector.trim())) ? selector : null),
  );
  if (idCandidate !== null && runtimeObjectNumericIds(row.item).includes(Math.trunc(idCandidate))) return true;

  const textSelector = firstNonEmptyText([
    typeof selector === "string" ? selector : "",
    selectorRecord.key,
    selectorRecord.name,
    selectorRecord.className,
    selectorRecord.query,
    selectorRecord.text,
    selectorRecord.ownerName,
  ]);
  if (!textSelector) return false;
  const normalized = textSelector.toLowerCase();
  const exact = selectorRecord.exact === true;
  const exactCandidates = [
    row.key,
    row.kind,
    row.label,
    row.item.className,
    row.item.name,
    row.item.ownerName,
    itemRowTitle(row, metadata),
    objectTitle(row.item),
    ...runtimeObjectNumericIds(row.item).map(String),
  ].map((value) => compactValue(value).toLowerCase());
  if (exact) return exactCandidates.includes(normalized);
  return itemRowSearchText(row, metadata).includes(normalized) || exactCandidates.some((candidate) => candidate.includes(normalized));
}

export function pluginResolveFloorItem(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  metadata: FurniMetadataSnapshot | null,
): { readonly row: ItemRow; readonly id: number; readonly tile: { readonly x: number; readonly y: number; readonly direction: number } } | null {
  const row = pluginFindItemRows(snapshot, selector, metadata, "floor")[0];
  const id = objectNumericId(row?.item);
  const tile = itemRowTile(row);
  return row && id !== null && tile ? { row, id, tile } : null;
}

export function pluginResolveWallItem(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  metadata: FurniMetadataSnapshot | null,
): { readonly row: ItemRow; readonly id: number; readonly location: WallMoverLocation } | null {
  const row = pluginFindItemRows(snapshot, selector, metadata, "wall")[0];
  const id = objectNumericId(row?.item);
  const location = wallMoverLocation(row?.item);
  return row && id !== null && location ? { row, id, location } : null;
}

export function pluginSelectorNumericId(selector: unknown): number | null {
  const record = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const parsed = finiteNumber(
    record.objectId ??
      record.itemId ??
      record.id ??
      (typeof selector === "number" || (typeof selector === "string" && /^\d+$/.test(selector.trim())) ? selector : null),
  );
  return parsed !== null && parsed > 0 ? Math.trunc(parsed) : null;
}

export function pluginSelectorTile(selector: unknown): { readonly x: number; readonly y: number; readonly direction: number } | null {
  const record = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const tileRecord = record.tile && typeof record.tile === "object" ? (record.tile as Record<string, unknown>) : record;
  const x = finiteNumber(tileRecord.x);
  const y = finiteNumber(tileRecord.y);
  if (x === null || y === null) return null;
  return { x: Math.trunc(x), y: Math.trunc(y), direction: cleanInteger(tileRecord.direction, 0) };
}

export function pluginSelectorKind(selector: unknown): "floor" | "wall" | null {
  const record = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const kind = String(record.kind ?? "").trim().toLowerCase();
  if (kind === "wall" || kind === "wallitem" || kind === "wall-item") return "wall";
  if (kind === "floor" || kind === "flooritem" || kind === "floor-item" || kind === "active" || kind === "passive") return "floor";
  return null;
}

export function pluginSelectorWallLocation(selector: unknown, location: unknown): WallMoverLocation | null {
  const locationRecord = location && typeof location === "object" ? (location as Record<string, unknown>) : {};
  const selectorRecord = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
  const candidate = Object.keys(locationRecord).length > 0
    ? locationRecord
    : selectorRecord.wallLocation && typeof selectorRecord.wallLocation === "object"
      ? (selectorRecord.wallLocation as Record<string, unknown>)
      : selectorRecord;
  const directWallX = finiteNumber(candidate.wallX);
  const directWallY = finiteNumber(candidate.wallY);
  const directLocalX = finiteNumber(candidate.localX);
  const directLocalY = finiteNumber(candidate.localY);
  const orientation = candidate.orientation === "r" || candidate.orientation === "l" ? candidate.orientation : null;
  if (directWallX !== null && directWallY !== null && directLocalX !== null && directLocalY !== null && orientation) {
    return {
      wallX: Math.trunc(directWallX),
      wallY: Math.trunc(directWallY),
      localX: Math.trunc(directLocalX),
      localY: Math.trunc(directLocalY),
      orientation,
    };
  }
  return null;
}

export function pluginWallMoveLocation(base: WallMoverLocation, input: unknown): WallMoverLocation {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const deltaX = cleanInteger(record.deltaX ?? record.dx, 0);
  const deltaY = cleanInteger(record.deltaY ?? record.dy, 0);
  const orientation = record.orientation === "r" || record.orientation === "l" ? record.orientation : base.orientation;
  return {
    wallX: Object.prototype.hasOwnProperty.call(record, "wallX") ? cleanInteger(record.wallX, base.wallX) : base.wallX + deltaX,
    wallY: Object.prototype.hasOwnProperty.call(record, "wallY") ? cleanInteger(record.wallY, base.wallY) : base.wallY + deltaY,
    localX: Object.prototype.hasOwnProperty.call(record, "localX") ? cleanInteger(record.localX, base.localX) : base.localX,
    localY: Object.prototype.hasOwnProperty.call(record, "localY") ? cleanInteger(record.localY, base.localY) : base.localY,
    orientation,
  };
}

export function pluginFishingAreaRows(
  snapshot: EngineRuntimeSnapshot | null,
  metadata: FurniMetadataSnapshot | null,
  packetRows: readonly ItemRow[] = [],
  removedPacketObjectIds: readonly string[] = [],
): readonly ItemRow[] {
  void metadata;
  const removedIds = new globalThis.Set(removedPacketObjectIds.map((id) => compactValue(id)));
  return mergeRuntimeAndPacketItemRows(snapshot, packetRows)
    .filter((row) => {
      if (row.kind === "wall" || !isFishingAreaObject(row.item) || !itemRowTile(row)) return false;
      const ids = runtimeObjectNumericIds(row.item).map(String);
      return ids.every((id) => !removedIds.has(id));
    });
}

export function pluginFishingAreaPayload(row: ItemRow, metadata: FurniMetadataSnapshot | null): Record<string, unknown> {
  const tile = itemRowTile(row);
  return {
    id: objectNumericId(row.item),
    title: itemRowTitle(row, metadata),
    meta: itemRowMeta(row, metadata),
    tile,
    item: row.item,
  };
}

export function pluginFishingAreaTarget(
  snapshot: EngineRuntimeSnapshot | null,
  areaId: unknown,
  metadata: FurniMetadataSnapshot | null,
  packetRows: readonly ItemRow[] = [],
  removedPacketObjectIds: readonly string[] = [],
): { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string; readonly area: Record<string, unknown> } | null {
  const rows = pluginFishingAreaRows(snapshot, metadata, packetRows, removedPacketObjectIds);
  if (rows.length === 0) return null;
  const parsedAreaId = cleanPositiveInt(areaId, 0);
  const row = parsedAreaId > 0 ? rows.find((entry) => runtimeObjectNumericIds(entry.item).includes(parsedAreaId)) : rows[0];
  const tile = itemRowTile(row);
  if (!row || !tile) return null;
  const area = pluginFishingAreaPayload(row, metadata);
  return {
    x: tile.x,
    y: tile.y,
    furniId: objectNumericId(row.item) ?? 0,
    label: `${itemRowTitle(row, metadata)} (${compactValue(row.item.className ?? row.key)})`,
    area,
  };
}

export function pluginFishingAreaWalkCandidates(
  snapshot: EngineRuntimeSnapshot | null,
  areaId: unknown,
  metadata: FurniMetadataSnapshot | null,
  packetRowsOrMaxRadius: readonly ItemRow[] | number = [],
  maxRadius = 5,
  removedPacketObjectIds: readonly string[] = [],
): readonly { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string; readonly selfDistance: number; readonly area: Record<string, unknown> }[] {
  const packetRows = Array.isArray(packetRowsOrMaxRadius) ? packetRowsOrMaxRadius : [];
  const radiusLimit = typeof packetRowsOrMaxRadius === "number" ? packetRowsOrMaxRadius : maxRadius;
  const target = pluginFishingAreaTarget(snapshot, areaId, metadata, packetRows, removedPacketObjectIds);
  if (!target) return [];

  const rows = mergeRuntimeAndPacketItemRows(snapshot, packetRows).filter((row) => row.kind !== "wall" && itemRowTile(row));
  const users = snapshot?.userState?.users ?? snapshot?.roomObjects?.users ?? [];
  const sessionName = String(snapshot?.userState?.sessionUserName ?? "").trim().toLowerCase();
  const self = users.find((user) => userDisplayName(user, sessionName).trim().toLowerCase() === sessionName) ?? null;
  const selfTile = userTile(self);
  const occupied = new Set<string>();
  const targetObjectId = objectNumericId((target.area.item as RuntimeObjectSummary | undefined) ?? null);

  for (const row of rows) {
    const objectId = objectNumericId(row.item);
    if (targetObjectId !== null && objectId === targetObjectId) continue;
    const tile = itemRowTile(row);
    if (tile) occupied.add(tileKey(tile.x, tile.y));
  }
  for (const user of users) {
    if (self && user.rowId === self.rowId) continue;
    const tile = userTile(user);
    if (tile) occupied.add(tileKey(tile.x, tile.y));
  }

  const radius = Math.max(1, Math.min(10, Math.trunc(radiusLimit)));
  const candidates: Array<{
    readonly x: number;
    readonly y: number;
    readonly axisBias: number;
    readonly rangeBias: number;
    readonly selfDistance: number;
  }> = [];
  for (let y = target.y - radius; y <= target.y + radius; y += 1) {
    for (let x = target.x - radius; x <= target.x + radius; x += 1) {
      if (x < 0 || y < 0) continue;
      if (x === target.x && y === target.y) continue;
      if (occupied.has(tileKey(x, y))) continue;
      const chebyshev = Math.max(Math.abs(x - target.x), Math.abs(y - target.y));
      if (chebyshev > radius) continue;
      const axisBias = x === target.x || y === target.y ? 0 : 1;
      const rangeBias = fishingRangeBias(x, y, target.x, target.y);
      const selfDistance = selfTile ? Math.abs(x - selfTile.x) + Math.abs(y - selfTile.y) : 0;
      candidates.push({ x, y, axisBias, rangeBias, selfDistance });
    }
  }

  return candidates
    .sort((left, right) =>
      left.axisBias - right.axisBias ||
      left.rangeBias - right.rangeBias ||
      left.selfDistance - right.selfDistance ||
      left.y - right.y ||
      left.x - right.x,
    )
    .map((candidate) => ({
      x: candidate.x,
      y: candidate.y,
      furniId: 0,
      label: `walk tile ${candidate.x},${candidate.y} for ${target.label}`,
      selfDistance: candidate.selfDistance,
      area: target.area,
    }));
}

export function pluginFishingAreaWalkTarget(
  snapshot: EngineRuntimeSnapshot | null,
  areaId: unknown,
  metadata: FurniMetadataSnapshot | null,
  packetRows: readonly ItemRow[] = [],
  removedPacketObjectIds: readonly string[] = [],
): { readonly x: number; readonly y: number; readonly furniId: number; readonly label: string; readonly area: Record<string, unknown> } | null {
  return pluginFishingAreaWalkCandidates(snapshot, areaId, metadata, packetRows, 5, removedPacketObjectIds)[0] ?? null;
}

function fishingRangeBias(x: number, y: number, targetX: number, targetY: number): number {
  const chebyshev = Math.max(Math.abs(x - targetX), Math.abs(y - targetY));
  if (x === targetX || y === targetY) {
    if (chebyshev >= 2 && chebyshev <= 3) return 0;
    if (chebyshev === 1) return 1;
    return 2 + chebyshev;
  }
  if (chebyshev === 1) return 10;
  return 20 + chebyshev;
}

export function pluginPlantRows(
  snapshot: EngineRuntimeSnapshot | null,
  metadata: FurniMetadataSnapshot | null,
  selector: unknown = null,
): readonly ItemRow[] {
  return runtimeItemRows(snapshot)
    .filter((row) => row.kind !== "wall" && isPlantLikeObject(row.item) && itemRowTile(row))
    .filter((row) => pluginSelectorIsEmpty(selector) || pluginItemRowMatchesSelector(row, selector, metadata));
}

export function pluginPlantPayload(row: ItemRow, metadata: FurniMetadataSnapshot | null): Record<string, unknown> {
  const tile = itemRowTile(row);
  return {
    id: objectNumericId(row.item),
    objectId: objectNumericId(row.item),
    title: itemRowTitle(row, metadata),
    meta: itemRowMeta(row, metadata),
    className: row.item.className ?? row.item.name ?? null,
    ownerName: row.item.ownerName ?? null,
    state: row.item.state ?? null,
    tile,
    item: row.item,
  };
}

export function pluginPlantCyclePlan(
  snapshot: EngineRuntimeSnapshot | null,
  selector: unknown,
  metadata: FurniMetadataSnapshot | null,
): Record<string, unknown> | null {
  const row = pluginPlantRows(snapshot, metadata, selector)[0];
  const objectId = objectNumericId(row?.item);
  const original = itemRowTile(row);
  if (!row || objectId === null || !original) return null;

  const users = snapshot?.userState?.users ?? snapshot?.roomObjects?.users ?? [];
  const sessionName = compactValue(snapshot?.userState?.sessionUserName).trim().toLowerCase();
  const self = users.find((user) => Boolean((user as RuntimeUserSummary & { readonly isSelf?: unknown }).isSelf))
    ?? users.find((user) => compactValue(user.name ?? user.className).trim().toLowerCase() === sessionName)
    ?? users[0]
    ?? null;
  const itemRows = runtimeItemRows(snapshot);
  const candidates = workingTilesNearSelf(self, row, itemRows, users);
  const working = candidates[0] ?? { x: original.x, y: original.y };
  const workingTiles = candidates.length > 0 ? candidates : [working];

  return {
    objectId,
    plant: pluginPlantPayload(row, metadata),
    original: { x: original.x, y: original.y, direction: original.direction },
    working: { x: working.x, y: working.y, direction: original.direction },
    workingTiles: workingTiles.map((tile) => ({ x: tile.x, y: tile.y, direction: original.direction })),
    candidates: workingTiles.map((tile) => ({ x: tile.x, y: tile.y, direction: original.direction })),
    self: self ? { name: self.name ?? self.className ?? null, tile: userTile(self), direction: self.direction ?? null } : null,
    actions: ["move", "water", "harvest", "return"],
  };
}

export function firstNonEmptyText(values: readonly unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    if (text) return text;
  }
  return "";
}
