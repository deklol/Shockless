import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { runEngineRuntimeAction, type EngineWebviewElement } from "../../engineRuntime";
import { delay } from "../injection/model";
import type { ClientPluginSnapshot, PacketMessengerMessage } from "../packets/types";
import {
  buildDmNotificationPayload,
  dmNotificationKey,
  isLivePrivateMessage,
  senderNameForPrivateMessage,
} from "./dmNotifications";

export interface DmNotificationsContext {
  readonly clientPluginSnapshotList: readonly ClientPluginSnapshot[];
  readonly clientPluginSnapshotsById: ReadonlyMap<number, ClientPluginSnapshot>;
  readonly dmNotificationFlushInFlightRef: MutableRefObject<boolean>;
  readonly dmNotificationInitializedRef: MutableRefObject<boolean>;
  readonly dmNotificationQueueRef: MutableRefObject<Map<number, PacketMessengerMessage[]>>;
  readonly dmNotificationSeenKeysRef: MutableRefObject<Map<number, Set<string>>>;
  readonly engineUrl: string;
  readonly gameWebviewMountEpoch: number;
  readonly gameWebviewRefs: MutableRefObject<Map<number, EngineWebviewElement>>;
  readonly selectedClientId: number;
  readonly selectedClientIsVisible: boolean;
  readonly setSocialMessage: Dispatch<SetStateAction<string>>;
  readonly socialPrivateMessageNotificationsEnabled: boolean;
  readonly webviewRef: MutableRefObject<EngineWebviewElement | null>;
}

export function useDmNotifications(context: DmNotificationsContext): void {
  const {
    clientPluginSnapshotList, clientPluginSnapshotsById, dmNotificationFlushInFlightRef,
    dmNotificationInitializedRef, dmNotificationQueueRef, dmNotificationSeenKeysRef, engineUrl,
    gameWebviewMountEpoch, gameWebviewRefs, selectedClientId, selectedClientIsVisible, setSocialMessage,
    socialPrivateMessageNotificationsEnabled, webviewRef,
  } = context;

useEffect(() => {
    if (!socialPrivateMessageNotificationsEnabled) {
      dmNotificationInitializedRef.current = false;
      dmNotificationSeenKeysRef.current.clear();
      dmNotificationQueueRef.current.clear();
      return;
    }

    const seenForClient = (clientId: number): globalThis.Set<string> => {
      let seen = dmNotificationSeenKeysRef.current.get(clientId);
      if (!seen) {
        seen = new globalThis.Set<string>();
        dmNotificationSeenKeysRef.current.set(clientId, seen);
      }
      return seen;
    };

    if (!dmNotificationInitializedRef.current) {
      for (const snapshot of clientPluginSnapshotList) {
        const seen = seenForClient(snapshot.clientId);
        for (const message of snapshot.packetInfo.privateMessages) {
          seen.add(dmNotificationKey(snapshot.clientId, message));
        }
      }
      dmNotificationInitializedRef.current = true;
      return;
    }

    for (const snapshot of clientPluginSnapshotList) {
      const seen = seenForClient(snapshot.clientId);
      const queue = dmNotificationQueueRef.current.get(snapshot.clientId) ?? [];
      for (const message of snapshot.packetInfo.privateMessages) {
        if (!isLivePrivateMessage(snapshot, message)) continue;
        const key = dmNotificationKey(snapshot.clientId, message);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(message);
      }
      if (queue.length > 0) dmNotificationQueueRef.current.set(snapshot.clientId, queue.slice(-12));
    }
  }, [clientPluginSnapshotList, socialPrivateMessageNotificationsEnabled]);

  useEffect(() => {
    if (!socialPrivateMessageNotificationsEnabled || !selectedClientIsVisible || !engineUrl) return;
    if (dmNotificationFlushInFlightRef.current) return;
    const webview = gameWebviewRefs.current.get(selectedClientId) ?? (selectedClientId === 1 ? webviewRef.current : null);
    if (!webview) return;
    const queued = dmNotificationQueueRef.current.get(selectedClientId) ?? [];
    if (queued.length === 0) return;

    let cancelled = false;
    dmNotificationFlushInFlightRef.current = true;
    dmNotificationQueueRef.current.set(selectedClientId, []);

    const flush = async () => {
      const retry: PacketMessengerMessage[] = [];
      const sourceSnapshot = clientPluginSnapshotsById.get(selectedClientId) ?? null;
      for (let index = 0; index < queued.length; index += 1) {
        const message = queued[index]!;
        if (cancelled) {
          retry.push(...queued.slice(index));
          break;
        }
        const senderName = senderNameForPrivateMessage(message, sourceSnapshot, clientPluginSnapshotList);
        const payload = buildDmNotificationPayload(message, senderName);
        const result = await runEngineRuntimeAction(webview, {
          kind: "showBulletinNotification",
          ...payload,
        });
        if (!result.ok) {
          retry.push(message, ...queued.slice(index + 1));
          setSocialMessage(result.message || "Private message notification could not be shown yet.");
          break;
        }
        setSocialMessage(`Private message notification shown from ${senderName}.`);
        await delay(350);
      }

      if (retry.length > 0) {
        const existing = dmNotificationQueueRef.current.get(selectedClientId) ?? [];
        dmNotificationQueueRef.current.set(selectedClientId, [...retry, ...existing].slice(-12));
      }
      dmNotificationFlushInFlightRef.current = false;
    };

    void flush().catch((error) => {
      const existing = dmNotificationQueueRef.current.get(selectedClientId) ?? [];
      dmNotificationQueueRef.current.set(selectedClientId, [...queued, ...existing].slice(-12));
      dmNotificationFlushInFlightRef.current = false;
      setSocialMessage(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, [
    clientPluginSnapshotList,
    clientPluginSnapshotsById,
    engineUrl,
    gameWebviewMountEpoch,
    selectedClientId,
    selectedClientIsVisible,
    socialPrivateMessageNotificationsEnabled,
  ]);
}
