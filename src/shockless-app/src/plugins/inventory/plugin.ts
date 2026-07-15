import type { PluginDefinition } from "../../shared/plugin.js";

export const inventoryPlugin: PluginDefinition = {
    id: "inventory",
    name: "Inventory",
    category: "inventory",
    icon: "package",
    enabledByDefault: false,
    status: "mapped",
    summary: "Inventory request, packet-backed item list, search, counts, and item details.",
    capabilities: [
      "Inventory request",
      "STRIPINFO_2 packet-backed item list",
      "REMOVESTRIPITEM packet removals",
      "Inventory search",
      "Floor/wall counts",
      "Selected item detail",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Inventory Panel",
        enabledByDefault: true,
        summary: "Inventory request and item detail surface.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Inventory Commands",
        enabledByDefault: false,
        summary: "Request and inspect inventory once mapped.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/inventory_tab.py", "habbpy/gui_dashboard.py", "habbpy/shockwave_parser.py"],
      shockless: [
        "Room Interface Class -> Room_container",
        "Container Hand Class.pItemList",
        "Room_bar:int_hand_image",
        "%APPDATA%/Shockless/logs/shockless-relay.log",
        "src/main/relayLog.ts STRIPINFO_2/REMOVESTRIPITEM decoders",
      ],
      notes:
        "The dock reads runtime hand rows when available and falls back to v3-equivalent decrypted STRIPINFO_2 inventory packets, including remove packets, search, counts, and selected detail rows. Bobba price lookup remains pending.",
    },
  };
