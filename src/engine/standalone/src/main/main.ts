import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, type OpenDialogOptions } from "electron";
import type {
  CredentialsInput,
  ImportProfileRequest,
  LauncherState,
  RuntimeProfile,
  UpdateLauncherSettingsRequest,
} from "../common/types.js";
import { appCacheRoot, engineRootForRuntime, portableClientsRoot, standaloneRoot } from "./profilePaths.js";
import { SettingsStore } from "./settingsStore.js";
import { CredentialStore } from "./credentials.js";
import { ProfileStore } from "./profileStore.js";
import { ProfileImporter, validateRuntimeReadiness } from "./profileImporter.js";
import { StandaloneStaticServer } from "./staticServer.js";
import { OriginsRelayController } from "./relay.js";
import { detectEngineExecutableScriptVersions } from "./originsRuntimeAdapter.js";
import { detectAcceptedVersionCheckBuild } from "./versionCheckBuild.js";

app.setName("ShocklessEngine");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let launcherWindow: BrowserWindow | null = null;
let gameWindow: BrowserWindow | null = null;
let staticServer: StandaloneStaticServer | null = null;
const relay = new OriginsRelayController(cacheRoot);

function cacheRoot(): string {
  return appCacheRoot(app.getPath("appData"));
}

function standaloneDataRoot(): string {
  return app.isPackaged ? dirname(app.getPath("exe")) : standaloneRoot();
}

function clientsRoot(): string {
  return portableClientsRoot(standaloneDataRoot());
}

function legacyProfilesRoot(): string {
  return join(cacheRoot(), "profiles");
}

function settingsStore(): SettingsStore {
  return new SettingsStore(cacheRoot());
}

function profileStore(): ProfileStore {
  return new ProfileStore(cacheRoot(), {
    profilesRoot: clientsRoot(),
    legacyProfilesRoot: legacyProfilesRoot(),
  });
}

function credentialStore(): CredentialStore {
  return new CredentialStore(cacheRoot());
}

function launcherState(options: { readonly refreshRuntime?: boolean } = {}): LauncherState {
  const store = profileStore();
  const profiles = store.list();
  return {
    cacheRoot: cacheRoot(),
    clientsRoot: clientsRoot(),
    profiles: options.refreshRuntime ? profiles.map((profile) => refreshProfileRuntime(store, profile)) : profiles,
    settings: settingsStore().read(),
    credentialsSaved: credentialStore().hasCredentials(),
  };
}

function refreshProfileRuntime(
  store: ProfileStore,
  profile: RuntimeProfile,
  options: { readonly fullValidation?: boolean } = {},
): RuntimeProfile {
  const profileRoot = store.profileRoot(profile.id) ?? profile.profileRoot ?? join(store.profilesRoot, profile.id);
  const runtime = validateRuntimeReadiness(
    join(profileRoot, profile.paths.runtimeData),
    profile.versionId,
    join(profileRoot, profile.paths.assets),
    join(profileRoot, profile.paths.extracted),
    {
      storedRuntime: profile.runtime,
      runtimeDataSchemaVersion: profile.runtimeDataSchemaVersion,
      executableScriptVersions: detectEngineExecutableScriptVersions(engineRootForRuntime()),
      skipProfileValidation: options.fullValidation !== true,
      validateAssetContents: options.fullValidation === true,
    },
  );
  if (JSON.stringify(runtime) === JSON.stringify(profile.runtime)) return profile;
  const updated = { ...profile, runtime };
  store.write(profileRoot, updated);
  return updated;
}

async function createLauncherWindow(): Promise<void> {
  launcherWindow = new BrowserWindow({
    width: 723,
    height: 449,
    minWidth: 723,
    minHeight: 449,
    maxWidth: 723,
    maxHeight: 449,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    show: !standaloneHeadlessEnabled(),
    title: "Shockless Engine",
    webPreferences: {
      preload: join(import.meta.dirname, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  launcherWindow.on("closed", () => {
    launcherWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    await launcherWindow.loadURL(devUrl);
  } else {
    await launcherWindow.loadFile(join(import.meta.dirname, "..", "..", "renderer", "index.html"));
  }
}

ipcMain.handle("launcher:get-state", () => launcherState({ refreshRuntime: true }));

ipcMain.handle("launcher:select-folder", async () => {
  const options: OpenDialogOptions = {
    title: "Select compiled Habbo Origins folder",
    properties: ["openDirectory"],
  };
  const result = launcherWindow
    ? await dialog.showOpenDialog(launcherWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("launcher:import-profile", async (_event, request: ImportProfileRequest) => {
  const importer = new ProfileImporter({
    cacheRoot: cacheRoot(),
    profilesRoot: clientsRoot(),
    legacyProfilesRoot: legacyProfilesRoot(),
    engineRoot: engineRootForRuntime(),
  });
  const profile = await importer.importProfile(request, (progress) => {
    launcherWindow?.webContents.send("launcher:import-progress", progress);
  });
  const settings = settingsStore().read();
  if (!settings.activeProfileId || profile.runtime.ready) {
    settingsStore().update({
      activeProfileId: profile.id,
      fixedStage: request.fixedStage,
      resizablePresentation: request.resizablePresentation,
      customHotelView: request.customHotelView,
      versionCheckBuild: request.versionCheckBuild ?? null,
    });
  }
  return launcherState();
});

ipcMain.handle("launcher:update-settings", (_event, request: UpdateLauncherSettingsRequest) => {
  settingsStore().update({
    fixedStage: request.fixedStage,
    resizablePresentation: request.resizablePresentation,
    customHotelView: request.customHotelView,
    versionCheckBuild: request.versionCheckBuild,
  });
  return launcherState();
});

ipcMain.handle("launcher:set-active-profile", (_event, profileId: string) => {
  if (!profileStore().read(profileId)) throw new Error(`Unknown profile: ${profileId}`);
  settingsStore().update({ activeProfileId: profileId });
  return launcherState();
});

ipcMain.handle("launcher:save-credentials", (_event, credentials: CredentialsInput | null) => {
  if (!credentials) {
    credentialStore().clear();
    settingsStore().update({ rememberCredentials: false });
  } else {
    credentialStore().save(credentials);
    settingsStore().update({ rememberCredentials: true });
  }
  return launcherState();
});

ipcMain.handle("launcher:clear-credentials", () => {
  credentialStore().clear();
  settingsStore().update({ rememberCredentials: false });
  return launcherState();
});

ipcMain.handle("launcher:clear-cache", () => {
  closeGameRuntime();
  const root = cacheRoot();
  assertSafeCacheRoot(root, app.getPath("appData"));
  const portableRoot = clientsRoot();
  assertSafeClientsRoot(portableRoot);
  rmSync(root, { recursive: true, force: true });
  rmSync(portableRoot, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(portableRoot, { recursive: true });
  return launcherState();
});

ipcMain.handle("launcher:play-profile", async (_event, profileId: string) => {
  const store = profileStore();
  const rawProfile = store.read(profileId);
  const profile = rawProfile ? refreshProfileRuntime(store, rawProfile) : null;
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  if (!profile.runtime.ready) throw new Error(profile.runtime.reason ?? "Profile is not ready to launch");
  await playProfile(profile);
  settingsStore().update({ activeProfileId: profile.id });
  return launcherState();
});

async function playProfile(profile: RuntimeProfile): Promise<void> {
  await relay.start();
  staticServer ??= new StandaloneStaticServer(cacheRoot(), {
    engineRoot: engineRootForRuntime(),
    profilesRoot: clientsRoot(),
  });
  const url = await staticServer.start(profile);
  const forceResizable = process.env.ORIGINS_STANDALONE_FORCE_RESIZABLE === "1";
  const settings = settingsStore().read();
  const versionCheckBuild = await launchVersionCheckBuild(profile, settings.versionCheckBuild);
  const params = new URLSearchParams({
    profile: profile.id,
    profileVersion: profile.versionId,
    standalone: "1",
    versionCheckBuild: String(versionCheckBuild),
    machineId: "director-habbo-runtime",
  });
  if (forceResizable || settings.resizablePresentation) {
    params.set("resizablePresentation", "1");
  }
  if (settings.customHotelView) {
    params.set("customHotelView", "1");
  }
  if (standaloneTraceEnabled()) {
    params.set("tracePackets", "1");
    params.set("capture", "1");
  }
  const traceHandlers = process.env.ORIGINS_STANDALONE_TRACE_HANDLERS?.trim();
  if (traceHandlers) {
    params.set("trace", traceHandlers);
  }
  applyStandaloneExtraLaunchParams(params);
  const launchUrl = `${url.split("?")[0]}?${params.toString()}`;
  const fixedStage = !forceResizable && settings.fixedStage !== false && settings.resizablePresentation !== true;
  const resizable = !fixedStage;
  const title = `Shockless Engine - ${profileWindowTitle(profile)}`;

  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.setTitle(title);
    gameWindow.setResizable(resizable);
    gameWindow.setMinimumSize(resizable ? 960 : 1, resizable ? 540 : 1);
    gameWindow.setContentSize(960, 540);
    await gameWindow.loadURL(launchUrl);
    if (!standaloneHeadlessEnabled()) gameWindow.show();
  } else {
    gameWindow = new BrowserWindow({
      width: 960,
      height: 540,
      useContentSize: true,
      resizable,
      minWidth: resizable ? 960 : undefined,
      minHeight: resizable ? 540 : undefined,
      show: !standaloneHeadlessEnabled(),
      title,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    gameWindow.on("closed", () => {
      gameWindow = null;
    });
    await gameWindow.loadURL(launchUrl);
  }

  if (settings.rememberCredentials && credentialStore().hasCredentials()) {
    void injectFastLoginWhenReady(gameWindow, credentialStore().read());
  }
}

async function launchVersionCheckBuild(profile: RuntimeProfile, manualOverride: number | null): Promise<number> {
  if (manualOverride !== null) return manualOverride;
  const detected = await detectAcceptedVersionCheckBuild({ preferredBuilds: [profile.versionCheckBuild] });
  const build = detected.build ?? profile.versionCheckBuild;
  if (build !== profile.versionCheckBuild) {
    const store = profileStore();
    const profileRoot = store.profileRoot(profile.id) ?? profile.profileRoot ?? join(store.profilesRoot, profile.id);
    store.write(profileRoot, { ...profile, versionCheckBuild: build });
  }
  return build;
}

function standaloneTraceEnabled(): boolean {
  return process.env.ORIGINS_STANDALONE_TRACE === "1";
}

function standaloneHeadlessEnabled(): boolean {
  return process.env.ORIGINS_STANDALONE_HEADLESS === "1";
}

function applyStandaloneExtraLaunchParams(params: URLSearchParams): void {
  const raw = process.env.ORIGINS_STANDALONE_EXTRA_QUERY?.trim();
  if (!raw) return;
  const extra = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  for (const [key, value] of extra) {
    if (!key) continue;
    params.set(key, value);
  }
}

function profileWindowTitle(profile: RuntimeProfile): string {
  if (profile.buildNumber) return `Origins build ${profile.buildNumber}`;
  const match = /^release(\d+)$/i.exec(profile.versionId);
  return match?.[1] ? `Origins build ${match[1]}` : "Origins profile";
}

async function injectFastLoginWhenReady(window: BrowserWindow | null, credentials: CredentialsInput | null): Promise<void> {
  if (!window || !credentials) return;
  const email = JSON.stringify(credentials.email);
  const password = JSON.stringify(credentials.password);
  const timeoutMs = positiveIntegerEnv("ORIGINS_STANDALONE_FAST_LOGIN_TIMEOUT_MS", 300000);
  const pollMs = positiveIntegerEnv("ORIGINS_STANDALONE_FAST_LOGIN_POLL_MS", 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) return;
    const sent = await window.webContents.executeJavaScript(`
      (async () => {
        const dev = window.__engine?.dev;
        const login = dev?.login;
        if (typeof login !== "function") return false;
        if (typeof dev.editableFields === "function" && dev.editableFields().length < 2) return false;
        try {
          await login(${email}, ${password}, 10);
          return true;
        } catch {
          return false;
        }
      })()
    `).catch(() => false) as boolean;
    if (sent) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await createLauncherWindow();
  if (!existsSync(engineRootForRuntime())) {
    launcherWindow?.webContents.send("launcher:import-progress", {
      stage: "validate",
      state: "warning",
      message: "Engine root was not found beside standalone folder",
      percent: 0,
    });
  }
});

app.on("before-quit", () => {
  closeGameRuntime();
});

app.on("window-all-closed", () => {
  closeGameRuntime();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createLauncherWindow();
  }
});

function closeGameRuntime(): void {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.close();
  }
  gameWindow = null;
  relay.stop();
  staticServer?.stop();
  staticServer = null;
}

function assertSafeCacheRoot(root: string, appDataPath: string): void {
  const resolvedRoot = resolve(root);
  const resolvedAppData = resolve(appDataPath);
  const expected = resolve(appCacheRoot(appDataPath));
  if (resolvedRoot !== expected) {
    throw new Error(`Refusing to clear unexpected cache root: ${resolvedRoot}`);
  }
  if (resolvedRoot === resolvedAppData || !resolvedRoot.startsWith(`${resolvedAppData}\\`)) {
    throw new Error(`Refusing to clear cache outside appData: ${resolvedRoot}`);
  }
}

function assertSafeClientsRoot(root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedBase = resolve(standaloneDataRoot());
  const expected = resolve(portableClientsRoot(resolvedBase));
  if (resolvedRoot !== expected) {
    throw new Error(`Refusing to clear unexpected clients root: ${resolvedRoot}`);
  }
  if (resolvedRoot === resolvedBase || !resolvedRoot.startsWith(`${resolvedBase}\\`)) {
    throw new Error(`Refusing to clear clients outside standalone folder: ${resolvedRoot}`);
  }
}
