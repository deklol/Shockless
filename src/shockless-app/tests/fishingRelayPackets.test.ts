import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFishingRelayPacketFromControl, isAllowedFishingRelayAction } from "../src/shared/fishingRelayPackets";

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

test("fishing relay start and minigame packets match v3 autofish headers", () => {
  const start = buildFishingRelayPacketFromControl({ action: "startFishing", areaId: 42 });
  assert.equal(start.ok, true, start.ok ? start.note : start.message);
  if (!start.ok) return;
  assert.equal(start.note, "Fishing start header=1100 areaId=42");
  assert.equal(text(start.packet), "QLRJ");

  const input = buildFishingRelayPacketFromControl({ action: "minigameInput", direction: "L" });
  assert.equal(input.ok, true, input.ok ? input.note : input.message);
  if (!input.ok) return;
  assert.equal(input.note, "Fishing minigame input header=1101 direction=L");
  assert.equal(text(input.packet), "QM@AL");
});

test("fishing relay supports named read and derby actions only", () => {
  const expected = new Map([
    ["registerDerby", "QT"],
    ["requestTokens", "QN"],
    ["requestProducts", "QO"],
    ["requestRodLevel", "QQ"],
    ["requestStats", "QR"],
    ["requestFishopedia", "QS"],
  ]);

  for (const [action, packetText] of expected) {
    const result = buildFishingRelayPacketFromControl({ action });
    assert.equal(result.ok, true, result.ok ? result.note : result.message);
    if (result.ok) assert.equal(text(result.packet), packetText);
  }

  assert.equal(isAllowedFishingRelayAction({ action: "startFishing", areaId: 0 }), false);
  assert.equal(isAllowedFishingRelayAction({ action: "minigameInput", direction: "X" as "L" }), false);
  assert.equal(isAllowedFishingRelayAction({ action: "purchaseProduct", productCode: "" }), false);
  assert.equal(isAllowedFishingRelayAction({ action: "rawPacket" } as never), false);
});

test("fishing relay purchase product packet matches Director Fishing command", () => {
  const purchase = buildFishingRelayPacketFromControl({ action: "purchaseProduct", productCode: "rod_lvl_2" });
  assert.equal(purchase.ok, true);
  if (!purchase.ok) return;
  assert.equal(Buffer.from(purchase.packet).toString("latin1"), "QP@Irod_lvl_2");
  assert.match(purchase.note, /1104/);
});
