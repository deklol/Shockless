import { timingSafeEqual } from "node:crypto";

export const STEAM_BRIDGE_NONCE_LENGTH = 16;
export const STEAM_BRIDGE_MAX_TICKET_LENGTH = 4_096;
export const STEAM_BRIDGE_HEADER_LENGTH = 38;

const MAGIC = Buffer.from("SKSB", "ascii");
const VERSION = 1;

export interface SteamBridgeCredentials {
  readonly appId: number;
  readonly steamId: bigint;
  readonly overlayEnabled: boolean;
  readonly ticket: Buffer;
}

export function expectedSteamBridgeFrameLength(header: Buffer): number | null {
  if (header.length < STEAM_BRIDGE_HEADER_LENGTH) return null;
  const ticketLength = header.readUInt16LE(36);
  if (ticketLength > STEAM_BRIDGE_MAX_TICKET_LENGTH) throw new Error("Steam bridge ticket length is invalid.");
  return STEAM_BRIDGE_HEADER_LENGTH + ticketLength;
}

export function parseSteamBridgeFrame(
  frame: Buffer,
  expectedNonce: Buffer,
  expectedAppId: number,
): SteamBridgeCredentials {
  if (frame.length < STEAM_BRIDGE_HEADER_LENGTH) throw new Error("Steam bridge frame is truncated.");
  if (!frame.subarray(0, 4).equals(MAGIC)) throw new Error("Steam bridge frame signature is invalid.");
  if (frame[4] !== VERSION) throw new Error("Steam bridge protocol version is unsupported.");
  const nonce = frame.subarray(6, 22);
  if (expectedNonce.length !== STEAM_BRIDGE_NONCE_LENGTH || !timingSafeEqual(nonce, expectedNonce)) {
    throw new Error("Steam bridge session identity is invalid.");
  }
  const appId = frame.readUInt32LE(23);
  if (appId !== expectedAppId) throw new Error("Steam bridge returned an unexpected AppID.");
  const expectedLength = expectedSteamBridgeFrameLength(frame);
  if (expectedLength !== frame.length) throw new Error("Steam bridge frame length is invalid.");
  const status = frame[5];
  const reason = frame[22];
  if (status === 0) throw new Error(steamBridgeFailureMessage(reason));
  const steamId = frame.readBigUInt64LE(27);
  const ticketLength = frame.readUInt16LE(36);
  if (status !== 1 || reason !== 0 || steamId === 0n || ticketLength === 0) {
    throw new Error("Steam bridge returned incomplete credentials.");
  }
  return {
    appId,
    steamId,
    overlayEnabled: (frame[35] & 1) !== 0,
    ticket: Buffer.from(frame.subarray(STEAM_BRIDGE_HEADER_LENGTH)),
  };
}

function steamBridgeFailureMessage(reason: number): string {
  switch (reason) {
    case 1: return "Steam bridge must run as a 32-bit process.";
    case 2: return "Steam API installation is unavailable.";
    case 3: return "Steam API could not be loaded.";
    case 4: return "Steam is not running or rejected initialization.";
    case 5: return "Steam user interfaces are unavailable.";
    case 6: return "Steam returned an unexpected AppID.";
    case 7: return "Steam is not logged in.";
    case 8: return "Steam did not issue an authentication ticket.";
    case 9: return "Installed Steam API exports are incompatible.";
    default: return "Steam bridge initialization failed.";
  }
}
