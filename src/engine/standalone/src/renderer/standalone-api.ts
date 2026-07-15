import type {
  CredentialsInput,
  ImportProgress,
  ImportProfileRequest,
  LauncherState,
  UpdateLauncherSettingsRequest,
} from "../common/types";

export interface StandaloneApi {
  getState(): Promise<LauncherState>;
  selectFolder(): Promise<string | null>;
  importProfile(request: ImportProfileRequest): Promise<LauncherState>;
  updateSettings(request: UpdateLauncherSettingsRequest): Promise<LauncherState>;
  setActiveProfile(profileId: string): Promise<LauncherState>;
  playProfile(profileId: string): Promise<LauncherState>;
  clearCache(): Promise<LauncherState>;
  saveCredentials(credentials: CredentialsInput | null): Promise<LauncherState>;
  clearCredentials(): Promise<LauncherState>;
  onImportProgress(listener: (progress: ImportProgress) => void): () => void;
}

declare global {
  interface Window {
    standalone?: StandaloneApi;
  }
}
