import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type BitdSource = {
  kind: string;
  sectionID?: number;
  candidateCount?: number;
  candidateSectionIds?: number[];
};

type RecoveryModule = {
  readDirectorKeyEntries: (chunksRoot: string) => Array<{ sectionID: number; castID: number; fourCC: string }>;
  resolveBitmapBitdSource: (chunksRoot: string, memberChunkId: number, bitmap: Record<string, number>) => BitdSource | undefined;
  recoverBitmapMetadataFromCastOrder: (chunksRoot: string, memberChunkId: number) => Record<string, unknown> | undefined;
};

async function recoveryModule(): Promise<RecoveryModule> {
  // @ts-expect-error Vitest can import this standalone ESM resource, but it has no TypeScript declaration.
  return (await import("../../standalone/resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
}

describe("Director orphan BITD recovery", () => {
  it("reads ProjectorRays little-endian KEY records with reversed FourCC values", async () => {
    const { readDirectorKeyEntries } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeReversedLittleEndianKey(chunksRoot, [
      { sectionID: 3406, castID: 6, fourCC: "CLUT" },
      { sectionID: 4725, castID: 8, fourCC: "BITD" },
      { sectionID: 4726, castID: 8, fourCC: "Thum" },
      { sectionID: 4568, castID: 10, fourCC: "STXT" },
    ]);

    expect(readDirectorKeyEntries(chunksRoot)).toEqual([
      { sectionID: 3406, castID: 6, fourCC: "CLUT" },
      { sectionID: 4725, castID: 8, fourCC: "BITD" },
      { sectionID: 4726, castID: 8, fourCC: "Thum" },
      { sectionID: 4568, castID: 10, fourCC: "STXT" },
    ]);
  });

  it("prefers explicit KEY_ child mappings over orphan candidates", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, [{ sectionID: 10, castID: 99, fourCC: "BITD" }]);
    writeFileSync(path.join(chunksRoot, "BITD-10.bin"), Buffer.from([0xf9, 0xaa]));
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.from([0xf9, 0xbb]));

    const source = resolveBitmapBitdSource(chunksRoot, 99, bitmapMetadata(8));

    expect(source?.kind).toBe("key");
    expect(source?.sectionID).toBe(10);
  });

  it("recovers one unclaimed PackBits BITD with the exact Director bitmap byte length", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, [{ sectionID: 10, castID: 99, fourCC: "BITD" }]);
    writeFileSync(path.join(chunksRoot, "BITD-10.bin"), Buffer.from([0xf9, 0xaa]));
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.from([0xf9, 0xbb]));

    const source = resolveBitmapBitdSource(chunksRoot, 123, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-packbits-exact-length");
    expect(source?.sectionID).toBe(20);
    expect(source?.candidateSectionIds).toEqual([20]);
  });

  it("does not guess when more than one unclaimed BITD has the same exact length", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.from([0xf9, 0xbb]));
    writeFileSync(path.join(chunksRoot, "BITD-30.bin"), Buffer.from([0xf9, 0xcc]));

    const source = resolveBitmapBitdSource(chunksRoot, 123, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-ambiguous");
    expect(source?.sectionID).toBeUndefined();
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([20, 30]);
  });

  it("recovers ambiguous same-sized orphan frames by CAS member order for a coherent numbered series", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "frame_1", 8);
    writeBitmapMember(chunksRoot, 101, "frame_2", 8);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-30.bin"), Buffer.alloc(8, 0xbb));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-order-raw-exact-length");
    expect(source?.sectionID).toBe(30);
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([20, 30]);
  });

  it("recovers adjacent same-stem bitmap variants by CAS member order", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "hrz_mainfloor_nohotel", 8);
    writeBitmapMember(chunksRoot, 101, "hrz_mainfloor", 8);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(8, 0xbb));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-contiguous-name-order-raw-exact-length");
    expect(source?.sectionID).toBe(21);
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([20, 21]);
  });

  it("recovers adjacent source variants where one member uses a trailing letter suffix", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "room_planet_stars", 8);
    writeBitmapMember(chunksRoot, 101, "room_planet_starsb", 8);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(8, 0xbb));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-contiguous-name-order-raw-exact-length");
    expect(source?.sectionID).toBe(21);
  });

  it("recovers an adjacent numeric animation series whose frames have different geometry", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "cr_bird_0", 8);
    writeBitmapMember(chunksRoot, 101, "cr_bird_1", 4);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(4, 0xbb));
    writeFileSync(path.join(chunksRoot, "BITD-80.bin"), Buffer.alloc(8, 0xcc));

    const source = resolveBitmapBitdSource(chunksRoot, 100, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-numeric-series-order-raw-exact-length");
    expect(source?.sectionID).toBe(20);
    expect(source?.candidateSectionIds).toEqual([20, 21]);
  });

  it("recovers non-adjacent full-room background bitmaps by CAS and orphan BITD order", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 200, 101, 201, 102]);
    writeBitmapMember(chunksRoot, 100, "beach_bg", 8);
    writeBitmapMember(chunksRoot, 200, "ocean_layer_1", 4);
    writeBitmapMember(chunksRoot, 101, "room_snow_bg", 8);
    writeBitmapMember(chunksRoot, 201, "room_planet", 5);
    writeBitmapMember(chunksRoot, 102, "room_underwater_bg", 8);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(8, 0xbb));
    writeFileSync(path.join(chunksRoot, "BITD-22.bin"), Buffer.alloc(8, 0xcc));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-room-background-order-raw-exact-length");
    expect(source?.sectionID).toBe(21);
    expect(source?.candidateCount).toBe(3);
    expect(source?.candidateSectionIds).toEqual([20, 21, 22]);
  });

  it("recovers adjacent directional-prefix wall item variants by CAS member order", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "rightwall poster 1003", 8);
    writeBitmapMember(chunksRoot, 101, "leftwall poster 1003", 8);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(8, 0xbb));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-cas-contiguous-name-order-raw-exact-length");
    expect(source?.sectionID).toBe(21);
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([20, 21]);
  });

  it("recovers a contiguous same-variant room architecture run by full CAS and BITD order", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101, 102, 103, 104]);
    writeBitmapMember(chunksRoot, 100, "left_wallpart_3_a_0_0_0", 4);
    writeBitmapMember(chunksRoot, 101, "left_wallmask_3_a_0_0_0", 5);
    writeBitmapMember(chunksRoot, 102, "right_wallpart_3_a_0_2_0", 4);
    writeBitmapMember(chunksRoot, 103, "left_wallend_3_b_0_0_0", 2);
    writeBitmapMember(chunksRoot, 104, "right_wallend_3_b_0_2_0", 2);
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(4, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-21.bin"), Buffer.alloc(5, 0xbb));
    writeFileSync(path.join(chunksRoot, "BITD-22.bin"), Buffer.alloc(4, 0xcc));
    writeFileSync(path.join(chunksRoot, "BITD-23.bin"), Buffer.alloc(2, 0xdd));
    writeFileSync(path.join(chunksRoot, "BITD-24.bin"), Buffer.alloc(2, 0xee));
    writeFileSync(path.join(chunksRoot, "BITD-80.bin"), Buffer.alloc(4, 0x11));
    writeFileSync(path.join(chunksRoot, "BITD-120.bin"), Buffer.alloc(2, 0x22));

    const source = resolveBitmapBitdSource(chunksRoot, 102, bitmapMetadata(4));

    expect(source?.kind).toBe("orphan-cas-variant-run-order-raw-exact-length");
    expect(source?.sectionID).toBe(22);
    expect(source?.candidateCount).toBe(5);
    expect(source?.candidateSectionIds).toEqual([20, 21, 22, 23, 24]);
  });

  it("does not apply CAS order to unrelated same-sized bitmap members", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101]);
    writeBitmapMember(chunksRoot, 100, "white.pixel", 4);
    writeBitmapMember(chunksRoot, 101, "room_dimmer_image", 4);
    writeFileSync(path.join(chunksRoot, "BITD-4959.bin"), Buffer.from([255, 255, 255, 255]));
    writeFileSync(path.join(chunksRoot, "BITD-5054.bin"), Buffer.from([0, 0, 0, 0]));

    const source = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(4));

    expect(source?.kind).toBe("orphan-ambiguous");
    expect(source?.sectionID).toBeUndefined();
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([4959, 5054]);
  });

  it("recovers malformed bitmap metadata inside a coherent numeric animation series", async () => {
    const { recoverBitmapMetadataFromCastOrder, resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeCasRegistry(chunksRoot, [100, 101, 102]);
    writeMalformedBitmapMember(chunksRoot, 100, "petal_9");
    writeBitmapMember(chunksRoot, 101, "petal_10", 8, { x: 4, y: 7 });
    writeBitmapMember(chunksRoot, 102, "petal_11", 8, { x: 4, y: 7 });
    writeFileSync(path.join(chunksRoot, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
    writeFileSync(path.join(chunksRoot, "BITD-30.bin"), Buffer.alloc(8, 0xbb));
    writeFileSync(path.join(chunksRoot, "BITD-40.bin"), Buffer.alloc(8, 0xcc));

    const recovered = recoverBitmapMetadataFromCastOrder(chunksRoot, 100);
    expect(recovered?.metadataSource).toBe("cas-order-recovered-neighbor-bitmap");
    expect(recovered?.width).toBe(8);
    expect(recovered?.height).toBe(1);
    expect(recovered?.regPoint).toEqual({ x: 4, y: 7 });

    const first = resolveBitmapBitdSource(chunksRoot, 100, recovered as Record<string, number>);
    const second = resolveBitmapBitdSource(chunksRoot, 101, bitmapMetadata(8));
    const third = resolveBitmapBitdSource(chunksRoot, 102, bitmapMetadata(8));

    expect(first?.kind).toBe("orphan-cas-order-raw-exact-length");
    expect(first?.sectionID).toBe(20);
    expect(second?.sectionID).toBe(30);
    expect(third?.sectionID).toBe(40);
  });

  it("does not guess from nearest orphan section when exact-size candidates are not clustered", async () => {
    const { resolveBitmapBitdSource } = await recoveryModule();
    const chunksRoot = makeChunksRoot();
    writeKey(chunksRoot, []);
    writeFileSync(path.join(chunksRoot, "BITD-130.bin"), Buffer.from([0xf9, 0xbb]));
    writeFileSync(path.join(chunksRoot, "BITD-900.bin"), Buffer.from([0xf9, 0xcc]));

    const source = resolveBitmapBitdSource(chunksRoot, 100, bitmapMetadata(8));

    expect(source?.kind).toBe("orphan-ambiguous");
    expect(source?.sectionID).toBeUndefined();
    expect(source?.candidateCount).toBe(2);
    expect(source?.candidateSectionIds).toEqual([130, 900]);
  });
});

function makeChunksRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "director-bitd-recovery-"));
  const chunksRoot = path.join(root, "chunks");
  mkdirSync(chunksRoot);
  return chunksRoot;
}

function writeKey(chunksRoot: string, entries: Array<{ sectionID: number; castID: number; fourCC: string }>): void {
  const bytes = Buffer.alloc(12 + entries.length * 12);
  entries.forEach((entry, index) => {
    const offset = 12 + index * 12;
    bytes.writeUInt32BE(entry.sectionID, offset);
    bytes.writeUInt32BE(entry.castID, offset + 4);
    bytes.write(entry.fourCC, offset + 8, 4, "latin1");
  });
  writeFileSync(path.join(chunksRoot, "KEY_-3.bin"), bytes);
}

function writeReversedLittleEndianKey(chunksRoot: string, entries: Array<{ sectionID: number; castID: number; fourCC: string }>): void {
  const bytes = Buffer.alloc(12 + entries.length * 12);
  entries.forEach((entry, index) => {
    const offset = 12 + index * 12;
    bytes.writeUInt32LE(entry.sectionID, offset);
    bytes.writeUInt32LE(entry.castID, offset + 4);
    bytes.write([...entry.fourCC].reverse().join(""), offset + 8, 4, "latin1");
  });
  writeFileSync(path.join(chunksRoot, "KEY_-3.bin"), bytes);
}

function writeCasRegistry(chunksRoot: string, memberIDs: number[]): void {
  writeFileSync(path.join(chunksRoot, "CAS_-1.json"), `${JSON.stringify({ memberIDs })}\n`);
}

function writeBitmapMember(
  chunksRoot: string,
  memberChunkId: number,
  name: string,
  expectedBytes: number,
  regPoint = { x: 0, y: 0 },
): void {
  writeFileSync(path.join(chunksRoot, `CASt-${memberChunkId}.json`), `${JSON.stringify({ type: 1, info: { name } })}\n`);
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(28, 8);
  const data = Buffer.alloc(28);
  data.writeUInt16BE(0x8000 | expectedBytes, 0);
  data.writeInt16BE(0, 2);
  data.writeInt16BE(0, 4);
  data.writeInt16BE(1, 6);
  data.writeInt16BE(expectedBytes, 8);
  data.writeInt16BE(regPoint.y, 18);
  data.writeInt16BE(regPoint.x, 20);
  data[23] = 8;
  writeFileSync(path.join(chunksRoot, `CASt-${memberChunkId}.bin`), Buffer.concat([header, data]));
}

function writeMalformedBitmapMember(chunksRoot: string, memberChunkId: number, name: string): void {
  writeFileSync(path.join(chunksRoot, `CASt-${memberChunkId}.json`), `${JSON.stringify({ type: 1, info: { name } })}\n`);
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(2, 8);
  writeFileSync(path.join(chunksRoot, `CASt-${memberChunkId}.bin`), Buffer.concat([header, Buffer.alloc(2)]));
}

function bitmapMetadata(expectedBytes: number): Record<string, number> {
  return {
    width: expectedBytes,
    height: 1,
    bitDepth: 8,
    pitch: expectedBytes,
  };
}
