import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Extraction resources are runtime JavaScript modules, exercised directly so
// their binary offsets and member-number conversion are covered without mocks.
// @ts-expect-error JavaScript extraction helper has no declaration file.
import { directorMemberNumber, readDirectorCastMetadata } from "../resources/extraction/director-cast-metadata.mjs";

describe("Director cast metadata", () => {
  it("maps CAS registry indexes through DRCF minMember and reads the D5 default palette", () => {
    const root = join(tmpdir(), `shockless-director-cast-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const chunksRoot = join(root, "chunks");
    mkdirSync(chunksRoot, { recursive: true });
    try {
      writeFileSync(join(chunksRoot, "DRCF-1.json"), JSON.stringify({ minMember: 5, maxMember: 65 }));
      const config = Buffer.alloc(84);
      config.writeInt16BE(84, 0);
      config.writeInt16BE(1850, 2);
      config.writeInt16BE(-1, 76);
      config.writeInt16BE(-101, 78);
      writeFileSync(join(chunksRoot, "DRCF-1.bin"), config);

      const metadata = readDirectorCastMetadata(chunksRoot);
      assert.equal(metadata.minMember, 5);
      assert.equal(metadata.maxMember, 65);
      assert.equal(metadata.slotCount, 61);
      assert.equal(directorMemberNumber(0, metadata), 5);
      assert.equal(directorMemberNumber(11, metadata), 16);
      assert.deepEqual(metadata.defaultPalette, {
        sourceCastLib: -1,
        sourceMember: -101,
        resolvedCastLib: -1,
        resolvedMember: -102,
        kind: "builtin",
        name: "systemWin",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
