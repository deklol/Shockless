import type { RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import type { RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, lookupTokenMatches, userDisplayName } from "../common/model";
import { packetFieldMap } from "./fields";
import { emptyPacketProfileIndex, type PacketProfileIndex, type PacketProfileUser } from "./types";

export function packetUsersFromEntries(entries: readonly RelayLogEntry[], startIndex = 0): readonly PacketProfileUser[] {
  const users: PacketProfileUser[] = [];
  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER" || entry.header !== 28) continue;
    const fields = packetFieldMap(entry);
    const count = Number(fields.get("userCount") ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    for (let row = 1; row <= count; row += 1) {
      const name = compactValue(fields.get(`user ${row} name`));
      if (name === "-") continue;
      users.push({
        name,
        accountId: compactValue(fields.get(`user ${row} accountId`)),
        index: compactValue(fields.get(`user ${row} index`)),
        gender: compactValue(fields.get(`user ${row} gender`)),
        motto: compactValue(fields.get(`user ${row} motto`)),
        figure: compactValue(fields.get(`user ${row} figure`)),
        poolFigure: compactValue(fields.get(`user ${row} poolFigure`)),
        badgeCode: compactValue(fields.get(`user ${row} badge`)),
        userType: compactValue(fields.get(`user ${row} type`)),
        position: compactValue(fields.get(`user ${row} position`)),
        sourceLine: entry.lineNumber,
      });
    }
  }
  return users;
}

export let packetProfileUserCache:
  | {
      readonly logPath: string;
      readonly entryCount: number;
      readonly totalLines: number;
      readonly users: readonly PacketProfileUser[];
    }
  | null = null;

export function packetUsersFromRelayLog(snapshot: RelayLogSnapshot | null): readonly PacketProfileUser[] {
  if (!snapshot || snapshot.entries.length === 0) {
    packetProfileUserCache = null;
    return [];
  }
  if (
    packetProfileUserCache &&
    packetProfileUserCache.logPath === snapshot.logPath &&
    packetProfileUserCache.entryCount <= snapshot.entries.length &&
    packetProfileUserCache.totalLines <= snapshot.totalLines
  ) {
    const appendedUsers = packetUsersFromEntries(snapshot.entries, packetProfileUserCache.entryCount);
    const users = appendedUsers.length > 0 ? [...packetProfileUserCache.users, ...appendedUsers] : packetProfileUserCache.users;
    packetProfileUserCache = {
      logPath: snapshot.logPath,
      entryCount: snapshot.entries.length,
      totalLines: snapshot.totalLines,
      users,
    };
    return users;
  }
  const users = packetUsersFromEntries(snapshot.entries);
  packetProfileUserCache = {
    logPath: snapshot.logPath,
    entryCount: snapshot.entries.length,
    totalLines: snapshot.totalLines,
    users,
  };
  return users;
}

export function packetUserMatchesLookup(user: PacketProfileUser, normalizedToken: string, rawToken: string): boolean {
  return lookupTokenMatches([user.name, user.accountId, user.index], normalizedToken, rawToken);
}

export function packetProfileLookupLine(user: PacketProfileUser): string {
  return [
    "in-game packet USERS:",
    `name=${compactValue(user.name)}`,
    `account=${compactValue(user.accountId)}`,
    `index=${compactValue(user.index)}`,
    `pos=${compactValue(user.position)}`,
    `motto=${compactValue(user.motto)}`,
    `figure=${compactValue(user.figure)}`,
    `badge=${compactValue(user.badgeCode)}`,
    `line=${user.sourceLine}`,
  ].join(" ");
}

export function packetProfileIndexFromUsers(users: readonly PacketProfileUser[]): PacketProfileIndex {
  if (users.length === 0) return emptyPacketProfileIndex;
  const byAccountId = new globalThis.Map<string, PacketProfileUser>();
  const byName = new globalThis.Map<string, PacketProfileUser>();
  const byIndex = new globalThis.Map<string, PacketProfileUser>();
  for (const user of users) {
    const accountId = compactValue(user.accountId);
    if (accountId !== "-") byAccountId.set(accountId, user);
    const name = user.name.trim().toLowerCase();
    if (name && name !== "-") byName.set(name, user);
    const index = compactValue(user.index);
    if (index !== "-") byIndex.set(index, user);
  }
  return { users, byAccountId, byName, byIndex };
}

export function selectPacketProfileUser(
  packetIndex: PacketProfileIndex,
  selectedName: string,
  selectedUser: RuntimeUserSummary | null,
): PacketProfileUser | null {
  if (packetIndex.users.length === 0) return null;
  const normalizedName = selectedName.trim().toLowerCase();
  const selectedAccountId = compactValue(selectedUser?.accountId);
  const selectedIndex = compactValue(selectedUser?.roomIndex ?? selectedUser?.rowId);
  if (selectedAccountId !== "-") {
    const match = packetIndex.byAccountId.get(selectedAccountId);
    if (match) return match;
  }
  if (normalizedName && normalizedName !== "-") {
    const match = packetIndex.byName.get(normalizedName);
    if (match) return match;
  }
  if (selectedIndex !== "-") {
    const match = packetIndex.byIndex.get(selectedIndex);
    if (match) return match;
  }
  return packetIndex.users[packetIndex.users.length - 1] ?? null;
}

export function packetProfileForRuntimeUser(packetIndex: PacketProfileIndex, user: RuntimeUserSummary, sessionName?: string | null): PacketProfileUser | null {
  const name = userDisplayName(user, sessionName).trim().toLowerCase();
  const accountId = compactValue(user.accountId);
  const index = compactValue(user.roomIndex ?? user.rowId);
  if (accountId !== "-") {
    const match = packetIndex.byAccountId.get(accountId);
    if (match) return match;
  }
  if (name && name !== "-") {
    const match = packetIndex.byName.get(name);
    if (match) return match;
  }
  if (index !== "-") {
    const match = packetIndex.byIndex.get(index);
    if (match) return match;
  }
  return null;
}

export function latestPacketVisitorUsers(packetUsers: readonly PacketProfileUser[]): readonly PacketProfileUser[] {
  const byKey = new globalThis.Map<string, PacketProfileUser>();
  for (const user of packetUsers) {
    if (compactValue(user.userType) !== "1") continue;
    const accountId = compactValue(user.accountId);
    const key = accountId !== "-" ? `id:${accountId}` : `name:${user.name.trim().toLowerCase()}`;
    byKey.set(key, user);
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
}
