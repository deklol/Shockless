import type { FishingRelayAction } from "./window-api.js";

export type FishingRelayPacketResult =
  | { readonly ok: true; readonly packet: Uint8Array; readonly note: string }
  | { readonly ok: false; readonly message: string };

export function buildFishingRelayPacketFromControl(record: Record<string, unknown>): FishingRelayPacketResult {
  const action = String(record.action ?? "");
  switch (action) {
    case "startFishing": {
      const areaId = parsePositiveControlInt(record.areaId ?? record.objectId ?? record.targetId, "areaId");
      if (!areaId.ok) return areaId;
      return {
        ok: true,
        packet: makePacket(1100, encodeVl64Bytes(areaId.value)),
        note: `Fishing start header=1100 areaId=${areaId.value}`,
      };
    }
    case "minigameInput": {
      const direction = String(record.direction ?? "").trim().toUpperCase();
      if (direction !== "L" && direction !== "R") return { ok: false, message: "Fishing minigame input direction must be L or R." };
      return {
        ok: true,
        packet: makePacket(1101, writeOutgoingStringBytes(direction)),
        note: `Fishing minigame input header=1101 direction=${direction}`,
      };
    }
    case "purchaseProduct": {
      const productCode = parseProductCode(record.productCode ?? record.code ?? record.productId);
      if (!productCode.ok) return productCode;
      return {
        ok: true,
        packet: makePacket(1104, writeOutgoingStringBytes(productCode.value)),
        note: `Fishing purchase product header=1104 code=${productCode.value}`,
      };
    }
    case "registerDerby":
      return { ok: true, packet: makePacket(1108), note: "Fishing derby register header=1108" };
    case "requestTokens":
      return { ok: true, packet: makePacket(1102), note: "Fishing request tokens header=1102" };
    case "requestProducts":
      return { ok: true, packet: makePacket(1103), note: "Fishing request products header=1103" };
    case "requestRodLevel":
      return { ok: true, packet: makePacket(1105), note: "Fishing request rod level header=1105" };
    case "requestStats":
      return { ok: true, packet: makePacket(1106), note: "Fishing request stats header=1106" };
    case "requestFishopedia":
      return { ok: true, packet: makePacket(1107), note: "Fishing request Fishopedia header=1107" };
    default:
      return { ok: false, message: `Unsupported Fishing relay action: ${action || "-"}.` };
  }
}

export function isAllowedFishingRelayAction(action: FishingRelayAction): boolean {
  return buildFishingRelayPacketFromControl(action as unknown as Record<string, unknown>).ok;
}

function makePacket(header: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  return concatBytes(latin1Bytes(encodeBase64Int(header, 2)), payload);
}

function writeOutgoingStringBytes(value: string): Uint8Array {
  return latin1Bytes(`${encodeBase64Int(value.length, 2)}${value}`);
}

function encodeVl64Bytes(value: number): Uint8Array {
  if (!Number.isInteger(value)) throw new Error(`VL64 value must be an integer: ${value}`);
  const negative = value < 0;
  let remaining = Math.abs(value);
  const bytes: number[] = [64 + (remaining & 0x03)];
  remaining = Math.floor(remaining / 4);
  while (remaining > 0) {
    bytes.push(64 + (remaining & 0x3f));
    remaining = Math.floor(remaining / 64);
  }
  if (bytes.length > 6) throw new Error(`VL64 value uses ${bytes.length} bytes; max supported is 6`);
  bytes[0] = bytes[0]! | (bytes.length << 3) | (negative ? 0x04 : 0);
  return Uint8Array.from(bytes);
}

function encodeBase64Int(value: number, width: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Shockwave base64 value must be a non-negative integer: ${value}`);
  const chars = new Array<number>(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    chars[index] = 0x40 + (remaining & 0x3f);
    remaining >>= 6;
  }
  if (remaining !== 0) throw new Error(`Shockwave base64 value ${value} does not fit in ${width} bytes`);
  return String.fromCharCode(...chars);
}

function parsePositiveControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Fishing relay ${label}: ${String(value ?? "")}.` };
  if (parsed <= 0) return { ok: false, message: `Invalid Fishing relay ${label}: ${parsed}.` };
  return { ok: true, value: parsed };
}

function parseProductCode(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const productCode = String(value ?? "").trim();
  if (!productCode) return { ok: false, message: "Fishing purchase product requires a product code." };
  if (productCode.length > 128) return { ok: false, message: "Fishing purchase product code is too long." };
  if (/[\u0000-\u001f\u007f]/.test(productCode)) return { ok: false, message: "Fishing purchase product code contains control characters." };
  return { ok: true, value: productCode };
}

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const value = text.charCodeAt(index);
    if (value > 0xff) throw new Error("Text cannot be encoded as Latin-1.");
    bytes[index] = value;
  }
  return bytes;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}
