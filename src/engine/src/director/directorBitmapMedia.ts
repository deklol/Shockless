import { LingoColor } from "./geometry";
import { LingoImage } from "./imaging";
import { paletteTableForBitmapDepth } from "./palettes";
import { LingoSymbol } from "./values";

const DIRECTOR_PHOTO_CAST_PROPERTY_BYTES = [
  0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
] as const;

const DIRECTOR_BITMAP_MEDIA_HEADER_BYTES = 40;

interface DirectorBitmapMediaHeader {
  offset: number;
  rowBytes: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
  bitDepth: number;
  palette: number;
  paletteName: string;
  fourCC: string;
  minRowBytes: number;
  packedOffset: number;
  packedLength: number;
}

export interface DirectorBitmapMediaInspection {
  readonly bytes: number;
  readonly prefix: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly offset?: number;
  readonly rowBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly bitDepth?: number;
  readonly palette?: number;
  readonly paletteName?: string;
  readonly fourCC?: string;
  readonly packedLength?: number;
  readonly minRowBytes?: number;
}

export function decodeDirectorBitmapMedia(bytes: Uint8Array): LingoImage | null {
  const header = findDirectorBitmapMediaHeader(bytes);
  if (!header) return null;
  const packedEnd = Math.min(bytes.length, header.packedOffset + header.packedLength);
  const decoded = unpackDirectorPackBits(bytes.subarray(header.packedOffset, packedEnd), header.rowBytes * header.height);
  const cropped = new Uint8Array(header.width * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const src = y * header.rowBytes;
    const dest = y * header.width;
    cropped.set(unpackBitmapRowIndices(decoded.subarray(src, src + header.rowBytes), header.width, header.bitDepth), dest);
  }
  return LingoImage.fromPaletteIndices(
    header.width,
    header.height,
    cropped,
    paletteTableForBitmapDepth(header.paletteName, header.bitDepth),
    LingoSymbol.for(header.paletteName),
    header.bitDepth,
  );
}

export function inspectDirectorBitmapMedia(bytes: Uint8Array): DirectorBitmapMediaInspection {
  const header = findDirectorBitmapMediaHeader(bytes);
  if (header) {
    return {
      bytes: bytes.length,
      prefix: hexPrefix(bytes),
      accepted: true,
      reason: "supported-director-bitmap",
      offset: header.offset,
      rowBytes: header.rowBytes,
      width: header.width,
      height: header.height,
      bitDepth: header.bitDepth,
      palette: header.palette,
      paletteName: header.paletteName,
      fourCC: header.fourCC,
      packedLength: header.packedLength,
      minRowBytes: header.minRowBytes,
    };
  }

  const candidate = findDirectorBitmapMediaCandidate(bytes);
  return {
    bytes: bytes.length,
    prefix: hexPrefix(bytes),
    accepted: false,
    reason: candidate?.reason ?? "no-director-bitmap-header",
    offset: candidate?.offset,
    rowBytes: candidate?.rowBytes,
    width: candidate?.width,
    height: candidate?.height,
    bitDepth: candidate?.bitDepth,
    palette: candidate?.palette,
    paletteName: candidate?.paletteName,
    fourCC: candidate?.fourCC,
    packedLength: candidate?.packedLength,
    minRowBytes: candidate?.minRowBytes,
  };
}

export function encodeDirectorBitmapMedia(image: LingoImage): Uint8Array {
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  const rowBytes = width + (width % 2);
  const indices = new Uint8Array(rowBytes * height);
  const indexed = image.directorBitmapMediaSource();
  if (indexed) {
    for (let y = 0; y < height; y += 1) {
      indices.set(indexed.indices.subarray(y * width, y * width + width), y * rowBytes);
    }
  } else if (image.context) {
    const pixels = image.context.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = (y * width + x) * 4;
        indices[y * rowBytes + x] = grayscalePaletteIndex(
          pixels[source] ?? 255,
          pixels[source + 1] ?? 255,
          pixels[source + 2] ?? 255,
        );
      }
    }
  }
  const packed = packDirectorPackBits(indices);
  const bytes: number[] = [...DIRECTOR_PHOTO_CAST_PROPERTY_BYTES];
  writeUInt16BE(bytes, 0x8000 | rowBytes);
  writeInt16BE(bytes, 0);
  writeInt16BE(bytes, 0);
  writeInt16BE(bytes, height);
  writeInt16BE(bytes, width);
  bytes.push(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  writeUInt16BE(bytes, 0);
  writeUInt16BE(bytes, 0);
  bytes.push(0xc0, 0x08);
  writeInt32BE(bytes, -2);
  writeUInt32BE(bytes, 0x01000000);
  bytes.push(0x44, 0x54, 0x49, 0x42);
  writeUInt32LE(bytes, packed.length);
  bytes.push(...packed);
  return new Uint8Array(bytes);
}

function findDirectorBitmapMediaHeader(bytes: Uint8Array): DirectorBitmapMediaHeader | null {
  const fixedOffset = DIRECTOR_PHOTO_CAST_PROPERTY_BYTES.length;
  const fixed = readDirectorBitmapMediaHeader(bytes, fixedOffset);
  if (fixed) return fixed;

  const maxOffset = Math.min(4096, Math.max(0, bytes.length - DIRECTOR_BITMAP_MEDIA_HEADER_BYTES));
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset === fixedOffset) continue;
    const header = readDirectorBitmapMediaHeader(bytes, offset);
    if (header) return header;
  }
  return null;
}

function readDirectorBitmapMediaHeader(bytes: Uint8Array, offset: number): DirectorBitmapMediaHeader | null {
  const candidate = readDirectorBitmapMediaCandidate(bytes, offset);
  return candidate.accepted ? candidate.header : null;
}

function findDirectorBitmapMediaCandidate(bytes: Uint8Array): ReturnType<typeof readDirectorBitmapMediaCandidate> | null {
  const fixedOffset = DIRECTOR_PHOTO_CAST_PROPERTY_BYTES.length;
  const fixed = readDirectorBitmapMediaCandidate(bytes, fixedOffset);
  if (fixed.offset !== undefined) return fixed;

  const maxOffset = Math.min(4096, Math.max(0, bytes.length - DIRECTOR_BITMAP_MEDIA_HEADER_BYTES));
  let best: ReturnType<typeof readDirectorBitmapMediaCandidate> | null = null;
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset === fixedOffset) continue;
    const candidate = readDirectorBitmapMediaCandidate(bytes, offset);
    if (candidate.offset === undefined) continue;
    if (candidate.accepted || candidate.fourCC === "DTIB") return candidate;
    best ??= candidate;
  }
  return best;
}

function readDirectorBitmapMediaCandidate(bytes: Uint8Array, offset: number):
  | (DirectorBitmapMediaInspection & { readonly header: DirectorBitmapMediaHeader; readonly accepted: true })
  | (DirectorBitmapMediaInspection & { readonly header?: undefined; readonly accepted: false }) {
  const base = (reason: string): DirectorBitmapMediaInspection & { readonly accepted: false; readonly header?: undefined } => ({
    bytes: bytes.length,
    prefix: hexPrefix(bytes),
    accepted: false,
    reason,
  });
  if (offset < 0 || offset + DIRECTOR_BITMAP_MEDIA_HEADER_BYTES > bytes.length) return base("header-out-of-range");
  let cursor = offset;
  const rowBytes = readUInt16BE(bytes, cursor) & 0x7fff;
  cursor += 2;
  const top = readInt16BE(bytes, cursor);
  cursor += 2;
  const left = readInt16BE(bytes, cursor);
  cursor += 2;
  const bottom = readInt16BE(bytes, cursor);
  cursor += 2;
  const right = readInt16BE(bytes, cursor);
  cursor += 2;
  const width = right - left;
  const height = bottom - top;
  cursor += 1 + 7 + 2 + 2 + 1;
  const bitDepth = bytes[cursor] ?? 0;
  cursor += 1;
  const palette = readInt32BE(bytes, cursor);
  cursor += 4;
  cursor += 4;
  const fourCC = stringFromBytes(bytes.subarray(cursor, cursor + 4));
  cursor += 4;
  const packedLength = readUInt32LE(bytes, cursor);
  cursor += 4;
  const minRowBytes = Math.ceil((width * bitDepth) / 8);
  const paletteName = paletteNameForDirectorBitmap(palette);
  const details = {
    bytes: bytes.length,
    prefix: hexPrefix(bytes),
    offset,
    rowBytes,
    width,
    height,
    bitDepth,
    palette,
    paletteName,
    fourCC,
    packedLength,
    minRowBytes,
  };
  if (rowBytes <= 0 || width <= 0 || height <= 0) return { ...details, accepted: false, reason: "invalid-dimensions" };
  if (![1, 2, 4, 8].includes(bitDepth)) return { ...details, accepted: false, reason: "unsupported-bit-depth" };
  if (rowBytes < minRowBytes || rowBytes > minRowBytes + 8) return { ...details, accepted: false, reason: "unsupported-row-bytes" };
  if (fourCC !== "DTIB") return { ...details, accepted: false, reason: "unsupported-fourcc" };
  if (packedLength <= 0 || cursor >= bytes.length || cursor + packedLength > bytes.length) {
    return { ...details, accepted: false, reason: "invalid-packed-length" };
  }
  const header = {
    offset,
    rowBytes,
    top,
    left,
    bottom,
    right,
    width,
    height,
    bitDepth,
    palette,
    paletteName,
    fourCC,
    minRowBytes,
    packedOffset: cursor,
    packedLength,
  };
  return { ...details, accepted: true, reason: "supported-director-bitmap", header };
}

function unpackBitmapRowIndices(row: Uint8Array, width: number, bitDepth: number): Uint8Array {
  if (bitDepth === 8) return row.subarray(0, width);
  const indices = new Uint8Array(width);
  const mask = (1 << bitDepth) - 1;
  let dest = 0;
  for (const byte of row) {
    for (let shift = 8 - bitDepth; shift >= 0 && dest < width; shift -= bitDepth) {
      indices[dest++] = (byte >> shift) & mask;
    }
  }
  return indices;
}

function grayscalePaletteIndex(red: number, green: number, blue: number): number {
  const luminance = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
  return Math.max(0, Math.min(255, 255 - luminance));
}

export function unpackDirectorPackBits(bytes: Uint8Array, expectedLength: number): Uint8Array {
  const output = new Uint8Array(expectedLength);
  let src = 0;
  let dest = 0;
  while (src < bytes.length && dest < output.length) {
    const marker = bytes[src++] ?? 0;
    if (marker >= 128) {
      const fill = bytes[src++] ?? 0;
      const count = Math.min(257 - marker, output.length - dest);
      output.fill(fill, dest, dest + count);
      dest += count;
      continue;
    }
    const count = Math.min(marker + 1, output.length - dest, bytes.length - src);
    output.set(bytes.subarray(src, src + count), dest);
    src += count;
    dest += count;
  }
  return output;
}

function packDirectorPackBits(bytes: Uint8Array): number[] {
  const output: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let runLength = 1;
    while (
      offset + runLength < bytes.length &&
      runLength < 128 &&
      bytes[offset + runLength] === bytes[offset]
    ) {
      runLength += 1;
    }
    if (runLength >= 3) {
      output.push(257 - runLength, bytes[offset] ?? 0);
      offset += runLength;
      continue;
    }

    const literalStart = offset;
    offset += runLength;
    while (offset < bytes.length && offset - literalStart < 128) {
      runLength = 1;
      while (
        offset + runLength < bytes.length &&
        runLength < 128 &&
        bytes[offset + runLength] === bytes[offset]
      ) {
        runLength += 1;
      }
      if (runLength >= 3) break;
      offset += runLength;
    }
    const literalLength = offset - literalStart;
    output.push(literalLength - 1);
    for (let index = literalStart; index < offset; index += 1) {
      output.push(bytes[index] ?? 0);
    }
  }
  return output;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)) >>> 0;
}

function readInt16BE(bytes: Uint8Array, offset: number): number {
  const value = readUInt16BE(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function readInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>
    0
  );
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

function stringFromBytes(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function paletteNameForDirectorBitmap(palette: number): string {
  return palette === -2 ? "grayscale" : "systemMac";
}

function hexPrefix(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 24), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function directorIndexedColor(palette: readonly number[] | null, paletteIndex: number): LingoColor {
  const rgb = palette?.[paletteIndex] ?? 0;
  return new LingoColor((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, paletteIndex);
}
