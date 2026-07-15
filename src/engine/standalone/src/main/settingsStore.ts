import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LauncherSettings } from "../common/types.js";

const DEFAULT_SETTINGS: LauncherSettings = {
  activeProfileId: null,
  fixedStage: true,
  resizablePresentation: false,
  customHotelView: false,
  rememberCredentials: false,
  versionCheckBuild: null,
};
const STALE_VERSION_CHECK_BUILDS = new Set([401, 1124, 1125, 1126, 1127, 1128]);

export class SettingsStore {
  private readonly filePath: string;

  constructor(root: string) {
    this.filePath = join(root, "settings.json");
  }

  read(): LauncherSettings {
    if (!existsSync(this.filePath)) return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<LauncherSettings> & {
        readonly "custom-hotelview"?: unknown;
      };
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        activeProfileId: typeof parsed.activeProfileId === "string" ? parsed.activeProfileId : null,
        fixedStage: parsed.fixedStage !== false,
        resizablePresentation: parsed.resizablePresentation === true,
        customHotelView: parsed.customHotelView === true || parsed["custom-hotelview"] === true,
        rememberCredentials: parsed.rememberCredentials === true,
        versionCheckBuild: normalizeBuild(parsed.versionCheckBuild),
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  update(patch: Partial<LauncherSettings>): LauncherSettings {
    const current = this.read();
    const next = {
      ...current,
      ...patch,
      versionCheckBuild: normalizeBuild(patch.versionCheckBuild === undefined ? current.versionCheckBuild : patch.versionCheckBuild),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}

function normalizeBuild(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return STALE_VERSION_CHECK_BUILDS.has(parsed) ? null : parsed;
}
