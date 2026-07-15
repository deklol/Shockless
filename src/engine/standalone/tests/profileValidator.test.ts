import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROFILE_RUNTIME_DATA_SCHEMA_VERSION } from "../src/common/types.js";
import { validateProfileContract } from "../src/main/profileValidator.js";

describe("profile compiler validator", () => {
  it("accepts a complete minimal Director profile contract", () => {
    const root = createProfileFixture();
    try {
      const report = validateFixture(root);
      assert.equal(
        report.ready,
        true,
        JSON.stringify(report.issues.filter((issue) => issue.severity === "error"), null, 2),
      );
      assert.deepEqual(report.completion, {
        launchable: true,
        materializedReferenceComplete: true,
        sourceExtractionComplete: true,
        fidelityComplete: true,
      });
      assert.equal(report.issues.filter((issue) => issue.severity === "error").length, 0);
      assert.equal(report.inventory.assetReferences, 1);
      assert.equal(report.inventory.assetFilesReady, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails with an explicit inventory diagnostic when a declared sound is unsupported", () => {
    const root = createProfileFixture({
      soundMembers: [{ number: 7, memberChunkId: 70, name: "Unsupported Sound", type: "sound" }],
      soundIndex: {
        schemaVersion: 2,
        versionId: "release320",
        declaredSoundCount: 1,
        soundCount: 0,
        unsupportedCount: 1,
        sounds: [],
        unsupported: [{
          id: "release320:2:7",
          castName: "sound-test",
          castOrder: 2,
          member: 7,
          memberName: "Unsupported Sound",
          code: "unsupported-sound-resource",
          reason: "fixture encoding is unsupported",
        }],
        diagnostics: [],
      },
    });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, false);
      assert.equal(report.diagnostics.soundInventory.declared, 1);
      assert.equal(report.diagnostics.soundInventory.unsupported, 1);
      assert.ok(report.issues.some((issue) => issue.code === "director-sound-inventory" && issue.severity === "error"));
      assert.match(report.diagnostics.soundInventory.samples[0] ?? "", /Unsupported Sound/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the sound ledger drops a declared member entirely", () => {
    const root = createProfileFixture({
      soundMembers: [{ number: 8, memberChunkId: 80, name: "Missing Sound", type: "sound" }],
    });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, false);
      assert.equal(report.diagnostics.soundInventory.missing, 1);
      assert.ok(report.diagnostics.soundInventory.samples.includes("missing release320:2:8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts for sound members declared by resolved external casts", () => {
    const root = createProfileFixture({
      externalSoundMembers: [{ number: 103, name: "sound_machine_sample_0", type: "sound", memberChunkId: 13 }],
      soundIndex: {
        schemaVersion: 3,
        versionId: "release320",
        declaredSoundCount: 1,
        movieSoundCount: 0,
        externalSoundCount: 1,
        soundCount: 1,
        unsupportedCount: 0,
        sounds: [{
          id: "release320:external:74:hh_soundmachine:103",
          sourceKind: "external",
          castName: "hh_soundmachine",
          castOrder: 74,
          member: 103,
          memberName: "sound_machine_sample_0",
          container: "director-edim-mp3",
          codec: "mp3",
          sampleRate: 44100,
          channels: 1,
          sampleSize: null,
          sampleCount: 88200,
          durationMs: 2000,
          assetPath: "sounds/release320/hh_soundmachine/0103-sound_machine_sample_0.mp3",
          assetSha256: "a".repeat(64),
          source: { fourCC: "ediM" },
        }],
        unsupported: [],
        diagnostics: [],
      },
    });
    try {
      const report = validateFixture(root);
      assert.equal(
        report.ready,
        true,
        JSON.stringify(report.issues.filter((issue) => issue.severity === "error"), null, 2),
      );
      assert.equal(report.diagnostics.soundInventory.declared, 1);
      assert.equal(report.diagnostics.soundInventory.extracted, 1);
      assert.equal(report.diagnostics.soundInventory.missing, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts matching movie and external sound declarations once", () => {
    const soundRecord = {
      id: "release320:632:170",
      sourceKind: "movie",
      castName: "hh_trax_samples",
      castOrder: 632,
      member: 170,
      memberName: "sound_machine_sample_1",
      container: "director-edim-mp3",
      codec: "mp3",
      sampleRate: 44100,
      channels: 1,
      sampleSize: null,
      sampleCount: 88200,
      durationMs: 2000,
      assetPath: "sounds/release320/hh_trax_samples/0170-sound_machine_sample_1.mp3",
      assetSha256: "a".repeat(64),
      source: { fourCC: "ediM" },
    };
    const root = createProfileFixture({
      soundCast: {
        number: 632,
        name: "hh_trax_samples",
        members: [{ number: 170, name: "sound_machine_sample_1", type: "sound", memberChunkId: 1965 }],
      },
      externalSoundCast: {
        order: 75,
        name: "HH_TRAX_SAMPLES",
        resolved: true,
        minMember: 170,
        maxMember: 170,
        members: [{ number: 170, name: "sound_machine_sample_1", type: "sound", memberChunkId: 1965 }],
      },
      soundAssetFiles: ["sounds/release320/hh_trax_samples/0170-sound_machine_sample_1.mp3"],
      soundIndex: {
        schemaVersion: 3,
        versionId: "release320",
        declaredSoundCount: 1,
        movieSoundCount: 1,
        externalSoundCount: 0,
        soundCount: 1,
        unsupportedCount: 0,
        sounds: [soundRecord],
        unsupported: [],
        diagnostics: [],
      },
    });
    try {
      const report = validateFixture(root);
      assert.equal(
        report.ready,
        true,
        JSON.stringify(report.issues.filter((issue) => issue.severity === "error"), null, 2),
      );
      assert.equal(report.diagnostics.soundInventory.declared, 1);
      assert.equal(report.diagnostics.soundInventory.extracted, 1);
      assert.equal(report.diagnostics.soundInventory.extra, 0);
      assert.equal(report.diagnostics.soundInventory.missing, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when materialized bitmap metadata drops Director registration state", () => {
    const root = createProfileFixture({
      externalAssetPatch: {
        regPoint: undefined,
      },
    });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, false);
      assert.ok(report.issues.some((issue) => issue.code === "bitmap-director-metadata" && issue.severity === "error"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a referenced bitmap PNG is missing", () => {
    const root = createProfileFixture({ omitPng: true });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, false);
      assert.ok(report.issues.some((issue) => issue.code === "materialized-assets" && issue.severity === "error"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces partial exterior visual layout coverage as a warning without disabling launch", () => {
    const root = createProfileFixture({
      visualRecord: {
        visualName: "exterior_z",
        memberName: "exterior_z.visual",
        bitmapElementCount: 3,
        assetIds: ["release320:test:1"],
      },
      visualIndexRecord: {
        visualName: "exterior_z",
        memberName: "exterior_z.visual",
        bitmapReferences: [
          visualBitmapReference(1, "ready_piece"),
          visualBitmapReference(2, "missing_piece", { bitDepth: 32, bitdExists: false, bitdBytes: 0 }),
        ],
        unresolvedReferences: [],
      },
    });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, true);
      assert.equal(report.completion.launchable, true);
      assert.equal(report.completion.materializedReferenceComplete, true);
      assert.equal(report.completion.sourceExtractionComplete, false);
      assert.equal(report.completion.fidelityComplete, false);
      assert.ok(report.issues.some((issue) => issue.code === "exterior-visual-layout-coverage" && issue.severity === "warning"));
      assert.equal(report.diagnostics.visualLayoutClosure.exteriorPartialLayouts, 1);
      assert.equal(report.diagnostics.visualLayoutClosure.gaps[0]?.missingBitmapReferences[0]?.memberName, "missing_piece");
      assert.equal(report.diagnostics.visualLayoutClosure.gaps[0]?.missingBitmapReferences[0]?.reason, "missing-bitd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("groups unsupported bitmap extraction records by source reason", () => {
    const root = createProfileFixture({
      externalUnsupported: [
        { castName: "test", memberName: "missing_bitd_a", reason: "BITD path is missing" },
        { castName: "test", memberName: "missing_bitd_b", reason: "BITD path is missing" },
        { castName: "test", memberName: "bad_palette", reason: "palette -102 did not resolve" },
      ],
    });
    try {
      const report = validateFixture(root);
      assert.equal(report.ready, false);
      assert.equal(report.completion.sourceExtractionComplete, false);
      assert.equal(report.completion.fidelityComplete, false);
      assert.equal(report.diagnostics.unsupportedBitmapRecords.total, 3);
      assert.ok(report.issues.some((issue) => issue.code === "extractor-unsupported-bitmap-records" && issue.severity === "error"));
      assert.deepEqual(
        report.diagnostics.unsupportedBitmapRecords.byReason.map((entry) => [entry.reason, entry.count]),
        [
          ["BITD path is missing", 2],
          ["palette -102 did not resolve", 1],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks missing visual bitmap references as recoverable when Director BITD source exists", () => {
    const root = createProfileFixture({
      visualRecord: {
        visualName: "exterior_recoverable",
        memberName: "exterior_recoverable.visual",
        bitmapElementCount: 2,
        assetIds: ["release320:test:1"],
      },
      visualIndexRecord: {
        visualName: "exterior_recoverable",
        memberName: "exterior_recoverable.visual",
        bitmapReferences: [
          visualBitmapReference(1, "ready_piece", {}, 100),
          visualBitmapReference(2, "recoverable_piece", { width: 2, height: 1, bitDepth: 8, pitch: 2, bitdExists: false, bitdBytes: 0 }, 200),
        ],
        unresolvedReferences: [],
      },
    });
    try {
      writeRecoverableBitd(root, 20, 2);
      const report = validateFixture(root);
      const missing = report.diagnostics.visualLayoutClosure.gaps[0]?.missingBitmapReferences[0];
      assert.equal(report.ready, true);
      assert.ok(report.issues.some((issue) => issue.code === "recoverable-visual-layout-assets" && issue.severity === "warning"));
      assert.equal(missing?.memberName, "recoverable_piece");
      assert.equal(missing?.reason, "recoverable-bitd:orphan-raw-exact-length");
      assert.equal(missing?.sourceRecovery?.sectionID, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not require palette indices for direct-color or source-authored empty bitmap members", () => {
    for (const externalAssetPatch of [
      { bitDepth: 16, paletteColors: undefined, paletteIndexData: undefined },
      {
        width: 0,
        height: 0,
        bitDepth: 8,
        initialRect: { left: 0, top: 0, right: 0, bottom: 0 },
        paletteColors: [0, 16777215],
        paletteIndexData: "",
      },
    ]) {
      const root = createProfileFixture({ externalAssetPatch });
      try {
        const report = validateFixture(root);
        const paletteCheck = report.checks.find((check) => check.name === "indexed-bitmap-palettes");
        assert.equal(paletteCheck?.state, "pass");
        assert.equal(report.issues.some((issue) => issue.code === "indexed-bitmap-palettes"), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

function validateFixture(root: string) {
  return validateProfileContract({
    versionId: "release320",
    runtimeDataRoot: join(root, "runtime-data"),
    assetsRoot: join(root, "assets"),
    scriptsRoot: join(root, "scripts"),
    extractedRoot: join(root, "extracted", "projectorrays"),
    runtimeDataSchemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
  });
}

function createProfileFixture(
  options: {
    readonly omitPng?: boolean;
    readonly externalAssetPatch?: Record<string, unknown>;
    readonly externalUnsupported?: Record<string, unknown>[];
    readonly visualRecord?: Record<string, unknown>;
    readonly visualIndexRecord?: Record<string, unknown>;
    readonly soundMembers?: Record<string, unknown>[];
    readonly soundCast?: Record<string, unknown>;
    readonly externalSoundMembers?: Record<string, unknown>[];
    readonly externalSoundCast?: Record<string, unknown>;
    readonly soundAssetFiles?: string[];
    readonly soundIndex?: Record<string, unknown>;
  } = {},
): string {
  const root = join(tmpdir(), `hoe-profile-validator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const runtimeDataRoot = join(root, "runtime-data");
  const assetsRoot = join(root, "assets");
  const scriptsRoot = join(root, "scripts");
  const extractedRoot = join(root, "extracted", "projectorrays", "test", "casts", "External");
  mkdirSync(runtimeDataRoot, { recursive: true });
  mkdirSync(assetsRoot, { recursive: true });
  mkdirSync(scriptsRoot, { recursive: true });
  mkdirSync(extractedRoot, { recursive: true });
  writeFileSync(join(extractedRoot, "ParentScript 1 - Test Class.ls"), "on test me\nend\n", "utf8");
  writeFileSync(
    join(scriptsRoot, "profile-script-registry.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), versionId: "release320", scripts: [{ sourcePath: "test/casts/External/ParentScript 1 - Test Class.ls" }] }, null, 2)}\n`,
    "utf8",
  );

  const pngPath = "generated/assets/external-bitmaps/release320/test/0001-test.png";
  if (!options.omitPng) {
    const fullPng = join(assetsRoot, "external-bitmaps", "release320", "test", "0001-test.png");
    mkdirSync(join(fullPng, ".."), { recursive: true });
    writeFileSync(fullPng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
  }
  if (options.externalSoundMembers?.length) {
    const fullSound = join(assetsRoot, "sounds", "release320", "hh_soundmachine", "0103-sound_machine_sample_0.mp3");
    mkdirSync(join(fullSound, ".."), { recursive: true });
    writeFileSync(fullSound, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(16)]));
  }
  for (const assetPath of options.soundAssetFiles ?? []) {
    const fullSound = join(assetsRoot, assetPath);
    mkdirSync(join(fullSound, ".."), { recursive: true });
    writeFileSync(fullSound, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(16)]));
  }

  const asset = {
    id: "release320:test:1",
    castName: "test",
    member: 1,
    memberName: "test",
    mediaType: "bitmap",
    width: 1,
    height: 1,
    bitDepth: 8,
    pitch: 1,
    regPoint: { x: 0, y: 0 },
    initialRect: { left: 0, top: 0, right: 1, bottom: 1 },
    paletteColors: [0, 16777215],
    paletteIndexData: "AA==",
    sourcePaletteCastLib: -1,
    sourcePaletteMember: 0,
    resolvedPaletteCastLib: -1,
    resolvedPaletteMember: -1,
    sourcePaletteKind: "builtin",
    paletteResolution: "exact-built-in",
    sourcePaletteReferenceValid: true,
    pngPath,
    ...options.externalAssetPatch,
  };
  const visualRecord = options.visualRecord ?? {
    visualName: "complete_visual",
    memberName: "complete.visual",
    bitmapElementCount: 1,
    assetIds: ["release320:test:1"],
  };
  const visualIndexRecord = options.visualIndexRecord ?? {
    visualName: String(visualRecord.visualName ?? "complete_visual"),
    memberName: String(visualRecord.memberName ?? "complete.visual"),
    bitmapReferences: [visualBitmapReference(1, "test")],
    unresolvedReferences: [],
  };

  writeJson(join(runtimeDataRoot, "release320-projectorrays-manifest.json"), {
    versionId: "release320",
    casts: options.soundCast
      ? [options.soundCast]
      : options.soundMembers?.length
      ? [{ number: 2, name: "sound-test", members: options.soundMembers }]
      : [],
  });
  writeJson(join(runtimeDataRoot, "projectorrays-text-fields.release320.json"), { releases: [{ versionId: "release320", fields: [] }] });
  writeJson(join(runtimeDataRoot, "external-cast-text-fields.release320.json"), { releases: [{ versionId: "release320", fields: [] }] });
  writeJson(join(runtimeDataRoot, "external-cast-graph.release320.json"), {
    releases: [{
      versionId: "release320",
      casts: [
        { name: "test", resolved: true, minMember: 1, maxMember: 1, members: [{ number: 1, name: "test", type: "bitmap" }] },
        ...(options.externalSoundMembers?.length
          ? [{
              order: 74,
              name: "hh_soundmachine",
              resolved: true,
              minMember: 103,
              maxMember: 103,
              members: options.externalSoundMembers,
            }]
          : []),
        ...(options.externalSoundCast ? [options.externalSoundCast] : []),
      ],
    }],
  });
  writeJson(join(runtimeDataRoot, "external-bitmap-assets.release320.json"), {
    releases: [{ versionId: "release320", assets: [asset], unsupported: options.externalUnsupported ?? [] }],
  });
  writeJson(join(runtimeDataRoot, "visual-bitmap-assets.release320.json"), {
    releases: [
      {
        versionId: "release320",
        assets: [asset],
        unsupported: [],
        visuals: [visualRecord],
      },
    ],
  });
  writeJson(join(runtimeDataRoot, "external-cast-visual-layout-index.release320.json"), {
    releases: [{ versionId: "release320", visuals: [visualIndexRecord] }],
  });
  writeJson(join(runtimeDataRoot, "sound-assets.release320.json"), options.soundIndex ?? {
    schemaVersion: 2,
    versionId: "release320",
    declaredSoundCount: 0,
    soundCount: 0,
    unsupportedCount: 0,
    sounds: [],
    unsupported: [],
    diagnostics: [],
  });
  return root;
}

function visualBitmapReference(
  member: number,
  memberName: string,
  bitmapPatch: Record<string, unknown> = {},
  memberChunkId = member,
): Record<string, unknown> {
  return {
    castName: "test",
    member,
    memberChunkId,
    memberName,
    memberType: "bitmap",
    bitmap: {
      bitDepth: 8,
      bitdExists: true,
      bitdBytes: 12,
      paletteId: -1,
      ...bitmapPatch,
    },
  };
}

function writeRecoverableBitd(root: string, sectionId: number, expectedBytes: number): void {
  const chunksRoot = join(root, "extracted", "projectorrays", "test", "chunks");
  mkdirSync(chunksRoot, { recursive: true });
  writeFileSync(join(chunksRoot, "KEY_-3.bin"), Buffer.alloc(12));
  writeFileSync(join(chunksRoot, `BITD-${sectionId}.bin`), Buffer.alloc(expectedBytes));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
