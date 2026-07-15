import type { EngineRuntimeSnapshot, EngineRuntimeSnapshotScope, RuntimeObjectSummary, RuntimeUserSummary } from "../../engineRuntime";

export function objectListSignature(items: readonly RuntimeObjectSummary[] | undefined): string {
  if (!items || items.length === 0) return "0";
  return items
    .map((item) =>
      [
        item.objectId ?? item.id ?? "-",
        item.className ?? "-",
        item.x ?? "-",
        item.y ?? "-",
        item.z ?? "-",
        item.direction ?? "-",
        item.state ?? "-",
      ].join(":"),
    )
    .join("|");
}

export function userListSignature(users: readonly RuntimeUserSummary[] | undefined): string {
  if (!users || users.length === 0) return "0";
  return users
    .map((user) =>
      [
        user.rowId,
        user.accountId ?? "-",
        user.roomIndex ?? "-",
        user.position ?? "-",
        user.activity ?? "-",
        user.typing ?? "-",
        user.lastAction ?? "-",
        user.lastSaid ?? "-",
      ].join(":"),
    )
    .join("|");
}

export function inventorySignature(inventory: EngineRuntimeSnapshot["inventory"]): string {
  if (!inventory) return "none";
  return [
    inventory.openState ?? "-",
    inventory.totalCount,
    inventory.itemCount,
    inventory.floorCount,
    inventory.wallCount,
    inventory.items.map((item) => [item.rowId, item.itemId, item.objectId ?? "-", item.slotId ?? "-"].join(":")).join("|"),
  ].join(";");
}

export function navigatorSignature(navigator: EngineRuntimeSnapshot["navigator"]): string {
  if (!navigator) return "none";
  return [
    navigator.total,
    navigator.categories,
    navigator.publicRooms,
    navigator.privateRooms,
    navigator.publicRoomNodes.map((node) => [node.id ?? "-", node.name ?? "-", node.users ?? "-"].join(":")).join("|"),
  ].join(";");
}

export function roomObjectsSignature(roomObjects: EngineRuntimeSnapshot["roomObjects"]): string {
  if (!roomObjects) return "none";
  return [
    JSON.stringify(roomObjects.counts),
    userListSignature(roomObjects.users),
    objectListSignature(roomObjects.activeObjects),
    objectListSignature(roomObjects.passiveObjects),
    objectListSignature(roomObjects.wallItems),
  ].join(";");
}

export function userStateSignature(userState: EngineRuntimeSnapshot["userState"]): string {
  if (!userState) return "none";
  return [
    userState.sessionUserName ?? "-",
    userState.roomName ?? "-",
    userState.roomOwner ?? "-",
    userState.roomId ?? "-",
    userState.roomType ?? "-",
    userState.rights.join("|"),
    userListSignature(userState.users),
  ].join(";");
}

export function chatHistorySignature(chatHistory: EngineRuntimeSnapshot["chatHistory"]): string {
  const last = chatHistory[chatHistory.length - 1];
  return `${chatHistory.length}:${last?.timestamp ?? ""}:${last?.userName ?? ""}:${last?.text ?? ""}`;
}

export function activeSpritesSignature(activeSprites: EngineRuntimeSnapshot["activeSprites"]): string {
  return activeSprites.map((sprite) => [sprite.n ?? "-", sprite.member ?? "-", sprite.loc?.join(",") ?? ""].join(":")).join("|");
}

export function runtimeProbeScopesForPlugin(pluginId: string): readonly EngineRuntimeSnapshotScope[] {
  switch (pluginId) {
    case "dev-tools":
      return ["full"];
    case "info":
      return ["core", "room", "inventory", "navigator"];
    case "room":
    case "user":
    case "items":
    case "wall-mover":
    case "chat":
    case "visitors":
      return ["core", "room"];
    case "inventory":
      return ["core", "inventory"];
    default:
      return ["core"];
  }
}

export function reuseStableRuntimeDetails(
  previous: EngineRuntimeSnapshot | null,
  next: EngineRuntimeSnapshot,
): EngineRuntimeSnapshot {
  if (!previous) return next;
  const scopes = new Set(next.dataScopes ?? ["full"]);
  const hasScope = (scope: string): boolean => scopes.has("full") || scopes.has(scope);
  return {
    ...next,
    roomObjects:
      !hasScope("room") && previous.roomObjects
        ? previous.roomObjects
        :
      roomObjectsSignature(previous.roomObjects) === roomObjectsSignature(next.roomObjects)
        ? previous.roomObjects
        : next.roomObjects,
    userState:
      !hasScope("room") && previous.userState
        ? previous.userState
        :
      userStateSignature(previous.userState) === userStateSignature(next.userState)
        ? previous.userState
        : next.userState,
    inventory:
      !hasScope("inventory") && previous.inventory
        ? previous.inventory
        :
      inventorySignature(previous.inventory) === inventorySignature(next.inventory)
        ? previous.inventory
        : next.inventory,
    navigator:
      !hasScope("navigator") && previous.navigator
        ? previous.navigator
        :
      navigatorSignature(previous.navigator) === navigatorSignature(next.navigator)
        ? previous.navigator
        : next.navigator,
    chatHistory:
      !hasScope("room") && previous.chatHistory.length > 0
        ? previous.chatHistory
        :
      chatHistorySignature(previous.chatHistory) === chatHistorySignature(next.chatHistory)
        ? previous.chatHistory
        : next.chatHistory,
    activeSprites:
      !hasScope("sprites") && previous.activeSprites.length > 0
        ? previous.activeSprites
        :
      activeSpritesSignature(previous.activeSprites) === activeSpritesSignature(next.activeSprites)
        ? previous.activeSprites
        : next.activeSprites,
    windowIds:
      previous.windowIds.join("|") === next.windowIds.join("|")
        ? previous.windowIds
        : next.windowIds,
  };
}
