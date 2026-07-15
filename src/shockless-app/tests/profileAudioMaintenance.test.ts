import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { profileNeedsAudioMaintenance } from "../src/main/profileAudioMaintenance.js";

test("profile audio maintenance detects missing, stale, malformed, and current sound metadata", () => {
  const profileRoot = join(tmpdir(), `shockless-profile-audio-${process.pid}-${Date.now()}`);
  const runtimeDataRoot = join(profileRoot, "runtime-data");
  const soundIndexPath = join(runtimeDataRoot, "sound-assets.release999.json");
  mkdirSync(runtimeDataRoot, { recursive: true });
  writeFileSync(
    join(profileRoot, "profile.json"),
    `${JSON.stringify({ versionId: "release999", paths: { runtimeData: "runtime-data" } })}\n`,
    "utf8",
  );

  try {
    assert.equal(profileNeedsAudioMaintenance(profileRoot), true, "missing sound index must be upgraded");

    writeFileSync(soundIndexPath, `${JSON.stringify({ schemaVersion: 2 })}\n`, "utf8");
    assert.equal(profileNeedsAudioMaintenance(profileRoot), true, "stale sound index must be upgraded");

    writeFileSync(soundIndexPath, "{not-json", "utf8");
    assert.equal(profileNeedsAudioMaintenance(profileRoot), true, "malformed sound index must be repaired");

    writeFileSync(soundIndexPath, `${JSON.stringify({ schemaVersion: 3 })}\n`, "utf8");
    assert.equal(profileNeedsAudioMaintenance(profileRoot), false, "current sound index must not be rebuilt");
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
});
