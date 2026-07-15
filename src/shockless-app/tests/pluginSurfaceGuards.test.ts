import assert from "node:assert/strict";
import { test } from "node:test";
import { plugins } from "../src/plugins/registry";
import {
  firstEnabledPanelSurface,
  pluginCommandsSurfaceEnabled,
  pluginDetailTabs,
  pluginSchemaActionGate,
} from "../src/renderer/ui/pluginSurfaceGuards";

const wallMover = plugins.find((plugin) => plugin.id === "wall-mover");
const social = plugins.find((plugin) => plugin.id === "social");

test("plugin detail panels only mount enabled panel surfaces", () => {
  assert.ok(wallMover);
  assert.equal(firstEnabledPanelSurface(wallMover, undefined, true), null);
  assert.equal(firstEnabledPanelSurface(wallMover, { panel: true }, true)?.id, "panel");
  assert.equal(firstEnabledPanelSurface(wallMover, { panel: true }, false), null);
});

test("plugin command tabs obey command surface toggles", () => {
  assert.ok(wallMover);
  assert.equal(pluginCommandsSurfaceEnabled(wallMover, { commands: false }, true), false);
  assert.equal(pluginCommandsSurfaceEnabled(wallMover, { commands: true }, true), true);
  assert.equal(pluginCommandsSurfaceEnabled(wallMover, { commands: true }, false), false);
  assert.deepEqual(pluginDetailTabs(wallMover, {
    pluginEnabled: true,
    surfaceEnabledById: { panel: true, commands: false },
    panelLayoutLength: 1,
    settingsLayoutLength: 0,
  }), ["panel", "preview"]);
});

test("schema action guard blocks disabled plugin and disabled surface side effects", () => {
  assert.ok(social);
  assert.deepEqual(pluginSchemaActionGate(social, false, { panel: true }, "panel"), {
    allowed: false,
    reason: "Social is disabled.",
  });
  assert.deepEqual(pluginSchemaActionGate(social, true, { panel: false }, "panel"), {
    allowed: false,
    reason: "Social Panel is disabled.",
  });
  assert.deepEqual(pluginSchemaActionGate(social, true, { panel: false }, "settings"), {
    allowed: true,
    reason: null,
  });
});
