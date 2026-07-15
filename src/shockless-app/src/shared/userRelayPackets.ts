import type { UserRelayAction } from "./window-api.js";

export type UserRelayPacketResult =
  | { readonly ok: true; readonly packet: Uint8Array; readonly note: string }
  | { readonly ok: false; readonly message: string };

export function buildUserRelayPacketFromControl(record: Record<string, unknown>): UserRelayPacketResult {
  const action = String(record.action ?? "");
  switch (action) {
    case "wave":
      return { ok: true, packet: makePacket(94), note: "User wave header=94" };
    case "stopDance":
      return { ok: true, packet: makePacket(93, encodeVl64Bytes(0)), note: "User stop dance header=93 number=0" };
    case "dance":
    case "hcdance": {
      const number = parseControlInt(action === "hcdance" && record.number === undefined ? 2 : record.number, "dance");
      if (!number.ok) return number;
      if (number.value < 0 || number.value > 4) return { ok: false, message: `Invalid User dance number: ${number.value}.` };
      return {
        ok: true,
        packet: makePacket(93, encodeVl64Bytes(number.value)),
        note: `User ${action === "hcdance" ? "hc dance" : "dance"} header=93 number=${number.value}`,
      };
    }
    case "carryDrink":
      return { ok: true, packet: makePacket(80, encodeVl64Bytes(5)), note: "User carry drink header=80 drink=5" };
    case "applyLook": {
      const figure = String(record.figure ?? "").trim();
      const validated = validateFigure(figure);
      if (!validated.ok) return validated;
      return {
        ok: true,
        packet: makeApplyLookPacket(figure),
        note: `User apply look header=44 figureLength=${figure.length}`,
      };
    }
    default:
      return { ok: false, message: `Unsupported User relay action: ${action || "-"}.` };
  }
}

export function isAllowedUserRelayAction(action: UserRelayAction): boolean {
  return buildUserRelayPacketFromControl(action as unknown as Record<string, unknown>).ok;
}

function makeApplyLookPacket(figure: string): Uint8Array {
  // Habbpy v3 UserTab builds exactly: @l@D<figure-length-b64><figure>@JH@AH@R@@.
  return latin1Bytes(`@l@D${encodeBase64Int(figure.length, 2)}${figure}@JH@AH@R@@`);
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

function validateFigure(figure: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (!figure) return { ok: false, message: "Apply Look needs a figure string." };
  if (figure.length > 4095) return { ok: false, message: `Apply Look figure is too long: ${figure.length}.` };
  for (const char of figure) {
    if (char.charCodeAt(0) > 0xff) return { ok: false, message: "Apply Look figure must be Latin-1/ASCII Shockwave text." };
  }
  return { ok: true };
}

function parseControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid relay ${label}: ${String(value ?? "")}.` };
  return { ok: true, value: parsed };
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
