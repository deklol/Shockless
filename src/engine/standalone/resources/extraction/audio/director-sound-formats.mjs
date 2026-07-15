import { createHash } from "node:crypto";

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseDirectorEdimSound(input, sourceLabel = "ediM") {
  const bytes = Buffer.from(input);
  if (bytes.length < 4) throw new Error(`${sourceLabel}: media is shorter than four bytes.`);

  if (isMp3At(bytes, 0) || isId3At(bytes, 0)) {
    const mp3 = inspectMp3(bytes, sourceLabel);
    return {
      container: isId3At(bytes, 0) ? "id3-mp3" : "mp3",
      codec: "mp3",
      payload: bytes,
      payloadOffset: 0,
      sampleRate: mp3.sampleRate,
      channels: mp3.channels,
      sampleSize: null,
      sampleCount: mp3.sampleCount,
      durationMs: mp3.durationMs,
      loopStart: null,
      loopEnd: null,
      mp3,
    };
  }

  const headerLength = bytes.readUInt32BE(0);
  const payloadOffset = 4 + headerLength;
  if (headerLength < 32 || payloadOffset >= bytes.length) {
    throw new Error(`${sourceLabel}: invalid Director media header length ${headerLength}.`);
  }
  if (!isMp3At(bytes, payloadOffset) && !isId3At(bytes, payloadOffset)) {
    throw new Error(`${sourceLabel}: Director media payload is not an MP3 stream.`);
  }

  const version = readU32(bytes, 4, sourceLabel);
  const sampleRate = readU32(bytes, 8, sourceLabel);
  const nominalBitRate = readU32(bytes, 12, sourceLabel);
  const codecDelay = readU32(bytes, 16, sourceLabel);
  const sampleCount = readU32(bytes, 20, sourceLabel);
  const rawLoopStart = readU32(bytes, 24, sourceLabel);
  const rawLoopEnd = readU32(bytes, 28, sourceLabel);
  const unknownWord32 = readU16(bytes, 32, sourceLabel);
  const unknownWord34 = readU16(bytes, 34, sourceLabel);
  if (sampleRate <= 0 || sampleRate > 384000) throw new Error(`${sourceLabel}: invalid sample rate ${sampleRate}.`);
  if (sampleCount <= 0) throw new Error(`${sourceLabel}: invalid sample count ${sampleCount}.`);

  const payload = bytes.subarray(payloadOffset);
  const mp3 = inspectMp3(payload, `${sourceLabel} MP3 payload`);
  if (mp3.sampleRate !== sampleRate) {
    throw new Error(`${sourceLabel}: header sample rate ${sampleRate} does not match MP3 rate ${mp3.sampleRate}.`);
  }
  const channels = mp3.channels;

  const { loopStart, loopEnd } = directorLoopPoints(rawLoopStart, rawLoopEnd, sampleCount);
  return {
    container: "director-edim-mp3",
    codec: "mp3",
    payload,
    payloadOffset,
    sampleRate,
    channels,
    sampleSize: null,
    sampleCount,
    durationMs: samplesToMilliseconds(sampleCount, sampleRate),
    loopStart,
    loopEnd,
    directorHeader: {
      headerLength,
      version,
      nominalBitRate,
      codecDelay,
      unknownWord32,
      unknownWord34,
      rawLoopStart,
      rawLoopEnd,
    },
    mp3,
  };
}

export function parseDirectorSndSound(input, sourceLabel = "snd ") {
  const bytes = Buffer.from(input);
  const reader = new BigEndianReader(bytes, sourceLabel);
  const format = reader.u16();
  if (format !== 1 && format !== 2) throw new Error(`${sourceLabel}: unsupported sound resource format ${format}.`);

  const dataFormats = [];
  let referenceCount = 0;
  if (format === 1) {
    const count = reader.u16();
    for (let index = 0; index < count; index += 1) {
      dataFormats.push({ id: reader.u16(), initOption: reader.u32() });
    }
  } else {
    referenceCount = reader.u16();
  }

  const commandCount = reader.u16();
  const commands = [];
  for (let index = 0; index < commandCount; index += 1) {
    commands.push({ command: reader.u16(), param1: reader.u16(), param2: reader.u32() });
  }

  const samplePtr = reader.u32();
  const encodeDependent = reader.u32();
  const sampleRateFixed = reader.u32();
  const sampleRate = sampleRateFixed / 65536;
  const rawLoopStart = reader.u32();
  const rawLoopEnd = reader.u32();
  const encode = reader.u8();
  const baseFrequency = reader.u8();

  let channels;
  let sampleCount;
  let sampleSize;
  let extendedHeader;
  if (encode === 0x00) {
    channels = 1;
    sampleCount = encodeDependent;
    sampleSize = 8;
  } else if (encode === 0xff || encode === 0xfd) {
    channels = encodeDependent;
    sampleCount = reader.u32();
    const aiffSampleRate = reader.bytes(10).toString("hex");
    const markerChunk = reader.u32();
    const instrumentChunks = reader.u32();
    const aesRecording = reader.u32();
    sampleSize = reader.u16();
    extendedHeader = {
      aiffSampleRate,
      markerChunk,
      instrumentChunks,
      aesRecording,
      futureUse1: reader.u16(),
      futureUse2: reader.u32(),
      futureUse3: reader.u32(),
      futureUse4: reader.u32(),
    };
  } else {
    throw new Error(`${sourceLabel}: unsupported sampled-sound encode 0x${encode.toString(16).padStart(2, "0")}.`);
  }

  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 384000) {
    throw new Error(`${sourceLabel}: invalid 16.16 sample rate ${sampleRate}.`);
  }
  if (channels !== 1 && channels !== 2) throw new Error(`${sourceLabel}: unsupported channel count ${channels}.`);
  if (sampleSize !== 8 && sampleSize !== 16) throw new Error(`${sourceLabel}: unsupported PCM sample size ${sampleSize}.`);
  if (sampleCount <= 0) throw new Error(`${sourceLabel}: invalid sample count ${sampleCount}.`);

  const bytesPerSample = sampleSize / 8;
  const expectedPcmBytes = sampleCount * channels * bytesPerSample;
  if (reader.remaining < expectedPcmBytes) {
    throw new Error(`${sourceLabel}: expected ${expectedPcmBytes} PCM bytes but only ${reader.remaining} remain.`);
  }
  const pcmBigEndian = reader.bytes(expectedPcmBytes);
  const trailingBytes = reader.remaining;
  const { loopStart, loopEnd } = directorLoopPoints(rawLoopStart, rawLoopEnd, sampleCount);

  return {
    container: "director-snd-pcm",
    codec: "pcm",
    sampleRate,
    channels,
    sampleSize,
    sampleCount,
    durationMs: samplesToMilliseconds(sampleCount, sampleRate),
    loopStart,
    loopEnd,
    pcmBigEndian,
    trailingBytes,
    directorHeader: {
      format,
      dataFormats,
      referenceCount,
      commands,
      samplePtr,
      encodeDependent,
      sampleRateFixed,
      rawLoopStart,
      rawLoopEnd,
      encode,
      baseFrequency,
      ...(extendedHeader ? { extendedHeader } : {}),
    },
  };
}

export function createPcmWave(sound) {
  const { channels, sampleRate, sampleSize, sampleCount } = sound;
  if (sampleSize !== 8 && sampleSize !== 16) throw new Error(`Cannot emit WAV for ${sampleSize}-bit PCM.`);
  const source = Buffer.from(sound.pcmBigEndian);
  const pcm = Buffer.allocUnsafe(source.length);
  if (sampleSize === 8) {
    source.copy(pcm);
  } else {
    for (let offset = 0; offset < source.length; offset += 2) {
      pcm[offset] = source[offset + 1];
      pcm[offset + 1] = source[offset];
    }
  }

  const blockAlign = channels * (sampleSize / 8);
  const byteRate = sampleRate * blockAlign;
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write("RIFF", 0, "ascii");
  wave.writeUInt32LE(36 + pcm.length, 4);
  wave.write("WAVE", 8, "ascii");
  wave.write("fmt ", 12, "ascii");
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(channels, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(byteRate, 28);
  wave.writeUInt16LE(blockAlign, 32);
  wave.writeUInt16LE(sampleSize, 34);
  wave.write("data", 36, "ascii");
  wave.writeUInt32LE(pcm.length, 40);
  pcm.copy(wave, 44);
  if (pcm.length !== sampleCount * blockAlign) throw new Error("PCM byte count changed while emitting WAV.");
  return wave;
}

export function inspectMp3(input, sourceLabel = "MP3") {
  const bytes = Buffer.from(input);
  const audioStart = skipId3v2(bytes, 0);
  const audioEnd = hasId3v1(bytes) ? bytes.length - 128 : bytes.length;
  let firstFrameOffset = -1;
  let firstFrame = null;
  for (let offset = audioStart; offset + 4 <= audioEnd; offset += 1) {
    const frame = parseMp3FrameHeader(bytes, offset);
    if (!frame || offset + frame.frameLength > audioEnd) continue;
    const nextOffset = offset + frame.frameLength;
    const next = nextOffset + 4 <= audioEnd ? parseMp3FrameHeader(bytes, nextOffset) : null;
    if (next && next.version === frame.version && next.layer === frame.layer && next.sampleRate === frame.sampleRate) {
      firstFrameOffset = offset;
      firstFrame = frame;
      break;
    }
    if (nextOffset === audioEnd) {
      firstFrameOffset = offset;
      firstFrame = frame;
      break;
    }
  }
  if (!firstFrame) throw new Error(`${sourceLabel}: no valid MPEG Layer III frame sequence was found.`);

  let offset = firstFrameOffset;
  let frameCount = 0;
  let sampleCount = 0;
  let encodedBytes = 0;
  while (offset + 4 <= audioEnd) {
    const frame = parseMp3FrameHeader(bytes, offset);
    if (!frame || frame.version !== firstFrame.version || frame.sampleRate !== firstFrame.sampleRate) break;
    if (offset + frame.frameLength > audioEnd) break;
    frameCount += 1;
    sampleCount += frame.samplesPerFrame;
    encodedBytes += frame.frameLength;
    offset += frame.frameLength;
  }
  if (frameCount === 0) throw new Error(`${sourceLabel}: MP3 frame scan produced no complete frames.`);

  return {
    version: firstFrame.version,
    layer: firstFrame.layer,
    sampleRate: firstFrame.sampleRate,
    channels: firstFrame.channels,
    frameCount,
    sampleCount,
    durationMs: samplesToMilliseconds(sampleCount, firstFrame.sampleRate),
    firstFrameOffset,
    audioEndOffset: offset,
    encodedBytes,
    trailingBytes: audioEnd - offset,
  };
}

function parseMp3FrameHeader(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const header = bytes.readUInt32BE(offset);
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) return null;
  const versionBits = (header >>> 19) & 0x3;
  const layerBits = (header >>> 17) & 0x3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const sampleRateIndex = (header >>> 10) & 0x3;
  const padding = (header >>> 9) & 0x1;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitRateKbps = (version === 1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
  const sampleRate = MPEG_SAMPLE_RATES[version][sampleRateIndex];
  const frameLength = Math.floor(((version === 1 ? 144 : 72) * bitRateKbps * 1000) / sampleRate) + padding;
  if (frameLength <= 4) return null;
  const channelMode = (header >>> 6) & 0x3;
  return {
    version,
    layer: 3,
    bitRateKbps,
    sampleRate,
    frameLength,
    samplesPerFrame: version === 1 ? 1152 : 576,
    channels: channelMode === 3 ? 1 : 2,
  };
}

function skipId3v2(bytes, offset) {
  if (!isId3At(bytes, offset) || offset + 10 > bytes.length) return offset;
  const flags = bytes[offset + 5];
  const size = synchsafe(bytes[offset + 6], bytes[offset + 7], bytes[offset + 8], bytes[offset + 9]);
  return Math.min(bytes.length, offset + 10 + size + ((flags & 0x10) !== 0 ? 10 : 0));
}

function synchsafe(a, b, c, d) {
  if ((a | b | c | d) & 0x80) return 0;
  return (a << 21) | (b << 14) | (c << 7) | d;
}

function hasId3v1(bytes) {
  return bytes.length >= 128 && bytes.subarray(bytes.length - 128, bytes.length - 125).toString("ascii") === "TAG";
}

function isId3At(bytes, offset) {
  return offset + 3 <= bytes.length && bytes.subarray(offset, offset + 3).toString("ascii") === "ID3";
}

function isMp3At(bytes, offset) {
  return offset + 2 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0;
}

function directorLoopPoints(rawStart, rawEnd, sampleCount) {
  if (rawStart === 0xffffffff || rawEnd === 0xffffffff) return { loopStart: null, loopEnd: null };
  if (rawStart < 0 || rawEnd <= rawStart || rawEnd > sampleCount) return { loopStart: null, loopEnd: null };
  return { loopStart: rawStart, loopEnd: rawEnd };
}

function samplesToMilliseconds(sampleCount, sampleRate) {
  return (sampleCount / sampleRate) * 1000;
}

function readU16(bytes, offset, label) {
  if (offset + 2 > bytes.length) throw new Error(`${label}: truncated 16-bit field at ${offset}.`);
  return bytes.readUInt16BE(offset);
}

function readU32(bytes, offset, label) {
  if (offset + 4 > bytes.length) throw new Error(`${label}: truncated 32-bit field at ${offset}.`);
  return bytes.readUInt32BE(offset);
}

class BigEndianReader {
  offset = 0;

  constructor(bytes, label) {
    this.source = Buffer.from(bytes);
    this.label = label;
  }

  get remaining() {
    return this.source.length - this.offset;
  }

  ensure(length) {
    if (this.offset + length > this.source.length) {
      throw new Error(`${this.label}: truncated at byte ${this.offset}; needed ${length}, have ${this.remaining}.`);
    }
  }

  u8() {
    this.ensure(1);
    return this.source.readUInt8(this.offset++);
  }

  u16() {
    this.ensure(2);
    const value = this.source.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    this.ensure(4);
    const value = this.source.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length) {
    this.ensure(length);
    const value = this.source.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}
