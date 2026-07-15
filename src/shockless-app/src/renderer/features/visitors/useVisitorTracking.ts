import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { EngineRuntimeSnapshot } from "../../engineRuntime";
import { compactValue } from "../common/model";
import { latestPacketVisitorUsers, packetProfileForRuntimeUser } from "../packets/profile";
import type { PacketProfileIndex, PacketProfileUser } from "../packets/types";
import {
  emptyVisitorState,
  isVisitorUser,
  visitorEntryFor,
  visitorEntryForPacketUser,
  visitorKeyFor,
  type VisitorEntry,
  type VisitorTrackerState,
} from "./model";

interface UseVisitorTrackingOptions {
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly packetProfileIndex: PacketProfileIndex;
  readonly packetProfileUsers: readonly PacketProfileUser[];
  readonly roomReady: boolean;
  readonly visitorRoomKey: string;
  readonly setVisitorState: Dispatch<SetStateAction<VisitorTrackerState>>;
}

/** Reconciles live runtime users and packet-derived visitors for the active room. */
export function useVisitorTracking(options: UseVisitorTrackingOptions): void {
  useEffect(() => {
    const sourceUsers = options.selectedRuntimeSnapshot?.userState?.users ?? [];
    const sessionUserName = options.selectedRuntimeSnapshot?.userState?.sessionUserName;
    const packetVisitors = latestPacketVisitorUsers(options.packetProfileUsers);
    options.setVisitorState((current) => {
      if (!options.roomReady || !options.visitorRoomKey) {
        if (current.roomKey === "" && Object.keys(current.entries).length === 0) return current;
        return emptyVisitorState;
      }

      const sameRoom = current.roomKey === options.visitorRoomKey;
      const previousActive = sameRoom ? new Set(current.activeKeys) : new Set<string>();
      const nextActive = new Set<string>();
      const nextEntries: Record<string, VisitorEntry> = sameRoom ? { ...current.entries } : {};
      const now = new Date().toLocaleTimeString();
      const matchedPacketKeys = new Set<string>();

      for (const user of sourceUsers.filter(isVisitorUser)) {
        const packetUser = packetProfileForRuntimeUser(options.packetProfileIndex, user, sessionUserName);
        if (packetUser) {
          const packetAccountId = compactValue(packetUser.accountId);
          matchedPacketKeys.add(packetAccountId !== "-" ? `id:${packetAccountId}` : `name:${packetUser.name.trim().toLowerCase()}`);
        }
        const key = visitorKeyFor(user, sessionUserName, packetUser);
        nextActive.add(key);
        const previous = nextEntries[key];
        const reentered = Boolean(previous) && !previousActive.has(key);
        nextEntries[key] = {
          ...visitorEntryFor(user, sessionUserName, now, previous, packetUser),
          visits: previous ? previous.visits + (reentered ? 1 : 0) : 1,
          entered: previous && !reentered ? previous.entered : now,
        };
      }

      for (const packetUser of packetVisitors) {
        const packetAccountId = compactValue(packetUser.accountId);
        const packetKey = packetAccountId !== "-" ? `id:${packetAccountId}` : `name:${packetUser.name.trim().toLowerCase()}`;
        if (matchedPacketKeys.has(packetKey)) continue;
        nextActive.add(packetKey);
        const previous = nextEntries[packetKey];
        const reentered = Boolean(previous) && !previousActive.has(packetKey);
        nextEntries[packetKey] = {
          ...visitorEntryForPacketUser(packetUser, now, previous),
          visits: previous ? previous.visits + (reentered ? 1 : 0) : 1,
          entered: previous && !reentered ? previous.entered : now,
        };
      }

      for (const key of previousActive) {
        if (!nextActive.has(key) && nextEntries[key]?.current) {
          nextEntries[key] = {
            ...nextEntries[key],
            current: false,
            left: now,
          };
        }
      }

      return {
        roomKey: options.visitorRoomKey,
        activeKeys: [...nextActive],
        entries: nextEntries,
      };
    });
  }, [
    options.packetProfileIndex,
    options.packetProfileUsers,
    options.roomReady,
    options.selectedRuntimeSnapshot?.userState?.sessionUserName,
    options.selectedRuntimeSnapshot?.userState?.users,
    options.setVisitorState,
    options.visitorRoomKey,
  ]);
}
