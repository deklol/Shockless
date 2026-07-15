import type { RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import type { RuntimeChatEntry, RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, userDisplayName } from "../common/model";
import { packetFieldMap } from "./fields";
import type { PacketChatEntry, PacketProfileIndex } from "./types";

export function packetChatEntriesFromEntries(entries: readonly RelayLogEntry[], startIndex = 0): readonly PacketChatEntry[] {
  const chatEntries: PacketChatEntry[] = [];
  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER" || (entry.header !== 24 && entry.header !== 25 && entry.header !== 26)) continue;
    const fields = packetFieldMap(entry);
    const text = compactValue(fields.get("chatText"));
    if (text === "-") continue;
    chatEntries.push({
      index: compactValue(fields.get("chatIndex")),
      text,
      chatMode: compactValue(fields.get("chatType")),
      activity: compactValue(fields.get("chatActivity")),
      sourceLine: entry.lineNumber,
    });
  }
  return chatEntries;
}

export let packetChatEntriesCache:
  | {
      readonly logPath: string;
      readonly entryCount: number;
      readonly totalLines: number;
      readonly entries: readonly PacketChatEntry[];
    }
  | null = null;

export function packetChatEntriesFromRelayLog(snapshot: RelayLogSnapshot | null): readonly PacketChatEntry[] {
  if (!snapshot || snapshot.entries.length === 0) {
    packetChatEntriesCache = null;
    return [];
  }
  if (
    packetChatEntriesCache &&
    packetChatEntriesCache.logPath === snapshot.logPath &&
    packetChatEntriesCache.entryCount <= snapshot.entries.length &&
    packetChatEntriesCache.totalLines <= snapshot.totalLines
  ) {
    const appendedEntries = packetChatEntriesFromEntries(snapshot.entries, packetChatEntriesCache.entryCount);
    const entries = appendedEntries.length > 0 ? [...packetChatEntriesCache.entries, ...appendedEntries] : packetChatEntriesCache.entries;
    packetChatEntriesCache = {
      logPath: snapshot.logPath,
      entryCount: snapshot.entries.length,
      totalLines: snapshot.totalLines,
      entries,
    };
    return entries;
  }
  const entries = packetChatEntriesFromEntries(snapshot.entries);
  packetChatEntriesCache = {
    logPath: snapshot.logPath,
    entryCount: snapshot.entries.length,
    totalLines: snapshot.totalLines,
    entries,
  };
  return entries;
}

export function packetChatRuntimeEntry(
  entry: PacketChatEntry,
  packetIndex: PacketProfileIndex,
  runtimeUsers: readonly RuntimeUserSummary[],
  sessionName?: string | null,
): RuntimeChatEntry {
  const numericIndex = Number(entry.index);
  const resolvedUser = packetChatUserName(entry.index, packetIndex, runtimeUsers, sessionName);
  return {
    index: Number.isFinite(numericIndex) ? numericIndex : undefined,
    timestamp: `line ${entry.sourceLine}`,
    userName: resolvedUser,
    chatMode: entry.chatMode === "-" ? "talk" : entry.chatMode,
    text: entry.text,
  };
}

export function packetChatUserName(
  index: string,
  packetIndex: PacketProfileIndex,
  runtimeUsers: readonly RuntimeUserSummary[],
  sessionName?: string | null,
): string {
  const cleanIndex = compactValue(index);
  if (cleanIndex === "0") return "System";
  const packetUser = cleanIndex !== "-" ? packetIndex.byIndex.get(cleanIndex) : null;
  if (packetUser) return packetUser.name;
  const runtimeUser = runtimeUsers.find((user) => compactValue(user.roomIndex ?? user.rowId) === cleanIndex);
  if (runtimeUser) return userDisplayName(runtimeUser, sessionName);
  return cleanIndex === "-" ? "System" : `#${cleanIndex}`;
}
