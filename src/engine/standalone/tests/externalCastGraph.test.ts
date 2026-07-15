import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const standaloneRoot = fileURLToPath(new URL("..", import.meta.url));

describe("external cast graph", () => {
  it("uses the DRCF authored member range for sparse CAS registries", () => {
    const root = join(tmpdir(), `shockless-cast-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const releaseRoot = join(root, "extracted");
    const chunksRoot = join(releaseRoot, "hh_test", "chunks");
    mkdirSync(chunksRoot, { recursive: true });
    try {
      writeFileSync(join(chunksRoot, "DRCF-1.json"), JSON.stringify({ minMember: 5, maxMember: 7 }));
      writeFileSync(join(chunksRoot, "CAS_-2.json"), JSON.stringify({ memberIDs: [100, 0, 200] }));
      writeFileSync(join(chunksRoot, "CASt-100.json"), JSON.stringify({ type: 1, info: { name: "bitmap_at_five" } }));
      writeFileSync(join(chunksRoot, "CASt-200.json"), JSON.stringify({ type: 4, info: { name: "palette_at_seven" } }));

      const summaryPath = join(root, "projectorrays-summary.json");
      const fieldsPath = join(root, "external-fields.json");
      const outPath = join(root, "external-cast-graph.release999.json");
      writeFileSync(summaryPath, JSON.stringify({
        releases: [{ release: "release999", sourceRelease: "release999", outputRoot: releaseRoot, entryMovie: "habbo.dcr" }],
      }));
      writeFileSync(fieldsPath, JSON.stringify({
        releases: [{
          versionId: "release999",
          sourceId: "fixture",
          fields: [{ name: "external_variables.txt", sourcePath: "fixture", properties: { "cast.entry.1": "hh_test" } }],
        }],
      }));

      const result = spawnSync(
        process.execPath,
        [
          join(standaloneRoot, "resources", "extraction", "build-external-cast-graph.mjs"),
          "--summary", summaryPath,
          "--external-fields", fieldsPath,
          "--out", outPath,
          "--version", "release999",
        ],
        { cwd: standaloneRoot, encoding: "utf8" },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${String(result.error ?? "")}`);
      const cast = JSON.parse(readFileSync(outPath, "utf8")).releases[0].casts[0];
      assert.equal(cast.minMember, 5);
      assert.equal(cast.maxMember, 7);
      assert.equal(cast.memberSlotCount, 3);
      assert.deepEqual(cast.members.map((member: { number: number }) => member.number), [5, 7]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
