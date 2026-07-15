import type {
  CredentialsInput,
  ImportProgress,
  ImportProfileRequest,
  LauncherState,
  UpdateLauncherSettingsRequest,
} from "./common/types.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("standalone", {
  getState: () => ipcRenderer.invoke("launcher:get-state") as Promise<LauncherState>,
  selectFolder: () => ipcRenderer.invoke("launcher:select-folder") as Promise<string | null>,
  importProfile: (request: ImportProfileRequest) =>
    ipcRenderer.invoke("launcher:import-profile", request) as Promise<LauncherState>,
  updateSettings: (request: UpdateLauncherSettingsRequest) =>
    ipcRenderer.invoke("launcher:update-settings", request) as Promise<LauncherState>,
  setActiveProfile: (profileId: string) =>
    ipcRenderer.invoke("launcher:set-active-profile", profileId) as Promise<LauncherState>,
  playProfile: (profileId: string) => ipcRenderer.invoke("launcher:play-profile", profileId) as Promise<LauncherState>,
  clearCache: () => ipcRenderer.invoke("launcher:clear-cache") as Promise<LauncherState>,
  saveCredentials: (credentials: CredentialsInput | null) =>
    ipcRenderer.invoke("launcher:save-credentials", credentials) as Promise<LauncherState>,
  clearCredentials: () => ipcRenderer.invoke("launcher:clear-credentials") as Promise<LauncherState>,
  onImportProgress: (listener: (progress: ImportProgress) => void) => {
    const wrapped = (_event: unknown, progress: ImportProgress) => listener(progress);
    ipcRenderer.on("launcher:import-progress", wrapped);
    return () => ipcRenderer.removeListener("launcher:import-progress", wrapped);
  },
});
