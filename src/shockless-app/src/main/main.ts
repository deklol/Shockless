import { app, BrowserWindow, dialog, ipcMain, shell, webContents, type WebContents } from "electron";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appPreferencesState, earlyAppDataPath, GPU_LAUNCH_SWITCHES, readAppPreferences, writeAppPreferences, type AppPreferences } from "./appPreferences.js";
import { applyAppMenu } from "./appMenu.js";
import { ClientLibraryStore } from "./clientLibrary.js";
import { readFurniMetadataSnapshot } from "./furnidata.js";
import { MultiSessionManager } from "./multiSessionManager.js";
import { lookupOriginsUser } from "./originsUserLookup.js";
import { PluginManager } from "./pluginManager.js";
import { stopActiveProfileImports } from "./profileImportRunner.js";
import { ReliabilityDiagnostics } from "./reliabilityDiagnostics.js";
import { readRelayLogDeltaSnapshot, readRelayLogHistoryPage, readRelayLogSnapshot } from "./relayLog.js";
import { readShocklessSettings, stopActiveEmbeddedRelays, writeShocklessSettings } from "./shocklessEmbed.js";
import { UpdateManager } from "./updateService.js";
import { appDataStorePath, appDataStoreRoot, legacyAppDataStoreRoots } from "./appDataPaths.js";
import { APP_DISPLAY_NAME } from "../shared/branding.js";
import { installLegacyEnvironment } from "../shared/legacyCompatibility.js";
import { migrateLegacyChromiumPartitions } from "./legacyMigration.js";
import { isAllowedGardeningRelayAction } from "../shared/gardeningRelayPackets.js";
import { isAllowedFurniRelayAction } from "../shared/furniRelayPackets.js";
import { isAllowedFishingRelayAction } from "../shared/fishingRelayPackets.js";
import { isAllowedRoomRelayAction } from "../shared/roomRelayPackets.js";
import { isAllowedSocialRelayAction } from "../shared/socialRelayPackets.js";
import { pluginPacketRelayControlPayload } from "../shared/shockwavePluginPacketBuilder.js";
import { isAllowedUserRelayAction } from "../shared/userRelayPackets.js";
import { isAllowedWallMoverRelayAction } from "../shared/wallMoverRelayPackets.js";
import type {
  GardeningRelayAction,
  FishingRelayAction,
  FurniRelayAction,
  GardeningRelayResult,
  ProfileImportProgress,
  EngineLaunchSettingsPatch,
  PluginPacketInput,
  RoomRelayAction,
  SocialRelayAction,
  UserRelayAction,
  WallMoverRelayAction,
  RendererHeartbeat,
  RuntimeHealthReport,
} from "../shared/window-api.js";
import type { PluginCreateRequest } from "../shared/plugin.js";
import { errorMessage } from "../shared/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

installLegacyEnvironment(process.env);

const isDev = process.env.SHOCKLESS_DEV === "1" || !app.isPackaged;
const RELAY_CONTROL_HOST = "127.0.0.1";
let clientLibrary: ClientLibraryStore | null = null;
let multiSessionManager: MultiSessionManager | null = null;
let pluginManagerInstance: PluginManager | null = null;
let updateManagerInstance: UpdateManager | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let forcedExitTimer: NodeJS.Timeout | null = null;
let activeImportJobId: string | null = null;
let reliabilityDiagnosticsInstance: ReliabilityDiagnostics | null = null;
let mainUnresponsiveTimer: NodeJS.Timeout | null = null;
let heartbeatMonitorTimer: NodeJS.Timeout | null = null;

// Portable build: relocate all app data (config, logs, saved credentials, the
// client library) AND Chromium's profile (localStorage / cache) into a `data/`
// folder next to the exe â€” easy to find, back up, or clear â€” instead of Roaming
// AppData. The env override keeps earlyAppDataPath() + appDataPath() in agreement;
// redirecting userData carries localStorage so renderer prefs persist portably.
if (app.isPackaged && !process.env.SHOCKLESS_APP_DATA_PATH) {
  const portableBase = process.env.PORTABLE_EXECUTABLE_DIR?.trim() || path.dirname(app.getPath("exe"));
  const dataRoot = path.join(portableBase, "data");
  process.env.SHOCKLESS_APP_DATA_PATH = dataRoot;
  app.setPath("userData", path.join(dataRoot, "profile"));
}

migrateLegacyChromiumPartitions(app.getPath("userData"));

const launchHardwareAccelerationEnabled = readAppPreferences(earlyAppDataPath()).hardwareAcceleration;

if (launchHardwareAccelerationEnabled) {
  for (const flag of GPU_LAUNCH_SWITCHES) app.commandLine.appendSwitch(flag);
} else {
  app.disableHardwareAcceleration();
}

function rendererUrl(): string {
  if (isDev) {
    return process.env.SHOCKLESS_RENDERER_URL || "http://127.0.0.1:5178";
  }
  return pathToFileURL(path.join(__dirname, "../../renderer/index.html")).toString();
}

function createWindow(): void {
  const showMainWindow = process.env.SHOCKLESS_MAIN_WINDOW_SHOW !== "0";
  const window = new BrowserWindow({
    width: 1440,
    height: 975,
    minWidth: 720,
    minHeight: 520,
    useContentSize: true,
    show: false,
    title: APP_DISPLAY_NAME,
    backgroundColor: "#090a0d",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false is required for webviewTag support and for Electron
      // APIs used by the embedded Shockless engine runtime. Mitigated by
      // contextIsolation:true and nodeIntegration:false.
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => {
    if (showMainWindow && !window.isDestroyed()) window.show();
  });
  attachMainWindowReliability(window);
  updateManager().addListener(window.webContents);
  applyAppMenu(window, {
    dataDir: appDataStoreRoot(appDataPath()),
    pluginsDir: appDataStorePath(appDataPath(), "plugins"),
    repoUrl: "https://github.com/deklol/Shockless",
    issuesUrl: "https://github.com/deklol/Shockless/issues",
    clearSavedCredentials: () => {
      for (const dir of [appDataStoreRoot(appDataPath()), ...legacyAppDataStoreRoots(appDataPath())]) {
        for (const file of ["account-store.v1.json", "multiclient-accounts.txt"]) {
          rmSync(path.join(dir, file), { force: true });
        }
      }
    },
    clearSessionLogs: () => {
      for (const dir of [appDataStoreRoot(appDataPath()), ...legacyAppDataStoreRoots(appDataPath())]) {
        rmSync(path.join(dir, "logs"), { recursive: true, force: true });
      }
    },
    clearAllAppData: () => {
      for (const dir of [appDataStoreRoot(appDataPath()), ...legacyAppDataStoreRoots(appDataPath())]) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    reloadPlugins: () => {
      pluginManager().reload();
    },
    shellUiHidden: readAppPreferences(appDataPath()).shellUiHidden,
    setShellUiHidden: (hidden) => {
      const next = writeAppPreferences(appDataPath(), { shellUiHidden: hidden });
      window.webContents.send("shockless:shell-ui-hidden-changed", next.shellUiHidden);
    },
  });
  window.on("close", () => {
    disposeAppResources();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.once("did-finish-load", () => {
    if (process.env.SHOCKLESS_DISABLE_UPDATE_CHECK === "1") return;
    setTimeout(() => void updateManager().checkForUpdates({ silent: true }), 600);
  });
  void window.loadURL(rendererUrl());
}

ipcMain.handle("shockless:get-app-info", () => ({
  name: APP_DISPLAY_NAME,
  version: appVersion(),
  mode: app.isPackaged ? "desktop" : "browser-preview",
}));
ipcMain.handle("shockless:get-reliability-state", () => reliabilityDiagnostics().state());
ipcMain.on("shockless:renderer-heartbeat", (_event, heartbeat: RendererHeartbeat) => {
  reliabilityDiagnostics().rendererHeartbeat(heartbeat);
});
ipcMain.on("shockless:runtime-health", (_event, report: RuntimeHealthReport) => {
  reliabilityDiagnostics().runtimeHealth(report);
});
ipcMain.handle("shockless:get-app-preferences", () =>
  appPreferencesState(appDataPath(), launchHardwareAccelerationEnabled),
);
ipcMain.handle("shockless:set-app-preferences", (_event, patch: Partial<Record<keyof AppPreferences, unknown>> | null) => {
  const current = readAppPreferences(appDataPath());
  writeAppPreferences(appDataPath(), {
    shellUiHidden: typeof patch?.shellUiHidden === "boolean" ? patch.shellUiHidden : current.shellUiHidden,
    hardwareAcceleration: typeof patch?.hardwareAcceleration === "boolean" ? patch.hardwareAcceleration : current.hardwareAcceleration,
    packetOutputWrap: typeof patch?.packetOutputWrap === "boolean" ? patch.packetOutputWrap : current.packetOutputWrap,
    packetOutputAutoScroll:
      typeof patch?.packetOutputAutoScroll === "boolean" ? patch.packetOutputAutoScroll : current.packetOutputAutoScroll,
    engineUserNameLabels:
      typeof patch?.engineUserNameLabels === "boolean" ? patch.engineUserNameLabels : current.engineUserNameLabels,
    customHabboCursor:
      typeof patch?.customHabboCursor === "boolean" ? patch.customHabboCursor : current.customHabboCursor,
    userNameLabelOffset:
      typeof patch?.userNameLabelOffset === "number" ? patch.userNameLabelOffset : current.userNameLabelOffset,
    userNameLabelSelfColor:
      typeof patch?.userNameLabelSelfColor === "string" ? patch.userNameLabelSelfColor : current.userNameLabelSelfColor,
    userNameLabelOtherColor:
      typeof patch?.userNameLabelOtherColor === "string" ? patch.userNameLabelOtherColor : current.userNameLabelOtherColor,
    nativeBindShift: typeof patch?.nativeBindShift === "string" ? patch.nativeBindShift : current.nativeBindShift,
    nativeBindControl: typeof patch?.nativeBindControl === "string" ? patch.nativeBindControl : current.nativeBindControl,
    nativeBindOption: typeof patch?.nativeBindOption === "string" ? patch.nativeBindOption : current.nativeBindOption,
    nativeBindCommand: typeof patch?.nativeBindCommand === "string" ? patch.nativeBindCommand : current.nativeBindCommand,
    defaultAccountFile: typeof patch?.defaultAccountFile === "string" ? patch.defaultAccountFile : current.defaultAccountFile,
    defaultAccountCount: typeof patch?.defaultAccountCount === "number" ? patch.defaultAccountCount : current.defaultAccountCount,
    defaultAccountConcurrency:
      typeof patch?.defaultAccountConcurrency === "number" ? patch.defaultAccountConcurrency : current.defaultAccountConcurrency,
    defaultAccountKeyEnv: typeof patch?.defaultAccountKeyEnv === "string" ? patch.defaultAccountKeyEnv : current.defaultAccountKeyEnv,
    defaultSummonTarget: typeof patch?.defaultSummonTarget === "string" ? patch.defaultSummonTarget : current.defaultSummonTarget,
    defaultLoadMode: patch?.defaultLoadMode === "visible" ? "visible" : patch?.defaultLoadMode === "headless" ? "headless" : current.defaultLoadMode,
    autoSubmitVisibleLogin:
      typeof patch?.autoSubmitVisibleLogin === "boolean" ? patch.autoSubmitVisibleLogin : current.autoSubmitVisibleLogin,
  });
  return appPreferencesState(appDataPath(), launchHardwareAccelerationEnabled);
});
ipcMain.handle("shockless:get-update-state", (event) => {
  updateManager().addListener(event.sender);
  return updateManager().snapshot();
});
ipcMain.handle("shockless:check-for-updates", (event) => {
  updateManager().addListener(event.sender);
  return updateManager().checkForUpdates({ silent: false });
});
ipcMain.handle("shockless:download-update", (event) => {
  updateManager().addListener(event.sender);
  return updateManager().downloadUpdate();
});
ipcMain.handle("shockless:install-downloaded-update", async (event) => {
  updateManager().addListener(event.sender);
  const state = await updateManager().installDownloadedUpdate();
  if (state.status === "installing") {
    setTimeout(() => {
      isQuitting = true;
      disposeAppResources();
      app.quit();
      scheduleForcedExit();
    }, 100);
  }
  return state;
});
ipcMain.handle("shockless:skip-update", (event, version: string) => {
  updateManager().addListener(event.sender);
  return updateManager().skipUpdate(String(version ?? ""));
});
ipcMain.handle("shockless:get-plugin-registry-state", () => pluginManager().state());
ipcMain.handle("shockless:set-plugin-enabled", (_event, pluginId: string, enabled: boolean) =>
  pluginManager().setPluginEnabled(String(pluginId ?? ""), enabled === true),
);
ipcMain.handle("shockless:set-plugin-surface-enabled", (_event, pluginId: string, surfaceId: string, enabled: boolean) =>
  pluginManager().setPluginSurfaceEnabled(String(pluginId ?? ""), String(surfaceId ?? ""), enabled === true),
);
ipcMain.handle("shockless:reload-plugins", () => pluginManager().reload());
ipcMain.handle("shockless:open-plugins-folder", async () => {
  const manager = pluginManager();
  mkdirSync(manager.userPluginRoot(), { recursive: true });
  const message = await shell.openPath(manager.userPluginRoot());
  return { ok: !message, message: message || "Plugins folder opened.", state: manager.state() };
});
ipcMain.handle("shockless:create-plugin-from-template", (_event, request: PluginCreateRequest) =>
  pluginManager().createFromTemplate(request),
);
ipcMain.handle("shockless:read-plugin-entry-source", (_event, pluginId: string) =>
  pluginManager().readPluginEntrySource(String(pluginId ?? "")),
);
ipcMain.handle("shockless:uninstall-plugin", (_event, pluginId: string) =>
  pluginManager().uninstallPlugin(String(pluginId ?? "")),
);
ipcMain.handle("shockless:install-plugin-from-folder", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = focusedWindow
    ? await dialog.showOpenDialog(focusedWindow, {
        title: "Install Shockless Plugin Folder",
        properties: ["openDirectory"],
      })
    : await dialog.showOpenDialog({
        title: "Install Shockless Plugin Folder",
        properties: ["openDirectory"],
      });
  if (result.canceled || !result.filePaths[0]) return { ok: false, message: "Plugin install cancelled.", state: pluginManager().state() };
  return pluginManager().installFromFolder(result.filePaths[0]);
});

ipcMain.handle("shockless:get-client-library-state", () => library().state());
ipcMain.handle("shockless:get-client-sessions", () => sessionManager().sessions());
ipcMain.handle("shockless:get-client-snapshot", (_event, clientId?: number) => sessionManager().clientSnapshot(normalizedClientId(clientId) ?? undefined));
ipcMain.handle("shockless:get-client-snapshots", () => sessionManager().clientSnapshots());
ipcMain.handle("shockless:select-client-session", (_event, clientId: number) => sessionManager().selectClient(Number(clientId)));
ipcMain.handle("shockless:rename-client-session", (_event, clientId: number, label: string) =>
  sessionManager().renameClient(Number(clientId), String(label ?? "")),
);
ipcMain.handle("shockless:run-console-command", (_event, input: string) => sessionManager().runConsoleCommand(String(input ?? "")));
ipcMain.handle("shockless:run-console-binding", (_event, key: string) => sessionManager().runConsoleBinding(String(key ?? "")));
ipcMain.handle("shockless:get-console-command-state", () => sessionManager().consoleCommandState());
ipcMain.handle("shockless:get-mimic-state", () => sessionManager().mimicStateSnapshot());

ipcMain.handle("shockless:import-client-reference", async (event) => {
  // Set jobId before the async dialog so a second IPC call cannot start
  // a concurrent import while the first dialog is still open.
  if (activeImportJobId) return library().state("An import/build job is already running. Watch the GameHost importer progress.");
  const jobId = `profile-import-${Date.now().toString(36)}`;
  activeImportJobId = jobId;
  const dialogOptions: Electron.OpenDialogOptions = {
    title: "Import Compiled Client Or Shockless Profile",
    properties: ["openDirectory"],
  };
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = focusedWindow
    ? await dialog.showOpenDialog(focusedWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths[0]) {
    activeImportJobId = null;
    return library().state("Import cancelled.");
  }
  const sourcePath = result.filePaths[0];
  sendProfileImportProgress(event.sender, {
    jobId,
    sourceName: path.basename(sourcePath),
    stage: "validate",
    state: "running",
    message: "Preparing importer",
    detail: "Selected folder accepted",
    percent: 1,
    elapsedMs: 0,
    logPath: null,
    updatedAt: new Date().toISOString(),
  });
  try {
    const importedLibrary = await library().importOrRegisterSource(sourcePath, {
      jobId,
      onProgress: (progress) => sendProfileImportProgress(event.sender, progress),
    });
    sendProfileImportProgress(event.sender, {
      jobId,
      sourceName: path.basename(sourcePath),
      stage: "validate-profile",
      state: "running",
      message: "Repairing VERSIONCHECK",
      detail: "Probing the live accepted build before enabling Start",
      percent: 99,
      elapsedMs: undefined,
      logPath: null,
      updatedAt: new Date().toISOString(),
    });
    const repair = await sessionManager().repairSelectedVersionCheckBuild();
    const message = appendVersionCheckRepairMessage(importedLibrary.message, repair);
    const selectedProfile = library().selectedProfile();
    const hasFidelityWarnings = selectedProfile?.fidelityComplete === false;
    const fidelityDetail = hasFidelityWarnings
      ? selectedProfile.fidelityWarningCount > 0
        ? `${selectedProfile.fidelityWarningCount.toLocaleString()} unresolved source extraction warning(s); see profile-validation-report.json`
        : "Source extraction is incomplete; see profile-validation-report.json"
      : null;
    sendProfileImportProgress(event.sender, {
      jobId,
      sourceName: path.basename(sourcePath),
      stage: "validate-profile",
      state: repair.error || hasFidelityWarnings ? "warning" : "done",
      message: hasFidelityWarnings ? "Profile is ready to launch with fidelity warnings" : "Profile is ready to launch",
      detail: [versionCheckRepairDetail(repair), fidelityDetail].filter((value): value is string => Boolean(value)).join("; ") || undefined,
      percent: 100,
      elapsedMs: undefined,
      logPath: null,
      updatedAt: new Date().toISOString(),
    });
    return library().state(message);
  } catch (error) {
    sendProfileImportProgress(event.sender, {
      jobId,
      sourceName: path.basename(sourcePath),
      stage: "validate-profile",
      state: "failed",
      message: "Import failed",
      detail: error instanceof Error ? error.message : String(error),
      percent: 99,
      elapsedMs: undefined,
      logPath: null,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    activeImportJobId = null;
  }
});

ipcMain.handle("shockless:set-active-client-profile", async (_event, profileRoot: string) => {
  const selected = library().setSelectedProfile(profileRoot);
  const repair = await sessionManager().repairSelectedVersionCheckBuild();
  return library().state(appendVersionCheckRepairMessage(selected.message, repair));
});

ipcMain.handle("shockless:get-engine-launch-state", () => sessionManager().engineStatus());
ipcMain.handle("shockless:set-engine-launch-settings", (_event, patch: EngineLaunchSettingsPatch) => {
  const profile = library().selectedProfile();
  const profileId = profile?.id ?? null;
  const current = readShocklessSettings(appDataPath());
  const settingSameProfile = Boolean(profileId && current.activeProfileId === profileId);
  const versionCheckBuild =
    profileId && (patch?.versionCheckBuild === null || (Number.isInteger(patch?.versionCheckBuild) && Number(patch.versionCheckBuild) > 0))
      ? patch.versionCheckBuild
      : profileId && !settingSameProfile
        ? profile?.versionCheckBuild ?? null
        : undefined;
  writeShocklessSettings(appDataPath(), {
    activeProfileId: profileId,
    realm: patch?.realm,
    resizablePresentation: typeof patch?.resizablePresentation === "boolean" ? patch.resizablePresentation : undefined,
    customHotelView: typeof patch?.customHotelView === "boolean" ? patch.customHotelView : undefined,
    entryView: typeof patch?.entryView === "string" ? patch.entryView : patch?.entryView === null ? null : undefined,
    versionCheckBuild,
  });
  return sessionManager().engineStatus();
});
ipcMain.handle("shockless:start-embedded-engine", () => sessionManager().startSelected());
ipcMain.handle("shockless:stop-embedded-engine", () => sessionManager().stopSelected());
ipcMain.handle("shockless:submit-visible-client-login", (_event, clientId: number, webContentsId: number) => {
  const contents = webContents.fromId(Number(webContentsId));
  if (!contents) return { ok: false, message: `Visible webview ${webContentsId} is not available.` };
  return sessionManager().submitVisibleClientLogin(Number(clientId), contents);
});
ipcMain.handle("shockless:get-relay-log-snapshot", () => readRelayLogSnapshot(appDataPath(), relayLogClients()));
ipcMain.handle("shockless:get-relay-log-delta-snapshot", (_event, currentLogPath: string | null, afterLineNumber: number) =>
  readRelayLogDeltaSnapshot(appDataPath(), typeof currentLogPath === "string" ? currentLogPath : null, Number(afterLineNumber), relayLogClients()),
);
ipcMain.handle(
  "shockless:get-relay-log-history-page",
  (_event, clientId: number, beforeSourceLineNumber?: number | null, limit?: number) =>
    readRelayLogHistoryPage(
      appDataPath(),
      Number(clientId),
      beforeSourceLineNumber === null || beforeSourceLineNumber === undefined ? null : Number(beforeSourceLineNumber),
      Number(limit),
      relayLogClients(),
    ),
);
ipcMain.handle("shockless:get-furni-metadata-snapshot", () => {
  const realm = readShocklessSettings(appDataPath()).realm;
  return readFurniMetadataSnapshot(appDataPath(), realm);
});
ipcMain.handle("shockless:lookup-origins-user", (_event, name: string) => {
  const realm = readShocklessSettings(appDataPath()).realm;
  return lookupOriginsUser(String(name ?? ""), realm);
});
ipcMain.handle("shockless:send-room-relay-action", (_event, action: RoomRelayAction, clientId?: number) =>
  sendRoomRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-fishing-relay-action", (_event, action: FishingRelayAction, clientId?: number) =>
  sendFishingRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-gardening-relay-action", (_event, action: GardeningRelayAction, clientId?: number) =>
  sendGardeningRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-user-relay-action", (_event, action: UserRelayAction, clientId?: number) =>
  sendUserRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-social-relay-action", (_event, action: SocialRelayAction, clientId?: number) =>
  sendSocialRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-wall-mover-relay-action", (_event, action: WallMoverRelayAction, clientId?: number) =>
  sendWallMoverRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-furni-relay-action", (_event, action: FurniRelayAction, clientId?: number) =>
  sendFurniRelayAction(action, clientId),
);
ipcMain.handle("shockless:send-plugin-packet", (_event, packet: PluginPacketInput, clientId?: number) => sendPluginPacket(packet, clientId));

app.whenReady().then(() => {
  startHeartbeatMonitor();
  createWindow();
});
app.whenReady().then(() => {
  void runAutomationIfRequested();
});

app.on("window-all-closed", () => {
  isQuitting = true;
  disposeAppResources();
  if (process.platform !== "darwin") {
    scheduleForcedExit();
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  disposeAppResources();
  scheduleForcedExit();
});

app.on("will-quit", () => {
  disposeAppResources();
  scheduleForcedExit();
});

app.on("quit", () => {
  clearForcedExitTimer();
  stopHeartbeatMonitor();
});

app.on("child-process-gone", (_event, details) => {
  reliabilityDiagnostics().record("gpu-process", "child-process-gone", details.reason === "clean-exit" ? "info" : "error", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name ?? "",
    serviceName: details.serviceName ?? "",
  });
  if (!isQuitting && details.type === "GPU" && details.reason !== "clean-exit") {
    requestMainWindowRecovery(`gpu-process-${details.reason}`, 1_500);
  }
});

app.on("activate", () => {
  if (!isQuitting && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function disposeAppResources(): void {
  stopActiveProfileImports();
  multiSessionManager?.dispose();
  stopActiveEmbeddedRelays();
  multiSessionManager = null;
}

function attachMainWindowReliability(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.on("did-finish-load", () => {
    reliabilityDiagnostics().record("main-renderer", "did-finish-load", "info", { url: contents.getURL() });
    clearMainUnresponsiveTimer();
    if (reliabilityDiagnostics().state().recovery.inProgress) {
      reliabilityDiagnostics().finishRecovery("recovered", { url: contents.getURL() });
    }
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    reliabilityDiagnostics().record("main-renderer", "did-fail-load", "error", {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
    if (!isQuitting && isMainFrame && errorCode !== -3) requestMainWindowRecovery(`main-load-${errorCode}`, 500);
  });
  contents.on("render-process-gone", (_event, details) => {
    reliabilityDiagnostics().record("main-renderer", "render-process-gone", details.reason === "clean-exit" ? "info" : "error", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: contents.getURL(),
    });
    if (!isQuitting && details.reason !== "clean-exit") requestMainWindowRecovery(`main-renderer-${details.reason}`, 500);
  });
  contents.on("unresponsive", () => {
    reliabilityDiagnostics().record("main-renderer", "unresponsive", "warning", { url: contents.getURL() });
    clearMainUnresponsiveTimer();
    mainUnresponsiveTimer = setTimeout(() => {
      mainUnresponsiveTimer = null;
      if (!isQuitting) requestMainWindowRecovery("main-renderer-unresponsive", 0);
    }, 10_000);
    mainUnresponsiveTimer.unref?.();
  });
  contents.on("responsive", () => {
    reliabilityDiagnostics().record("main-renderer", "responsive", "info", { url: contents.getURL() });
    clearMainUnresponsiveTimer();
  });
  contents.on("destroyed", clearMainUnresponsiveTimer);
}

function requestMainWindowRecovery(reason: string, delayMs: number): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || isQuitting) return;
  if (!reliabilityDiagnostics().beginRecovery(reason)) {
    reliabilityDiagnostics().record("application", "recovery-suppressed", "warning", { reason, cooldownMs: 60_000 });
    return;
  }
  const timer = setTimeout(() => {
    if (window.isDestroyed() || isQuitting) {
      reliabilityDiagnostics().finishRecovery("failed", { reason: "window-destroyed-or-quitting" });
      return;
    }
    void window.loadURL(rendererUrl()).catch((error) => {
      reliabilityDiagnostics().finishRecovery("failed", { error: errorMessage(error) });
    });
  }, Math.max(0, delayMs));
  timer.unref?.();
}

function startHeartbeatMonitor(): void {
  if (heartbeatMonitorTimer) return;
  heartbeatMonitorTimer = setInterval(() => {
    if (isQuitting || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
    const ageMs = reliabilityDiagnostics().rendererHeartbeatAgeMs();
    if (ageMs !== null && ageMs > 45_000) {
      reliabilityDiagnostics().record("main-renderer", "heartbeat-stale", "error", { ageMs });
      requestMainWindowRecovery("main-renderer-heartbeat-stale", 0);
    }
  }, 10_000);
  heartbeatMonitorTimer.unref?.();
}

function stopHeartbeatMonitor(): void {
  if (!heartbeatMonitorTimer) return;
  clearInterval(heartbeatMonitorTimer);
  heartbeatMonitorTimer = null;
}

function clearMainUnresponsiveTimer(): void {
  if (!mainUnresponsiveTimer) return;
  clearTimeout(mainUnresponsiveTimer);
  mainUnresponsiveTimer = null;
}

function scheduleForcedExit(): void {
  if (forcedExitTimer) return;
  forcedExitTimer = setTimeout(() => {
    disposeAppResources();
    app.exit(0);
  }, 2500);
  forcedExitTimer.unref?.();
}

function clearForcedExitTimer(): void {
  if (!forcedExitTimer) return;
  clearTimeout(forcedExitTimer);
  forcedExitTimer = null;
}

function library(): ClientLibraryStore {
  clientLibrary ??= new ClientLibraryStore(appDataPath());
  return clientLibrary;
}

function sessionManager(): MultiSessionManager {
  multiSessionManager ??= new MultiSessionManager({
    appDataPath: appDataPath(),
    library: library(),
    hardwareAccelerationActive: launchHardwareAccelerationEnabled,
    relayPolicyProvider: () => pluginManager().relayPolicy(),
  });
  return multiSessionManager;
}

function pluginManager(): PluginManager {
  pluginManagerInstance ??= new PluginManager(appDataPath());
  return pluginManagerInstance;
}

function updateManager(): UpdateManager {
  updateManagerInstance ??= new UpdateManager({
    appDataPath: appDataPath(),
    currentVersion: appVersion(),
    installDir: process.env.PORTABLE_EXECUTABLE_DIR?.trim() || path.dirname(app.getPath("exe")),
    executablePath: app.getPath("exe"),
    isPackaged: app.isPackaged,
  });
  return updateManagerInstance;
}

function reliabilityDiagnostics(): ReliabilityDiagnostics {
  reliabilityDiagnosticsInstance ??= new ReliabilityDiagnostics(appDataStorePath(appDataPath(), "logs"));
  return reliabilityDiagnosticsInstance;
}

function relayLogClients(): readonly { readonly id: number; readonly label: string }[] {
  return sessionManager().sessions().sessions.map((session) => ({ id: session.id, label: session.label }));
}

function appDataPath(): string {
  const override = process.env.SHOCKLESS_APP_DATA_PATH?.trim();
  return override || app.getPath("appData");
}

function appVersion(): string {
  for (const packagePath of [path.join(__dirname, "../../../package.json"), path.join(process.cwd(), "package.json")]) {
    if (!existsSync(packagePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { readonly version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Fall back to Electron's packaged app version below.
    }
  }
  return app.getVersion();
}

function sendProfileImportProgress(contents: WebContents, progress: ProfileImportProgress): void {
  if (contents.isDestroyed()) return;
  contents.send("shockless:profile-import-progress", progress);
}

function appendVersionCheckRepairMessage(
  message: string,
  repair: { readonly build: number | null; readonly updated: boolean; readonly tried: readonly number[]; readonly error?: string },
): string {
  const detail = versionCheckRepairDetail(repair);
  return detail ? `${message} ${detail}` : message;
}

function versionCheckRepairDetail(repair: {
  readonly build: number | null;
  readonly updated: boolean;
  readonly tried: readonly number[];
  readonly error?: string;
}): string {
  if (repair.error) {
    const tried = repair.tried.length > 0 ? ` tried ${repair.tried.join(",")}` : "";
    return `VERSIONCHECK repair warning: ${repair.error}${tried}`;
  }
  if (!repair.build) return "VERSIONCHECK auto-detect did not return an accepted build.";
  const tried = repair.tried.length > 0 ? ` after trying ${repair.tried.join(",")}` : "";
  return repair.updated
    ? `VERSIONCHECK accepted build ${repair.build} saved${tried}.`
    : `VERSIONCHECK accepted build ${repair.build} already active${tried}.`;
}

function sendScopedRelayAction(
  scope: string,
  label: string,
  action: Record<string, unknown>,
  validator: (action: Record<string, unknown>) => boolean,
  clientId?: number,
): Promise<GardeningRelayResult> {
  if (!(action && typeof action === "object" && validator(action))) {
    return Promise.resolve({ ok: false, message: `Invalid ${label} relay action.` });
  }
  return sendRelayControl({ scope, ...action }, clientId);
}

function sendGardeningRelayAction(action: GardeningRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("gardening", "Gardening", action as Record<string, unknown>, isAllowedGardeningRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendRoomRelayAction(action: RoomRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("room", "Room", action as Record<string, unknown>, isAllowedRoomRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendFishingRelayAction(action: FishingRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("fishing", "Fishing", action as Record<string, unknown>, isAllowedFishingRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendUserRelayAction(action: UserRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("user", "User", action as Record<string, unknown>, isAllowedUserRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendSocialRelayAction(action: SocialRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("social", "Social", action as Record<string, unknown>, isAllowedSocialRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendWallMoverRelayAction(action: WallMoverRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("wallMover", "Wall Mover", action as Record<string, unknown>, isAllowedWallMoverRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendFurniRelayAction(action: FurniRelayAction, clientId?: number): Promise<GardeningRelayResult> {
  return sendScopedRelayAction("furni", "Furni", action as Record<string, unknown>, isAllowedFurniRelayAction as (a: Record<string, unknown>) => boolean, clientId);
}

function sendPluginPacket(packet: PluginPacketInput, clientId?: number): Promise<GardeningRelayResult> {
  const payload = pluginPacketRelayControlPayload(packet);
  if (!payload.ok) return Promise.resolve({ ok: false, message: payload.message });
  return sendRelayControl(payload.payload, clientId);
}

function sendRelayControl(action: Record<string, unknown>, clientId?: number): Promise<GardeningRelayResult> {
  const resolvedClientId = normalizedClientId(clientId) ?? sessionManager().sessions().selectedClientId;
  const controlPort = sessionManager().relayControlPortForClient(resolvedClientId);
  if (!controlPort) {
    return Promise.resolve({ ok: false, message: `Client ${resolvedClientId} relay control is not running.` });
  }
  return new Promise((resolveAction) => {
    const socket = net.connect({ host: RELAY_CONTROL_HOST, port: controlPort });
    let buffer = "";
    const finish = (result: GardeningRelayResult): void => {
      socket.destroy();
      resolveAction(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(action)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as GardeningRelayResult;
        finish({ ok: Boolean(parsed.ok), message: String(parsed.message ?? ""), sessionId: parsed.sessionId });
      } catch {
        finish({ ok: false, message: "Relay control returned invalid JSON." });
      }
    });
    socket.on("timeout", () => finish({ ok: false, message: "Relay control timed out." }));
    socket.on("error", (error: Error) => finish({ ok: false, message: `Client ${resolvedClientId} relay control unavailable: ${error.message}` }));
  });
}

function normalizedClientId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function runAutomationIfRequested(): Promise<void> {
  const automationPath = process.env.SHOCKLESS_AUTOMATION_FILE?.trim();
  if (!automationPath) return;
  const result = await runAutomationFile(automationPath).catch((error) => ({
    ok: false,
    message: errorMessage(error),
    commands: [],
    sessions: null,
    snapshots: null,
    relay: null,
    screenshots: null,
  }));
  const reportPath = process.env.SHOCKLESS_AUTOMATION_REPORT?.trim() || automationReportPath();
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`[shockless automation] report ${reportPath}`);
  disposeAppResources();
  app.exit(result.ok ? 0 : 1);
}

async function runAutomationFile(filePath: string): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly commands: readonly unknown[];
  readonly sessions: unknown;
  readonly snapshots: unknown;
  readonly relay: unknown;
  readonly screenshots: unknown;
}> {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    readonly commands?: readonly string[];
    readonly waitMs?: number;
    readonly relaySnapshot?: boolean;
  };
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  const commandResults = [];
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const result = await sessionManager().runConsoleCommand(String(command));
    commandResults.push({
      command: maskAutomationCommand(command),
      startedAt,
      ok: result.ok,
      handled: result.handled,
      level: result.level,
      lines: result.lines.map(maskAutomationText),
      targetClientIds: result.targetClientIds ?? [],
    });
  }
  const waitMs = Number.isFinite(parsed.waitMs) ? Math.max(0, Math.min(120000, Number(parsed.waitMs))) : 0;
  if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  const sessions = sessionManager().sessions();
  const snapshots = await sessionManager().clientSnapshots();
  const relay = parsed.relaySnapshot ? compactRelaySnapshot(readRelayLogSnapshot(appDataPath(), relayLogClients())) : null;
  const screenshots = await sessionManager().captureAutomationScreenshots("real-session-proof");
  const ok = commandResults.every((entry) => entry.ok);
  return {
    ok,
    message: ok ? "Automation commands completed." : "One or more automation commands failed.",
    commands: commandResults,
    sessions,
    snapshots,
    relay,
    screenshots,
  };
}

function automationReportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(process.cwd(), "logs", "automation", `automation-${stamp}.json`);
}

function maskAutomationCommand(command: string): string {
  return String(command).replace(/(login\s+)\S+:\S+/i, "$1[credentials]");
}

function maskAutomationText(text: string): string {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(password|token|webhook|secret)=\S+/gi, "$1=[redacted]");
}

function compactRelaySnapshot(snapshot: ReturnType<typeof readRelayLogSnapshot>): unknown {
  const recentEntries = snapshot.entries.slice(-80).map((entry) => ({
    lineNumber: entry.lineNumber,
    clientId: entry.clientId,
    clientLabel: entry.clientLabel,
    sessionId: entry.sessionId,
    direction: entry.direction,
    header: entry.header,
    packetName: entry.packetName,
    payloadBytes: entry.payloadBytes,
    bodyStatus: entry.bodyStatus,
    decodedFields: entry.decodedFields.slice(0, 24),
  }));
  return {
    logPath: snapshot.logPath,
    exists: snapshot.exists,
    fileSize: snapshot.fileSize,
    updatedAt: snapshot.updatedAt,
    totalLines: snapshot.totalLines,
    packetCount: snapshot.packetCount,
    clientCount: snapshot.clientCount,
    serverCount: snapshot.serverCount,
    message: snapshot.message,
    recentEntries,
  };
}
