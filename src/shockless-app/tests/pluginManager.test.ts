import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { appDataStorePath } from "../src/main/appDataPaths";
import { PluginManager } from "../src/main/pluginManager";

function withTempAppData(name: string, run: (appData: string) => void): void {
  const appData = mkdtempSync(join(tmpdir(), name));
  try {
    run(appData);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
}

function writePluginFixture(root: string, id = "fixture-plugin"): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "shockless.plugin.json"),
    `${JSON.stringify(
      {
        id,
        name: "Fixture Plugin",
        version: "0.1.0",
        author: "Local test",
        description: "Fixture plugin.",
        entry: "plugin.js",
        icon: "terminal",
        category: "developer",
        permissions: ["ui.panel", "console.commands"],
        surfaces: [
          {
            id: "panel",
            kind: "panel",
            label: "Fixture Panel",
            enabledByDefault: true,
            summary: "Fixture plugin panel.",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(root, "plugin.js"), "export function activate() { return { dispose() {} }; }\n", "utf8");
}

test("plugin manager keeps app-level tools out of the plugin registry and reserves their ids", () => {
  withTempAppData("habbpy-v4-plugin-core-", (appData) => {
    const manager = new PluginManager(appData);
    const state = manager.state();

    assert.equal(state.plugins.some((plugin) => plugin.id === "plugin-manager"), false);
    assert.equal(state.plugins.some((plugin) => plugin.id === "settings"), false);
    assert.equal(state.enabledById["plugin-manager"], undefined);
    assert.equal(state.enabledById.settings, undefined);

    const pluginManagerResult = manager.createFromTemplate({ id: "plugin-manager", name: "Plugin Manager" });
    assert.equal(pluginManagerResult.ok, false);
    assert.match(pluginManagerResult.message, /reserved/i);

    const settingsResult = manager.createFromTemplate({ id: "settings", name: "Settings" });
    assert.equal(settingsResult.ok, false);
    assert.match(settingsResult.message, /reserved/i);
  });
});

test("plugin manager refuses plugin sources with network or keyboard capture primitives", () => {
  withTempAppData("habbpy-v4-plugin-security-", (appData) => {
    const manager = new PluginManager(appData);
    const networkRoot = join(appData, "network-plugin");
    writePluginFixture(networkRoot, "network-plugin");
    writeFileSync(join(networkRoot, "plugin.js"), `export function activate() { return fetch("https://example.test/collect"); }\n`, "utf8");

    const networkResult = manager.installFromFolder(networkRoot);
    assert.equal(networkResult.ok, false);
    assert.match(networkResult.message, /blocked network APIs|external URL/i);

    const keyRoot = join(appData, "key-plugin");
    writePluginFixture(keyRoot, "key-plugin");
    writeFileSync(join(keyRoot, "plugin.js"), `export function activate() { addEventListener("keydown", () => {}); }\n`, "utf8");

    const keyResult = manager.installFromFolder(keyRoot);
    assert.equal(keyResult.ok, false);
    assert.match(keyResult.message, /keyboard event capture/i);
  });
});

test("plugin manager creates enabled user plugins from the local template", () => {
  withTempAppData("habbpy-v4-plugin-template-", (appData) => {
    const manager = new PluginManager(appData);
    const result = manager.createFromTemplate({ id: "local-toolkit", name: "Local Toolkit" });

    assert.equal(result.ok, true);
    assert.equal(result.state.enabledById["local-toolkit"], true);
    assert.ok(existsSync(join(manager.userPluginRoot(), "local-toolkit", "shockless.plugin.json")));
    assert.ok(existsSync(join(manager.userPluginRoot(), "local-toolkit", "plugin.js")));

    const created = result.state.plugins.find((plugin) => plugin.id === "local-toolkit");
    assert.ok(created);
    assert.equal(created.origin, "user");
    assert.equal(created.status, "ready");
    assert.equal(created.permissions?.includes("ui.panel"), true);

    const relayPolicy = manager.relayPolicy();
    assert.ok(relayPolicy.grants.some((grant) => grant.pluginId === "local-toolkit" && grant.permissions.includes("packet.read")));

    const disabled = manager.setPluginEnabled("local-toolkit", false);
    assert.equal(disabled.enabledById["local-toolkit"], false);
    assert.equal(manager.relayPolicy().grants.some((grant) => grant.pluginId === "local-toolkit"), false);
  });
});

test("plugin manager restores a usable primary surface for enabled plugins", () => {
  withTempAppData("habbpy-v4-plugin-surface-restore-", (appData) => {
    const settingsPath = appDataStorePath(appData, "plugins", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        version: 1,
        enabledById: { "wall-mover": true },
        uiSurfaceEnabledByPluginId: { "wall-mover": { panel: false, commands: false } },
        permissionGrants: {},
      }, null, 2)}\n`,
      "utf8",
    );

    const manager = new PluginManager(appData);
    const initial = manager.state();
    assert.equal(initial.enabledById["wall-mover"], true);
    assert.equal(initial.uiSurfaceEnabledByPluginId["wall-mover"]?.panel, true);
    assert.equal(initial.uiSurfaceEnabledByPluginId["wall-mover"]?.commands, false);

    const disabled = manager.setPluginEnabled("wall-mover", false);
    assert.equal(disabled.enabledById["wall-mover"], false);

    const enabled = manager.setPluginEnabled("wall-mover", true);
    assert.equal(enabled.enabledById["wall-mover"], true);
    assert.equal(enabled.uiSurfaceEnabledByPluginId["wall-mover"]?.panel, true);

    const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(stored.uiSurfaceEnabledByPluginId["wall-mover"].panel, true);
  });
});

test("plugin manager installs valid folders and refuses obvious private files", () => {
  withTempAppData("habbpy-v4-plugin-install-", (appData) => {
    const fixtureParent = mkdtempSync(join(tmpdir(), "habbpy-v4-plugin-source-"));
    try {
      const validRoot = join(fixtureParent, "valid-plugin");
      writePluginFixture(validRoot);

      const manager = new PluginManager(appData);
      const installed = manager.installFromFolder(validRoot);
      assert.equal(installed.ok, true);
      assert.equal(installed.state.enabledById["fixture-plugin"], true);
      assert.ok(existsSync(join(manager.userPluginRoot(), "fixture-plugin", "plugin.js")));

      const privateRoot = join(fixtureParent, "private-plugin");
      writePluginFixture(privateRoot, "private-fixture");
      writeFileSync(join(privateRoot, "webhook-token.txt"), "local test placeholder\n", "utf8");
      const refused = manager.installFromFolder(privateRoot);
      assert.equal(refused.ok, false);
      assert.match(refused.message, /credential|webhook/i);
    } finally {
      rmSync(fixtureParent, { recursive: true, force: true });
    }
  });
});

test("plugin manager still accepts legacy habbpy plugin manifests", () => {
  withTempAppData("habbpy-v4-plugin-legacy-manifest-", (appData) => {
    const fixtureParent = mkdtempSync(join(tmpdir(), "habbpy-v4-plugin-legacy-source-"));
    try {
      const legacyRoot = join(fixtureParent, "legacy-plugin");
      writePluginFixture(legacyRoot, "legacy-plugin");
      const manifestText = readFileSync(join(legacyRoot, "shockless.plugin.json"), "utf8");
      writeFileSync(join(legacyRoot, "habbpy.plugin.json"), manifestText, "utf8");
      rmSync(join(legacyRoot, "shockless.plugin.json"), { force: true });

      const manager = new PluginManager(appData);
      const installed = manager.installFromFolder(legacyRoot);
      assert.equal(installed.ok, true, installed.message);
      assert.equal(installed.state.enabledById["legacy-plugin"], true);
    } finally {
      rmSync(fixtureParent, { recursive: true, force: true });
    }
  });
});

test("plugin manager installs the welcome message example plugin", () => {
  withTempAppData("habbpy-v4-plugin-example-", (appData) => {
    const manager = new PluginManager(appData);
    const result = manager.installFromFolder(resolve("examples/premade-plugins/welcome-message"));

    assert.equal(result.ok, true);
    assert.equal(result.state.enabledById["welcome-message"], true);
    const plugin = result.state.plugins.find((entry) => entry.id === "welcome-message");
    assert.ok(plugin);
    assert.equal(plugin.origin, "user");
    assert.equal(plugin.permissions?.includes("events.room"), true);
    assert.equal(plugin.permissions?.includes("chat.send"), true);
    assert.equal(plugin.permissions?.includes("packet.inject"), false);
  });
});


test("plugin manager installs premade module source plugins", () => {
  withTempAppData("habbpy-v4-plugin-premade-", (appData) => {
    const manager = new PluginManager(appData);
    const result = manager.installFromFolder(resolve("examples/premade-plugins/room"));

    assert.equal(result.ok, true);
    assert.equal(result.state.enabledById["premade-room"], true);
    const plugin = result.state.plugins.find((entry) => entry.id === "premade-room");
    assert.ok(plugin);
    assert.equal(plugin.origin, "user");
    assert.equal(plugin.permissions?.includes("events.room"), true);
    assert.equal(plugin.permissions?.includes("engine.snapshot"), true);
  });
});

test("plugin manager installs premade modules with explicit action permissions", () => {
  withTempAppData("habbpy-v4-plugin-premade-actions-", (appData) => {
    const manager = new PluginManager(appData);
    for (const moduleId of ["user", "items", "wall-mover", "social"]) {
      const result = manager.installFromFolder(resolve("examples/premade-plugins", moduleId));
      assert.equal(result.ok, true, result.message);
    }

    const state = manager.state();
    assert.equal(state.plugins.find((entry) => entry.id === "premade-user")?.permissions?.includes("actions.avatar"), true);
    assert.equal(state.plugins.find((entry) => entry.id === "premade-items")?.permissions?.includes("actions.furni"), true);
    assert.equal(state.plugins.find((entry) => entry.id === "premade-wall-mover")?.permissions?.includes("actions.furni"), true);
    assert.equal(state.plugins.find((entry) => entry.id === "premade-wall-mover")?.permissions?.includes("actions.wallItems"), false);
    assert.equal(state.plugins.find((entry) => entry.id === "premade-social")?.permissions?.includes("actions.social"), true);
  });
});

test("generated premade modules use explicit host APIs instead of blanket action wrappers", () => {
  const user = readFileSync(resolve("examples/premade-plugins/user/plugin.js"), "utf8");
  const items = readFileSync(resolve("examples/premade-plugins/items/plugin.js"), "utf8");
  const wallMover = readFileSync(resolve("examples/premade-plugins/wall-mover/plugin.js"), "utf8");
  const social = readFileSync(resolve("examples/premade-plugins/social/plugin.js"), "utf8");
  const combined = [user, items, wallMover, social].join("\n");
  const premadeRoot = resolve("examples/premade-plugins");
  const allGenerated = readdirSync(premadeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(premadeRoot, entry.name, "plugin.js"), "utf8"))
    .join("\n");

  assert.match(user, /avatar\.walkToItem/);
  assert.match(items, /furni\.findItems/);
  assert.match(items, /furni\.pickupItem/);
  assert.match(wallMover, /furni\.wallMoveLocation/);
  assert.match(wallMover, /furni\.moveWallItem/);
  assert.match(wallMover, /furni\.pickupWallItem/);
  assert.match(social, /social\.addUser/);
  assert.match(combined, /ui\.onAction/);
  assert.match(readFileSync(resolve("examples/premade-plugins/items/shockless.plugin.json"), "utf8"), /"action": "items\.move"/);
  assert.match(allGenerated, /storage\.remember/);
  assert.match(allGenerated, /room\.summarizeItem|packets\.summary/);
  assert.doesNotMatch(combined, /habbpy\.|actions\.user|actions\.gardening|actions\.wallMover/);
  assert.doesNotMatch(allGenerated, /function (?:tileOf|objectId|itemKey|itemSummary|countRoomItems|packetSummary|parsePair|wallMoveAction|wallItemActionShape|visitorKey)\b/);
});

test("plugin manager ignores underscored source-pack folders", () => {
  withTempAppData("habbpy-v4-plugin-source-pack-", (appData) => {
    const manager = new PluginManager(appData);
    mkdirSync(join(manager.userPluginRoot(), "_premade-modules", "room"), { recursive: true });
    writeFileSync(join(manager.userPluginRoot(), "_premade-modules", "room", "README.md"), "source reference only\n", "utf8");

    const state = manager.state();
    assert.equal(state.loadErrors.some((error) => error.sourcePath.includes("_premade-modules")), false);
  });
});
