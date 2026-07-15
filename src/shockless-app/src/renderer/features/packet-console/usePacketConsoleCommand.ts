import { useCallback, type Dispatch, type SetStateAction } from "react";
import { runtimeRoomId, runtimeRoomName, runtimeRoomType } from "../../../engine-adapter/shocklessSessionAdapter";
import { redactConsoleCommandInput, type ConsoleRendererAction } from "../../../shared/consoleCommand";
import { buildShockwavePluginPacketFromControl } from "../../../shared/shockwavePluginPacketBuilder";
import type {
  AppPreferencesPatch, AppPreferencesState, ClientSessionList, ClientSnapshot, ConsoleCommandStateSnapshot, EngineLaunchState, GardeningRelayResult,
  RelayLogSnapshot, SocialRelayAction,
} from "../../../shared/window-api";
import type { EngineRuntimeAction, EngineRuntimeActionResult, EngineRuntimeSnapshot, EngineRuntimeSnapshotScope, RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, finiteNumber, runtimeUserMatchesLookup, userDisplayName, withVisibleConsoleContext } from "../common/model";
import { commandRefreshesEngineLaunch, isRelayBackedConsoleCommand, originsLookupLine, runtimeLookupLine } from "../console/commandRouting";
import { normalizePacketClientFilter } from "./relayModel";
import { parsePacketInjectionCommand } from "./packetInjectionCommand";
import { sceneFxPresetList } from "./suggestions";
import { packetProfileLookupLine, packetUserMatchesLookup } from "../packets/profile";
import {
  findPacketFriendForAction, findPacketFriendRequestForAction, friendRequestLookupLine, packetFriendActionId, packetFriendMatchesLookup,
  packetFriendMeta, packetFriendRequestActionId, packetFriendRequestMatchesLookup, packetFriendTitle, parsePositiveSocialAccountId,
} from "../packets/social";
import type { PacketInfoState, PacketProfileIndex, PacketProfileUser } from "../packets/types";
import { parseConsoleBoolean } from "../settings/normalization";
import type { PacketConsoleEntry } from "./types";

interface UserNameLabelSettings {
  readonly sourceYOffset: number;
  readonly selfColor: string;
  readonly otherColor: string;
}

interface PacketClientChoice {
  readonly value: string;
  readonly label: string;
}

interface PacketConsoleCommandOptions {
  readonly appPreferences: AppPreferencesState | null;
  readonly applyEngineLaunch: (launch: EngineLaunchState) => void;
  readonly applyUserNameLabelRuntime: (enabled?: boolean, settings?: UserNameLabelSettings, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult | null>;
  readonly appendPacketConsole: (kind: PacketConsoleEntry["kind"], text: string) => void;
  readonly clientSessions: ClientSessionList | null;
  readonly executeConsoleRendererActions: (actions: readonly ConsoleRendererAction[], output?: (kind: PacketConsoleEntry["kind"], text: string) => void) => Promise<void>;
  readonly packetClientChoices: readonly PacketClientChoice[];
  readonly packetConsoleInput: string;
  readonly packetInfoState: PacketInfoState;
  readonly packetProfileIndex: PacketProfileIndex;
  readonly perfTrace: boolean;
  readonly refreshClientSessions: () => Promise<ClientSessionList | null>;
  readonly refreshConsoleCommandState: () => Promise<ConsoleCommandStateSnapshot | null>;
  readonly refreshRelayLog: () => Promise<RelayLogSnapshot | null>;
  readonly refreshRuntimeSnapshot: (scopes?: readonly EngineRuntimeSnapshotScope[]) => Promise<EngineRuntimeSnapshot | null>;
  readonly refreshSelectedClientSnapshot: (clientId?: number, options?: { readonly updateSelectedSnapshot?: boolean }) => Promise<ClientSnapshot | null>;
  readonly runConsoleRuntimeAction: (action: EngineRuntimeAction) => Promise<EngineRuntimeActionResult>;
  readonly selectedClientIsVisible: boolean;
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly selectedUserAccountId: string;
  readonly selectedUserFigure: string;
  readonly selectedUserName: string;
  readonly selectedUserPosition: string;
  readonly sendSocialAction: (action: SocialRelayAction, label: string, clientId?: number) => Promise<GardeningRelayResult>;
  readonly setEngineUserNameLabels: Dispatch<SetStateAction<boolean>>;
  readonly setPacketConsoleClientFilter: Dispatch<SetStateAction<string>>;
  readonly setPacketConsoleEntries: Dispatch<SetStateAction<PacketConsoleEntry[]>>;
  readonly setPacketConsoleHistoryIndex: Dispatch<SetStateAction<number | null>>;
  readonly setPacketConsoleInput: Dispatch<SetStateAction<string>>;
  readonly setPacketConsoleQuery: Dispatch<SetStateAction<string>>;
  readonly setPerfTrace: Dispatch<SetStateAction<boolean>>;
  readonly setSmoothAvatars: Dispatch<SetStateAction<boolean>>;
  readonly setSmoothUi: Dispatch<SetStateAction<boolean>>;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly updateAppPreferencePatch: (patch: AppPreferencesPatch, message: string, severity?: "success" | "warning") => Promise<void>;
  readonly userNameLabelSettings: UserNameLabelSettings;
  readonly userRows: readonly RuntimeUserSummary[];
  readonly visibleActiveAccountNames: readonly string[];
}

export function usePacketConsoleCommand(options: PacketConsoleCommandOptions): () => Promise<void> {
  const {
    appPreferences,
    applyEngineLaunch,
    applyUserNameLabelRuntime,
    appendPacketConsole,
    clientSessions,
    executeConsoleRendererActions,
    packetClientChoices,
    packetConsoleInput,
    packetInfoState,
    packetProfileIndex,
    perfTrace,
    refreshClientSessions,
    refreshConsoleCommandState,
    refreshRelayLog,
    refreshRuntimeSnapshot,
    refreshSelectedClientSnapshot,
    runConsoleRuntimeAction,
    selectedClientIsVisible,
    selectedRuntimeSnapshot,
    selectedUserAccountId,
    selectedUserFigure,
    selectedUserName,
    selectedUserPosition,
    sendSocialAction,
    setEngineUserNameLabels,
    setPacketConsoleClientFilter,
    setPacketConsoleEntries,
    setPacketConsoleHistoryIndex,
    setPacketConsoleInput,
    setPacketConsoleQuery,
    setPerfTrace,
    setSmoothAvatars,
    setSmoothUi,
    smoothAvatars,
    smoothUi,
    updateAppPreferencePatch,
    userNameLabelSettings,
    userRows,
    visibleActiveAccountNames,
  } = options;

  return useCallback(async () => {
    const raw = packetConsoleInput.trim();
    if (!raw) return;
    setPacketConsoleInput("");
    setPacketConsoleHistoryIndex(null);
    appendPacketConsole("command", redactConsoleCommandInput(raw));

    let commandInput = raw.replace(/^\//, "");
    let commandParts = commandInput.split(/\s+/).filter(Boolean);
    let command = (commandParts[0] ?? "").toLowerCase();
    let parts: readonly string[] = commandParts.slice(1);
    let rest = commandInput.slice(commandParts[0]?.length ?? 0).trim();
    let targetClientIds: readonly number[] = [clientSessions?.selectedClientId ?? 1];
    if (window.shockless?.runConsoleCommand) {
      const busInput = withVisibleConsoleContext(raw, selectedClientIsVisible ? selectedRuntimeSnapshot : null, visibleActiveAccountNames);
      const busResult = await window.shockless.runConsoleCommand(busInput);
      await refreshConsoleCommandState().catch(() => null);
      for (const line of busResult.lines) appendPacketConsole(busResult.level, line);
      if (busResult.handled) {
        await refreshClientSessions().catch(() => null);
        await refreshSelectedClientSnapshot(busResult.targetClientIds?.[0] ?? clientSessions?.selectedClientId).catch(() => null);
        if ((busResult.rendererActions?.length ?? 0) > 0) {
          await executeConsoleRendererActions(busResult.rendererActions ?? []);
        }
        if (commandRefreshesEngineLaunch(busResult.command?.command ?? "", busResult.command?.args[0] ?? "")) {
          const launch = await window.shockless.getEngineLaunchState().catch(() => null);
          if (launch) applyEngineLaunch(launch);
        }
        return;
      }
      if (!busResult.ok) return;
      const busCommand = busResult.command?.command ?? "";
      const relayBackedCommand = isRelayBackedConsoleCommand(busCommand);
      if ((busResult.targetClientIds?.length ?? 0) !== 1 && !relayBackedCommand) {
        appendPacketConsole("warning", "This command needs exactly one target client in the current single-view phase.");
        return;
      }
      if (!relayBackedCommand && busResult.targetClientIds?.[0] !== (clientSessions?.selectedClientId ?? 1)) {
        appendPacketConsole("warning", `client${busResult.targetClientIds?.[0] ?? "-"} is not the selected visible client yet.`);
        return;
      }
      if (!relayBackedCommand && !selectedClientIsVisible) {
        appendPacketConsole("warning", `client${clientSessions?.selectedClientId ?? 1} is headless; this command needs a visible runtime.`);
        return;
      }
      commandInput = busResult.passthroughInput ?? busResult.command?.inputWithoutTarget ?? commandInput;
      commandParts = busResult.command ? [busResult.command.command, ...busResult.command.args] : commandInput.split(/\s+/).filter(Boolean);
      command = busResult.command?.command ?? (commandParts[0] ?? "").toLowerCase();
      parts = busResult.command?.args ?? commandParts.slice(1);
      rest = parts.join(" ");
      targetClientIds = busResult.targetClientIds ?? targetClientIds;
    }
    const runtime = selectedRuntimeSnapshot;
    const refreshSelectedRuntime = async () => (selectedClientIsVisible ? await refreshRuntimeSnapshot().catch(() => null) : null);
    const sendSocialToTargets = async (action: SocialRelayAction, label: string) => {
      for (const clientId of targetClientIds) {
        const result = await sendSocialAction(action, label, clientId);
        const prefix = targetClientIds.length > 1 ? `client${clientId}: ` : "";
        appendPacketConsole(result.ok ? "success" : "warning", `${prefix}${result.message}`);
      }
    };

    if (command === "inject" || command === "sendpacket" || command === "rawpacket") {
      const packetInput = parsePacketInjectionCommand(raw);
      if (!packetInput.ok) {
        appendPacketConsole("warning", packetInput.message);
        return;
      }
      const packet = { target: packetInput.target, packetText: packetInput.packetText } as const;
      const preview = buildShockwavePluginPacketFromControl(packet);
      if (!preview.ok) {
        appendPacketConsole("warning", preview.message);
        return;
      }
      if (!window.shockless?.sendPluginPacket) {
        appendPacketConsole("warning", "Run the Electron shell before injecting packets.");
        return;
      }
      for (const clientId of targetClientIds) {
        const result = await window.shockless.sendPluginPacket(packet, clientId);
        const prefix = targetClientIds.length > 1 ? `client${clientId}: ` : "";
        appendPacketConsole(result.ok ? "success" : "warning", `${prefix}${result.message}`);
        if (!result.ok) break;
      }
      await refreshRelayLog().catch(() => null);
      return;
    }

    if (command === "help" || command === "?") {
      appendPacketConsole(
        "info",
        "commands: help, clear, packets <filter|all|selected|client id>, inject server|client <packet>, list, select <id>, newclient, load <file> <count> --headless, mimic status|on|off|source <id>, enterroom <flat-id>, public <query>, navigator [view], hotelView, room, user, lookup <name>, rooms <query>, showNames true|false, smoothAvatars true|false|status, smoothUi true|false|status, perfTrace true|false|last|clear, hideFurni true|false, hideUsers true|false, hideUi true|false, hideBulletin, zoom 1|2, fx <preset>, say <message>, input [client] <message>, wave, dance <1-4>, carrydrink, message <user|id> <message>, adduser <name>, requests, accept <request>, decline <request>, follow <friend>, removefriend <friend>, walk <x> <y>, windowClick <window> <element>, inventory, fps [limit], perf, gpu",
      );
      return;
    }
    if (command === "clear") {
      setPacketConsoleEntries([]);
      return;
    }
    if (command === "packets" || command === "filter") {
      const mode = (parts[0] ?? "").toLowerCase();
      if (mode === "all" || mode === "clients") {
        setPacketConsoleClientFilter("All");
        appendPacketConsole("success", "packet client filter set to all clients");
        return;
      }
      if (mode === "selected") {
        const selected = String(clientSessions?.selectedClientId ?? 1);
        setPacketConsoleClientFilter(selected);
        appendPacketConsole("success", `packet client filter set to client${selected}`);
        return;
      }
      if (mode === "client" || mode === "c") {
        const nextClient = normalizePacketClientFilter(parts[1] ?? "All", packetClientChoices);
        setPacketConsoleClientFilter(nextClient);
        appendPacketConsole("success", nextClient === "All" ? "packet client filter set to all clients" : `packet client filter set to client${nextClient}`);
        return;
      }
      if (/^(?:client)?\d+$/i.test(parts[0] ?? "")) {
        const nextClient = normalizePacketClientFilter(parts[0] ?? "All", packetClientChoices);
        setPacketConsoleClientFilter(nextClient);
        appendPacketConsole("success", nextClient === "All" ? "packet client filter set to all clients" : `packet client filter set to client${nextClient}`);
        return;
      }
      setPacketConsoleQuery(rest);
      appendPacketConsole("success", rest ? `packet filter set to "${rest}"` : "packet filter cleared");
      return;
    }
    if (command === "fx" || command === "scenefilter" || command === "scene-filter") {
      const preset = (parts[0] ?? "").trim();
      if (!preset || preset.toLowerCase() === "list") {
        appendPacketConsole("info", `available fx presets: ${sceneFxPresetList}`);
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "setSceneFilter", name: preset });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "hidefurni" || command === "hidefurniture" || command === "showfurni" || command === "showfurniture") {
      const enabled = command.startsWith("show") ? false : parseConsoleBoolean(parts[0]);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: hideFurni true|false");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "setHideFurni", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "hideusers" || command === "showusers") {
      const enabled = command.startsWith("show") ? false : parseConsoleBoolean(parts[0]);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: hideUsers true|false");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "setHideUsers", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "hideui" || command === "hideinterface" || command === "showui" || command === "showinterface") {
      const enabled = command.startsWith("show") ? false : parseConsoleBoolean(parts[0]);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: hideUi true|false");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "setHideUi", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "hidebulletin" || command === "hidebulletinboard" || command === "autohidebulletin") {
      const result = await runConsoleRuntimeAction({ kind: "hideBulletinBoard" });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "hotelview" || command === "showhotelview" || command === "lobby") {
      const result = await runConsoleRuntimeAction({ kind: "showHotelView" });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "navigator" || command === "nav" || command === "opennavigator") {
      const result = await runConsoleRuntimeAction({ kind: "openNavigator", view: rest.trim() || "nav_pr" });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "public" || command === "enterpublic" || command === "publicroom" || command === "enterpublicroom") {
      const result = await runConsoleRuntimeAction({ kind: "enterPublicRoom", query: rest.trim() || undefined });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "inventory" || command === "hand" || command === "requestinventory") {
      const result = await runConsoleRuntimeAction({ kind: "requestInventory" });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "zoom" || command === "stagezoom" || command === "roomzoom") {
      const scale = Number(parts[0]);
      if (scale !== 1 && scale !== 2) {
        appendPacketConsole("warning", "usage: zoom 1|2");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "setRoomStageZoom", scale });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "windowclick" || command === "clickwindow" || command === "clickwindowelement") {
      const windowId = parts[0] ?? "";
      const elementId = parts[1] ?? "";
      if (!windowId || !elementId) {
        appendPacketConsole("warning", "usage: windowClick <window-id> <element-id>");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "clickWindowElement", windowId, elementId });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "shownames" || command === "names") {
      const enabled = parseConsoleBoolean(parts[0]);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: showNames true|false");
        return;
      }
      setEngineUserNameLabels(enabled);
      void updateAppPreferencePatch({ engineUserNameLabels: enabled }, `Username labels ${enabled ? "enabled" : "disabled"}.`);
      const result = await applyUserNameLabelRuntime(enabled, userNameLabelSettings);
      appendPacketConsole(result?.ok === false ? "warning" : "success", `username labels ${enabled ? "enabled" : "disabled"}`);
      return;
    }
    if (command === "smoothavatars") {
      const mode = (parts[0] ?? "status").toLowerCase();
      if (!mode || mode === "status") {
        const snapshot = (await refreshSelectedRuntime()) ?? runtime;
        const stats = snapshot?.performanceStats as Record<string, unknown> | null | undefined;
        const modern = stats?.modernPresentation as Record<string, unknown> | undefined;
        const avatar = modern?.avatarInterpolation as Record<string, unknown> | undefined;
        appendPacketConsole("info", `smoothAvatars preference=${smoothAvatars ? "on" : "off"} runtime=${compactValue(avatar?.enabled)} channels=${compactValue(avatar?.channels)} active=${compactValue(avatar?.active)} durationMs=${compactValue(avatar?.durationMs)}`);
        return;
      }
      const enabled = parseConsoleBoolean(mode);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: smoothAvatars true|false|status");
        return;
      }
      setSmoothAvatars(enabled);
      void updateAppPreferencePatch({ smoothAvatars: enabled }, `Room motion smoothing ${enabled ? "enabled" : "disabled"}.`);
      const result = await runConsoleRuntimeAction({ kind: "setSmoothAvatars", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "smoothui") {
      const mode = (parts[0] ?? "status").toLowerCase();
      if (!mode || mode === "status") {
        const snapshot = (await refreshSelectedRuntime()) ?? runtime;
        const stats = snapshot?.performanceStats as Record<string, unknown> | null | undefined;
        const modern = stats?.modernPresentation as Record<string, unknown> | undefined;
        const budget = modern?.sourceWindowBudget as Record<string, unknown> | undefined;
        appendPacketConsole("info", `smoothUi preference=${smoothUi ? "on" : "off"} runtime=${compactValue(budget?.enabled)} windows=${compactValue(modern?.sourceWindowCount)} channels=${compactValue(budget?.channels)} deferredText=${compactValue(budget?.deferredText)} deferredSprites=${compactValue(budget?.deferredSprites)}`);
        return;
      }
      const enabled = parseConsoleBoolean(mode);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: smoothUi true|false|status");
        return;
      }
      setSmoothUi(enabled);
      void updateAppPreferencePatch({ smoothUi: enabled }, `Source-window smoothing ${enabled ? "enabled" : "disabled"}.`);
      const result = await runConsoleRuntimeAction({ kind: "setSmoothUi", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "perftrace") {
      const mode = (parts[0] ?? "status").toLowerCase();
      if (!mode || mode === "status" || mode === "last") {
        const snapshot = (await refreshSelectedRuntime()) ?? runtime;
        const stats = snapshot?.performanceStats as Record<string, unknown> | null | undefined;
        const frameTrace = stats?.frameStutter as Record<string, unknown> | undefined;
        const samples = Array.isArray(frameTrace?.samples) ? frameTrace.samples : [];
        const slowRuntimeCalls = Array.isArray(frameTrace?.slowRuntimeCalls) ? frameTrace.slowRuntimeCalls : [];
        appendPacketConsole("info", `perfTrace preference=${perfTrace ? "on" : "off"} runtime=${compactValue(frameTrace?.enabled)} samples=${samples.length} slowCalls=${slowRuntimeCalls.length} thresholdMs=${compactValue(frameTrace?.thresholdMs)}`);
        if (mode === "last" && samples.length > 0) {
          for (const sample of samples.slice(-3)) appendPacketConsole("info", JSON.stringify(sample));
        }
        if (mode === "last" && slowRuntimeCalls.length > 0) {
          for (const sample of slowRuntimeCalls.slice(-5)) appendPacketConsole("info", JSON.stringify(sample));
        }
        return;
      }
      if (mode === "clear") {
        const result = await runConsoleRuntimeAction({ kind: "setPerfTrace", enabled: perfTrace, clear: true });
        appendPacketConsole(result.ok ? "success" : "warning", result.ok ? "Performance trace samples cleared." : result.message);
        return;
      }
      const enabled = parseConsoleBoolean(mode);
      if (enabled === null) {
        appendPacketConsole("warning", "usage: perfTrace true|false|status|last|clear");
        return;
      }
      setPerfTrace(enabled);
      void updateAppPreferencePatch({ perfTrace: enabled }, `Performance trace ${enabled ? "enabled" : "disabled"}.`);
      const result = await runConsoleRuntimeAction({ kind: "setPerfTrace", enabled });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "say" || command === "chat") {
      if (!rest) {
        appendPacketConsole("warning", "usage: say <message>");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "sendChat", message: rest });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "message" || command === "msg" || command === "pm") {
      const target = parts[0] ?? "";
      const message = rest.slice(target.length).trim();
      if (!target || !message) {
        appendPacketConsole("warning", "usage: message <friend-name-or-account-id> <message>");
        return;
      }
      if (!window.shockless) {
        appendPacketConsole("warning", "desktop bridge unavailable for private message");
        return;
      }
      let accountId = Number.parseInt(target, 10);
      const normalizedTarget = target.toLowerCase();
      if (!Number.isInteger(accountId) || accountId <= 0) {
        const runtimeUser = userRows.find((entry) =>
          runtimeUserMatchesLookup(entry, normalizedTarget, target, selectedRuntimeSnapshot?.userState?.sessionUserName),
        );
        const packetUser =
          packetProfileIndex.byName.get(normalizedTarget) ??
          packetProfileIndex.byAccountId.get(target) ??
          packetProfileIndex.users.find((entry) => packetUserMatchesLookup(entry, normalizedTarget, target));
        const friend = packetInfoState.friends.find(
          (entry) => packetFriendMatchesLookup(entry, normalizedTarget, target),
        );
        const request = packetInfoState.friendRequests.find(
          (entry) => packetFriendRequestMatchesLookup(entry, normalizedTarget, target),
        );
        for (const candidate of [runtimeUser?.accountId, packetUser?.accountId, friend?.accountId, request?.accountId]) {
          const resolvedId = Number.parseInt(compactValue(candidate), 10);
          if (Number.isInteger(resolvedId) && resolvedId > 0) {
            accountId = resolvedId;
            break;
          }
        }
      }
      if (!Number.isInteger(accountId) || accountId <= 0) {
        const lookup = await window.shockless.lookupOriginsUser(target);
        const lookupId = Number.parseInt(lookup.id, 10);
        if (Number.isInteger(lookupId) && lookupId > 0) {
          accountId = lookupId;
        } else {
          appendPacketConsole("warning", `message target needs a numeric account id or parsed friend row; lookup id=${lookup.id || "-"}`);
          return;
        }
      }
      await sendSocialToTargets({ action: "message", accountId, recipient: target, message }, "Private message");
      return;
    }
    if (command === "adduser" || command === "friend") {
      const name = rest.trim();
      if (!name) {
        appendPacketConsole("warning", "usage: adduser <habbo-name>");
        return;
      }
      if (!window.shockless) {
        appendPacketConsole("warning", "desktop bridge unavailable for friend request");
        return;
      }
      await sendSocialToTargets({ action: "addUser", name }, `Friend request ${name}`);
      return;
    }
    if (command === "requests" || command === "friendrequests" || command === "refreshrequests") {
      await sendSocialToTargets({ action: "refreshFriendRequests" }, "Refresh friend requests");
      return;
    }
    if (command === "accept" || command === "acceptfriend") {
      const target = rest.trim();
      const request = findPacketFriendRequestForAction(packetInfoState.friendRequests, target);
      if (!request) {
        appendPacketConsole("warning", target ? `friend request not found: ${target}` : "usage: accept <request-name-or-account-id>");
        return;
      }
      const accountId = packetFriendRequestActionId(request);
      if (accountId === null) {
        appendPacketConsole("warning", `friend request ${request.name} has no numeric account id`);
        return;
      }
      await sendSocialToTargets({ action: "acceptRequest", accountId }, `Accept request ${request.name}`);
      return;
    }
    if (command === "decline" || command === "declinefriend") {
      const target = rest.trim();
      const request = findPacketFriendRequestForAction(packetInfoState.friendRequests, target);
      if (!request) {
        appendPacketConsole("warning", target ? `friend request not found: ${target}` : "usage: decline <request-name-or-account-id>");
        return;
      }
      const accountId = packetFriendRequestActionId(request);
      if (accountId === null) {
        appendPacketConsole("warning", `friend request ${request.name} has no numeric account id`);
        return;
      }
      await sendSocialToTargets({ action: "declineRequest", accountId }, `Decline request ${request.name}`);
      return;
    }
    if (command === "follow" || command === "followfriend") {
      const target = rest.trim();
      if (!target) {
        appendPacketConsole("warning", "usage: follow <friend-name-or-account-id>");
        return;
      }
      const friend = findPacketFriendForAction(packetInfoState.friends, target);
      const accountId = parsePositiveSocialAccountId(target) ?? (friend ? packetFriendActionId(friend) : null);
      if (accountId === null) {
        appendPacketConsole("warning", `friend not found with numeric account id: ${target}`);
        return;
      }
      await sendSocialToTargets(
        { action: "followFriend", accountId, name: friend?.name ?? target },
        `Follow friend ${friend?.name ?? target}`,
      );
      return;
    }
    if (command === "removefriend" || command === "unfriend") {
      const target = rest.trim();
      if (!target) {
        appendPacketConsole("warning", "usage: removefriend <friend-name-or-account-id>");
        return;
      }
      const friend = findPacketFriendForAction(packetInfoState.friends, target);
      const accountId = parsePositiveSocialAccountId(target) ?? (friend ? packetFriendActionId(friend) : null);
      if (accountId === null) {
        appendPacketConsole("warning", `friend not found with numeric account id: ${target}`);
        return;
      }
      await sendSocialToTargets(
        { action: "removeFriend", accountId, name: friend?.name ?? target },
        `Remove friend ${friend?.name ?? target}`,
      );
      return;
    }
    if (command === "walk" || command === "stageclick") {
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        appendPacketConsole("warning", "usage: walk <stage-x> <stage-y>");
        return;
      }
      const result = await runConsoleRuntimeAction({ kind: "stageClick", x, y });
      appendPacketConsole(result.ok ? "success" : "warning", result.message);
      return;
    }
    if (command === "room") {
      const snapshot = (await refreshSelectedRuntime()) ?? runtime;
      appendPacketConsole(
        "info",
        `room=${runtimeRoomName(snapshot)} id=${runtimeRoomId(snapshot)} type=${runtimeRoomType(snapshot)} ready=${compactValue(snapshot?.roomReady?.ready ?? snapshot?.roomEntryState?.roomReady?.ready)} users=${compactValue(snapshot?.userState?.roomUserCount ?? snapshot?.roomReady?.roomLikeSpriteCount)}`,
      );
      return;
    }
    if (command === "user") {
      appendPacketConsole(
        "info",
        `user=${selectedUserName} account=${selectedUserAccountId} pos=${selectedUserPosition} figure=${selectedUserFigure}`,
      );
      return;
    }
    if (command === "lookup") {
      const name = rest || selectedUserName;
      if (!name || name === "-") {
        appendPacketConsole("warning", "usage: lookup <habbo-name>");
        return;
      }
      if (!window.shockless) {
        appendPacketConsole("warning", "desktop bridge unavailable for Origins public lookup");
        return;
      }
      const rawToken = name.trim();
      const normalizedToken = rawToken.toLowerCase();
      const snapshot = (await refreshSelectedRuntime()) ?? runtime;
      const runtimeMatches: RuntimeUserSummary[] = [];
      const seenRuntimeUsers = new Set<string>();
      for (const user of [...(snapshot?.userState?.users ?? []), ...(snapshot?.roomObjects?.users ?? [])]) {
        if (!runtimeUserMatchesLookup(user, normalizedToken, rawToken, snapshot?.userState?.sessionUserName)) continue;
        const key = [
          compactValue(user.accountId),
          compactValue(user.roomIndex ?? user.rowId),
          userDisplayName(user, snapshot?.userState?.sessionUserName).toLowerCase(),
        ].join(":");
        if (seenRuntimeUsers.has(key)) continue;
        seenRuntimeUsers.add(key);
        runtimeMatches.push(user);
      }
      const packetMatches: PacketProfileUser[] = [];
      const seenPacketUsers = new Set<string>();
      for (const user of packetProfileIndex.users) {
        if (!packetUserMatchesLookup(user, normalizedToken, rawToken)) continue;
        const key = [compactValue(user.accountId), compactValue(user.index), user.name.toLowerCase()].join(":");
        if (seenPacketUsers.has(key)) continue;
        seenPacketUsers.add(key);
        packetMatches.push(user);
      }
      const friendMatches = packetInfoState.friends.filter((entry) => packetFriendMatchesLookup(entry, normalizedToken, rawToken));
      const requestMatches = packetInfoState.friendRequests.filter((entry) => packetFriendRequestMatchesLookup(entry, normalizedToken, rawToken));
      const localAccountIds = new Set<string>();
      for (const user of runtimeMatches) {
        const accountIdValue = compactValue(user.accountId);
        if (accountIdValue !== "-") localAccountIds.add(accountIdValue);
      }
      for (const user of packetMatches) {
        if (user.accountId !== "-") localAccountIds.add(user.accountId);
      }
      for (const friend of friendMatches) {
        if (friend.accountId !== "-") localAccountIds.add(friend.accountId);
      }
      for (const request of requestMatches) {
        if (request.accountId !== "-") localAccountIds.add(request.accountId);
      }
      for (const user of runtimeMatches.slice(0, 3)) appendPacketConsole("info", runtimeLookupLine(user, snapshot));
      for (const user of packetMatches.slice(-3)) appendPacketConsole("info", packetProfileLookupLine(user));
      for (const friend of friendMatches.slice(0, 3)) {
        appendPacketConsole("info", `friend: ${packetFriendTitle(friend)} / ${packetFriendMeta(friend)} / line=${friend.sourceLine}`);
      }
      for (const request of requestMatches.slice(0, 3)) appendPacketConsole("info", friendRequestLookupLine(request));
      const recentMessages = localAccountIds.size > 0
        ? packetInfoState.privateMessages.filter((entry) => localAccountIds.has(entry.senderAccountId)).slice(-3)
        : [];
      for (const message of recentMessages) {
        appendPacketConsole(
          "info",
          `private message: from=${message.senderAccountId} sent=${compactValue(message.sentAt)} text=${compactValue(message.text)} line=${message.sourceLine}`,
        );
      }
      if (runtimeMatches.length === 0 && packetMatches.length === 0 && friendMatches.length === 0 && requestMatches.length === 0) {
        appendPacketConsole("info", `in-game: no runtime, USERS, friend, or request match for ${rawToken}`);
      }
      const result = await window.shockless.lookupOriginsUser(name);
      appendPacketConsole(result.ok ? "success" : "warning", originsLookupLine(result, name));
      return;
    }
    if (command === "rooms") {
      const opened = await runConsoleRuntimeAction({ kind: "openNavigator", view: "nav_pr" });
      const snapshot = (await refreshSelectedRuntime()) ?? runtime;
      const query = rest.toLowerCase();
      const rooms = (snapshot?.navigator?.publicRoomNodes ?? [])
        .filter((entry) => !query || [entry.name, entry.unitStrId, entry.id, entry.port].some((value) => String(value ?? "").toLowerCase().includes(query)))
        .slice(0, 6);
      if (rooms.length === 0) {
        appendPacketConsole(opened.ok ? "warning" : "error", opened.ok ? "no matching public rooms loaded yet" : opened.message);
        return;
      }
      appendPacketConsole("success", rooms.map((entry) => `${compactValue(entry.name)} id=${compactValue(entry.id)} unit=${compactValue(entry.unitStrId)}`).join(" | "));
      return;
    }
    if (command === "fps" || command === "perf") {
      const snapshot = (await refreshSelectedRuntime()) ?? runtime;
      const stats = snapshot?.performanceStats;
      appendPacketConsole(
        "info",
        `fps=${compactValue(stats?.rafPerSecond ?? stats?.rafRate)} tempo=${compactValue(stats?.frameTempo)} director=${compactValue(stats?.directorTicksPerSecond ?? stats?.directorTickRate)} worstRafMs=${compactValue(finiteNumber(stats?.worstRafDeltaMs))}`,
      );
      if (command === "fps" && parts[0]) {
        appendPacketConsole("warning", "runtime FPS limit changes are not available yet.");
      }
      return;
    }
    if (command === "gpu") {
      const active = appPreferences?.hardwareAccelerationActive ?? true;
      const preferred = appPreferences?.hardwareAcceleration ?? true;
      const switches = appPreferences?.gpuLaunchSwitches.join(", ") || "none";
      const restart = appPreferences?.hardwareAccelerationRestartRequired ? " restart required" : " active";
      appendPacketConsole(
        appPreferences?.hardwareAccelerationRestartRequired ? "warning" : "info",
        `hardwareAcceleration=${active ? "on" : "off"} preference=${preferred ? "on" : "off"} state=${restart} launchSwitches=${switches}`,
      );
      return;
    }

    appendPacketConsole("warning", `unknown command "${command}". type help`);
  }, [
    appendPacketConsole,
    appPreferences,
    applyEngineLaunch,
    applyUserNameLabelRuntime,
    clientSessions?.selectedClientId,
    executeConsoleRendererActions,
    packetConsoleInput,
    packetInfoState.friendRequests,
    packetInfoState.friends,
    packetInfoState.privateMessages,
    packetClientChoices,
    packetProfileIndex,
    refreshRelayLog,
    refreshClientSessions,
    refreshConsoleCommandState,
    refreshSelectedClientSnapshot,
    refreshRuntimeSnapshot,
    runConsoleRuntimeAction,
    sendSocialAction,
    selectedClientIsVisible,
    selectedRuntimeSnapshot,
    selectedUserAccountId,
    selectedUserFigure,
    selectedUserName,
    selectedUserPosition,
    smoothAvatars,
    smoothUi,
    perfTrace,
    visibleActiveAccountNames,
    updateAppPreferencePatch,
    userNameLabelSettings,
    userRows,
  ]);
}
