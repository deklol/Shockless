import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { ORIGINS_STEAM_APP_ID } from "../../shared/steam.js";
import { parseValveKeyValues, valveObject, valveString, valveValue } from "./ValveKeyValues.js";

const execFileAsync = promisify(execFile);

export interface SteamOriginsInstallation {
  readonly steamRoot: string;
  readonly libraryRoot: string;
  readonly gameRoot: string;
  readonly steamApiPath: string;
}

export async function locateSteamOriginsInstallation(): Promise<SteamOriginsInstallation> {
  if (process.platform !== "win32") throw new Error("Steam Login is currently available on Windows only.");
  const steamRoot = await locateSteamRoot();
  const libraryRoots = steamLibraryRoots(steamRoot);
  for (const libraryRoot of libraryRoots) {
    const manifestPath = join(libraryRoot, "steamapps", `appmanifest_${ORIGINS_STEAM_APP_ID}.acf`);
    if (!existsSync(manifestPath)) continue;
    const manifest = parseValveKeyValues(readFileSync(manifestPath, "utf8"));
    const appState = valveObject(valveValue(manifest, "AppState"));
    if (!appState || valveString(valveValue(appState, "appid")) !== String(ORIGINS_STEAM_APP_ID)) continue;
    const installDir = valveString(valveValue(appState, "installdir"))?.trim();
    if (!installDir || installDir.includes("..") || /[\\/:*?"<>|]/.test(installDir)) continue;
    const gameRoot = join(libraryRoot, "steamapps", "common", installDir);
    const steamApiPath = join(gameRoot, "Xtras", "steam_api.dll");
    if (!existsSync(steamApiPath)) continue;
    assertX86PortableExecutable(steamApiPath);
    return {
      steamRoot: canonicalPath(steamRoot),
      libraryRoot: canonicalPath(libraryRoot),
      gameRoot: canonicalPath(gameRoot),
      steamApiPath: canonicalPath(steamApiPath),
    };
  }
  throw new Error("Habbo Hotel: Origins is not installed in a registered Steam library.");
}

export function steamLibraryRoots(steamRoot: string): readonly string[] {
  const roots = new Map<string, string>();
  addRoot(roots, steamRoot);
  const manifestPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!existsSync(manifestPath)) return [...roots.values()];
  const parsed = parseValveKeyValues(readFileSync(manifestPath, "utf8"));
  const folders = valveObject(valveValue(parsed, "libraryfolders")) ?? parsed;
  for (const [key, rawEntry] of Object.entries(folders)) {
    if (!/^\d+$/.test(key)) continue;
    const entry = valveObject(rawEntry);
    const path = entry ? valveString(valveValue(entry, "path")) : valveString(rawEntry);
    if (path) addRoot(roots, path);
  }
  return [...roots.values()];
}

export function parseSteamRegistryPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(SteamPath|InstallPath)\s+REG_\w+\s+(.+?)\s*$/i.exec(line);
    if (match?.[2]) return match[2].trim();
  }
  return null;
}

function addRoot(roots: Map<string, string>, value: string): void {
  const path = resolve(normalize(value.replaceAll("/", "\\")));
  roots.set(path.toLowerCase(), path);
}

async function locateSteamRoot(): Promise<string> {
  const keys = ["HKCU\\Software\\Valve\\Steam", "HKLM\\Software\\WOW6432Node\\Valve\\Steam"];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", key], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5_000,
      });
      const path = parseSteamRegistryPath(stdout);
      if (path && existsSync(join(path, "steamapps"))) return path;
    } catch {
      // Continue to the next official registry location.
    }
  }
  throw new Error("Steam installation was not found in the Windows registry.");
}

function assertX86PortableExecutable(filePath: string): void {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error("Installed Steam API is not a valid Windows executable image.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Installed Steam API has an invalid PE header.");
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x014c) {
    throw new Error("Installed Steam API is not the required 32-bit build.");
  }
}

function canonicalPath(path: string): string {
  return realpathSync.native(path);
}
