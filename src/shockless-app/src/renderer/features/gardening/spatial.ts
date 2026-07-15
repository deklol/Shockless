import type { RuntimeUserSummary } from "../../engineRuntime";
import { finiteNumber } from "../common/model";
import { itemRowTile, objectIdText, objectNumericId, tileKey, type ItemRow } from "../room/items";

export function userTile(user: RuntimeUserSummary | null | undefined): { readonly x: number; readonly y: number } | null {
  const directX = finiteNumber(user?.x);
  const directY = finiteNumber(user?.y);
  if (directX !== null && directY !== null) return { x: Math.trunc(directX), y: Math.trunc(directY) };
  const match = String(user?.position ?? "").match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!match) return null;
  return { x: Number.parseInt(match[1]!, 10), y: Number.parseInt(match[2]!, 10) };
}

export const gardeningFacingTilePriority: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  0: [[0, -1], [-1, 0], [1, 0]],
  1: [[1, 0], [0, -1], [-1, 0]],
  2: [[1, 0], [0, -1], [0, 1]],
  3: [[1, 0], [0, 1], [0, -1]],
  4: [[0, 1], [1, 0], [-1, 0]],
  5: [[-1, 0], [0, 1], [1, 0]],
  6: [[-1, 0], [0, 1], [0, -1]],
  7: [[-1, 0], [0, -1], [1, 0]],
};

export const gardeningFallbackTilePriority: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [-1, 0],
  [0, -1],
];

export function occupiedGardeningTiles(
  itemRows: readonly ItemRow[],
  users: readonly RuntimeUserSummary[],
  self: RuntimeUserSummary | null | undefined,
  ignoredObjectId: string,
): Set<string> {
  const occupied = new Set<string>();
  for (const row of itemRows) {
    if (objectIdText(row.item) === ignoredObjectId) continue;
    const tile = itemRowTile(row);
    if (tile) occupied.add(tileKey(tile.x, tile.y));
  }
  for (const user of users) {
    if (self && user.rowId === self.rowId) continue;
    const tile = userTile(user);
    if (tile) occupied.add(tileKey(tile.x, tile.y));
  }
  return occupied;
}

export function workingTileNearSelf(
  self: RuntimeUserSummary | null | undefined,
  fallback: ItemRow | null | undefined,
  itemRows: readonly ItemRow[] = [],
  users: readonly RuntimeUserSummary[] = [],
): { readonly x: number; readonly y: number } | null {
  return workingTilesNearSelf(self, fallback, itemRows, users)[0] ?? null;
}

export function workingTilesNearSelf(
  self: RuntimeUserSummary | null | undefined,
  fallback: ItemRow | null | undefined,
  itemRows: readonly ItemRow[] = [],
  users: readonly RuntimeUserSummary[] = [],
): readonly { readonly x: number; readonly y: number }[] {
  const tile = userTile(self);
  if (tile) {
    const direction = finiteNumber(self?.direction);
    const offsets = direction === null ? gardeningFallbackTilePriority : gardeningFacingTilePriority[Math.trunc(direction) & 7] ?? gardeningFallbackTilePriority;
    const ignoredObjectId = objectIdText(fallback?.item);
    const occupied = occupiedGardeningTiles(itemRows, users, self, ignoredObjectId);
    const candidates = offsets.map(([dx, dy]) => ({ x: tile.x + dx, y: tile.y + dy }));
    return [
      ...candidates.filter((candidate) => !occupied.has(tileKey(candidate.x, candidate.y))),
      ...candidates.filter((candidate) => occupied.has(tileKey(candidate.x, candidate.y))),
    ];
  }
  const plant = itemRowTile(fallback);
  return plant ? [{ x: plant.x, y: plant.y }] : [];
}

export function findCurrentPlantRow(rows: readonly ItemRow[], objectId: number): ItemRow | null {
  return rows.find((row) => objectNumericId(row.item) === objectId) ?? null;
}

export function adjacentTileForItem(
  row: ItemRow | null | undefined,
  itemRows: readonly ItemRow[],
  users: readonly RuntimeUserSummary[],
  self: RuntimeUserSummary | null | undefined,
): { readonly x: number; readonly y: number } | null {
  const tile = itemRowTile(row);
  if (!tile) return null;
  const occupied = occupiedGardeningTiles(itemRows, users, self, objectIdText(row?.item));
  const selfTile = userTile(self);
  const candidates = [
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y - 1 },
  ].filter((candidate) => !occupied.has(tileKey(candidate.x, candidate.y)));
  const pool = candidates.length > 0 ? candidates : [{ x: tile.x, y: tile.y + 1 }];
  if (!selfTile) return pool[0] ?? null;
  return [...pool].sort((left, right) => Math.abs(left.x - selfTile.x) + Math.abs(left.y - selfTile.y) - (Math.abs(right.x - selfTile.x) + Math.abs(right.y - selfTile.y)))[0] ?? null;
}
