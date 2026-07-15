import { contextBridge, ipcRenderer } from "electron";
import type { ShocklessApi } from "../shared/window-api.js";

const api: ShocklessApi = {
  getAppInfo: () => ipcRenderer.invoke("shockless:get-app-info"),
  getReliabilityState: () => ipcRenderer.invoke("shockless:get-reliability-state"),
  reportRendererHeartbeat: (heartbeat) => ipcRenderer.send("shockless:renderer-heartbeat", heartbeat),
  reportRuntimeHealth: (report) => ipcRenderer.send("shockless:runtime-health", report),
  getAppPreferences: () => ipcRenderer.invoke("shockless:get-app-preferences"),
  setAppPreferences: (patch) => ipcRenderer.invoke("shockless:set-app-preferences", patch),
  onShellUiHiddenChanged: (listener) => {
    const channel = "shockless:shell-ui-hidden-changed";
    const wrapped = (_event: Electron.IpcRendererEvent, hidden: unknown) => listener(hidden === true);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  getUpdateState: () => ipcRenderer.invoke("shockless:get-update-state"),
  checkForUpdates: () => ipcRenderer.invoke("shockless:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("shockless:download-update"),
  installDownloadedUpdate: () => ipcRenderer.invoke("shockless:install-downloaded-update"),
  skipUpdate: (version) => ipcRenderer.invoke("shockless:skip-update", version),
  onUpdateState: (listener) => {
    const channel = "shockless:update-state";
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state as Parameters<typeof listener>[0]);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  getPluginRegistryState: () => ipcRenderer.invoke("shockless:get-plugin-registry-state"),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke("shockless:set-plugin-enabled", pluginId, enabled),
  setPluginSurfaceEnabled: (pluginId, surfaceId, enabled) =>
    ipcRenderer.invoke("shockless:set-plugin-surface-enabled", pluginId, surfaceId, enabled),
  reloadPlugins: () => ipcRenderer.invoke("shockless:reload-plugins"),
  openPluginsFolder: () => ipcRenderer.invoke("shockless:open-plugins-folder"),
  createPluginFromTemplate: (request) => ipcRenderer.invoke("shockless:create-plugin-from-template", request),
  installPluginFromFolder: () => ipcRenderer.invoke("shockless:install-plugin-from-folder"),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke("shockless:uninstall-plugin", pluginId),
  readPluginEntrySource: (pluginId) => ipcRenderer.invoke("shockless:read-plugin-entry-source", pluginId),
  getClientLibraryState: () => ipcRenderer.invoke("shockless:get-client-library-state"),
  getClientSessions: () => ipcRenderer.invoke("shockless:get-client-sessions"),
  getClientSnapshot: (clientId) => ipcRenderer.invoke("shockless:get-client-snapshot", clientId),
  getClientSnapshots: () => ipcRenderer.invoke("shockless:get-client-snapshots"),
  selectClientSession: (clientId) => ipcRenderer.invoke("shockless:select-client-session", clientId),
  renameClientSession: (clientId, label) => ipcRenderer.invoke("shockless:rename-client-session", clientId, label),
  runConsoleCommand: (input) => ipcRenderer.invoke("shockless:run-console-command", input),
  runConsoleBinding: (key) => ipcRenderer.invoke("shockless:run-console-binding", key),
  getConsoleCommandState: () => ipcRenderer.invoke("shockless:get-console-command-state"),
  getMimicState: () => ipcRenderer.invoke("shockless:get-mimic-state"),
  importClientReference: () => ipcRenderer.invoke("shockless:import-client-reference"),
  onProfileImportProgress: (listener) => {
    const channel = "shockless:profile-import-progress";
    const wrapped = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress as Parameters<typeof listener>[0]);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onShowAbout: (listener) => {
    const channel = "shockless:show-about";
    const wrapped = () => listener();
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  setActiveClientProfile: (profileRoot) => ipcRenderer.invoke("shockless:set-active-client-profile", profileRoot),
  getEngineLaunchState: () => ipcRenderer.invoke("shockless:get-engine-launch-state"),
  setEngineLaunchSettings: (patch) => ipcRenderer.invoke("shockless:set-engine-launch-settings", patch),
  startEmbeddedEngine: () => ipcRenderer.invoke("shockless:start-embedded-engine"),
  stopEmbeddedEngine: () => ipcRenderer.invoke("shockless:stop-embedded-engine"),
  submitVisibleClientLogin: (clientId, webContentsId) => ipcRenderer.invoke("shockless:submit-visible-client-login", clientId, webContentsId),
  getRelayLogSnapshot: () => ipcRenderer.invoke("shockless:get-relay-log-snapshot"),
  getRelayLogDeltaSnapshot: (currentLogPath, afterLineNumber) =>
    ipcRenderer.invoke("shockless:get-relay-log-delta-snapshot", currentLogPath, afterLineNumber),
  getRelayLogHistoryPage: (clientId, beforeSourceLineNumber, limit) =>
    ipcRenderer.invoke("shockless:get-relay-log-history-page", clientId, beforeSourceLineNumber, limit),
  getFurniMetadataSnapshot: () => ipcRenderer.invoke("shockless:get-furni-metadata-snapshot"),
  lookupOriginsUser: (name) => ipcRenderer.invoke("shockless:lookup-origins-user", name),
  sendRoomRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-room-relay-action", action, clientId),
  sendFishingRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-fishing-relay-action", action, clientId),
  sendGardeningRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-gardening-relay-action", action, clientId),
  sendUserRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-user-relay-action", action, clientId),
  sendSocialRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-social-relay-action", action, clientId),
  sendWallMoverRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-wall-mover-relay-action", action, clientId),
  sendFurniRelayAction: (action, clientId) => ipcRenderer.invoke("shockless:send-furni-relay-action", action, clientId),
  sendPluginPacket: (packet, clientId) => ipcRenderer.invoke("shockless:send-plugin-packet", packet, clientId),
};

contextBridge.exposeInMainWorld("shockless", api);
