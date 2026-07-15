import { useEffect, type MutableRefObject } from "react";
import type { PluginDefinition } from "../../../shared/plugin";
import type { ClientSessionList, ClientSessionSummary, FurniMetadataSnapshot, RelayLogSnapshot } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeChatEntry } from "../../engineRuntime";
import { RendererUserPluginHost, type UserPluginHostRequest } from "../../userPluginHost";
import { chatEntryKey } from "../common/model";
import {
  dispatchPluginRoomItemEvent,
  pluginChatPayload,
  pluginRelayPacketPayload,
  pluginRoomKey,
  pluginRoomObjectRecords,
  pluginRoomObjectsPayload,
  pluginRoomPayload,
  pluginRoomUsersPayload,
  pluginRuntimeUserKey,
  pluginRuntimeUserPayload,
  type UserPluginChatCache,
  type UserPluginRoomObjectCache,
  type UserPluginRoomUserCache,
} from "./runtimePayload";

interface PluginPacketCursor {
  readonly logPath: string | null;
  readonly lineNumber: number;
  readonly initialized: boolean;
}

export interface UserPluginEventsContext {
  readonly availablePlugins: readonly PluginDefinition[];
  readonly chatHistory: readonly RuntimeChatEntry[];
  readonly clientSessions: ClientSessionList | null;
  readonly furniMetadata: FurniMetadataSnapshot | null;
  readonly pluginEnabledById: Readonly<Record<string, boolean>>;
  readonly relayLog: RelayLogSnapshot | null;
  readonly roomReady: boolean;
  readonly selectedClientId: number;
  readonly selectedClientSession: ClientSessionSummary | null;
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly userPluginChatRef: MutableRefObject<UserPluginChatCache | null>;
  readonly userPluginHostRef: MutableRefObject<RendererUserPluginHost | null>;
  readonly userPluginLogHandlerRef: MutableRefObject<(plugin: PluginDefinition, level: "info" | "warning" | "error", message: string) => void>;
  readonly userPluginPacketCursorRef: MutableRefObject<PluginPacketCursor>;
  readonly userPluginRequestHandlerRef: MutableRefObject<(plugin: PluginDefinition, request: UserPluginHostRequest) => Promise<unknown>>;
  readonly userPluginRoomObjectsRef: MutableRefObject<UserPluginRoomObjectCache | null>;
  readonly userPluginRoomUsersRef: MutableRefObject<UserPluginRoomUserCache | null>;
}

export function useUserPluginEvents(context: UserPluginEventsContext): void {
  const {
    availablePlugins, chatHistory, clientSessions, furniMetadata, pluginEnabledById, relayLog, roomReady,
    selectedClientId, selectedClientSession, selectedRuntimeSnapshot, userPluginChatRef, userPluginHostRef,
    userPluginLogHandlerRef, userPluginPacketCursorRef, userPluginRequestHandlerRef, userPluginRoomObjectsRef,
    userPluginRoomUsersRef,
  } = context;

useEffect(() => {
    if (!window.shockless?.readPluginEntrySource) return undefined;
    const host = new RendererUserPluginHost({
      readEntrySource: (pluginId) => window.shockless!.readPluginEntrySource(pluginId),
      handleRequest: (plugin, request) => userPluginRequestHandlerRef.current(plugin, request),
      log: (plugin, level, message) => userPluginLogHandlerRef.current(plugin, level, message),
    });
    userPluginHostRef.current = host;
    return () => {
      host.dispose();
      if (userPluginHostRef.current === host) userPluginHostRef.current = null;
    };
  }, []);

  useEffect(() => {
    userPluginHostRef.current?.sync(availablePlugins, pluginEnabledById);
  }, [availablePlugins, pluginEnabledById]);

  useEffect(() => {
    userPluginHostRef.current?.dispatchEvent("session.selected", {
      clientId: selectedClientId,
      session: selectedClientSession,
      mainClientId: clientSessions?.mainClientId ?? 1,
    });
  }, [clientSessions?.mainClientId, selectedClientId, selectedClientSession]);

  useEffect(() => {
    if (!selectedRuntimeSnapshot) return;
    userPluginHostRef.current?.dispatchEvent("runtime.snapshot", {
      clientId: selectedClientId,
      room: pluginRoomPayload(selectedRuntimeSnapshot),
      snapshot: selectedRuntimeSnapshot,
    });
  }, [selectedClientId, selectedRuntimeSnapshot]);

  useEffect(() => {
    const host = userPluginHostRef.current;
    const snapshot = selectedRuntimeSnapshot;
    const currentRoomKey = pluginRoomKey(snapshot);
    if (!host || !snapshot || !roomReady || !currentRoomKey) {
      userPluginRoomUsersRef.current = null;
      return;
    }
    const sessionName = snapshot.userState?.sessionUserName ?? null;
    const usersByKey = new globalThis.Map<string, ReturnType<typeof pluginRuntimeUserPayload>>();
    for (const user of snapshot.userState?.users ?? []) {
      usersByKey.set(pluginRuntimeUserKey(user, sessionName), pluginRuntimeUserPayload(user, sessionName));
    }
    const room = pluginRoomPayload(snapshot);
    const previous = userPluginRoomUsersRef.current;
    if (!previous || previous.roomKey !== currentRoomKey) {
      userPluginRoomUsersRef.current = { roomKey: currentRoomKey, usersByKey };
      host.dispatchEvent("room.changed", { clientId: selectedClientId, room });
      host.dispatchEvent("room.ready", { clientId: selectedClientId, room });
      host.dispatchEvent("room.users", { ...pluginRoomUsersPayload(snapshot, selectedClientId), initial: true });
      return;
    }
    for (const [key, user] of usersByKey) {
      if (previous.usersByKey.has(key)) continue;
      host.dispatchEvent("room.userJoined", { clientId: selectedClientId, room, user, initial: false });
    }
    for (const [key, user] of previous.usersByKey) {
      if (usersByKey.has(key)) continue;
      host.dispatchEvent("room.userLeft", { clientId: selectedClientId, room, user });
    }
    userPluginRoomUsersRef.current = { roomKey: currentRoomKey, usersByKey };
  }, [roomReady, selectedClientId, selectedRuntimeSnapshot]);

  useEffect(() => {
    const host = userPluginHostRef.current;
    const snapshot = selectedRuntimeSnapshot;
    const currentRoomKey = pluginRoomKey(snapshot);
    if (!host || !snapshot || !roomReady || !currentRoomKey) {
      userPluginRoomObjectsRef.current = null;
      return;
    }

    const room = pluginRoomPayload(snapshot);
    const itemsByKey = pluginRoomObjectRecords(snapshot, furniMetadata);
    const objectPayload = pluginRoomObjectsPayload(snapshot, selectedClientId, furniMetadata);
    const previous = userPluginRoomObjectsRef.current;
    if (!previous || previous.roomKey !== currentRoomKey) {
      userPluginRoomObjectsRef.current = { roomKey: currentRoomKey, itemsByKey };
      host.dispatchEvent("room.items", { ...objectPayload, initial: true });
      host.dispatchEvent("room.floorItemsLoaded", {
        clientId: selectedClientId,
        room,
        items: objectPayload.floorItems,
        floorItems: objectPayload.floorItems,
        initial: true,
      });
      host.dispatchEvent("room.wallItemsLoaded", {
        clientId: selectedClientId,
        room,
        items: objectPayload.wallItems,
        wallItems: objectPayload.wallItems,
        initial: true,
      });
      return;
    }

    let changed = false;
    for (const [key, record] of itemsByKey) {
      const previousRecord = previous.itemsByKey.get(key);
      if (!previousRecord) {
        changed = true;
        dispatchPluginRoomItemEvent(host, "Added", selectedClientId, room, record.payload);
        continue;
      }
      if (previousRecord.signature !== record.signature) {
        changed = true;
        dispatchPluginRoomItemEvent(host, "Updated", selectedClientId, room, record.payload, previousRecord.payload);
      }
    }
    for (const [key, previousRecord] of previous.itemsByKey) {
      if (itemsByKey.has(key)) continue;
      changed = true;
      dispatchPluginRoomItemEvent(host, "Removed", selectedClientId, room, previousRecord.payload);
    }
    if (changed) {
      host.dispatchEvent("room.items", { ...objectPayload, initial: false });
    }
    userPluginRoomObjectsRef.current = { roomKey: currentRoomKey, itemsByKey };
  }, [furniMetadata, roomReady, selectedClientId, selectedRuntimeSnapshot]);

  useEffect(() => {
    const host = userPluginHostRef.current;
    const snapshot = selectedRuntimeSnapshot;
    const currentRoomKey = pluginRoomKey(snapshot);
    if (!host || !snapshot || !currentRoomKey) {
      userPluginChatRef.current = null;
      return;
    }
    const room = pluginRoomPayload(snapshot);
    const entriesByKey = new globalThis.Map<string, RuntimeChatEntry>();
    for (let index = 0; index < chatHistory.length; index += 1) {
      const entry = chatHistory[index]!;
      entriesByKey.set(chatEntryKey(entry, index), entry);
    }
    const previous = userPluginChatRef.current;
    if (!previous || previous.roomKey !== currentRoomKey) {
      userPluginChatRef.current = { roomKey: currentRoomKey, keys: new globalThis.Set(entriesByKey.keys()) };
      return;
    }
    for (const [key, entry] of entriesByKey) {
      if (previous.keys.has(key)) continue;
      host.dispatchEvent("chat.message", pluginChatPayload(entry, selectedClientId, room));
    }
    userPluginChatRef.current = { roomKey: currentRoomKey, keys: new globalThis.Set(entriesByKey.keys()) };
  }, [chatHistory, selectedClientId, selectedRuntimeSnapshot]);

  useEffect(() => {
    const host = userPluginHostRef.current;
    if (!host || !relayLog) return;
    const cursor = userPluginPacketCursorRef.current;
    if (!cursor.initialized || cursor.logPath !== relayLog.logPath) {
      userPluginPacketCursorRef.current = {
        logPath: relayLog.logPath,
        lineNumber: relayLog.totalLines,
        initialized: true,
      };
      return;
    }
    let nextLineNumber = cursor.lineNumber;
    for (const entry of relayLog.entries) {
      if (entry.lineNumber <= cursor.lineNumber || entry.header === null) continue;
      nextLineNumber = Math.max(nextLineNumber, entry.lineNumber);
      const packet = pluginRelayPacketPayload(entry, relayLog.updatedAt);
      host.dispatchEvent("packet", packet);
      if (packet.direction === "client" || packet.direction === "server") {
        host.dispatchEvent(`packet.${packet.direction}`, packet);
      }
    }
    if (nextLineNumber !== cursor.lineNumber) {
      userPluginPacketCursorRef.current = {
        logPath: relayLog.logPath,
        lineNumber: nextLineNumber,
        initialized: true,
      };
    }
  }, [relayLog]);
}
