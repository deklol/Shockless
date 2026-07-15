import type { EngineRuntimeSnapshot } from "../../engineRuntime";
import type { ClientRuntimeSummary, RelayLogSnapshot } from "../../../shared/window-api";

export interface PacketProfileUser {
  readonly name: string;
  readonly accountId: string;
  readonly index: string;
  readonly gender: string;
  readonly motto: string;
  readonly figure: string;
  readonly poolFigure: string;
  readonly badgeCode: string;
  readonly userType: string;
  readonly position: string;
  readonly sourceLine: number;
}

export interface PacketProfileIndex {
  readonly users: readonly PacketProfileUser[];
  readonly byAccountId: ReadonlyMap<string, PacketProfileUser>;
  readonly byName: ReadonlyMap<string, PacketProfileUser>;
  readonly byIndex: ReadonlyMap<string, PacketProfileUser>;
}

export interface PacketInfoFriend {
  readonly accountId: string;
  readonly name: string;
  readonly gender: string;
  readonly motto: string;
  readonly online: boolean;
  readonly canFollow: boolean;
  readonly location: string;
  readonly lastAccess: string;
  readonly figure: string;
  readonly categoryId: string;
  readonly sourceLine: number;
}

export interface PacketInfoEffect {
  readonly name: string;
  readonly value: string;
  readonly sourceLine: number;
}

export interface PacketMessengerMessage {
  readonly key: string;
  readonly id: string;
  readonly senderAccountId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly sourceLine: number;
}

export interface PacketFriendRequest {
  readonly key: string;
  readonly accountId: string;
  readonly name: string;
  readonly requestId: string;
  readonly sourceLine: number;
}

export interface PacketInfoState {
  readonly friends: readonly PacketInfoFriend[];
  readonly badges: readonly string[];
  readonly activeBadgeSlot: string;
  readonly activeBadgeCode: string;
  readonly preferences: readonly string[];
  readonly statusEffects: readonly PacketInfoEffect[];
  readonly privateMessages: readonly PacketMessengerMessage[];
  readonly friendRequests: readonly PacketFriendRequest[];
  readonly messengerMessage: string;
  readonly messengerUserLimit: string;
  readonly messengerRequestCount: string;
  readonly messengerRequestPendingCount: string;
  readonly messengerMessageCount: string;
  readonly messengerUnreadMessageCount: string;
}

export interface PacketInventoryItem {
  readonly key: string;
  readonly itemId: string;
  readonly rawId: string;
  readonly itemIdValue: string;
  readonly slotId: string;
  readonly objectId: string;
  readonly itemType: string;
  readonly inventoryKind: string;
  readonly className: string;
  readonly size: string;
  readonly colors: string;
  readonly data: string;
  readonly head: string;
  readonly body: string;
  readonly meta: string;
  readonly headTokens: string;
  readonly bodyTokens: string;
  readonly metaTokens: string;
  readonly sourceLine: number;
}

export interface PacketInventoryState {
  readonly items: readonly PacketInventoryItem[];
  readonly totalCount: number;
  readonly floorCount: number;
  readonly wallCount: number;
  readonly lastSourceLine: number | null;
}

export interface PacketWallItem {
  readonly key: string;
  readonly itemId: string;
  readonly className: string;
  readonly ownerName: string;
  readonly wall: string;
  readonly local: string;
  readonly orientation: string;
  readonly rawLocation: string;
  readonly data: string;
  readonly state: string;
  readonly sourceLine: number;
}

export interface PacketWallItemState {
  readonly items: readonly PacketWallItem[];
  readonly itemCount: number;
  readonly lastSourceLine: number | null;
}

export interface PacketActiveObject {
  readonly key: string;
  readonly objectId: string;
  readonly className: string;
  readonly x: number;
  readonly y: number;
  readonly z: string;
  readonly direction: number;
  readonly size: string;
  readonly rawPosition: string;
  readonly state: string;
  readonly runtimeData: string;
  readonly stuffData: string;
  readonly trailingData: string;
  readonly sourceLine: number;
}

export interface PacketActiveObjectState {
  readonly items: readonly PacketActiveObject[];
  readonly itemCount: number;
  readonly removedObjectIds: readonly string[];
  readonly lastSourceLine: number | null;
}

export interface PacketChatEntry {
  readonly index: string;
  readonly text: string;
  readonly chatMode: string;
  readonly activity: string;
  readonly sourceLine: number;
}

export interface PacketFishingCatch {
  readonly key: string;
  readonly fishName: string;
  readonly message: string;
  readonly xp: number;
  readonly golden: boolean;
  readonly sourceLine: number;
}

export interface PacketFishopediaEntry {
  readonly key: string;
  readonly fishName: string;
  readonly xp: string;
  readonly catches: string;
  readonly completion: string;
  readonly location: string;
  readonly sourceLine: number;
}

export interface PacketFishingState {
  readonly status: string;
  readonly note: string;
  readonly tokens: string;
  readonly level: string;
  readonly minigameActive: boolean;
  readonly minigamePin: string;
  readonly minigameValues: string;
  readonly catches: number;
  readonly golden: number;
  readonly xp: number;
  readonly frenzies: number;
  readonly fishopedia: readonly PacketFishopediaEntry[];
  readonly catchLog: readonly PacketFishingCatch[];
  readonly lastCatch: PacketFishingCatch | null;
  readonly lastClientAction: string;
  readonly lastClientTargetId: string;
  readonly activeTile: { readonly x: number; readonly y: number; readonly state: number; readonly raw: string; readonly sourceLine: number } | null;
  readonly lastSourceLine: number | null;
}

export interface ClientPluginSnapshot {
  readonly clientId: number;
  readonly label: string;
  readonly relay: RelayLogSnapshot | null;
  readonly runtime: EngineRuntimeSnapshot | null;
  readonly runtimeSummary: ClientRuntimeSummary | null;
  readonly profileUsers: readonly PacketProfileUser[];
  readonly profileIndex: PacketProfileIndex;
  readonly packetInfo: PacketInfoState;
  readonly packetInventory: PacketInventoryState;
  readonly packetWallItems: PacketWallItemState;
  readonly packetActiveObjects: PacketActiveObjectState;
  readonly packetChatEntries: readonly PacketChatEntry[];
  readonly packetFishing: PacketFishingState;
  readonly updatedAt: string | null;
}

export interface InventoryDisplayRow {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly meta: string;
  readonly searchText: string;
  readonly detailRows: readonly { readonly label: string; readonly value: string }[];
}

export const emptyPacketProfileIndex: PacketProfileIndex = {
  users: [],
  byAccountId: new globalThis.Map<string, PacketProfileUser>(),
  byName: new globalThis.Map<string, PacketProfileUser>(),
  byIndex: new globalThis.Map<string, PacketProfileUser>(),
};

export const emptyPacketInfoState: PacketInfoState = {
  friends: [],
  badges: [],
  activeBadgeSlot: "-",
  activeBadgeCode: "-",
  preferences: [],
  statusEffects: [],
  privateMessages: [],
  friendRequests: [],
  messengerMessage: "-",
  messengerUserLimit: "-",
  messengerRequestCount: "-",
  messengerRequestPendingCount: "-",
  messengerMessageCount: "-",
  messengerUnreadMessageCount: "-",
};

export const emptyPacketInventoryState: PacketInventoryState = {
  items: [],
  totalCount: 0,
  floorCount: 0,
  wallCount: 0,
  lastSourceLine: null,
};

export const emptyPacketWallItemState: PacketWallItemState = {
  items: [],
  itemCount: 0,
  lastSourceLine: null,
};

export const emptyPacketActiveObjectState: PacketActiveObjectState = {
  items: [],
  itemCount: 0,
  removedObjectIds: [],
  lastSourceLine: null,
};

export const emptyPacketFishingState: PacketFishingState = {
  status: "idle",
  note: "-",
  tokens: "-",
  level: "-",
  minigameActive: false,
  minigamePin: "-",
  minigameValues: "-",
  catches: 0,
  golden: 0,
  xp: 0,
  frenzies: 0,
  fishopedia: [],
  catchLog: [],
  lastCatch: null,
  lastClientAction: "-",
  lastClientTargetId: "-",
  activeTile: null,
  lastSourceLine: null,
};
