import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface SoundFormatsModule {
  createPcmWave(sound: unknown): Buffer;
  inspectMp3(bytes: Buffer, label?: string): {
    sampleRate: number;
    channels: number;
    frameCount: number;
    sampleCount: number;
    firstFrameOffset: number;
  };
  parseDirectorEdimSound(bytes: Buffer, label?: string): Record<string, unknown>;
  parseDirectorSndSound(bytes: Buffer, label?: string): Record<string, unknown>;
}

// @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
const soundFormats = (await import("../resources/extraction/audio/director-sound-formats.mjs")) as SoundFormatsModule;

interface SoundAssetsModule {
  buildDirectorSoundAssets(options: Record<string, unknown>): {
    declaredSoundCount: number;
    movieSoundCount: number;
    externalSoundCount: number;
    soundCount: number;
    unsupportedCount: number;
    diagnostics: unknown[];
    unsupported: Array<Record<string, unknown>>;
    sounds: Array<Record<string, unknown>>;
  };
}

// @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
const soundAssets = (await import("../resources/extraction/audio/director-sound-assets.mjs")) as SoundAssetsModule;

test("MP3 inspection handles raw and ID3-prefixed MPEG Layer III streams", () => {
  const frames = Buffer.concat([mpeg1Layer3Frame(), mpeg1Layer3Frame()]);
  const raw = soundFormats.inspectMp3(frames);
  assert.equal(raw.sampleRate, 44100);
  assert.equal(raw.channels, 1);
  assert.equal(raw.frameCount, 2);
  assert.equal(raw.sampleCount, 2304);
  assert.equal(raw.firstFrameOffset, 0);

  const id3 = Buffer.alloc(10);
  id3.write("ID3", 0, "ascii");
  id3[3] = 3;
  const tagged = soundFormats.inspectMp3(Buffer.concat([id3, frames]));
  assert.equal(tagged.frameCount, 2);
  assert.equal(tagged.firstFrameOffset, 10);
});

test("Director ediM parsing preserves the media header and extracts its MP3 payload", () => {
  const headerLength = 320;
  const header = Buffer.alloc(4 + headerLength);
  header.writeUInt32BE(headerLength, 0);
  header.writeUInt32BE(3, 4);
  header.writeUInt32BE(44100, 8);
  header.writeUInt32BE(64000, 12);
  header.writeUInt32BE(1393, 16);
  header.writeUInt32BE(2304, 20);
  header.writeUInt32BE(0xffffffff, 24);
  header.writeUInt32BE(0xffffffff, 28);
  header.writeUInt16BE(2, 32);
  header.writeUInt16BE(1, 34);
  const frames = Buffer.concat([mpeg1Layer3Frame(), mpeg1Layer3Frame()]);

  const parsed = soundFormats.parseDirectorEdimSound(Buffer.concat([header, frames]));
  assert.equal(parsed.container, "director-edim-mp3");
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.sampleSize, null);
  assert.equal(parsed.sampleCount, 2304);
  assert.equal(parsed.loopStart, null);
  assert.equal(parsed.loopEnd, null);
  assert.equal((parsed.payload as Buffer).equals(frames), true);
  assert.deepEqual(parsed.directorHeader, {
    headerLength: 320,
    version: 3,
    nominalBitRate: 64000,
    codecDelay: 1393,
    unknownWord32: 2,
    unknownWord34: 1,
    rawLoopStart: 0xffffffff,
    rawLoopEnd: 0xffffffff,
  });
});

test("classic Director snd parsing uses declared PCM length and emits little-endian WAV", () => {
  const source = classicSndFixture();
  const parsed = soundFormats.parseDirectorSndSound(source) as Record<string, unknown> & {
    pcmBigEndian: Buffer;
  };
  assert.equal(parsed.container, "director-snd-pcm");
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.sampleSize, 16);
  assert.equal(parsed.sampleCount, 2);
  assert.equal(parsed.trailingBytes, 4);
  assert.equal(parsed.loopStart, null);
  assert.equal(parsed.loopEnd, null);
  assert.equal(parsed.pcmBigEndian.toString("hex"), "1234abcd");

  const wave = soundFormats.createPcmWave(parsed);
  assert.equal(wave.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wave.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(24), 44100);
  assert.equal(wave.readUInt16LE(34), 16);
  assert.equal(wave.subarray(44).toString("hex"), "3412cdab");
});

test("standard Director snd parsing preserves mono 8-bit PCM and loop points", () => {
  const source = directorSndFixture({
    resourceFormat: 1,
    encode: 0x00,
    channels: 1,
    sampleSize: 8,
    sampleRate: 22050,
    sampleCount: 4,
    loopStart: 1,
    loopEnd: 3,
    pcm: Buffer.from([0x00, 0x40, 0x80, 0xff]),
  });
  const parsed = soundFormats.parseDirectorSndSound(source) as Record<string, unknown> & {
    pcmBigEndian: Buffer;
    directorHeader: { dataFormats: unknown[] };
  };

  assert.equal(parsed.sampleRate, 22050);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.sampleSize, 8);
  assert.equal(parsed.sampleCount, 4);
  assert.equal(parsed.loopStart, 1);
  assert.equal(parsed.loopEnd, 3);
  assert.equal(parsed.pcmBigEndian.equals(Buffer.from([0x00, 0x40, 0x80, 0xff])), true);
  assert.deepEqual(parsed.directorHeader.dataFormats, [{ id: 5, initOption: 0 }]);

  const wave = soundFormats.createPcmWave(parsed);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(24), 22050);
  assert.equal(wave.readUInt16LE(34), 8);
  assert.equal(wave.subarray(44).equals(Buffer.from([0x00, 0x40, 0x80, 0xff])), true);
});

test("extended Director snd parsing preserves stereo interleaving for 8-bit and 16-bit PCM", () => {
  const pcm8 = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const parsed8 = soundFormats.parseDirectorSndSound(directorSndFixture({
    encode: 0xfd,
    channels: 2,
    sampleSize: 8,
    sampleRate: 11025,
    sampleCount: 2,
    pcm: pcm8,
  })) as Record<string, unknown> & { pcmBigEndian: Buffer };
  assert.equal(parsed8.channels, 2);
  assert.equal(parsed8.sampleSize, 8);
  assert.equal(parsed8.sampleCount, 2);
  assert.equal(parsed8.pcmBigEndian.equals(pcm8), true);
  assert.equal(soundFormats.createPcmWave(parsed8).subarray(44).equals(pcm8), true);

  const pcm16 = Buffer.from("0001fffe1234abcd", "hex");
  const parsed16 = soundFormats.parseDirectorSndSound(directorSndFixture({
    encode: 0xff,
    channels: 2,
    sampleSize: 16,
    sampleRate: 44100,
    sampleCount: 2,
    pcm: pcm16,
  })) as Record<string, unknown> & { pcmBigEndian: Buffer };
  assert.equal(parsed16.channels, 2);
  assert.equal(parsed16.sampleSize, 16);
  assert.equal(parsed16.sampleCount, 2);
  assert.equal(parsed16.pcmBigEndian.equals(pcm16), true);
  assert.equal(soundFormats.createPcmWave(parsed16).subarray(44).toString("hex"), "0100feff3412cdab");
});

test("Director snd parsing rejects invalid loop ranges and truncated PCM deterministically", () => {
  const invalidLoop = soundFormats.parseDirectorSndSound(directorSndFixture({
    encode: 0x00,
    channels: 1,
    sampleSize: 8,
    sampleRate: 8000,
    sampleCount: 4,
    loopStart: 3,
    loopEnd: 2,
    pcm: Buffer.alloc(4),
  }));
  assert.equal(invalidLoop.loopStart, null);
  assert.equal(invalidLoop.loopEnd, null);

  const truncated = directorSndFixture({
    encode: 0xff,
    channels: 2,
    sampleSize: 16,
    sampleRate: 44100,
    sampleCount: 2,
    pcm: Buffer.alloc(8),
  }).subarray(0, -1);
  assert.throws(
    () => soundFormats.parseDirectorSndSound(truncated),
    /expected 8 PCM bytes but only 7 remain/,
  );
  assert.throws(() => soundFormats.parseDirectorSndSound(Buffer.alloc(0)), /truncated at byte 0/);
});

test("unknown ediM and snd encodings fail explicitly", () => {
  assert.throws(() => soundFormats.parseDirectorEdimSound(Buffer.from("not audio")), /invalid Director media header length/);
  const source = classicSndFixture();
  source[34] = 0x7f;
  assert.throws(() => soundFormats.parseDirectorSndSound(source), /unsupported sampled-sound encode/);
});

test("sound extraction follows KEY links and emits deterministic manifest metadata", () => {
  const root = join(tmpdir(), `shockless-sound-assets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const chunks = join(root, "casts", "Test", "chunks");
  const runtimeData = join(root, "runtime-data");
  const assets = join(root, "assets");
  const manifestPath = join(runtimeData, "release999-projectorrays-manifest.json");
  const outputPath = join(runtimeData, "sound-assets.release999.json");
  mkdirSync(chunks, { recursive: true });
  mkdirSync(runtimeData, { recursive: true });
  writeFileSync(join(chunks, "CASt-100.bin"), Buffer.alloc(1));
  writeFileSync(join(chunks, "CASt-101.bin"), Buffer.alloc(1));
  writeFileSync(join(chunks, "ediM-20.bin"), Buffer.concat([mpeg1Layer3Frame(), mpeg1Layer3Frame()]));
  writeFileSync(join(chunks, "snd -21.bin"), classicSndFixture());
  writeFileSync(
    join(chunks, "KEY_-1.json"),
    JSON.stringify({ entries: [
      { sectionID: 20, castID: 100, fourCC: "ediM" },
      { sectionID: 21, castID: 101, fourCC: "snd " },
    ] }),
  );
  writeFileSync(manifestPath, JSON.stringify({
    casts: [{
      number: 1,
      name: "Test",
      members: [
        { number: 1, memberChunkId: 100, name: "MP3 Sound", type: "sound", sourceMemberChunkPath: "casts/Test/chunks/CASt-100.bin" },
        { number: 2, memberChunkId: 101, name: "PCM Sound", type: "sound", sourceMemberChunkPath: "casts/Test/chunks/CASt-101.bin" },
      ],
    }],
  }));

  try {
    const first = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });
    const firstIndex = readFileSync(outputPath);
    const firstManifest = readFileSync(manifestPath);
    const second = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });

    assert.equal(first.soundCount, 2);
    assert.equal(first.declaredSoundCount, 2);
    assert.equal(first.unsupportedCount, 0);
    assert.equal(second.soundCount, 2);
    assert.equal(first.sounds[0]?.codec, "mp3");
    assert.equal(first.sounds[0]?.sampleSize, null);
    assert.equal(first.sounds[1]?.codec, "pcm");
    assert.equal(first.sounds[1]?.sampleSize, 16);
    assert.match(String(first.sounds[0]?.assetSha256), /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(outputPath).equals(firstIndex), true);
    assert.equal(readFileSync(manifestPath).equals(firstManifest), true);
    const manifest = JSON.parse(firstManifest.toString("utf8"));
    assert.equal(manifest.casts[0].members[0].sound.assetPath, "release999/test/0001-mp3-sound.mp3");
    assert.equal(manifest.casts[0].members[1].sound.assetPath, "release999/test/0002-pcm-sound.wav");

    const cli = spawnSync(process.execPath, [
      fileURLToPath(new URL("../resources/extraction/audio/director-sound-assets.mjs", import.meta.url)),
      "--version", "release999",
      "--manifest", manifestPath,
      "--runtime-data-root", runtimeData,
      "--asset-root", assets,
      "--asset-path-base", assets,
      "--out", outputPath,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Materialized 2 Director sound asset\(s\)\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sound extraction inventories and enriches resolved external cast sound members", () => {
  const root = join(tmpdir(), `shockless-external-sound-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const chunks = join(root, "extracted", "projectorrays", "hh_soundmachine", "chunks");
  const runtimeData = join(root, "runtime-data");
  const assets = join(root, "assets");
  const manifestPath = join(runtimeData, "release999-projectorrays-manifest.json");
  const externalCastGraphPath = join(runtimeData, "external-cast-graph.release999.json");
  const outputPath = join(runtimeData, "sound-assets.release999.json");
  mkdirSync(chunks, { recursive: true });
  mkdirSync(runtimeData, { recursive: true });
  writeFileSync(join(chunks, "CASt-13.json"), "{}\n");
  writeFileSync(join(chunks, "ediM-822.bin"), Buffer.concat([mpeg1Layer3Frame(), mpeg1Layer3Frame()]));
  writeFileSync(
    join(chunks, "KEY_-3.json"),
    JSON.stringify({ entries: [{ sectionID: 822, castID: 13, fourCC: "ediM" }] }),
  );
  writeFileSync(manifestPath, JSON.stringify({ casts: [] }));
  writeFileSync(externalCastGraphPath, JSON.stringify({
    releases: [{
      versionId: "release999",
      casts: [{
        order: 74,
        name: "hh_soundmachine",
        resolved: true,
        expectedExtractionRoot: "extracted/projectorrays/hh_soundmachine",
        members: [{
          number: 103,
          name: "sound_machine_sample_0",
          type: "sound",
          memberChunkId: 13,
          sourceRegistry: "CAS_-431.json",
        }],
      }],
    }],
  }));

  try {
    const first = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      externalCastGraphPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });
    const firstIndex = readFileSync(outputPath);
    const firstGraph = readFileSync(externalCastGraphPath);
    const second = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      externalCastGraphPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });

    assert.equal(first.declaredSoundCount, 1);
    assert.equal(first.soundCount, 1);
    assert.equal(first.unsupportedCount, 0);
    assert.equal(second.soundCount, 1);
    assert.equal(first.sounds[0]?.id, "release999:external:74:hh_soundmachine:103");
    assert.equal(first.sounds[0]?.sourceKind, "external");
    assert.equal(first.sounds[0]?.codec, "mp3");
    assert.equal(readFileSync(outputPath).equals(firstIndex), true);
    assert.equal(readFileSync(externalCastGraphPath).equals(firstGraph), true);
    const graph = JSON.parse(firstGraph.toString("utf8"));
    const sound = graph.releases[0].casts[0].members[0].sound;
    assert.equal(sound.assetPath, "release999/hh_soundmachine/0103-sound_machine_sample_0.mp3");
    assert.equal(sound.sourceFourCC, "ediM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sound extraction reconciles matching movie and external declarations by Director identity", () => {
  const root = join(tmpdir(), `shockless-duplicate-sound-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const chunks = join(root, "extracted", "projectorrays", "hh_trax_samples", "chunks");
  const runtimeData = join(root, "runtime-data");
  const assets = join(root, "assets");
  const manifestPath = join(runtimeData, "release999-projectorrays-manifest.json");
  const externalCastGraphPath = join(runtimeData, "external-cast-graph.release999.json");
  const outputPath = join(runtimeData, "sound-assets.release999.json");
  mkdirSync(chunks, { recursive: true });
  mkdirSync(runtimeData, { recursive: true });
  writeFileSync(join(chunks, "CASt-1965.json"), "{}\n");
  writeFileSync(join(chunks, "ediM-822.bin"), Buffer.concat([mpeg1Layer3Frame(), mpeg1Layer3Frame()]));
  writeFileSync(
    join(chunks, "KEY_-3.json"),
    JSON.stringify({ entries: [{ sectionID: 822, castID: 1965, fourCC: "ediM" }] }),
  );
  writeFileSync(manifestPath, JSON.stringify({
    casts: [{
      number: 632,
      name: "hh_trax_samples",
      members: [{
        number: 170,
        name: "sound_machine_sample_1",
        type: "sound",
        memberChunkId: 1965,
        sourceMemberChunkPath: "extracted/projectorrays/hh_trax_samples/chunks/CASt-1965.json",
      }],
    }],
  }));
  writeFileSync(externalCastGraphPath, JSON.stringify({
    releases: [{
      versionId: "release999",
      casts: [{
        order: 75,
        name: "HH_TRAX_SAMPLES",
        resolved: true,
        expectedExtractionRoot: "extracted/projectorrays/hh_trax_samples",
        members: [{
          number: 170,
          name: "sound_machine_sample_1",
          type: "sound",
          memberChunkId: 1965,
          assetPath: "stale/duplicate.mp3",
          sound: { assetPath: "stale/duplicate.mp3" },
        }],
      }],
    }],
  }));

  try {
    const first = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      externalCastGraphPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });
    const firstIndex = readFileSync(outputPath);
    const firstGraph = readFileSync(externalCastGraphPath);
    const second = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      externalCastGraphPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });

    assert.equal(first.declaredSoundCount, 1);
    assert.equal(first.soundCount, 1);
    assert.equal(first.movieSoundCount, 1);
    assert.equal(first.externalSoundCount, 0);
    assert.equal(first.sounds[0]?.id, "release999:632:170");
    assert.equal(first.sounds[0]?.sourceKind, "movie");
    assert.equal(second.declaredSoundCount, 1);
    assert.equal(readFileSync(outputPath).equals(firstIndex), true);
    assert.equal(readFileSync(externalCastGraphPath).equals(firstGraph), true);
    const graphMember = JSON.parse(firstGraph.toString("utf8")).releases[0].casts[0].members[0];
    assert.equal("assetPath" in graphMember, false);
    assert.equal("sound" in graphMember, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sound extraction rejects conflicting duplicate Director declarations", () => {
  const root = join(tmpdir(), `shockless-conflicting-sound-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const runtimeData = join(root, "runtime-data");
  const manifestPath = join(runtimeData, "release999-projectorrays-manifest.json");
  const externalCastGraphPath = join(runtimeData, "external-cast-graph.release999.json");
  mkdirSync(runtimeData, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    casts: [{
      number: 632,
      name: "hh_trax_samples",
      members: [{ number: 170, name: "sound_machine_sample_1", type: "sound", memberChunkId: 1965 }],
    }],
  }));
  writeFileSync(externalCastGraphPath, JSON.stringify({
    releases: [{
      versionId: "release999",
      casts: [{
        order: 75,
        name: "hh_trax_samples",
        members: [{ number: 170, name: "different_sample", type: "sound", memberChunkId: 1966 }],
      }],
    }],
  }));

  try {
    assert.throws(
      () => soundAssets.buildDirectorSoundAssets({
        profileRoot: root,
        version: "release999",
        manifestPath,
        externalCastGraphPath,
        runtimeDataRoot: runtimeData,
        assetsRoot: join(root, "assets"),
        outputPath: join(runtimeData, "sound-assets.release999.json"),
      }),
      /Conflicting Director sound declarations for hh_trax_samples#170/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sound extraction inventories every unsupported member without hiding later failures", () => {
  const root = join(tmpdir(), `shockless-sound-unsupported-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const chunks = join(root, "casts", "Test", "chunks");
  const runtimeData = join(root, "runtime-data");
  const assets = join(root, "assets");
  const manifestPath = join(runtimeData, "release999-projectorrays-manifest.json");
  const outputPath = join(runtimeData, "sound-assets.release999.json");
  mkdirSync(chunks, { recursive: true });
  mkdirSync(runtimeData, { recursive: true });
  writeFileSync(join(chunks, "CASt-100.bin"), Buffer.alloc(1));
  writeFileSync(join(chunks, "CASt-101.bin"), Buffer.alloc(1));
  writeFileSync(join(chunks, "ediM-20.bin"), Buffer.from("not audio"));
  writeFileSync(
    join(chunks, "KEY_-1.json"),
    JSON.stringify({ entries: [{ sectionID: 20, castID: 100, fourCC: "ediM" }] }),
  );
  writeFileSync(manifestPath, JSON.stringify({
    casts: [{
      number: 1,
      name: "Test",
      members: [
        { number: 1, memberChunkId: 100, name: "Bad Media", type: "sound", sourceMemberChunkPath: "casts/Test/chunks/CASt-100.bin" },
        { number: 2, memberChunkId: 101, name: "Missing Link", type: "sound", sourceMemberChunkPath: "casts/Test/chunks/CASt-101.bin" },
        { number: 3, name: "Missing Identity", type: "sound" },
      ],
    }],
  }));

  try {
    const first = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });
    const firstIndex = readFileSync(outputPath);
    const second = soundAssets.buildDirectorSoundAssets({
      profileRoot: root,
      version: "release999",
      manifestPath,
      runtimeDataRoot: runtimeData,
      assetsRoot: assets,
      assetPathBase: assets,
      outputPath,
    });

    assert.equal(first.declaredSoundCount, 3);
    assert.equal(first.soundCount, 0);
    assert.equal(first.unsupportedCount, 3);
    assert.deepEqual(first.unsupported.map((entry) => entry.code), [
      "unsupported-sound-resource",
      "missing-linked-sound-resource",
      "missing-sound-source-identity",
    ]);
    assert.deepEqual(second.unsupported, first.unsupported);
    assert.equal(readFileSync(outputPath).equals(firstIndex), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mpeg1Layer3Frame(): Buffer {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb90c4, 0);
  return frame;
}

function classicSndFixture(): Buffer {
  return Buffer.concat([
    directorSndFixture({
      encode: 0xff,
      channels: 1,
      sampleSize: 16,
      sampleRate: 44100,
      sampleCount: 2,
      pcm: Buffer.from("1234abcd", "hex"),
    }),
    Buffer.from("deadbeef", "hex"),
  ]);
}

interface DirectorSndFixtureOptions {
  resourceFormat?: 1 | 2;
  encode: 0x00 | 0xfd | 0xff;
  channels: 1 | 2;
  sampleSize: 8 | 16;
  sampleRate: number;
  sampleCount: number;
  loopStart?: number;
  loopEnd?: number;
  pcm: Buffer;
}

function directorSndFixture(options: DirectorSndFixtureOptions): Buffer {
  const bytes: number[] = [];
  const append = (buffer: Buffer) => bytes.push(...buffer);
  const u8 = (value: number) => bytes.push(value & 0xff);
  const u16 = (value: number) => {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value);
    append(buffer);
  };
  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0);
    append(buffer);
  };

  const format = options.resourceFormat ?? 2;
  u16(format);
  if (format === 1) {
    u16(1);
    u16(5);
    u32(0);
  } else {
    u16(0);
  }
  u16(1);
  u16(0x8051);
  u16(0);
  u32(14);
  u32(0);
  u32(options.encode === 0x00 ? options.sampleCount : options.channels);
  u32(options.sampleRate * 65536);
  u32(options.loopStart ?? 0);
  u32(options.loopEnd ?? 0);
  u8(options.encode);
  u8(60);

  if (options.encode !== 0x00) {
    u32(options.sampleCount);
    append(Buffer.from("400eac44000000000000", "hex"));
    u32(0);
    u32(0);
    u32(0);
    u16(options.sampleSize);
    u16(0);
    u32(0);
    u32(0);
    u32(0);
  }

  const expectedBytes = options.sampleCount * options.channels * (options.sampleSize / 8);
  assert.equal(options.pcm.length, expectedBytes, "fixture PCM length must match declared format");
  append(options.pcm);
  return Buffer.from(bytes);
}
