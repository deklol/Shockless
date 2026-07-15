import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RuntimeItemRow } from "../../../engine-adapter/shocklessSessionAdapter";
import type { AppPreferencesPatch, FurniRelayAction, RelayLogEntry, RelayLogSnapshot, UserRelayAction } from "../../../shared/window-api";
import type {
  EngineRuntimeAction,
  EngineRuntimeActionResult,
  EngineRuntimeSnapshot,
  EngineRuntimeSnapshotScope,
  RuntimeChatEntry,
} from "../../engineRuntime";
import type { RendererUserPluginHost } from "../../userPluginHost";
import { compactValue } from "../common/model";
import {
  hideListEntryId,
  hideListEntryLine,
  hideListTargetKey,
  normalizeHideListReason,
  parseHiddenUserEntries,
  type HideListEntry,
} from "../hide-list/model";
import {
  clampMultiAccountConcurrency,
  clampMultiAccountCount,
  type InjectionCommandDraft,
  type InjectionHistoryEntry,
  type InjectionSnippet,
} from "../injection/model";
import { normalizePacketClientFilter } from "../packet-console/relayModel";
import { objectNumericId } from "../room/items";
import { pluginSchemaActionGate } from "../../ui/pluginSurfaceGuards";
import type { PluginSchemaActionEvent } from "./schemaAction";
import type { SchemaPrimitiveValue } from "./schemaBuilders";
import type { PluginRuntimeUiStateById } from "./runtimeUiState";
import type { PluginDefinition } from "../../../shared/plugin";

interface ChatFilterState {
  readonly talk: boolean;
  readonly whisper: boolean;
  readonly shout: boolean;
  readonly system: boolean;
  readonly autoscroll: boolean;
}

interface PacketFilterState {
  readonly client: boolean;
  readonly server: boolean;
  readonly relay: boolean;
  readonly wrap: boolean;
  readonly autoscroll: boolean;
  readonly clientSession: string;
  readonly session: string;
  readonly search: string;
}

export interface PluginSchemaActionsContext {
  readonly activeStoredUserLook: string;
  readonly addInjectionSnippet: () => void;
  readonly appendTimeline: (severity: "info" | "success" | "warning" | "error", message: string) => void;
  readonly applyUserNameLabelRuntime: (enabled?: boolean, settings?: { readonly sourceYOffset: number; readonly selfColor: string; readonly otherColor: string }, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult | null>;
  readonly availablePluginById: Map<string, PluginDefinition>;
  readonly chatDraft: string;
  readonly chatHistory: readonly RuntimeChatEntry[];
  readonly clearStoredUserLooks: () => void;
  readonly copySelectedUserProfile: () => Promise<void>;
  readonly copyStoredUserLook: () => Promise<void>;
  readonly executeInjectionCommand: (command: InjectionCommandDraft, label?: string) => Promise<void>;
  readonly exportInjectionSnippets: () => void;
  readonly exportVisiblePacketLog: () => void;
  readonly gameZoom: 1 | 2;
  readonly hideBulletinBoard: (mode: "auto" | "manual") => Promise<void>;
  readonly hideListReason: string;
  readonly hideListRecords: readonly HideListEntry[];
  readonly hideListTarget: string;
  readonly importClientReference: () => Promise<void>;
  readonly injectionDraft: InjectionCommandDraft;
  readonly installPluginFromFolder: () => Promise<void>;
  readonly loadInjectionSnippet: (snippet: InjectionSnippet) => void;
  readonly lookupMissingVisitorProfiles: () => Promise<void>;
  readonly lookupPublicUser: () => Promise<void>;
  readonly multiAccountConcurrency: string;
  readonly multiAccountCount: string;
  readonly multiAccountFile: string;
  readonly openPluginsFolder: () => Promise<void>;
  readonly packetClientChoices: readonly { readonly value: string; readonly label: string }[];
  readonly packetEntries: readonly RelayLogEntry[];
  readonly pluginEnabledById: Readonly<Record<string, boolean>>;
  readonly pluginSurfaceEnabledByPluginId: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly publicRoomQuery: string;
  readonly refreshLibrary: () => Promise<void>;
  readonly refreshRelayLog: () => Promise<RelayLogSnapshot | null>;
  readonly refreshRuntimeSnapshot: (scopes?: readonly EngineRuntimeSnapshotScope[]) => Promise<EngineRuntimeSnapshot | null>;
  readonly reloadPlugins: () => Promise<void>;
  readonly roomStageClickX: string;
  readonly roomStageClickY: string;
  readonly runConsoleRuntimeAction: (action: EngineRuntimeAction) => Promise<EngineRuntimeActionResult>;
  readonly runMultiAccountCommand: (input: string) => Promise<void>;
  readonly runRuntimeAction: (action: EngineRuntimeAction) => Promise<void>;
  readonly selectClientSession: (clientId: number) => Promise<void>;
  readonly selectedClientId: number;
  readonly selectedInjectionSnippet: InjectionSnippet | null;
  readonly selectedItemRow: RuntimeItemRow | null;
  readonly sendUserAction: (action: UserRelayAction, label: string, clientId?: number) => Promise<void>;
  readonly sendWallMoverMove: (dx: number, dy: number, orientationOverride?: "l" | "r") => Promise<void>;
  readonly sendWallMoverPickup: () => Promise<void>;
  readonly setAutomationPrefs: Dispatch<SetStateAction<{ readonly autoHideBulletin: boolean }>>;
  readonly setChatClearOffset: Dispatch<SetStateAction<number>>;
  readonly setChatDraft: Dispatch<SetStateAction<string>>;
  readonly setChatFilters: Dispatch<SetStateAction<ChatFilterState>>;
  readonly setEmbeddedRoomZoom: (scale: 1 | 2) => Promise<void>;
  readonly setEngineUserNameLabels: Dispatch<SetStateAction<boolean>>;
  readonly setHideListMessage: Dispatch<SetStateAction<string>>;
  readonly setHideListReason: Dispatch<SetStateAction<string>>;
  readonly setHideListTarget: Dispatch<SetStateAction<string>>;
  readonly setInjectionRepeatCount: Dispatch<SetStateAction<string>>;
  readonly setInjectionRepeatInterval: Dispatch<SetStateAction<string>>;
  readonly setInjectionSendAll: Dispatch<SetStateAction<boolean>>;
  readonly setInjectionHistory: Dispatch<SetStateAction<InjectionHistoryEntry[]>>;
  readonly setInjectionMessage: Dispatch<SetStateAction<string>>;
  readonly setInventoryFilter: Dispatch<SetStateAction<string>>;
  readonly setItemFilter: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountConcurrency: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountCount: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountFile: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountLoadMode: Dispatch<SetStateAction<"headless" | "visible">>;
  readonly setPacketClearAfterLine: Dispatch<SetStateAction<number>>;
  readonly setPacketConsoleOpen: Dispatch<SetStateAction<boolean>>;
  readonly setPacketFilters: Dispatch<SetStateAction<PacketFilterState>>;
  readonly setPersistentHideListRecords: (records: readonly HideListEntry[]) => void;
  readonly setPluginRuntimeUiById: Dispatch<SetStateAction<PluginRuntimeUiStateById>>;
  readonly setPluginUiValue: (pluginId: string, key: string, value: SchemaPrimitiveValue) => void;
  readonly setPublicLookupName: Dispatch<SetStateAction<string>>;
  readonly setPublicRoomQuery: Dispatch<SetStateAction<string>>;
  readonly setRoomStageClickX: Dispatch<SetStateAction<string>>;
  readonly setRoomStageClickY: Dispatch<SetStateAction<string>>;
  readonly setSelectedInjectionSnippetId: Dispatch<SetStateAction<string>>;
  readonly setSelectedInventoryKey: Dispatch<SetStateAction<string>>;
  readonly setSelectedItemKey: Dispatch<SetStateAction<string>>;
  readonly setSelectedPacketKey: Dispatch<SetStateAction<string>>;
  readonly setSelectedStoredUserLook: Dispatch<SetStateAction<string>>;
  readonly setSelectedUserKey: Dispatch<SetStateAction<string>>;
  readonly setSelectedWallMoverKey: Dispatch<SetStateAction<string>>;
  readonly setSocialDraft: Dispatch<SetStateAction<string>>;
  readonly setSocialFriendFilter: Dispatch<SetStateAction<string>>;
  readonly setSocialTarget: Dispatch<SetStateAction<string>>;
  readonly setVisitorFilter: Dispatch<SetStateAction<string>>;
  readonly setWallMoverStep: Dispatch<SetStateAction<string>>;
  readonly socialDraft: string;
  readonly socialTarget: string;
  readonly startEngine: () => Promise<void>;
  readonly stopEngine: () => Promise<void>;
  readonly storeSelectedUserLook: () => void;
  readonly updateAppPreferencePatch: (patch: AppPreferencesPatch, message: string, severity?: "success" | "warning") => Promise<void>;
  readonly updateInjectionDraft: <K extends keyof InjectionCommandDraft>(key: K, value: InjectionCommandDraft[K]) => void;
  readonly userNameLabelSettings: { readonly sourceYOffset: number; readonly selfColor: string; readonly otherColor: string };
  readonly userPluginHostRef: MutableRefObject<RendererUserPluginHost | null>;
}

export function usePluginSchemaActions(context: PluginSchemaActionsContext): (event: PluginSchemaActionEvent) => void {
  const {
    activeStoredUserLook, addInjectionSnippet, appendTimeline, applyUserNameLabelRuntime, availablePluginById, chatDraft,
    chatHistory, clearStoredUserLooks, copySelectedUserProfile, copyStoredUserLook, executeInjectionCommand,
    exportInjectionSnippets, exportVisiblePacketLog, gameZoom, hideBulletinBoard, hideListReason, hideListRecords,
    hideListTarget, importClientReference, injectionDraft, installPluginFromFolder, loadInjectionSnippet,
    lookupMissingVisitorProfiles, lookupPublicUser, multiAccountConcurrency, multiAccountCount, multiAccountFile,
    openPluginsFolder, packetClientChoices, packetEntries, pluginEnabledById, pluginSurfaceEnabledByPluginId,
    publicRoomQuery, refreshLibrary, refreshRelayLog, refreshRuntimeSnapshot, reloadPlugins, roomStageClickX, roomStageClickY,
    runConsoleRuntimeAction, runMultiAccountCommand, runRuntimeAction, selectClientSession, selectedClientId,
    selectedInjectionSnippet, selectedItemRow, sendUserAction, sendWallMoverMove, sendWallMoverPickup, setAutomationPrefs,
    setChatClearOffset, setChatDraft, setChatFilters, setEmbeddedRoomZoom, setEngineUserNameLabels, setHideListMessage,
    setHideListReason, setHideListTarget, setInjectionHistory, setInjectionMessage, setInjectionRepeatCount,
    setInjectionRepeatInterval, setInjectionSendAll, setInventoryFilter,
    setItemFilter, setMultiAccountConcurrency, setMultiAccountCount, setMultiAccountFile, setMultiAccountLoadMode,
    setPacketClearAfterLine, setPacketConsoleOpen, setPacketFilters, setPersistentHideListRecords,
    setPluginRuntimeUiById, setPluginUiValue, setPublicLookupName, setPublicRoomQuery, setRoomStageClickX,
    setRoomStageClickY, setSelectedInjectionSnippetId, setSelectedInventoryKey, setSelectedItemKey, setSelectedPacketKey,
    setSelectedStoredUserLook, setSelectedUserKey, setSelectedWallMoverKey, setSocialDraft, setSocialFriendFilter,
    setSocialTarget, setVisitorFilter, setWallMoverStep, socialDraft, socialTarget, startEngine, stopEngine,
    storeSelectedUserLook, updateAppPreferencePatch, updateInjectionDraft, userNameLabelSettings, userPluginHostRef,
  } = context;

const handlePluginSchemaAction = (event: PluginSchemaActionEvent) => {
    const key = event.action || event.elementId || "";
    const value = event.value;
    if (event.elementId) {
      setPluginRuntimeUiById((current) => {
        const existing = current[event.pluginId] ?? {};
        return {
          ...current,
          [event.pluginId]: {
            ...existing,
            values: {
              ...(existing.values ?? {}),
              [event.elementId!]: event.value ?? null,
            },
          },
        };
      });
    }

    const gate = pluginSchemaActionGate(
      availablePluginById.get(event.pluginId),
      pluginEnabledById[event.pluginId] !== false,
      pluginSurfaceEnabledByPluginId[event.pluginId],
      event.surfaceId,
    );
    if (!gate.allowed) {
      appendTimeline("warning", gate.reason ?? "Plugin action is disabled.");
      return;
    }

    if (event.pluginId === "connection") {
      if (key === "connection.refresh") void refreshLibrary();
      if (key === "connection.start") void startEngine();
      if (key === "connection.stop") void stopEngine();
      if (key === "connection.import") void importClientReference();
      return;
    }

    if (event.pluginId === "multi-account") {
      if (key === "multi.file") setMultiAccountFile(String(value ?? ""));
      else if (key === "multi.count") setMultiAccountCount(String(value ?? "1"));
      else if (key === "multi.concurrency") setMultiAccountConcurrency(String(value ?? "2"));
      else if (key === "multi.loadMode") setMultiAccountLoadMode(value === "visible" ? "visible" : "headless");
      else if (key === "multi.selectClient") void selectClientSession(Number(value));
      else if (key === "multi.loadHeadless") void runMultiAccountCommand(`load ${multiAccountFile} ${clampMultiAccountCount(multiAccountCount)} --headless --concurrency ${clampMultiAccountConcurrency(multiAccountConcurrency)}`);
      else if (key === "multi.loadVisible") void runMultiAccountCommand(`load ${multiAccountFile} ${clampMultiAccountCount(multiAccountCount)} --visible --concurrency ${clampMultiAccountConcurrency(multiAccountConcurrency)}`);
      else if (key === "multi.newVisible") void runMultiAccountCommand("newclient");
      else if (key === "multi.summonAll") void runMultiAccountCommand("summon all");
      else if (key === "multi.mimicOn") void runMultiAccountCommand("mimic on");
      else if (key === "multi.mimicOff") void runMultiAccountCommand("mimic off");
      else if (key === "multi.mimicStatus") void runMultiAccountCommand("mimic status");
      else if (key === "multi.setMain") void runMultiAccountCommand(`main ${selectedClientId}`);
      return;
    }

    if (event.pluginId === "info") {
      if (key === "info.lookupName") setPublicLookupName(String(value ?? ""));
      if (key === "info.lookup") void lookupPublicUser();
      return;
    }

    if (event.pluginId === "room") {
      if (key === "room.query") setPublicRoomQuery(String(value ?? ""));
      else if (key === "room.stageX") setRoomStageClickX(String(value ?? ""));
      else if (key === "room.stageY") setRoomStageClickY(String(value ?? ""));
      else if (key === "room.refresh") void refreshRuntimeSnapshot(["core", "room"]);
      else if (key === "room.navigator") void runRuntimeAction({ kind: "openNavigator", view: "nav_pr" });
      else if (key === "room.hotelView") void runRuntimeAction({ kind: "showHotelView" });
      else if (key === "room.toggleZoom") void setEmbeddedRoomZoom(gameZoom === 2 ? 1 : 2);
      else if (key === "room.enterPrivate") void runRuntimeAction({ kind: "enterPrivateRoom", flatId: publicRoomQuery.trim() || undefined, waitUntilReady: true });
      else if (key === "room.enterPublic") void runRuntimeAction({ kind: "enterPublicRoom", query: publicRoomQuery.trim() || undefined });
      else if (key === "room.stageClick") void runRuntimeAction({ kind: "stageClick", x: Number(roomStageClickX) || 0, y: Number(roomStageClickY) || 0 });
      return;
    }

    if (event.pluginId === "user") {
      if (key === "user.select") setSelectedUserKey(String(value ?? ""));
      else if (key === "user.nameLabels") {
        const enabled = Boolean(value);
        setEngineUserNameLabels(enabled);
        void updateAppPreferencePatch({ engineUserNameLabels: enabled }, `Username labels ${enabled ? "enabled" : "disabled"}.`);
        void applyUserNameLabelRuntime(enabled, userNameLabelSettings, { announce: true });
      }
      else if (key === "user.wave") void sendUserAction({ action: "wave" }, "Wave");
      else if (key === "user.dance1") void sendUserAction({ action: "dance", number: 1 }, "Dance 1");
      else if (key === "user.dance2") void sendUserAction({ action: "dance", number: 2 }, "Dance 2");
      else if (key === "user.dance3") void sendUserAction({ action: "dance", number: 3 }, "Dance 3");
      else if (key === "user.dance4") void sendUserAction({ action: "dance", number: 4 }, "Dance 4");
      else if (key === "user.stopDance") void sendUserAction({ action: "stopDance" }, "Stop Dance");
      else if (key === "user.carryDrink") void sendUserAction({ action: "carryDrink" }, "Carry Drink");
      else if (key === "user.copyProfile") void copySelectedUserProfile();
      else if (key === "user.storeLook") storeSelectedUserLook();
      else if (key === "user.selectStoredLook") setSelectedStoredUserLook(String(value ?? ""));
      else if (key === "user.applyStoredLook") void sendUserAction({ action: "applyLook", figure: activeStoredUserLook }, "Apply Look");
      else if (key === "user.copyStoredLook") void copyStoredUserLook();
      else if (key === "user.clearStoredLooks") clearStoredUserLooks();
      return;
    }

    if (event.pluginId === "social") {
      if (key === "social.target") setSocialTarget(String(value ?? ""));
      else if (key === "social.messageText") setSocialDraft(String(value ?? ""));
      else if (key === "social.friendFilter") setSocialFriendFilter(String(value ?? ""));
      else if (key === "social.sendMessage") void runMultiAccountCommand(`message ${socialTarget.trim()} ${socialDraft.trim()}`.trim());
      else if (key === "social.addUser") void runMultiAccountCommand(`adduser ${socialTarget.trim()}`.trim());
      else if (key === "social.refreshRequests") void runMultiAccountCommand("requests");
      else if (key === "social.lookupTarget") {
        setPublicLookupName(socialTarget.trim());
        void runMultiAccountCommand(`lookup ${socialTarget.trim()}`.trim());
      }
      return;
    }

    if (event.pluginId === "chat") {
      if (key === "chat.draft") setChatDraft(String(value ?? ""));
      else if (key === "chat.send") {
        const message = chatDraft.trim();
        if (message) void runConsoleRuntimeAction({ kind: "sendChat", message });
      } else if (key === "chat.clear") setChatClearOffset(chatHistory.length);
      else if (key === "chat.filterTalk") setChatFilters((current) => ({ ...current, talk: Boolean(value) }));
      else if (key === "chat.filterWhisper") setChatFilters((current) => ({ ...current, whisper: Boolean(value) }));
      else if (key === "chat.filterShout") setChatFilters((current) => ({ ...current, shout: Boolean(value) }));
      else if (key === "chat.filterSystem") setChatFilters((current) => ({ ...current, system: Boolean(value) }));
      else if (key === "chat.autoscroll") setChatFilters((current) => ({ ...current, autoscroll: Boolean(value) }));
      return;
    }

    if (event.pluginId === "visitors") {
      if (key === "visitors.search") setVisitorFilter(String(value ?? ""));
      else if (key === "visitors.lookupMissing") void lookupMissingVisitorProfiles();
      return;
    }

    if (event.pluginId === "items") {
      if (key === "items.search") setItemFilter(String(value ?? ""));
      else if (key === "items.select") setSelectedItemKey(String(value ?? ""));
      else if (key === "items.refresh") void refreshRuntimeSnapshot(["core", "room"]);
      else if (key === "items.useSelected" || key === "items.pickupSelected") {
        void (async () => {
          if (!window.shockless || !selectedItemRow) return;
          const id = objectNumericId(selectedItemRow.item);
          if (!id) return;
          if (selectedItemRow.kind === "wall" && key === "items.useSelected") {
            appendTimeline("warning", "Wall items do not have a generic use route. Select the item in Wall Mover for move, flip, or pickup.");
            return;
          }
          const action: FurniRelayAction = selectedItemRow.kind === "wall"
            ? key === "items.pickupSelected"
              ? { action: "pickupWallItem", itemId: id, className: compactValue(selectedItemRow.item.className) }
              : { action: "pickupWallItem", itemId: id, className: compactValue(selectedItemRow.item.className) }
            : key === "items.pickupSelected"
              ? { action: "pickupFloorItem", objectId: id, className: compactValue(selectedItemRow.item.className) }
              : { action: "useFloorItem", objectId: id, value: "0", className: compactValue(selectedItemRow.item.className) };
          const result = await window.shockless.sendFurniRelayAction(action, selectedClientId);
          appendTimeline(result.ok ? "success" : "warning", result.message);
          await Promise.all([refreshRuntimeSnapshot(["core", "room"]).catch(() => null), refreshRelayLog().catch(() => null)]);
        })();
      }
      return;
    }

    if (event.pluginId === "inventory") {
      if (key === "inventory.search") setInventoryFilter(String(value ?? ""));
      else if (key === "inventory.select") setSelectedInventoryKey(String(value ?? ""));
      else if (key === "inventory.request") void runRuntimeAction({ kind: "requestInventory" });
      else if (key === "inventory.refresh") void refreshRuntimeSnapshot(["core", "inventory"]);
      return;
    }

    if (event.pluginId === "automation") {
      if (key === "automation.autoHideBulletin") setAutomationPrefs((current) => ({ ...current, autoHideBulletin: Boolean(value) }));
      else if (key === "automation.hideBulletin") void hideBulletinBoard("manual");
      else if (key === "automation.refresh") void refreshRuntimeSnapshot(["core"]);
      return;
    }

    if (event.pluginId === "wall-mover") {
      if (key === "wallMover.select") setSelectedWallMoverKey(String(value ?? ""));
      else if (key === "wallMover.step") setWallMoverStep(String(value ?? "1"));
      else if (key === "wallMover.up") void sendWallMoverMove(0, -1);
      else if (key === "wallMover.down") void sendWallMoverMove(0, 1);
      else if (key === "wallMover.left") void sendWallMoverMove(-1, 0);
      else if (key === "wallMover.right") void sendWallMoverMove(1, 0);
      else if (key === "wallMover.flipL") void sendWallMoverMove(0, 0, "l");
      else if (key === "wallMover.flipR") void sendWallMoverMove(0, 0, "r");
      else if (key === "wallMover.pickup") void sendWallMoverPickup();
      return;
    }

    if (event.pluginId === "hide-list") {
      if (key === "hideList.target") setHideListTarget(String(value ?? ""));
      else if (key === "hideList.reason") setHideListReason(String(value ?? ""));
      else if (key === "hideList.add") {
        const target = parseHiddenUserEntries(hideListTarget)[0] ?? "";
        if (!target) {
          setHideListMessage("Enter a username or account id first.");
          return;
        }
        const reason = normalizeHideListReason(hideListReason);
        const targetKey = hideListTargetKey(target);
        const nextEntry: HideListEntry = {
          id: hideListEntryId(target),
          target,
          reason,
          createdAt: new Date().toISOString(),
        };
        const next = [...hideListRecords.filter((entry) => hideListTargetKey(entry.target) !== targetKey), nextEntry];
        setPersistentHideListRecords(next);
        setHideListTarget("");
        setHideListReason("");
        setPluginUiValue("hide-list", "target", "");
        setPluginUiValue("hide-list", "reason", "");
        setHideListMessage(`Added ${hideListEntryLine(nextEntry)}.`);
      } else if (key === "hideList.remove") {
        const rowKey = String(value ?? "");
        const removed = hideListRecords.find((entry) => entry.id === rowKey);
        setPersistentHideListRecords(hideListRecords.filter((entry) => entry.id !== rowKey));
        setHideListMessage(removed ? `Removed ${removed.target}.` : "Removed hidden-user entry.");
      } else if (key === "hideList.clear") {
        setPersistentHideListRecords([]);
        setHideListMessage("Hide list cleared.");
      }
      return;
    }

    if (event.pluginId === "packet-log") {
      if (key === "packet.search") setPacketFilters((current) => ({ ...current, search: String(value ?? "") }));
      else if (key === "packet.session") setPacketFilters((current) => ({ ...current, session: String(value ?? "All") }));
      else if (key === "packet.clientSession") setPacketFilters((current) => ({ ...current, clientSession: normalizePacketClientFilter(String(value ?? "All"), packetClientChoices) }));
      else if (key === "packet.client") setPacketFilters((current) => ({ ...current, client: Boolean(value) }));
      else if (key === "packet.server") setPacketFilters((current) => ({ ...current, server: Boolean(value) }));
      else if (key === "packet.relay") setPacketFilters((current) => ({ ...current, relay: Boolean(value) }));
      else if (key === "packet.wrap") setPacketFilters((current) => ({ ...current, wrap: Boolean(value) }));
      else if (key === "packet.autoscroll") setPacketFilters((current) => ({ ...current, autoscroll: Boolean(value) }));
      else if (key === "packet.clear") setPacketClearAfterLine(packetEntries.at(-1)?.lineNumber ?? 0);
      else if (key === "packet.export") exportVisiblePacketLog();
      else if (key === "packet.select") setSelectedPacketKey(String(value ?? ""));
      return;
    }

    if (event.pluginId === "injection") {
      if (key === "injection.rawDirection") updateInjectionDraft("rawDirection", String(value ?? "SERVER").toUpperCase() === "CLIENT" ? "CLIENT" : "SERVER");
      else if (key === "injection.rawText") updateInjectionDraft("rawText", String(value ?? ""));
      else if (key === "injection.sendAll") setInjectionSendAll(Boolean(value));
      else if (key === "injection.repeatCount") setInjectionRepeatCount(String(value ?? "1"));
      else if (key === "injection.repeatInterval") setInjectionRepeatInterval(String(value ?? "1000"));
      else if (key === "injection.run") void executeInjectionCommand(injectionDraft);
      else if (key === "injection.saveSnippet") addInjectionSnippet();
      else if (key === "injection.exportSnippets") exportInjectionSnippets();
      else if (key === "injection.selectSnippet") setSelectedInjectionSnippetId(String(value ?? ""));
      else if (key === "injection.loadSnippet" && selectedInjectionSnippet) loadInjectionSnippet(selectedInjectionSnippet);
      else if (key === "injection.clearHistory") {
        setInjectionHistory([]);
        setInjectionMessage("Packet history cleared.");
      }
      return;
    }

    if (event.pluginId === "dev-tools") {
      if (key === "dev.refresh") void refreshRuntimeSnapshot(["full"]);
      else if (key === "dev.console") setPacketConsoleOpen(true);
      return;
    }

    if (event.pluginId === "plugin-manager") {
      if (key === "pluginManager.openFolder") void openPluginsFolder();
      else if (key === "pluginManager.install") void installPluginFromFolder();
      else if (key === "pluginManager.reload") void reloadPlugins();
      return;
    }

    userPluginHostRef.current?.dispatchPluginEvent(event.pluginId, "ui.action", event);
  };

  return handlePluginSchemaAction;
}
