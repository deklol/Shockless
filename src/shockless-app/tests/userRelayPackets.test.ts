import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserRelayPacketFromControl, isAllowedUserRelayAction } from "../src/shared/userRelayPackets";

function text(packet: Uint8Array): string {
  return String.fromCharCode(...packet);
}

test("user relay packets match Habbpy v3 quick action bytes", () => {
  assert.equal(text(assertPacket({ action: "wave" })), "A^");
  assert.equal(text(assertPacket({ action: "dance", number: 1 })), "A]I");
  assert.equal(text(assertPacket({ action: "dance", number: 4 })), "A]PA");
  assert.equal(text(assertPacket({ action: "stopDance" })), "A]H");
  assert.equal(text(assertPacket({ action: "carryDrink" })), "APQA");
});

test("apply look relay packet preserves the exact v3 figure packet shape", () => {
  const figure = "hd-180-1.ch-210-66";
  const packet = assertPacket({ action: "applyLook", figure });
  assert.equal(text(packet), `@l@D@R${figure}@JH@AH@R@@`);
});

test("user relay action validation rejects unsupported or unsafe shapes", () => {
  assert.equal(isAllowedUserRelayAction({ action: "dance", number: 5 }), false);
  assert.equal(isAllowedUserRelayAction({ action: "applyLook", figure: "" }), false);
  assert.equal(isAllowedUserRelayAction({ action: "applyLook", figure: "hd-180-1" }), true);
  assert.equal(buildUserRelayPacketFromControl({ action: "rawPacket", text: "{h:1}" }).ok, false);
});

function assertPacket(record: Record<string, unknown>): Uint8Array {
  const result = buildUserRelayPacketFromControl(record);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.packet;
}
