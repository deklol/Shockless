import type { PluginDefinition } from "../../shared/plugin.js";

export const connectionPlugin: PluginDefinition = {
    id: "connection",
    name: "Connection",
    category: "session",
    icon: "plug",
    enabledByDefault: true,
    status: "mapped",
    summary: "Client/profile import, session lifecycle, active profile, status, and traffic facts.",
    capabilities: [
      "Session list and active session selection",
      "Compiled client import/build and Shockless profile registration",
      "Profile selection and launch",
      "Client state, traffic, crypto/status facts",
      "Lifecycle controls",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Connection Panel",
        enabledByDefault: true,
        summary: "Session, profile, and lifecycle controls in the dock.",
      },
      {
        id: "status",
        kind: "status",
        label: "Connection Status",
        enabledByDefault: true,
        summary: "Connection state shown in the bottom strip.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Lifecycle Commands",
        enabledByDefault: true,
        summary: "Launch and stop controls once embed plumbing is available.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/gui.py", "habbpy/tabs/connection_tab.py", "habbpy/proxy_runner.py"],
      shockless: ["standalone/src/main/main.ts", "standalone/src/main/profileImporter.ts", "src/main/clientLibrary.ts"],
      notes:
        "v4 registers existing Shockless profile folders by reference. Selecting a compiled client folder reuses a matching ready profile cache when present, otherwise it invokes the bundled Shockless profile importer to build a playable profile without hardcoded client versions.",
    },
  };
