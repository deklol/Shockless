import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_DATA_DIR_NAME } from "../shared/branding.js";
import { LEGACY_APP_DATA_DIR_NAMES } from "../shared/legacyCompatibility.js";

export function appDataStoreRoot(appDataPath: string): string {
  return join(appDataPath, APP_DATA_DIR_NAME);
}

export function appDataStorePath(appDataPath: string, ...parts: readonly string[]): string {
  return join(appDataStoreRoot(appDataPath), ...parts);
}

export function legacyAppDataStoreRoots(appDataPath: string): readonly string[] {
  return LEGACY_APP_DATA_DIR_NAMES.map((name) => join(appDataPath, name));
}

export function appDataStoreRootsForRead(appDataPath: string): readonly string[] {
  return [appDataStoreRoot(appDataPath), ...legacyAppDataStoreRoots(appDataPath)];
}

export function firstExistingAppDataStorePath(appDataPath: string, ...parts: readonly string[]): string {
  const preferred = appDataStorePath(appDataPath, ...parts);
  if (existsSync(preferred)) return preferred;
  const legacy = legacyAppDataStoreRoots(appDataPath).map((root) => join(root, ...parts)).find((candidate) => existsSync(candidate));
  return legacy ?? preferred;
}
