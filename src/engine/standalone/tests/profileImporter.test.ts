import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILE_RUNTIME_DATA_SCHEMA_VERSION } from "../src/common/types.js";
import { ProfileImporter, validateCompiledClient, validateRuntimeReadiness } from "../src/main/profileImporter.js";
import { requiredRuntimeDataFiles } from "../src/main/originsRuntimeAdapter.js";

describe("standalone profile importer", () => {
  it("rejects folders without the Origins entry movie", () => {
    const root = tempRoot("invalid");
    mkdirSync(root, { recursive: true });
    assert.throws(() => validateCompiledClient(root), /habbo\.dcr/);
    rmSync(root, { recursive: true, force: true });
  });

  it("imports a sanitized profile without mutating the source folder", async () => {
    const source = tempRoot("source-origins");
    const cache = tempRoot("cache");
    createMinimalClient(source);

    const importer = new ProfileImporter({ cacheRoot: cache, runProjectorRays: false, engineRoot: tempRoot("missing-engine") });
    const profile = await importer.importProfile({
      clientRoot: source,
      fixedStage: true,
      resizablePresentation: false,
    });

    assert.equal(profile.buildNumber, null);
    assert.equal(profile.status, "imported");
    assert.equal(profile.runtime.ready, false);
    assert.match(profile.runtime.reason ?? "", /supported Origins build|Missing runtime-data/);
    assert.doesNotThrow(() => validateCompiledClient(source));
    assert.equal(existsSync(join(source, "external_variables.txt")), true);
    assert.equal(existsSync(join(profile.profileRoot ?? "", "client", "external_variables.txt")), true);
    assert.equal(existsSync(join(profile.profileRoot ?? "", "client", "external_texts.txt")), true);
    rmSync(source, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("writes new imports to the configured portable clients root", async () => {
    const source = tempRoot("source-portable-origins");
    const cache = tempRoot("cache-portable");
    const clients = tempRoot("clients-portable");
    createMinimalClient(source);

    const importer = new ProfileImporter({
      cacheRoot: cache,
      profilesRoot: clients,
      runProjectorRays: false,
      engineRoot: tempRoot("missing-engine"),
    });
    const profile = await importer.importProfile({
      clientRoot: source,
      fixedStage: true,
      resizablePresentation: false,
    });

    assert.equal(profile.profileRoot, join(clients, profile.id));
    assert.doesNotThrow(() => validateCompiledClient(join(clients, profile.id, "client")));
    rmSync(source, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    rmSync(clients, { recursive: true, force: true });
  });

  it("reuses an exact ready profile without copying or rebuilding it", async () => {
    const source = tempRoot("source-cache-hit");
    const cache = tempRoot("cache-hit");
    const clients = tempRoot("clients-cache-hit");
    createMinimalClient(source);
    const importer = new ProfileImporter({
      cacheRoot: cache,
      profilesRoot: clients,
      runProjectorRays: false,
      engineRoot: tempRoot("missing-engine"),
    });
    const request = { clientRoot: source, fixedStage: true, resizablePresentation: false } as const;
    const first = await importer.importProfile(request);
    const profilePath = join(first.profileRoot ?? "", "profile.json");
    const persisted = JSON.parse(readFileSync(profilePath, "utf8")) as { runtime: { ready: boolean } };
    persisted.runtime.ready = true;
    writeFileSync(profilePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    const progress: Array<{ state: string; cacheHits?: number }> = [];
    const second = await importer.importProfile(request, (entry) => progress.push(entry));

    assert.equal(second.id, first.id);
    assert.ok(progress.some((entry) => entry.cacheHits === 1));
    assert.ok(progress.some((entry) => entry.state === "skipped"));
    rmSync(source, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    rmSync(clients, { recursive: true, force: true });
  });

  it("stores an explicit manual VERSIONCHECK build override when provided", async () => {
    const source = tempRoot("source-version-override");
    const cache = tempRoot("cache-version-override");
    createMinimalClient(source);

    const importer = new ProfileImporter({ cacheRoot: cache, runProjectorRays: false, engineRoot: tempRoot("missing-engine") });
    const profile = await importer.importProfile({
      clientRoot: source,
      fixedStage: true,
      resizablePresentation: false,
      versionCheckBuild: 1300,
    });

    assert.equal(profile.versionCheckBuild, 1300);
    rmSync(source, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("keeps source client.version.id separate from the VERSIONCHECK build", async () => {
    const source = tempRoot("source-client-version-id");
    const cache = tempRoot("cache-client-version-id");
    createMinimalClient(source, { clientVersionId: 401 });

    const importer = new ProfileImporter({ cacheRoot: cache, runProjectorRays: false, engineRoot: tempRoot("missing-engine") });
    const profile = await importer.importProfile({
      clientRoot: source,
      fixedStage: true,
      resizablePresentation: false,
    });

    assert.equal(profile.versionCheckBuild, 1128);
    rmSync(source, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("accepts a parent compiled folder and imports the newest valid child build", async () => {
    const parent = tempRoot("compiled-parent");
    const cache = tempRoot("cache");
    createMinimalClient(join(parent, "318"));
    createMinimalClient(join(parent, "320"));

    const importer = new ProfileImporter({ cacheRoot: cache, runProjectorRays: false, engineRoot: tempRoot("missing-engine") });
    const profile = await importer.importProfile({
      clientRoot: parent,
      fixedStage: true,
      resizablePresentation: false,
    });

    assert.equal(profile.buildNumber, 320);
    assert.equal(profile.versionId, "release320");
    assert.equal(profile.sourceFolderName, "320");
    assert.doesNotThrow(() => validateCompiledClient(join(parent, "318")));
    assert.doesNotThrow(() => validateCompiledClient(join(parent, "320")));
    rmSync(parent, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("does not mark a future imported profile ready without executable generated scripts", () => {
    const root = tempRoot("future-profile");
    const runtimeDataRoot = join(root, "runtime-data");
    const scriptsRoot = join(root, "scripts");
    const extractedRoot = join(root, "extracted", "projectorrays", "future", "casts", "External");
    mkdirSync(runtimeDataRoot, { recursive: true });
    mkdirSync(scriptsRoot, { recursive: true });
    mkdirSync(extractedRoot, { recursive: true });
    for (const file of requiredRuntimeDataFiles("release999")) {
      writeFileSync(join(runtimeDataRoot, file), `${JSON.stringify({ releases: [{ versionId: "release999" }] })}\n`, "utf8");
    }
    writeFileSync(
      join(scriptsRoot, "profile-script-registry.json"),
      `${JSON.stringify({ versionId: "release999", scripts: [{ sourcePath: "future/casts/External/MovieScript 1.ls" }] })}\n`,
      "utf8",
    );
    writeFileSync(join(extractedRoot, "MovieScript 1.ls"), "on startMovie\nend\n", "utf8");

    const readiness = validateRuntimeReadiness(runtimeDataRoot, "release999", undefined, join(root, "extracted", "projectorrays"), {
      runtimeDataSchemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
    });

    assert.equal(readiness.ready, false);
    assert.equal(readiness.executableScriptsSupported, false);
    assert.ok(readiness.missingFiles.includes("scripts/executable/registry.js"));
    assert.match(readiness.reason ?? "", /does not include executable generated scripts for release999/);
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts profile-local executable scripts for future imported profiles", () => {
    const root = tempRoot("future-profile-executable");
    const runtimeDataRoot = join(root, "runtime-data");
    const assetsRoot = join(root, "assets");
    const scriptsRoot = join(root, "scripts", "executable");
    const extractedRoot = join(root, "extracted", "projectorrays", "future", "casts", "External");
    mkdirSync(runtimeDataRoot, { recursive: true });
    mkdirSync(assetsRoot, { recursive: true });
    mkdirSync(scriptsRoot, { recursive: true });
    mkdirSync(extractedRoot, { recursive: true });
    for (const file of requiredRuntimeDataFiles("release999")) {
      writeFileSync(join(runtimeDataRoot, file), `${JSON.stringify({ releases: [{ versionId: "release999" }] })}\n`, "utf8");
    }
    writeFileSync(join(root, "scripts", "profile-script-registry.json"), `${JSON.stringify({ versionId: "release999", scripts: [] })}\n`, "utf8");
    writeFileSync(join(extractedRoot, "MovieScript 1.ls"), "on startMovie\nend\n", "utf8");
    writeFileSync(join(scriptsRoot, "registry.js"), "export const generatedScripts = [];\n", "utf8");
    writeFileSync(
      join(scriptsRoot, "manifest.json"),
      `${JSON.stringify({ versionId: "release999", scriptCount: 1, failureCount: 0 })}\n`,
      "utf8",
    );

    const readiness = validateRuntimeReadiness(runtimeDataRoot, "release999", assetsRoot, join(root, "extracted", "projectorrays"), {
      runtimeDataSchemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
      skipProfileValidation: true,
      storedRuntime: {
        ready: true,
        missingFiles: [],
        assetReferences: 1,
        assetFilesReady: 1,
        assetFilesMissing: 0,
        assetFilesInvalid: 0,
      },
    });

    assert.equal(readiness.executableScriptsSupported, true);
    assert.equal(readiness.executableScriptVersion, "profile:release999");
    assert.ok(!readiness.missingFiles.includes("scripts/executable/registry.js"));
    rmSync(root, { recursive: true, force: true });
  });

  it("validates bitmap and sound assets through their declared media types", () => {
    const root = tempRoot("typed-profile-media");
    const runtimeDataRoot = join(root, "runtime-data");
    const assetsRoot = join(root, "assets");
    const scriptsRoot = join(root, "scripts", "executable");
    const extractedRoot = join(root, "extracted", "projectorrays", "future", "casts", "External");
    mkdirSync(runtimeDataRoot, { recursive: true });
    mkdirSync(join(assetsRoot, "bitmaps"), { recursive: true });
    mkdirSync(join(assetsRoot, "sounds"), { recursive: true });
    mkdirSync(scriptsRoot, { recursive: true });
    mkdirSync(extractedRoot, { recursive: true });
    for (const file of requiredRuntimeDataFiles("release999")) {
      writeFileSync(join(runtimeDataRoot, file), `${JSON.stringify({ releases: [{ versionId: "release999" }] })}\n`, "utf8");
    }
    writeFileSync(
      join(runtimeDataRoot, "external-bitmap-assets.release999.json"),
      `${JSON.stringify({ releases: [{ versionId: "release999", assets: [{ pngPath: "bitmaps/test.png" }] }] })}\n`,
      "utf8",
    );
    writeFileSync(
      join(runtimeDataRoot, "sound-assets.release999.json"),
      `${JSON.stringify({ schemaVersion: 3, sounds: [{ assetPath: "sounds/test.mp3" }] })}\n`,
      "utf8",
    );
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    writeFileSync(join(assetsRoot, "bitmaps", "test.png"), png);
    writeFileSync(join(assetsRoot, "sounds", "test.mp3"), Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000", "binary"));
    writeFileSync(join(root, "scripts", "profile-script-registry.json"), `${JSON.stringify({ versionId: "release999", scripts: [] })}\n`, "utf8");
    writeFileSync(join(extractedRoot, "MovieScript 1.ls"), "on startMovie\nend\n", "utf8");
    writeFileSync(join(scriptsRoot, "registry.js"), "export const generatedScripts = [];\n", "utf8");
    writeFileSync(
      join(scriptsRoot, "manifest.json"),
      `${JSON.stringify({ versionId: "release999", scriptCount: 1, failureCount: 0 })}\n`,
      "utf8",
    );

    const ready = validateRuntimeReadiness(runtimeDataRoot, "release999", assetsRoot, join(root, "extracted", "projectorrays"), {
      runtimeDataSchemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
      skipProfileValidation: true,
      validateAssetContents: true,
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.assetReferences, 2);
    assert.equal(ready.assetFilesReady, 2);
    assert.equal(ready.assetFilesInvalid, 0);

    writeFileSync(join(assetsRoot, "sounds", "test.mp3"), png);
    const invalidSound = validateRuntimeReadiness(runtimeDataRoot, "release999", assetsRoot, join(root, "extracted", "projectorrays"), {
      runtimeDataSchemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
      skipProfileValidation: true,
      validateAssetContents: true,
    });
    assert.equal(invalidSound.ready, false);
    assert.equal(invalidSound.assetFilesInvalid, 1);
    assert.match(invalidSound.reason ?? "", /invalid media assets/);
    rmSync(root, { recursive: true, force: true });
  });
});

function createMinimalClient(root: string, options: { readonly clientVersionId?: number } = {}): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "habbo.dcr"), Buffer.alloc(16, 1));
  writeFileSync(join(root, "fuse_client.cct"), Buffer.alloc(16, 1));
  writeFileSync(join(root, "external_variables.txt"), `client.version.id=${options.clientVersionId ?? 1128}\r`, "utf8");
  writeFileSync(join(root, "external_texts.txt"), "client.name=Habbo\r", "utf8");
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(join(root, `hh_test_${index}.cct`), Buffer.alloc(8, index + 1));
  }
  writeFileSync(join(root, "empty.cct"), Buffer.alloc(0));
}

function tempRoot(name: string): string {
  return join(tmpdir(), `hoe-standalone-${process.pid}-${Date.now()}-${name}`);
}
