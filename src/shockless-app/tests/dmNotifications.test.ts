import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDmNotificationPayload,
  dmNotificationKey,
  isLivePrivateMessage,
  senderNameForPrivateMessage,
  socialDmNotificationsEnabled,
} from "../src/renderer/ui/dmNotifications";
import type { ClientPluginSnapshot, PacketMessengerMessage } from "../src/renderer/ui/helpers";

const message: PacketMessengerMessage = {
  key: "abc:233421:hello",
  id: "abc",
  senderAccountId: "233421",
  sentAt: "30-06-2026 23:00:00",
  text: "hello",
  sourceLine: 42,
};

test("social DM notification surface follows plugin and surface enabled state", () => {
  assert.equal(socialDmNotificationsEnabled({ social: true }, { social: { "private-message-notifications": true } }), true);
  assert.equal(socialDmNotificationsEnabled({ social: false }, { social: { "private-message-notifications": true } }), false);
  assert.equal(socialDmNotificationsEnabled({ social: true }, { social: { "private-message-notifications": false } }), false);
});

test("DM notification helper only treats live MESSENGER_MESSAGE rows as notification-worthy", () => {
  const snapshot = snapshotWithEntries([
    { lineNumber: 41, direction: "SERVER", header: 313 },
    { lineNumber: 42, direction: "SERVER", header: 134 },
  ]);
  assert.equal(isLivePrivateMessage(snapshot, message), true);
  assert.equal(isLivePrivateMessage(snapshotWithEntries([{ lineNumber: 42, direction: "SERVER", header: 313 }]), message), false);
  assert.equal(isLivePrivateMessage(snapshotWithEntries([{ lineNumber: 42, direction: "CLIENT", header: 134 }]), message), false);
});

test("DM notification payload uses resolved sender name and messenger alert image", () => {
  const snapshot = snapshotWithEntries([{ lineNumber: 42, direction: "SERVER", header: 134 }], "shockless1");
  const senderName = senderNameForPrivateMessage(message, snapshot, [snapshot]);
  const payload = buildDmNotificationPayload(message, senderName, "23:00");
  assert.equal(senderName, "dek");
  assert.equal(payload.title, "DM Received from dek (23:00)");
  assert.equal(payload.message, "hello");
  assert.equal(payload.imageName, "thumb.messenger_alert");
});

test("DM notification keys are scoped per receiving client", () => {
  assert.notEqual(dmNotificationKey(2, message), dmNotificationKey(3, message));
});

function snapshotWithEntries(
  entries: readonly { readonly lineNumber: number; readonly direction: "SERVER" | "CLIENT"; readonly header: number }[],
  receiverName = "receiver",
): ClientPluginSnapshot {
  return {
    clientId: 3,
    label: receiverName,
    relay: { entries } as unknown,
    runtime: null,
    runtimeSummary: null,
    profileUsers: [],
    profileIndex: {
      users: [],
      byAccountId: new Map(),
      byName: new Map(),
      byIndex: new Map(),
    },
    packetInfo: {
      friends: [
        {
          accountId: "233421",
          name: "dek",
          gender: "-",
          motto: "-",
          online: true,
          canFollow: true,
          location: "Codex Test LAB",
          lastAccess: "-",
          figure: "-",
          categoryId: "-",
          sourceLine: 12,
        },
      ],
      badges: [],
      activeBadgeSlot: "-",
      activeBadgeCode: "-",
      preferences: [],
      statusEffects: [],
      privateMessages: [message],
      friendRequests: [],
      messengerMessage: "-",
      messengerUserLimit: "-",
      messengerRequestCount: "-",
      messengerRequestPendingCount: "-",
      messengerMessageCount: "1",
      messengerUnreadMessageCount: "1",
    },
    packetInventory: { items: [], totalCount: 0, floorCount: 0, wallCount: 0, lastSourceLine: null },
    packetWallItems: { items: [], itemCount: 0, lastSourceLine: null },
    packetActiveObjects: { items: [], itemCount: 0, removedObjectIds: [], lastSourceLine: null },
    packetChatEntries: [],
    packetFishing: {
      status: "idle",
      note: "-",
      tokens: "-",
      level: "-",
      minigameActive: false,
      minigamePin: "-",
      minigameValues: "-",
      catches: 0,
      golden: 0,
      xp: 0,
      frenzies: 0,
      fishopedia: [],
      catchLog: [],
      lastCatch: null,
      lastClientAction: "-",
      lastClientTargetId: "-",
      activeTile: null,
      lastSourceLine: null,
    },
    updatedAt: "2026-06-30T23:00:00.000Z",
  } as ClientPluginSnapshot;
}
