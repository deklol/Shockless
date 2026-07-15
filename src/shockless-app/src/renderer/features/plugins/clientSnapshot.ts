import type { ClientRuntimeSummary, ClientSessionList, ClientSessionSummary, ClientSnapshot, RelayLogDeltaSnapshot, RelayLogSnapshot } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot } from "../../engineRuntime";
import { relayLogSnapshotForClient } from "../packet-console/relayModel";
import { packetChatEntriesFromEntries } from "../packets/chat";
import { packetFishingStateFromEntries } from "../packets/fishing";
import { packetInfoStateFromEntries } from "../packets/social";
import { packetInventoryStateFromEntries } from "../packets/inventory";
import { packetProfileIndexFromUsers, packetUsersFromEntries } from "../packets/profile";
import { packetActiveObjectStateFromEntries, packetWallItemStateFromEntries } from "../packets/roomObjects";
import {
  emptyPacketActiveObjectState, emptyPacketFishingState, emptyPacketInfoState, emptyPacketInventoryState, emptyPacketWallItemState,
  type ClientPluginSnapshot, type PacketActiveObjectState, type PacketChatEntry, type PacketFishingState, type PacketInfoState,
type PacketInventoryState, type PacketProfileUser, type PacketWallItemState,
} from "../packets/types";

interface ClientPluginPacketCache {
  readonly logPath: string;
  readonly totalLines: number;
  readonly lastSourceLineNumber: number;
  readonly profileUsers: readonly PacketProfileUser[];
  readonly packetInfo: PacketInfoState;
  readonly packetInventory: PacketInventoryState;
  readonly packetWallItems: PacketWallItemState;
  readonly packetActiveObjects: PacketActiveObjectState;
  readonly packetChatEntries: readonly PacketChatEntry[];
  readonly packetFishing: PacketFishingState;
}

const clientPluginPacketCaches = new globalThis.Map<number, ClientPluginPacketCache>();

export function clientPluginSnapshotForClient(options: {
  readonly clientId: number;
  readonly label: string;
  readonly relay: RelayLogSnapshot | null;
  readonly runtime: EngineRuntimeSnapshot | null;
  readonly runtimeSummary: ClientRuntimeSummary | null;
}): ClientPluginSnapshot {
  const cached = clientPluginPacketCaches.get(options.clientId) ?? null;
  const relay = options.relay;
  const latestSourceLine = relay?.entries.reduce((latest, entry) => Math.max(latest, entry.sourceLineNumber), 0) ?? 0;
  const canAppend = Boolean(
    relay &&
    cached &&
    cached.logPath === relay.logPath &&
    cached.totalLines <= relay.totalLines &&
    (latestSourceLine >= cached.lastSourceLineNumber || relay.totalLines === cached.totalLines),
  );
  const previous = canAppend ? cached : null;
  const entries = relay
    ? previous
      ? relay.entries.filter((entry) => entry.sourceLineNumber > previous.lastSourceLineNumber)
      : relay.entries
    : [];
  const appendedUsers = packetUsersFromEntries(entries);
  const packetState: ClientPluginPacketCache = {
    logPath: relay?.logPath ?? `client-${options.clientId}-none`,
    totalLines: relay?.totalLines ?? 0,
    lastSourceLineNumber: entries.reduce(
      (latest, entry) => Math.max(latest, entry.sourceLineNumber),
      previous?.lastSourceLineNumber ?? 0,
    ),
    profileUsers: appendedUsers.length > 0 ? [...(previous?.profileUsers ?? []), ...appendedUsers] : previous?.profileUsers ?? [],
    packetInfo: packetInfoStateFromEntries(entries, 0, previous?.packetInfo ?? emptyPacketInfoState),
    packetInventory: packetInventoryStateFromEntries(entries, 0, previous?.packetInventory ?? emptyPacketInventoryState),
    packetWallItems: packetWallItemStateFromEntries(entries, 0, previous?.packetWallItems ?? emptyPacketWallItemState),
    packetActiveObjects: packetActiveObjectStateFromEntries(entries, 0, previous?.packetActiveObjects ?? emptyPacketActiveObjectState),
    packetChatEntries: entries.length > 0
      ? [...(previous?.packetChatEntries ?? []), ...packetChatEntriesFromEntries(entries)]
      : previous?.packetChatEntries ?? [],
    packetFishing: packetFishingStateFromEntries(entries, 0, previous?.packetFishing ?? emptyPacketFishingState),
  };
  if (relay) clientPluginPacketCaches.set(options.clientId, packetState);
  else clientPluginPacketCaches.delete(options.clientId);
  return {
    clientId: options.clientId,
    label: options.label,
    relay: options.relay,
    runtime: options.runtime,
    runtimeSummary: options.runtimeSummary,
    profileUsers: packetState.profileUsers,
    profileIndex: packetProfileIndexFromUsers(packetState.profileUsers),
    packetInfo: packetState.packetInfo,
    packetInventory: packetState.packetInventory,
    packetWallItems: packetState.packetWallItems,
    packetActiveObjects: packetState.packetActiveObjects,
    packetChatEntries: packetState.packetChatEntries,
    packetFishing: packetState.packetFishing,
    updatedAt: options.runtimeSummary?.updatedAt ?? options.relay?.updatedAt ?? null,
  };
}

export function clientPluginSnapshotMapFromSources(options: {
  readonly relayLog: RelayLogSnapshot | null;
  readonly sessions: readonly ClientSessionSummary[];
  readonly selectedClientId: number;
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly selectedClientSnapshot: ClientSnapshot | null;
}): ReadonlyMap<number, ClientPluginSnapshot> {
  const sessions = options.sessions.length > 0
    ? options.sessions
    : options.selectedClientSnapshot?.client
      ? [options.selectedClientSnapshot.client]
      : [];
  const map = new globalThis.Map<number, ClientPluginSnapshot>();
  for (const session of sessions) {
    const runtimeSummary = options.selectedClientSnapshot?.client?.id === session.id ? options.selectedClientSnapshot.runtime : null;
    map.set(
      session.id,
      clientPluginSnapshotForClient({
        clientId: session.id,
        label: session.label || `client${session.id}`,
        relay: relayLogSnapshotForClient(options.relayLog, session.id),
        runtime: session.id === options.selectedClientId ? options.selectedRuntimeSnapshot : null,
        runtimeSummary,
      }),
    );
  }
  if (!map.has(options.selectedClientId)) {
    const selected = options.selectedClientSnapshot?.client;
    map.set(
      options.selectedClientId,
      clientPluginSnapshotForClient({
        clientId: options.selectedClientId,
        label: selected?.label || `client${options.selectedClientId}`,
        relay: relayLogSnapshotForClient(options.relayLog, options.selectedClientId),
        runtime: options.selectedRuntimeSnapshot,
        runtimeSummary: options.selectedClientSnapshot?.runtime ?? null,
      }),
    );
  }
  return map;
}

export function ingestClientPluginRelaySnapshot(snapshot: RelayLogSnapshot): void {
  const delta = snapshot as RelayLogDeltaSnapshot;
  const changedClientIds = "reset" in snapshot && !delta.reset
    ? new globalThis.Set(snapshot.entries.map((entry) => entry.clientId ?? 1))
    : null;
  for (const client of snapshot.clients) {
    if (changedClientIds && !changedClientIds.has(client.clientId)) continue;
    clientPluginSnapshotForClient({
      clientId: client.clientId,
      label: client.clientLabel || `client${client.clientId}`,
      relay: relayLogSnapshotForClient(snapshot, client.clientId),
      runtime: null,
      runtimeSummary: null,
    });
  }
}

export function mergeClientSummaryIntoList(current: ClientSessionList | null, snapshot: ClientSnapshot): ClientSessionList | null {
  if (!current || !snapshot.client) return current;
  return {
    ...current,
    sessions: current.sessions.map((session) => session.id === snapshot.client?.id ? snapshot.client : session),
  };
}
