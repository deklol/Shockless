import { LingoBitmapMedia } from "./imaging";
import * as ops from "./ops";
import { LINGO_VOID, LingoPropList, LingoSymbol, LingoValue } from "./values";
import { latin1BytesFromString, stringFromLatin1Bytes } from "./byteStrings";

export const MUS_TYPES = {
  Void: 0,
  Integer: 1,
  Symbol: 2,
  String: 3,
  Picture: 5,
  Float: 6,
  List: 7,
  Point: 8,
  Rect: 9,
  PropList: 10,
  Color: 18,
  Date: 19,
  Media: 20,
  Vector3D: 22,
  Transform3D: 23,
} as const;

export interface DecodedMusMessage {
  readonly subject: string;
  readonly content: LingoValue;
  readonly errorCode: number;
}

export function encodeMusMessage(subject: string, content: LingoValue = LINGO_VOID, errorCode = 0): Uint8Array {
  const body = new ByteWriter();
  body.writeInt32(errorCode);
  body.writeInt32(Math.floor(Date.now() / 1000));
  body.writeEvenString(subject);
  body.writeEvenString("System");
  body.writeInt32(1);
  body.writeEvenString("*");
  const encoded = encodeMusValue(content);
  body.writeInt16(encoded.type);
  body.writeBytes(encoded.bytes);
  return encodeMusFrame(body.bytes());
}

export function encodeMusLogonMessage(): Uint8Array {
  const body = new ByteWriter();
  body.writeInt32(0);
  body.writeInt32(Math.floor(Date.now() / 1000));
  body.writeEvenString("Logon");
  body.writeEvenString("System");
  body.writeInt32(1);
  body.writeEvenString("*");
  return encodeMusFrame(body.bytes());
}

export function decodeMusMessages(
  incoming: Uint8Array,
  previous: Uint8Array = new Uint8Array(),
): { readonly messages: DecodedMusMessage[]; readonly remaining: Uint8Array } {
  const bytes = concatBytes(previous, incoming);
  const messages: DecodedMusMessage[] = [];
  let offset = 0;
  while (bytes.length - offset >= 6) {
    if (bytes[offset] !== 0x72 || bytes[offset + 1] !== 0x00) {
      throw new Error("Invalid MUS frame header");
    }
    const length = readInt32(bytes, offset + 2);
    if (length < 0) throw new Error("Invalid MUS frame length");
    if (bytes.length - offset - 6 < length) break;
    messages.push(decodeMusBody(bytes.subarray(offset + 6, offset + 6 + length)));
    offset += 6 + length;
  }
  return { messages, remaining: bytes.subarray(offset) };
}

class ByteWriter {
  private readonly output: number[] = [];

  bytes(): Uint8Array {
    return new Uint8Array(this.output);
  }

  writeInt16(value: number): void {
    this.output.push((value >>> 8) & 0xff, value & 0xff);
  }

  writeInt32(value: number): void {
    this.output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) this.output.push(byte);
  }

  writeEvenString(value: string): void {
    const bytes = latin1BytesFromString(value);
    this.writeInt32(bytes.length);
    this.writeBytes(bytes);
    if (bytes.length % 2 !== 0) this.output.push(0);
  }
}

function encodeMusFrame(body: Uint8Array): Uint8Array {
  const writer = new ByteWriter();
  writer.writeBytes(new Uint8Array([0x72, 0x00]));
  writer.writeInt32(body.length);
  writer.writeBytes(body);
  return writer.bytes();
}

function encodeMusValue(value: LingoValue): { readonly type: number; readonly bytes: Uint8Array } {
  if (value === LINGO_VOID) return { type: MUS_TYPES.Void, bytes: new Uint8Array() };
  if (typeof value === "number") return { type: MUS_TYPES.Integer, bytes: int32Bytes(value) };
  if (value instanceof LingoPropList) return { type: MUS_TYPES.PropList, bytes: encodeMusPropList(value) };
  if (value instanceof LingoBitmapMedia) return { type: MUS_TYPES.Media, bytes: value.bytes };
  const writer = new ByteWriter();
  writer.writeEvenString(value instanceof LingoSymbol ? value.name : ops.stringOf(value));
  return { type: MUS_TYPES.String, bytes: writer.bytes() };
}

function encodeMusPropList(list: LingoPropList): Uint8Array {
  const writer = new ByteWriter();
  writer.writeInt32(list.count());
  for (let index = 0; index < list.count(); index += 1) {
    const key = list.keys[index] ?? "";
    const value = list.values[index] ?? LINGO_VOID;
    writer.writeInt16(MUS_TYPES.Symbol);
    writer.writeEvenString(key instanceof LingoSymbol ? key.name : ops.stringOf(key));
    const encoded = encodeMusPropValue(value);
    writer.writeInt16(encoded.type);
    if (encoded.type !== MUS_TYPES.Integer) writer.writeInt32(encoded.bytes.length);
    writer.writeBytes(encoded.bytes);
    if (encoded.bytes.length % 2 !== 0) writer.writeBytes(new Uint8Array([0]));
  }
  return writer.bytes();
}

function encodeMusPropValue(value: LingoValue): { readonly type: number; readonly bytes: Uint8Array } {
  if (typeof value === "number") return { type: MUS_TYPES.Integer, bytes: int32Bytes(value) };
  if (value instanceof LingoBitmapMedia) return { type: MUS_TYPES.Media, bytes: value.bytes };
  if (value instanceof LingoPropList) return { type: MUS_TYPES.PropList, bytes: encodeMusPropList(value) };
  if (value === LINGO_VOID) return { type: MUS_TYPES.Void, bytes: new Uint8Array() };
  return { type: MUS_TYPES.String, bytes: latin1BytesFromString(value instanceof LingoSymbol ? value.name : ops.stringOf(value)) };
}

function decodeMusBody(bytes: Uint8Array): DecodedMusMessage {
  let offset = 0;
  const errorCode = readInt32(bytes, offset);
  offset += 4;
  offset += 4;
  const subject = readEvenString(bytes, offset);
  offset = subject.offset;
  const sender = readEvenString(bytes, offset);
  offset = sender.offset;
  const receiverCount = Math.max(0, readInt32(bytes, offset));
  offset += 4;
  for (let index = 0; index < receiverCount; index += 1) {
    const receiver = readEvenString(bytes, offset);
    offset = receiver.offset;
  }
  if (offset >= bytes.length) return { subject: subject.value, content: "", errorCode };
  const type = readInt16(bytes, offset);
  offset += 2;
  return { subject: subject.value, content: decodeMusValue(type, bytes, offset), errorCode };
}

function decodeMusValue(type: number, bytes: Uint8Array, offset: number): LingoValue {
  switch (type) {
    case MUS_TYPES.Void:
      return LINGO_VOID;
    case MUS_TYPES.Integer:
      return readInt32(bytes, offset);
    case MUS_TYPES.String:
    case MUS_TYPES.Symbol:
      return readEvenString(bytes, offset).value;
    case MUS_TYPES.PropList:
      return decodeMusPropList(bytes, offset).value;
    case MUS_TYPES.Picture:
    case MUS_TYPES.Media: {
      const length = Math.max(0, readInt32(bytes, offset));
      return new LingoBitmapMedia(bytes.slice(offset + 4, offset + 4 + length));
    }
    default:
      return LINGO_VOID;
  }
}

export function decodeMusPropList(bytes: Uint8Array, offset: number): { readonly value: LingoPropList; readonly offset: number } {
  const count = Math.max(0, readInt32(bytes, offset));
  offset = Math.min(bytes.length, offset + 4);
  const pairs: [LingoValue, LingoValue][] = [];
  for (let index = 0; index < count && offset < bytes.length; index += 1) {
    if (offset + 2 > bytes.length) break;
    offset += 2;
    const key = readEvenString(bytes, offset);
    offset = key.offset;
    if (offset + 2 > bytes.length) break;
    const type = readInt16(bytes, offset);
    offset += 2;
    let valueBytes: Uint8Array;
    if (type === MUS_TYPES.Integer) {
      valueBytes = bytes.subarray(offset, Math.min(bytes.length, offset + 4));
      offset = Math.min(bytes.length, offset + 4);
    } else {
      const length = offset + 4 <= bytes.length ? Math.max(0, readInt32(bytes, offset)) : 0;
      const start = Math.min(bytes.length, offset + 4);
      const end = Math.min(bytes.length, start + length);
      valueBytes = bytes.subarray(start, end);
      offset = Math.min(bytes.length, start + length + (length % 2));
    }
    pairs.push([LingoSymbol.for(key.value), decodeMusPropValue(type, valueBytes)]);
  }
  return { value: LingoPropList.fromPairs(pairs), offset };
}

function decodeMusPropValue(type: number, bytes: Uint8Array): LingoValue {
  switch (type) {
    case MUS_TYPES.Integer:
      return readInt32(bytes, 0);
    case MUS_TYPES.String:
    case MUS_TYPES.Symbol:
      return stringFromLatin1Bytes(bytes);
    case MUS_TYPES.Picture:
    case MUS_TYPES.Media:
      return new LingoBitmapMedia(bytes.slice());
    case MUS_TYPES.PropList:
      return decodeMusPropList(bytes, 0).value;
    case MUS_TYPES.Void:
      return LINGO_VOID;
    default:
      return LINGO_VOID;
  }
}

function int32Bytes(value: number): Uint8Array {
  const writer = new ByteWriter();
  writer.writeInt32(Math.trunc(value));
  return writer.bytes();
}

function readInt16(bytes: Uint8Array, offset: number): number {
  const value = (((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)) >>> 0;
  return value & 0x8000 ? value - 0x10000 : value;
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>
    0
  );
}

function readEvenString(bytes: Uint8Array, offset: number): { readonly value: string; readonly offset: number } {
  if (offset + 4 > bytes.length) {
    return { value: "", offset: bytes.length };
  }
  const length = Math.max(0, readInt32(bytes, offset));
  const start = offset + 4;
  const end = Math.min(bytes.length, start + length);
  return {
    value: stringFromLatin1Bytes(bytes.subarray(start, end)),
    offset: Math.min(bytes.length, start + length + (length % 2)),
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}
