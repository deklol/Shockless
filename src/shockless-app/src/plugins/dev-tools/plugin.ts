import type { PluginDefinition } from "../../shared/plugin.js";

export const devToolsPlugin: PluginDefinition = {
    id: "dev-tools",
    name: "Dev Tools",
    category: "developer",
    icon: "wrench",
    enabledByDefault: true,
    status: "mapped",
    summary: "Shockless sprite, window, hit-test, profile, and performance diagnostics.",
    capabilities: [
      "Sprite inspector",
      "Window tree",
      "Hit probe",
      "Profile doctor",
      "Performance stats",
      "Screenshot/diff runner",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Dev Tools Panel",
        enabledByDefault: true,
        summary: "Shockless diagnostics and inspection tools.",
      },
      {
        id: "overlay",
        kind: "overlay",
        label: "Dev Overlay",
        enabledByDefault: false,
        summary: "Hit-test and sprite debug overlays above the game.",
      },
      {
        id: "status",
        kind: "status",
        label: "Dev Status",
        enabledByDefault: true,
        summary: "FPS, errors, and profile doctor signals.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Dev Commands",
        enabledByDefault: true,
        summary: "Screenshot capture, visual diff, and diagnostic commands.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["New v4 feature; v3 has no exact equivalent"],
      shockless: ["docs/DEV_AUTOMATION_API.md", "window.__engine.dev.*"],
    },
  };
