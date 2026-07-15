import type { PluginDefinition } from "../../shared/plugin.js";

export const settingsPlugin: PluginDefinition = {
    id: "settings",
    name: "Settings",
    category: "core",
    icon: "wrench",
    enabledByDefault: true,
    status: "ready",
    summary: "Engine preferences, launch settings, hotkeys, console defaults, and session defaults.",
    capabilities: [
      "Pinned core plugin that cannot be disabled",
      "Engine launch settings",
      "Hardware acceleration preference",
      "VERSIONCHECK override controls",
      "Console key binding management",
      "Session and plugin preference surface",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Settings Panel",
        enabledByDefault: true,
        summary: "Application settings separated from diagnostic plugin panels.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/gui.py settings/menu behavior"],
      shockless: ["src/main/appPreferences.ts", "src/main/shocklessEmbed.ts", "src/main/multiSessionManager.ts"],
      notes:
        "Settings is pinned and keeps app preferences away from normal plugin data panels.",
    },
    core: true,
    origin: "built-in",
    permissions: ["ui.panel"],
  };
