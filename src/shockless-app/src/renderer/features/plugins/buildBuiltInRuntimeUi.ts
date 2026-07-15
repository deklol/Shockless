import {
  runtimeFps,
  runtimeLocation,
  runtimeRoomId,
  runtimeRoomName,
  runtimeRoomOwner,
  runtimeRoomProp,
  runtimeRoomType,
  runtimeTickRate,
  type RuntimeItemRow,
} from "../../../engine-adapter/shocklessSessionAdapter";
import type { PluginDefinition, PluginRegistryState } from "../../../shared/plugin";
import { buildShockwavePluginPacketFromControl } from "../../../shared/shockwavePluginPacketBuilder";
import type {
  ClientProfileSummary,
  ClientSessionList,
  ClientSessionSummary,
  EngineLaunchState,
  FurniMetadataEntry,
  FurniMetadataSnapshot,
  MimicStateSnapshot,
  OriginsUserLookupResult,
  RelayLogEntry,
  RelayLogSnapshot,
} from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeChatEntry, RuntimeUserSummary } from "../../engineRuntime";
import {
  chatEntryLabel,
  compactValue,
  labelCase,
  mimicCategoryOptions,
  profileLine,
  profileValue,
  statusLabel,
  userDisplayName,
  userPosition,
  userRowMeta,
} from "../common/model";
import { originsLookupLine } from "../console/commandRouting";
import type { HideListEntry } from "../hide-list/model";
import {
  clampMultiAccountConcurrency,
  clampMultiAccountCount,
  clampRepeatCount,
  clampRepeatInterval,
  type InjectionCommandDraft,
  type InjectionHistoryEntry,
  type InjectionSnippet,
} from "../injection/model";
import {
  relayEntryDisplayName,
  relayEntryPlain,
  relayEntryV3Line,
  relayPacketSummary,
} from "../packet-console/relayModel";
import { packetProfileForRuntimeUser } from "../packets/profile";
import { packetFriendMeta, packetFriendTitle } from "../packets/social";
import type {
  InventoryDisplayRow,
  PacketFriendRequest,
  PacketInfoFriend,
  PacketInfoState,
  PacketMessengerMessage,
  PacketProfileIndex,
} from "../packets/types";
import { itemRowMeta, itemRowTitle, objectIdText, objectMeta } from "../room/items";
import { wallMoverLocation, wallObjectMeta, type WallMoverLocation } from "../room/wallPlacement";
import type { VisitorEntry, VisitorTrackerState } from "../visitors/model";
import { schemaButton, schemaButtonGrid, schemaKv, schemaLog, schemaSection, schemaTable } from "./schemaBuilders";
import type { RuntimePluginUiState } from "./runtimeUiState";

export interface BuiltInRuntimeUiContext {
  readonly activeStoredUserLook: string;
  readonly automationMessage: string;
  readonly automationPrefs: { readonly autoHideBulletin: boolean };
  readonly availablePlugins: readonly PluginDefinition[];
  readonly chatDraft: string;
  readonly chatFilters: { readonly talk: boolean; readonly whisper: boolean; readonly shout: boolean; readonly system: boolean; readonly autoscroll: boolean };
  readonly clientSessions: ClientSessionList | null;
  readonly effectiveHiddenUserEntries: readonly string[];
  readonly engineLaunch: EngineLaunchState | null;
  readonly engineProfileLabel: string;
  readonly engineUserNameLabels: boolean;
  readonly filteredInventoryRows: readonly InventoryDisplayRow[];
  readonly filteredItemRows: readonly RuntimeItemRow[];
  readonly filteredPacketFriends: readonly PacketInfoFriend[];
  readonly filteredVisitorEntries: readonly VisitorEntry[];
  readonly floorAnywhereMessage: string;
  readonly floorItemAnywhereEnabled: boolean;
  readonly furniMetadata: FurniMetadataSnapshot | null;
  readonly gameZoom: 1 | 2;
  readonly hideListMessage: string;
  readonly hideListPluginEnabled: boolean;
  readonly hideListReason: string;
  readonly hideListRecords: readonly HideListEntry[];
  readonly hideListTarget: string;
  readonly injectionDraft: InjectionCommandDraft;
  readonly injectionHistory: readonly InjectionHistoryEntry[];
  readonly injectionMessage: string;
  readonly injectionRepeatCount: string;
  readonly injectionRepeatInterval: string;
  readonly injectionSendAll: boolean;
  readonly injectionSnippets: readonly InjectionSnippet[];
  readonly inventoryFilter: string;
  readonly inventoryFloorCount: number;
  readonly inventoryRowCount: number;
  readonly inventoryTotalCount: number;
  readonly inventoryUsesPacketRows: boolean;
  readonly inventoryWallCount: number;
  readonly itemFilter: string;
  readonly itemRows: readonly RuntimeItemRow[];
  readonly itemWallCount: number;
  readonly latestClientPacket: RelayLogEntry | null;
  readonly latestServerPacket: RelayLogEntry | null;
  readonly mimicState: MimicStateSnapshot | null;
  readonly missingVisitorAccountIds: number;
  readonly multiAccountConcurrency: string;
  readonly multiAccountCount: string;
  readonly multiAccountFile: string;
  readonly multiAccountLoadMode: "headless" | "visible";
  readonly multiAccountMessage: string;
  readonly multiAccountSummonTarget: string;
  readonly onlinePacketFriends: number;
  readonly packetClientChoices: readonly { readonly value: string; readonly label: string }[];
  readonly packetEntries: readonly RelayLogEntry[];
  readonly packetExportMessage: string;
  readonly packetFilters: { readonly client: boolean; readonly server: boolean; readonly relay: boolean; readonly wrap: boolean; readonly autoscroll: boolean; readonly clientSession: string; readonly session: string; readonly search: string };
  readonly packetInfoState: PacketInfoState;
  readonly packetProfileIndex: PacketProfileIndex;
  readonly packetSessionChoices: readonly string[];
  readonly pinnedPluginIds: ReadonlySet<string>;
  readonly pluginEnabledById: Readonly<Record<string, boolean>>;
  readonly pluginRegistryState: PluginRegistryState | null;
  readonly publicLookupBusy: boolean;
  readonly publicLookupName: string;
  readonly publicLookupResult: OriginsUserLookupResult | null;
  readonly publicRoomQuery: string;
  readonly relayBodyLoggingState: string;
  readonly relayClientModes: string;
  readonly relayEncryptionState: string;
  readonly relayLog: RelayLogSnapshot | null;
  readonly relayServerModes: string;
  readonly relaySessionId: string;
  readonly roomStageClickX: string;
  readonly roomStageClickY: string;
  readonly selectedClientId: number;
  readonly selectedClientIsVisible: boolean;
  readonly selectedClientSession: ClientSessionSummary | null;
  readonly selectedInjectionSnippetId: string;
  readonly selectedInventoryRow: InventoryDisplayRow | null;
  readonly selectedItemMetadata: FurniMetadataEntry | null;
  readonly selectedItemRow: RuntimeItemRow | null;
  readonly selectedPacketEntry: RelayLogEntry | null;
  readonly selectedProfile: ClientProfileSummary | null;
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly selectedStoredUserLook: string;
  readonly selectedUser: RuntimeUserSummary | null;
  readonly selectedUserAccountId: string;
  readonly selectedUserBadgeCode: string;
  readonly selectedUserFigure: string;
  readonly selectedUserGender: string;
  readonly selectedUserIndex: string;
  readonly selectedUserMotto: string;
  readonly selectedUserName: string;
  readonly selectedUserPosition: string;
  readonly selectedWallMoverItemId: number | null;
  readonly selectedWallMoverLocation: WallMoverLocation | null;
  readonly selectedWallMoverRow: RuntimeItemRow | null;
  readonly socialDraft: string;
  readonly socialFriendFilter: string;
  readonly socialMessage: string;
  readonly socialMessageCount: string;
  readonly socialRequestCount: string;
  readonly socialTarget: string;
  readonly userRows: readonly RuntimeUserSummary[];
  readonly userStoredLooks: readonly string[];
  readonly userToolMessage: string;
  readonly visibleChatHistory: readonly RuntimeChatEntry[];
  readonly visibleFriendRequests: readonly PacketFriendRequest[];
  readonly visiblePacketEntries: readonly RelayLogEntry[];
  readonly visiblePrivateMessages: readonly PacketMessengerMessage[];
  readonly visitorEntries: readonly VisitorEntry[];
  readonly visitorFilter: string;
  readonly visitorLookupBusy: boolean;
  readonly visitorLookupMessage: string;
  readonly visitorRoomName: string;
  readonly visitorState: VisitorTrackerState;
  readonly wallAnywhereMessage: string;
  readonly wallItemAnywhereEnabled: boolean;
  readonly wallMoverMessage: string;
  readonly wallMoverRows: readonly RuntimeItemRow[];
  readonly wallMoverStep: string;
}

export function buildBuiltInRuntimeUi(context: BuiltInRuntimeUiContext): Readonly<Record<string, RuntimePluginUiState>> {
  const {
    activeStoredUserLook, automationMessage, automationPrefs, availablePlugins, chatDraft, chatFilters, clientSessions,
    effectiveHiddenUserEntries, engineLaunch, engineProfileLabel, engineUserNameLabels, filteredInventoryRows, filteredItemRows,
    filteredPacketFriends, filteredVisitorEntries, floorAnywhereMessage, floorItemAnywhereEnabled, furniMetadata, gameZoom,
    hideListMessage, hideListPluginEnabled, hideListReason, hideListRecords, hideListTarget, injectionDraft, injectionHistory,
    injectionMessage, injectionRepeatCount, injectionRepeatInterval, injectionSendAll, injectionSnippets, inventoryFilter, inventoryFloorCount,
    inventoryRowCount, inventoryTotalCount, inventoryUsesPacketRows, inventoryWallCount, itemFilter, itemRows, itemWallCount,
    latestClientPacket, latestServerPacket, mimicState, missingVisitorAccountIds, multiAccountConcurrency, multiAccountCount,
    multiAccountFile, multiAccountLoadMode, multiAccountMessage, multiAccountSummonTarget, onlinePacketFriends,
    packetClientChoices, packetEntries, packetExportMessage, packetFilters, packetInfoState, packetProfileIndex,
    packetSessionChoices, pinnedPluginIds, pluginEnabledById, pluginRegistryState, publicLookupBusy, publicLookupName,
    publicLookupResult, publicRoomQuery, relayBodyLoggingState, relayClientModes, relayEncryptionState, relayLog,
    relayServerModes, relaySessionId, roomStageClickX, roomStageClickY, selectedClientId, selectedClientIsVisible,
    selectedClientSession, selectedInjectionSnippetId, selectedInventoryRow, selectedItemMetadata, selectedItemRow,
    selectedPacketEntry, selectedProfile, selectedRuntimeSnapshot, selectedStoredUserLook, selectedUser, selectedUserAccountId,
    selectedUserBadgeCode, selectedUserFigure, selectedUserGender, selectedUserIndex, selectedUserMotto, selectedUserName,
    selectedUserPosition, selectedWallMoverItemId, selectedWallMoverLocation, selectedWallMoverRow, socialDraft,
    socialFriendFilter, socialMessage, socialMessageCount, socialRequestCount, socialTarget, userRows, userStoredLooks,
    userToolMessage, visibleChatHistory, visibleFriendRequests, visiblePacketEntries, visiblePrivateMessages, visitorEntries,
    visitorFilter, visitorLookupBusy, visitorLookupMessage, visitorRoomName, visitorState, wallAnywhereMessage,
    wallItemAnywhereEnabled, wallMoverMessage, wallMoverRows, wallMoverStep,
  } = context;

  const injectionPacketPreview = buildShockwavePluginPacketFromControl({
    target: injectionDraft.rawDirection === "CLIENT" ? "client" : "server",
    packetText: injectionDraft.rawText,
  });

  return {
    connection: {
      values: {},
      surfaces: {
        panel: [
          schemaSection("Session", [
            schemaKv([
              ["Selected", `client${selectedClientId} ${selectedClientSession?.label ?? "-"}`],
              ["Mode", selectedClientSession?.headless ? "Headless" : selectedClientIsVisible ? "Visible" : "Hidden"],
              ["State", selectedClientSession?.status ?? engineLaunch?.status ?? "-"],
              ["Profile", selectedProfile ? profileLine(selectedProfile) : engineProfileLabel],
              ["Room", runtimeRoomName(selectedRuntimeSnapshot)],
              ["Relay", relayLog?.exists ? `${packetEntries.length} rows` : "No relay log"],
              ["Crypto", relayEncryptionState],
            ]),
            schemaButtonGrid([
              schemaButton("Refresh", "connection.refresh"),
              schemaButton("Start", "connection.start", "primary"),
              schemaButton("Stop", "connection.stop", "danger"),
              schemaButton("Import / Build Client", "connection.import"),
            ], 4),
          ]),
          schemaTable(
            "Clients",
            [
              ["id", "ID"],
              ["label", "Label"],
              ["state", "State"],
              ["mode", "Mode"],
              ["room", "Room"],
            ],
            (clientSessions?.sessions ?? []).map((session) => ({
              id: String(session.id),
              label: session.label,
              state: session.selected ? "Selected" : statusLabel(session.status),
              mode: session.headless ? "Headless" : session.visible ? "Visible" : "Hidden",
              room: compactValue(session.roomName ?? session.profileLabel),
            })),
            { rowKey: "id", selectedRowKey: String(selectedClientId), rowAction: "multi.selectClient", maxRows: 18 },
          ),
        ],
      },
    },
    "multi-account": {
      values: {
        multiAccountFile,
        multiAccountCount: clampMultiAccountCount(multiAccountCount),
        multiAccountConcurrency: clampMultiAccountConcurrency(multiAccountConcurrency),
        multiAccountLoadMode,
        multiAccountSummonTarget,
      },
      surfaces: {
        panel: [
          schemaSection("Load Clients", [
            { type: "textInput", id: "multiAccountFile", label: "Account File", defaultValue: multiAccountFile, action: "multi.file" },
            { type: "numberInput", id: "multiAccountCount", label: "Count", min: 1, max: 50, step: 1, defaultValue: clampMultiAccountCount(multiAccountCount), action: "multi.count" },
            { type: "numberInput", id: "multiAccountConcurrency", label: "Concurrency", min: 1, max: 8, step: 1, defaultValue: clampMultiAccountConcurrency(multiAccountConcurrency), action: "multi.concurrency" },
            { type: "select", id: "multiAccountLoadMode", label: "Load Mode", defaultValue: multiAccountLoadMode, action: "multi.loadMode", options: [{ value: "headless", label: "Headless" }, { value: "visible", label: "Visible" }] },
            schemaButtonGrid([
              schemaButton("Load Headless", "multi.loadHeadless", "primary"),
              schemaButton("Load Visible", "multi.loadVisible", "primary"),
              schemaButton("New Visible", "multi.newVisible"),
              schemaButton("Summon All", "multi.summonAll"),
            ], 4),
          ]),
          schemaSection("Mimic", [
            schemaKv([
              ["Enabled", mimicState?.enabled ? "Yes" : "No"],
              ["Source", mimicState?.sourceClientId ? `client${mimicState.sourceClientId}` : "-"],
              ["Targets", mimicState?.targetClientIds.length ? mimicState.targetClientIds.map((id) => `client${id}`).join(", ") : "-"],
              ["Categories", mimicCategoryOptions.filter((option) => mimicState?.categories[option.id]).map((option) => option.label).join(", ") || "-"],
            ]),
            schemaButtonGrid([
              schemaButton("Mimic On", "multi.mimicOn", "primary"),
              schemaButton("Mimic Off", "multi.mimicOff", "danger"),
              schemaButton("Mimic Status", "multi.mimicStatus"),
              schemaButton("Set Main", "multi.setMain"),
            ], 4),
          ]),
          schemaTable("Sessions", [["id", "ID"], ["label", "Label"], ["status", "Status"], ["room", "Room"], ["main", "Main"]], (clientSessions?.sessions ?? []).map((session) => ({
            id: String(session.id),
            label: session.label,
            status: `${session.headless ? "Headless" : session.visible ? "Visible" : "Hidden"} / ${statusLabel(session.status)}`,
            room: compactValue(session.roomName ?? session.profileLabel),
            main: session.main ? "Yes" : "",
          })), { rowKey: "id", selectedRowKey: String(selectedClientId), rowAction: "multi.selectClient", maxRows: 30 }),
          schemaLog("Last Result", multiAccountMessage ? multiAccountMessage.split(/\r?\n/).slice(-8) : ["No multi-account action has run this session."]),
        ],
      },
    },
    info: {
      values: { publicLookupName },
      surfaces: {
        panel: [
          schemaSection("Summary", [
            schemaKv([
              ["Account", selectedRuntimeSnapshot?.userState?.sessionUserName ?? selectedClientSession?.username ?? "-"],
              ["Room", runtimeRoomName(selectedRuntimeSnapshot)],
              ["Owner", runtimeRoomOwner(selectedRuntimeSnapshot)],
              ["Layout", runtimeRoomProp(selectedRuntimeSnapshot, "layout")],
              ["Friends", packetInfoState.friends.length],
              ["Badges", packetInfoState.badges.length],
              ["Inventory", inventoryTotalCount],
              ["Rights", selectedRuntimeSnapshot?.userState?.rightsCount ?? 0],
              ["Effects", packetInfoState.statusEffects.length],
            ]),
          ]),
          schemaSection("Lookup", [
            { type: "textInput", id: "publicLookupName", label: "Habbo Name", defaultValue: publicLookupName || selectedUserName, action: "info.lookupName" },
            schemaButtonGrid([schemaButton(publicLookupBusy ? "Looking Up..." : "Lookup User", "info.lookup", "primary")], 1),
            schemaLog("Lookup Result", publicLookupResult ? [originsLookupLine(publicLookupResult, publicLookupName || selectedUserName)] : ["No public lookup result yet."]),
          ]),
          schemaTable("Friends", [["name", "Name"], ["id", "ID"], ["state", "State"]], filteredPacketFriends.slice(0, 40).map((friend) => ({
            name: packetFriendTitle(friend),
            id: compactValue(friend.accountId),
            state: packetFriendMeta(friend),
          })), { maxRows: 40 }),
          schemaTable("Badges", [["badge", "Badge"]], packetInfoState.badges.slice(0, 80).map((badge) => ({ badge })), { maxRows: 80 }),
        ],
      },
    },
    room: {
      values: { publicRoomQuery, roomStageClickX, roomStageClickY },
      surfaces: {
        panel: [
          schemaSection("Room", [
            schemaKv([
              ["Name", runtimeRoomName(selectedRuntimeSnapshot)],
              ["ID", runtimeRoomId(selectedRuntimeSnapshot)],
              ["Type", runtimeRoomType(selectedRuntimeSnapshot)],
              ["Owner", runtimeRoomOwner(selectedRuntimeSnapshot)],
              ["Users", selectedRuntimeSnapshot?.userState?.roomUserCount ?? userRows.length],
              ["Items", itemRows.length],
              ["Floor", itemRows.filter((row) => row.kind !== "wall").length],
              ["Wall", itemWallCount],
            ]),
            schemaButtonGrid([
              schemaButton("Refresh Room", "room.refresh"),
              schemaButton("Open Navigator", "room.navigator"),
              schemaButton("Hotel View", "room.hotelView"),
              schemaButton(gameZoom === 2 ? "Zoom 100%" : "Zoom 200%", "room.toggleZoom"),
            ], 4),
          ]),
          schemaSection("Entry / Walk", [
            { type: "textInput", id: "publicRoomQuery", label: "Room Query / ID", defaultValue: publicRoomQuery, action: "room.query" },
            { type: "textInput", id: "roomStageClickX", label: "Stage X", defaultValue: roomStageClickX, action: "room.stageX" },
            { type: "textInput", id: "roomStageClickY", label: "Stage Y", defaultValue: roomStageClickY, action: "room.stageY" },
            schemaButtonGrid([
              schemaButton("Enter Private", "room.enterPrivate", "primary"),
              schemaButton("Enter Public", "room.enterPublic"),
              schemaButton("Stage Click", "room.stageClick"),
            ], 3),
          ]),
          schemaTable("Users", [["name", "Name"], ["id", "ID"], ["tile", "Tile"], ["activity", "Activity"]], userRows.map((user) => ({
            key: user.rowId,
            name: userDisplayName(user, selectedRuntimeSnapshot?.userState?.sessionUserName),
            id: compactValue(user.accountId),
            tile: userPosition(user),
            activity: compactValue(user.activity ?? user.lastAction),
          })), { rowKey: "key", selectedRowKey: selectedUser?.rowId, rowAction: "user.select", maxRows: 40 }),
          schemaTable("Room Items", [["name", "Item"], ["kind", "Kind"], ["id", "ID"], ["pos", "Position"]], filteredItemRows.slice(0, 80).map((row) => ({
            key: row.key,
            name: itemRowTitle(row, furniMetadata),
            kind: labelCase(row.kind),
            id: objectIdText(row.item),
            pos: row.kind === "wall" ? wallObjectMeta(row.item) : objectMeta(row.item),
          })), { rowKey: "key", selectedRowKey: selectedItemRow?.key, rowAction: "items.select", maxRows: 80 }),
        ],
      },
    },
    user: {
      values: {
        engineUserNameLabels,
        selectedStoredUserLook: activeStoredUserLook,
      },
      surfaces: {
        panel: [
          schemaSection("Selected User", [
            schemaKv([
              ["Name", selectedUserName],
              ["Account ID", selectedUserAccountId],
              ["Room Index", selectedUserIndex],
              ["Gender", selectedUserGender],
              ["Badge", selectedUserBadgeCode],
              ["Motto", selectedUserMotto],
              ["Position", selectedUserPosition],
              ["Direction", compactValue(selectedUser?.direction)],
              ["Figure", selectedUserFigure],
            ]),
            { type: "toggle", id: "engineUserNameLabels", label: "Render Names Above Heads", defaultValue: engineUserNameLabels, action: "user.nameLabels" },
            schemaButtonGrid([
              schemaButton("Wave", "user.wave", "primary"),
              schemaButton("Dance 1", "user.dance1"),
              schemaButton("Dance 2", "user.dance2"),
              schemaButton("Dance 3", "user.dance3"),
              schemaButton("Dance 4", "user.dance4"),
              schemaButton("Stop Dance", "user.stopDance"),
              schemaButton("Carry Drink", "user.carryDrink"),
              schemaButton("Copy Profile", "user.copyProfile"),
            ], 4),
          ]),
          schemaTable("Room Users", [["name", "Name"], ["id", "ID"], ["idx", "Index"], ["tile", "Tile"], ["state", "State"]], userRows.map((user) => ({
            key: user.rowId,
            name: userDisplayName(user, selectedRuntimeSnapshot?.userState?.sessionUserName),
            id: profileValue(user.accountId, packetProfileForRuntimeUser(packetProfileIndex, user, selectedRuntimeSnapshot?.userState?.sessionUserName)?.accountId),
            idx: compactValue(user.roomIndex ?? user.rowId),
            tile: userPosition(user),
            state: userRowMeta(user),
          })), { rowKey: "key", selectedRowKey: selectedUser?.rowId, rowAction: "user.select", maxRows: 50 }),
          schemaSection("Looks", [
            { type: "select", id: "selectedStoredUserLook", label: "Stored Look", defaultValue: activeStoredUserLook, action: "user.selectStoredLook", options: userStoredLooks.length ? userStoredLooks.map((look) => ({ value: look, label: look.slice(0, 80) })) : [{ value: "", label: "No stored looks" }] },
            schemaButtonGrid([
              schemaButton("Store Selected Look", "user.storeLook"),
              schemaButton("Apply Stored Look", "user.applyStoredLook", "primary"),
              schemaButton("Copy Stored Look", "user.copyStoredLook"),
              schemaButton("Clear Stored Looks", "user.clearStoredLooks", "danger"),
            ], 4),
            schemaLog("Status", userToolMessage ? [userToolMessage] : ["No user action has run this session."]),
          ]),
        ],
      },
    },
    social: {
      values: { socialTarget, socialDraft, socialFriendFilter },
      surfaces: {
        panel: [
          schemaSection("Messages / Requests", [
            schemaKv([
              ["Friends", `${onlinePacketFriends}/${packetInfoState.friends.length} online`],
              ["Private Messages", socialMessageCount],
              ["Friend Requests", socialRequestCount],
              ["Unread", packetInfoState.messengerUnreadMessageCount],
              ["Status", socialMessage || "-"],
            ]),
            { type: "textInput", id: "socialTarget", label: "User / ID", defaultValue: socialTarget, action: "social.target" },
            { type: "textInput", id: "socialDraft", label: "Message", defaultValue: socialDraft, action: "social.messageText" },
            schemaButtonGrid([
              schemaButton("Send Message", "social.sendMessage", "primary"),
              schemaButton("Add Friend", "social.addUser"),
              schemaButton("Refresh Requests", "social.refreshRequests"),
              schemaButton("Lookup Target", "social.lookupTarget"),
            ], 4),
          ]),
          { type: "textInput", id: "socialFriendFilter", label: "Friend Search", defaultValue: socialFriendFilter, action: "social.friendFilter" },
          schemaTable("Friends", [["name", "Name"], ["id", "ID"], ["meta", "Status"]], filteredPacketFriends.slice(0, 80).map((friend) => ({
            name: packetFriendTitle(friend),
            id: compactValue(friend.accountId),
            meta: packetFriendMeta(friend),
          })), { maxRows: 80 }),
          schemaTable("Friend Requests", [["name", "Name"], ["id", "ID"], ["line", "Line"]], visibleFriendRequests.map((request) => ({
            name: compactValue(request.name),
            id: compactValue(request.accountId),
            line: request.sourceLine,
          })), { maxRows: 20 }),
          schemaLog("Private Messages", visiblePrivateMessages.length ? visiblePrivateMessages.map((message) => `${message.senderAccountId}: ${message.text}`) : ["No private messages parsed yet."]),
        ],
      },
    },
    chat: {
      values: {
        chatDraft,
        chatFilterTalk: chatFilters.talk,
        chatFilterWhisper: chatFilters.whisper,
        chatFilterShout: chatFilters.shout,
        chatFilterSystem: chatFilters.system,
        chatAutoscroll: chatFilters.autoscroll,
      },
      surfaces: {
        panel: [
          schemaSection("Send", [
            { type: "textInput", id: "chatDraft", label: "Message", defaultValue: chatDraft, action: "chat.draft" },
            schemaButtonGrid([schemaButton("Send", "chat.send", "primary"), schemaButton("Clear Display", "chat.clear", "danger")], 2),
          ]),
          schemaSection("Filters", [
            { type: "toggle", id: "chatFilterTalk", label: "Talk", defaultValue: chatFilters.talk, action: "chat.filterTalk" },
            { type: "toggle", id: "chatFilterWhisper", label: "Whisper", defaultValue: chatFilters.whisper, action: "chat.filterWhisper" },
            { type: "toggle", id: "chatFilterShout", label: "Shout", defaultValue: chatFilters.shout, action: "chat.filterShout" },
            { type: "toggle", id: "chatFilterSystem", label: "System", defaultValue: chatFilters.system, action: "chat.filterSystem" },
            { type: "toggle", id: "chatAutoscroll", label: "Auto Scroll", defaultValue: chatFilters.autoscroll, action: "chat.autoscroll" },
          ]),
          schemaLog("Room Chat", visibleChatHistory.slice(-120).map((entry) => `${entry.timestamp ?? ""} ${chatEntryLabel(entry)}: ${entry.text ?? ""}`)),
        ],
      },
    },
    visitors: {
      values: { visitorFilter },
      surfaces: {
        panel: [
          schemaSection("Visitors", [
            schemaKv([
              ["Room", visitorRoomName],
              ["Current", visitorState.activeKeys.length],
              ["Seen", visitorEntries.length],
              ["Missing IDs", missingVisitorAccountIds],
              ["Lookup", visitorLookupMessage || "-"],
            ]),
            { type: "textInput", id: "visitorFilter", label: "Search", defaultValue: visitorFilter, action: "visitors.search" },
            schemaButtonGrid([schemaButton(visitorLookupBusy ? "Looking Up..." : "Lookup Missing IDs", "visitors.lookupMissing", "primary")], 1),
          ]),
          schemaTable("Seen Visitors", [["current", "In"], ["name", "Name"], ["id", "ID"], ["visits", "Visits"], ["entered", "Entered"], ["left", "Left"]], filteredVisitorEntries.map((entry) => ({
            current: entry.current ? "Yes" : "",
            name: entry.name,
            id: entry.accountId,
            visits: entry.visits,
            entered: entry.entered,
            left: entry.left,
          })), { maxRows: 120 }),
        ],
      },
    },
    items: {
      values: { itemFilter },
      surfaces: {
        panel: [
          schemaSection("Item Browser", [
            schemaKv([
              ["Total", itemRows.length],
              ["Floor", itemRows.filter((row) => row.kind !== "wall").length],
              ["Wall", itemWallCount],
              ["Selected", selectedItemRow ? itemRowTitle(selectedItemRow, furniMetadata) : "-"],
            ]),
            { type: "textInput", id: "itemFilter", label: "Search Items", defaultValue: itemFilter, action: "items.search" },
            schemaButtonGrid([
              schemaButton("Use Selected", "items.useSelected", "primary"),
              schemaButton("Pickup Selected", "items.pickupSelected", "danger"),
              schemaButton("Refresh", "items.refresh"),
            ], 3),
          ]),
          schemaTable("Floor Items", [["name", "Item"], ["id", "ID"], ["tile", "Tile"], ["state", "State"]], filteredItemRows.filter((row) => row.kind !== "wall").map((row) => ({
            key: row.key,
            name: itemRowTitle(row, furniMetadata),
            id: objectIdText(row.item),
            tile: objectMeta(row.item),
            state: compactValue(row.item.state),
          })), { rowKey: "key", selectedRowKey: selectedItemRow?.key, rowAction: "items.select", maxRows: 80 }),
          schemaTable("Wall Items", [["name", "Item"], ["id", "ID"], ["owner", "Owner"], ["pos", "Position"]], filteredItemRows.filter((row) => row.kind === "wall").map((row) => ({
            key: row.key,
            name: itemRowTitle(row, furniMetadata),
            id: objectIdText(row.item),
            owner: compactValue(row.item.ownerName),
            pos: wallObjectMeta(row.item),
          })), { rowKey: "key", selectedRowKey: selectedItemRow?.key, rowAction: "items.select", maxRows: 80 }),
          schemaKv([
            ["Kind", selectedItemRow?.kind ?? "-"],
            ["Class", compactValue(selectedItemRow?.item.className)],
            ["Name", selectedItemRow ? itemRowTitle(selectedItemRow, furniMetadata) : "-"],
            ["Meta", selectedItemRow ? itemRowMeta(selectedItemRow, furniMetadata) : "-"],
            ["Furnidata", selectedItemMetadata?.description ?? "-"],
          ]),
        ],
      },
    },
    inventory: {
      values: { inventoryFilter },
      surfaces: {
        panel: [
          schemaSection("Inventory", [
            schemaKv([
              ["Total", inventoryTotalCount],
              ["Rows", inventoryRowCount],
              ["Floor", inventoryFloorCount],
              ["Wall", inventoryWallCount],
              ["Source", inventoryUsesPacketRows ? "Packet log" : "Runtime"],
              ["Selected", selectedInventoryRow?.title ?? "-"],
            ]),
            { type: "textInput", id: "inventoryFilter", label: "Search Inventory", defaultValue: inventoryFilter, action: "inventory.search" },
            schemaButtonGrid([schemaButton("Request Inventory", "inventory.request", "primary"), schemaButton("Refresh", "inventory.refresh")], 2),
          ]),
          schemaTable("Inventory Items", [["kind", "Type"], ["title", "Furni"], ["meta", "Meta"]], filteredInventoryRows.map((row) => ({
            key: row.key,
            kind: row.kind,
            title: row.title,
            meta: row.meta,
          })), { rowKey: "key", selectedRowKey: selectedInventoryRow?.key, rowAction: "inventory.select", maxRows: 120 }),
          schemaKv((selectedInventoryRow?.detailRows ?? [{ label: "Selected", value: "-" }]).map((row) => [row.label, row.value])),
        ],
      },
    },
    automation: {
      values: { autoHideBulletin: automationPrefs.autoHideBulletin },
      surfaces: {
        panel: [
          schemaSection("Comfort Automation", [
            { type: "toggle", id: "autoHideBulletin", label: "Auto Hide Bulletin On Login", defaultValue: automationPrefs.autoHideBulletin, action: "automation.autoHideBulletin" },
            schemaButtonGrid([schemaButton("Hide Bulletin Now", "automation.hideBulletin", "primary"), schemaButton("Refresh Windows", "automation.refresh")], 2),
            schemaKv([
              ["Open Windows", selectedRuntimeSnapshot?.windowIds.length ?? 0],
              ["Status", automationMessage || "-"],
            ]),
          ]),
          schemaTable("Known Windows", [["id", "Window ID"]], (selectedRuntimeSnapshot?.windowIds ?? []).map((id) => ({ id })), { maxRows: 60 }),
        ],
      },
    },
    "wall-mover": {
      values: { wallMoverStep: Number.parseInt(wallMoverStep, 10) || 1 },
      surfaces: {
        panel: [
          schemaSection("Target", [
            schemaKv([
              ["Selected", selectedWallMoverRow ? itemRowTitle(selectedWallMoverRow, furniMetadata) : "-"],
              ["Item ID", selectedWallMoverItemId ?? "-"],
              ["Owner", compactValue(selectedWallMoverRow?.item.ownerName)],
              ["Wall", selectedWallMoverLocation ? `${selectedWallMoverLocation.wallX},${selectedWallMoverLocation.wallY}` : "-"],
              ["Local", selectedWallMoverLocation ? `${selectedWallMoverLocation.localX},${selectedWallMoverLocation.localY}` : "-"],
              ["Face", selectedWallMoverLocation?.orientation ?? "-"],
              ["Status", wallMoverMessage || "-"],
            ]),
            { type: "numberInput", id: "wallMoverStep", label: "Step", min: 1, max: 50, step: 1, defaultValue: Number.parseInt(wallMoverStep, 10) || 1, action: "wallMover.step" },
            schemaButtonGrid([
              schemaButton("Up", "wallMover.up"),
              schemaButton("Left", "wallMover.left"),
              schemaButton("Right", "wallMover.right"),
              schemaButton("Down", "wallMover.down"),
              schemaButton("Flip L", "wallMover.flipL"),
              schemaButton("Flip R", "wallMover.flipR"),
              schemaButton("Pickup", "wallMover.pickup", "danger"),
            ], 3),
          ]),
          schemaTable("Wall Items", [["name", "Item"], ["id", "ID"], ["owner", "Owner"], ["wall", "Wall"], ["local", "Local"], ["face", "Face"]], wallMoverRows.map((row) => {
            const loc = wallMoverLocation(row.item);
            return {
              key: row.key,
              name: itemRowTitle(row, furniMetadata),
              id: objectIdText(row.item),
              owner: compactValue(row.item.ownerName),
              wall: loc ? `${loc.wallX},${loc.wallY}` : compactValue(row.item.wall),
              local: loc ? `${loc.localX},${loc.localY}` : compactValue(row.item.local),
              face: loc?.orientation ?? compactValue(row.item.orientation),
            };
          }), { rowKey: "key", selectedRowKey: selectedWallMoverRow?.key, rowAction: "wallMover.select", maxRows: 120 }),
        ],
      },
    },
    "wall-item-anywhere": {
      values: {},
      surfaces: {
        panel: [
          schemaSection("Native Placement", [
            schemaKv([
              ["Mode", wallItemAnywhereEnabled ? "Native wall drag/drop accepts off-wall locations" : "Plugin disabled"],
              ["How to use", "Click a wall item, press Move, drag it anywhere on the stage, then click to place"],
              ["Status", wallAnywhereMessage || "-"],
            ]),
            { type: "notice", tone: "info", text: "This plugin does not use a separate item selector. It changes Habbo's own Object Mover validation so the normal wall item move cursor can place outside visible wall bounds." },
          ]),
        ],
      },
    },
    "floor-item-anywhere": {
      values: {},
      surfaces: {
        panel: [
          schemaSection("Native Placement", [
            schemaKv([
              ["Mode", floorItemAnywhereEnabled ? "Native floor drag/drop accepts off-room tiles" : "Plugin disabled"],
              ["How to use", "Click a floor item, press Move, drag it outside the room floor, then click to place"],
              ["Status", floorAnywhereMessage || "-"],
            ]),
            { type: "notice", tone: "info", text: "This plugin keeps Habbo's own floor item move cursor and packet flow. It only relaxes Object Mover's floor-coordinate validation while the plugin is enabled." },
          ]),
        ],
      },
    },
    "hide-list": {
      values: {
        hideListTarget,
        hideListReason,
      },
      surfaces: {
        panel: [
          schemaSection("Add Hidden User", [
            { type: "textInput", id: "hideListTarget", label: "Username or ID", defaultValue: hideListTarget, action: "hideList.target" },
            { type: "textInput", id: "hideListReason", label: "Reason", defaultValue: hideListReason, action: "hideList.reason" },
            schemaButtonGrid([
              schemaButton("Add To Hide List", "hideList.add", "primary"),
              schemaButton("Clear List", "hideList.clear", "danger"),
            ], 2),
            schemaKv([
              ["Hidden", hideListPluginEnabled ? hideListRecords.length : 0],
              ["Status", hideListPluginEnabled ? hideListMessage || "-" : "Plugin disabled"],
            ]),
          ]),
          schemaTable("Hidden Users", [["target", "User / ID"], ["reason", "Reason"], ["created", "Added"]], hideListRecords.map((entry) => ({
            key: entry.id,
            target: entry.target,
            reason: entry.reason || "-",
            created: new Date(entry.createdAt).toLocaleString(),
          })), { rowKey: "key", rowAction: "hideList.remove", maxRows: 120 }),
          schemaLog("Active Filters", hideListPluginEnabled && effectiveHiddenUserEntries.length > 0 ? effectiveHiddenUserEntries.map((entry) => `hide ${entry}`) : ["No active hidden-user filters."]),
        ],
      },
    },
    "packet-log": {
      values: {
        packetSearch: packetFilters.search,
        packetClient: packetFilters.client,
        packetServer: packetFilters.server,
        packetRelay: packetFilters.relay,
        packetWrap: packetFilters.wrap,
        packetAutoscroll: packetFilters.autoscroll,
        packetSession: packetFilters.session,
        packetClientSession: packetFilters.clientSession,
      },
      surfaces: {
        panel: [
          schemaSection("Filters", [
            { type: "textInput", id: "packetSearch", label: "Search", defaultValue: packetFilters.search, action: "packet.search" },
            { type: "select", id: "packetSession", label: "Session", defaultValue: packetFilters.session, action: "packet.session", options: packetSessionChoices.map((choice) => ({ value: choice, label: choice })) },
            { type: "select", id: "packetClientSession", label: "Client", defaultValue: packetFilters.clientSession, action: "packet.clientSession", options: packetClientChoices },
            { type: "toggle", id: "packetClient", label: "CLIENT", defaultValue: packetFilters.client, action: "packet.client" },
            { type: "toggle", id: "packetServer", label: "SERVER", defaultValue: packetFilters.server, action: "packet.server" },
            { type: "toggle", id: "packetRelay", label: "RELAY", defaultValue: packetFilters.relay, action: "packet.relay" },
            { type: "toggle", id: "packetWrap", label: "Wrap", defaultValue: packetFilters.wrap, action: "packet.wrap" },
            { type: "toggle", id: "packetAutoscroll", label: "Auto Scroll", defaultValue: packetFilters.autoscroll, action: "packet.autoscroll" },
            schemaButtonGrid([schemaButton("Clear Display", "packet.clear", "danger"), schemaButton("Export Visible", "packet.export", "primary")], 2),
          ]),
          schemaTable("Packets", [["line", "Line"], ["dir", "Dir"], ["name", "Name"], ["header", "Header"], ["size", "Size"], ["text", "Body"]], visiblePacketEntries.slice(-250).map((entry) => ({
            key: entry.id,
            line: entry.lineNumber,
            dir: entry.direction,
            name: relayEntryDisplayName(entry),
            header: compactValue(entry.header),
            size: compactValue(entry.size),
            text: relayEntryPlain(entry, relayLog?.updatedAt),
          })), { rowKey: "key", selectedRowKey: selectedPacketEntry?.id, rowAction: "packet.select", maxRows: 250 }),
          schemaKv([
            ["Visible", visiblePacketEntries.length],
            ["Total", packetEntries.length],
            ["Latest Client", relayPacketSummary(latestClientPacket)],
            ["Latest Server", relayPacketSummary(latestServerPacket)],
            ["Session", relaySessionId],
            ["Modes", `${relayClientModes} / ${relayServerModes}`],
            ["Body Logging", relayBodyLoggingState],
            ["Export", packetExportMessage || "-"],
          ]),
          schemaKv([
            ["Selected", selectedPacketEntry ? relayEntryV3Line(selectedPacketEntry, relayLog?.updatedAt) : "-"],
            ["ASCII", selectedPacketEntry?.bodyAscii ?? "-"],
            ["HEX", selectedPacketEntry?.bodyHex ?? "-"],
          ]),
        ],
      },
    },
    injection: {
      values: {
        injectionRawDirection: injectionDraft.rawDirection,
        injectionRawText: injectionDraft.rawText,
        injectionSendAll,
        injectionRepeatCount: clampRepeatCount(injectionRepeatCount),
        injectionRepeatInterval: clampRepeatInterval(injectionRepeatInterval),
        selectedInjectionSnippetId,
      },
      surfaces: {
        panel: [
          schemaSection("Raw Shockwave Packet", [
            { type: "select", id: "injectionRawDirection", label: "Send To", defaultValue: injectionDraft.rawDirection, action: "injection.rawDirection", options: [{ value: "SERVER", label: "Server (outgoing)" }, { value: "CLIENT", label: "Client (incoming)" }] },
            { type: "textArea", id: "injectionRawText", label: "Packet", rows: 7, monospace: true, placeholder: '{h:94} or {h:4}{s:"hello"} or raw Shockwave text', defaultValue: injectionDraft.rawText, action: "injection.rawText" },
            injectionPacketPreview.ok
              ? schemaKv([
                  ["State", "Valid"],
                  ["Name", injectionPacketPreview.packet.packetName ?? "UNKNOWN_HEADER"],
                  ["Header", injectionPacketPreview.packet.header],
                  ["Length", `${injectionPacketPreview.packet.packet.length} bytes`],
                ])
              : { type: "notice", title: "Packet validation", text: injectionPacketPreview.message, tone: "warning" },
            { type: "toggle", id: "injectionSendAll", label: "Send to all running sessions", defaultValue: injectionSendAll, action: "injection.sendAll" },
            { type: "numberInput", id: "injectionRepeatCount", label: "Repeat", min: 1, max: 25, step: 1, defaultValue: clampRepeatCount(injectionRepeatCount), action: "injection.repeatCount" },
            { type: "numberInput", id: "injectionRepeatInterval", label: "Every ms", min: 50, max: 60000, step: 50, defaultValue: clampRepeatInterval(injectionRepeatInterval), action: "injection.repeatInterval" },
            schemaButtonGrid([schemaButton("Send Packet", "injection.run", "primary"), schemaButton("Save Packet", "injection.saveSnippet"), schemaButton("Export Saved", "injection.exportSnippets")], 3),
          ]),
          schemaTable("Saved Packets", [["direction", "To"], ["packet", "Packet"], ["created", "Saved"]], injectionSnippets.map((snippet) => ({ key: snippet.id, direction: snippet.command.rawDirection, packet: snippet.command.rawText, created: new Date(snippet.createdAt).toLocaleString() })), { rowKey: "key", selectedRowKey: selectedInjectionSnippetId, rowAction: "injection.selectSnippet", maxRows: 50 }),
          schemaButtonGrid([schemaButton("Load Selected", "injection.loadSnippet"), schemaButton("Clear History", "injection.clearHistory", "danger")], 2),
          schemaLog("Sent Packet History", injectionHistory.slice(0, 50).map((entry) =>
            `${entry.time} [${entry.direction}] ${statusLabel(entry.status)}\n${entry.packetText}\n${entry.message}`,
          )),
          schemaLog("Status", injectionMessage ? [injectionMessage] : ["Ready."]),
        ],
      },
    },
    "dev-tools": {
      surfaces: {
        panel: [
          schemaSection("Runtime Diagnostics", [
            schemaKv([
              ["FPS", runtimeFps(selectedRuntimeSnapshot)],
              ["Director Tick", runtimeTickRate(selectedRuntimeSnapshot)],
              ["Location", runtimeLocation(selectedRuntimeSnapshot)],
              ["Sprites", selectedRuntimeSnapshot?.activeSprites.length ?? 0],
              ["Windows", selectedRuntimeSnapshot?.windowIds.length ?? 0],
              ["Profile", selectedProfile ? profileLine(selectedProfile) : "-"],
            ]),
            schemaButtonGrid([schemaButton("Refresh Snapshot", "dev.refresh", "primary"), schemaButton("Open Console", "dev.console")], 2),
          ]),
          schemaTable("Sprites", [["n", "N"], ["member", "Member"], ["type", "Type"], ["loc", "Loc"]], (selectedRuntimeSnapshot?.activeSprites ?? []).slice(0, 80).map((sprite) => ({
            n: compactValue(sprite.n),
            member: compactValue(sprite.member),
            type: compactValue(sprite.type),
            loc: compactValue(sprite.loc?.join(",")),
          })), { maxRows: 80 }),
          schemaTable("Windows", [["id", "Window ID"]], (selectedRuntimeSnapshot?.windowIds ?? []).map((id) => ({ id })), { maxRows: 80 }),
        ],
      },
    },
    "plugin-manager": {
      surfaces: {
        panel: [
          schemaSection("Plugin Manager", [
            schemaKv([
              ["Installed", availablePlugins.length],
              ["Enabled", availablePlugins.filter((plugin) => pluginEnabledById[plugin.id] !== false).length],
              ["Pinned", pinnedPluginIds.size],
              ["User Root", pluginRegistryState?.userPluginRoot ?? "-"],
              ["Portable Root", pluginRegistryState?.portablePluginRoot ?? "-"],
            ]),
            schemaButtonGrid([schemaButton("Open Plugin Folder", "pluginManager.openFolder"), schemaButton("Install Plugin", "pluginManager.install", "primary"), schemaButton("Reload Plugins", "pluginManager.reload")], 3),
          ]),
          schemaTable("Load Errors", [["plugin", "Plugin"], ["source", "Source"], ["message", "Message"]], (pluginRegistryState?.loadErrors ?? []).map((error) => ({
            plugin: error.pluginId ?? "-",
            source: error.sourcePath,
            message: error.message,
          })), { maxRows: 30 }),
        ],
      },
    },
  };
}
