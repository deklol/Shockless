export interface RoomAssetVariableOptions {
  enabled?: boolean;
  queueBatchSize?: number;
  queueDelayMs?: number;
  deferDelayMs?: number;
}

export const RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE = "room.dynamic.furniture.cast.list";

const ROOM_DYNAMIC_KEYS = new Set([
  "room.dynamic.assets.enabled",
  "room.asset.buffer.component.class",
  "room.dynamic.furniture.cast.permanent",
  "room.dynamic.furniture.cast.preindex",
  "room.dynamic.furniture.queue.batch.size",
  "room.dynamic.furniture.queue.delay",
  "room.dynamic.furniture.defer.delay",
  RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE,
]);

export function isRelease306DynamicRoomCast(castName: string): boolean {
  const normalized = castName.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return normalized.startsWith("hh_furni") && normalized !== "hh_furni_small";
}

export function release306DynamicRoomCastsFromVariables(text: string): string[] {
  const seen = new Set<string>();
  const casts: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = /^cast\.entry\.\d+=(.+)$/i.exec(line.trim());
    if (!match) continue;
    const castName = match[1]!.trim();
    const key = castName.toLowerCase();
    if (!isRelease306DynamicRoomCast(castName) || seen.has(key)) continue;
    seen.add(key);
    casts.push(castName);
  }
  return casts;
}

export function enableRelease306RoomAssetVariables(
  text: string,
  options: RoomAssetVariableOptions = {},
): string {
  if (options.enabled === false) return text;

  const lines = text.split(/\r\n|\r|\n/);
  const dynamicCasts = release306DynamicRoomCastsFromVariables(text);
  if (dynamicCasts.length === 0) return text;

  const withoutOverrides = lines.filter((line) => {
    const key = line.split("=", 1)[0]!.trim().toLowerCase();
    return !ROOM_DYNAMIC_KEYS.has(key);
  });

  const dynamicLines = [
    "room.dynamic.assets.enabled=1",
    "room.asset.buffer.component.class=Buffer Component Class",
    "room.dynamic.furniture.cast.permanent=1",
    "room.dynamic.furniture.cast.preindex=1",
    `room.dynamic.furniture.queue.batch.size=${Math.max(1, options.queueBatchSize ?? 64)}`,
    `room.dynamic.furniture.queue.delay=${Math.max(1, options.queueDelayMs ?? 1)}`,
    `room.dynamic.furniture.defer.delay=${Math.max(1, options.deferDelayMs ?? 1)}`,
    `${RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE}=[${dynamicCasts.map((castName) => JSON.stringify(castName)).join(", ")}]`,
  ];

  return [...withoutOverrides, ...dynamicLines].join("\r");
}
