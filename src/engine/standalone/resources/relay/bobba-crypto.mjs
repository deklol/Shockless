import crypto from "node:crypto";

export const BOBBA_G = 23786635532332886537261431906453031264918297n;
export const BOBBA_P = 632158881801130885249042417232212770524741295422564233061391190031954228421232913648184592218883487397503624904102572293826728806813079n;

const HKDF_SALT = Buffer.from("BobbaXtraHKDFSalt", "latin1");
const HKDF_INFO_PREFIX = Buffer.from("BobbaXtra|", "latin1");

export class BobbaChaChaStream {
  constructor(key, nonce) {
    this.key = Buffer.from(key);
    this.nonce = Buffer.from(nonce);
    this.packetCounter = 0n;

    if (this.key.length !== 32) {
      throw new Error(`Bobba ChaCha key must be 32 bytes, got ${this.key.length}`);
    }
    if (this.nonce.length !== 12) {
      throw new Error(`Bobba ChaCha nonce must be 12 bytes, got ${this.nonce.length}`);
    }
  }

  nextNonce() {
    const nonce = Buffer.from(this.nonce);
    const base = nonce.readBigUInt64LE(4);
    nonce.writeBigUInt64LE((base + this.packetCounter) & 0xffffffffffffffffn, 4);
    this.packetCounter += 1n;
    return nonce;
  }

  xor(data) {
    return chacha20Xor(this.key, this.nextNonce(), data);
  }
}

export class BobbaCrypto {
  constructor(options = {}) {
    this.privateKey = options.privateKey === undefined
      ? randomNonZeroUInt64()
      : BigInt(options.privateKey);
    if (this.privateKey <= 0n) {
      throw new Error("Bobba private key must be a positive integer");
    }

    this.publicKey = modPow(BOBBA_G, this.privateKey, BOBBA_P);
    this.sharedKey = undefined;
    this.c2sData = undefined;
    this.c2sHeader = undefined;
    this.s2cData = undefined;
    this.s2cHeader = undefined;
  }

  publicKeyString() {
    return this.publicKey.toString(10);
  }

  setPeerPublicKey(publicKey) {
    const peer = BigInt(String(publicKey));
    if (peer <= 0n || peer >= BOBBA_P) {
      throw new Error("Bobba peer public key is outside the expected field");
    }

    this.sharedKey = modPow(peer, this.privateKey, BOBBA_P);
    const sharedBytes = bigIntToMinimalBytes(this.sharedKey);
    this.c2sData = createStream(sharedBytes, "bobba-c2s-data");
    this.c2sHeader = createStream(sharedBytes, "bobba-c2s-header");
    this.s2cData = createStream(sharedBytes, "bobba-s2c-data");
    this.s2cHeader = createStream(sharedBytes, "bobba-s2c-header");
  }

  get ready() {
    return Boolean(this.sharedKey && this.c2sData && this.c2sHeader && this.s2cData && this.s2cHeader);
  }

  requireReady() {
    if (!this.ready) {
      throw new Error("Bobba crypto keys are not ready");
    }
  }
}

export function applyBobbaChaCha(data, stream) {
  return stream.xor(Buffer.from(data));
}

export function hkdfSha256(inputKeyMaterial, info, length) {
  const ikm = Buffer.from(inputKeyMaterial);
  const infoBytes = Buffer.isBuffer(info) ? info : Buffer.from(String(info), "latin1");
  const pseudoRandomKey = crypto.createHmac("sha256", HKDF_SALT).update(ikm).digest();
  const output = [];
  let previous = Buffer.alloc(0);
  let totalLength = 0;
  let counter = 1;

  while (totalLength < length) {
    previous = crypto
      .createHmac("sha256", pseudoRandomKey)
      .update(previous)
      .update(HKDF_INFO_PREFIX)
      .update(infoBytes)
      .update(Buffer.from([counter]))
      .digest();
    output.push(previous);
    totalLength += previous.length;
    counter += 1;
  }

  return Buffer.concat(output, totalLength).subarray(0, length);
}

export function chacha20Xor(key, nonce, data, initialCounter = 0) {
  const input = Buffer.from(data);
  const output = Buffer.alloc(input.length);
  const blockCount = Math.ceil(input.length / 64);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const block = chacha20Block(key, initialCounter + blockIndex, nonce);
    const start = blockIndex * 64;
    const end = Math.min(start + 64, input.length);
    for (let index = start; index < end; index += 1) {
      output[index] = input[index] ^ block[index - start];
    }
  }

  return output;
}

export function chacha20Block(keyInput, counter, nonceInput) {
  const key = Buffer.from(keyInput);
  const nonce = Buffer.from(nonceInput);
  if (key.length !== 32) {
    throw new Error(`ChaCha20 key must be 32 bytes, got ${key.length}`);
  }
  if (nonce.length !== 12) {
    throw new Error(`ChaCha20 nonce must be 12 bytes, got ${nonce.length}`);
  }

  const constants = Buffer.from("expand 32-byte k", "latin1");
  const state = new Uint32Array(16);
  state[0] = constants.readUInt32LE(0);
  state[1] = constants.readUInt32LE(4);
  state[2] = constants.readUInt32LE(8);
  state[3] = constants.readUInt32LE(12);
  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = key.readUInt32LE(index * 4);
  }
  state[12] = counter >>> 0;
  state[13] = nonce.readUInt32LE(0);
  state[14] = nonce.readUInt32LE(4);
  state[15] = nonce.readUInt32LE(8);

  const working = new Uint32Array(state);
  for (let round = 0; round < 10; round += 1) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  const output = Buffer.alloc(64);
  for (let index = 0; index < 16; index += 1) {
    output.writeUInt32LE((working[index] + state[index]) >>> 0, index * 4);
  }
  return output;
}

export function bigIntToMinimalBytes(value) {
  if (value === 0n) {
    return Buffer.from([0]);
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex");
}

function createStream(sharedBytes, label) {
  const material = hkdfSha256(sharedBytes, Buffer.from(label, "latin1"), 44);
  return new BobbaChaChaStream(material.subarray(0, 32), material.subarray(32));
}

function randomNonZeroUInt64() {
  while (true) {
    const value = crypto.randomBytes(8).readBigUInt64BE(0);
    if (value !== 0n) {
      return value;
    }
  }
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let current = base % modulus;
  let remaining = exponent;

  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) {
      result = (result * current) % modulus;
    }
    current = (current * current) % modulus;
    remaining >>= 1n;
  }

  return result;
}

function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft32(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft32(state[b] ^ state[c], 7);
}

function rotateLeft32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
