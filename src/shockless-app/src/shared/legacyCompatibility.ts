import { ENVIRONMENT_PREFIX, STORAGE_NAMESPACE, WEBVIEW_PARTITION_NAME } from "./branding.js";

export const LEGACY_APP_EXECUTABLE_NAMES = ["Habbpy v4.exe"] as const;
export const LEGACY_APP_PORTABLE_DIR_NAMES = ["HabbpyV4"] as const;
export const LEGACY_APP_DATA_DIR_NAMES = ["HabbpyV4", "ShocklessEngine"] as const;
export const LEGACY_PLUGIN_MANIFEST_FILES = ["habbpy.plugin.json"] as const;
export const LEGACY_WINDOW_BRIDGE_NAME = "habbpyV4";

const LEGACY_ENVIRONMENT_PREFIX = "HABBPY_V4_";
const LEGACY_STORAGE_NAMESPACE = "habbpy-v4";
const LEGACY_WEBVIEW_PARTITION_NAME = "habbpy-v4-shockless";

const LEGACY_ENVIRONMENT_ALIASES: Readonly<Record<string, string>> = {
  HABBPY_V4_SHOCKLESS_CLIENTS_ROOT: "SHOCKLESS_CLIENTS_ROOT",
  HABBPY_V4_SHOCKLESS_ENGINE_ROOT: "SHOCKLESS_ENGINE_ROOT",
  HABBPY_V4_SHOCKLESS_RELAY: "SHOCKLESS_RELAY",
  HABBPY_V4_SHOCKLESS_RELAY_RESOURCES: "SHOCKLESS_RELAY_RESOURCES",
};

export function legacyEnvironmentName(canonicalName: string): string | null {
  const explicit = Object.entries(LEGACY_ENVIRONMENT_ALIASES).find(([, canonical]) => canonical === canonicalName);
  if (explicit) return explicit[0];
  if (!canonicalName.startsWith(ENVIRONMENT_PREFIX)) return null;
  return `${LEGACY_ENVIRONMENT_PREFIX}${canonicalName.slice(ENVIRONMENT_PREFIX.length)}`;
}

export function installLegacyEnvironment(environment: Record<string, string | undefined>): void {
  for (const [legacyName, canonicalName] of Object.entries(LEGACY_ENVIRONMENT_ALIASES)) {
    const value = environment[legacyName];
    if (value !== undefined && environment[canonicalName] === undefined) environment[canonicalName] = value;
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(LEGACY_ENVIRONMENT_PREFIX) || value === undefined) continue;
    if (LEGACY_ENVIRONMENT_ALIASES[name]) continue;
    const canonicalName = `${ENVIRONMENT_PREFIX}${name.slice(LEGACY_ENVIRONMENT_PREFIX.length)}`;
    if (environment[canonicalName] === undefined) environment[canonicalName] = value;
  }
}

export function legacyStorageKey(canonicalKey: string): string | null {
  const prefix = `${STORAGE_NAMESPACE}:`;
  if (!canonicalKey.startsWith(prefix)) return null;
  return `${LEGACY_STORAGE_NAMESPACE}:${canonicalKey.slice(prefix.length)}`;
}

export function legacyWebviewPartitionName(canonicalName: string): string | null {
  if (canonicalName === WEBVIEW_PARTITION_NAME) return LEGACY_WEBVIEW_PARTITION_NAME;
  const clientPrefix = `${WEBVIEW_PARTITION_NAME}-client-`;
  if (!canonicalName.startsWith(clientPrefix)) return null;
  return `${LEGACY_WEBVIEW_PARTITION_NAME}-client-${canonicalName.slice(clientPrefix.length)}`;
}

export function canonicalWebviewPartitionName(legacyName: string): string | null {
  if (legacyName === LEGACY_WEBVIEW_PARTITION_NAME) return WEBVIEW_PARTITION_NAME;
  const clientPrefix = `${LEGACY_WEBVIEW_PARTITION_NAME}-client-`;
  if (!legacyName.startsWith(clientPrefix)) return null;
  return `${WEBVIEW_PARTITION_NAME}-client-${legacyName.slice(clientPrefix.length)}`;
}
