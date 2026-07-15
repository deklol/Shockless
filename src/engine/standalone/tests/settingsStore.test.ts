import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettingsStore } from "../src/main/settingsStore.js";

describe("standalone settings store", () => {
  it("defaults new launcher settings to automatic version check build detection", () => {
    const root = tempRoot("default");
    const store = new SettingsStore(root);

    assert.equal(store.read().versionCheckBuild, null);

    rmSync(root, { recursive: true, force: true });
  });

  it("migrates known stale version check overrides back to automatic detection", () => {
    const root = tempRoot("version-override");
    mkdirSync(root, { recursive: true });
    const store = new SettingsStore(root);

    store.update({ versionCheckBuild: 1126 });

    assert.equal(store.read().versionCheckBuild, null);

    rmSync(root, { recursive: true, force: true });
  });

  it("can clear an explicit version check override", () => {
    const root = tempRoot("version-override-clear");
    mkdirSync(root, { recursive: true });
    const store = new SettingsStore(root);

    store.update({ versionCheckBuild: 1300 });
    store.update({ versionCheckBuild: null });

    assert.equal(store.read().versionCheckBuild, null);

    rmSync(root, { recursive: true, force: true });
  });

  it("preserves a new explicit version check override", () => {
    const root = tempRoot("version-override-current");
    mkdirSync(root, { recursive: true });
    const store = new SettingsStore(root);

    store.update({ versionCheckBuild: 1300 });

    assert.equal(store.read().versionCheckBuild, 1300);

    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips custom hotel view and migrates the temporary dashed key", () => {
    const root = tempRoot("custom-hotel-view");
    mkdirSync(root, { recursive: true });
    const store = new SettingsStore(root);

    store.update({ customHotelView: true });
    assert.equal(store.read().customHotelView, true);

    const legacyRoot = tempRoot("custom-hotel-view-legacy");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "settings.json"), `${JSON.stringify({ "custom-hotelview": true })}\n`, "utf8");
    assert.equal(new SettingsStore(legacyRoot).read().customHotelView, true);

    rmSync(root, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  });
});

function tempRoot(name: string): string {
  return join(tmpdir(), `hoe-settings-${process.pid}-${Date.now()}-${name}`);
}
