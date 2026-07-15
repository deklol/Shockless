import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

// Extraction modules are shipped as native ESM JavaScript and exercised here at runtime.
// @ts-expect-error No declaration file is emitted for extraction resources.
import { createDirectorBuiltInPalette } from "../resources/extraction/director-built-in-palettes.mjs";
// @ts-expect-error No declaration file is emitted for extraction resources.
import { resolveDirectorBitmapPalette } from "../resources/extraction/director-palette-reference.mjs";

const EXPECTED_PALETTES = [
  [-1, "systemMac", "5e107e5a1b7f8563fb8c3ed3b726465b253f73e41bc3dde147c1312bd1eb45dc"],
  [-2, "rainbow", "56f3b3017d2f8a32e3639d0a39d6a1f5019f126cd529e0772a8b3482729162c7"],
  [-3, "grayscale", "346f6a25ad11ec5b45a83392366f269058ba209d2877491634a2405f86beb3db"],
  [-4, "pastels", "b265fe8e6125e5518e677f0d9959a88d2fd383e27c9a0503c5efbaa22d31aaf8"],
  [-5, "vivid", "8e4b5f3a27f05f4a3a0c106e0e6c0e8199f6c4681692373b51bd11efc775aa78"],
  [-6, "ntsc", "baa5b6f063a5938a7c5def8495488a26394e9a46191d6a274dc3af1714e24e47"],
  [-7, "metallic", "ae407708bc4c43a45c1e23e5dd30b3755a2a4aae3e183c37afeda187a038a993"],
  [-101, "systemWinDir4", "80dd06fb54f93b88f483f8fe8435fa69edcdcc62ab29fd0ae8fa2d38caf0e044"],
  [-102, "systemWin", "88ec19a1219c9fb03a93bbf12c649f0c31250f7877a3a27076d7791165560020"],
] as const;

describe("Director built-in palettes", () => {
  for (const [member, name, expectedHash] of EXPECTED_PALETTES) {
    it(`preserves the exact ${name} RGB table`, () => {
      const palette = createDirectorBuiltInPalette(member);
      assert.ok(palette);
      assert.equal(palette.name, name);
      assert.equal(palette.colors.length, 256);

      const bytes = Buffer.from(palette.colors.flatMap(({ r, g, b }: { r: number; g: number; b: number }) => [r, g, b]));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
    });
  }

  it("does not invent a palette for an invalid built-in member", () => {
    assert.equal(createDirectorBuiltInPalette(-150), undefined);
  });

  it("uses Director System Mac rendering for invalid saved built-in ids", () => {
    const reference = resolveDirectorBitmapPalette({
      sourceCast: { name: "test", members: [] },
      bitmap: { paletteCastLib: -1, paletteMemberNumber: -149 },
      readPalette: () => undefined,
    });

    assert.equal(reference.palette.name, "systemMac");
    assert.equal(reference.sourceMember, -149);
    assert.equal(reference.sourceKind, "builtin");
    assert.equal(reference.resolution, "invalid-built-in-system-mac-fallback");
    assert.equal(reference.sourceReferenceValid, false);
  });
});
