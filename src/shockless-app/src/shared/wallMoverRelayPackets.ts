import type { WallMoverRelayAction } from "./window-api.js";

export type WallMoverRelayPacketResult =
  | { readonly ok: true; readonly packet: Uint8Array; readonly note: string }
  | { readonly ok: false; readonly message: string };

export function buildWallMoverRelayPacketFromControl(record: Record<string, unknown>): WallMoverRelayPacketResult {
  const action = String(record.action ?? "");
  switch (action) {
    case "moveItem": {
      const itemId = parsePositiveControlInt(record.itemId, "itemId");
      if (!itemId.ok) return itemId;
      const wallX = parseControlInt(record.wallX, "wallX");
      const wallY = parseControlInt(record.wallY, "wallY");
      const localX = parseControlInt(record.localX, "localX");
      const localY = parseControlInt(record.localY, "localY");
      if (!wallX.ok) return wallX;
      if (!wallY.ok) return wallY;
      if (!localX.ok) return localX;
      if (!localY.ok) return localY;
      const orientation = normalizeOrientation(record.orientation);
      if (!orientation.ok) return orientation;
      const location = formatWallLocation(wallX.value, wallY.value, localX.value, localY.value, orientation.value);
      return {
        ok: true,
        packet: makePacket(91, concatBytes(encodeVl64Bytes(itemId.value), writeOutgoingStringBytes(location))),
        note: `Wall Mover move item header=91 itemId=${itemId.value} location=${location}`,
      };
    }
    case "pickup": {
      const itemId = parsePositiveControlInt(record.itemId, "itemId");
      if (!itemId.ok) return itemId;
      const className = String(record.className ?? "").trim();
      return {
        ok: true,
        packet: makePacket(67, latin1Bytes(String(itemId.value))),
        note: `Wall Mover pickup header=67 itemId=${itemId.value}${className ? ` class=${className}` : ""}`,
      };
    }
    default:
      return { ok: false, message: `Unsupported Wall Mover relay action: ${action || "-"}.` };
  }
}

export function isAllowedWallMoverRelayAction(action: WallMoverRelayAction): boolean {
  return buildWallMoverRelayPacketFromControl(action as unknown as Record<string, unknown>).ok;
}

export function formatWallLocation(wallX: number, wallY: number, localX: number, localY: number, orientation: "l" | "r"): string {
  return `:w=${wallX},${wallY} l=${localX},${localY} ${orientation}`;
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
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Wall Mover ${label}: ${String(value ?? "")}.` };
  if (Math.abs(parsed) > 1000000) return { ok: false, message: `Wall Mover ${label} is out of range: ${parsed}.` };
  return { ok: true, value: parsed };
}

function parsePositiveControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = parseControlInt(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) return { ok: false, message: `Wall Mover ${label} must be positive: ${parsed.value}.` };
  return parsed;
}

function normalizeOrientation(value: unknown): { readonly ok: true; readonly value: "l" | "r" } | { readonly ok: false; readonly message: string } {
  const orientation = String(value ?? "").trim().toLowerCase();
  if (orientation === "l" || orientation === "r") return { ok: true, value: orientation };
  return { ok: false, message: `Wall Mover orientation must be l or r: ${String(value ?? "")}.` };
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
