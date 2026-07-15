import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGardeningRelayPacketFromControl, isAllowedGardeningRelayAction } from "../src/shared/gardeningRelayPackets";

function text(packet: Uint8Array): string {
  return String.fromCharCode(...packet);
}

test("gardening relay packets match v3 move water harvest and compost bytes", () => {
  assert.equal(text(assertPacket({ action: "move", objectId: 42, x: 3, y: 5, direction: 2 })), "AIRJKQAJ");
  assert.equal(text(assertPacket({ action: "water", objectId: 42 })), "H\\@B42");
  assert.equal(text(assertPacket({ action: "harvest", objectId: 42 })), "H]@B42");
  assert.equal(text(assertPacket({ action: "compost", objectId: 42 })), "Q[@B42");
});

test("gardening relay validation rejects unsupported or incomplete actions", () => {
  assert.equal(isAllowedGardeningRelayAction({ action: "move", objectId: 42, x: 3, y: 5, direction: 2 }), true);
  assert.equal(isAllowedGardeningRelayAction({ action: "water", objectId: 42 }), true);
  assert.equal(isAllowedGardeningRelayAction({ action: "harvest", objectId: 0 }), false);
  assert.equal(
    isAllowedGardeningRelayAction({ action: "move", objectId: 42, x: 3, y: Number.NaN, direction: 2 }),
    false,
  );
  assert.equal(buildGardeningRelayPacketFromControl({ action: "rawPacket", objectId: 42 }).ok, false);
});

function assertPacket(record: Record<string, unknown>): Uint8Array {
  const result = buildGardeningRelayPacketFromControl(record);
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  return result.packet;
}
