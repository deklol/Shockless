import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ORIGINS_STEAM_APP_ID } from "../src/shared/steam";
import {
  expectedSteamBridgeFrameLength,
  parseSteamBridgeFrame,
  STEAM_BRIDGE_HEADER_LENGTH,
  STEAM_BRIDGE_MAX_TICKET_LENGTH,
  STEAM_BRIDGE_NONCE_LENGTH,
} from "../src/main/steam/SteamBridgeProtocol";
import { parseSteamRegistryPath, steamLibraryRoots } from "../src/main/steam/SteamInstallationLocator";
import { parseValveKeyValues, valveObject, valveString, valveValue } from "../src/main/steam/ValveKeyValues";

const FAKE_TICKET = Buffer.from("shockless-test-ticket-not-a-real-credential", "ascii");

test("Valve KeyValues parsing preserves nested Steam manifest data", () => {
  const parsed = parseValveKeyValues([
    '"AppState"',
    "{",
    `  "appid" "${ORIGINS_STEAM_APP_ID}"`,
    '  "installdir" "Habbo Hotel Origins"',
    '  "label" "line\\nvalue"',
    "}",
  ].join("\n"));
  const appState = valveObject(valveValue(parsed, "appstate"));
  assert.ok(appState);
  assert.equal(valveString(valveValue(appState, "APPID")), String(ORIGINS_STEAM_APP_ID));
  assert.equal(valveString(valveValue(appState, "installdir")), "Habbo Hotel Origins");
  assert.equal(valveString(valveValue(appState, "label")), "line\nvalue");
});

test("Steam library discovery reads registered VDF roots without fixed machine paths", () => {
  const root = mkdtempSync(join(tmpdir(), "shockless-steam-libraries-"));
  const library = join(root, "secondary-library");
  try {
    mkdirSync(join(root, "steamapps"), { recursive: true });
    const encodedLibrary = library.replaceAll("\\", "\\\\");
    writeFileSync(join(root, "steamapps", "libraryfolders.vdf"), [
      '"libraryfolders"',
      "{",
      '  "0"',
      "  {",
      `    "path" "${encodedLibrary}"`,
      "  }",
      "}",
    ].join("\n"), "utf8");

    assert.deepEqual(steamLibraryRoots(root), [resolve(root), resolve(library)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Steam registry output parsing accepts only installation path values", () => {
  const output = [
    "HKEY_CURRENT_USER\\Software\\Valve\\Steam",
    "    Language    REG_SZ    english",
    "    SteamPath    REG_SZ    C:\\Program Files (x86)\\Steam",
  ].join("\r\n");
  assert.equal(parseSteamRegistryPath(output), "C:\\Program Files (x86)\\Steam");
  assert.equal(parseSteamRegistryPath("Language REG_SZ english"), null);
});

test("Steam bridge protocol accepts only complete authenticated frames", () => {
  const nonce = Buffer.alloc(STEAM_BRIDGE_NONCE_LENGTH, 0x5a);
  const frame = successFrame(nonce);
  assert.equal(expectedSteamBridgeFrameLength(frame.subarray(0, STEAM_BRIDGE_HEADER_LENGTH)), frame.length);

  const credentials = parseSteamBridgeFrame(frame, nonce, ORIGINS_STEAM_APP_ID);
  assert.equal(credentials.appId, ORIGINS_STEAM_APP_ID);
  assert.equal(credentials.steamId, 76561198000000000n);
  assert.equal(credentials.overlayEnabled, true);
  assert.deepEqual(credentials.ticket, FAKE_TICKET);

  const wrongNonce = Buffer.from(nonce);
  wrongNonce[0] ^= 0xff;
  assert.throws(() => parseSteamBridgeFrame(frame, wrongNonce, ORIGINS_STEAM_APP_ID), /session identity/i);
  assert.throws(() => parseSteamBridgeFrame(frame, nonce, ORIGINS_STEAM_APP_ID + 1), /unexpected AppID/i);
  assert.throws(() => parseSteamBridgeFrame(frame.subarray(0, frame.length - 1), nonce, ORIGINS_STEAM_APP_ID), /frame length/i);
});

test("Steam bridge protocol rejects failure, empty, and oversized ticket frames", () => {
  const nonce = Buffer.alloc(STEAM_BRIDGE_NONCE_LENGTH, 0x31);
  const failed = successFrame(nonce);
  failed[5] = 0;
  failed[22] = 7;
  assert.throws(() => parseSteamBridgeFrame(failed, nonce, ORIGINS_STEAM_APP_ID), /not logged in/i);

  const empty = successFrame(nonce, Buffer.alloc(0));
  assert.throws(() => parseSteamBridgeFrame(empty, nonce, ORIGINS_STEAM_APP_ID), /incomplete credentials/i);

  const oversizedHeader = Buffer.alloc(STEAM_BRIDGE_HEADER_LENGTH);
  oversizedHeader.writeUInt16LE(STEAM_BRIDGE_MAX_TICKET_LENGTH + 1, 36);
  assert.throws(() => expectedSteamBridgeFrameLength(oversizedHeader), /ticket length/i);
});

test("native Steam bridge follows installed interface revisions instead of pinning versions", () => {
  const source = readFileSync(resolve("native", "steam-bridge", "SteamBridge.cs"), "utf8");
  assert.match(source, /LoadVersionedInterface\(module, "SteamAPI_SteamUser"\)/);
  assert.match(source, /LoadVersionedInterface\(module, "SteamAPI_SteamUtils"\)/);
  assert.doesNotMatch(source, /SteamAPI_SteamUser_v\d{3}/);
  assert.doesNotMatch(source, /SteamAPI_SteamUtils_v\d{3}/);
});

test("Steam guest preload is CommonJS-safe and uses the shared IPC contract", () => {
  const source = readFileSync(resolve("src", "preload", "steam-guest-preload.cts"), "utf8");
  assert.match(source, /import type \{ SteamGuestApi, SteamGuestMethod, SteamGuestResult \}/);
  assert.doesNotMatch(source, /^import (?!type).*from "\.\.\/shared\/steam\.js";$/m);
  assert.match(source, /const STEAM_GUEST_IPC_CHANNEL = "shockless:steam-guest-call"/);
});

function successFrame(nonce: Buffer, ticket = FAKE_TICKET): Buffer {
  const frame = Buffer.alloc(STEAM_BRIDGE_HEADER_LENGTH + ticket.length);
  frame.write("SKSB", 0, "ascii");
  frame[4] = 1;
  frame[5] = 1;
  nonce.copy(frame, 6);
  frame[22] = 0;
  frame.writeUInt32LE(ORIGINS_STEAM_APP_ID, 23);
  frame.writeBigUInt64LE(76561198000000000n, 27);
  frame[35] = 1;
  frame.writeUInt16LE(ticket.length, 36);
  ticket.copy(frame, STEAM_BRIDGE_HEADER_LENGTH);
  return frame;
}
