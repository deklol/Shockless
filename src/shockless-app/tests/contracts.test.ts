import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/core/commandRegistry";
import { createInitialPluginEnabledState, createInitialPluginUiSurfaceState, shellReducer } from "../src/core/shellStore";
import { plugins } from "../src/plugins/registry";
import { initialAppState } from "../src/core/sampleState";
import { appPreferencesPath, appPreferencesState, GPU_LAUNCH_SWITCHES, readAppPreferences, writeAppPreferences } from "../src/main/appPreferences";
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
import {
  decodeOriginsExternalTexts,
  isCompatibleOriginsExternalTexts,
  lastExternalVariableValue,
} from "../src/main/originsRealmGamedata";
import { packetNameFor } from "../src/shared/packetNames";
import {
  normalizeOriginsRealmId,
  originsRealmDefinition,
  originsRealmGamedataUrl,
} from "../src/shared/originsRealm";
import { installLegacyEnvironment } from "../src/shared/legacyCompatibility";
import {
  isFishingAreaObject,
  packetActiveObjectRow,
  packetActiveObjectStateFromEntries,
  clientPluginSnapshotForClient,
  mergeRelayLogSnapshot,
  packetFishingStateFromEntries,
  pluginFishingAreaRows,
  pluginFishingAreaWalkCandidates,
  pluginFishingAreaWalkTarget,
  pluginPlantCyclePlan,
  pluginRoomOccupantsPayload,
  pluginWalkTargetFromUser,
} from "../src/renderer/ui/helpers";
import type { ProfileImportProgress, RelayLogDeltaSnapshot, RelayLogEntry, RelayLogSnapshot } from "../src/shared/window-api";
import {
  normalizeInjectionHistory,
  normalizeInjectionSnippets,
} from "../src/renderer/features/injection/model";
import { parsePacketInjectionCommand } from "../src/renderer/features/packet-console/packetInjectionCommand";
import { profileImportMetricText } from "../src/renderer/features/client-import/model";

function relayEntry(header: number, lineNumber: number, fields: readonly (readonly [string, string])[], direction: RelayLogEntry["direction"] = "SERVER"): RelayLogEntry {
  return {
    id: `test-${lineNumber}`,
    sourceLineNumber: lineNumber,
    lineNumber,
    clientId: 1,
    clientLabel: "client1",
    sessionId: "1",
    direction,
    route: "official->browser",
    mode: "plain",
    header,
    packetName: null,
    size: 0,
    payloadBytes: 0,
    bodyStatus: "sampled",
    bodyText: null,
    bodyHex: null,
    bodyAscii: null,
    bodyTruncated: false,
    decodedFields: fields.map(([label, value]) => ({ label, value })),
    bodyNote: "",
    message: "",
  };
}

function relaySnapshot(entries: readonly RelayLogEntry[], totalLines: number, logPath = "test://relay"): RelayLogSnapshot {
  const first = entries[0]?.lineNumber ?? totalLines + 1;
  const last = entries.at(-1)?.lineNumber ?? totalLines;
  return {
    logPath,
    exists: true,
    fileSize: totalLines * 80,
    updatedAt: "2026-07-10T00:00:00.000Z",
    totalLines,
    packetCount: totalLines,
    clientCount: 0,
    serverCount: totalLines,
    retainedFromLine: first,
    retainedToLine: last,
    historyComplete: first === 1 && last === totalLines,
    clients: [{
      clientId: entries[0]?.clientId ?? 1,
      clientLabel: entries[0]?.clientLabel ?? "client1",
      logPath,
      exists: true,
      fileSize: totalLines * 80,
      updatedAt: "2026-07-10T00:00:00.000Z",
      totalLines,
      packetCount: totalLines,
      clientCount: 0,
      serverCount: totalLines,
    }],
    entries,
    message: "test",
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

test("renderer relay merge keeps only the live tail while preserving exact totals", () => {
  const currentEntries = Array.from({ length: 1_000 }, (_, index) => relayEntry(50, index + 1, []));
  const current = relaySnapshot(currentEntries, 1_000);
  const appendedEntries = Array.from({ length: 10 }, (_, index) => relayEntry(50, index + 1_001, []));
  const incoming: RelayLogDeltaSnapshot = {
    ...relaySnapshot(appendedEntries, 1_010),
    afterLineNumber: 1_000,
    reset: false,
    nextLineNumber: 1_010,
    hasMore: false,
  };

  const merged = mergeRelayLogSnapshot(current, incoming);
  assert.equal(merged.totalLines, 1_010);
  assert.equal(merged.entries.length, 1_000);
  assert.equal(merged.entries[0]?.lineNumber, 11);
  assert.equal(merged.entries.at(-1)?.lineNumber, 1_010);
  assert.equal(merged.historyComplete, false);
});

test("plugin packet state advances incrementally after old relay rows leave the live window", () => {
  const clientId = 901;
  const catchEntry = (lineNumber: number, fishName: string): RelayLogEntry => ({
    ...relayEntry(1101, lineNumber, [
      ["fishingCatchName", fishName],
      ["fishingCatchXp", "5"],
      ["fishingCatchGolden", "false"],
      ["fishingCatchMessage", `${fishName} caught`],
    ]),
    clientId,
    clientLabel: "incremental-test",
  });
  const runtimeOptions = { runtime: null, runtimeSummary: null } as const;

  const first = clientPluginSnapshotForClient({
    clientId,
    label: "incremental-test",
    relay: relaySnapshot([catchEntry(1, "carp")], 1, "test://incremental#client-901"),
    ...runtimeOptions,
  });
  assert.equal(first.packetFishing.catches, 1);

  const second = clientPluginSnapshotForClient({
    clientId,
    label: "incremental-test",
    relay: relaySnapshot([catchEntry(1, "carp"), catchEntry(2, "tuna")], 2, "test://incremental#client-901"),
    ...runtimeOptions,
  });
  assert.equal(second.packetFishing.catches, 2);

  const afterTrim = clientPluginSnapshotForClient({
    clientId,
    label: "incremental-test",
    relay: relaySnapshot([catchEntry(3, "salmon")], 3, "test://incremental#client-901"),
    ...runtimeOptions,
  });
  assert.equal(afterTrim.packetFishing.catches, 3);
  assert.equal(afterTrim.packetFishing.xp, 15);
  assert.deepEqual(afterTrim.packetFishing.catchLog.map((entry) => entry.fishName), ["carp", "tuna", "salmon"]);
});

function missingFrom(expected: readonly string[], actual: readonly string[]): readonly string[] {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value)).sort();
}

test("app launch preferences keep hardware acceleration default-on with restart-aware state", () => {
  const appData = mkdtempSync(join(tmpdir(), "habbpy-v4-app-prefs-"));
  try {
    assert.equal(appPreferencesPath(appData), join(appData, "Shockless", "app-preferences.json"));
    const defaults = readAppPreferences(appData);
    assert.equal(defaults.shellUiHidden, false);
    assert.equal(defaults.hardwareAcceleration, true);
    assert.equal(defaults.packetOutputWrap, true);
    assert.equal(defaults.packetOutputAutoScroll, true);
    assert.equal(defaults.engineUserNameLabels, false);
    assert.equal(defaults.userNameLabelOffset, 40);
    assert.equal(defaults.userNameLabelSelfColor, "#ffffff");
    assert.equal(defaults.userNameLabelOtherColor, "#ffffff");
    assert.equal(defaults.nativeBindShift, "Shift");
    assert.equal(defaults.nativeBindControl, "Control");
    assert.equal(defaults.nativeBindOption, "Alt");
    assert.equal(defaults.nativeBindCommand, "Control");
    assert.equal(defaults.defaultAccountFile, "multiclient-accounts.txt");
    assert.equal(defaults.defaultAccountCount, 3);
    assert.equal(defaults.defaultAccountConcurrency, 2);
    assert.equal(defaults.defaultAccountKeyEnv, "SHOCKLESS_ACCOUNT_STORE_KEY");
    assert.equal(defaults.defaultSummonTarget, "headless");
    assert.equal(defaults.defaultLoadMode, "headless");
    assert.equal(defaults.autoSubmitVisibleLogin, true);

    const disabled = writeAppPreferences(appData, {
      shellUiHidden: true,
      hardwareAcceleration: false,
      packetOutputWrap: false,
      packetOutputAutoScroll: false,
      engineUserNameLabels: true,
      userNameLabelOffset: 500,
      userNameLabelSelfColor: "#ABCDEF",
      userNameLabelOtherColor: "bad-color",
      nativeBindShift: " Shift+R ",
      nativeBindControl: " Control+P ",
      nativeBindOption: " M ",
      nativeBindCommand: " Control+Enter ",
      defaultAccountFile: " accounts.txt ",
      defaultAccountCount: 500,
      defaultAccountConcurrency: 0,
      defaultAccountKeyEnv: " HABBPY_TEST_KEY ",
      defaultSummonTarget: " visible ",
      defaultLoadMode: "visible",
      autoSubmitVisibleLogin: false,
    });
    assert.equal(disabled.hardwareAcceleration, false);
    assert.equal(disabled.shellUiHidden, true);
    assert.equal(disabled.packetOutputWrap, false);
    assert.equal(disabled.packetOutputAutoScroll, false);
    assert.equal(disabled.engineUserNameLabels, true);
    assert.equal(disabled.userNameLabelOffset, 96);
    assert.equal(disabled.userNameLabelSelfColor, "#abcdef");
    assert.equal(disabled.userNameLabelOtherColor, "#ffffff");
    assert.equal(disabled.nativeBindShift, "Shift+R");
    assert.equal(disabled.nativeBindControl, "Control+P");
    assert.equal(disabled.nativeBindOption, "M");
    assert.equal(disabled.nativeBindCommand, "Control+Enter");
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

test("View menu toggles the persistent chrome-free game layout", () => {
  const menuSource = readFileSync(join(process.cwd(), "src", "main", "appMenu.ts"), "utf8");
  const preloadSource = readFileSync(join(process.cwd(), "src", "preload", "preload.cts"), "utf8");
  const rendererSource = readFileSync(join(process.cwd(), "src", "renderer", "ui", "App.tsx"), "utf8");
  const stylesSource = readFileSync(join(process.cwd(), "src", "renderer", "styles.css"), "utf8");

  assert.match(menuSource, /label: "Hide UI"/);
  assert.match(menuSource, /type: "checkbox"/);
  assert.match(preloadSource, /onShellUiHiddenChanged/);
  assert.match(rendererSource, /shell-ui-hidden/);
  assert.match(rendererSource, /shellUiMenuEventSeenRef/);
  assert.match(rendererSource, /if \(!shellUiMenuEventSeenRef\.current\) setShellUiHidden\(appPreferences\.shellUiHidden\)/);
  assert.match(stylesSource, /\.app-shell\.shell-ui-hidden/);
  assert.match(stylesSource, /\.shell-ui-hidden > \.plugin-dock/);
});

test("legacy Habbpy v4 environment names migrate without overriding canonical Shockless values", () => {
  const environment: Record<string, string | undefined> = {
    HABBPY_V4_PROFILE_IMPORT_CLI: "legacy-importer.js",
    HABBPY_V4_SHOCKLESS_ENGINE_ROOT: "legacy-engine",
    SHOCKLESS_PROFILE_IMPORT_CLI: "canonical-importer.js",
  };

  installLegacyEnvironment(environment);

  assert.equal(environment.SHOCKLESS_PROFILE_IMPORT_CLI, "canonical-importer.js");
  assert.equal(environment.SHOCKLESS_ENGINE_ROOT, "legacy-engine");
});

test("Electron preload remains self-contained CommonJS so the desktop bridge can initialize", () => {
  const preloadSource = readFileSync(join(process.cwd(), "src", "preload", "preload.cts"), "utf8");
  assert.doesNotMatch(preloadSource, /import\s+(?!type\b).*?from\s+["']\.\.?\//);
  assert.match(preloadSource, /exposeInMainWorld\("shockless", api\)/);
  assert.doesNotMatch(preloadSource, /habbpyV4/);
});

test("plugin walk target resolver matches live users by name and account id", () => {
  const snapshot = {
    userState: {
      sessionUserName: "shockless",
      users: [
        { rowId: "0", name: "shockless", x: "4", y: "5", sourceKeys: [] },
        { rowId: "2", name: "dek", accountId: "233421", x: 7, y: 8, sourceKeys: [] },
      ],
    },
  } as never;

  assert.deepEqual(pluginWalkTargetFromUser(snapshot, "dek", { offset: { x: 1, y: 0 } }), {
    x: 8,
    y: 8,
    furniId: 0,
    label: "dek (233421)",
  });
  assert.deepEqual(pluginWalkTargetFromUser(snapshot, { accountId: 233421 }), {
    x: 7,
    y: 8,
    furniId: 0,
    label: "dek (233421)",
  });
});

test("fishing area detection accepts normalized Director class names", () => {
  assert.equal(isFishingAreaObject({ className: "ZaCads_fish_area", objectId: 42 }), true);
  assert.equal(isFishingAreaObject({ className: "fish_area", objectId: 41 }), true);
  assert.equal(isFishingAreaObject({ className: "ads_fishing_area", objectId: 43 }), true);
  assert.equal(isFishingAreaObject({ className: "fisharea", objectId: 44 }), true);
  assert.equal(isFishingAreaObject({ className: "fish_wall_poster", objectId: 45 }), false);
});

test("Fishing public room NPCs do not trip the safe-room guard", () => {
  const snapshot = {
    userState: {
      sessionUserName: "dek",
      users: [
        { rowId: "0", name: "dek", userType: "1", x: 1, y: 1, sourceKeys: [] },
        { rowId: "1", name: "Bob", userType: "1", figure: "hd-190-1", x: 3, y: 4, sourceKeys: [] },
        { rowId: "2", name: "Recruiter Blaze", userType: "1", figure: "hd-180-1", x: 4, y: 4, sourceKeys: [] },
      ],
    },
  } as never;

  const occupants = pluginRoomOccupantsPayload(snapshot);
  assert.equal(occupants.safeToAutomate, true);
  assert.equal(occupants.otherHumanCount, 0);
  assert.equal(occupants.botCount, 2);
});

test("Fishing walk target chooses a free tile around the area, not the area tile", () => {
  const snapshot = {
    userState: {
      sessionUserName: "dek",
      users: [{ rowId: "0", name: "dek", userType: "1", x: 0, y: 0, sourceKeys: [] }],
    },
    roomObjects: {
      counts: {},
      users: [],
      activeObjects: [
        { objectId: 1002, className: "fish_area", x: 5, y: 5, direction: 0 },
        { objectId: 2001, className: "chair", x: 5, y: 4, direction: 0 },
        { objectId: 2002, className: "plant", x: 5, y: 3, direction: 0 },
      ],
      passiveObjects: [],
      wallItems: [],
    },
  } as never;

  const candidates = pluginFishingAreaWalkCandidates(snapshot, 1002, null);
  assert.ok(candidates.length > 0);
  assert.equal(candidates.some((tile) => tile.x === 5 && tile.y === 5), false);
  assert.equal(candidates.some((tile) => tile.x === 5 && tile.y === 4), false);
  assert.equal(candidates.some((tile) => tile.x === 5 && tile.y === 3), false);

  const target = pluginFishingAreaWalkTarget(snapshot, 1002, null);
  assert.deepEqual(target && { x: target.x, y: target.y, furniId: target.furniId }, { x: 5, y: 2, furniId: 0 });
});

test("Fishing APIs see live fish_area objects from relay active-object packets", () => {
  const packetObjects = packetActiveObjectStateFromEntries([
    relayEntry(93, 100, [
      ["activeObjectAdd id", "1002"],
      ["activeObjectAdd class", "fish_area"],
      ["activeObjectAdd tile", "5, 5"],
      ["activeObjectAdd size", "1x1"],
      ["activeObjectAdd direction", "0"],
      ["activeObjectAdd rawPosition", "QGSDIIH0"],
    ]),
  ]);
  const packetRows = packetObjects.items.map(packetActiveObjectRow);
  const snapshot = {
    userState: {
      sessionUserName: "dek",
      users: [
        { rowId: "0", name: "dek", userType: "1", x: 0, y: 0, sourceKeys: [] },
        { rowId: "1", name: "Bob", userType: "1", figure: "hd-190-1", x: 3, y: 4, sourceKeys: [] },
      ],
    },
    roomObjects: {
      counts: {},
      users: [],
      activeObjects: [],
      passiveObjects: [],
      wallItems: [],
    },
  } as never;

  const areas = pluginFishingAreaRows(snapshot, null, packetRows);
  assert.equal(areas.length, 1);
  assert.equal(areas[0]?.item.objectId, "1002");

  const candidates = pluginFishingAreaWalkCandidates(snapshot, 1002, null, packetRows);
  assert.ok(candidates.length > 0);
  assert.equal(candidates.some((tile) => tile.x === 5 && tile.y === 5), false);

  const removed = packetActiveObjectStateFromEntries([
    relayEntry(93, 100, [
      ["activeObjectAdd id", "1002"],
      ["activeObjectAdd class", "fish_area"],
      ["activeObjectAdd tile", "5, 5"],
      ["activeObjectAdd size", "1x1"],
      ["activeObjectAdd direction", "0"],
    ]),
    relayEntry(94, 101, [["activeObjectRemove id", "1002"]]),
  ]);
  assert.equal(removed.itemCount, 0);
  assert.deepEqual(removed.removedObjectIds, ["1002"]);

  const staleRuntimeAfterRemove = pluginFishingAreaRows(snapshot, null, [], removed.removedObjectIds);
  assert.equal(staleRuntimeAfterRemove.length, 0);
});

test("Fishing packet state treats STATUS fsh rows as active fishing", () => {
  const state = packetFishingStateFromEntries([
    relayEntry(34, 150, [
      ["statusRows", "1"],
      ["statusRow 1", "1/4 4 0.0/0,0,0//fsh 5,5,0,0/"],
      ["statusState 1", "fsh 5,5,0,0"],
    ]),
  ]);

  assert.equal(state.status, "fishing");
  assert.equal(state.note, "Fishing status active");
  assert.deepEqual(state.activeTile, { x: 5, y: 5, state: 0, raw: "fsh 5,5,0,0", sourceLine: 150 });
  assert.equal(state.lastSourceLine, 150);
});

test("Fishing packet state remembers the last start target", () => {
  const state = packetFishingStateFromEntries([
    relayEntry(1100, 155, [
      ["fishingClientAction", "start"],
      ["fishingClientTargetId", "888"],
    ], "CLIENT"),
  ]);

  assert.equal(state.lastClientAction, "start / target 888");
  assert.equal(state.lastClientTargetId, "888");
});

test("plant cycle planning exposes usable candidate working tiles", () => {
  const snapshot = {
    userState: {
      sessionUserName: "dek",
      users: [
        { rowId: "0", name: "dek", x: 5, y: 5, direction: 2, sourceKeys: [] },
        { rowId: "2", name: "visitor", x: 6, y: 5, sourceKeys: [] },
      ],
    },
    roomObjects: {
      counts: {},
      users: [],
      activeObjects: [
        { objectId: 1001, className: "garden_plant", x: 3, y: 3, direction: 4 },
        { objectId: 1002, className: "chair", x: 6, y: 5, direction: 0 },
      ],
      passiveObjects: [],
      wallItems: [],
    },
  } as never;

  const plan = pluginPlantCyclePlan(snapshot, { id: 1001 }, null) as Record<string, any>;
  assert.equal(plan.objectId, 1001);
  assert.deepEqual(plan.original, { x: 3, y: 3, direction: 4 });
  assert.deepEqual(plan.working, { x: 5, y: 4, direction: 4 });
  assert.ok(Array.isArray(plan.workingTiles));
  assert.ok(plan.workingTiles.length >= 3);
  assert.deepEqual(plan.workingTiles[0], { x: 5, y: 4, direction: 4 });
  assert.ok(plan.workingTiles.some((tile: Record<string, unknown>) => tile.x === 6 && tile.y === 5));
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
    "wall-mover",
    "social",
    "visitors",
    "chat",
    "injection",
    "packet-log",
    "dev-tools",
  ];
  const ids = plugins.map((plugin) => plugin.id);
  for (const id of expected) {
    assert.ok(ids.includes(id), `missing plugin ${id}`);
  }

  assert.equal(ids.includes("about"), false, "About must stay an app-level dialog, not a public built-in plugin");
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
test("plugins expose schema-rendered preview and surface layouts", () => {
  for (const plugin of plugins) {
    assert.ok(plugin.ui?.preview?.length, `${plugin.id} has no schema preview`);
    for (const surface of plugin.uiSurfaces) {
      assert.ok(surface.layout?.length, `${plugin.id}.${surface.id} has no schema layout`);
    }
  }
});

test("active renderer does not mount legacy custom plugin panels", () => {
  const source = readFileSync(join(process.cwd(), "src", "renderer", "ui", "App.tsx"), "utf8");
  const schemaActionsSource = readFileSync(
    join(process.cwd(), "src", "renderer", "features", "plugins", "usePluginSchemaActions.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.\.\/\.\.\/plugins\/[^\"]+\/Panel/);
  assert.doesNotMatch(source, /<\w+Panel\b/);
  assert.match(source, /PluginStoreModal/);
  assert.match(schemaActionsSource, /PluginSchemaActionEvent/);
  assert.match(source, /onShowAbout/);
  assert.match(source, /AboutModal/);
  assert.match(source, /Shockless GitHub/);
  assert.match(source, /discord\.gg\/rXgvjE4y3G/);
  assert.match(source, /x\.com\/digitalm1nd/);
  assert.match(source, /x\.com\/dekHabbo/);
});

test("backtick console suggestions cover built-in command handlers", () => {
  const suggestionsSource = readFileSync(join(process.cwd(), "src", "renderer", "features", "packet-console", "suggestions.ts"), "utf8");
  const commandHandlerSource = readFileSync(join(process.cwd(), "src", "renderer", "features", "packet-console", "usePacketConsoleCommand.ts"), "utf8");
  const managerSource = readFileSync(join(process.cwd(), "src", "main", "multiSessionManager.ts"), "utf8");
  const suggestions = uniqueSorted(
    [...suggestionsSource.matchAll(/consoleSuggestion\("([^"]+)"/g)]
      .map((match) => match[1]!.toLowerCase())
      .filter((command) => !command.startsWith("@")),
  );
  const reservedBlock = managerSource.match(/const reservedCommandNames = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(reservedBlock, "multi-session reserved command set must be readable");
  const reserved = uniqueSorted([...reservedBlock[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!.toLowerCase()));
  const switchBlock = managerSource.match(/switch \(command\.command\) \{([\s\S]*?)\n\s*default:/);
  assert.ok(switchBlock, "multi-session command switch must be readable");
  const switchCases = uniqueSorted([...switchBlock[1]!.matchAll(/case "([^"]+)"/g)].map((match) => match[1]!.toLowerCase()));
  const rendererHandlers = uniqueSorted([...commandHandlerSource.matchAll(/command === "([^"]+)"/g)].map((match) => match[1]!.toLowerCase()));

  assert.deepEqual(missingFrom(reserved, suggestions), [], "reserved built-in commands must appear in console suggestions");
  assert.deepEqual(missingFrom(switchCases, suggestions), [], "main command switch cases must appear in console suggestions");
  assert.deepEqual(missingFrom(rendererHandlers, suggestions), [], "renderer command handlers must appear in console suggestions");
  assert.deepEqual(missingFrom(suggestions, reserved), [], "suggested built-in commands must be reserved against alias shadowing");
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

test("Social exposes private message notifications as a toggleable surface", () => {
  const social = plugins.find((plugin) => plugin.id === "social");
  assert.ok(social);
  const surface = social.uiSurfaces.find((entry) => entry.id === "private-message-notifications");
  assert.ok(surface);
  assert.equal(surface.kind, "overlay");
  assert.equal(surface.label, "Private Message Notifications");
  assert.equal(surface.enabledByDefault, true);
});

test("plugin worker APIs exposed to user plugins have renderer request handlers", () => {
  const hostSource = readFileSync(join(process.cwd(), "src", "renderer", "userPluginHost.ts"), "utf8");
  const requestHandlerSource = readFileSync(join(process.cwd(), "src", "renderer", "features", "plugins", "handleUserPluginRequest.ts"), "utf8");
  const exposed = [...hostSource.matchAll(/request\("([^"]+)"/g)].map((match) => match[1]!).sort();
  const uniqueExposed = [...new Set(exposed)];
  const missing = uniqueExposed.filter((api) => !requestHandlerSource.includes(`request.api === "${api}"`));
  assert.deepEqual(missing, []);
});

test("notification plugin API uses the documented notification permission", () => {
  const requestHandlerSource = readFileSync(join(process.cwd(), "src", "renderer", "features", "plugins", "handleUserPluginRequest.ts"), "utf8");
  const block = requestHandlerSource.match(/if \(request\.api === "notifications\.showBulletin"\) \{[\s\S]*?throw new Error\(`Unknown plugin host API/);
  assert.ok(block, "notifications.showBulletin handler must exist");
  assert.match(block[0], /requirePluginPermission\(plugin, \["notifications\.show"\]\)/);
  assert.doesNotMatch(block[0], /requirePluginPermission\(plugin, \["ui\.overlay"\]\)/);
});

test("plugin icon documentation matches renderer icon map", () => {
  const helperSource = readFileSync(join(process.cwd(), "src", "renderer", "features", "plugins", "icon.tsx"), "utf8");
  const iconMapBlock = helperSource.match(/export const iconMap = \{([\s\S]*?)\};/);
  assert.ok(iconMapBlock, "iconMap must be exported from the plugin icon module");
  const iconKeys = [...iconMapBlock[1]!.matchAll(/^\s*([a-z0-9-]+):/gm)].map((match) => match[1]!).sort();
  assert.deepEqual(iconKeys, ["activity", "bot", "command", "hammer", "info", "list", "map", "messages", "package", "plug", "sofa", "terminal", "user", "wrench"].sort());

  const authoringPath = join(process.cwd(), "docs", "plugin-authoring.md");
  const apiReferencePath = join(process.cwd(), "docs", "plugin-api-reference.md");
  const wikiPath = existsSync(join(process.cwd(), "docs", "plugin-api.html"))
    ? join(process.cwd(), "docs", "plugin-api.html")
    : join(process.cwd(), "..", "..", "docs", "plugin-api.html");
  const authoring = existsSync(authoringPath) ? readFileSync(authoringPath, "utf8") : null;
  const apiReference = existsSync(apiReferencePath) ? readFileSync(apiReferencePath, "utf8") : null;
  const wiki = readFileSync(wikiPath, "utf8");
  for (const key of iconKeys) {
    if (authoring) assert.match(authoring, new RegExp(`- \`${key}\``), `plugin-authoring.md missing icon ${key}`);
    if (apiReference) assert.match(apiReference, new RegExp(`- \`${key}\``), `plugin-api-reference.md missing icon ${key}`);
    assert.match(wiki, new RegExp(`\\["${key}",`), `plugin-api.html missing icon ${key}`);
  }
  if (authoring && apiReference) {
    const authoringIconSection = authoring.match(/## Icons([\s\S]*?)## Surfaces/);
    const apiReferenceIconSection = apiReference.match(/## Manifest Icon Keys([\s\S]*?)## Plugin And Surface Lifecycle/);
    assert.ok(authoringIconSection, "plugin-authoring.md icon section must exist");
    assert.ok(apiReferenceIconSection, "plugin-api-reference.md icon section must exist");
    for (const invalid of ["settings", "users"]) {
      assert.doesNotMatch(authoringIconSection[1], new RegExp(`- \`${invalid}\``), `plugin-authoring.md lists invalid icon ${invalid}`);
      assert.doesNotMatch(apiReferenceIconSection[1], new RegExp(`- \`${invalid}\``), `plugin-api-reference.md lists invalid icon ${invalid}`);
    }
  }
});

test("plugin API documentation covers every exposed worker request API", () => {
  const hostSource = readFileSync(join(process.cwd(), "src", "renderer", "userPluginHost.ts"), "utf8");
  const apiReferencePath = join(process.cwd(), "docs", "plugin-api-reference.md");
  const wikiPath = existsSync(join(process.cwd(), "docs", "plugin-api.html"))
    ? join(process.cwd(), "docs", "plugin-api.html")
    : join(process.cwd(), "..", "..", "docs", "plugin-api.html");
  const apiReference = existsSync(apiReferencePath) ? readFileSync(apiReferencePath, "utf8") : null;
  const wiki = readFileSync(wikiPath, "utf8");
  const exposedApis = [...new Set([...hostSource.matchAll(/request\("([^"]+)"/g)].map((match) => match[1]!))].sort();
  const missingFromReference = apiReference ? exposedApis.filter((api) => !apiReference.includes(api)) : [];
  const missingFromWiki = exposedApis.filter((api) => !wiki.includes(api));
  assert.deepEqual(missingFromReference, [], "plugin-api-reference.md is missing exposed Worker APIs");
  assert.deepEqual(missingFromWiki, [], "plugin-api.html is missing exposed Worker APIs");
});

test("plugin HTML permission table lists only real manifest permissions", () => {
  const pluginTypes = readFileSync(join(process.cwd(), "src", "shared", "plugin.ts"), "utf8");
  const wiki = readFileSync(join(process.cwd(), "docs", "plugin-api.html"), "utf8");
  const permissionUnion = pluginTypes.match(/export type PluginPermission =([\s\S]*?);/);
  assert.ok(permissionUnion, "PluginPermission union must exist");
  const declaredPermissions = [...permissionUnion[1]!.matchAll(/\|\s*"([^"]+)"/g)].map((match) => match[1]!).sort();
  const permissionTable = wiki.match(/const permissions = \[([\s\S]*?)\];/);
  assert.ok(permissionTable, "plugin-api.html permission table must exist");
  const documentedPermissions = [...permissionTable[1]!.matchAll(/\["([^"]+)"/g)].map((match) => match[1]!).sort();
  assert.deepEqual(documentedPermissions, declaredPermissions);
});

test("default enabled plugins stay focused on recovery, connection, info, and diagnostics", () => {
  const enabledById = createInitialPluginEnabledState();
  const enabledIds = Object.entries(enabledById)
    .filter(([, enabled]) => enabled)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(enabledIds, ["connection", "dev-tools", "info"].sort());
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
  assert.equal(collapsed.ui.dockCollapsed, !overlayOff.ui.dockCollapsed);

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

test("injection exposes one validated raw packet command without the legacy mapped editor", () => {
  const injectionCommands = commands.filter((entry) => entry.pluginId === "injection");
  assert.equal(injectionCommands.length, 1);
  const command = injectionCommands[0];
  assert.ok(command);
  assert.equal(command.status, "ready");
  assert.equal(command.id, "injection.rawPacketSend");
  assert.equal(command.risk, "advanced");
  assert.equal(command.route.kind, "shockless-webcontents");
  assert.ok(command.route.sourcePaths.some((sourcePath) => sourcePath.includes("shockwavePluginPacketBuilder")));
  assert.match(command.route.notes ?? "", /server and client targets/i);
});

test("injection storage migration keeps raw packets and discards legacy mapped commands", () => {
  const snippets = normalizeInjectionSnippets([
    { id: "raw", direction: "client", text: "@^" },
    { id: "legacy", command: { actionKind: "clickWindowElement", windowId: "Room_bar", elementId: "int_hand_image" } },
  ]);
  assert.deepEqual(snippets.map((entry) => entry.id), ["raw"]);
  assert.equal(snippets[0]?.command.rawDirection, "CLIENT");
  assert.equal(snippets[0]?.command.rawText, "@^");

  const history = normalizeInjectionHistory([
    { id: "old", label: "[CLIENT] {h:48}", status: "success", message: "sent", time: "12:00" },
  ]);
  assert.equal(history[0]?.direction, "CLIENT");
  assert.equal(history[0]?.packetText, "{h:48}");
});

test("backtick injection parser preserves complete raw packet text and target prefixes", () => {
  assert.deepEqual(parsePacketInjectionCommand("@2 inject client {h:48}{s:\"line one\"}\n[2]tail"), {
    ok: true,
    target: "client",
    packetText: "{h:48}{s:\"line one\"}\n[2]tail",
  });
  assert.deepEqual(parsePacketInjectionCommand("sendpacket server @^"), {
    ok: true,
    target: "server",
    packetText: "@^",
  });
});

test("blocked plugins must explain the missing boundary", () => {
  for (const plugin of plugins.filter((entry) => entry.status === "blocked")) {
    const text = [...plugin.sourceMapping.shockless, plugin.sourceMapping.notes ?? ""].join(" ");
    assert.match(text, /not yet|requires|blocked|prefer/i);
  }
});

test("embedded Shockless launch URL is built from selected profile metadata", () => {
  const previousTcpHost = process.env.SHOCKLESS_ORIGINS_TCP_HOST;
  const previousTcpPort = process.env.SHOCKLESS_ORIGINS_TCP_PORT;
  const previousMusHost = process.env.SHOCKLESS_ORIGINS_MUS_HOST;
  const previousMusPort = process.env.SHOCKLESS_ORIGINS_MUS_PORT;
  try {
    process.env.SHOCKLESS_ORIGINS_TCP_HOST = "game-ous.habbo.com";
    process.env.SHOCKLESS_ORIGINS_TCP_PORT = "40001";
    delete process.env.SHOCKLESS_ORIGINS_MUS_HOST;
    delete process.env.SHOCKLESS_ORIGINS_MUS_PORT;
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
          fidelityComplete: true,
          fidelityWarningCount: 0,
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
        realm: originsRealmDefinition("ous"),
        settings: {
          realm: "ous",
          resizablePresentation: true,
          customHotelView: false,
          entryView: null,
          versionCheckBuild: null,
        },
      }),
    );

    assert.equal(url.searchParams.get("profile"), "dynamic-profile");
    assert.equal(url.searchParams.get("profileVersion"), "release-current");
    assert.equal(url.searchParams.get("resizablePresentation"), "1");
    assert.equal(url.searchParams.get("bridgeHost"), "127.0.0.1");
    assert.equal(url.searchParams.get("bridgePort"), "12340");
    assert.equal(url.searchParams.get("connection.info.host"), "game-ous.habbo.com");
    assert.equal(url.searchParams.get("connection.info.port"), "40001");
    assert.equal(url.searchParams.get("connection.mus.host"), "game-ous.habbo.com");
    assert.equal(url.searchParams.get("connection.mus.port"), "40002");
    assert.equal(url.searchParams.has("versionCheckBuild"), false);
  } finally {
    if (previousTcpHost === undefined) delete process.env.SHOCKLESS_ORIGINS_TCP_HOST;
    else process.env.SHOCKLESS_ORIGINS_TCP_HOST = previousTcpHost;
    if (previousTcpPort === undefined) delete process.env.SHOCKLESS_ORIGINS_TCP_PORT;
    else process.env.SHOCKLESS_ORIGINS_TCP_PORT = previousTcpPort;
    if (previousMusHost === undefined) delete process.env.SHOCKLESS_ORIGINS_MUS_HOST;
    else process.env.SHOCKLESS_ORIGINS_MUS_HOST = previousMusHost;
    if (previousMusPort === undefined) delete process.env.SHOCKLESS_ORIGINS_MUS_PORT;
    else process.env.SHOCKLESS_ORIGINS_MUS_PORT = previousMusPort;
  }
});

test("embedded Shockless presentation defaults to responsive with explicit fixed-stage opt-out", () => {
  const previousResizable = process.env.SHOCKLESS_RESIZABLE_PRESENTATION;
  const previousFixed = process.env.SHOCKLESS_FIXED_STAGE;
  try {
    delete process.env.SHOCKLESS_RESIZABLE_PRESENTATION;
    delete process.env.SHOCKLESS_FIXED_STAGE;
    assert.equal(embeddedResizablePresentation(null, false), true);
    assert.equal(embeddedResizablePresentation(false, false), false);
    assert.equal(embeddedResizablePresentation(true, false), true);

    process.env.SHOCKLESS_FIXED_STAGE = "1";
    assert.equal(embeddedResizablePresentation(true, true), false);

    delete process.env.SHOCKLESS_FIXED_STAGE;
    process.env.SHOCKLESS_RESIZABLE_PRESENTATION = "0";
    assert.equal(embeddedResizablePresentation(true, true), false);

    process.env.SHOCKLESS_RESIZABLE_PRESENTATION = "1";
    assert.equal(embeddedResizablePresentation(false, false), true);
  } finally {
    if (previousResizable === undefined) delete process.env.SHOCKLESS_RESIZABLE_PRESENTATION;
    else process.env.SHOCKLESS_RESIZABLE_PRESENTATION = previousResizable;
    if (previousFixed === undefined) delete process.env.SHOCKLESS_FIXED_STAGE;
    else process.env.SHOCKLESS_FIXED_STAGE = previousFixed;
  }
});

test("external variables normalization keeps live gamedata dynamic", () => {
  const normalized = normalizeOriginsExternalVariables("flash.dynamic.download.url=https://example.test/dyn/\rclient.version.id=401");
  assert.match(normalized, /dynamic\.download\.url=https:\/\/example\.test\/dyn\//);
  assert.match(normalized, /furnidata\.load\.url=furnidata\.txt/);
  assert.match(normalized, /productdata\.load\.url=productdata\.txt/);
});

test("external variables normalization applies accepted VERSIONCHECK build", () => {
  const normalized = normalizeOriginsExternalVariables(
    "client.version.id=401\rflash.dynamic.download.url=https://example.test/dyn/\rclient.version.id=401",
    1129,
  );
  assert.match(normalized, /client\.version\.id=1129/);
  assert.doesNotMatch(normalized, /client\.version\.id=401/);
});

test("external variables normalization forces official game and MUS endpoints over imported localhost values", () => {
  const normalized = normalizeOriginsExternalVariables(
    "connection.info.host=127.0.0.1\rconnection.info.port=40001\rconnection.mus.host=127.0.0.1\rconnection.mus.port=40002",
    1129,
    { host: "game-ous.habbo.com", port: 40001 },
  );

  assert.match(normalized, /connection\.info\.host=game-ous\.habbo\.com/);
  assert.match(normalized, /connection\.info\.port=40001/);
  assert.match(normalized, /connection\.mus\.host=game-ous\.habbo\.com/);
  assert.match(normalized, /connection\.mus\.port=40002/);
  assert.doesNotMatch(normalized, /connection\.mus\.host=127\.0\.0\.1/);
});

test("Origins realm definitions default to OUS and map each regional endpoint", () => {
  assert.equal(normalizeOriginsRealmId(undefined), "ous");
  assert.equal(normalizeOriginsRealmId("invalid"), "ous");
  assert.equal(originsRealmDefinition("ous").gameHost, "game-ous.habbo.com");
  assert.equal(originsRealmDefinition("oes").nativeEntryView, "hh_entry_es");
  assert.equal(originsRealmDefinition("obr").patchCast, "hh_patch_br");
  assert.equal(
    originsRealmGamedataUrl(originsRealmDefinition("oes"), "external_texts/1"),
    "https://origins-gamedata.habbo.es/external_texts/1",
  );
  assert.equal(
    originsRealmGamedataUrl(originsRealmDefinition("obr"), "/external_variables/1"),
    "https://origins-gamedata.habbo.com.br/external_variables/1",
  );
});

test("regional legacy external texts decode as Windows-1252 and reject unrelated locale corpora", () => {
  const spanishBytes = Uint8Array.from([
    ...Buffer.from("login_name=Contrase", "ascii"),
    0xf1,
    ...Buffer.from("a\nlogin_ok=OK\nlogin_password=Clave\nlogin_firstTimeHere=Primera vez", "ascii"),
  ]);
  const decoded = decodeOriginsExternalTexts(spanishBytes);
  assert.match(decoded, /login_name=Contraseña/);

  const profileTexts = [
    "login_name=Email Address",
    "login_ok=OK",
    "login_password=Password",
    "login_firstTimeHere=First time here?",
  ].join("\n");
  assert.equal(isCompatibleOriginsExternalTexts(decoded, profileTexts), true);
  assert.equal(
    isCompatibleOriginsExternalTexts(
      "navigator.search=Search\nmodern.client.setting=Enabled\nroom.name=Room",
      profileTexts,
    ),
    false,
  );
});

test("regional external variables replace every duplicate with the selected realm", () => {
  const normalized = normalizeOriginsExternalVariables(
    [
      "connection.info.host=stale-one.example",
      "cast.entry.2=hh_patch_uk",
      "cast.entry.11=hh_entry_uk",
      "connection.info.host=stale-two.example",
      "connection.mus.host=stale-mus.example",
      "external.texts.txt=https://stale.example/external_texts",
    ].join("\r"),
    1130,
    undefined,
    "obr",
  );

  assert.equal(normalized.match(/connection\.info\.host=game-obr\.habbo\.com/g)?.length, 2);
  assert.doesNotMatch(normalized, /stale-(?:one|two|mus)/);
  assert.match(normalized, /connection\.mus\.host=game-obr\.habbo\.com/);
  assert.match(normalized, /cast\.entry\.2=hh_patch_br/);
  assert.match(normalized, /cast\.entry\.11=hh_entry_br/);
  assert.match(normalized, /external\.texts\.txt=external_texts\.txt/);
  assert.equal(lastExternalVariableValue("key=first\rkey=second", "key"), "second");
});

test("Shockless launch settings default to custom hotel view", () => {
  const appData = mkdtempSync(join(tmpdir(), "habbpy-v4-default-hotel-view-"));
  try {
    const defaults = readShocklessSettings(appData);
    assert.equal(defaults.realm, "ous");
    assert.equal(defaults.customHotelView, true);
    assert.equal(defaults.entryView, null);

    const settingsRoot = join(appData, "ShocklessEngine");
    mkdirSync(settingsRoot, { recursive: true });
    writeFileSync(join(settingsRoot, "settings.json"), `${JSON.stringify({ entryView: "hh_entry_uk" })}\n`, "utf8");
    const legacyCountryView = readShocklessSettings(appData);
    assert.equal(legacyCountryView.customHotelView, false);
    assert.equal(legacyCountryView.entryView, "hh_entry_uk");

    writeFileSync(join(settingsRoot, "settings.json"), `${JSON.stringify({ customHotelView: false, entryView: "hh_entry_br" })}\n`, "utf8");
    const brazilianCountryView = readShocklessSettings(appData);
    assert.equal(brazilianCountryView.customHotelView, false);
    assert.equal(brazilianCountryView.entryView, "hh_entry_br");

    const selectedRealm = writeShocklessSettings(appData, { realm: "oes", customHotelView: false, entryView: "hh_entry_es" });
    assert.equal(selectedRealm.realm, "oes");
    assert.equal(selectedRealm.customHotelView, false);
    assert.equal(selectedRealm.entryView, "hh_entry_es");
    assert.equal(readShocklessSettings(appData).realm, "oes");

    const invalidRealm = writeShocklessSettings(appData, { realm: "not-a-realm" as never });
    assert.equal(invalidRealm.realm, "ous");

    const explicitCustom = writeShocklessSettings(appData, { customHotelView: true, entryView: null });
    assert.equal(explicitCustom.customHotelView, true);
    assert.equal(explicitCustom.entryView, null);
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
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

test("client library exposes persisted profile fidelity without blocking launch", () => {
  const root = mkdtempSync(join(tmpdir(), "shockless-profile-fidelity-"));
  try {
    const appData = join(root, "appdata");
    const profileRoot = join(root, "profiles", "release331-fixture");
    writeReadyProfileFixture(profileRoot, "release331", 331, "compiled 331", {
      fidelityComplete: false,
      warningCount: 4,
    });

    const selected = new ClientLibraryStore(appData)
      .registerSource(profileRoot)
      .profiles.find((profile) => profile.profileRoot === profileRoot);
    assert.equal(selected?.ready, true);
    assert.equal(selected?.fidelityComplete, false);
    assert.equal(selected?.fidelityWarningCount, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library ignores incomplete importer work folders", () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-profile-transient-"));
  try {
    const clientsRoot = join(root, "clients");
    const importingRoot = join(clientsRoot, ".importing-release324-fixture");
    const readyRoot = join(clientsRoot, "release324-fixture");
    writeReadyProfileFixture(importingRoot, "release324", 324, "compiled 324");
    writeReadyProfileFixture(readyRoot, "release324", 324, "compiled 324");

    const scan = findProfileRootsInSource(clientsRoot);
    assert.deepEqual(scan.profileRoots, [readyRoot]);
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

test("client library rejects importer success when final profile json is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-import-missing-profile-"));
  const previousCli = process.env.SHOCKLESS_PROFILE_IMPORT_CLI;
  const previousClientsRoot = process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT;
  const previousCacheRoot = process.env.SHOCKLESS_IMPORT_CACHE_ROOT;
  try {
    const appData = join(root, "appdata");
    const clientRoot = join(root, "compiled 326");
    const clientsRoot = join(root, "habbpy-clients");
    const fakeCli = join(root, "fake-profile-import-missing-profile.js");
    writeCompiledClientFixture(clientRoot, 326);
    writeFakeProfileImportCliWithoutProfileJson(fakeCli);
    process.env.SHOCKLESS_PROFILE_IMPORT_CLI = fakeCli;
    process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT = clientsRoot;
    process.env.SHOCKLESS_IMPORT_CACHE_ROOT = join(root, "import-cache");

    const library = new ClientLibraryStore(appData);
    await assert.rejects(() => library.importOrRegisterSource(clientRoot), /profile\.json.*was not created/);
  } finally {
    if (previousCli === undefined) delete process.env.SHOCKLESS_PROFILE_IMPORT_CLI;
    else process.env.SHOCKLESS_PROFILE_IMPORT_CLI = previousCli;
    if (previousClientsRoot === undefined) delete process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT;
    else process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT = previousClientsRoot;
    if (previousCacheRoot === undefined) delete process.env.SHOCKLESS_IMPORT_CACHE_ROOT;
    else process.env.SHOCKLESS_IMPORT_CACHE_ROOT = previousCacheRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("client library compiled-client import builds a playable profile when cache is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-import-runner-"));
  const previousCli = process.env.SHOCKLESS_PROFILE_IMPORT_CLI;
  const previousClientsRoot = process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT;
  const previousCacheRoot = process.env.SHOCKLESS_IMPORT_CACHE_ROOT;
  try {
    const appData = join(root, "appdata");
    const clientRoot = join(root, "compiled 325");
    const clientsRoot = join(root, "habbpy-clients");
    const fakeCli = join(root, "fake-profile-import.js");
    writeCompiledClientFixture(clientRoot, 325);
    writeFakeProfileImportCli(fakeCli);
    process.env.SHOCKLESS_PROFILE_IMPORT_CLI = fakeCli;
    process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT = clientsRoot;
    process.env.SHOCKLESS_IMPORT_CACHE_ROOT = join(root, "import-cache");

    const library = new ClientLibraryStore(appData);
    const progress: ProfileImportProgress[] = [];
    const state = await library.importOrRegisterSource(clientRoot, { onProgress: (entry) => progress.push(entry) });
    const importedRoot = join(clientsRoot, "release325-imported");

    assert.equal(state.selectedProfileRoot, importedRoot);
    assert.ok(existsSync(join(importedRoot, "profile.json")));
    assert.ok(state.profiles.some((profile) => profile.profileRoot === importedRoot && profile.ready));
    assert.ok(state.profiles.some((profile) => profile.profileRoot === importedRoot && profile.fidelityComplete === false));
    assert.ok(progress.some((entry) =>
      entry.stage === "materialize-bitmaps"
      && entry.state === "running"
      && entry.bytesProcessed === 1536
      && entry.bytesTotal === 4096
      && entry.workers === 4
      && entry.cacheMisses === 1
      && entry.reusedBytes === 1024
    ));
    assert.ok(progress.some((entry) => entry.stage === "validate-profile" && entry.state === "warning" && /fidelity warnings/i.test(entry.message)));
    assert.match(state.message, /Compiled client release325 was imported into a playable Shockless profile/);
  } finally {
    if (previousCli === undefined) delete process.env.SHOCKLESS_PROFILE_IMPORT_CLI;
    else process.env.SHOCKLESS_PROFILE_IMPORT_CLI = previousCli;
    if (previousClientsRoot === undefined) delete process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT;
    else process.env.SHOCKLESS_IMPORT_CLIENTS_ROOT = previousClientsRoot;
    if (previousCacheRoot === undefined) delete process.env.SHOCKLESS_IMPORT_CACHE_ROOT;
    else process.env.SHOCKLESS_IMPORT_CACHE_ROOT = previousCacheRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("client importer metrics are concise and human readable", () => {
  const metrics = profileImportMetricText({
    jobId: "metrics-test",
    sourceName: "compiled 325",
    stage: "materialize-bitmaps",
    state: "running",
    message: "Preparing assets",
    percent: 37.5,
    bytesProcessed: 1536,
    bytesTotal: 4096,
    workers: 4,
    cacheMisses: 1,
    reusedBytes: 1024,
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  assert.deepEqual(metrics, ["1.5 KB / 4.0 KB", "4 workers", "Cache miss", "1.0 KB reused"]);
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
  runtime: { ready: true, validation: { fidelityComplete: false, warningCount: 3 } },
  paths: {
    client: "client",
    runtimeData: "runtime-data",
    assets: "assets",
    scripts: "scripts"
  }
}, null, 2) + "\\n", "utf8");
console.log("@shockless-import-progress " + JSON.stringify({
  stage: "materialize-bitmaps",
  state: "running",
  message: "Preparing assets",
  detail: "Decoding imported bitmap assets",
  percent: 37.5,
  current: 384,
  total: 1024,
  bytesProcessed: 1536,
  bytesTotal: 4096,
  workers: 4,
  cacheMisses: 1,
  reusedBytes: 1024,
  elapsedMs: 2500
}));
console.log("[done] fake import complete");
console.log(JSON.stringify({ id: "release325-imported", profileRoot, runtime: { ready: true, validation: { fidelityComplete: false, warningCount: 3 } } }, null, 2));
`,
    "utf8",
  );
}

function writeFakeProfileImportCliWithoutProfileJson(cliPath: string): void {
  writeFileSync(
    cliPath,
    `
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
const clientsRoot = arg("--clients-root");
const profileRoot = join(clientsRoot, "release326-imported");
mkdirSync(join(profileRoot, "client"), { recursive: true });
console.log(JSON.stringify({ id: "release326-imported", profileRoot, runtime: { ready: true } }, null, 2));
`,
    "utf8",
  );
}

function writeReadyProfileFixture(
  profileRoot: string,
  versionId: string,
  buildNumber: number,
  sourceFolderName: string,
  validation?: { readonly fidelityComplete: boolean; readonly warningCount: number },
): void {
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
        runtime: { ready: true, ...(validation ? { validation } : {}) },
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
