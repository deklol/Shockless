import test from "node:test";
import assert from "node:assert/strict";
import { buildWallMoverRelayPacketFromControl, formatWallLocation, isAllowedWallMoverRelayAction } from "../src/shared/wallMoverRelayPackets";

function packet(action: Record<string, unknown>): Uint8Array {
  const result = buildWallMoverRelayPacketFromControl(action);
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  return result.packet;
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

test("wall mover relay packets match v3 MoveItem and AddStripItem bytes", () => {
  assert.equal(formatWallLocation(-2, 5, 0, 1, "r"), ":w=-2,5 l=0,1 r");
  assert.equal(
    text(packet({ action: "moveItem", itemId: 77, wallX: -2, wallY: 5, localX: 0, localY: 1, orientation: "r" })),
    "A[QS@O:w=-2,5 l=0,1 r",
  );
  assert.equal(
    text(packet({ action: "moveItem", itemId: 224520, wallX: 3, wallY: -1, localX: 16, localY: 48, orientation: "l" })),
    "A[`BmM@Q:w=3,-1 l=16,48 l",
  );
  assert.equal(text(packet({ action: "pickup", itemId: 77, className: "poster_hc" })), "AC77");
});

test("wall mover relay validation rejects unsafe or incomplete shapes", () => {
  assert.equal(isAllowedWallMoverRelayAction({ action: "pickup", itemId: 0 }), false);
  assert.equal(isAllowedWallMoverRelayAction({ action: "pickup", itemId: 77 }), true);
  assert.equal(
    isAllowedWallMoverRelayAction({ action: "moveItem", itemId: 77, wallX: -2, wallY: 5, localX: 0, localY: 1, orientation: "x" as "l" }),
    false,
  );
  assert.equal(
    isAllowedWallMoverRelayAction({ action: "moveItem", itemId: 77, wallX: -2, wallY: 5, localX: 0, localY: 1, orientation: "r" }),
    true,
  );
});
