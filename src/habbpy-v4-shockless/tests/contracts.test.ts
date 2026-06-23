import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/core/commandRegistry";
import { createInitialPluginEnabledState, createInitialPluginUiSurfaceState, shellReducer } from "../src/core/shellStore";
import { plugins } from "../src/plugins/registry";
import { initialAppState } from "../src/core/sampleState";
import { appPreferencesState, GPU_LAUNCH_SWITCHES, readAppPreferences, writeAppPreferences } from "../src/main/appPreferences";
import {
  ShocklessEmbedController,
  buildShocklessEmbedUrl,
  embeddedResizablePresentation,
  normalizeOriginsExternalVariables,
  readShocklessSettings,
  writeShocklessSettings,
} from "../src/main/shocklessEmbed";
import { ClientLibraryStore, findProfileRootsInSource } from "../src/main/clientLibrary";
import { normalizeOriginsUserLookup } from "../src/main/originsUserLookup";
import { packetNameFor } from "../src/shared/packetNames";

test("app launch preferences keep hardware acceleration default-on with restart-aware state", () => {
  const appData = mkdtempSync(join(tmpdir(), "habbpy-v4-app-prefs-"));
  try {
    const defaults = readAppPreferences(appData);
    assert.equal(defaults.hardwareAcceleration, true);
    assert.equal(defaults.packetOutputWrap, true);
    assert.equal(defaults.packetOutputAutoScroll, true);
    assert.equal(defaults.defaultAccountFile, "multiclient-accounts.txt");
    assert.equal(defaults.defaultAccountCount, 3);
    assert.equal(defaults.defaultAccountConcurrency, 2);
    assert.equal(defaults.defaultAccountKeyEnv, "HABBPY_V4_ACCOUNT_STORE_KEY");
    assert.equal(defaults.defaultSummonTarget, "headless");
    assert.equal(defaults.defaultLoadMode, "headless");
    assert.equal(defaults.autoSubmitVisibleLogin, true);

    const disabled = writeAppPreferences(appData, {
      hardwareAcceleration: false,
      packetOutputWrap: false,
      packetOutputAutoScroll: false,
      defaultAccountFile: " accounts.txt ",
      defaultAccountCount: 500,
      defaultAccountConcurrency: 0,
      defaultAccountKeyEnv: " HABBPY_TEST_KEY ",
      defaultSummonTarget: " visible ",
      defaultLoadMode: "visible",
      autoSubmitVisibleLogin: false,
    });
    assert.equal(disabled.hardwareAcceleration, false);
    assert.equal(disabled.packetOutputWrap, false);
    assert.equal(disabled.packetOutputAutoScroll, false);
    assert.equal(disabled.defaultAccountFile, "accounts.txt");
    assert.equal(disabled.defaultAccountCount, 50);
    assert.equal(disabled.defaultAccountConcurrency, 1);
    assert.equal(disabled.defaultAccountKeyEnv, "HABBPY_TEST_KEY");
    assert.equal(disabled.defaultSummonTarget, "visible");
    assert.equal(disabled.defaultLoadMode, "visible");
    assert.equal(disabled.autoSubmitVisibleLogin, false);

    const stillActive = appPreferencesState(appData, true);
    assert.equal(stillActive.hardwareAcceleration, false);
    assert.equal(stillActive.hardwareAccelerationActive, true);
    assert.equal(stillActive.hardwareAccelerationRestartRequired, true);
    assert.deepEqual(stillActive.gpuLaunchSwitches, GPU_LAUNCH_SWITCHES);

    const restartedDisabled = appPreferencesState(appData, false);
    assert.equal(restartedDisabled.hardwareAccelerationRestartRequired, false);
    assert.deepEqual(restartedDisabled.gpuLaunchSwitches, []);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test("engine status exposes staged launch settings before a profile is attached", () => {
  const appData = mkdtempSync(join(tmpdir(), "habbpy-v4-launch-settings-"));
  try {
    writeShocklessSettings(appData, {
      customHotelView: true,
      resizablePresentation: false,
      versionCheckBuild: 9999,
    });

    const controller = new ShocklessEmbedController({
      appDataPath: appData,
      library: { selectedProfile: () => null } as ClientLibraryStore,
    });
    const status = controller.status();

    assert.equal(status.status, "not-configured");
    assert.equal(status.settings?.customHotelView, true);
    assert.equal(status.settings?.resizablePresentation, false);
    assert.equal(status.settings?.versionCheckBuild, null);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test("plugin registry keeps required Habbpy v3 surfaces", () => {
  const expected = [
    "connection",
    "multi-account",
    "info",
    "room",
    "user",
    "items",
    "inventory",
    "automation",
    "fishing",
    "gardening",
    "wall-mover",
    "social",
    "visitors",
    "chat",
    "injection",
    "packet-log",
    "dev-tools",
    "about",
  ];
  const ids = plugins.map((plugin) => plugin.id);
  for (const id of expected) {
    assert.ok(ids.includes(id), `missing plugin ${id}`);
  }
});

test("built-in plugin definitions live in per-plugin source folders", () => {
  for (const plugin of plugins.filter((entry) => entry.origin === "built-in")) {
    const pluginPath = join(process.cwd(), "src", "plugins", plugin.id, "plugin.ts");
    assert.ok(existsSync(pluginPath), `${plugin.id} definition must live at ${pluginPath}`);
    const source = readFileSync(pluginPath, "utf8");
    assert.match(source, new RegExp(`id:\\s*"${plugin.id}"`), `${plugin.id} definition file must declare the matching id`);
  }
  const registrySource = readFileSync(join(process.cwd(), "src", "plugins", "registry.ts"), "utf8");
  assert.equal(registrySource.includes("const pluginDefinitions"), false, "registry.ts must not contain the built-in definition blob");
  assert.equal(registrySource.includes("builtInPluginDefinitions"), true, "registry.ts must import the modular built-in index");
});

test("every plugin declares source mapping and capabilities", () => {
  for (const plugin of plugins) {
    assert.ok(plugin.capabilities.length > 0, `${plugin.id} has no capabilities`);
    assert.ok(plugin.uiSurfaces.length > 0, `${plugin.id} has no UI surfaces`);
    assert.ok(plugin.sourceMapping.habbpyV3.length > 0, `${plugin.id} has no v3 mapping`);
    assert.ok(plugin.sourceMapping.shockless.length > 0, `${plugin.id} has no Shockless mapping`);
  }
});

test("plugin UI surfaces are modular and toggleable", () => {
  const enabledById = createInitialPluginEnabledState();
  const surfacesByPlugin = createInitialPluginUiSurfaceState();
  for (const plugin of plugins) {
    assert.equal(enabledById[plugin.id], plugin.enabledByDefault);
    const surfaceState = surfacesByPlugin[plugin.id];
    assert.ok(surfaceState, `${plugin.id} has no runtime surface state`);
    for (const surface of plugin.uiSurfaces) {
      assert.equal(
        surfaceState[surface.id],
        surface.enabledByDefault,
        `${plugin.id}.${surface.id} default mismatch`,
      );
    }
  }
});

test("default enabled plugins stay focused on recovery, connection, info, diagnostics, and about", () => {
  const enabledById = createInitialPluginEnabledState();
  const enabledIds = Object.entries(enabledById)
    .filter(([, enabled]) => enabled)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(enabledIds, ["about", "connection", "dev-tools", "info", "plugin-manager", "settings"].sort());
});

test("shell reducer toggles plugins, surfaces, and dock without mutating source state", () => {
  const enabled = shellReducer(initialAppState, {
    type: "setPluginEnabled",
    pluginId: "room",
    enabled: true,
  });
  assert.equal(enabled.plugins.enabledById.room, true);
  assert.equal(initialAppState.plugins.enabledById.room, false);

  const overlayOff = shellReducer(enabled, {
    type: "setPluginUiSurfaceEnabled",
    pluginId: "room",
    surfaceId: "overlay",
    enabled: false,
  });
  assert.equal(overlayOff.plugins.uiSurfaceEnabledByPluginId.room.overlay, false);
  assert.equal(initialAppState.plugins.uiSurfaceEnabledByPluginId.room.overlay, true);

  const collapsed = shellReducer(overlayOff, { type: "toggleDockCollapsed" });
  assert.equal(collapsed.ui.dockCollapsed, true);

  const accountMerged = shellReducer(collapsed, {
    type: "mergeAccountSummary",
    account: {
      name: "dek",
      badge: "ADM",
    },
  });
  assert.equal(accountMerged.account.name, "dek");
  assert.equal(accountMerged.account.badge, "ADM");
  assert.equal(initialAppState.account.name, "-");
});

test("commands are owned by registered plugins and declare explicit routes", () => {
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  for (const command of commands) {
    assert.ok(pluginIds.has(command.pluginId), `${command.id} references missing plugin`);
    assert.ok(command.route.sourcePaths.length > 0, `${command.id} has no route source path`);
    if (command.status === "blocked") {
      assert.equal(command.route.kind, "blocked", `${command.id} blocked status must use blocked route`);
      assert.match(command.route.notes ?? "", /blocked|until|requires/i);
    }
  }
});

test("room public entry is a source-routed ready command", () => {
  const command = commands.find((entry) => entry.id === "room.enterPublic");
  assert.ok(command);
  assert.equal(command.pluginId, "room");
  assert.equal(command.status, "ready");
  assert.equal(command.route.kind, "shockless-dev-api");
  assert.ok(command.route.sourcePaths.some((sourcePath) => sourcePath.includes("enterPublicRoom")));
  assert.doesNotMatch(command.route.notes ?? "", /raw packet/i);
});

test("room stage click is exposed as a source-routed room command", () => {
  const command = commands.find((entry) => entry.id === "room.stageClick");
  assert.ok(command);
  assert.equal(command.status, "ready");
  assert.equal(command.risk, "source-routed-action");
  assert.equal(command.route.kind, "shockless-dev-api");
  assert.ok(command.route.sourcePaths.some((sourcePath) => sourcePath.includes("stageClick")));
  assert.match(command.route.notes ?? "", /Director pointer events/i);
  assert.doesNotMatch(command.route.notes ?? "", /raw packet/i);
});

test("user plugin separates local tools, runtime user actions, and raw packet boundaries", () => {
  const userPlugin = plugins.find((plugin) => plugin.id === "user");
  assert.ok(userPlugin);
  assert.ok(userPlugin.capabilities.some((capability) => capability.includes("Local copy/profile")));

  const localTools = commands.find((command) => command.id === "user.copyProfileData");
  assert.ok(localTools);
  assert.equal(localTools.status, "ready");
  assert.equal(localTools.risk, "read-only");
  assert.equal(localTools.route.kind, "local-shell");

  const sourceActions = commands.find((command) => command.id === "user.sourceWindowActions");
  assert.ok(sourceActions);
  assert.equal(sourceActions.status, "ready");
  assert.equal(sourceActions.risk, "source-routed-action");
  assert.equal(sourceActions.route.kind, "habbpy-v3-port");
  assert.ok(sourceActions.route.sourcePaths.some((sourcePath) => sourcePath.includes("userRelayPackets")));
  assert.match(sourceActions.route.notes ?? "", /80 Carry Drink/i);
  assert.match(sourceActions.route.notes ?? "", /44 Apply Look/i);

  const mimicActions = commands.find((command) => command.id === "user.mimicForwarding");
  assert.ok(mimicActions);
  assert.equal(mimicActions.status, "ready");
  assert.equal(mimicActions.risk, "source-routed-action");
  assert.equal(mimicActions.route.kind, "habbpy-v3-port");
  assert.ok(mimicActions.route.sourcePaths.some((sourcePath) => sourcePath.includes("mimicRelayPackets")));
  assert.match(mimicActions.route.notes ?? "", /sensitive login/i);
});

test("injection mapped editor includes user actions while raw packet text stays reserved", () => {
  const command = commands.find((entry) => entry.id === "injection.mappedEditor");
  assert.ok(command);
  assert.equal(command.status, "ready");
  assert.equal(command.risk, "source-routed-action");
  assert.equal(command.route.kind, "shockless-dev-api");
  assert.ok(command.route.sourcePaths.some((sourcePath) => sourcePath.includes("userRelayPackets")));
  assert.match(command.route.notes ?? "", /scoped User relay actions/i);
  assert.match(command.route.notes ?? "", /Raw packet text is reserved/i);
});

test("blocked plugins must explain the missing boundary", () => {
  for (const plugin of plugins.filter((entry) => entry.status === "blocked")) {
    const text = [...plugin.sourceMapping.shockless, plugin.sourceMapping.notes ?? ""].join(" ");
    assert.match(text, /not yet|requires|blocked|prefer/i);
  }
});

test("embedded Shockless launch URL is built from selected profile metadata", () => {
  const url = new URL(
    buildShocklessEmbedUrl("http://127.0.0.1:49152/", {
      profile: {
        id: "dynamic-profile",
        label: "Dynamic Profile",
        versionId: "release-current",
        buildNumber: null,
        versionCheckBuild: null,
        importedAt: "2026-06-20T00:00:00.000Z",
        sourceFolderName: "current",
        profileRoot: "X:/profiles/current",
        ready: true,
        reason: null,
        storageMode: "referenced",
        fixedStage: true,
        resizablePresentation: true,
        paths: {
          client: "client",
          runtimeData: "runtime-data",
          assets: "assets",
          scripts: "scripts",
        },
      },
      engineRoot: "X:/engine",
      relay: {
        script: "X:/relay/origins-relay.mjs",
        resourceDir: "X:/relay",
        safeBodyLogging: false,
      },
      relayWsPort: 12340,
      relayControlPort: 12341,
      settings: {
        resizablePresentation: true,
        customHotelView: false,
        versionCheckBuild: null,
      },
    }),
  );

  assert.equal(url.searchParams.get("profile"), "dynamic-profile");
  assert.equal(url.searchParams.get("profileVersion"), "release-current");
  assert.equal(url.searchParams.get("resizablePresentation"), "1");
  assert.equal(url.searchParams.get("bridgeHost"), "127.0.0.1");
  assert.equal(url.searchParams.get("bridgePort"), "12340");
  assert.equal(url.searchParams.has("versionCheckBuild"), false);
});

test("embedded Shockless presentation defaults to responsive with explicit fixed-stage opt-out", () => {
  const previousResizable = process.env.HABBPY_V4_RESIZABLE_PRESENTATION;
  const previousFixed = process.env.HABBPY_V4_FIXED_STAGE;
  try {
    delete process.env.HABBPY_V4_RESIZABLE_PRESENTATION;
    delete process.env.HABBPY_V4_FIXED_STAGE;
    assert.equal(embeddedResizablePresentation(null, false), true);
    assert.equal(embeddedResizablePresentation(false, false), false);
    assert.equal(embeddedResizablePresentation(true, false), true);

    process.env.HABBPY_V4_FIXED_STAGE = "1";
    assert.equal(embeddedResizablePresentation(true, true), false);

    delete process.env.HABBPY_V4_FIXED_STAGE;
    process.env.HABBPY_V4_RESIZABLE_PRESENTATION = "0";
    assert.equal(embeddedResizablePresentation(true, true), false);

    process.env.HABBPY_V4_RESIZABLE_PRESENTATION = "1";
    assert.equal(embeddedResizablePresentation(false, false), true);
  } finally {
    if (previousResizable === undefined) delete process.env.HABBPY_V4_RESIZABLE_PRESENTATION;
    else process.env.HABBPY_V4_RESIZABLE_PRESENTATION = previousResizable;
    if (previousFixed === undefined) delete process.env.HABBPY_V4_FIXED_STAGE;
    else process.env.HABBPY_V4_FIXED_STAGE = previousFixed;
  }
});

test("external variables normalization keeps live gamedata dynamic", () => {
  const normalized = normalizeOriginsExternalVariables("flash.dynamic.download.url=https://example.test/dyn/\rclient.version.id=401");
  assert.match(normalized, /dynamic\.download\.url=https:\/\/example\.test\/dyn\//);
  assert.match(normalized, /furnidata\.load\.url=furnidata\.txt/);
  assert.match(normalized, /productdata\.load\.url=productdata\.txt/);
});

test("external variables normalization applies accepted VERSIONCHECK build", () => {
  const normalized = normalizeOriginsExternalVariables("client.version.id=401\rflash.dynamic.download.url=https://example.test/dyn/", 1129);
  assert.match(normalized, /client\.version\.id=1129/);
  assert.doesNotMatch(normalized, /client\.version\.id=401/);
});

test("Shockless launch settings drop stale VERSIONCHECK overrides", () => {
  const appData = mkdtempSync(join(tmpdir(), "habbpy-v4-stale-versioncheck-"));
  try {
    const saved = writeShocklessSettings(appData, {
      activeProfileId: "release324",
      versionCheckBuild: 1128,
    });
    assert.equal(saved.versionCheckBuild, null);
    assert.equal(readShocklessSettings(appData).versionCheckBuild, null);

    const fresh = writeShocklessSettings(appData, {
      activeProfileId: "release324",
      versionCheckBuild: 1129,
    });
    assert.equal(fresh.versionCheckBuild, 1129);
    assert.equal(readShocklessSettings(appData).versionCheckBuild, 1129);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test("client import classifier distinguishes compiled clients from imported profiles", () => {
  const profileScan = findProfileRootsInSource("missing-profile-root-for-test");
  assert.equal(profileScan.kind, "unknown");
  assert.deepEqual(profileScan.profileRoots, []);
});

test("Origins public user lookup normalizes profile facts without credential fields", () => {
  const normalized = normalizeOriginsUserLookup(
    {
      uniqueId: "hhus-123",
      name: "dek",
      figureString: "hd-180-1.ch-210-66",
      motto: "hello",
      memberSince: "2024-06-18T12:00:00.000Z",
      profileVisible: true,
      selectedBadges: [{ code: "ACH_Test1" }, "ADM"],
    },
    "dek",
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.source, "official-origins-public-api");
  assert.equal(normalized.id, "hhus-123");
  assert.equal(normalized.name, "dek");
  assert.equal(normalized.figureString, "hd-180-1.ch-210-66");
  assert.deepEqual(normalized.selectedBadges, ["ACH_Test1", "ADM"]);
  assert.doesNotMatch(JSON.stringify(normalized), /password|webhook|token/i);
});

test("client import classifier recognizes compiled clients without hardcoded versions", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-client-"));
  try {
    const clientRoot = join(root, "compiled 324");
    writeCompiledClientFixture(clientRoot, 324);

    const scan = findProfileRootsInSource(root);
    assert.equal(scan.kind, "compiled-client");
    assert.equal(scan.compiledClient?.selectedFromParent, true);
    assert.equal(scan.compiledClient?.versionId, "release324");
    assert.equal(scan.compiledClient?.sourceFolderName, "compiled 324");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library compiled-client import reuses a matching profile cache by reference", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-library-"));
  try {
    const appData = join(root, "appdata");
    const clientRoot = join(root, "compiled 324");
    const profileRoot = join(root, "profiles", "release324-fixture");
    writeCompiledClientFixture(clientRoot, 324);
    writeReadyProfileFixture(profileRoot, "release324", 324, "compiled 324");

    const library = new ClientLibraryStore(appData);
    const initial = library.registerSource(profileRoot);
    assert.ok(initial.profiles.some((profile) => profile.profileRoot === profileRoot));

    const state = library.registerSource(clientRoot);
    assert.ok(state.profiles.some((profile) => profile.profileRoot === profileRoot));
    assert.match(state.message, /Registered existing release324 profile cache by reference/);
    assert.match(state.message, /no files copied or decompiled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library compiled-client registration activates the matching cached profile", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-library-select-"));
  try {
    const appData = join(root, "appdata");
    const oldProfileRoot = join(root, "profiles", "release9875-fixture");
    const clientRoot = join(root, "compiled 9876");
    const profileRoot = join(root, "profiles", "release9876-fixture");
    writeReadyProfileFixture(oldProfileRoot, "release9875", 9875, "compiled 9875");
    writeCompiledClientFixture(clientRoot, 9876);
    writeReadyProfileFixture(profileRoot, "release9876", 9876, "compiled 9876");

    const library = new ClientLibraryStore(appData);
    assert.equal(library.registerSource(profileRoot).selectedProfileRoot, profileRoot);
    assert.equal(library.registerSource(oldProfileRoot).selectedProfileRoot, oldProfileRoot);

    const state = library.registerSource(clientRoot);
    assert.equal(state.selectedProfileRoot, profileRoot);
    assert.match(state.message, /Registered existing release9876 profile cache by reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library direct profile registration activates the selected profile folder", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-profile-select-"));
  try {
    const appData = join(root, "appdata");
    const oldProfileRoot = join(root, "profiles", "release323-fixture");
    const profileRoot = join(root, "profiles", "release324-fixture");
    writeReadyProfileFixture(oldProfileRoot, "release323", 323, "compiled 323");
    writeReadyProfileFixture(profileRoot, "release324", 324, "compiled 324");

    const library = new ClientLibraryStore(appData);
    assert.equal(library.registerSource(oldProfileRoot).selectedProfileRoot, oldProfileRoot);

    const state = library.registerSource(profileRoot);
    assert.equal(state.selectedProfileRoot, profileRoot);
    assert.match(state.message, /Registered 1 profile folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library compiled-client import discovers existing appdata profile cache", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-appdata-library-"));
  try {
    const appData = join(root, "appdata");
    const clientRoot = join(root, "compiled 324");
    const profileRoot = join(appData, "ShocklessEngine", "clients", "release324-fixture");
    writeCompiledClientFixture(clientRoot, 324);
    writeReadyProfileFixture(profileRoot, "release324", 324, "compiled 324");

    const library = new ClientLibraryStore(appData);
    const state = library.registerSource(clientRoot);

    assert.ok(state.profiles.some((profile) => profile.profileRoot === profileRoot));
    assert.equal(state.selectedProfileRoot, profileRoot);
    assert.match(state.message, /Registered existing release324 profile cache by reference/);
    assert.match(state.message, /no files copied or decompiled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library compiled-client import builds a playable profile when cache is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-import-runner-"));
  const previousCli = process.env.HABBPY_V4_PROFILE_IMPORT_CLI;
  const previousClientsRoot = process.env.HABBPY_V4_IMPORT_CLIENTS_ROOT;
  const previousCacheRoot = process.env.HABBPY_V4_IMPORT_CACHE_ROOT;
  try {
    const appData = join(root, "appdata");
    const clientRoot = join(root, "compiled 325");
    const clientsRoot = join(root, "habbpy-clients");
    const fakeCli = join(root, "fake-profile-import.js");
    writeCompiledClientFixture(clientRoot, 325);
    writeFakeProfileImportCli(fakeCli);
    process.env.HABBPY_V4_PROFILE_IMPORT_CLI = fakeCli;
    process.env.HABBPY_V4_IMPORT_CLIENTS_ROOT = clientsRoot;
    process.env.HABBPY_V4_IMPORT_CACHE_ROOT = join(root, "import-cache");

    const library = new ClientLibraryStore(appData);
    const state = await library.importOrRegisterSource(clientRoot);
    const importedRoot = join(clientsRoot, "release325-imported");

    assert.equal(state.selectedProfileRoot, importedRoot);
    assert.ok(existsSync(join(importedRoot, "profile.json")));
    assert.ok(state.profiles.some((profile) => profile.profileRoot === importedRoot && profile.ready));
    assert.match(state.message, /Compiled client release325 was imported into a playable Shockless profile/);
  } finally {
    if (previousCli === undefined) delete process.env.HABBPY_V4_PROFILE_IMPORT_CLI;
    else process.env.HABBPY_V4_PROFILE_IMPORT_CLI = previousCli;
    if (previousClientsRoot === undefined) delete process.env.HABBPY_V4_IMPORT_CLIENTS_ROOT;
    else process.env.HABBPY_V4_IMPORT_CLIENTS_ROOT = previousClientsRoot;
    if (previousCacheRoot === undefined) delete process.env.HABBPY_V4_IMPORT_CACHE_ROOT;
    else process.env.HABBPY_V4_IMPORT_CACHE_ROOT = previousCacheRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("packet names are sourced from the v3 packet name table", () => {
  assert.equal(packetNameFor("CLIENT", 94), "WAVE");
  assert.equal(packetNameFor("CLIENT", 75), "MOVE");
  assert.equal(packetNameFor("CLIENT", 1269), "ORIGINS_MOVE");
  assert.equal(packetNameFor("SERVER", 24), "CHAT");
  assert.equal(packetNameFor("SERVER", 3439), "UNKNOWN_HEADER");
  assert.equal(packetNameFor("CLIENT", 99999), "UNKNOWN_HEADER");
  assert.equal(packetNameFor("RELAY", 24), null);
});

function writeCompiledClientFixture(clientRoot: string, buildNumber: number): void {
  mkdirSync(clientRoot, { recursive: true });
  writeFileSync(join(clientRoot, "habbo.dcr"), "movie", "utf8");
  writeFileSync(join(clientRoot, "fuse_client.cct"), "cast", "utf8");
  writeFileSync(join(clientRoot, "Habbo.INI"), `release=${buildNumber}\n`, "utf8");
  writeFileSync(join(clientRoot, "external_variables.txt"), `client.version.id=${buildNumber}\n`, "utf8");
  writeFileSync(join(clientRoot, "external_texts.txt"), "ok=OK\n", "utf8");
  for (let index = 0; index < 23; index += 1) {
    writeFileSync(join(clientRoot, `cast_${index}.cct`), "cast", "utf8");
  }
}

function writeFakeProfileImportCli(cliPath: string): void {
  writeFileSync(
    cliPath,
    `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
const clientsRoot = arg("--clients-root");
const profileRoot = join(clientsRoot, "release325-imported");
mkdirSync(join(profileRoot, "client"), { recursive: true });
mkdirSync(join(profileRoot, "runtime-data"), { recursive: true });
mkdirSync(join(profileRoot, "assets"), { recursive: true });
mkdirSync(join(profileRoot, "scripts"), { recursive: true });
writeFileSync(join(profileRoot, "profile.json"), JSON.stringify({
  id: "release325-imported",
  displayName: "Origins build 325 (compiled 325)",
  versionId: "release325",
  buildNumber: 325,
  versionCheckBuild: 1125,
  importedAt: "2026-06-22T00:00:00.000Z",
  sourceFolderName: "compiled 325",
  runtime: { ready: true },
  paths: {
    client: "client",
    runtimeData: "runtime-data",
    assets: "assets",
    scripts: "scripts"
  }
}, null, 2) + "\\n", "utf8");
console.log("[done] fake import complete");
console.log(JSON.stringify({ id: "release325-imported", profileRoot, runtime: { ready: true } }, null, 2));
`,
    "utf8",
  );
}

function writeReadyProfileFixture(profileRoot: string, versionId: string, buildNumber: number, sourceFolderName: string): void {
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(join(profileRoot, "client"), { recursive: true });
  writeFileSync(
    join(profileRoot, "profile.json"),
    `${JSON.stringify(
      {
        id: `${versionId}-fixture`,
        displayName: `Origins build ${buildNumber} (${sourceFolderName})`,
        versionId,
        buildNumber,
        versionCheckBuild: buildNumber + 800,
        importedAt: "2026-06-20T00:00:00.000Z",
        sourceFolderName,
        runtime: { ready: true },
        paths: {
          client: "client",
          runtimeData: "runtime-data",
          assets: "assets",
          scripts: "scripts",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
