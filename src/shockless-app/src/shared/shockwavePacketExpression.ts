import { encodeShockwaveBase64Int } from "./shockwavePacketText.js";

export type ShockwavePacketTarget = "server" | "client";

export type ShockwavePacketExpressionResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

export function parseShockwavePacketExpression(
  value: unknown,
  target: ShockwavePacketTarget,
): ShockwavePacketExpressionResult {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, message: "Packet input is empty." };

  const bytes: number[] = [];
  let literal = "";
  const flushLiteral = (): ShockwavePacketExpressionResult | null => {
    if (!literal) return null;
    for (let index = 0; index < literal.length; index += 1) {
      const code = literal.charCodeAt(index);
      if (code > 0xff) return { ok: false, message: `Packet text must be Latin-1; character ${index} is ${code}.` };
      bytes.push(code);
    }
    literal = "";
    return null;
  };

  for (let index = 0; index < text.length;) {
    if (text[index] === "[") {
      const flushed = flushLiteral();
      if (flushed) return flushed;
      const close = text.indexOf("]", index + 1);
      if (close < 0) return { ok: false, message: `Unclosed byte escape at character ${index}.` };
      const rawByte = text.slice(index + 1, close);
      if (!/^[0-9]{1,3}$/.test(rawByte)) return { ok: false, message: `Invalid byte escape [${rawByte}].` };
      const byte = Number.parseInt(rawByte, 10);
      if (byte > 255) return { ok: false, message: `Byte escape [${rawByte}] is outside 0..255.` };
      bytes.push(byte);
      index = close + 1;
      continue;
    }

    if (text[index] === "{") {
      const flushed = flushLiteral();
      if (flushed) return flushed;
      const token = readExpressionToken(text, index);
      if (!token.ok) return token;
      const encoded = encodeExpressionToken(token.kind, token.value, target);
      if (!encoded.ok) return encoded;
      bytes.push(...encoded.bytes);
      index = token.nextIndex;
      continue;
    }

    if (text[index] === "}") return { ok: false, message: `Unexpected } at character ${index}.` };
    literal += text[index];
    index += 1;
  }

  const flushed = flushLiteral();
  if (flushed) return flushed;
  if (bytes.length < 2) return { ok: false, message: "Shockwave packet must include a two-byte header." };
  return { ok: true, bytes: Uint8Array.from(bytes) };
}

type ExpressionTokenResult =
  | { readonly ok: true; readonly kind: string; readonly value: string; readonly nextIndex: number }
  | { readonly ok: false; readonly message: string };

function readExpressionToken(text: string, start: number): ExpressionTokenResult {
  if (text.startsWith('{s:"', start)) {
    let value = "";
    for (let index = start + 4; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === '"' && text[index + 1] === "}") {
        return { ok: true, kind: "s", value, nextIndex: index + 2 };
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = text[index + 1];
      if (escaped === '"' || escaped === "\\") value += escaped;
      else if (escaped === "r") value += "\r";
      else if (escaped === "n") value += "\n";
      else return { ok: false, message: `Unsupported string escape \\${escaped ?? ""}.` };
      index += 1;
    }
    return { ok: false, message: "Unterminated string expression." };
  }

  const close = text.indexOf("}", start + 1);
  if (close < 0) return { ok: false, message: `Unclosed expression at character ${start}.` };
  const body = text.slice(start + 1, close);
  const separator = body.indexOf(":");
  if (separator <= 0) return { ok: false, message: `Invalid expression {${body}}.` };
  return {
    ok: true,
    kind: body.slice(0, separator).trim().toLowerCase(),
    value: body.slice(separator + 1).trim(),
    nextIndex: close + 1,
  };
}

function encodeExpressionToken(
  kind: string,
  rawValue: string,
  target: ShockwavePacketTarget,
): ShockwavePacketExpressionResult {
  if (kind === "s") return encodeString(rawValue, target);
  if (kind === "b") {
    const normalized = rawValue.toLowerCase();
    if (normalized === "true" || normalized === "false") {
      return { ok: true, bytes: encodeVl64(normalized === "true" ? 1 : 0) };
    }
    const byte = parseInteger(rawValue, kind);
    if (!byte.ok) return byte;
    if (byte.value < 0 || byte.value > 255) return { ok: false, message: `{b:${rawValue}} must be within 0..255.` };
    return { ok: true, bytes: Uint8Array.of(byte.value) };
  }

  const parsed = parseInteger(rawValue, kind);
  if (!parsed.ok) return parsed;
  if (kind === "h") {
    if (parsed.value < 0 || parsed.value > 4095) return { ok: false, message: `{h:${rawValue}} must be within 0..4095.` };
    return { ok: true, bytes: Uint8Array.from(encodeShockwaveBase64Int(parsed.value, 2)) };
  }
  if (kind === "i") return { ok: true, bytes: encodeVl64(parsed.value) };
  if (kind === "u" || kind === "short") {
    if (target === "client") return { ok: true, bytes: encodeVl64(parsed.value) };
    if (parsed.value < 0 || parsed.value > 4095) return { ok: false, message: `{${kind}:${rawValue}} must be within 0..4095 for outgoing packets.` };
    return { ok: true, bytes: Uint8Array.from(encodeShockwaveBase64Int(parsed.value, 2)) };
  }
  return { ok: false, message: `Unsupported Shockwave expression type: ${kind}.` };
}

function encodeString(value: string, target: ShockwavePacketTarget): ShockwavePacketExpressionResult {
  const raw = latin1Bytes(value);
  if (!raw.ok) return raw;
  if (target === "client") return { ok: true, bytes: Uint8Array.from([...raw.bytes, 2]) };
  if (raw.bytes.length > 4095) return { ok: false, message: `Outgoing string is too long: ${raw.bytes.length} bytes.` };
  return { ok: true, bytes: Uint8Array.from([...encodeShockwaveBase64Int(raw.bytes.length, 2), ...raw.bytes]) };
}

function latin1Bytes(value: string): ShockwavePacketExpressionResult {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) return { ok: false, message: `String expression must be Latin-1; character ${index} is ${code}.` };
    bytes[index] = code;
  }
  return { ok: true, bytes };
}

function parseInteger(value: string, kind: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  if (!/^-?[0-9]+$/.test(value)) return { ok: false, message: `{${kind}:${value}} requires an integer.` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { ok: false, message: `{${kind}:${value}} is outside the safe integer range.` };
  return { ok: true, value: parsed };
}

function encodeVl64(value: number): Uint8Array {
  if (!Number.isInteger(value)) throw new Error(`VL64 value must be an integer: ${value}`);
  const negative = value < 0;
  let remaining = Math.abs(value);
  const bytes: number[] = [64 + (remaining & 0x03)];
  remaining = Math.floor(remaining / 4);
  while (remaining > 0) {
    bytes.push(64 + (remaining & 0x3f));
    remaining = Math.floor(remaining / 64);
  }
  if (bytes.length > 6) throw new Error(`VL64 value uses ${bytes.length} bytes; max supported is 6.`);
  bytes[0] = bytes[0]! | (bytes.length << 3) | (negative ? 0x04 : 0);
  return Uint8Array.from(bytes);
}
