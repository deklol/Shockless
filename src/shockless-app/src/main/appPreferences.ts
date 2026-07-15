import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appDataStorePath, firstExistingAppDataStorePath } from "./appDataPaths.js";

const STORE_FILE = "app-preferences.json";

export const GPU_LAUNCH_SWITCHES = [
  "enable-gpu-rasterization",
  "enable-zero-copy",
  "ignore-gpu-blocklist",
  "enable-accelerated-2d-canvas",
] as const;

export interface AppPreferences {
  readonly shellUiHidden: boolean;
  readonly hardwareAcceleration: boolean;
  readonly packetOutputWrap: boolean;
  readonly packetOutputAutoScroll: boolean;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly perfTrace: boolean;
  readonly engineUserNameLabels: boolean;
  readonly customHabboCursor: boolean;
  readonly userNameLabelOffset: number;
  readonly userNameLabelSelfColor: string;
  readonly userNameLabelOtherColor: string;
  readonly nativeBindShift: string;
  readonly nativeBindControl: string;
  readonly nativeBindOption: string;
  readonly nativeBindCommand: string;
  readonly defaultAccountFile: string;
  readonly defaultAccountCount: number;
  readonly defaultAccountConcurrency: number;
  readonly defaultAccountKeyEnv: string;
  readonly defaultSummonTarget: string;
  readonly defaultLoadMode: "headless" | "visible";
  readonly autoSubmitVisibleLogin: boolean;
}

export interface AppPreferencesState extends AppPreferences {
  readonly hardwareAccelerationActive: boolean;
  readonly hardwareAccelerationRestartRequired: boolean;
  readonly gpuLaunchSwitches: readonly string[];
}

export function defaultAppPreferences(): AppPreferences {
  return {
    shellUiHidden: false,
    hardwareAcceleration: true,
    packetOutputWrap: true,
    packetOutputAutoScroll: true,
    smoothAvatars: true,
    smoothUi: true,
    perfTrace: false,
    engineUserNameLabels: false,
    customHabboCursor: true,
    userNameLabelOffset: 40,
    userNameLabelSelfColor: "#ffffff",
    userNameLabelOtherColor: "#ffffff",
    nativeBindShift: "Shift",
    nativeBindControl: "Control",
    nativeBindOption: "Alt",
    nativeBindCommand: "Control",
    defaultAccountFile: "multiclient-accounts.txt",
    defaultAccountCount: 3,
    defaultAccountConcurrency: 2,
    defaultAccountKeyEnv: "SHOCKLESS_ACCOUNT_STORE_KEY",
    defaultSummonTarget: "headless",
    defaultLoadMode: "headless",
    autoSubmitVisibleLogin: true,
  };
}

export function readAppPreferences(appDataPath: string): AppPreferences {
  const filePath = firstExistingAppDataStorePath(appDataPath, STORE_FILE);
  if (!existsSync(filePath)) return defaultAppPreferences();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Record<keyof AppPreferences, unknown>>;
    return normalizeAppPreferences(parsed);
  } catch {
    return defaultAppPreferences();
  }
}

export function writeAppPreferences(appDataPath: string, patch: Partial<AppPreferences>): AppPreferences {
  const next = normalizeAppPreferences({ ...readAppPreferences(appDataPath), ...patch });
  const filePath = appPreferencesPath(appDataPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function appPreferencesState(appDataPath: string, hardwareAccelerationActive: boolean): AppPreferencesState {
  const preferences = readAppPreferences(appDataPath);
  return {
    ...preferences,
    hardwareAccelerationActive,
    hardwareAccelerationRestartRequired: preferences.hardwareAcceleration !== hardwareAccelerationActive,
    gpuLaunchSwitches: hardwareAccelerationActive ? GPU_LAUNCH_SWITCHES : [],
  };
}

export function appPreferencesPath(appDataPath: string): string {
  return appDataStorePath(appDataPath, STORE_FILE);
}

export function earlyAppDataPath(): string {
  const override = process.env.SHOCKLESS_APP_DATA_PATH?.trim();
  if (override) return resolve(override);
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin" && process.env.HOME) return join(process.env.HOME, "Library", "Application Support");
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.env.HOME) return join(process.env.HOME, ".config");
  return process.cwd();
}

function normalizeAppPreferences(value: Partial<Record<keyof AppPreferences, unknown>>): AppPreferences {
  const defaults = defaultAppPreferences();
  return {
    shellUiHidden: value.shellUiHidden === true,
    hardwareAcceleration: value.hardwareAcceleration !== false,
    packetOutputWrap: value.packetOutputWrap !== false,
    packetOutputAutoScroll: value.packetOutputAutoScroll !== false,
    smoothAvatars: value.smoothAvatars !== false,
    smoothUi: value.smoothUi !== false,
    perfTrace: value.perfTrace === true,
    engineUserNameLabels: value.engineUserNameLabels === true,
    customHabboCursor: value.customHabboCursor !== false,
    userNameLabelOffset: normalizePreferenceInt(value.userNameLabelOffset, defaults.userNameLabelOffset, 0, 96),
    userNameLabelSelfColor: normalizePreferenceColor(value.userNameLabelSelfColor, defaults.userNameLabelSelfColor),
    userNameLabelOtherColor: normalizePreferenceColor(value.userNameLabelOtherColor, defaults.userNameLabelOtherColor),
    nativeBindShift: normalizePreferenceText(value.nativeBindShift, defaults.nativeBindShift, 80),
    nativeBindControl: normalizePreferenceText(value.nativeBindControl, defaults.nativeBindControl, 80),
    nativeBindOption: normalizePreferenceText(value.nativeBindOption, defaults.nativeBindOption, 80),
    nativeBindCommand: normalizePreferenceText(value.nativeBindCommand, defaults.nativeBindCommand, 80),
    defaultAccountFile: normalizePreferenceText(value.defaultAccountFile, defaults.defaultAccountFile, 260),
    defaultAccountCount: normalizePreferenceInt(value.defaultAccountCount, defaults.defaultAccountCount, 1, 50),
    defaultAccountConcurrency: normalizePreferenceInt(value.defaultAccountConcurrency, defaults.defaultAccountConcurrency, 1, 8),
    defaultAccountKeyEnv: normalizePreferenceText(value.defaultAccountKeyEnv, defaults.defaultAccountKeyEnv, 120),
    defaultSummonTarget: normalizePreferenceText(value.defaultSummonTarget, defaults.defaultSummonTarget, 80),
    defaultLoadMode: value.defaultLoadMode === "visible" ? "visible" : "headless",
    autoSubmitVisibleLogin: value.autoSubmitVisibleLogin !== false,
  };
}

function normalizePreferenceText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLength);
}

function normalizePreferenceInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function normalizePreferenceColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}
