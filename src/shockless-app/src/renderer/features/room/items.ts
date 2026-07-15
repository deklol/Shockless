import type { RuntimeItemRow } from "../../../engine-adapter/shocklessSessionAdapter";
import type { FurniMetadataEntry, FurniMetadataSnapshot } from "../../../shared/window-api";
import type { RuntimeInventoryItemSummary, RuntimeObjectSummary } from "../../engineRuntime";
import { compactValue, finiteNumber } from "../common/model";

export function objectTitle(entry: { readonly id?: unknown; readonly objectId?: unknown; readonly className?: unknown; readonly name?: unknown }): string {
  return compactValue(entry.name ?? entry.className ?? entry.objectId ?? entry.id);
}

export function normalizeFurniClassName(value: unknown): string {
  return String(value ?? "").replace(/^ZaC/i, "").trim().toLowerCase();
}

export function furniInfoForClass(metadata: FurniMetadataSnapshot | null, className: unknown): FurniMetadataEntry | null {
  const key = normalizeFurniClassName(className);
  return key ? metadata?.entriesByClass[key] ?? null : null;
}

export function furniInfoForObject(metadata: FurniMetadataSnapshot | null, entry: RuntimeObjectSummary | RuntimeInventoryItemSummary | null | undefined): FurniMetadataEntry | null {
  if (!entry) return null;
  const record = entry as Record<string, unknown>;
  return furniInfoForClass(metadata, record.className ?? record.name);
}

export function furniDisplayName(metadata: FurniMetadataSnapshot | null, entry: RuntimeObjectSummary | RuntimeInventoryItemSummary | null | undefined): string {
  if (!entry) return "-";
  const record = entry as Record<string, unknown>;
  return compactValue(
    furniInfoForObject(metadata, entry)?.name ??
      record.className ??
      record.name ??
      record.objectId ??
      record.itemId ??
      record.id,
  );
}

export function objectMeta(entry: {
  readonly id?: unknown;
  readonly objectId?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly direction?: unknown;
  readonly state?: unknown;
  readonly type?: unknown;
}): string {
  const parts = [
    entry.objectId ?? entry.id ? `id ${compactValue(entry.objectId ?? entry.id)}` : "",
    entry.x !== undefined || entry.y !== undefined ? `xy ${compactValue(entry.x)},${compactValue(entry.y)}` : "",
    entry.direction !== undefined ? `dir ${compactValue(entry.direction)}` : "",
    entry.state !== undefined && entry.state !== null ? `state ${compactValue(entry.state)}` : "",
    entry.type !== undefined ? `type ${compactValue(entry.type)}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "-";
}

export function objectSearchText(entry: RuntimeObjectSummary): string {
  return [
    entry.id,
    entry.objectId,
    entry.className,
    entry.name,
    entry.ownerName,
    entry.type,
    entry.state,
    entry.wall,
    entry.local,
    entry.orientation,
    entry.rawLocation,
  ]
    .map(compactValue)
    .join(" ")
    .toLowerCase();
}

export function isPlantLikeObject(entry: RuntimeObjectSummary): boolean {
  const text = objectSearchText(entry);
  return ["farm", "garden", "plant", "flower", "blossom", "pumpkin", "seed", "compost", "harvest", "water"].some((token) =>
    text.includes(token),
  );
}

export function isFishingAreaObject(entry: RuntimeObjectSummary): boolean {
  const className = normalizeFurniClassName(entry.className ?? entry.name);
  const text = objectSearchText(entry);
  return (
    className.endsWith("fish_area") ||
    className.endsWith("fishing_area") ||
    className === "fisharea" ||
    /\bfish(?:ing)?\s*area\b/.test(text.replace(/[_-]+/g, " "))
  );
}

export function isPresentCatcherHammerObject(entry: RuntimeObjectSummary): boolean {
  return compactValue(entry.className ?? entry.name).trim().toLowerCase() === "toby_hammer";
}

export function isPresentCatcherPresentObject(entry: RuntimeObjectSummary): boolean {
  return compactValue(entry.className ?? entry.name).trim().toLowerCase().startsWith("anniv_present_gen");
}

export function isPresentCatcherGiftItem(entry: RuntimeInventoryItemSummary, classFilter: string): boolean {
  const filter = classFilter.trim().toLowerCase();
  if (!filter) return false;
  const text = [entry.className, entry.itemId, entry.objectId, entry.slotId, entry.inventoryKind].map(compactValue).join(" ").toLowerCase();
  return text.includes(filter);
}

export const presentCatcherPacketHeaders = new Set([65, 74, 78, 90, 93, 94, 1240, 1241, 3400, 3401, 3402, 3403, 3404, 3600, 3601, 3602, 3603, 3604]);

export type ItemRow = RuntimeItemRow;

export function objectNumericId(entry: RuntimeObjectSummary | null | undefined): number | null {
  const parsed = finiteNumber(entry?.objectId ?? entry?.id);
  return parsed === null ? null : Math.trunc(parsed);
}

export function itemRowTile(row: ItemRow | null | undefined): { readonly x: number; readonly y: number; readonly direction: number } | null {
  const x = finiteNumber(row?.item.x);
  const y = finiteNumber(row?.item.y);
  const direction = finiteNumber(row?.item.direction) ?? 0;
  if (x === null || y === null) return null;
  return { x: Math.trunc(x), y: Math.trunc(y), direction: Math.trunc(direction) };
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function objectIdText(entry: RuntimeObjectSummary | null | undefined): string {
  return compactValue(entry?.objectId ?? entry?.id);
}

export function itemRowTitle(row: ItemRow, metadata: FurniMetadataSnapshot | null = null): string {
  return furniDisplayName(metadata, row.item);
}

export function itemRowMeta(row: ItemRow, metadata: FurniMetadataSnapshot | null = null): string {
  const info = furniInfoForObject(metadata, row.item);
  const className = compactValue(row.item.className ?? row.item.name);
  const meta = objectMeta(row.item);
  return info && className !== "-" ? `class ${className} / ${meta}` : meta;
}

export function itemRowSearchText(row: ItemRow, metadata: FurniMetadataSnapshot | null = null): string {
  const info = furniInfoForObject(metadata, row.item);
  return [
    row.label,
    row.source,
    row.key,
    objectTitle(row.item),
    objectMeta(row.item),
    row.item.className,
    row.item.name,
    info?.id,
    info?.name,
    info?.description,
    info?.category,
  ]
    .join(" ")
    .toLowerCase();
}

export function runtimeObjectNumericIds(entry: RuntimeObjectSummary | null | undefined): readonly number[] {
  if (!entry) return [];
  const record = entry as RuntimeObjectSummary & { readonly itemId?: unknown; readonly slotId?: unknown };
  const ids = [record.objectId, record.id, record.itemId, record.slotId]
    .map((value) => finiteNumber(value))
    .filter((value): value is number => value !== null)
    .map((value) => Math.trunc(value))
    .filter((value) => value > 0);
  return [...new Set(ids)];
}
