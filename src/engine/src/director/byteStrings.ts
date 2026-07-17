export function latin1BytesFromString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export function stringFromLatin1Bytes(bytes: Uint8Array): string {
  let output = "";
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return output;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Director 11+ Multiuser delivers text messages as Unicode. The Origins relay
 * forwards decrypted game packets as UTF-8 bytes, but unknown/binary payloads
 * must remain byte-preserving rather than being replaced with U+FFFD.
 */
export function stringFromUtf8Bytes(bytes: Uint8Array): string {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return stringFromLatin1Bytes(bytes);
  }
}
