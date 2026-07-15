import type { GardeningRelayAction } from "./window-api.js";

export type GardeningRelayPacketResult =
  | { readonly ok: true; readonly packet: Uint8Array; readonly note: string }
  | { readonly ok: false; readonly message: string };

export function buildGardeningRelayPacketFromControl(record: Record<string, unknown>): GardeningRelayPacketResult {
  const action = String(record.action ?? "");
  const objectId = parsePositiveControlInt(record.objectId, "objectId");
  if (!objectId.ok) return objectId;

  if (action === "move") {
    const x = parseControlInt(record.x, "x");
    const y = parseControlInt(record.y, "y");
    const direction = parseControlInt(record.direction, "direction");
    if (!x.ok) return x;
    if (!y.ok) return y;
    if (!direction.ok) return direction;
    return {
      ok: true,
      packet: makePacket(73, concatMany([encodeVl64Bytes(objectId.value), encodeVl64Bytes(x.value), encodeVl64Bytes(y.value), encodeVl64Bytes(direction.value)])),
      note: `Gardening move header=73 objectId=${objectId.value} x=${x.value} y=${y.value} direction=${direction.value}`,
    };
  }

  const headerByAction: Record<string, number> = {
    water: 540,
    harvest: 541,
    compost: 1115,
  };
  const header = headerByAction[action];
  if (!header) return { ok: false, message: `Unsupported Gardening relay action: ${action || "-"}.` };
  return {
    ok: true,
    packet: makePacket(header, writeOutgoingStringBytes(String(objectId.value))),
    note: `Gardening ${action} header=${header} objectId=${objectId.value}`,
  };
}

export function isAllowedGardeningRelayAction(action: GardeningRelayAction): boolean {
  return buildGardeningRelayPacketFromControl(action as unknown as Record<string, unknown>).ok;
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

function parseControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Gardening relay ${label}: ${String(value ?? "")}.` };
  return { ok: true, value: parsed };
}

function parsePositiveControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = parseControlInt(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) return { ok: false, message: `Invalid Gardening relay ${label}: ${parsed.value}.` };
  return parsed;
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

function concatMany(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}
