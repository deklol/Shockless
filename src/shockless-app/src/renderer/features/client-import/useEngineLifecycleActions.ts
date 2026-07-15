import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  ClientLibraryState,
  EngineLaunchSettingsPatch,
  EngineLaunchState,
} from "../../../shared/window-api";
import { originsRealmDefinition, type OriginsRealmId } from "../../../shared/originsRealm";
import {
  pendingProfileImportUiState,
  profileImportUiFinished,
  type ProfileImportUiState,
} from "./model";

type AppendTimeline = (severity: "info" | "success" | "warning" | "error", message: string) => void;

interface UseEngineLifecycleActionsOptions {
  readonly appendTimeline: AppendTimeline;
  readonly applyEngineLaunch: (launch: EngineLaunchState) => void;
  readonly refreshClientSessions: () => Promise<unknown>;
  readonly versionCheckDraft: string;
  readonly setLibraryState: Dispatch<SetStateAction<ClientLibraryState | null>>;
  readonly setBridgeMessage: Dispatch<SetStateAction<string>>;
  readonly setProfileImportUi: Dispatch<SetStateAction<ProfileImportUiState>>;
  readonly setEngineBusy: Dispatch<SetStateAction<boolean>>;
}

/** Client import, profile selection, engine launch, and launch-setting IPC actions. */
export function useEngineLifecycleActions(options: UseEngineLifecycleActionsOptions) {
  const importClientReference = useCallback(async () => {
    if (!window.shockless) return;
    options.setProfileImportUi(pendingProfileImportUiState());
    options.setEngineBusy(true);
    try {
      const nextLibrary = await window.shockless.importClientReference();
      options.setLibraryState(nextLibrary);
      options.setBridgeMessage(nextLibrary.message);
      options.applyEngineLaunch(await window.shockless.getEngineLaunchState());
      await options.refreshClientSessions();
      options.setProfileImportUi((current) => profileImportUiFinished(current, nextLibrary.message, false));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import/build failed.";
      options.setBridgeMessage(message);
      options.setProfileImportUi((current) => profileImportUiFinished(current, message, true));
    } finally {
      options.setEngineBusy(false);
    }
  }, [
    options.applyEngineLaunch,
    options.refreshClientSessions,
    options.setBridgeMessage,
    options.setEngineBusy,
    options.setLibraryState,
    options.setProfileImportUi,
  ]);

  const selectClientProfile = useCallback(
    async (profileRoot: string) => {
      if (!window.shockless) return;
      const nextLibrary = await window.shockless.setActiveClientProfile(profileRoot);
      options.setLibraryState(nextLibrary);
      options.setBridgeMessage(nextLibrary.message);
      options.applyEngineLaunch(await window.shockless.getEngineLaunchState());
      await options.refreshClientSessions();
    },
    [
      options.applyEngineLaunch,
      options.refreshClientSessions,
      options.setBridgeMessage,
      options.setLibraryState,
    ],
  );

  const startEngine = useCallback(async () => {
    if (!window.shockless) {
      options.setBridgeMessage("Run npm run electron:dev to use embedded Shockless.");
      return;
    }
    options.setEngineBusy(true);
    try {
      options.applyEngineLaunch(await window.shockless.startEmbeddedEngine());
      await options.refreshClientSessions();
    } finally {
      options.setEngineBusy(false);
    }
  }, [options.applyEngineLaunch, options.refreshClientSessions, options.setBridgeMessage, options.setEngineBusy]);

  const stopEngine = useCallback(async () => {
    if (!window.shockless) return;
    options.setEngineBusy(true);
    try {
      options.applyEngineLaunch(await window.shockless.stopEmbeddedEngine());
      await options.refreshClientSessions();
    } finally {
      options.setEngineBusy(false);
    }
  }, [options.applyEngineLaunch, options.refreshClientSessions, options.setEngineBusy]);

  const updateEngineLaunchSettings = useCallback(
    async (patch: EngineLaunchSettingsPatch, message = "Launch settings updated.") => {
      if (!window.shockless?.setEngineLaunchSettings) return;
      options.setEngineBusy(true);
      try {
        const launch = await window.shockless.setEngineLaunchSettings(patch);
        options.applyEngineLaunch(launch);
        await options.refreshClientSessions();
        options.setBridgeMessage(message);
        options.appendTimeline("success", message);
      } finally {
        options.setEngineBusy(false);
      }
    },
    [
      options.appendTimeline,
      options.applyEngineLaunch,
      options.refreshClientSessions,
      options.setBridgeMessage,
      options.setEngineBusy,
    ],
  );

  const applyVersionCheckBuild = useCallback(() => {
    const trimmed = options.versionCheckDraft.trim();
    if (!trimmed) {
      void updateEngineLaunchSettings(
        { versionCheckBuild: null },
        "Version check override cleared; profile/default value will be used.",
      );
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
      options.setBridgeMessage("Version check build must be a positive integer, or blank for auto/profile default.");
      options.appendTimeline("warning", "Invalid version check build override.");
      return;
    }
    void updateEngineLaunchSettings({ versionCheckBuild: parsed }, `Version check override set to ${parsed}.`);
  }, [options.appendTimeline, options.setBridgeMessage, options.versionCheckDraft, updateEngineLaunchSettings]);

  const setHotelView = useCallback(
    (value: string) => {
      const normalized = value.trim() || "custom";
      if (normalized === "custom") {
        void updateEngineLaunchSettings({ customHotelView: true, entryView: null }, "Hotel view set to Shockless Custom.");
        return;
      }
      void updateEngineLaunchSettings(
        { customHotelView: false, entryView: normalized },
        `Hotel view set to ${normalized}.`,
      );
    },
    [updateEngineLaunchSettings],
  );

  const setRealm = useCallback(
    (value: OriginsRealmId) => {
      const realm = originsRealmDefinition(value);
      void updateEngineLaunchSettings(
        { realm: realm.id },
        `Realm set to ${realm.label} (${realm.id.toUpperCase()}).`,
      );
    },
    [updateEngineLaunchSettings],
  );

  return {
    importClientReference,
    selectClientProfile,
    startEngine,
    stopEngine,
    updateEngineLaunchSettings,
    applyVersionCheckBuild,
    setRealm,
    setHotelView,
  };
}
