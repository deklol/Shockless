import type { RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, profileValue, userDisplayName, userPosition } from "../common/model";
import type { PacketProfileUser } from "../packets/types";

export interface VisitorEntry {
  readonly key: string;
  readonly name: string;
  readonly accountId: string;
  readonly index: string;
  readonly rowId: string;
  readonly visits: number;
  readonly entered: string;
  readonly left: string;
  readonly current: boolean;
  readonly position: string;
  readonly userType: string;
  readonly packetLine: string;
  readonly sourceKeys: readonly string[];
}

export interface VisitorTrackerState {
  readonly roomKey: string;
  readonly activeKeys: readonly string[];
  readonly entries: Readonly<Record<string, VisitorEntry>>;
}

export const emptyVisitorState: VisitorTrackerState = {
  roomKey: "",
  activeKeys: [],
  entries: {},
};

export function isVisitorUser(user: RuntimeUserSummary): boolean {
  const sourceText = [user.type, user.userType, user.objectClass, user.className].map(compactValue).join(" ").toLowerCase();
  if (sourceText.includes("pet") || sourceText.includes("bot")) return false;
  if (sourceText.includes("human")) return true;
  return compactValue(user.type ?? user.userType) === "1" || Boolean(user.name || user.rowId);
}

export function visitorKeyFor(user: RuntimeUserSummary, sessionName?: string | null, packetUser?: PacketProfileUser | null): string {
  const accountId = profileValue(user.accountId, packetUser?.accountId);
  if (accountId !== "-") return `id:${accountId}`;
  const name = userDisplayName(user, sessionName).trim().toLowerCase();
  if (name && name !== "-") return `name:${name}`;
  return `row:${user.rowId}`;
}

export function visitorEntryFor(
  user: RuntimeUserSummary,
  sessionName: string | null | undefined,
  now: string,
  previous?: VisitorEntry,
  packetUser?: PacketProfileUser | null,
): VisitorEntry {
  const accountId = profileValue(user.accountId, packetUser?.accountId);
  const name = profileValue(userDisplayName(user, sessionName), packetUser?.name);
  const packetLine = packetUser ? String(packetUser.sourceLine) : "-";
  return {
    key: visitorKeyFor(user, sessionName, packetUser),
    name,
    accountId,
    index: profileValue(user.roomIndex ?? user.rowId, packetUser?.index),
    rowId: user.rowId,
    visits: previous?.visits ?? 1,
    entered: previous?.entered ?? now,
    left: "-",
    current: true,
    position: profileValue(userPosition(user), packetUser?.position),
    userType: profileValue(user.userType ?? user.type ?? user.objectClass, packetUser?.userType),
    packetLine,
    sourceKeys: packetUser ? [...user.sourceKeys, `relay.USERS.line.${packetUser.sourceLine}`] : user.sourceKeys,
  };
}

export function visitorEntryForPacketUser(user: PacketProfileUser, now: string, previous?: VisitorEntry): VisitorEntry {
  const key = compactValue(user.accountId) !== "-" ? `id:${user.accountId}` : `name:${user.name.trim().toLowerCase()}`;
  return {
    key,
    name: user.name,
    accountId: compactValue(user.accountId),
    index: compactValue(user.index),
    rowId: user.index,
    visits: previous?.visits ?? 1,
    entered: previous?.entered ?? now,
    left: "-",
    current: true,
    position: compactValue(user.position),
    userType: compactValue(user.userType),
    packetLine: String(user.sourceLine),
    sourceKeys: [`relay.USERS.line.${user.sourceLine}`],
  };
}

export function visitorSearchText(entry: VisitorEntry): string {
  return [
    entry.name,
    entry.accountId,
    entry.index,
    entry.visits,
    entry.entered,
    entry.left,
    entry.position,
    entry.userType,
    entry.packetLine,
    entry.sourceKeys.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

export function visitorMeta(entry: VisitorEntry): string {
  const id = entry.accountId === "-" ? "id missing" : `id:${entry.accountId}`;
  const visits = `${entry.visits} visit${entry.visits === 1 ? "" : "s"}`;
  return [
    id,
    visits,
    entry.position !== "-" ? `tile ${entry.position}` : "",
    entry.entered !== "-" ? `entered ${entry.entered}` : "",
    entry.current ? "in room" : `left ${entry.left}`,
  ]
    .filter(Boolean)
    .join(" / ");
}
