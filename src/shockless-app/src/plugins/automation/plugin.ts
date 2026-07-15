import type { PluginDefinition } from "../../shared/plugin.js";

export const automationPlugin: PluginDefinition = {
    id: "automation",
    name: "Automation",
    category: "automation",
    icon: "bot",
    enabledByDefault: false,
    status: "mapped",
    summary: "Automation tools for comfort actions, window cleanup, and wall items.",
    capabilities: [
      "Auto-hide Bulletin Board after login",      "Wall Mover plugin split",
      "Comfort toggles",    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Automation Panel",
        enabledByDefault: false,
        summary: "Window cleanup, wall mover, and helper settings.",
      },
      {
        id: "status",
        kind: "status",
        label: "Automation Status",
        enabledByDefault: false,
        summary: "Compact active automation readout.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Automation Commands",
        enabledByDefault: false,
        summary: "Automation start/stop and mode commands.",
      },
    ],
    sourceMapping: {
      habbpyV3: [        "habbpy/tabs/wallmover_tab.py",        "habbpy/wallmover.py",
      ],
      shockless: [
        "window.__engine.dev.windowIds",
        "window.__engine.dev.windowElements",
        "window.__engine.dev.clickWindowElement",      ],
      notes:
        "Auto-hide Bulletin Board is mapped through runtime window controls. Wall Mover owns first-class wall item controls and validated relay actions.",
    },
  };
