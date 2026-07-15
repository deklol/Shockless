import type { RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import { compactValue, lookupTokenMatches } from "../common/model";
import { packetFieldMap, parsedCount } from "./fields";
import {
  emptyPacketInfoState,
  type PacketFriendRequest,
  type PacketInfoFriend,
  type PacketInfoState,
  type PacketMessengerMessage,
} from "./types";

export function packetInfoStateFromEntries(
  entries: readonly RelayLogEntry[],
  startIndex = 0,
  initialState: PacketInfoState = emptyPacketInfoState,
): PacketInfoState {
  const friendsByKey = new globalThis.Map<string, PacketInfoFriend>();
  for (const friend of initialState.friends) {
    friendsByKey.set(packetFriendKey(friend), friend);
  }
  const privateMessagesByKey = new globalThis.Map<string, PacketMessengerMessage>();
  for (const message of initialState.privateMessages) {
    privateMessagesByKey.set(packetPrivateMessageKey(message), message);
  }
  const friendRequestsByKey = new globalThis.Map<string, PacketFriendRequest>();
  for (const request of initialState.friendRequests) {
    friendRequestsByKey.set(packetFriendRequestKey(request), request);
  }
  let badges = [...initialState.badges];
  let activeBadgeSlot = initialState.activeBadgeSlot;
  let activeBadgeCode = initialState.activeBadgeCode;
  let preferences = [...initialState.preferences];
  let statusEffects = [...initialState.statusEffects];
  let messengerMessage = initialState.messengerMessage;
  let messengerUserLimit = initialState.messengerUserLimit;
  let messengerRequestCount = initialState.messengerRequestCount;
  let messengerRequestPendingCount = initialState.messengerRequestPendingCount;
  let messengerMessageCount = initialState.messengerMessageCount;
  let messengerUnreadMessageCount = initialState.messengerUnreadMessageCount;

  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER") continue;
    const fields = packetFieldMap(entry);
    if (entry.header === 12) {
      const count = parsedCount(fields.get("messengerFriendCount"));
      if (count !== null) {
        friendsByKey.clear();
        addPacketFriendsFromPrefix(friendsByKey, fields, "friend", count, entry.lineNumber);
      }
      messengerMessage = compactValue(fields.get("messenger persistentMessage"));
      messengerUserLimit = compactValue(fields.get("messenger userLimit"));
      messengerRequestCount = compactValue(fields.get("messenger requestCount"));
      messengerMessageCount = compactValue(fields.get("messenger messageCount"));
    } else if (entry.header === 13) {
      const count = parsedCount(fields.get("friendUpdateCount"));
      if (count !== null) addPacketFriendsFromPrefix(friendsByKey, fields, "friendUpdate", count, entry.lineNumber);
    } else if (entry.header === 137) {
      const friend = packetFriendFromPrefix(fields, "friendAdded", entry.lineNumber);
      if (friend) friendsByKey.set(packetFriendKey(friend), friend);
    } else if (entry.header === 132) {
      const count = parsedCount(fields.get("friendRequestCount"));
      if (count !== null) {
        addPacketFriendRequestsFromPrefix(friendRequestsByKey, fields, "friendRequest", count, entry.lineNumber);
        messengerRequestCount = String(friendRequestsByKey.size);
        messengerRequestPendingCount = compactValue(fields.get("friendRequestPendingCount"));
      }
    } else if (entry.header === 134) {
      const count = parsedCount(fields.get("privateMessageCount"));
      if (count !== null) {
        addPacketPrivateMessagesFromPrefix(privateMessagesByKey, fields, "privateMessage", count, entry.lineNumber);
        messengerMessageCount = String(privateMessagesByKey.size);
        messengerUnreadMessageCount = compactValue(fields.get("privateMessageUnreadCount"));
      }
    } else if (entry.header === 362) {
      const count = parsedCount(fields.get("highlightFriendCount"));
      if (count !== null) addPacketFriendsFromPrefix(friendsByKey, fields, "highlightFriend", count, entry.lineNumber);
    } else if (entry.header === 229) {
      const count = parsedCount(fields.get("badgeCount"));
      if (count !== null) {
        badges = [];
        for (let row = 1; row <= count; row += 1) {
          const badge = compactValue(fields.get(`badge ${row} code`));
          if (badge !== "-") badges.push(badge);
        }
      }
    } else if (entry.header === 228) {
      activeBadgeSlot = compactValue(fields.get("activeBadgeSlot"));
      activeBadgeCode = compactValue(fields.get("activeBadgeCode"));
    } else if (entry.header === 308) {
      const count = parsedCount(fields.get("accountPreferenceCount"));
      if (count !== null) {
        preferences = [];
        for (let row = 1; row <= count; row += 1) {
          const preference = compactValue(fields.get(`accountPreference ${row}`));
          if (preference !== "-") preferences.push(preference);
        }
      }
    } else if (entry.header === 1242) {
      const count = parsedCount(fields.get("statusEffectCount"));
      if (count !== null) {
        statusEffects = [];
        for (let row = 1; row <= count; row += 1) {
          const name = compactValue(fields.get(`statusEffect ${row} name`));
          if (name === "-") continue;
          statusEffects.push({
            name,
            value: compactValue(fields.get(`statusEffect ${row} value`)),
            sourceLine: entry.lineNumber,
          });
        }
      }
    } else if (entry.header === 313) {
      const count = parsedCount(fields.get("privateMessageCount"));
      if (count !== null) {
        privateMessagesByKey.clear();
        addPacketPrivateMessagesFromPrefix(privateMessagesByKey, fields, "privateMessage", count, entry.lineNumber);
        messengerMessageCount = String(count);
        messengerUnreadMessageCount = compactValue(fields.get("privateMessageUnreadCount"));
      }
    } else if (entry.header === 314) {
      const count = parsedCount(fields.get("friendRequestCount"));
      if (count !== null) {
        friendRequestsByKey.clear();
        addPacketFriendRequestsFromPrefix(friendRequestsByKey, fields, "friendRequest", count, entry.lineNumber);
        messengerRequestCount = String(count);
        messengerRequestPendingCount = compactValue(fields.get("friendRequestPendingCount"));
      }
    }
  }

  return {
    friends: [...friendsByKey.values()].sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return left.name.localeCompare(right.name);
    }),
    badges,
    activeBadgeSlot,
    activeBadgeCode,
    preferences,
    statusEffects,
    privateMessages: [...privateMessagesByKey.values()],
    friendRequests: [...friendRequestsByKey.values()],
    messengerMessage,
    messengerUserLimit,
    messengerRequestCount,
    messengerRequestPendingCount,
    messengerMessageCount,
    messengerUnreadMessageCount,
  };
}

export let packetInfoStateCache:
  | {
      readonly logPath: string;
      readonly entryCount: number;
      readonly totalLines: number;
      readonly state: PacketInfoState;
    }
  | null = null;

export function packetInfoStateFromRelayLog(snapshot: RelayLogSnapshot | null): PacketInfoState {
  if (!snapshot || snapshot.entries.length === 0) {
    packetInfoStateCache = null;
    return emptyPacketInfoState;
  }
  if (
    packetInfoStateCache &&
    packetInfoStateCache.logPath === snapshot.logPath &&
    packetInfoStateCache.entryCount <= snapshot.entries.length &&
    packetInfoStateCache.totalLines <= snapshot.totalLines
  ) {
    const state = packetInfoStateFromEntries(snapshot.entries, packetInfoStateCache.entryCount, packetInfoStateCache.state);
    packetInfoStateCache = {
      logPath: snapshot.logPath,
      entryCount: snapshot.entries.length,
      totalLines: snapshot.totalLines,
      state,
    };
    return state;
  }
  const state = packetInfoStateFromEntries(snapshot.entries);
  packetInfoStateCache = {
    logPath: snapshot.logPath,
    entryCount: snapshot.entries.length,
    totalLines: snapshot.totalLines,
    state,
  };
  return state;
}

export function addPacketFriendsFromPrefix(
  friendsByKey: globalThis.Map<string, PacketInfoFriend>,
  fields: ReadonlyMap<string, string>,
  prefix: string,
  count: number,
  sourceLine: number,
): void {
  for (let row = 1; row <= count; row += 1) {
    const friend = packetFriendFromPrefix(fields, `${prefix} ${row}`, sourceLine);
    if (friend) friendsByKey.set(packetFriendKey(friend), friend);
  }
}

export function addPacketPrivateMessagesFromPrefix(
  messagesByKey: globalThis.Map<string, PacketMessengerMessage>,
  fields: ReadonlyMap<string, string>,
  prefix: string,
  count: number,
  sourceLine: number,
): void {
  for (let row = 1; row <= count; row += 1) {
    const message = packetPrivateMessageFromPrefix(fields, `${prefix} ${row}`, sourceLine);
    if (message) messagesByKey.set(packetPrivateMessageKey(message), message);
  }
}

export function addPacketFriendRequestsFromPrefix(
  requestsByKey: globalThis.Map<string, PacketFriendRequest>,
  fields: ReadonlyMap<string, string>,
  prefix: string,
  count: number,
  sourceLine: number,
): void {
  for (let row = 1; row <= count; row += 1) {
    const request = packetFriendRequestFromPrefix(fields, `${prefix} ${row}`, sourceLine);
    if (request) requestsByKey.set(packetFriendRequestKey(request), request);
  }
}

export function packetFriendFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketInfoFriend | null {
  const accountId = compactValue(fields.get(`${prefix} accountId`));
  const name = compactValue(fields.get(`${prefix} name`));
  if (accountId === "-" && name === "-") return null;
  return {
    accountId,
    name,
    gender: compactValue(fields.get(`${prefix} gender`)),
    motto: compactValue(fields.get(`${prefix} motto`)),
    online: fields.get(`${prefix} online`) === "true",
    canFollow: fields.get(`${prefix} canFollow`) === "true",
    location: compactValue(fields.get(`${prefix} location`)),
    lastAccess: compactValue(fields.get(`${prefix} lastAccess`)),
    figure: compactValue(fields.get(`${prefix} figure`)),
    categoryId: compactValue(fields.get(`${prefix} categoryId`)),
    sourceLine,
  };
}

export function packetPrivateMessageFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketMessengerMessage | null {
  const id = compactValue(fields.get(`${prefix} id`));
  const text = compactValue(fields.get(`${prefix} text`));
  if (id === "-" && text === "-") return null;
  const message: PacketMessengerMessage = {
    key: "",
    id,
    senderAccountId: compactValue(fields.get(`${prefix} senderAccountId`)),
    sentAt: compactValue(fields.get(`${prefix} sentAt`)),
    text,
    sourceLine,
  };
  return { ...message, key: packetPrivateMessageKey(message) };
}

export function packetFriendRequestFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketFriendRequest | null {
  const accountId = compactValue(fields.get(`${prefix} accountId`));
  const name = compactValue(fields.get(`${prefix} name`));
  if (accountId === "-" && name === "-") return null;
  const request: PacketFriendRequest = {
    key: "",
    accountId,
    name,
    requestId: compactValue(fields.get(`${prefix} requestId`)),
    sourceLine,
  };
  return { ...request, key: packetFriendRequestKey(request) };
}

export function packetFriendKey(friend: PacketInfoFriend): string {
  if (friend.accountId !== "-") return `id:${friend.accountId}`;
  return `name:${friend.name.trim().toLowerCase()}`;
}

export function packetPrivateMessageKey(message: PacketMessengerMessage): string {
  if (message.id !== "-") return `id:${message.id}`;
  return `${message.senderAccountId}:${message.sentAt}:${message.text}`.trim().toLowerCase();
}

export function packetFriendRequestKey(request: PacketFriendRequest): string {
  if (request.requestId !== "-") return `request:${request.requestId}`;
  if (request.accountId !== "-") return `account:${request.accountId}`;
  return `name:${request.name.trim().toLowerCase()}`;
}

export function packetFriendSearchText(friend: PacketInfoFriend): string {
  return [
    friend.accountId,
    friend.name,
    friend.motto,
    friend.online ? "online" : "offline",
    friend.canFollow ? "follow" : "",
    friend.location,
    friend.lastAccess,
    friend.figure,
    friend.categoryId,
  ]
    .join(" ")
    .toLowerCase();
}

export function packetFriendMeta(friend: PacketInfoFriend): string {
  const parts = [
    friend.online ? "online" : "offline",
    friend.canFollow ? "follow" : "",
    friend.location !== "-" ? friend.location : "",
    friend.lastAccess !== "-" ? `last ${friend.lastAccess}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "-";
}

export function packetFriendTitle(friend: PacketInfoFriend): string {
  const id = friend.accountId !== "-" ? `#${friend.accountId}` : "";
  return [friend.name, id, friend.motto !== "-" ? friend.motto : ""].filter(Boolean).join(" / ") || "-";
}

export function packetFriendMatchesLookup(friend: PacketInfoFriend, normalizedToken: string, rawToken: string): boolean {
  return lookupTokenMatches([friend.name, friend.accountId], normalizedToken, rawToken);
}

export function packetFriendRequestMatchesLookup(request: PacketFriendRequest, normalizedToken: string, rawToken: string): boolean {
  return lookupTokenMatches([request.name, request.accountId, request.requestId], normalizedToken, rawToken);
}

export function parsePositiveSocialAccountId(value: unknown): number | null {
  const accountId = Number.parseInt(compactValue(value), 10);
  return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
}

export function packetFriendActionId(friend: PacketInfoFriend): number | null {
  return parsePositiveSocialAccountId(friend.accountId);
}

export function packetFriendRequestActionId(request: PacketFriendRequest): number | null {
  return parsePositiveSocialAccountId(request.accountId) ?? parsePositiveSocialAccountId(request.requestId);
}

export function findPacketFriendForAction(friends: readonly PacketInfoFriend[], target: string): PacketInfoFriend | undefined {
  const rawToken = target.trim();
  if (!rawToken) return undefined;
  const normalizedToken = rawToken.toLowerCase();
  return friends.find((entry) => packetFriendMatchesLookup(entry, normalizedToken, rawToken));
}

export function findPacketFriendRequestForAction(requests: readonly PacketFriendRequest[], target: string): PacketFriendRequest | undefined {
  const rawToken = target.trim();
  if (!rawToken) return requests.length === 1 ? requests[0] : undefined;
  const normalizedToken = rawToken.toLowerCase();
  return requests.find((entry) => packetFriendRequestMatchesLookup(entry, normalizedToken, rawToken));
}

export function friendRequestLookupLine(request: PacketFriendRequest): string {
  return [
    "friend request:",
    `name=${compactValue(request.name)}`,
    `account=${compactValue(request.accountId)}`,
    `request=${compactValue(request.requestId)}`,
    `line=${request.sourceLine}`,
  ].join(" ");
}
