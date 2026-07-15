import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  AppPreferencesPatch,
  EngineLaunchSettingsPatch,
} from "../../../shared/window-api";
import type { OriginsRealmId } from "../../../shared/originsRealm";
import type { EngineRuntimeAction, EngineRuntimeActionResult } from "../../engineRuntime";
import type { PluginSchemaActionEvent } from "../plugins/schemaAction";
import { clampNameLabelOffset, normalizeNameLabelColor, normalizeNativeBindValue } from "./normalization";

interface PacketFilterState {
  readonly client: boolean;
  readonly server: boolean;
  readonly relay: boolean;
  readonly wrap: boolean;
  readonly autoscroll: boolean;
  readonly clientSession: string;
  readonly session: string;
  readonly search: string;
}

interface UserNameLabelSettings {
  readonly sourceYOffset: number;
  readonly selfColor: string;
  readonly otherColor: string;
}

interface NativeKeyBindSettings {
  readonly shift: string;
  readonly control: string;
  readonly option: string;
  readonly command: string;
}

export interface SettingsActionsContext {
  readonly applyCustomHabboCursorRuntime: (enabled?: boolean, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult | null>;
  readonly applyNativeKeyBindsRuntime: (bindings?: NativeKeyBindSettings, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult | null>;
  readonly applyPerformanceOverridesRuntime: (values?: { readonly smoothAvatars: boolean; readonly smoothUi: boolean; readonly perfTrace: boolean }, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult[] | null>;
  readonly applyUserNameLabelRuntime: (enabled?: boolean, settings?: UserNameLabelSettings, options?: { readonly announce?: boolean }) => Promise<EngineRuntimeActionResult | null>;
  readonly applyVersionCheckBuild: () => void;
  readonly checkForUpdates: () => Promise<void>;
  readonly engineUserNameLabels: boolean;
  readonly nativeKeyBindSettings: NativeKeyBindSettings;
  readonly perfTrace: boolean;
  readonly runMultiAccountCommand: (input: string) => Promise<void>;
  readonly runRuntimeAction: (action: EngineRuntimeAction) => Promise<void>;
  readonly saveAppPreferencePatchQuietly: (patch: AppPreferencesPatch) => Promise<void>;
  readonly saveSessionDefaultPreferences: () => Promise<void>;
  readonly setAutomationPrefs: Dispatch<SetStateAction<{ readonly autoHideBulletin: boolean }>>;
  readonly setCustomHabboCursor: Dispatch<SetStateAction<boolean>>;
  readonly setEngineUserNameLabels: Dispatch<SetStateAction<boolean>>;
  readonly setRealm: (value: OriginsRealmId) => void;
  readonly setHotelView: (value: string) => void;
  readonly setMultiAccountConcurrency: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountCount: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountFile: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountKeyEnv: Dispatch<SetStateAction<string>>;
  readonly setMultiAccountLoadMode: Dispatch<SetStateAction<"headless" | "visible">>;
  readonly setMultiAccountSummonTarget: Dispatch<SetStateAction<string>>;
  readonly setNativeBindCommand: Dispatch<SetStateAction<string>>;
  readonly setNativeBindControl: Dispatch<SetStateAction<string>>;
  readonly setNativeBindOption: Dispatch<SetStateAction<string>>;
  readonly setNativeBindShift: Dispatch<SetStateAction<string>>;
  readonly setPacketFilters: Dispatch<SetStateAction<PacketFilterState>>;
  readonly setPerfTrace: Dispatch<SetStateAction<boolean>>;
  readonly setSettingsBindCommand: Dispatch<SetStateAction<string>>;
  readonly setSettingsBindKey: Dispatch<SetStateAction<string>>;
  readonly setSmoothAvatars: Dispatch<SetStateAction<boolean>>;
  readonly setSmoothUi: Dispatch<SetStateAction<boolean>>;
  readonly settingsBindCommand: string;
  readonly settingsBindKey: string;
  readonly setUserNameLabelOffset: Dispatch<SetStateAction<number>>;
  readonly setUserNameLabelOtherColor: Dispatch<SetStateAction<string>>;
  readonly setUserNameLabelSelfColor: Dispatch<SetStateAction<string>>;
  readonly setVersionCheckDraft: Dispatch<SetStateAction<string>>;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly updateAppPreferencePatch: (patch: AppPreferencesPatch, message: string, severity?: "success" | "warning") => Promise<void>;
  readonly updateEngineLaunchSettings: (patch: EngineLaunchSettingsPatch, message?: string) => Promise<void>;
  readonly updateHardwareAccelerationPreference: (enabled: boolean) => Promise<void>;
  readonly userNameLabelSettings: UserNameLabelSettings;
}

export function useSettingsActions(context: SettingsActionsContext): (event: PluginSchemaActionEvent) => void {
  const {
    applyCustomHabboCursorRuntime, applyNativeKeyBindsRuntime, applyPerformanceOverridesRuntime, applyUserNameLabelRuntime,
    applyVersionCheckBuild, checkForUpdates, engineUserNameLabels, nativeKeyBindSettings, perfTrace, runMultiAccountCommand,
    runRuntimeAction, saveAppPreferencePatchQuietly, saveSessionDefaultPreferences, setAutomationPrefs,
    setCustomHabboCursor, setEngineUserNameLabels, setRealm, setHotelView, setMultiAccountConcurrency, setMultiAccountCount,
    setMultiAccountFile, setMultiAccountKeyEnv, setMultiAccountLoadMode, setMultiAccountSummonTarget,
    setNativeBindCommand, setNativeBindControl, setNativeBindOption, setNativeBindShift, setPacketFilters, setPerfTrace,
    setSettingsBindCommand, setSettingsBindKey, setSmoothAvatars, setSmoothUi, settingsBindCommand, settingsBindKey,
    setUserNameLabelOffset, setUserNameLabelOtherColor, setUserNameLabelSelfColor, setVersionCheckDraft, smoothAvatars,
    smoothUi, updateAppPreferencePatch, updateEngineLaunchSettings, updateHardwareAccelerationPreference,
    userNameLabelSettings,
  } = context;

const handleSettingsAction = useCallback((event: PluginSchemaActionEvent) => {
    const key = event.elementId ?? event.action;
    const value = event.value;
    if (key === "autoHideBulletin") {
      setAutomationPrefs((current) => ({ ...current, autoHideBulletin: value !== false }));
      return;
    }
    if (key === "customHabboCursor") {
      const enabled = value !== false;
      setCustomHabboCursor(enabled);
      void updateAppPreferencePatch({ customHabboCursor: enabled }, `Habbo select cursor ${enabled ? "enabled" : "disabled"}.`);
      void applyCustomHabboCursorRuntime(enabled, { announce: true });
      return;
    }
    if (key === "engineUserNameLabels") {
      const enabled = value !== false;
      setEngineUserNameLabels(enabled);
      void updateAppPreferencePatch({ engineUserNameLabels: enabled }, `Username labels ${enabled ? "enabled" : "disabled"}.`);
      void applyUserNameLabelRuntime(enabled, userNameLabelSettings, { announce: true });
      return;
    }
    if (key === "userNameLabelOffset") {
      const sourceYOffset = clampNameLabelOffset(value);
      const nextSettings = { ...userNameLabelSettings, sourceYOffset };
      setUserNameLabelOffset(sourceYOffset);
      void saveAppPreferencePatchQuietly({ userNameLabelOffset: sourceYOffset });
      void applyUserNameLabelRuntime(engineUserNameLabels, nextSettings);
      return;
    }
    if (key === "userNameLabelSelfColor") {
      const selfColor = normalizeNameLabelColor(value);
      const nextSettings = { ...userNameLabelSettings, selfColor };
      setUserNameLabelSelfColor(selfColor);
      void saveAppPreferencePatchQuietly({ userNameLabelSelfColor: selfColor });
      void applyUserNameLabelRuntime(engineUserNameLabels, nextSettings);
      return;
    }
    if (key === "userNameLabelOtherColor") {
      const otherColor = normalizeNameLabelColor(value);
      const nextSettings = { ...userNameLabelSettings, otherColor };
      setUserNameLabelOtherColor(otherColor);
      void saveAppPreferencePatchQuietly({ userNameLabelOtherColor: otherColor });
      void applyUserNameLabelRuntime(engineUserNameLabels, nextSettings);
      return;
    }
    if (key === "hotelView") {
      setHotelView(String(value ?? "hh_entry_uk"));
      return;
    }
    if (key === "realm") {
      setRealm(String(value ?? "ous") as OriginsRealmId);
      return;
    }
    if (key === "resizablePresentation") {
      void updateEngineLaunchSettings({ resizablePresentation: value !== false }, `Responsive stage resize ${value !== false ? "enabled" : "disabled"}.`);
      return;
    }
    if (key === "versionCheckBuild") {
      setVersionCheckDraft(String(value ?? ""));
      return;
    }
    if (key === "applyVersionCheckBuild") {
      applyVersionCheckBuild();
      return;
    }
    if (key === "hardwareAcceleration") {
      void updateHardwareAccelerationPreference(value !== false);
      return;
    }
    if (key === "smoothAvatars") {
      const enabled = value !== false;
      setSmoothAvatars(enabled);
      void updateAppPreferencePatch({ smoothAvatars: enabled }, `Room motion smoothing ${enabled ? "enabled" : "disabled"}.`);
      void applyPerformanceOverridesRuntime({ smoothAvatars: enabled, smoothUi, perfTrace }, { announce: true });
      return;
    }
    if (key === "smoothUi") {
      const enabled = value !== false;
      setSmoothUi(enabled);
      void updateAppPreferencePatch({ smoothUi: enabled }, `Source-window smoothing ${enabled ? "enabled" : "disabled"}.`);
      void applyPerformanceOverridesRuntime({ smoothAvatars, smoothUi: enabled, perfTrace }, { announce: true });
      return;
    }
    if (key === "perfTrace") {
      const enabled = value !== false;
      setPerfTrace(enabled);
      void updateAppPreferencePatch({ perfTrace: enabled }, `Performance trace ${enabled ? "enabled" : "disabled"}.`);
      void applyPerformanceOverridesRuntime({ smoothAvatars, smoothUi, perfTrace: enabled }, { announce: true });
      return;
    }
    if (key === "checkForUpdates") {
      void checkForUpdates();
      return;
    }
    if (key === "packetOutputWrap") {
      const enabled = value !== false;
      setPacketFilters((current) => ({ ...current, wrap: enabled }));
      void updateAppPreferencePatch({ packetOutputWrap: enabled }, `Packet output wrapping ${enabled ? "enabled" : "disabled"}.`);
      return;
    }
    if (key === "packetOutputAutoScroll") {
      const enabled = value !== false;
      setPacketFilters((current) => ({ ...current, autoscroll: enabled }));
      void updateAppPreferencePatch({ packetOutputAutoScroll: enabled }, `Packet output auto-scroll ${enabled ? "enabled" : "disabled"}.`);
      return;
    }
    if (key === "nativeBindShift") {
      const nativeBindShift = normalizeNativeBindValue(value, "Shift");
      const next = { ...nativeKeyBindSettings, shift: nativeBindShift };
      setNativeBindShift(nativeBindShift);
      void saveAppPreferencePatchQuietly({ nativeBindShift });
      void applyNativeKeyBindsRuntime(next);
      return;
    }
    if (key === "nativeBindControl") {
      const nativeBindControl = normalizeNativeBindValue(value, "Control");
      const next = { ...nativeKeyBindSettings, control: nativeBindControl };
      setNativeBindControl(nativeBindControl);
      void saveAppPreferencePatchQuietly({ nativeBindControl });
      void applyNativeKeyBindsRuntime(next);
      return;
    }
    if (key === "nativeBindOption") {
      const nativeBindOption = normalizeNativeBindValue(value, "Alt");
      const next = { ...nativeKeyBindSettings, option: nativeBindOption };
      setNativeBindOption(nativeBindOption);
      void saveAppPreferencePatchQuietly({ nativeBindOption });
      void applyNativeKeyBindsRuntime(next);
      return;
    }
    if (key === "nativeBindCommand") {
      const nativeBindCommand = normalizeNativeBindValue(value, "Control");
      const next = { ...nativeKeyBindSettings, command: nativeBindCommand };
      setNativeBindCommand(nativeBindCommand);
      void saveAppPreferencePatchQuietly({ nativeBindCommand });
      void applyNativeKeyBindsRuntime(next);
      return;
    }
    if (key === "resetNativeBinds") {
      const next = { shift: "Shift", control: "Control", option: "Alt", command: "Control" };
      setNativeBindShift(next.shift);
      setNativeBindControl(next.control);
      setNativeBindOption(next.option);
      setNativeBindCommand(next.command);
      void updateAppPreferencePatch(
        {
          nativeBindShift: next.shift,
          nativeBindControl: next.control,
          nativeBindOption: next.option,
          nativeBindCommand: next.command,
        },
        "Native in-game binds reset to Habbo defaults.",
      );
      void applyNativeKeyBindsRuntime(next, { announce: true });
      return;
    }
    if (key === "settingsBindKey") setSettingsBindKey(String(value ?? ""));
    if (key === "settingsBindCommand") setSettingsBindCommand(String(value ?? ""));
    if (key === "bindHotkey") void runMultiAccountCommand(`bind ${settingsBindKey} ${settingsBindCommand}`.trim());
    if (key === "defaultAccountFile") setMultiAccountFile(String(value ?? ""));
    if (key === "defaultAccountCount") setMultiAccountCount(String(value ?? "3"));
    if (key === "defaultAccountConcurrency") setMultiAccountConcurrency(String(value ?? "2"));
    if (key === "defaultAccountKeyEnv") setMultiAccountKeyEnv(String(value ?? ""));
    if (key === "defaultSummonTarget") setMultiAccountSummonTarget(String(value ?? "headless"));
    if (key === "defaultLoadMode") setMultiAccountLoadMode(value === "visible" ? "visible" : "headless");
    if (key === "autoSubmitVisibleLogin") void updateAppPreferencePatch({ autoSubmitVisibleLogin: value !== false }, `Visible-login auto submit ${value !== false ? "enabled" : "disabled"}.`);
    if (key === "saveSessionDefaults") void saveSessionDefaultPreferences();
  }, [
    applyVersionCheckBuild,
    applyCustomHabboCursorRuntime,
    applyNativeKeyBindsRuntime,
    applyPerformanceOverridesRuntime,
    applyUserNameLabelRuntime,
    checkForUpdates,
    engineUserNameLabels,
    nativeKeyBindSettings,
    perfTrace,
    runMultiAccountCommand,
    runRuntimeAction,
    saveAppPreferencePatchQuietly,
    saveSessionDefaultPreferences,
    setRealm,
    setHotelView,
    settingsBindCommand,
    settingsBindKey,
    smoothAvatars,
    smoothUi,
    updateAppPreferencePatch,
    updateEngineLaunchSettings,
    updateHardwareAccelerationPreference,
    userNameLabelSettings,
  ]);

  return handleSettingsAction;
}
