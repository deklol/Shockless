import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFurniRelayPacketFromControl, formatWallLocation, isAllowedFurniRelayAction } from "../src/shared/furniRelayPackets";

function packet(action: Record<string, unknown>): Uint8Array {
  const result = buildFurniRelayPacketFromControl(action);
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  return result.packet;
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

test("furni relay builds source-backed floor move rotate and pickup packets", () => {
  assert.equal(text(packet({ action: "moveFloorItem", objectId: 42, x: 3, y: 5, direction: 2 })), "AIRJKQAJ");
  assert.equal(text(packet({ action: "rotateFloorItem", objectId: 42, x: 3, y: 5, direction: 4 })), "AIRJKQAPA");
  assert.equal(text(packet({ action: "setFloorItemLocation", objectId: 42, x: 3, y: 5, height: 0 })), "SiRJKQA@E0.000");
  assert.equal(text(packet({ action: "useFloorItem", objectId: 42, value: "0", className: "toby_hammer" })), "AJ@B42@A0");
  assert.equal(text(packet({ action: "pickupFloorItem", objectId: 42, className: "chair" })), "ACnew stuff 42");
});

test("furni relay builds source-backed wall move and pickup packets", () => {
  assert.equal(formatWallLocation(-2, 5, 0, 1, "r"), ":w=-2,5 l=0,1 r");
  assert.equal(
    text(packet({ action: "moveWallItem", itemId: 77, wallX: -2, wallY: 5, localX: 0, localY: 1, orientation: "r" })),
    "A[QS@O:w=-2,5 l=0,1 r",
  );
  assert.equal(text(packet({ action: "pickupWallItem", itemId: 77, className: "poster_hc" })), "ACnew item 77");
});

test("furni relay validation rejects unsafe or incomplete actions", () => {
  assert.equal(isAllowedFurniRelayAction({ action: "pickupFloorItem", objectId: 0 }), false);
  assert.equal(isAllowedFurniRelayAction({ action: "useFloorItem", objectId: 42, value: "0" }), true);
  assert.equal(isAllowedFurniRelayAction({ action: "useFloorItem", objectId: 0, value: "0" }), false);
  assert.equal(isAllowedFurniRelayAction({ action: "pickupWallItem", itemId: 77 }), true);
  assert.equal(
    isAllowedFurniRelayAction({ action: "moveFloorItem", objectId: 42, x: 3, y: Number.NaN, direction: 2 }),
    false,
  );
  assert.equal(isAllowedFurniRelayAction({ action: "setFloorItemLocation", objectId: 42, x: 3, y: 5, height: "0.45" }), true);
  assert.equal(isAllowedFurniRelayAction({ action: "setFloorItemLocation", objectId: 42, x: 3, y: 5, height: "bad" }), false);
  assert.equal(
    isAllowedFurniRelayAction({ action: "moveWallItem", itemId: 77, wallX: -2, wallY: 5, localX: 0, localY: 1, orientation: "x" as "l" }),
    false,
  );
  assert.equal(buildFurniRelayPacketFromControl({ action: "useFloorItem", objectId: 42, value: "snowman ☃" }).ok, false);
  assert.equal(buildFurniRelayPacketFromControl({ action: "rawPacket", objectId: 42 }).ok, false);
});
