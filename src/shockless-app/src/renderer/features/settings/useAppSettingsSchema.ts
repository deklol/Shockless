import { useMemo } from "react";
import type { PluginUiElement } from "../../../shared/plugin";
import type { AppPreferencesState, EngineLaunchState } from "../../../shared/window-api";
import type { OriginsRealmId } from "../../../shared/originsRealm";
import type { AppUpdateState } from "../../../shared/update";
import { statusLabel } from "../common/model";

export interface AppSettingsSchemaContext {
  readonly appPreferences: AppPreferencesState | null;
  readonly automationPrefs: { readonly autoHideBulletin: boolean };
  readonly currentHotelView: string;
  readonly currentRealm: OriginsRealmId;
  readonly customHabboCursor: boolean;
  readonly engineLaunch: EngineLaunchState | null;
  readonly engineUserNameLabels: boolean;
  readonly multiAccountConcurrency: string;
  readonly multiAccountCount: string;
  readonly multiAccountFile: string;
  readonly multiAccountKeyEnv: string;
  readonly multiAccountLoadMode: "headless" | "visible";
  readonly multiAccountSummonTarget: string;
  readonly nativeBindCommand: string;
  readonly nativeBindControl: string;
  readonly nativeBindOption: string;
  readonly nativeBindShift: string;
  readonly packetFilters: { readonly wrap: boolean; readonly autoscroll: boolean };
  readonly perfTrace: boolean;
  readonly resizeSensitiveHotelViewSelected: boolean;
  readonly settingsBindCommand: string;
  readonly settingsBindKey: string;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly updateState: AppUpdateState | null;
  readonly userNameLabelOffset: number;
  readonly userNameLabelOtherColor: string;
  readonly userNameLabelSelfColor: string;
  readonly versionCheckDraft: string;
}

export function useAppSettingsSchema(context: AppSettingsSchemaContext): {
  readonly appSettingsLayout: readonly PluginUiElement[];
  readonly appSettingsValues: Readonly<Record<string, string | number | boolean | null>>;
} {
  const {
    appPreferences,
    automationPrefs,
    currentHotelView,
    currentRealm,
    customHabboCursor,
    engineLaunch,
    engineUserNameLabels,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    multiAccountKeyEnv,
    multiAccountLoadMode,
    multiAccountSummonTarget,
    nativeBindCommand,
    nativeBindControl,
    nativeBindOption,
    nativeBindShift,
    packetFilters,
    perfTrace,
    resizeSensitiveHotelViewSelected,
    settingsBindCommand,
    settingsBindKey,
    smoothAvatars,
    smoothUi,
    updateState,
    userNameLabelOffset,
    userNameLabelOtherColor,
    userNameLabelSelfColor,
    versionCheckDraft,
  } = context;

const appSettingsLayout = useMemo<readonly PluginUiElement[]>(() => [
    {
      type: "section",
      id: "interface",
      title: "Interface",
      description: "Global app behaviour.",
      children: [
        { type: "toggle", id: "autoHideBulletin", label: "Auto Hide Bulletin On Login", description: "Hide the initial in-game bulletin when a room snapshot is available.", defaultValue: true, action: "settings.autoHideBulletin" },
        { type: "toggle", id: "customHabboCursor", label: "Habbo Select Cursor", description: "Use the cursor bitmap requested by the Director source on clickable game sprites.", defaultValue: true, action: "settings.customHabboCursor" },
        { type: "toggle", id: "engineUserNameLabels", label: "Render Names Above Heads", description: "Draw 9px Goldfish username labels in the engine view when a room is loaded.", defaultValue: false, action: "settings.engineUserNameLabels" },
        { type: "slider", id: "userNameLabelOffset", label: "Name Height", description: "Higher values move the label upward above the avatar.", min: 0, max: 96, step: 1, defaultValue: 40, action: "settings.userNameLabelOffset" },
        { type: "colorInput", id: "userNameLabelSelfColor", label: "My Name Color", defaultValue: "#ffffff", action: "settings.userNameLabelSelfColor" },
        { type: "colorInput", id: "userNameLabelOtherColor", label: "Other Users Color", defaultValue: "#ffffff", action: "settings.userNameLabelOtherColor" },
      ],
    },
    {
      type: "section",
      id: "engine",
      title: "Engine",
      description: "Client launch and room-stage settings.",
      children: [
        { type: "select", id: "realm", label: "Realm", defaultValue: "ous", action: "settings.realm", options: [
          { value: "ous", label: "US / UK (OUS)" },
          { value: "oes", label: "Spain (OES)" },
          { value: "obr", label: "Brazil / Portugal (OBR)" },
        ] },
        { type: "select", id: "hotelView", label: "Hotel View", defaultValue: "custom", action: "settings.hotelView", options: [
          { value: "custom", label: "Shockless Custom" },
          { value: "hh_entry_uk", label: "United Kingdom" },
          { value: "hh_entry_es", label: "Spain" },
          { value: "hh_entry_br", label: "Brazil" },
          { value: "hh_entry_ru", label: "Russia" },
        ] },
        ...(resizeSensitiveHotelViewSelected ? [
          {
            type: "notice" as const,
            tone: "warning" as const,
            text: "This hotel view is currently visually broken while Responsive Stage Resize is enabled.",
          },
        ] : []),
        { type: "toggle", id: "resizablePresentation", label: "Responsive Stage Resize", defaultValue: true, action: "settings.resizablePresentation" },
        { type: "textInput", id: "versionCheckBuild", label: "Version Check Build", placeholder: "auto", action: "settings.versionCheckBuild" },
        { type: "button", id: "applyVersionCheckBuild", label: "Apply Version", action: "settings.applyVersionCheckBuild", variant: "primary" },
      ],
    },
    {
      type: "section",
      id: "performance",
      title: "Performance",
      description: "Renderer and launch performance preferences.",
      children: [
        { type: "toggle", id: "hardwareAcceleration", label: "Hardware Acceleration", description: "Requires an app restart when changed after launch.", defaultValue: true, action: "settings.hardwareAcceleration" },
        { type: "toggle", id: "smoothAvatars", label: "Smooth Room Motion", description: "Presentation-only interpolation for avatar and active room-object sprites. Director state and animation timing stay unchanged.", defaultValue: true, action: "settings.smoothAvatars" },
        { type: "toggle", id: "smoothUi", label: "Smooth Source Windows", description: "Spreads heavy source-window presentation work across frames to reduce room-stage stalls.", defaultValue: true, action: "settings.smoothUi" },
        { type: "toggle", id: "perfTrace", label: "Performance Trace", description: "Capture long-frame samples in engine diagnostics.", defaultValue: false, action: "settings.perfTrace" },
      ],
    },
    {
      type: "section",
      id: "updates",
      title: "Updates",
      description: "GitHub release checks and downloaded update installation.",
      children: [
        { type: "kv", id: "updateStatus", rows: [
          { key: "State", value: updateState ? statusLabel(updateState.status) : "Idle" },
          { key: "Current", value: updateState?.currentVersion ? `v${updateState.currentVersion}` : "development build" },
          { key: "Available", value: updateState?.available?.version ? `v${updateState.available.version}` : "-" },
          { key: "Last Check", value: updateState?.lastCheckedAt ? new Date(updateState.lastCheckedAt).toLocaleString() : "-" },
        ] },
        { type: "button", id: "checkForUpdates", label: "Check For Updates", action: "settings.checkForUpdates", variant: "primary" },
      ],
    },
    {
      type: "section",
      id: "console",
      title: "Console",
      description: "Backtick console and packet output defaults.",
      children: [
        { type: "toggle", id: "packetOutputWrap", label: "Wrap Packet Output", defaultValue: true, action: "settings.packetOutputWrap" },
        { type: "toggle", id: "packetOutputAutoScroll", label: "Auto Scroll Packet Output", defaultValue: true, action: "settings.packetOutputAutoScroll" },
      ],
    },
    {
      type: "section",
      id: "hotkeys",
      title: "Hotkeys",
      description: "Console shortcuts and native in-game modifier binds.",
      children: [
        { type: "keybind", id: "settingsBindKey", label: "Key", defaultValue: "F1", action: "settings.bindKey" },
        { type: "textInput", id: "settingsBindCommand", label: "Command", defaultValue: "mimic status", action: "settings.bindCommand" },
        { type: "button", id: "bindHotkey", label: "Bind Hotkey", action: "settings.bindHotkey", variant: "primary" },
        { type: "divider" },
        { type: "text", text: "Native Habbo binds feed Director modifier properties. Defaults match the original client unless changed here.", tone: "info" },
        { type: "keybind", id: "nativeBindOption", label: "Move / Bulk Select Modifier", defaultValue: "Alt", action: "settings.nativeBindOption" },
        { type: "keybind", id: "nativeBindShift", label: "Rotate / Inspect Modifier", defaultValue: "Shift", action: "settings.nativeBindShift" },
        { type: "keybind", id: "nativeBindControl", label: "Pickup Modifier", defaultValue: "Control", action: "settings.nativeBindControl" },
        { type: "keybind", id: "nativeBindCommand", label: "Command Modifier", defaultValue: "Control", action: "settings.nativeBindCommand" },
        { type: "button", id: "resetNativeBinds", label: "Reset Native Binds", action: "settings.resetNativeBinds" },
      ],
    },
    {
      type: "section",
      id: "sessions",
      title: "Sessions",
      description: "Default multi-client load settings.",
      children: [
        { type: "textInput", id: "defaultAccountFile", label: "Account File", defaultValue: "multiclient-accounts.txt", action: "settings.defaultAccountFile" },
        { type: "numberInput", id: "defaultAccountCount", label: "Default Count", min: 1, max: 50, step: 1, defaultValue: 3, action: "settings.defaultAccountCount" },
        { type: "numberInput", id: "defaultAccountConcurrency", label: "Concurrency", min: 1, max: 8, step: 1, defaultValue: 2, action: "settings.defaultAccountConcurrency" },
        { type: "textInput", id: "defaultAccountKeyEnv", label: "Account Store Key Env", defaultValue: "SHOCKLESS_ACCOUNT_STORE_KEY", action: "settings.defaultAccountKeyEnv" },
        { type: "select", id: "defaultSummonTarget", label: "Summon Target", defaultValue: "headless", action: "settings.defaultSummonTarget", options: [
          { value: "headless", label: "Headless" },
          { value: "visible", label: "Visible" },
        ] },
        { type: "select", id: "defaultLoadMode", label: "Load Mode", defaultValue: "headless", action: "settings.defaultLoadMode", options: [
          { value: "headless", label: "Headless" },
          { value: "visible", label: "Visible" },
        ] },
        { type: "toggle", id: "autoSubmitVisibleLogin", label: "Auto Submit Visible Login", defaultValue: true, action: "settings.autoSubmitVisibleLogin" },
        { type: "button", id: "saveSessionDefaults", label: "Save Session Defaults", action: "settings.saveSessionDefaults", variant: "primary" },
      ],
    },
  ], [currentHotelView, currentRealm, resizeSensitiveHotelViewSelected, updateState]);

  const appSettingsValues = useMemo<Readonly<Record<string, string | number | boolean | null>>>(() => ({
    autoHideBulletin: automationPrefs.autoHideBulletin,
    customHabboCursor,
    engineUserNameLabels,
    userNameLabelOffset,
    userNameLabelSelfColor,
    userNameLabelOtherColor,
    realm: currentRealm,
    hotelView: currentHotelView,
    resizablePresentation: engineLaunch?.settings?.resizablePresentation !== false,
    versionCheckBuild: versionCheckDraft,
    hardwareAcceleration: appPreferences?.hardwareAcceleration ?? true,
    smoothAvatars,
    smoothUi,
    perfTrace,
    packetOutputWrap: packetFilters.wrap,
    packetOutputAutoScroll: packetFilters.autoscroll,
    settingsBindKey,
    settingsBindCommand,
    nativeBindShift,
    nativeBindControl,
    nativeBindOption,
    nativeBindCommand,
    defaultAccountFile: multiAccountFile,
    defaultAccountCount: Number.parseInt(multiAccountCount, 10) || 3,
    defaultAccountConcurrency: Number.parseInt(multiAccountConcurrency, 10) || 2,
    defaultAccountKeyEnv: multiAccountKeyEnv,
    defaultSummonTarget: multiAccountSummonTarget,
    defaultLoadMode: multiAccountLoadMode,
    autoSubmitVisibleLogin: appPreferences?.autoSubmitVisibleLogin !== false,
  }), [
    appPreferences?.autoSubmitVisibleLogin,
    appPreferences?.hardwareAcceleration,
    automationPrefs.autoHideBulletin,
    customHabboCursor,
    engineUserNameLabels,
    userNameLabelOffset,
    userNameLabelSelfColor,
    userNameLabelOtherColor,
    currentRealm,
    currentHotelView,
    engineLaunch?.settings?.resizablePresentation,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    multiAccountKeyEnv,
    multiAccountLoadMode,
    multiAccountSummonTarget,
    nativeBindCommand,
    nativeBindControl,
    nativeBindOption,
    nativeBindShift,
    packetFilters.autoscroll,
    packetFilters.wrap,
    perfTrace,
    settingsBindCommand,
    settingsBindKey,
    smoothAvatars,
    smoothUi,
    versionCheckDraft,
  ]);

  return { appSettingsLayout, appSettingsValues };
}
