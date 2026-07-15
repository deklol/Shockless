import type { ClientPluginSnapshot, PacketMessengerMessage } from "../packets/types";

export interface DmNotificationPayload {
  readonly title: string;
  readonly message: string;
  readonly imageName: string;
  readonly titleColor: string;
  readonly backgroundColor: string;
}

export function socialDmNotificationsEnabled(
  enabledById: Readonly<Record<string, boolean>>,
  surfaceEnabledByPluginId: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
): boolean {
  return enabledById.social !== false && surfaceEnabledByPluginId.social?.["private-message-notifications"] !== false;
}

export function dmNotificationKey(clientId: number, message: PacketMessengerMessage): string {
  return `${clientId}:${message.key || message.id || message.sourceLine}:${message.senderAccountId}:${message.text}`;
}

export function isLivePrivateMessage(snapshot: ClientPluginSnapshot, message: PacketMessengerMessage): boolean {
  const sourceLine = Number(message.sourceLine);
  if (!Number.isFinite(sourceLine)) return false;
  return Boolean(snapshot.relay?.entries.some((entry) => entry.lineNumber === sourceLine && entry.direction === "SERVER" && entry.header === 134));
}

export function senderNameForPrivateMessage(
  message: PacketMessengerMessage,
  sourceSnapshot: ClientPluginSnapshot | null,
  allSnapshots: readonly ClientPluginSnapshot[],
): string {
  const accountId = cleanId(message.senderAccountId);
  if (!accountId) return "Unknown";
  const candidates = sourceSnapshot ? [sourceSnapshot, ...allSnapshots.filter((snapshot) => snapshot.clientId !== sourceSnapshot.clientId)] : allSnapshots;
  for (const snapshot of candidates) {
    const friendName = snapshot.packetInfo.friends.find((friend) => cleanId(friend.accountId) === accountId)?.name;
    if (usableName(friendName)) return friendName.trim();

    const packetProfileName = snapshot.profileIndex.byAccountId.get(accountId)?.name;
    if (usableName(packetProfileName)) return packetProfileName.trim();

    for (const user of snapshot.runtime?.userState?.users ?? []) {
      const userAccountId = cleanId((user as { readonly accountId?: unknown }).accountId);
      const userName = String((user as { readonly name?: unknown; readonly userName?: unknown }).name ?? (user as { readonly userName?: unknown }).userName ?? "").trim();
      if (userAccountId === accountId && usableName(userName)) return userName;
    }
  }
  return `#${accountId}`;
}

export function buildDmNotificationPayload(
  message: PacketMessengerMessage,
  senderName: string,
  timeText = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): DmNotificationPayload {
  return {
    title: `DM Received from ${senderName || "Unknown"} (${timeText})`,
    message: message.text || "(empty message)",
    imageName: "thumb.messenger_alert",
    titleColor: "#1f1f1f",
    backgroundColor: "#ffffff",
  };
}

function cleanId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : "";
}

function usableName(value: unknown): value is string {
  const text = String(value ?? "").trim();
  return Boolean(text && text !== "-");
}
