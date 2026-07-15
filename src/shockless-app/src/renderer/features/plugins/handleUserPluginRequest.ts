import type { Dispatch, SetStateAction } from "react";
import type { PluginDefinition, PluginUiElement } from "../../../shared/plugin";
import type {
  ClientRuntimeSummary,
  ClientSessionList,
  FishingRelayAction,
  FurniMetadataSnapshot,
  FurniRelayAction,
  PluginPacketInput,
  RelayLogSnapshot,
  SocialRelayAction,
} from "../../../shared/window-api";
import {
  runEngineRuntimeAction,
  type EngineRuntimeAction,
  type EngineRuntimeActionResult,
  type EngineRuntimeSnapshot,
  type EngineRuntimeSnapshotScope,
  type EngineWebviewElement,
  type RuntimeObjectSummary,
} from "../../engineRuntime";
import type { UserPluginHostRequest } from "../../userPluginHost";
import { compactValue, finiteNumber, userDisplayName } from "../common/model";
import { userTile } from "../gardening/spatial";
import { parseHiddenUserEntries } from "../hide-list/model";
import { delay } from "../injection/model";
import { relayLogSnapshotForClient } from "../packet-console/relayModel";
import { packetActiveObjectRow } from "../packets/roomObjects";
import type { ClientPluginSnapshot } from "../packets/types";
import { itemRowMeta, itemRowTile, objectNumericId, tileKey, type ItemRow } from "../room/items";
import { wallLocationFromStagePoint } from "../room/wallPlacement";
import type { PendingStageClickRequest } from "../stage/capture";
import { pluginStagePoint } from "../stage/inputCoordinates";
import { readShocklessStorage, removeShocklessStorage } from "../../storage/shocklessStorage";
import { clientPluginSnapshotForClient } from "./clientSnapshot";
import {
  assertDisabledPluginCleanupRequest,
  cleanInteger,
  cleanPluginRightsList,
  cleanPositiveInt,
  pluginStorageKey,
  requestedPluginClientId,
  requirePluginPermission,
  updateClientRightOwners,
  type PluginClientRightsOwners,
} from "./permissions";
import {
  pluginRoomOccupantsPayload,
  pluginRuntimeItemPayload,
  pluginRuntimeUserPayload,
} from "./runtimePayload";
import type { PluginRuntimeUiStateById } from "./runtimeUiState";
import {
  pluginFindItemRows,
  pluginFishingAreaPayload,
  pluginFishingAreaRows,
  pluginFishingAreaTarget,
  pluginFishingAreaWalkCandidates,
  pluginFishingAreaWalkTarget,
  pluginPlantCyclePlan,
  pluginPlantPayload,
  pluginPlantRows,
  pluginResolveFloorItem,
  pluginResolveWallItem,
  pluginSelectorKind,
  pluginSelectorNumericId,
  pluginSelectorTile,
  pluginSelectorWallLocation,
  pluginWalkTargetFromSnapshot,
  pluginWalkTargetFromUser,
  pluginWallMoveLocation,
} from "./selectors";

interface MutableValueRef<T> {
  current: T;
}

export interface UserPluginRequestContext {
  readonly pluginEnabledById: Readonly<Record<string, boolean>>;
  readonly clientPluginSnapshotsById: ReadonlyMap<number, ClientPluginSnapshot>;
  readonly furniMetadata: FurniMetadataSnapshot | null;
  readonly apiHiddenUserEntriesByPluginId: Readonly<Record<string, readonly string[]>>;
  readonly selectedClientIsVisible: boolean;
  readonly engineUrl: string;
  readonly setPluginRuntimeUiById: Dispatch<SetStateAction<PluginRuntimeUiStateById>>;
  readonly setWallAnywhereMessage: Dispatch<SetStateAction<string>>;
  readonly setFloorAnywhereMessage: Dispatch<SetStateAction<string>>;
  readonly setApiHiddenUserEntriesByPluginId: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
  readonly pendingStageClickRequestsRef: MutableValueRef<PendingStageClickRequest[]>;
  readonly webviewRef: MutableValueRef<EngineWebviewElement | null>;
  readonly gameWebviewRefs: MutableValueRef<Map<number, EngineWebviewElement>>;
  readonly relayLogRef: MutableValueRef<RelayLogSnapshot | null>;
  readonly clientSessionsRef: MutableValueRef<ClientSessionList | null>;
  readonly selectedClientIdRef: MutableValueRef<number>;
  readonly selectedRuntimeSnapshotRef: MutableValueRef<EngineRuntimeSnapshot | null>;
  readonly pluginClientRightsOwnersRef: MutableValueRef<PluginClientRightsOwners>;
  readonly refreshRuntimeSnapshot: (scopes?: readonly EngineRuntimeSnapshotScope[]) => Promise<EngineRuntimeSnapshot | null>;
  readonly refreshRelayLog: () => Promise<RelayLogSnapshot | null>;
  readonly refreshStageClickCaptureCount: () => void;
  readonly runConsoleRuntimeAction: (action: EngineRuntimeAction) => Promise<EngineRuntimeActionResult>;
}

export async function handleUserPluginRequest(
  context: UserPluginRequestContext,
  plugin: PluginDefinition,
  request: UserPluginHostRequest,
): Promise<unknown> {
  const {
    apiHiddenUserEntriesByPluginId,
    clientPluginSnapshotsById,
    clientSessionsRef,
    engineUrl,
    furniMetadata,
    gameWebviewRefs,
    pendingStageClickRequestsRef,
    pluginClientRightsOwnersRef,
    pluginEnabledById,
    refreshRelayLog,
    refreshRuntimeSnapshot,
    refreshStageClickCaptureCount,
    relayLogRef,
    runConsoleRuntimeAction,
    selectedClientIdRef,
    selectedClientIsVisible,
    selectedRuntimeSnapshotRef,
    setApiHiddenUserEntriesByPluginId,
    setFloorAnywhereMessage,
    setPluginRuntimeUiById,
    setWallAnywhereMessage,
    webviewRef,
  } = context;

  const args = request.args && typeof request.args === "object" ? (request.args as Record<string, unknown>) : {};
  const pluginEnabled = pluginEnabledById[plugin.id] !== false;
  if (!pluginEnabled) assertDisabledPluginCleanupRequest(plugin, request.api, args);
  const fullSnapshotForClient = async (clientId: number): Promise<EngineRuntimeSnapshot | null> => {
    if (clientId === selectedClientIdRef.current) return selectedRuntimeSnapshotRef.current;
    return null;
  };
  const runtimeSummaryForClient = async (clientId: number): Promise<ClientRuntimeSummary | null> => {
    const cached = clientPluginSnapshotsById.get(clientId)?.runtimeSummary;
    if (cached) return cached;
    const snapshot = await window.shockless?.getClientSnapshot(clientId);
    return snapshot?.runtime ?? null;
  };
  const freshPluginSnapshotForClient = async (
    clientId: number,
    runtime: EngineRuntimeSnapshot | null,
    runtimeSummary: ClientRuntimeSummary | null,
  ) => {
    const relaySnapshot = await refreshRelayLog().catch(() => relayLogRef.current);
    const session = clientSessionsRef.current?.sessions.find((entry) => entry.id === clientId) ?? null;
    return clientPluginSnapshotForClient({
      clientId,
      label: session?.label || `client${clientId}`,
      relay: relayLogSnapshotForClient(relaySnapshot, clientId),
      runtime,
      runtimeSummary,
    });
  };
  if (request.api === "storage.get") {
    requirePluginPermission(plugin, ["storage"]);
    const raw = readShocklessStorage(localStorage, pluginStorageKey(plugin.id, args.key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (request.api === "storage.set") {
    requirePluginPermission(plugin, ["storage"]);
    localStorage.setItem(pluginStorageKey(plugin.id, args.key), JSON.stringify(args.value ?? null));
    return true;
  }
  if (request.api === "storage.delete") {
    requirePluginPermission(plugin, ["storage"]);
    removeShocklessStorage(localStorage, pluginStorageKey(plugin.id, args.key));
    return true;
  }
  if (request.api === "engine.getSnapshot") {
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const requestedClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (requestedClientId === selectedClientIdRef.current) return selectedRuntimeSnapshotRef.current;
    const snapshot = await window.shockless?.getClientSnapshot(requestedClientId);
    return snapshot?.runtime ?? null;
  }
  if (request.api === "session.getClients") {
    requirePluginPermission(plugin, ["events.session"]);
    return {
      selectedClientId: clientSessionsRef.current?.selectedClientId ?? selectedClientIdRef.current,
      mainClientId: clientSessionsRef.current?.mainClientId ?? 1,
      clients: clientSessionsRef.current?.sessions ?? [],
    };
  }
  if (
    request.api === "filters.getHiddenUsers" ||
    request.api === "filters.setHiddenUsers" ||
    request.api === "filters.addHiddenUser" ||
    request.api === "filters.removeHiddenUser" ||
    request.api === "filters.clearHiddenUsers"
  ) {
    requirePluginPermission(plugin, ["engine.control"]);
    const current = apiHiddenUserEntriesByPluginId[plugin.id] ?? [];
    if (request.api === "filters.getHiddenUsers") return { entries: current };

    const setEntriesForPlugin = (entries: readonly string[]) => {
      setApiHiddenUserEntriesByPluginId((state) => {
        const next = { ...state };
        if (entries.length === 0) delete next[plugin.id];
        else next[plugin.id] = entries;
        return next;
      });
      return { entries };
    };

    if (request.api === "filters.clearHiddenUsers") return setEntriesForPlugin([]);
    if (request.api === "filters.setHiddenUsers") return setEntriesForPlugin(parseHiddenUserEntries(args.entries ?? args.users ?? args.targets ?? ""));
    const target = parseHiddenUserEntries(args.target ?? args.user ?? args.name ?? args.id)[0] ?? "";
    if (!target) throw new Error(`${request.api} requires a username or account id.`);
    if (request.api === "filters.addHiddenUser") {
      const seen = new Set(current.map((entry) => entry.toLowerCase()));
      return setEntriesForPlugin(seen.has(target.toLowerCase()) ? current : [...current, target]);
    }
    return setEntriesForPlugin(current.filter((entry) => entry.toLowerCase() !== target.toLowerCase()));
  }
  if (
    request.api === "client.getRights" ||
    request.api === "client.setRights" ||
    request.api === "client.grantRights" ||
    request.api === "client.removeRights" ||
    request.api === "client.enableChooserCommands"
  ) {
    requirePluginPermission(plugin, ["client.rights"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Client rights APIs currently target the selected visible runtime.");
    }
    const mode: "get" | "set" | "grant" | "remove" =
      request.api === "client.getRights" ? "get" :
      request.api === "client.setRights" ? "set" :
      request.api === "client.removeRights" ? "remove" :
      "grant";
    const rights = request.api === "client.enableChooserCommands"
      ? ["fuse_habbo_chooser", "fuse_furni_chooser"]
      : cleanPluginRightsList(args.rights);
    if (mode !== "get" && rights.length === 0) {
      throw new Error(`${request.api} requires at least one right.`);
    }
    const result = await runConsoleRuntimeAction({ kind: "clientRights", mode, rights });
    if (!result.ok) throw new Error(result.message);
    updateClientRightOwners(pluginClientRightsOwnersRef.current, plugin, targetClientId, mode, rights, result);
    if (mode !== "get") await refreshRuntimeSnapshot().catch(() => null);
    return result;
  }
  if (request.api === "chat.send" || request.api === "chat.shout" || request.api === "chat.whisper") {
    requirePluginPermission(plugin, ["chat.send"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const rawMessage = String(args.message ?? "").trim();
    if (!rawMessage) throw new Error(`${request.api} requires a non-empty message.`);
    if (rawMessage.length > 240) throw new Error(`${request.api} messages are limited to 240 characters.`);

    if (request.api === "chat.send" && targetClientId === selectedClientIdRef.current) {
      const result = await runConsoleRuntimeAction({ kind: "sendChat", message: rawMessage });
      if (!result.ok) throw new Error(result.message);
      return result;
    }

    if (!window.shockless) throw new Error("Desktop bridge unavailable for chat relay.");
    let packet: PluginPacketInput;
    if (request.api === "chat.send") {
      packet = { header: 52, bodyText: rawMessage };
    } else if (request.api === "chat.shout") {
      packet = { header: 55, bodyText: rawMessage };
    } else {
      const target = String(args.target ?? "").trim();
      if (!target) throw new Error("chat.whisper requires a target user name.");
      if (target.length > 64 || /[\x00-\x1f]/.test(target)) throw new Error("chat.whisper target name is invalid.");
      packet = { header: 56, bodyText: `${target} ${rawMessage}` };
    }
    const result = await window.shockless.sendPluginPacket(packet, targetClientId);
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    if (!result.ok) throw new Error(result.message);
    return result;
  }
  if (request.api === "stage.click") {
    requirePluginPermission(plugin, ["engine.control"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Stage clicks can only target the selected visible client.");
    }
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const modifierValue = (...keys: readonly string[]): boolean | undefined => {
      for (const key of keys) {
        if (typeof options[key] === "boolean") return Boolean(options[key]);
      }
      return undefined;
    };
    const modifiers = {
      shiftDown: modifierValue("shiftDown", "shift"),
      controlDown: modifierValue("controlDown", "control", "ctrlDown", "ctrl"),
      optionDown: modifierValue("optionDown", "option", "altDown", "alt"),
      commandDown: modifierValue("commandDown", "command", "metaDown", "meta"),
    };
    const hasModifiers = Object.values(modifiers).some((value) => typeof value === "boolean");
    const result = await runConsoleRuntimeAction({
      kind: "stageClick",
      x: cleanInteger(args.x, 0),
      y: cleanInteger(args.y, 0),
      modifiers: hasModifiers ? modifiers : undefined,
    });
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "stage.captureNextClick" || request.api === "stage.nextClick") {
    requirePluginPermission(plugin, ["ui.overlay"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current || !selectedClientIsVisible || !engineUrl) {
      throw new Error("Stage click capture needs the selected visible client.");
    }
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const timeoutMs = Math.max(0, Math.min(60000, cleanInteger(args.timeoutMs ?? options.timeoutMs ?? options.timeout, 15000)));
    return await new Promise((resolve, reject) => {
      const entry: typeof pendingStageClickRequestsRef.current[number] = {
        pluginId: plugin.id,
        createdAt: Date.now(),
        resolve,
        reject,
        timeout: null,
      };
      if (timeoutMs > 0) {
        entry.timeout = window.setTimeout(() => {
          pendingStageClickRequestsRef.current = pendingStageClickRequestsRef.current.filter((request) => request !== entry);
          refreshStageClickCaptureCount();
          reject(new Error("Timed out waiting for a stage click."));
        }, timeoutMs);
      }
      pendingStageClickRequestsRef.current.push(entry);
      refreshStageClickCaptureCount();
    });
  }
  if (request.api === "avatar.walkTo") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for avatar movement.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const result = await window.shockless.sendRoomRelayAction(
      {
        action: "move",
        x: cleanInteger(args.x, 0),
        y: cleanInteger(args.y, 0),
        furniId: cleanInteger(args.furniId ?? options.furniId, 0),
      },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.walkToItem") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    requirePluginPermission(plugin, ["engine.snapshot"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for avatar movement.");
    const target = pluginWalkTargetFromSnapshot(selectedRuntimeSnapshotRef.current, args.selector, furniMetadata);
    if (!target) throw new Error("avatar.walkToItem could not resolve a floor item by id, name, class, or search text.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const furniId = options.useFurniId === false ? 0 : cleanInteger(options.furniId ?? args.furniId, target.furniId);
    const result = await window.shockless.sendRoomRelayAction(
      { action: "move", x: target.x, y: target.y, furniId },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, target };
  }
  if (request.api === "avatar.walkToArea") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for avatar movement.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.area ?? args.areaId ?? options.selector ?? options.area ?? options.areaId;
    const directTile = pluginSelectorTile(selector ?? args);
    const target = directTile
      ? {
          x: directTile.x,
          y: directTile.y,
          furniId: cleanInteger(options.furniId ?? args.furniId, 0),
          label: `tile ${directTile.x},${directTile.y}`,
        }
      : (() => {
          requirePluginPermission(plugin, ["engine.snapshot"]);
          const snapshot = targetClientId === selectedClientIdRef.current ? selectedRuntimeSnapshotRef.current : null;
          return pluginWalkTargetFromSnapshot(snapshot, selector, furniMetadata);
        })();
    if (!target) throw new Error("avatar.walkToArea could not resolve a tile, floor item, passive object, or area selector.");
    const furniId = options.useFurniId === false ? 0 : cleanInteger(options.furniId ?? args.furniId, target.furniId);
    const result = await window.shockless.sendRoomRelayAction(
      { action: "move", x: target.x, y: target.y, furniId },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, target };
  }
  if (request.api === "avatar.walkToUser") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    requirePluginPermission(plugin, ["engine.snapshot"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for avatar movement.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    if (!snapshot) throw new Error("avatar.walkToUser needs the target client to be the selected rendered client so live user tiles are available.");
    const target = pluginWalkTargetFromUser(snapshot, args.selector ?? args.user ?? args.name ?? args.accountId, options);
    if (!target) throw new Error("avatar.walkToUser could not resolve a live room user by name, account id, room index, or row id.");
    const result = await window.shockless.sendRoomRelayAction(
      { action: "move", x: target.x, y: target.y, furniId: cleanInteger(options.furniId ?? args.furniId, target.furniId) },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, target };
  }
  if (request.api === "teleport.enter") {
    requirePluginPermission(plugin, ["actions.furni"]);
    requirePluginPermission(plugin, ["engine.snapshot"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for teleport entry.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    if (options.walk !== false) requirePluginPermission(plugin, ["actions.avatar"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    const resolved = pluginResolveFloorItem(snapshot, args.selector, furniMetadata);
    if (!resolved) throw new Error("teleport.enter could not resolve a floor teleport item by id, name, class, or search text.");
    let walk: Awaited<ReturnType<NonNullable<typeof window.shockless>["sendRoomRelayAction"]>> | null = null;
    if (options.walk !== false) {
      const furniId = options.useFurniId === false ? 0 : cleanInteger(options.furniId, resolved.id);
      walk = await window.shockless.sendRoomRelayAction(
        { action: "move", x: resolved.tile.x, y: resolved.tile.y, furniId },
        targetClientId,
      );
      if (!walk.ok && options.requireWalk !== false) {
        await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
        return { ...walk, item: pluginRuntimeItemPayload(resolved.row, furniMetadata), walk };
      }
    }
    const result = await window.shockless.sendFurniRelayAction(
      { action: "useFloorItem", objectId: resolved.id, value: String(options.value ?? "0"), className: compactValue(resolved.row.item.className) },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: pluginRuntimeItemPayload(resolved.row, furniMetadata), walk };
  }
  if (request.api === "rooms.enterPrivateRoom") {
    requirePluginPermission(plugin, ["engine.control"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Private room entry through plugin engine control can only target the selected visible client.");
    }
    const flatId = String(args.flatId ?? "").trim();
    const result = await runConsoleRuntimeAction({ kind: "enterPrivateRoom", flatId: flatId || undefined, waitUntilReady: true });
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "rooms.enterPublicRoom") {
    requirePluginPermission(plugin, ["engine.control"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Public room entry through plugin engine control can only target the selected visible client.");
    }
    const result = await runConsoleRuntimeAction({ kind: "enterPublicRoom", query: String(args.query ?? "").trim() || undefined });
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "rooms.leave") {
    requirePluginPermission(plugin, ["engine.control"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for room leave.");
    const result = await window.shockless.sendRoomRelayAction(
      { action: "leave" },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "navigator.open") {
    requirePluginPermission(plugin, ["engine.control"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Navigator control can only target the selected visible client.");
    }
    const result = await runConsoleRuntimeAction({ kind: "openNavigator", view: String(args.view ?? "nav_pr") });
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "windows.clickElement") {
    requirePluginPermission(plugin, ["engine.control"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    if (targetClientId !== selectedClientIdRef.current) {
      throw new Error("Window element clicks can only target the selected visible client.");
    }
    const windowId = String(args.windowId ?? "").trim();
    const elementId = String(args.elementId ?? "").trim();
    if (!windowId || !elementId) throw new Error("windows.clickElement requires windowId and elementId.");
    const result = await runConsoleRuntimeAction({ kind: "clickWindowElement", windowId, elementId });
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.wave") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const result = await window.shockless.sendUserRelayAction({ action: "wave" }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.dance") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const result = await window.shockless.sendUserRelayAction({ action: "dance", number: cleanPositiveInt(args.number, 1) }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.stopDance") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const result = await window.shockless.sendUserRelayAction({ action: "stopDance" }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.hcDance") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const result = await window.shockless.sendUserRelayAction({ action: "hcdance", number: cleanPositiveInt(args.number, 1) }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.carryDrink") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const result = await window.shockless.sendUserRelayAction({ action: "carryDrink" }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "avatar.applyLook") {
    requirePluginPermission(plugin, ["actions.avatar"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for user action.");
    const figure = String(args.figure ?? "").trim();
    if (!figure) throw new Error("avatar.applyLook requires a figure string.");
    const result = await window.shockless.sendUserRelayAction({ action: "applyLook", figure }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "social.message") {
    requirePluginPermission(plugin, ["actions.social"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for social message.");
    const result = await window.shockless.sendSocialRelayAction(
      { action: "message", accountId: cleanPositiveInt(args.accountId, 0), message: String(args.message ?? ""), recipient: String(args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>).recipient ?? "" : "") },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "social.addUser") {
    requirePluginPermission(plugin, ["actions.social"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for friend request.");
    const result = await window.shockless.sendSocialRelayAction({ action: "addUser", name: String(args.name ?? "") }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "social.refreshRequests") {
    requirePluginPermission(plugin, ["actions.social"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for friend requests.");
    const result = await window.shockless.sendSocialRelayAction({ action: "refreshFriendRequests" }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "social.acceptRequest" || request.api === "social.declineRequest" || request.api === "social.removeFriend" || request.api === "social.followFriend") {
    requirePluginPermission(plugin, ["actions.social"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for social action.");
    const accountId = cleanPositiveInt(args.accountId, 0);
    const socialAction: SocialRelayAction =
      request.api === "social.acceptRequest" ? { action: "acceptRequest", accountId } :
      request.api === "social.declineRequest" ? { action: "declineRequest", accountId } :
      request.api === "social.removeFriend" ? { action: "removeFriend", accountId } :
      { action: "followFriend", accountId };
    const result = await window.shockless.sendSocialRelayAction(socialAction, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "plants.getState" || request.api === "plants.findPlants" || request.api === "plants.planCycle") {
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    const runtimeSummary = await runtimeSummaryForClient(targetClientId);
    const selector = args.selector ?? options.selector ?? {};
    const rows = pluginPlantRows(snapshot, furniMetadata, selector);
    const plan = pluginPlantCyclePlan(snapshot, selector, furniMetadata);
    const planRecord = plan as Record<string, unknown> | null;
    const payload = {
      roomReady: snapshot ? Boolean(snapshot.roomReady?.ready ?? snapshot.roomEntryState?.roomReady?.ready) : runtimeSummary?.roomReady ?? false,
      selectedClientId: selectedClientIdRef.current,
      clientId: targetClientId,
      hasFullRuntimeSnapshot: Boolean(snapshot),
      userCount: snapshot?.userState?.roomUserCount ?? snapshot?.roomObjects?.counts.users ?? runtimeSummary?.userCount ?? null,
      occupants: pluginRoomOccupantsPayload(snapshot),
      target: planRecord?.["plant"] ?? null,
      plan,
      plants: rows.map((row) => pluginPlantPayload(row, furniMetadata)),
    };
    if (request.api === "plants.findPlants") return payload.plants;
    if (request.api === "plants.planCycle") return plan;
    return payload;
  }
  if (request.api === "plants.runCycle") {
    requirePluginPermission(plugin, ["actions.plants"]);
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const bridge = window.shockless;
    if (!bridge) throw new Error("Desktop bridge unavailable for plant cycle.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const initialSnapshot = await fullSnapshotForClient(targetClientId);
    if (!initialSnapshot) throw new Error("plants.runCycle needs the target client to be the selected rendered client so live plant state is available.");
    const plan = pluginPlantCyclePlan(initialSnapshot, args.selector ?? options.selector ?? {}, furniMetadata);
    const planRecord = plan as Record<string, unknown> | null;
    const objectId = cleanPositiveInt(planRecord?.["objectId"], 0);
    if (!objectId) throw new Error("plants.runCycle could not resolve a plant object id.");

    type CycleTile = { readonly x: number; readonly y: number; readonly direction: number };
    const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => Math.max(min, Math.min(max, cleanInteger(value, fallback)));
    const tileFromRecord = (value: unknown, fallbackDirection = 0): CycleTile | null => {
      const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const x = finiteNumber(record.x);
      const y = finiteNumber(record.y);
      if (x === null || y === null) return null;
      return { x: Math.trunc(x), y: Math.trunc(y), direction: cleanInteger(record.direction, fallbackDirection) };
    };
    const original = tileFromRecord(planRecord?.["original"]);
    if (!original) throw new Error("plants.runCycle could not resolve the plant's original tile.");
    const working = tileFromRecord(planRecord?.["working"], original.direction) ?? original;
    const candidateValues = [
      ...(Array.isArray(planRecord?.["workingTiles"]) ? planRecord?.["workingTiles"] as unknown[] : []),
      ...(Array.isArray(planRecord?.["candidates"]) ? planRecord?.["candidates"] as unknown[] : []),
      working,
    ];
    const candidateTiles: CycleTile[] = [];
    const candidateKeys = new Set<string>();
    for (const value of candidateValues) {
      const tile = tileFromRecord(value, original.direction);
      if (!tile) continue;
      const key = tileKey(tile.x, tile.y);
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      candidateTiles.push(tile);
    }
    if (candidateTiles.length === 0) candidateTiles.push(working);

    const mode = String(options.mode ?? args.mode ?? "waterHarvest").trim().toLowerCase();
    const settleMs = boundedInt(options.settleMs ?? args.settleMs, 350, 0, 5000);
    const pollIntervalMs = boundedInt(options.pollIntervalMs ?? args.pollIntervalMs, 150, 50, 1000);
    const moveTimeoutMs = boundedInt(options.moveTimeoutMs ?? args.moveTimeoutMs, 3000, 250, 10000);
    const actionTimeoutMs = boundedInt(options.actionTimeoutMs ?? args.actionTimeoutMs ?? options.actionDelayMs ?? args.actionDelayMs, 2500, 250, 10000);
    const compostTimeoutMs = boundedInt(options.compostTimeoutMs ?? args.compostTimeoutMs, 2000, 250, 10000);
    const moveRetryLimit = boundedInt(options.moveRetryLimit ?? args.moveRetryLimit, 3, 1, 8);
    const actionAttempts = 1 + boundedInt(options.actionRetryLimit ?? args.actionRetryLimit, 2, 0, 8);
    const compostAttemptLimit = boundedInt(options.compostAttemptLimit ?? args.compostAttemptLimit, 3, 1, 8);
    const results: Record<string, unknown>[] = [];
    const confirmed: Record<string, boolean | null> = { move: false, water: null, harvest: null, compost: null, return: false };

    const freshSnapshot = async (waitMs = 0): Promise<EngineRuntimeSnapshot | null> => {
      if (waitMs > 0) await delay(waitMs);
      if (targetClientId === selectedClientIdRef.current) {
        return await refreshRuntimeSnapshot(["full"]).catch(() => null) ?? selectedRuntimeSnapshotRef.current;
      }
      return await fullSnapshotForClient(targetClientId);
    };
    const plantRow = (runtimeSnapshot: EngineRuntimeSnapshot | null): ItemRow | null =>
      pluginPlantRows(runtimeSnapshot, furniMetadata, { id: objectId, exact: true })[0] ?? null;
    const plantSignature = (row: ItemRow | null): string => {
      if (!row) return "missing";
      const record = row.item as RuntimeObjectSummary & Record<string, unknown>;
      return [
        record.state,
        record.type,
        record["data"],
        record["rawData"],
        record["props"],
        record["rawProps"],
        record["stuffData"],
        record["extra"],
        itemRowMeta(row, furniMetadata),
      ].map(compactValue).join("|");
    };
    const waitForTile = async (tile: CycleTile, timeoutMs: number): Promise<boolean> => {
      const startedAt = Date.now();
      do {
        const nextSnapshot = await freshSnapshot(pollIntervalMs);
        const nextTile = itemRowTile(plantRow(nextSnapshot));
        if (nextTile && nextTile.x === tile.x && nextTile.y === tile.y) return true;
      } while (Date.now() - startedAt < timeoutMs);
      return false;
    };
    const waitForSignatureChange = async (before: string, timeoutMs: number): Promise<boolean> => {
      const startedAt = Date.now();
      do {
        const nextSnapshot = await freshSnapshot(pollIntervalMs);
        const nextSignature = plantSignature(plantRow(nextSnapshot));
        if (nextSignature !== before) return true;
      } while (Date.now() - startedAt < timeoutMs);
      return false;
    };
    const waitForRemoval = async (timeoutMs: number): Promise<boolean> => {
      const startedAt = Date.now();
      do {
        const nextSnapshot = await freshSnapshot(pollIntervalMs);
        if (!plantRow(nextSnapshot)) return true;
      } while (Date.now() - startedAt < timeoutMs);
      return false;
    };
    const sendMove = async (phase: string, tile: CycleTile, attempt: number): Promise<boolean> => {
      const sent = await bridge.sendGardeningRelayAction({ action: "move", objectId, x: tile.x, y: tile.y, direction: tile.direction }, targetClientId);
      results.push({ phase, attempt, target: tile, sent });
      return waitForTile(tile, moveTimeoutMs);
    };

    let workingTile = candidateTiles[0]!;
    for (let attempt = 1; attempt <= moveRetryLimit; attempt += 1) {
      const candidate = candidateTiles[(attempt - 1) % candidateTiles.length]!;
      if (await sendMove("move_out", candidate, attempt)) {
        confirmed.move = true;
        workingTile = candidate;
        break;
      }
    }
    if (!confirmed.move) {
      await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      return { ok: false, message: `Plant #${objectId} did not confirm at a working tile.`, plan, results, confirmed };
    }
    if (settleMs > 0) await delay(settleMs);

    if (mode === "compost" || mode === "compostonly" || mode === "compost-only") {
      for (let attempt = 1; attempt <= compostAttemptLimit; attempt += 1) {
        const sent = await bridge.sendGardeningRelayAction({ action: "compost", objectId }, targetClientId);
        results.push({ phase: "compost", attempt, sent });
        if (await waitForRemoval(compostTimeoutMs)) {
          confirmed.compost = true;
          await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
          return { ok: true, message: `Plant #${objectId} composted.`, plan, workingTile, results, confirmed };
        }
      }
      confirmed.compost = false;
    } else {
      for (const action of ["water", "harvest"] as const) {
        let actionConfirmed = false;
        for (let attempt = 1; attempt <= actionAttempts; attempt += 1) {
          const before = plantSignature(plantRow(await freshSnapshot()));
          const sent = await bridge.sendGardeningRelayAction({ action, objectId }, targetClientId);
          results.push({ phase: action, attempt, sent });
          if (await waitForSignatureChange(before, actionTimeoutMs)) {
            actionConfirmed = true;
            break;
          }
        }
        confirmed[action] = actionConfirmed;
      }
    }

    for (let attempt = 1; attempt <= moveRetryLimit; attempt += 1) {
      if (await sendMove("return", original, attempt)) {
        confirmed.return = true;
        break;
      }
    }
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    const ok = confirmed.return === true && (mode.startsWith("compost") ? confirmed.compost === true : true);
    return {
      ok,
      message: ok
        ? `Plant cycle completed for #${objectId}.`
        : `Plant cycle for #${objectId} finished with unconfirmed phase(s).`,
      plan,
      workingTile,
      results,
      confirmed,
    };
  }
  if (request.api === "plants.movePlant") {
    requirePluginPermission(plugin, ["actions.plants"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for plant movement.");
    const result = await window.shockless.sendGardeningRelayAction(
      { action: "move", objectId: cleanPositiveInt(args.objectId, 0), x: cleanInteger(args.x, 0), y: cleanInteger(args.y, 0), direction: cleanInteger(args.direction, 0) },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "plants.waterPlant" || request.api === "plants.harvestPlant" || request.api === "plants.compostPlant") {
    requirePluginPermission(plugin, ["actions.plants"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for plant action.");
    const action = request.api === "plants.waterPlant" ? "water" : request.api === "plants.harvestPlant" ? "harvest" : "compost";
    const result = await window.shockless.sendGardeningRelayAction({ action, objectId: cleanPositiveInt(args.objectId, 0) }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "wallItems.setAnywherePlacementEnabled") {
    requirePluginPermission(plugin, ["actions.wallItems"]);
    requirePluginPermission(plugin, ["engine.control"]);
    const webview = webviewRef.current;
    if (!webview || !engineUrl || !selectedClientIsVisible) throw new Error("Start a visible embedded client before changing wall placement behavior.");
    const result = await runEngineRuntimeAction(webview, { kind: "setWallItemAnywherePlacement", enabled: Boolean(args.enabled) });
    setWallAnywhereMessage(result.message);
    return result;
  }
  if (request.api === "furni.setAnywherePlacementEnabled") {
    requirePluginPermission(plugin, ["actions.furni"]);
    requirePluginPermission(plugin, ["engine.control"]);
    const webview = webviewRef.current;
    if (!webview || !engineUrl || !selectedClientIsVisible) throw new Error("Start a visible embedded client before changing floor placement behavior.");
    const result = await runEngineRuntimeAction(webview, { kind: "setFloorItemAnywherePlacement", enabled: Boolean(args.enabled) });
    setFloorAnywhereMessage(result.message);
    return result;
  }
  if (request.api === "wallItems.locationFromStagePoint" || request.api === "wallItems.moveAnywhere" || request.api === "wallItems.placeAnywhere") {
    requirePluginPermission(plugin, request.api === "wallItems.locationFromStagePoint" ? ["engine.snapshot"] : ["actions.wallItems"]);
    if (request.api !== "wallItems.locationFromStagePoint" && !window.shockless) {
      throw new Error("Desktop bridge unavailable for wall item placement.");
    }
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const selector = args.selector ?? args.item ?? args.itemId;
    const pointOrLocation = args.pointOrLocation ?? args.point ?? args.location;
    const directId = pluginSelectorNumericId(selector);
    const directLocation = pluginSelectorWallLocation(selector, pointOrLocation);
    const directPoint = pluginStagePoint(pointOrLocation);
    const selectorRecord = selector && typeof selector === "object" ? (selector as Record<string, unknown>) : {};
    const sourceItem = (selectorRecord.raw && typeof selectorRecord.raw === "object" ? selectorRecord.raw : selector) as RuntimeObjectSummary | null | undefined;
    const sourceLocation = directLocation ?? (directPoint ? wallLocationFromStagePoint(sourceItem, directPoint, options) : null);
    const needsSnapshot = !directId || !sourceLocation;
    if (needsSnapshot) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = needsSnapshot ? await fullSnapshotForClient(targetClientId) : null;
    const resolved = snapshot ? pluginResolveWallItem(snapshot, selector, furniMetadata) : null;
    const itemId = directId ?? resolved?.id ?? null;
    const location = sourceLocation ?? (directPoint && resolved ? wallLocationFromStagePoint(resolved.row.item, directPoint, options) : null);
    if (!location) throw new Error(`${request.api} needs a clicked stage point or full wall/local/orientation coordinates.`);
    if (request.api === "wallItems.locationFromStagePoint") {
      return {
        location,
        item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null,
      };
    }
    if (!itemId) throw new Error(`${request.api} needs a wall item id or a selector that resolves to a wall item.`);
    const result = await window.shockless!.sendWallMoverRelayAction(
      {
        action: "moveItem",
        itemId,
        wallX: location.wallX,
        wallY: location.wallY,
        localX: location.localX,
        localY: location.localY,
        orientation: location.orientation,
        className: compactValue(resolved?.row.item.className ?? selectorRecord.className ?? selectorRecord.name),
      },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, location, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "wallItems.moveItem") {
    requirePluginPermission(plugin, ["actions.wallItems"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for wall item movement.");
    const item = args.item && typeof args.item === "object" ? args.item as Record<string, unknown> : {};
    const result = await window.shockless.sendWallMoverRelayAction(
      {
        action: "moveItem",
        itemId: cleanPositiveInt(item.itemId, 0),
        wallX: cleanInteger(item.wallX, 0),
        wallY: cleanInteger(item.wallY, 0),
        localX: cleanInteger(item.localX, 0),
        localY: cleanInteger(item.localY, 0),
        orientation: item.orientation === "r" ? "r" : "l",
        className: typeof item.className === "string" ? item.className : undefined,
      },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "wallItems.pickupItem") {
    requirePluginPermission(plugin, ["actions.wallItems"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for wall item pickup.");
    const result = await window.shockless.sendWallMoverRelayAction({ action: "pickup", itemId: cleanPositiveInt(args.itemId, 0) }, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "furni.findItems" || request.api === "furni.findItem") {
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const requestedKind = String(args.kind ?? options.kind ?? "all").trim().toLowerCase();
    const kind = requestedKind === "floor" || requestedKind === "wall" ? requestedKind : "all";
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    if (!snapshot) throw new Error("furni.findItems needs the target client to be the selected rendered client so room object rows are available.");
    const rows = pluginFindItemRows(snapshot, args.selector, furniMetadata, kind);
    const items = rows.map((row) => pluginRuntimeItemPayload(row, furniMetadata));
    return request.api === "furni.findItem" ? items[0] ?? null : items;
  }
  if (request.api === "furni.moveFloorItem" || request.api === "furni.rotateFloorItem" || request.api === "furni.setFloorItemLocation") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for furni movement.");
    const isRotate = request.api === "furni.rotateFloorItem";
    const isPreciseLocation = request.api === "furni.setFloorItemLocation";
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.objectId ?? args.item;
    const directId = pluginSelectorNumericId(selector);
    const selectorTile = pluginSelectorTile(selector);
    const directX = finiteNumber(isRotate ? selectorTile?.x : args.x ?? selectorTile?.x);
    const directY = finiteNumber(isRotate ? selectorTile?.y : args.y ?? selectorTile?.y);
    const directDirection = finiteNumber(args.direction ?? selectorTile?.direction);
    const needsSnapshot = !directId || directX === null || directY === null || (!isPreciseLocation && directDirection === null);
    if (needsSnapshot) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = needsSnapshot ? await fullSnapshotForClient(targetClientId) : null;
    const resolved = snapshot ? pluginResolveFloorItem(snapshot, selector, furniMetadata) : null;
    const objectId = directId ?? resolved?.id ?? null;
    if (!objectId) throw new Error(`${request.api} needs a floor item id or a selector that resolves to a floor item.`);
    const xValue = finiteNumber(directX ?? resolved?.tile.x);
    const yValue = finiteNumber(directY ?? resolved?.tile.y);
    const directionValue = finiteNumber(directDirection ?? resolved?.tile.direction);
    if (xValue === null || yValue === null) throw new Error(`${request.api} needs target tile x/y or a selector with a parsed tile.`);
    if (!isPreciseLocation && directionValue === null) throw new Error(`${request.api} needs a direction or a selector with current direction.`);
    const action: FurniRelayAction = isPreciseLocation
      ? {
          action: "setFloorItemLocation",
          objectId,
          x: Math.trunc(xValue),
          y: Math.trunc(yValue),
          height: finiteNumber(args.height) ?? 0,
          className: compactValue(resolved?.row.item.className),
        }
      : {
          action: isRotate ? "rotateFloorItem" : "moveFloorItem",
          objectId,
          x: Math.trunc(xValue),
          y: Math.trunc(yValue),
          direction: Math.trunc(directionValue ?? 0),
          className: compactValue(resolved?.row.item.className),
        };
    const result = await window.shockless.sendFurniRelayAction(action, targetClientId);
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "furni.pickupFloorItem") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for furni pickup.");
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.objectId ?? args.item;
    const directId = pluginSelectorNumericId(selector);
    if (!directId) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = directId ? null : await fullSnapshotForClient(targetClientId);
    const resolved = snapshot ? pluginResolveFloorItem(snapshot, selector, furniMetadata) : null;
    const objectId = directId ?? resolved?.id ?? null;
    if (!objectId) throw new Error("furni.pickupFloorItem needs a floor item id or a selector that resolves to a floor item.");
    const result = await window.shockless.sendFurniRelayAction(
      { action: "pickupFloorItem", objectId, className: compactValue(resolved?.row.item.className) },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "furni.useFloorItem") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for furni use.");
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.objectId ?? args.item;
    const directId = pluginSelectorNumericId(selector);
    if (!directId) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = directId ? null : await fullSnapshotForClient(targetClientId);
    const resolved = snapshot ? pluginResolveFloorItem(snapshot, selector, furniMetadata) : null;
    const objectId = directId ?? resolved?.id ?? null;
    if (!objectId) throw new Error("furni.useFloorItem needs a floor item id or a selector that resolves to a floor item.");
    const result = await window.shockless.sendFurniRelayAction(
      { action: "useFloorItem", objectId, value: String(args.value ?? "0"), className: compactValue(resolved?.row.item.className) },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "furni.moveWallItem") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for wall furni movement.");
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.item ?? args.itemId;
    const directId = pluginSelectorNumericId(selector);
    const directLocation = pluginSelectorWallLocation(selector, args.location);
    if (!directId || !directLocation) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = directId && directLocation ? null : await fullSnapshotForClient(targetClientId);
    const resolved = snapshot ? pluginResolveWallItem(snapshot, selector, furniMetadata) : null;
    const itemId = directId ?? resolved?.id ?? null;
    const location = directLocation ?? (resolved ? pluginWallMoveLocation(resolved.location, args.location) : null);
    if (!itemId) throw new Error("furni.moveWallItem needs a wall item id or a selector that resolves to a wall item.");
    if (!location) throw new Error("furni.moveWallItem needs wall/local/orientation coordinates or a selected wall item with parsed coordinates.");
    const result = await window.shockless.sendFurniRelayAction(
      {
        action: "moveWallItem",
        itemId,
        wallX: location.wallX,
        wallY: location.wallY,
        localX: location.localX,
        localY: location.localY,
        orientation: location.orientation,
        className: compactValue(resolved?.row.item.className),
      },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "furni.pickupWallItem") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for wall furni pickup.");
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.itemId ?? args.item;
    const directId = pluginSelectorNumericId(selector);
    if (!directId) requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = directId ? null : await fullSnapshotForClient(targetClientId);
    const resolved = snapshot ? pluginResolveWallItem(snapshot, selector, furniMetadata) : null;
    const itemId = directId ?? resolved?.id ?? null;
    if (!itemId) throw new Error("furni.pickupWallItem needs a wall item id or a selector that resolves to a wall item.");
    const result = await window.shockless.sendFurniRelayAction(
      { action: "pickupWallItem", itemId, className: compactValue(resolved?.row.item.className) },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
  }
  if (request.api === "furni.pickupItem") {
    requirePluginPermission(plugin, ["actions.furni"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for furni pickup.");
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const selector = args.selector ?? args.itemId ?? args.objectId ?? args.item;
    const kind = pluginSelectorKind(selector);
    if (kind === "floor") {
      const objectId = pluginSelectorNumericId(selector);
      if (!objectId) requirePluginPermission(plugin, ["engine.snapshot"]);
      const resolved = objectId ? null : pluginResolveFloorItem(await fullSnapshotForClient(targetClientId), selector, furniMetadata);
      const id = objectId ?? resolved?.id ?? null;
      if (!id) throw new Error("furni.pickupItem could not resolve a floor item id.");
      const result = await window.shockless.sendFurniRelayAction({ action: "pickupFloorItem", objectId: id }, targetClientId);
      await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
    }
    if (kind === "wall") {
      const itemId = pluginSelectorNumericId(selector);
      if (!itemId) requirePluginPermission(plugin, ["engine.snapshot"]);
      const resolved = itemId ? null : pluginResolveWallItem(await fullSnapshotForClient(targetClientId), selector, furniMetadata);
      const id = itemId ?? resolved?.id ?? null;
      if (!id) throw new Error("furni.pickupItem could not resolve a wall item id.");
      const result = await window.shockless.sendFurniRelayAction({ action: "pickupWallItem", itemId: id }, targetClientId);
      await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      return { ...result, item: resolved ? pluginRuntimeItemPayload(resolved.row, furniMetadata) : null };
    }
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const snapshot = await fullSnapshotForClient(targetClientId);
    const row = pluginFindItemRows(snapshot, selector, furniMetadata, "all")[0];
    if (!row) throw new Error("furni.pickupItem needs item kind or a selector that resolves to a live room item.");
    const id = objectNumericId(row.item);
    if (!id) throw new Error("furni.pickupItem resolved item has no numeric id.");
    const action: FurniRelayAction = row.kind === "wall" ? { action: "pickupWallItem", itemId: id } : { action: "pickupFloorItem", objectId: id };
    const result = await window.shockless.sendFurniRelayAction(action, targetClientId);
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, item: pluginRuntimeItemPayload(row, furniMetadata) };
  }
  if (request.api === "fishing.getState") {
    requirePluginPermission(plugin, ["engine.snapshot"]);
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    const runtimeSummary = await runtimeSummaryForClient(targetClientId);
    const pluginSnapshot = await freshPluginSnapshotForClient(targetClientId, snapshot, runtimeSummary);
    const packetActiveObjects = pluginSnapshot?.packetActiveObjects ?? null;
    const packetActiveRows = packetActiveObjects?.items.map(packetActiveObjectRow) ?? [];
    const removedPacketObjectIds = packetActiveObjects?.removedObjectIds ?? [];
    const rows = pluginFishingAreaRows(snapshot, furniMetadata, packetActiveRows, removedPacketObjectIds);
    const target = pluginFishingAreaTarget(snapshot, args.areaId, furniMetadata, packetActiveRows, removedPacketObjectIds);
    const walkTarget = pluginFishingAreaWalkTarget(snapshot, args.areaId, furniMetadata, packetActiveRows, removedPacketObjectIds);
    const occupants = pluginRoomOccupantsPayload(snapshot);
    const sessionName = snapshot?.userState?.sessionUserName ?? null;
    const rawUsers = snapshot?.userState?.users ?? snapshot?.roomObjects?.users ?? [];
    const normalizedSessionName = String(sessionName ?? "").trim().toLowerCase();
    const rawSelf =
      rawUsers.find((user) => normalizedSessionName && userDisplayName(user, sessionName).trim().toLowerCase() === normalizedSessionName) ??
      rawUsers.find((user) => user.rowId === "0") ??
      null;
    const selfTile = userTile(rawSelf);
    const self = occupants.self
      ? { ...occupants.self, tile: selfTile }
      : rawSelf
        ? { ...pluginRuntimeUserPayload(rawSelf, sessionName), tile: selfTile }
        : null;
    return {
      roomReady: snapshot ? Boolean(snapshot.roomReady?.ready ?? snapshot.roomEntryState?.roomReady?.ready) : runtimeSummary?.roomReady ?? false,
      selectedClientId: selectedClientIdRef.current,
      clientId: targetClientId,
      hasFullRuntimeSnapshot: Boolean(snapshot),
      userCount: snapshot?.userState?.roomUserCount ?? snapshot?.roomObjects?.counts.users ?? runtimeSummary?.userCount ?? null,
      occupants,
      self,
      target: target?.area ?? null,
      walkTarget: walkTarget ? { x: walkTarget.x, y: walkTarget.y, furniId: walkTarget.furniId, label: walkTarget.label } : null,
      areas: rows.map((row) => {
        const area = pluginFishingAreaPayload(row, furniMetadata);
        return {
          ...area,
          walkCandidates: pluginFishingAreaWalkCandidates(snapshot, area.id, furniMetadata, packetActiveRows, 5, removedPacketObjectIds).slice(0, 12).map((candidate) => ({
            x: candidate.x,
            y: candidate.y,
            furniId: candidate.furniId,
            label: candidate.label,
            selfDistance: candidate.selfDistance,
          })),
        };
      }),
      packet: pluginSnapshot?.packetFishing ?? null,
    };
  }
  if (request.api === "fishing.walkToArea") {
    requirePluginPermission(plugin, ["actions.fishing"]);
    requirePluginPermission(plugin, ["actions.avatar"]);
    requirePluginPermission(plugin, ["engine.snapshot"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for Fishing movement.");
    const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const snapshot = await fullSnapshotForClient(targetClientId);
    if (!snapshot) throw new Error("fishing.walkToArea needs the target client to be the selected rendered client so room object tiles are available.");
    const candidateIndex = Math.max(0, cleanInteger(options.candidateIndex ?? args.candidateIndex, 0));
    const runtimeSummary = await runtimeSummaryForClient(targetClientId);
    const pluginSnapshot = await freshPluginSnapshotForClient(targetClientId, snapshot, runtimeSummary);
    const packetActiveObjects = pluginSnapshot?.packetActiveObjects ?? null;
    const packetActiveRows = packetActiveObjects?.items.map(packetActiveObjectRow) ?? [];
    const candidates = pluginFishingAreaWalkCandidates(snapshot, args.areaId, furniMetadata, packetActiveRows, 5, packetActiveObjects?.removedObjectIds ?? []);
    const target = candidates[candidateIndex] ?? candidates[0] ?? null;
    if (!target) throw new Error("fishing.walkToArea could not resolve a free candidate tile near a parsed fishing area.");
    const result = await window.shockless.sendRoomRelayAction(
      { action: "move", x: target.x, y: target.y, furniId: target.furniId },
      targetClientId,
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return { ...result, target };
  }
  if (request.api === "fishing.startFishing") {
    requirePluginPermission(plugin, ["actions.fishing"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for Fishing action.");
    const result = await window.shockless.sendFishingRelayAction(
      { action: "startFishing", areaId: cleanPositiveInt(args.areaId, 0) },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "fishing.minigameInput") {
    requirePluginPermission(plugin, ["actions.fishing"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for Fishing action.");
    const direction = String(args.direction ?? "").trim().toUpperCase();
    if (direction !== "L" && direction !== "R") throw new Error("fishing.minigameInput direction must be L or R.");
    const result = await window.shockless.sendFishingRelayAction(
      { action: "minigameInput", direction },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "fishing.purchaseProduct") {
    requirePluginPermission(plugin, ["actions.fishing"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for Fishing action.");
    const productCode = String(args.productCode ?? args.code ?? "").trim();
    const result = await window.shockless.sendFishingRelayAction(
      { action: "purchaseProduct", productCode },
      requestedPluginClientId(args, selectedClientIdRef.current),
    );
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (
    request.api === "fishing.registerDerby" ||
    request.api === "fishing.requestTokens" ||
    request.api === "fishing.requestProducts" ||
    request.api === "fishing.requestRodLevel" ||
    request.api === "fishing.requestStats" ||
    request.api === "fishing.requestFishopedia"
  ) {
    requirePluginPermission(plugin, ["actions.fishing"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for Fishing action.");
    const action: FishingRelayAction =
      request.api === "fishing.registerDerby" ? { action: "registerDerby" } :
      request.api === "fishing.requestTokens" ? { action: "requestTokens" } :
      request.api === "fishing.requestProducts" ? { action: "requestProducts" } :
      request.api === "fishing.requestRodLevel" ? { action: "requestRodLevel" } :
      request.api === "fishing.requestStats" ? { action: "requestStats" } :
      { action: "requestFishopedia" };
    const result = await window.shockless.sendFishingRelayAction(action, requestedPluginClientId(args, selectedClientIdRef.current));
    await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
    return result;
  }
  if (request.api === "packets.send") {
    requirePluginPermission(plugin, ["packet.inject"]);
    if (!window.shockless) throw new Error("Desktop bridge unavailable for packet send.");
    const result = await window.shockless.sendPluginPacket(args.packet as PluginPacketInput, requestedPluginClientId(args, selectedClientIdRef.current));
    await refreshRelayLog().catch(() => null);
    return result;
  }
  if (request.api === "console.registerCommand") {
    requirePluginPermission(plugin, ["console.commands"]);
    return { ok: false, message: "Plugin console command registration is reserved for the command registry phase." };
  }
  if (request.api === "ui.registerPanel" || request.api === "ui.registerSurface" || request.api === "ui.updateSurface") {
    requirePluginPermission(plugin, ["ui.panel"]);
    const args = (request.args && typeof request.args === "object" ? request.args : {}) as Record<string, unknown>;
    const surface = (args.surface && typeof args.surface === "object" ? args.surface : {}) as Record<string, unknown>;
    const surfaceId = String(args.surfaceId ?? surface.id ?? "panel").trim() || "panel";
    const layoutValue = args.layout ?? surface.layout;
    const layout = Array.isArray(layoutValue) ? layoutValue as readonly PluginUiElement[] : [];
    if (layout.length === 0) return { ok: false, message: `${request.api} requires a non-empty schema layout.` };
    setPluginRuntimeUiById((current) => {
      const existing = current[plugin.id] ?? {};
      return {
        ...current,
        [plugin.id]: {
          ...existing,
          surfaces: {
            ...(existing.surfaces ?? {}),
            [surfaceId]: layout,
          },
        },
      };
    });
    return { ok: true, message: `${plugin.name} updated ${surfaceId}.` };
  }
  if (request.api === "ui.setValue") {
    requirePluginPermission(plugin, ["ui.panel"]);
    const args = (request.args && typeof request.args === "object" ? request.args : {}) as Record<string, unknown>;
    const key = String(args.key ?? "").trim();
    if (!key) return { ok: false, message: "ui.setValue requires a key." };
    const value = ["string", "number", "boolean"].includes(typeof args.value) || args.value === null ? args.value as string | number | boolean | null : String(args.value ?? "");
    setPluginRuntimeUiById((current) => {
      const existing = current[plugin.id] ?? {};
      return {
        ...current,
        [plugin.id]: {
          ...existing,
          values: {
            ...(existing.values ?? {}),
            [key]: value,
          },
        },
      };
    });
    return { ok: true, message: `${plugin.name} set ${key}.` };
  }
  if (request.api === "notifications.showBulletin") {
    requirePluginPermission(plugin, ["notifications.show"]);
    const args = (request.args && typeof request.args === "object" ? request.args : {}) as Record<string, unknown>;
    const targetClientId = requestedPluginClientId(args, selectedClientIdRef.current);
    const webview = gameWebviewRefs.current.get(targetClientId) ?? (targetClientId === selectedClientIdRef.current ? webviewRef.current : null);
    if (!webview) return { ok: false, message: `Client ${targetClientId} has no visible engine view for bulletin notifications.` };
    const result = await runEngineRuntimeAction(webview, {
      kind: "showBulletinNotification",
      title: String(args.title ?? "Notification"),
      message: String(args.message ?? args.body ?? args.text ?? ""),
      imageName: typeof args.imageName === "string" ? args.imageName : undefined,
      titleColor: typeof args.titleColor === "string" ? args.titleColor : undefined,
      backgroundColor: typeof args.backgroundColor === "string" ? args.backgroundColor : undefined,
    });
    return result;
  }
  throw new Error(`Unknown plugin host API: ${request.api}`);
}
