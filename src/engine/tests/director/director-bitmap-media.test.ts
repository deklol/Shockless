import { describe, expect, it } from "vitest";
import { decodeDirectorBitmapMedia, unpackDirectorPackBits } from "../../src/director/directorBitmapMedia";
import { LingoImage } from "../../src/director/imaging";
import { paletteTableForBitmapDepth } from "../../src/director/palettes";
import { symbol } from "../../src/director/values";

const PHOTO_CHECKSUM_TABLE = [
  1764, 9932, 4128, 2847, 3797, 8964, 9635, 5911, 8697, 7642,
  9017, 1437, 5576, 2304, 4660, 2591, 8453, 7274, 9706, 3243,
  3911, 395, 8559, 8257, 3336, 3407, 5917, 2590, 5228, 1918,
  5113, 9384, 2276, 655, 7487, 5586, 9717, 6731, 674, 1264,
  6445, 4663, 7572, 9080, 6291, 852, 5835, 2082, 7378, 3998,
  4514, 6811, 7881, 3544, 3941, 4810, 455, 6193, 5564, 4422,
  3575, 3043, 7328, 721, 2696, 1450, 6414, 9122, 1006, 1307,
  8598, 3871, 7731, 7707, 2788, 559, 4404, 6935, 4254, 7743,
  8780, 5507, 9428, 9559, 1569, 5403, 3064, 5871, 9457, 3519,
  6990, 7475, 9792, 7686, 5686, 6557, 9290, 7985, 977, 2525,
];

function makeIndexedImage(width = 160, height = 100): LingoImage {
  const indices = new Uint8Array(width * height);
  for (let index = 0; index < indices.length; index += 1) {
    indices[index] = (index * 31 + Math.floor(index / width) * 17) & 0xff;
  }
  return LingoImage.fromPaletteIndices(
    width,
    height,
    indices,
    paletteTableForBitmapDepth("grayscale", 8),
    symbol("grayscale"),
    8,
  );
}

function photoChecksum(image: LingoImage): number {
  let value = 0;
  for (let index = 1; index <= 100; index += 1) {
    const x = index % image.width;
    const y = (index * index) % image.height;
    const paletteIndex = image.getPixel(x, y).paletteIndex ?? 0;
    value = (value + paletteIndex * PHOTO_CHECKSUM_TABLE[index % PHOTO_CHECKSUM_TABLE.length]!) % 85000;
  }
  return value;
}

function buildDirectorBitmapMedia(options: {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 1 | 2 | 4 | 8;
  readonly packedRows: readonly number[];
  readonly palette?: number;
}): Uint8Array {
  const rowBytes = Math.ceil((options.width * options.bitDepth) / 8);
  const packed = packLiteralRows(options.packedRows);
  const bytes: number[] = [
    0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  writeUInt16BE(bytes, 0x8000 | rowBytes);
  writeInt16BE(bytes, 0);
  writeInt16BE(bytes, 0);
  writeInt16BE(bytes, options.height);
  writeInt16BE(bytes, options.width);
  bytes.push(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  writeUInt16BE(bytes, 0);
  writeUInt16BE(bytes, 0);
  bytes.push(0xc0, options.bitDepth);
  writeInt32BE(bytes, options.palette ?? -2);
  writeUInt32BE(bytes, 0x01000000);
  bytes.push(0x44, 0x54, 0x49, 0x42);
  writeUInt32LE(bytes, packed.length);
  bytes.push(...packed);
  return new Uint8Array(bytes);
}

function packLiteralRows(bytes: readonly number[]): number[] {
  return [bytes.length - 1, ...bytes];
}

function writeUInt16BE(output: number[], value: number): void {
  output.push((value >>> 8) & 0xff, value & 0xff);
}

function writeInt16BE(output: number[], value: number): void {
  writeUInt16BE(output, value & 0xffff);
}

function writeUInt32BE(output: number[], value: number): void {
  output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeInt32BE(output: number[], value: number): void {
  writeUInt32BE(output, value >>> 0);
}

function writeUInt32LE(output: number[], value: number): void {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

describe("Director bitmap media", () => {
  it("returns exact palette indexes from decoded indexed images without requiring canvas materialization", () => {
    const image = makeIndexedImage(8, 8);
    expect(image.getPixel(3, 4).paletteIndex).toBe((4 * 8 + 3) * 31 + 4 * 17 & 0xff);
  });

  it("preserves Habbo photo checksum indexes across Director media encode/decode", () => {
    const image = makeIndexedImage();
    const media = image.toDirectorBitmapMedia();
    const decoded = decodeDirectorBitmapMedia(media.bytes);
    expect(decoded).not.toBeNull();
    expect(photoChecksum(decoded!)).toBe(photoChecksum(image));
  });

  it("detects valid Director bitmap headers when the wrapper preamble differs", () => {
    const image = makeIndexedImage(80, 40);
    const media = image.toDirectorBitmapMedia();
    const shifted = new Uint8Array(12 + media.bytes.length - 28);
    shifted.fill(0x55, 0, 12);
    shifted.set(media.bytes.subarray(28), 12);
    const decoded = decodeDirectorBitmapMedia(shifted);
    expect(decoded).not.toBeNull();
    expect(photoChecksum(decoded!)).toBe(photoChecksum(image));
  });

  it("decodes 4-bit grayscale Director bitmap media without losing palette indexes", () => {
    const media = buildDirectorBitmapMedia({
      width: 4,
      height: 2,
      bitDepth: 4,
      packedRows: [0x12, 0x3f, 0x45, 0x60],
    });

    const decoded = decodeDirectorBitmapMedia(media);

    expect(decoded).not.toBeNull();
    expect(decoded!.depth).toBe(4);
    expect(decoded!.getPixel(0, 0).paletteIndex).toBe(1);
    expect(decoded!.getPixel(1, 0).paletteIndex).toBe(2);
    expect(decoded!.getPixel(2, 0).paletteIndex).toBe(3);
    expect(decoded!.getPixel(3, 0).paletteIndex).toBe(15);
    expect(decoded!.getPixel(0, 1).paletteIndex).toBe(4);
    expect(decoded!.getPixel(1, 1).paletteIndex).toBe(5);
    expect(decoded!.getPixel(2, 1).paletteIndex).toBe(6);
    expect(decoded!.getPixel(3, 1).paletteIndex).toBe(0);
  });

  it("accepts Director bitmap media that references a non-grayscale palette", () => {
    const media = buildDirectorBitmapMedia({
      width: 3,
      height: 1,
      bitDepth: 8,
      palette: 0,
      packedRows: [1, 2, 3],
    });

    const decoded = decodeDirectorBitmapMedia(media);

    expect(decoded).not.toBeNull();
    expect(decoded!.paletteRef).toBe(symbol("systemMac"));
    expect(decoded!.getPixel(0, 0).paletteIndex).toBe(1);
    expect(decoded!.getPixel(1, 0).paletteIndex).toBe(2);
    expect(decoded!.getPixel(2, 0).paletteIndex).toBe(3);
  });

  it("bounds PackBits repeat and literal runs to the requested output length", () => {
    expect([...unpackDirectorPackBits(new Uint8Array([0xff, 0xab]), 4)]).toEqual([0xab, 0xab, 0, 0]);
    expect([...unpackDirectorPackBits(new Uint8Array([0x7f, 1, 2, 3]), 2)]).toEqual([1, 2]);
    expect([...unpackDirectorPackBits(new Uint8Array([0x80, 0xee]), 256)]).toHaveLength(256);
  });

  it("fuzzes PackBits payloads without escaping the expected buffer", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const output = unpackDirectorPackBits(seededBytes(seed, (seed % 13) + 1), 64);
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBe(64);
    }
  });
});

function seededBytes(seed: number, length: number): Uint8Array {
  let state = seed >>> 0;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}
