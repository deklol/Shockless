import type { PluginDefinition } from "../../shared/plugin.js";

export const pluginManagerPlugin: PluginDefinition = {
    id: "plugin-manager",
    name: "Plugin Manager",
    category: "core",
    icon: "plug",
    enabledByDefault: true,
    status: "ready",
    summary: "Install, create, reload, enable, disable, and inspect Shockless plugins.",
    capabilities: [
      "Pinned core plugin that cannot be disabled",
      "Built-in and user plugin list",
      "Enable/disable optional plugins",
      "Per-surface toggles",
      "Create plugin from template",
      "Install plugin from folder",
      "Plugin folder and reload controls",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Plugin Manager Panel",
        enabledByDefault: true,
        summary: "Plugin list, install/create actions, permissions, and load errors.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["New v4 plugin architecture feature"],
      shockless: ["src/main/pluginManager.ts", "src/plugins/template", "src/renderer/ui/App.tsx"],
      notes:
        "Plugin Manager owns persisted plugin enablement and user plugin discovery. It is pinned so users can always recover hidden optional plugins.",
    },
    core: true,
    origin: "built-in",
    permissions: ["ui.panel"],
  };
