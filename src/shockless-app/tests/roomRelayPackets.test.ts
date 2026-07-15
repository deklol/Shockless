import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoomRelayPacketsFromControl, isAllowedRoomRelayAction } from "../src/shared/roomRelayPackets";

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

test("room relay visit packet sequence matches v3 private-room travel", () => {
  const result = buildRoomRelayPacketsFromControl({ action: "visitPrivateRoom", roomId: 224520 });
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  if (!result.ok) return;

  assert.deepEqual(
    result.packets.map((packet) => packet.note.replace(/ roomId=.*/, "")),
    [
      "Room visit GETFLATINFO header=21",
      "Room visit GETINTERST header=182",
      "Room visit ROOM_DIRECTORY header=2",
      "Room visit TRYFLAT header=57",
      "Room visit GOTOFLAT header=59",
    ],
  );
  assert.deepEqual(result.packets.map((packet) => text(packet.packet)), [
    "@U224520",
    "Bvgeneral",
    "@BH`BmMH",
    "@y224520",
    "@{224520",
  ]);
});

test("room relay validation rejects unsafe room targets", () => {
  assert.equal(isAllowedRoomRelayAction({ action: "visitPrivateRoom", roomId: 224520 }), true);
  assert.equal(isAllowedRoomRelayAction({ action: "visitPrivateRoom", roomId: 0 }), false);
  assert.equal(isAllowedRoomRelayAction({ action: "visitPrivateRoom", roomId: "abc" }), false);
  assert.equal(isAllowedRoomRelayAction({ action: "rawPacket", roomId: 224520 }), false);
});

test("room relay movement packet matches live ORIGINS_MOVE VL64 triples", () => {
  const result = buildRoomRelayPacketsFromControl({ action: "move", x: 9, y: 7, furniId: 0 });
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  if (!result.ok) return;

  assert.equal(result.packets.length, 1);
  assert.equal(result.packets[0]?.note, "Room ORIGINS_MOVE header=1269 x=9 y=7 furniId=0");
  assert.equal(text(result.packets[0]!.packet), "SuQBSAH");
  assert.equal(isAllowedRoomRelayAction({ action: "move", x: 0, y: 0 }), true);
  assert.equal(isAllowedRoomRelayAction({ action: "move", x: -1, y: 0 }), false);
});


test("room relay leave packet uses typed QUIT route", () => {
  const result = buildRoomRelayPacketsFromControl({ action: "leave" });
  assert.equal(result.ok, true, result.ok ? result.note : result.message);
  if (!result.ok) return;

  assert.equal(result.packets.length, 1);
  assert.equal(result.packets[0]?.note, "Room QUIT header=53");
  assert.equal(text(result.packets[0]!.packet), "@u");
  assert.equal(isAllowedRoomRelayAction({ action: "leave" }), true);
});
