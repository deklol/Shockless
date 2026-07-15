import type { SocialRelayAction } from "./window-api.js";

export type SocialRelayPacketResult =
  | { readonly ok: true; readonly packet: Uint8Array; readonly note: string }
  | { readonly ok: false; readonly message: string };

export function buildSocialRelayPacketFromControl(record: Record<string, unknown>): SocialRelayPacketResult {
  const action = String(record.action ?? "");
  switch (action) {
    case "message": {
      const accountId = parseControlInt(record.accountId, "accountId");
      if (!accountId.ok) return accountId;
      if (accountId.value <= 0) return { ok: false, message: `Invalid message account id: ${accountId.value}.` };
      const message = String(record.message ?? "").trim();
      const validated = validateShockwaveText(message, "message", 4095);
      if (!validated.ok) return validated;
      const recipient = String(record.recipient ?? "").trim();
      return {
        ok: true,
        packet: makePacket(33, concatBytes(concatBytes(encodeVl64Bytes(1), encodeVl64Bytes(accountId.value)), writeOutgoingStringBytes(message))),
        note: `Social private message header=33 accountId=${accountId.value}${recipient ? ` recipient=${recipient}` : ""}`,
      };
    }
    case "addUser": {
      const name = String(record.name ?? "").trim();
      const validated = validateShockwaveText(name, "friend request name", 128);
      if (!validated.ok) return validated;
      return {
        ok: true,
        packet: makePacket(39, writeOutgoingStringBytes(name)),
        note: `Social friend request header=39 name=${name}`,
      };
    }
    case "refreshFriendRequests":
      return {
        ok: true,
        packet: makePacket(233),
        note: "Social friend request refresh header=233",
      };
    case "acceptRequest": {
      const accountId = parsePositiveControlInt(record.accountId, "accountId");
      if (!accountId.ok) return accountId;
      return {
        ok: true,
        packet: makePacket(37, accountIdListPayload([accountId.value])),
        note: `Social accept friend request header=37 accountId=${accountId.value}`,
      };
    }
    case "declineRequest": {
      const accountId = parsePositiveControlInt(record.accountId, "accountId");
      if (!accountId.ok) return accountId;
      return {
        ok: true,
        packet: makePacket(38, concatBytes(encodeVl64Bytes(0), accountIdListPayload([accountId.value]))),
        note: `Social decline friend request header=38 accountId=${accountId.value}`,
      };
    }
    case "removeFriend": {
      const accountId = parsePositiveControlInt(record.accountId, "accountId");
      if (!accountId.ok) return accountId;
      const name = String(record.name ?? "").trim();
      return {
        ok: true,
        packet: makePacket(40, accountIdListPayload([accountId.value])),
        note: `Social remove friend header=40 accountId=${accountId.value}${name ? ` name=${name}` : ""}`,
      };
    }
    case "followFriend": {
      const accountId = parsePositiveControlInt(record.accountId, "accountId");
      if (!accountId.ok) return accountId;
      const name = String(record.name ?? "").trim();
      return {
        ok: true,
        packet: makePacket(262, encodeVl64Bytes(accountId.value)),
        note: `Social follow friend header=262 accountId=${accountId.value}${name ? ` name=${name}` : ""}`,
      };
    }
    default:
      return { ok: false, message: `Unsupported Social relay action: ${action || "-"}.` };
  }
}

export function isAllowedSocialRelayAction(action: SocialRelayAction): boolean {
  return buildSocialRelayPacketFromControl(action as unknown as Record<string, unknown>).ok;
}

function makePacket(header: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  return concatBytes(latin1Bytes(encodeBase64Int(header, 2)), payload);
}

function writeOutgoingStringBytes(value: string): Uint8Array {
  return latin1Bytes(`${encodeBase64Int(value.length, 2)}${value}`);
}

function accountIdListPayload(accountIds: readonly number[]): Uint8Array {
  return concatMany([encodeVl64Bytes(accountIds.length), ...accountIds.map((accountId) => encodeVl64Bytes(accountId))]);
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

function validateShockwaveText(value: string, label: string, maxLength: number): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (!value) return { ok: false, message: `Social ${label} is required.` };
  if (value.length > maxLength) return { ok: false, message: `Social ${label} is too long: ${value.length}.` };
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 0xff || code === 0x00 || code === 0x02) {
      return { ok: false, message: `Social ${label} must be Latin-1 Shockwave text without NUL/STX separators.` };
    }
  }
  return { ok: true };
}

function parseControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed)) return { ok: false, message: `Invalid Social relay ${label}: ${String(value ?? "")}.` };
  return { ok: true, value: parsed };
}

function parsePositiveControlInt(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = parseControlInt(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) return { ok: false, message: `Invalid Social relay ${label}: ${parsed.value}.` };
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
