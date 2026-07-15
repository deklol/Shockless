import { encodeShockwaveBase64Int } from "../../../shared/shockwavePacketText";

export function latin1ByteArray(text: string): readonly number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const value = text.charCodeAt(index);
    if (value > 0xff) throw new Error("Text cannot be encoded as Latin-1.");
    bytes.push(value);
  }
  return bytes;
}

export function shockwaveVl64ByteArray(value: number): readonly number[] {
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
  return bytes;
}

export function shockwaveOutgoingStringByteArray(value: string): readonly number[] {
  return [...encodeShockwaveBase64Int(value.length, 2), ...latin1ByteArray(value)];
}

export function decodeShockwaveVl64Text(value: string): number | null {
  if (!value) return null;
  const bytes = latin1ByteArray(value);
  const first = bytes[0];
  if (first === undefined || first < 64) return null;
  const length = (first >> 3) & 0x07;
  if (length <= 0 || bytes.length < length) return null;
  let result = first & 0x03;
  let shift = 2;
  for (let index = 1; index < length; index += 1) {
    result += (bytes[index]! & 0x3f) << shift;
    shift += 6;
  }
  return (first & 0x04) !== 0 ? -result : result;
}
