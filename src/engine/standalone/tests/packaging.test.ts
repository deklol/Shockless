import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

describe("standalone packaging", () => {
  it("ships extraction script dependencies beside extraction resources", () => {
    const extraResources = packageJson.build?.extraResources ?? [];
    assert.ok(
      extraResources.some(
        (entry: { from?: string; to?: string }) =>
          entry.from === "node_modules/jpeg-js" && entry.to === "extraction/node_modules/jpeg-js",
      ),
      "jpeg-js must be available to Node scripts run from resources/extraction",
    );
  });
});
