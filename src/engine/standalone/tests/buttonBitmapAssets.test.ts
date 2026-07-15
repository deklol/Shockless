import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const standaloneRoot = fileURLToPath(new URL("..", import.meta.url));

describe("button bitmap asset materializer", () => {
  it("records source-authored missing button parts without reporting decoder failure", () => {
    const root = join(tmpdir(), `shockless-button-source-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimeDataRoot = join(root, "runtime-data");
    const assetRoot = join(root, "assets");
    mkdirSync(runtimeDataRoot, { recursive: true });

    try {
      const graphPath = join(runtimeDataRoot, "external-cast-graph.release999.json");
      const fieldsPath = join(runtimeDataRoot, "external-cast-text-fields.release999.json");
      const outputPath = join(runtimeDataRoot, "button-bitmap-assets.release999.json");

      writeFileSync(
        graphPath,
        JSON.stringify({
          releases: [{
            versionId: "release999",
            release: "release999",
            sourceId: "fixture",
            casts: [{ name: "hh_dev", order: 1, resolved: true, members: [] }],
          }],
        }),
      );
      writeFileSync(
        fieldsPath,
        JSON.stringify({
          releases: [{
            versionId: "release999",
            fields: [{
              castName: "hh_dev",
              castOrder: 1,
              member: 48,
              memberChunkId: 59,
              memberName: "btn.element",
              textChunkPath: "fixture/STXT-1.bin",
              text: '[#state: #up, #members: [#left: [#member: "missing.left", #cast: 1]]]',
            }],
          }],
        }),
      );

      const result = spawnSync(
        process.execPath,
        [
          join(standaloneRoot, "resources", "extraction", "decode-button-element-bitmaps.mjs"),
          "--version", "release999",
          "--external-cast-graph", graphPath,
          "--external-cast-text-fields", fieldsPath,
          "--asset-root", assetRoot,
          "--asset-path-base", root,
          "--out", outputPath,
        ],
        { cwd: standaloneRoot, encoding: "utf8" },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${String(result.error ?? "")}`);
      const release = JSON.parse(readFileSync(outputPath, "utf8")).releases[0];
      assert.equal(release.unsupportedCount, 0);
      assert.equal(release.sourceMissingCount, 1);
      assert.deepEqual(release.sourceMissing[0], {
        elementName: "btn.element",
        memberName: "missing.left",
        reason: "source-authored button part name does not exist in the extracted cast graph",
      });
      assert.deepEqual(release.elements[0].states[0].parts, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
