import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSocialRelayPacketFromControl, isAllowedSocialRelayAction } from "../src/shared/socialRelayPackets";

function text(packet: Uint8Array): string {
  return String.fromCharCode(...packet);
}

test("social relay message packet matches v3 MESSENGER_SENDMSG bytes", () => {
  const packet = assertPacket({ action: "message", accountId: 161423, recipient: "Wessley", message: "oo ty!" });
  assert.equal(text(packet), "@aIccvI@Foo ty!");
});

test("social relay friend request packet matches v3 FRIENDLIST_FRIENDREQUEST bytes", () => {
  const packet = assertPacket({ action: "addUser", name: "trickortori" });
  assert.equal(text(packet), "@g@Ktrickortori");
});

test("social relay friend lifecycle packets match v3 friend list bytes", () => {
  assert.equal(text(assertPacket({ action: "refreshFriendRequests" })), "Ci");
  assert.equal(text(assertPacket({ action: "acceptRequest", accountId: 161423 })), "@eIccvI");
  assert.equal(text(assertPacket({ action: "declineRequest", accountId: 161423 })), "@fHIccvI");
  assert.equal(text(assertPacket({ action: "removeFriend", accountId: 161423, name: "Wessley" })), "@hIccvI");
  assert.equal(text(assertPacket({ action: "followFriend", accountId: 161423, name: "Wessley" })), "DFccvI");
});

test("social relay action validation rejects unsafe message and friend request shapes", () => {
  assert.equal(isAllowedSocialRelayAction({ action: "message", accountId: 0, message: "hello" }), false);
  assert.equal(isAllowedSocialRelayAction({ action: "message", accountId: 1, message: "" }), false);
  assert.equal(isAllowedSocialRelayAction({ action: "message", accountId: 1, message: "hello" }), true);
  assert.equal(isAllowedSocialRelayAction({ action: "addUser", name: "" }), false);
  assert.equal(isAllowedSocialRelayAction({ action: "addUser", name: "dek" }), true);
  assert.equal(isAllowedSocialRelayAction({ action: "acceptRequest", accountId: 0 }), false);
  assert.equal(isAllowedSocialRelayAction({ action: "declineRequest", accountId: 77157 }), true);
  assert.equal(isAllowedSocialRelayAction({ action: "removeFriend", accountId: -1 }), false);
  assert.equal(isAllowedSocialRelayAction({ action: "followFriend", accountId: 902 }), true);
  assert.equal(isAllowedSocialRelayAction({ action: "refreshFriendRequests" }), true);
  assert.equal(buildSocialRelayPacketFromControl({ action: "rawPacket", text: "{h:1}" }).ok, false);
});

function assertPacket(record: Record<string, unknown>): Uint8Array {
  const result = buildSocialRelayPacketFromControl(record);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.packet;
}
