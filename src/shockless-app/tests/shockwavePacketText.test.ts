import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeShockwaveBase64Int, formatShockwavePacketParts, formatShockwavePacketText } from "../src/shared/shockwavePacketText";

test("Shockwave base64 header encoding matches Habbpy v3 wedgie packets", () => {
  assert.equal(Buffer.from(encodeShockwaveBase64Int(230, 2)).toString("latin1"), "Cf");
  assert.equal(Buffer.from(encodeShockwaveBase64Int(50, 2)).toString("latin1"), "@r");
  assert.equal(Buffer.from(encodeShockwaveBase64Int(196, 2)).toString("latin1"), "CD");
  assert.equal(Buffer.from(encodeShockwaveBase64Int(1269, 2)).toString("latin1"), "Su");
});

test("Shockwave packet text formatter matches Habbpy v3 wedgie.format_packet_text escaping", () => {
  assert.equal(
    formatShockwavePacketParts(230, Buffer.from("QBQBQBRBIaPcs0.45\x020.45\x02`Znp", "latin1")),
    "CfQBQBQBRBIaPcs0.45[2]0.45[2]`Znp",
  );
  assert.equal(
    formatShockwavePacketParts(230, Buffer.from("QBRBQBQBIaPcs0.45\x020.45\x02cp[`", "latin1")),
    "CfQBRBQBQBIaPcs0.45[2]0.45[2]cp[91]`",
  );
  assert.equal(formatShockwavePacketParts(50, Buffer.from("1782013912174\x02", "latin1")), "@r1782013912174[2]");
  assert.equal(formatShockwavePacketParts(196, Buffer.from("@F435119@M1782013912174", "latin1")), "CD@F435119@M1782013912174");
  assert.equal(formatShockwavePacketParts(1269, Buffer.from("PBRAH", "latin1")), "SuPBRAH");
});

test("Shockwave packet text formatter escapes bracket and control bytes exactly like v3", () => {
  assert.equal(formatShockwavePacketText([65, 66, 67]), "ABC");
  assert.equal(formatShockwavePacketText([0, 2, 9, 91, 93, 123, 125, 127, 128]), "[0][2][9][91][93][123][125][127][128]");
});
