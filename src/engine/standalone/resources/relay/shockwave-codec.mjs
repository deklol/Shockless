import crypto from "node:crypto";

const BASE64_ALPHABET = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "latin1");
const BASE64_REVERSE = new Uint8Array(256).fill(255);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_REVERSE[BASE64_ALPHABET[index]] = index;
}

export function encodeHabboBase64Int(value, width) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Habbo Base64 value must be a non-negative integer: ${value}`);
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Habbo Base64 width must be positive: ${width}`);
  }

  const output = Buffer.alloc(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = 0x40 + (remaining & 0x3f);
    remaining >>= 6;
  }
  if (remaining !== 0) {
    throw new Error(`Habbo Base64 value ${value} does not fit in ${width} bytes`);
  }
  return output;
}

export function decodeHabboBase64Int(input) {
  const bytes = Buffer.from(input);
  if (bytes.length === 0) {
    throw new Error("Cannot decode an empty Habbo Base64 integer");
  }

  let value = 0;
  for (const byte of bytes) {
    const digit = byte - 0x40;
    if (digit < 0 || digit >= 64) {
      throw new Error(`Invalid Habbo Base64 integer byte: ${byte}`);
    }
    value = (value << 6) | digit;
  }
  return value;
}

export function encodeHabboBase64Bytes(input) {
  const data = Buffer.from(input);
  const output = [];

  for (let index = 0; index < data.length; index += 3) {
    const first = data[index];
    const second = index + 1 < data.length ? data[index + 1] : 0;
    output.push(BASE64_ALPHABET[(first & 0xfc) >> 2]);
    output.push(BASE64_ALPHABET[((first & 0x03) << 4) | ((second & 0xf0) >> 4)]);

    if (index + 1 < data.length) {
      const third = index + 2 < data.length ? data[index + 2] : 0;
      output.push(BASE64_ALPHABET[((second & 0x0f) << 2) | ((third & 0xc0) >> 6)]);
      if (index + 2 < data.length) {
        output.push(BASE64_ALPHABET[third & 0x3f]);
      }
    }
  }

  return Buffer.from(output);
}

export function decodeHabboBase64Bytes(input) {
  const data = Buffer.from(input);
  const output = [];

  for (let index = 0; index < data.length; index += 4) {
    const first = decodeBase64Byte(data[index]);
    const second = decodeBase64Byte(data[index + 1]);
    const hasThird = index + 2 < data.length;
    const third = hasThird ? decodeBase64Byte(data[index + 2]) : 0;
    const hasFourth = index + 3 < data.length;
    const fourth = hasFourth ? decodeBase64Byte(data[index + 3]) : 0;

    output.push((first << 2) | ((second & 0x30) >> 4));
    if (hasThird) {
      output.push(((second & 0x0f) << 4) | ((third & 0x3c) >> 2));
      if (hasFourth) {
        output.push(((third & 0x03) << 6) | (fourth & 0x3f));
      }
    }
  }

  return Buffer.from(output);
}

export function packetHeaderId(packet) {
  const body = Buffer.from(packet);
  if (body.length < 2) {
    throw new Error("Shockwave packet body is missing its two-byte header");
  }
  return decodeHabboBase64Int(body.subarray(0, 2));
}

export function makePacket(headerId, payload = Buffer.alloc(0)) {
  return Buffer.concat([encodeHabboBase64Int(headerId, 2), Buffer.from(payload)]);
}

export function prependClientLength(packet) {
  const body = Buffer.from(packet);
  return Buffer.concat([encodeHabboBase64Int(body.length, 3), body]);
}

export function serverFrame(packet) {
  return Buffer.concat([Buffer.from(packet), Buffer.from([1])]);
}

export function writeOutgoingString(value) {
  const bytes = Buffer.from(String(value), "latin1");
  return Buffer.concat([encodeHabboBase64Int(bytes.length, 2), bytes]);
}

export function readOutgoingString(packet, offset = 2) {
  const body = Buffer.from(packet);
  const length = decodeHabboBase64Int(body.subarray(offset, offset + 2));
  const start = offset + 2;
  const end = start + length;
  if (end > body.length) {
    throw new Error(`Outgoing string declares ${length} bytes but packet has ${body.length - start}`);
  }
  return {
    value: body.subarray(start, end).toString("latin1"),
    offset: end
  };
}

export function writeIncomingString(value) {
  return Buffer.concat([Buffer.from(String(value), "latin1"), Buffer.from([2])]);
}

export function readIncomingString(packet, offset = 2) {
  const body = Buffer.from(packet);
  let end = body.indexOf(2, offset);
  if (end < 0) {
    end = body.length;
  }
  return {
    value: body.subarray(offset, end).toString("latin1"),
    offset: end + 1
  };
}

export class ClientPacketBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (chunk?.length > 0) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }
  }

  receive() {
    const packets = [];
    while (this.buffer.length >= 5) {
      const length = decodeHabboBase64Int(this.buffer.subarray(0, 3));
      if (this.buffer.length < length + 3) {
        break;
      }
      packets.push(this.buffer.subarray(3, 3 + length));
      this.buffer = this.buffer.subarray(3 + length);
    }
    return packets;
  }
}

export class ServerPacketBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (chunk?.length > 0) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }
  }

  receive() {
    const packets = [];
    while (true) {
      const end = this.buffer.indexOf(1);
      if (end < 0) {
        break;
      }
      if (end > 0) {
        packets.push(this.buffer.subarray(0, end));
      }
      this.buffer = this.buffer.subarray(end + 1);
    }
    return packets;
  }
}

export class EncryptedShockwaveChunkBuffer {
  constructor(headerStream, dataStream) {
    this.headerStream = headerStream;
    this.dataStream = dataStream;
    this.buffer = Buffer.alloc(0);
    this.previousLength = 0;
  }

  push(chunk) {
    if (chunk?.length > 0) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }
  }

  receive() {
    const chunks = [];
    while (this.buffer.length >= 6) {
      if (this.previousLength === 0) {
        const headerBytes = decodeHabboBase64Bytes(this.buffer.subarray(0, 6));
        if (headerBytes.length < 4) {
          throw new Error("Encrypted Shockwave header decoded to fewer than 4 bytes");
        }
        const decryptedHeader = this.headerStream.xor(headerBytes);
        this.previousLength = decodeHabboBase64Int(decryptedHeader.subarray(1, 4));
      }

      if (this.buffer.length < this.previousLength + 6) {
        break;
      }

      const encodedPayload = this.buffer.subarray(6, 6 + this.previousLength);
      const encryptedPayload = decodeHabboBase64Bytes(encodedPayload);
      chunks.push(this.dataStream.xor(encryptedPayload));
      this.buffer = this.buffer.subarray(6 + this.previousLength);
      this.previousLength = 0;
    }
    return chunks;
  }
}

export function encryptShockwaveChunk(plainChunk, headerStream, dataStream, headerLeadByte = randomHeaderLeadByte()) {
  const encryptedPayload = dataStream.xor(Buffer.from(plainChunk));
  const encodedPayload = encodeHabboBase64Bytes(encryptedPayload);
  const header = Buffer.alloc(4);
  header[0] = headerLeadByte;
  encodeHabboBase64Int(encodedPayload.length, 3).copy(header, 1);
  const encryptedHeader = headerStream.xor(header);
  return Buffer.concat([encodeHabboBase64Bytes(encryptedHeader), encodedPayload]);
}

function decodeBase64Byte(byte) {
  const value = BASE64_REVERSE[byte];
  if (value === 255) {
    throw new Error(`Invalid Shockwave Base64 byte: ${byte}`);
  }
  return value;
}

function randomHeaderLeadByte() {
  return crypto.randomInt(1, 127);
}
