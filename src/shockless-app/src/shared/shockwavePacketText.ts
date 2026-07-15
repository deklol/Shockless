export function encodeShockwaveBase64Int(value: number, width: number): readonly number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Shockwave base64 value must be a non-negative integer: ${value}`);
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Shockwave base64 width must be positive: ${width}`);
  }

  const output = new Array<number>(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = 0x40 + (remaining & 0x3f);
    remaining >>= 6;
  }
  if (remaining !== 0) {
    throw new Error(`Shockwave base64 value ${value} does not fit in ${width} bytes`);
  }
  return output;
}

export function formatShockwavePacketText(packet: Iterable<number>): string {
  let text = "";
  for (const rawValue of packet) {
    const value = rawValue & 0xff;
    const signed = value < 128 ? value : value - 256;
    if ((signed >= 0 && signed < 32) || signed < -96 || value === 91 || value === 93 || value === 123 || value === 125 || value === 127) {
      text += `[${value}]`;
    } else {
      text += String.fromCharCode(value);
    }
  }
  return text;
}

export function formatShockwavePacketParts(header: number | null, bodyBytes: Iterable<number> | null): string {
  if (header === null || !Number.isFinite(header)) return "";
  return formatShockwavePacketText([...encodeShockwaveBase64Int(header, 2), ...(bodyBytes ?? [])]);
}
