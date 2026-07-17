import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShockwavePluginPacketFromControl,
  pluginPacketRelayControlPayload,
} from "../src/shared/shockwavePluginPacketBuilder";
import { parseShockwavePacketExpression } from "../src/shared/shockwavePacketExpression";
import { formatShockwavePacketParts } from "../src/shared/shockwavePacketText";

test("plugin Shockwave packet builder accepts known packet names and body encodings", () => {
  const wave = buildShockwavePluginPacketFromControl({ packetName: "WAVE" });
  assert.equal(wave.ok, true);
  if (!wave.ok) return;
  assert.equal(wave.packet.header, 94);
  assert.equal(wave.packet.packetName, "WAVE");
  assert.equal(wave.packet.bodyHex, "");
  assert.equal(wave.packet.packetText, formatShockwavePacketParts(94, []));

  const hex = buildShockwavePluginPacketFromControl({ header: 52, bodyHex: "68 69" });
  assert.equal(hex.ok, true);
  if (!hex.ok) return;
  assert.equal(hex.packet.bodyHex, "6869");
  assert.deepEqual([...hex.packet.body], [0x68, 0x69]);

  const bytes = buildShockwavePluginPacketFromControl({ header: "52", bodyBytes: [104, 105] });
  assert.equal(bytes.ok, true);
  if (!bytes.ok) return;
  assert.equal(bytes.packet.bodyHex, "6869");

  const literal = buildShockwavePluginPacketFromControl({ header: 52, bodyText: "hi" });
  assert.equal(literal.ok, true);
  if (!literal.ok) return;
  assert.equal(literal.packet.bodyHex, "6869");

  const escaped = buildShockwavePluginPacketFromControl({ header: 52, bodyEscapedText: "hi[0][2]" });
  assert.equal(escaped.ok, true);
  if (!escaped.ok) return;
  assert.equal(escaped.packet.bodyHex, "68690002");
});

test("plugin Shockwave packet builder accepts full formatted packet text", () => {
  const packetText = formatShockwavePacketParts(94, [0, 2, 91, 255]);
  const result = buildShockwavePluginPacketFromControl({ packetText });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.packet.header, 94);
  assert.equal(result.packet.bodyHex, "00025bff");
  assert.equal(result.packet.packetText, packetText);
});

test("raw Shockwave expressions encode outgoing strings exactly", () => {
  const parsed = parseShockwavePacketExpression('{h:52}{s:"hello world"}', "server");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual([...parsed.bytes], [64, 116, 64, 75, ...Buffer.from("hello world", "latin1")]);

  const built = buildShockwavePluginPacketFromControl({
    target: "server",
    packetText: '{h:52}{s:"hello world"}',
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.packet.target, "server");
  assert.equal(built.packet.header, 52);
  assert.equal(built.packet.bodyHex, "404b68656c6c6f20776f726c64");
});

test("raw Shockwave expressions encode incoming strings with chr2", () => {
  const parsed = parseShockwavePacketExpression('{h:4}{s:"hello"}', "client");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual([...parsed.bytes], [64, 68, ...Buffer.from("hello", "latin1"), 2]);

  const built = buildShockwavePluginPacketFromControl({
    target: "client",
    packetText: '{h:4}{s:"hello"}',
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.packet.target, "client");
  assert.equal(built.packet.header, 4);
  assert.equal(built.packet.bodyHex, "68656c6c6f02");
});

test("raw Shockwave expressions preserve literal text and byte escapes", () => {
  const parsed = parseShockwavePacketExpression("@tplain[0][2][255]", "server");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual([...parsed.bytes], [64, 116, ...Buffer.from("plain", "latin1"), 0, 2, 255]);
});

test("plugin Shockwave packet builder normalizes relay control payloads", () => {
  const result = pluginPacketRelayControlPayload({ packetName: "WAVE", bodyEscapedText: "[1]" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    scope: "packet",
    target: "server",
    header: 94,
    packetName: "WAVE",
    bodyHex: "01",
  });
});

test("plugin Shockwave packet builder permits server-to-client headers", () => {
  const result = buildShockwavePluginPacketFromControl({ target: "client", header: 4, bodyHex: "00" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.packet.target, "client");
  assert.equal(result.packet.header, 4);
});

test("plugin Shockwave packet builder rejects sensitive and invalid packets", () => {
  const sensitive = buildShockwavePluginPacketFromControl({ header: 4, bodyHex: "00" });
  assert.equal(sensitive.ok, false);
  if (!sensitive.ok) assert.match(sensitive.message, /refuses.*TRY_LOGIN|sensitive/i);

  const secretByName = buildShockwavePluginPacketFromControl({ packetName: "GENERATEKEY", bodyHex: "00" });
  assert.equal(secretByName.ok, false);
  if (!secretByName.ok) assert.match(secretByName.message, /refuses.*GENERATEKEY|sensitive/i);

  for (const header of [764, 765]) {
    const steamAuth = buildShockwavePluginPacketFromControl({ target: "server", header, bodyHex: "00" });
    assert.equal(steamAuth.ok, false);
    if (!steamAuth.ok) assert.match(steamAuth.message, /refuses.*header 76[45]/i);
  }

  const unknownName = buildShockwavePluginPacketFromControl({ packetName: "NOT_A_REAL_PACKET" });
  assert.equal(unknownName.ok, false);
  if (!unknownName.ok) assert.match(unknownName.message, /Unknown client packet name/);

  const badHex = buildShockwavePluginPacketFromControl({ header: 52, bodyHex: "abc" });
  assert.equal(badHex.ok, false);
  if (!badHex.ok) assert.match(badHex.message, /even-length hexadecimal/);

  const mixedBody = buildShockwavePluginPacketFromControl({ header: 52, bodyHex: "00", bodyText: "x" });
  assert.equal(mixedBody.ok, false);
  if (!mixedBody.ok) assert.match(mixedBody.message, /exactly one body source/);

  const mismatch = buildShockwavePluginPacketFromControl({ header: 94, packetName: "CHAT" });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.message, /does not match/);
});

test("plugin Shockwave packet builder allows numeric unknown headers without guessing names", () => {
  const result = buildShockwavePluginPacketFromControl({ header: 3439, bodyHex: "" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.packet.header, 3439);
  assert.equal(result.packet.packetName, null);
  assert.match(result.packet.note, /UNKNOWN_HEADER/);
});
