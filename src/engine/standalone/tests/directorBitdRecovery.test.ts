import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

type RecoveryModule = {
  readDirectorKeyEntries(chunksRoot: string): Array<{ sectionID: number; castID: number; fourCC: string }>;
  resolveBitmapBitdSource(
    chunksRoot: string,
    memberChunkId: number,
    bitmap: Record<string, unknown>,
  ): { kind: string; sectionID?: number } | undefined;
};

describe("Director BITD recovery", () => {
  it("reads big-endian KEY records and reuses same-name keyed duplicate bitmap sources", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-recovery");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([{ sectionID: 20, castID: 200, fourCC: "BITD" }]));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "wall_piece" } }));
      writeFileSync(join(root, "CASt-200.json"), JSON.stringify({ type: 1, info: { name: "wall_piece" } }));
      writeFileSync(join(root, "CASt-200.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.from([1, 2]));

      assert.deepEqual(recovery.readDirectorKeyEntries(root), [{ sectionID: 20, castID: 200, fourCC: "BITD" }]);
      const source = recovery.resolveBitmapBitdSource(root, 100, {
        width: 2,
        height: 1,
        bitDepth: 8,
        pitch: 2,
        regPoint: { x: 0, y: 0 },
      });
      assert.equal(source?.kind, "keyed-same-name-bitmap-member");
      assert.equal(source?.sectionID, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ProjectorRays little-endian KEY records with reversed FourCC values", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-reversed-key");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "KEY_-3.bin"),
        reversedLittleEndianKeyChunk([
          { sectionID: 3406, castID: 6, fourCC: "CLUT" },
          { sectionID: 4725, castID: 8, fourCC: "BITD" },
          { sectionID: 4726, castID: 8, fourCC: "Thum" },
          { sectionID: 4568, castID: 10, fourCC: "STXT" },
        ]),
      );

      assert.deepEqual(recovery.readDirectorKeyEntries(root), [
        { sectionID: 3406, castID: 6, fourCC: "CLUT" },
        { sectionID: 4725, castID: 8, fourCC: "BITD" },
        { sectionID: 4726, castID: 8, fourCC: "Thum" },
        { sectionID: 4568, castID: 10, fourCC: "STXT" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses contiguous CAS member order for same-stem unkeyed bitmap variants", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-contiguous-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 101] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "landscape_cloud_1_left" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "landscape_cloud_1_right" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.from([1, 2]));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.from([3, 4]));

      const source = recovery.resolveBitmapBitdSource(root, 101, {
        width: 2,
        height: 1,
        bitDepth: 8,
        pitch: 2,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-contiguous-name-order-raw-exact-length");
      assert.equal(source?.sectionID, 21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses contiguous CAS order for a trailing-letter source variant", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-trailing-letter-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 101] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "room_planet_stars" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "room_planet_starsb" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.from([1, 2]));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.from([3, 4]));

      const source = recovery.resolveBitmapBitdSource(root, 101, {
        width: 2,
        height: 1,
        bitDepth: 8,
        pitch: 2,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-contiguous-name-order-raw-exact-length");
      assert.equal(source?.sectionID, 21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a unique orphan byte-length sequence for numeric frames with different geometry", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-separated-numeric-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 101] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "cr_bird_0" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "cr_bird_1" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 1, height: 1, pitch: 1 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.from([1, 2]));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.from([3]));
      writeFileSync(join(root, "BITD-80.bin"), Buffer.from([4, 5]));

      const source = recovery.resolveBitmapBitdSource(root, 100, {
        width: 2,
        height: 1,
        bitDepth: 8,
        pitch: 2,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-numeric-series-order-raw-exact-length");
      assert.equal(source?.sectionID, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses CAS and orphan BITD order for non-adjacent full-room background bitmaps", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-background-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 200, 101, 201, 102] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "beach_bg" } }));
      writeFileSync(join(root, "CASt-200.json"), JSON.stringify({ type: 1, info: { name: "ocean_layer_1" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "room_snow_bg" } }));
      writeFileSync(join(root, "CASt-201.json"), JSON.stringify({ type: 1, info: { name: "room_planet" } }));
      writeFileSync(join(root, "CASt-102.json"), JSON.stringify({ type: 1, info: { name: "room_underwater_bg" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 8, height: 1, pitch: 8 }));
      writeFileSync(join(root, "CASt-200.bin"), bitmapCastChunk({ width: 4, height: 1, pitch: 4 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 8, height: 1, pitch: 8 }));
      writeFileSync(join(root, "CASt-201.bin"), bitmapCastChunk({ width: 5, height: 1, pitch: 5 }));
      writeFileSync(join(root, "CASt-102.bin"), bitmapCastChunk({ width: 8, height: 1, pitch: 8 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.alloc(8, 0xaa));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.alloc(8, 0xbb));
      writeFileSync(join(root, "BITD-22.bin"), Buffer.alloc(8, 0xcc));

      const source = recovery.resolveBitmapBitdSource(root, 101, {
        width: 8,
        height: 1,
        bitDepth: 8,
        pitch: 8,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-room-background-order-raw-exact-length");
      assert.equal(source?.sectionID, 21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses contiguous CAS member order for directional prefix wall item variants", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-directional-prefix-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 101] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "rightwall poster 1003" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "leftwall poster 1003" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.from([1, 2]));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.from([3, 4]));

      const source = recovery.resolveBitmapBitdSource(root, 101, {
        width: 2,
        height: 1,
        bitDepth: 8,
        pitch: 2,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-contiguous-name-order-raw-exact-length");
      assert.equal(source?.sectionID, 21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a full same-variant architecture run to resolve ambiguous orphan BITDs", async () => {
    // @ts-ignore resources are plain ESM extraction tools used by the packaged importer.
    const recovery = (await import("../resources/extraction/director-bitd-recovery.mjs")) as RecoveryModule;
    const root = tempRoot("bitd-variant-run-order");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "KEY_-3.bin"), keyChunk([]));
      writeFileSync(join(root, "CAS_-1.json"), JSON.stringify({ memberIDs: [100, 101, 102, 103, 104] }));
      writeFileSync(join(root, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "left_wallpart_3_a_0_0_0" } }));
      writeFileSync(join(root, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "left_wallmask_3_a_0_0_0" } }));
      writeFileSync(join(root, "CASt-102.json"), JSON.stringify({ type: 1, info: { name: "right_wallpart_3_a_0_2_0" } }));
      writeFileSync(join(root, "CASt-103.json"), JSON.stringify({ type: 1, info: { name: "left_wallend_3_b_0_0_0" } }));
      writeFileSync(join(root, "CASt-104.json"), JSON.stringify({ type: 1, info: { name: "right_wallend_3_b_0_2_0" } }));
      writeFileSync(join(root, "CASt-100.bin"), bitmapCastChunk({ width: 4, height: 1, pitch: 4 }));
      writeFileSync(join(root, "CASt-101.bin"), bitmapCastChunk({ width: 5, height: 1, pitch: 5 }));
      writeFileSync(join(root, "CASt-102.bin"), bitmapCastChunk({ width: 4, height: 1, pitch: 4 }));
      writeFileSync(join(root, "CASt-103.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "CASt-104.bin"), bitmapCastChunk({ width: 2, height: 1, pitch: 2 }));
      writeFileSync(join(root, "BITD-20.bin"), Buffer.alloc(4, 0xaa));
      writeFileSync(join(root, "BITD-21.bin"), Buffer.alloc(5, 0xbb));
      writeFileSync(join(root, "BITD-22.bin"), Buffer.alloc(4, 0xcc));
      writeFileSync(join(root, "BITD-23.bin"), Buffer.alloc(2, 0xdd));
      writeFileSync(join(root, "BITD-24.bin"), Buffer.alloc(2, 0xee));
      writeFileSync(join(root, "BITD-80.bin"), Buffer.alloc(4, 0x11));
      writeFileSync(join(root, "BITD-120.bin"), Buffer.alloc(2, 0x22));

      const source = recovery.resolveBitmapBitdSource(root, 102, {
        width: 4,
        height: 1,
        bitDepth: 8,
        pitch: 4,
        regPoint: { x: 0, y: 0 },
      });

      assert.equal(source?.kind, "orphan-cas-variant-run-order-raw-exact-length");
      assert.equal(source?.sectionID, 22);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function keyChunk(entries: Array<{ sectionID: number; castID: number; fourCC: string }>): Buffer {
  const buffer = Buffer.alloc(12 + entries.length * 12);
  for (const [index, entry] of entries.entries()) {
    const offset = 12 + index * 12;
    buffer.writeUInt32BE(entry.sectionID, offset);
    buffer.writeUInt32BE(entry.castID, offset + 4);
    buffer.write(entry.fourCC, offset + 8, 4, "latin1");
  }
  return buffer;
}

function reversedLittleEndianKeyChunk(entries: Array<{ sectionID: number; castID: number; fourCC: string }>): Buffer {
  const buffer = Buffer.alloc(12 + entries.length * 12);
  for (const [index, entry] of entries.entries()) {
    const offset = 12 + index * 12;
    buffer.writeUInt32LE(entry.sectionID, offset);
    buffer.writeUInt32LE(entry.castID, offset + 4);
    buffer.write([...entry.fourCC].reverse().join(""), offset + 8, 4, "latin1");
  }
  return buffer;
}

function bitmapCastChunk(input: { width: number; height: number; pitch: number }): Buffer {
  const buffer = Buffer.alloc(12 + 28);
  buffer.writeUInt32BE(0, 4);
  buffer.writeUInt32BE(28, 8);
  const offset = 12;
  buffer.writeUInt16BE(0x8000 | input.pitch, offset);
  buffer.writeInt16BE(0, offset + 2);
  buffer.writeInt16BE(0, offset + 4);
  buffer.writeInt16BE(input.height, offset + 6);
  buffer.writeInt16BE(input.width, offset + 8);
  buffer.writeInt16BE(0, offset + 18);
  buffer.writeInt16BE(0, offset + 20);
  buffer.writeUInt8(8, offset + 23);
  buffer.writeInt16BE(1, offset + 26);
  return buffer;
}

function tempRoot(name: string): string {
  return join(tmpdir(), `hoe-standalone-${process.pid}-${Date.now()}-${name}`);
}
