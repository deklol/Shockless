import { runtimeItemRows, runtimeRoomId, runtimeRoomName, runtimeRoomOwner, runtimeRoomProp, runtimeRoomType, type RuntimeItemRow } from "../../../engine-adapter/shocklessSessionAdapter";
import type { FurniMetadataSnapshot, RelayLogEntry } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeChatEntry, RuntimeUserSummary } from "../../engineRuntime";
import type { RendererUserPluginHost } from "../../userPluginHost";
import { relayEntryPlain } from "../packet-console/relayModel";
import { compactValue, userDisplayName, userPosition } from "../common/model";
import { itemRowMeta, itemRowSearchText, itemRowTile, itemRowTitle } from "../room/items";
import { wallMoverLocation } from "../room/wallPlacement";

export interface UserPluginRoomUserCache {
  readonly roomKey: string;
  readonly usersByKey: ReadonlyMap<string, ReturnType<typeof pluginRuntimeUserPayload>>;
}

export interface UserPluginRoomObjectRecord {
  readonly payload: ReturnType<typeof pluginRuntimeItemPayload>;
  readonly signature: string;
}

export interface UserPluginRoomObjectCache {
  readonly roomKey: string;
  readonly itemsByKey: ReadonlyMap<string, UserPluginRoomObjectRecord>;
}

export interface UserPluginChatCache {
  readonly roomKey: string;
  readonly keys: ReadonlySet<string>;
}

export function pluginRoomKey(snapshot: EngineRuntimeSnapshot | null): string {
  if (!snapshot) return "";
  return `${runtimeRoomType(snapshot)}:${runtimeRoomId(snapshot)}:${runtimeRoomName(snapshot)}`;
}

export function pluginRoomPayload(snapshot: EngineRuntimeSnapshot | null) {
  return {
    id: compactValue(runtimeRoomId(snapshot)),
    name: runtimeRoomName(snapshot),
    owner: runtimeRoomOwner(snapshot),
    type: runtimeRoomType(snapshot),
    layout: compactValue(runtimeRoomProp(snapshot, "#layout") ?? runtimeRoomProp(snapshot, "layout")),
    ready: Boolean(snapshot?.roomReady?.ready ?? snapshot?.roomEntryState?.roomReady?.ready),
  };
}

export function pluginRuntimeUserKey(user: RuntimeUserSummary, sessionName?: string | null): string {
  const accountId = compactValue(user.accountId);
  if (accountId !== "-") return `account:${accountId}`;
  const roomIndex = compactValue(user.roomIndex);
  if (roomIndex !== "-") return `room-index:${roomIndex}`;
  return `row:${user.rowId}:${userDisplayName(user, sessionName).trim().toLowerCase()}`;
}

export function pluginRuntimeUserPayload(user: RuntimeUserSummary, sessionName?: string | null) {
  const displayName = userDisplayName(user, sessionName);
  const kind = pluginRuntimeUserKind(user, sessionName);
  return {
    key: pluginRuntimeUserKey(user, sessionName),
    id: compactValue(user.id ?? user.objectId ?? user.rowId),
    rowId: user.rowId,
    roomIndex: compactValue(user.roomIndex),
    accountId: compactValue(user.accountId),
    name: displayName,
    isSelf: Boolean(sessionName && displayName.trim().toLowerCase() === String(sessionName).trim().toLowerCase()),
    figure: compactValue(user.figure),
    gender: compactValue(user.gender),
    motto: compactValue(user.motto),
    badgeCode: compactValue(user.badgeCode),
    userType: compactValue(user.userType ?? user.type ?? user.objectClass),
    kind,
    isBot: kind === "bot",
    isHuman: kind === "human" || kind === "self",
    position: userPosition(user),
    activity: compactValue(user.activity),
    typing: user.typing ?? null,
    expression: compactValue(user.expression),
    lastSaid: compactValue(user.lastSaid),
  };
}

export function pluginRuntimeItemSignature(row: RuntimeItemRow): string {
  const item = row.item;
  return JSON.stringify({
    key: row.key,
    kind: row.kind,
    id: compactValue(item.objectId ?? item.id),
    className: compactValue(item.className ?? item.name),
    name: compactValue(item.name),
    ownerName: compactValue(item.ownerName),
    x: compactValue(item.x),
    y: compactValue(item.y),
    z: compactValue(item.z),
    direction: compactValue(item.direction),
    wall: compactValue(item.wall),
    local: compactValue(item.local),
    orientation: compactValue(item.orientation),
    rawLocation: compactValue(item.rawLocation),
    state: compactValue(item.state),
    type: compactValue(item.type),
  });
}

export function pluginRuntimeItemPayload(row: RuntimeItemRow, metadata: FurniMetadataSnapshot | null = null) {
  const item = row.item;
  const tile = itemRowTile(row);
  const wallLocation = wallMoverLocation(item);
  return {
    key: row.key,
    kind: row.kind,
    label: row.label,
    source: row.source,
    id: compactValue(item.objectId ?? item.id),
    objectId: compactValue(item.objectId),
    itemId: compactValue(item.id),
    className: compactValue(item.className ?? item.name),
    name: itemRowTitle(row, metadata),
    ownerName: compactValue(item.ownerName),
    meta: itemRowMeta(row, metadata),
    searchText: itemRowSearchText(row, metadata),
    tile,
    wallLocation,
    wall: compactValue(item.wall),
    local: compactValue(item.local),
    orientation: compactValue(item.orientation ?? item.direction),
    rawLocation: compactValue(item.rawLocation),
    state: item.state ?? null,
    type: compactValue(item.type),
    raw: item,
  };
}

export function pluginRoomObjectRecords(
  snapshot: EngineRuntimeSnapshot | null,
  metadata: FurniMetadataSnapshot | null,
): ReadonlyMap<string, UserPluginRoomObjectRecord> {
  const map = new globalThis.Map<string, UserPluginRoomObjectRecord>();
  for (const row of runtimeItemRows(snapshot)) {
    map.set(row.key, {
      payload: pluginRuntimeItemPayload(row, metadata),
      signature: pluginRuntimeItemSignature(row),
    });
  }
  return map;
}

export function pluginRoomObjectsPayload(snapshot: EngineRuntimeSnapshot | null, clientId: number, metadata: FurniMetadataSnapshot | null) {
  const items = [...pluginRoomObjectRecords(snapshot, metadata).values()].map((record) => record.payload);
  const floorItems = items.filter((item) => item.kind !== "wall");
  const wallItems = items.filter((item) => item.kind === "wall");
  return {
    clientId,
    room: pluginRoomPayload(snapshot),
    counts: {
      total: items.length,
      floorItems: floorItems.length,
      wallItems: wallItems.length,
      activeObjects: snapshot?.roomObjects?.counts.activeObjects ?? 0,
      passiveObjects: snapshot?.roomObjects?.counts.passiveObjects ?? 0,
    },
    items,
    floorItems,
    wallItems,
  };
}

export function dispatchPluginRoomItemEvent(
  host: RendererUserPluginHost,
  phase: "Added" | "Updated" | "Removed",
  clientId: number,
  room: ReturnType<typeof pluginRoomPayload>,
  item: ReturnType<typeof pluginRuntimeItemPayload>,
  previous: ReturnType<typeof pluginRuntimeItemPayload> | null = null,
): void {
  const payload = { clientId, room, item, previous };
  host.dispatchEvent(`room.item${phase}`, payload);
  host.dispatchEvent(`room.${item.kind === "wall" ? "wallItem" : "floorItem"}${phase}`, payload);
}

const fishingPublicRoomNpcNames = new Set(["bob", "recruiter blaze"]);

export function pluginRuntimeUserKind(user: RuntimeUserSummary, sessionName?: string | null): "self" | "human" | "bot" | "unknown" {
  const displayName = userDisplayName(user, sessionName).trim();
  const normalizedName = displayName.toLowerCase();
  const normalizedSession = String(sessionName ?? "").trim().toLowerCase();
  if (normalizedName && normalizedSession && normalizedName === normalizedSession) return "self";
  if (fishingPublicRoomNpcNames.has(normalizedName)) return "bot";
  const type = compactValue(user.userType ?? user.type ?? user.objectClass ?? user.className).trim().toLowerCase();
  const sourceText = [type, user.objectClass, user.className].map(compactValue).join(" ").toLowerCase();
  if (type === "1" || sourceText.includes("human")) return "human";
  if ((/^\d+$/.test(type) && type !== "1") || sourceText.includes("bot") || sourceText.includes("pet")) return "bot";
  if (compactValue(user.accountId) !== "-" || compactValue(user.figure) !== "-") return "human";
  return "unknown";
}

export function pluginRoomOccupantsPayload(snapshot: EngineRuntimeSnapshot | null) {
  const sessionName = snapshot?.userState?.sessionUserName ?? null;
  const users = (snapshot?.userState?.users ?? []).map((user) => pluginRuntimeUserPayload(user, sessionName));
  const humans = users.filter((user) => user.kind === "human" || user.kind === "self");
  const others = users.filter((user) => user.kind === "human");
  const bots = users.filter((user) => user.kind === "bot");
  const unknown = users.filter((user) => user.kind === "unknown");
  return {
    totalCount: users.length,
    humanCount: humans.length,
    otherHumanCount: others.length,
    botCount: bots.length,
    unknownCount: unknown.length,
    safeToAutomate: others.length === 0,
    self: users.find((user) => user.kind === "self") ?? null,
    bob: users.find((user) => String(user.name ?? "").trim().toLowerCase() === "bob") ?? null,
    users,
    otherHumans: others,
    bots,
    unknown,
  };
}

export function pluginRoomUsersPayload(snapshot: EngineRuntimeSnapshot | null, clientId: number) {
  const sessionName = snapshot?.userState?.sessionUserName ?? null;
  const users = snapshot?.userState?.users ?? [];
  return {
    clientId,
    room: pluginRoomPayload(snapshot),
    users: users.map((user) => pluginRuntimeUserPayload(user, sessionName)),
  };
}

export function pluginRelayPacketPayload(entry: RelayLogEntry, updatedAt?: string | null) {
  const direction = entry.direction === "CLIENT" ? "client" : entry.direction === "SERVER" ? "server" : "relay";
  return {
    id: entry.id,
    lineNumber: entry.lineNumber,
    clientId: entry.clientId ?? 1,
    clientLabel: entry.clientLabel,
    sessionId: entry.sessionId,
    direction,
    route: entry.route,
    mode: entry.mode,
    header: entry.header,
    packetName: entry.packetName,
    size: entry.size,
    payloadBytes: entry.payloadBytes,
    bodyStatus: entry.bodyStatus,
    bodyText: entry.bodyText,
    bodyHex: entry.bodyHex,
    bodyAscii: entry.bodyAscii,
    bodyTruncated: entry.bodyTruncated,
    bodyNote: entry.bodyNote,
    message: entry.message,
    decodedFields: entry.decodedFields,
    plainText: relayEntryPlain(entry, updatedAt),
  };
}

export function pluginChatPayload(entry: RuntimeChatEntry, clientId: number, room: ReturnType<typeof pluginRoomPayload>) {
  return {
    clientId,
    room,
    index: entry.index ?? null,
    timestamp: entry.timestamp ?? null,
    userName: entry.userName ?? "System",
    userId: entry.userId ?? null,
    mode: entry.chatMode ?? "talk",
    text: entry.text ?? "",
  };
}
