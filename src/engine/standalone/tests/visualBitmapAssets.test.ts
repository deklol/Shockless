import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const standaloneRoot = fileURLToPath(new URL("..", import.meta.url));

describe("visual bitmap asset materializer", () => {
  it("materializes Director ediM JPEG media when no BITD chunk exists", async () => {
    // @ts-ignore jpeg-js is a CommonJS package used by the extraction tool.
    const jpeg = (await import("jpeg-js")).default;
    const root = tempRoot("visual-edim");
    try {
      const sourceRoot = join(root, "source");
      const runtimeDataRoot = join(root, "runtime-data");
      const assetRoot = join(root, "assets", "visual-bitmaps");
      const chunksRoot = join(sourceRoot, "hh_room_edim", "chunks");
      mkdirSync(chunksRoot, { recursive: true });
      mkdirSync(runtimeDataRoot, { recursive: true });

      writeFileSync(
        join(chunksRoot, "KEY_-3.bin"),
        reversedLittleEndianKeyChunk([
          { sectionID: 20, castID: 100, fourCC: "ediM" },
          { sectionID: 21, castID: 100, fourCC: "ALFA" },
        ]),
      );
      writeFileSync(join(chunksRoot, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "jpeg_glow" } }));
      writeFileSync(join(chunksRoot, "CASt-100.bin"), bitmapCastChunk({ width: 2, height: 2, pitch: 8, bitDepth: 32 }));
      writeFileSync(
        join(chunksRoot, "ediM-20.bin"),
        Buffer.from(
          jpeg.encode(
            {
              width: 2,
              height: 2,
              data: Buffer.from([
                255, 0, 0, 255,
                0, 255, 0, 255,
                0, 0, 255, 255,
                255, 255, 255, 255,
              ]),
            },
            100,
          ).data,
        ),
      );
      writeFileSync(join(chunksRoot, "ALFA-21.bin"), Buffer.from([3, 0, 128, 192, 255]));
      writeFileSync(
        join(runtimeDataRoot, "external-cast-graph.release999.json"),
        JSON.stringify({
          releases: [
            {
              versionId: "release999",
              casts: [
                {
                  name: "hh_room_edim",
                  order: 1,
                  resolved: true,
                  members: [{ number: 1, name: "jpeg_glow", type: "bitmap", memberChunkId: 100 }],
                },
              ],
            },
          ],
        }),
      );
      writeFileSync(
        join(runtimeDataRoot, "external-cast-visual-layout-index.release999.json"),
        JSON.stringify({
          releases: [
            {
              versionId: "release999",
              visuals: [
                {
                  memberName: "edim.room",
                  visualName: "edim",
                  elementCount: 1,
                  elements: [
                    {
                      index: 0,
                      media: "bitmap",
                      memberName: "jpeg_glow",
                      resolvedMember: {
                        castName: "hh_room_edim",
                        castOrder: 1,
                        member: 1,
                        memberName: "jpeg_glow",
                        memberType: "bitmap",
                        memberChunkId: 100,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outPath = join(root, "visual-bitmap-assets.release999.json");
      const result = spawnSync(
        process.execPath,
        [
          join(standaloneRoot, "resources", "extraction", "build-visual-bitmap-assets.mjs"),
          "--version",
          "release999",
          "--source-root",
          sourceRoot,
          "--runtime-data-root",
          runtimeDataRoot,
          "--asset-root",
          assetRoot,
          "--asset-path-base",
          join(root, "assets"),
          "--out",
          outPath,
          "--visual",
          "edim",
        ],
        { cwd: standaloneRoot, encoding: "utf8" },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${String(result.error ?? "")}`);
      const release = JSON.parse(readFileSync(outPath, "utf8")).releases[0];
      assert.equal(release.unsupportedCount, 0);
      const asset = release.assets.find((entry: Record<string, unknown>) => entry.memberName === "jpeg_glow");
      assert.equal(asset.sourceMediaFourCC, "ediM");
      assert.equal(asset.sourceMediaFormat, "jpeg");
      assert.equal(asset.sourceAlphaPath.endsWith("ALFA-21.bin"), true);
      assert.equal(asset.width, 2);
      assert.equal(asset.height, 2);
      assert.equal(existsSync(join(root, "assets", asset.pngPath)), true);
      assert.deepEqual(readFileSync(join(root, "assets", asset.pngPath)).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves bitmap palette carriers and preserves native media for runtime-only names", () => {
    const root = tempRoot("visual-layout-palettes");
    try {
      const sourceRoot = join(root, "source");
      const runtimeDataRoot = join(root, "runtime-data");
      const assetRoot = join(root, "assets", "visual-bitmaps");
      const chunksRoot = join(sourceRoot, "hh_room_palette", "chunks");
      mkdirSync(chunksRoot, { recursive: true });
      mkdirSync(runtimeDataRoot, { recursive: true });

      writeFileSync(
        join(chunksRoot, "KEY_-3.bin"),
        reversedLittleEndianKeyChunk([
          { sectionID: 20, castID: 100, fourCC: "BITD" },
          { sectionID: 21, castID: 101, fourCC: "BITD" },
          { sectionID: 22, castID: 102, fourCC: "CLUT" },
          { sectionID: 23, castID: 103, fourCC: "BITD" },
        ]),
      );
      writeFileSync(join(chunksRoot, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "carrier_target" } }));
      writeFileSync(join(chunksRoot, "CASt-101.json"), JSON.stringify({ type: 1, info: { name: "carrier" } }));
      writeFileSync(join(chunksRoot, "CASt-102.json"), JSON.stringify({ type: 4, info: { name: "native_palette" } }));
      writeFileSync(join(chunksRoot, "CASt-103.json"), JSON.stringify({ type: 1, info: { name: "runtime_target" } }));
      writeFileSync(join(chunksRoot, "CASt-100.bin"), bitmapCastChunk({ width: 1, height: 1, pitch: 1, bitDepth: 8, paletteMemberNumber: 3 }));
      writeFileSync(join(chunksRoot, "CASt-101.bin"), bitmapCastChunk({ width: 1, height: 1, pitch: 1, bitDepth: 8, paletteMemberNumber: 0 }));
      writeFileSync(join(chunksRoot, "CASt-103.bin"), bitmapCastChunk({ width: 1, height: 1, pitch: 1, bitDepth: 8, paletteMemberNumber: 3 }));
      writeFileSync(join(chunksRoot, "BITD-20.bin"), Buffer.from([1]));
      writeFileSync(join(chunksRoot, "BITD-21.bin"), Buffer.from([1]));
      writeFileSync(join(chunksRoot, "BITD-23.bin"), Buffer.from([1]));
      writeFileSync(join(chunksRoot, "CLUT-22.bin"), paletteChunk([0xffffff, 0xff0000]));

      const members = [
        { number: 1, name: "carrier_target", type: "bitmap", memberChunkId: 100 },
        { number: 2, name: "carrier", type: "bitmap", memberChunkId: 101 },
        { number: 3, name: "native_palette", type: "palette", memberChunkId: 102 },
        { number: 4, name: "runtime_target", type: "bitmap", memberChunkId: 103 },
      ];
      writeFileSync(
        join(runtimeDataRoot, "external-cast-graph.release999.json"),
        JSON.stringify({ releases: [{ versionId: "release999", casts: [{ name: "hh_room_palette", order: 1, resolved: true, members }] }] }),
      );
      writeFileSync(
        join(runtimeDataRoot, "external-cast-visual-layout-index.release999.json"),
        JSON.stringify({
          releases: [{
            versionId: "release999",
            visuals: [{
              memberName: "palette.room",
              visualName: "palette",
              elementCount: 2,
              elements: [
                visualElement(members[0]!, "carrier"),
                visualElement(members[3]!, "missing_runtime_palette"),
              ],
            }],
          }],
        }),
      );

      const outPath = join(root, "visual-bitmap-assets.release999.json");
      const result = spawnSync(
        process.execPath,
        [
          join(standaloneRoot, "resources", "extraction", "build-visual-bitmap-assets.mjs"),
          "--version", "release999",
          "--source-root", sourceRoot,
          "--runtime-data-root", runtimeDataRoot,
          "--asset-root", assetRoot,
          "--asset-path-base", join(root, "assets"),
          "--out", outPath,
          "--visual", "palette",
        ],
        { cwd: standaloneRoot, encoding: "utf8" },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${String(result.error ?? "")}`);
      const release = JSON.parse(readFileSync(outPath, "utf8")).releases[0];
      assert.equal(release.unsupportedCount, 0);
      const carrierTarget = release.assets.find((entry: Record<string, unknown>) => entry.memberName === "carrier_target");
      assert.equal(carrierTarget.layoutPaletteResolution, "exact-bitmap-palette");
      assert.equal(carrierTarget.layoutPaletteSourceMember, 2);
      assert.equal(carrierTarget.paletteName, "systemMac");
      assert.equal(carrierTarget.paletteColors[1], 0xffffcc);

      const runtimeTarget = release.assets.find((entry: Record<string, unknown>) => entry.memberName === "runtime_target");
      assert.equal(runtimeTarget.layoutPaletteResolution, "runtime-unresolved-member");
      assert.equal(runtimeTarget.paletteName, "native_palette");
      assert.equal(runtimeTarget.paletteColors[1], 0xff0000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function tempRoot(name: string): string {
  const root = join(tmpdir(), `habbo-origins-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
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

function bitmapCastChunk(options: { width: number; height: number; pitch: number; bitDepth: number; paletteMemberNumber?: number }): Buffer {
  const specific = Buffer.alloc(28);
  specific.writeUInt16BE(0x8000 | options.pitch, 0);
  specific.writeInt16BE(0, 2);
  specific.writeInt16BE(0, 4);
  specific.writeInt16BE(options.height, 6);
  specific.writeInt16BE(options.width, 8);
  specific.writeUInt8(1, 10);
  specific.writeInt16BE(0, 18);
  specific.writeInt16BE(0, 20);
  specific.writeUInt8(options.bitDepth, 23);
  specific.writeInt16BE(-1, 24);
  specific.writeInt16BE(options.paletteMemberNumber ?? 0, 26);

  const header = Buffer.alloc(12);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(specific.length, 8);
  return Buffer.concat([header, specific]);
}

function visualElement(member: { number: number; name: string; type: string; memberChunkId: number }, palette: string) {
  return {
    index: member.number,
    media: "bitmap",
    memberName: member.name,
    palette,
    resolvedMember: {
      castName: "hh_room_palette",
      castOrder: 1,
      member: member.number,
      memberName: member.name,
      memberType: member.type,
      memberChunkId: member.memberChunkId,
    },
  };
}

function paletteChunk(colors: number[]): Buffer {
  const buffer = Buffer.alloc(colors.length * 6);
  colors.forEach((rgb, index) => {
    const offset = index * 6;
    buffer.writeUInt16BE(((rgb >> 16) & 0xff) * 257, offset);
    buffer.writeUInt16BE(((rgb >> 8) & 0xff) * 257, offset + 2);
    buffer.writeUInt16BE((rgb & 0xff) * 257, offset + 4);
  });
  return buffer;
}
