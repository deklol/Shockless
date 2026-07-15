export type RoomRelayPacketBuild =
  | { readonly ok: true; readonly packets: readonly RoomRelayPacket[]; readonly note: string }
  | { readonly ok: false; readonly message: string };

export interface RoomRelayPacket {
  readonly packet: Uint8Array;
  readonly note: string;
}

export function buildRoomRelayPacketsFromControl(record: Record<string, unknown>): RoomRelayPacketBuild {
  const action = String(record.action ?? "");
  switch (action) {
    case "move": {
      const x = parseBoundedControlInt(record.x, "x");
      const y = parseBoundedControlInt(record.y, "y");
      const furniId = parseNonNegativeControlInt(record.furniId ?? 0, "furniId");
      if (!x.ok) return x;
      if (!y.ok) return y;
      if (!furniId.ok) return furniId;
      return {
        ok: true,
        note: `Room move avatar ${x.value},${y.value}`,
        packets: [
          {
            packet: makePacket(1269, concatMany([encodeVl64Bytes(x.value), encodeVl64Bytes(y.value), encodeVl64Bytes(furniId.value)])),
            note: `Room ORIGINS_MOVE header=1269 x=${x.value} y=${y.value} furniId=${furniId.value}`,
          },
        ],
      };
    }
    case "leave": {
      return {
        ok: true,
        note: "Room leave current room",
        packets: [{ packet: makePacket(53), note: "Room QUIT header=53" }],
      };
    }
    case "visitPrivateRoom": {
      const roomId = parsePositiveControlInt(record.roomId ?? record.flatId, "roomId");
      if (!roomId.ok) return roomId;
      const roomIdText = String(roomId.value);
      const directoryPayload = concatMany([encodeVl64Bytes(0), encodeVl64Bytes(roomId.value), encodeVl64Bytes(0)]);
      return {
        ok: true,
        note: `Room visit private room ${roomIdText}`,
        packets: [
          { packet: makePacket(21, latin1Bytes(roomIdText)), note: `Room visit GETFLATINFO header=21 roomId=${roomIdText}` },
          { packet: makePacket(182, latin1Bytes("general")), note: `Room visit GETINTERST header=182 roomId=${roomIdText}` },
          { packet: makePacket(2, directoryPayload), note: `Room visit ROOM_DIRECTORY header=2 roomId=${roomIdText}` },
          { packet: makePacket(57, latin1Bytes(roomIdText)), note: `Room visit TRYFLAT header=57 roomId=${roomIdText}` },
          { packet: makePacket(59, latin1Bytes(roomIdText)), note: `Room visit GOTOFLAT header=59 roomId=${roomIdText}` },
        ],
      };
    }
    default:
      return { ok: false, message: `Unsupported Room relay action: ${action || "-"}.` };
  }
}

export function isAllowedRoomRelayAction(action: Record<string, unknown>): boolean {
  return buildRoomRelayPacketsFromControl(action).ok;
}

function makePacket(header: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  return concatBytes(latin1Bytes(encodeBase64Int(header, 2)), payload);
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
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Room relay ${label}: ${String(value ?? "")}.` };
  if (parsed <= 0) return { ok: false, message: `Room relay ${label} must be positive: ${parsed}.` };
  return { ok: true, value: parsed };
}

function parseNonNegativeControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Room relay ${label}: ${String(value ?? "")}.` };
  if (parsed < 0) return { ok: false, message: `Room relay ${label} must be non-negative: ${parsed}.` };
  return { ok: true, value: parsed };
}

function parseBoundedControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = parseNonNegativeControlInt(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value > 1000) return { ok: false, message: `Room relay ${label} is out of range: ${parsed.value}.` };
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
