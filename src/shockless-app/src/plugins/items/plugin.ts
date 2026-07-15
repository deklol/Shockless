import type { PluginDefinition } from "../../shared/plugin.js";

export const itemsPlugin: PluginDefinition = {
    id: "items",
    name: "Items",
    category: "inventory",
    icon: "sofa",
    enabledByDefault: false,
    status: "mapped",
    summary: "Searchable floor and wall item inspector with furnidata names and packet-backed wall rows.",
    capabilities: [
      "Floor item table",
      "Wall item table",
      "ITEMS/UPDATEITEM/REMOVEITEM packet-backed wall fallback",
      "Search",
      "Selected item detail",
      "Furnidata names/descriptions",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Items Panel",
        enabledByDefault: true,
        summary: "Floor and wall item browser.",
      },
      {
        id: "overlay",
        kind: "overlay",
        label: "Item Overlay",
        enabledByDefault: false,
        summary: "Item hover/selection labels above the game.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/items_tab.py"],
      shockless: [
        "window.__engine.roomObjects",
        "window.__engine.dev.roomObjects",
        "%APPDATA%/Shockless/logs/shockless-relay.log decoded ITEMS/UPDATEITEM/REMOVEITEM",
        "Origins furnidata gamedata cached through src/main/furnidata.ts",
      ],
      notes:
        "Live room rows and furnidata names/descriptions are mapped. When runtime wall rows are absent, decrypted v3 wall item packets provide owner, wall/local position, orientation, data, state, and add/remove/update fallback rows. Bobba pricing remains pending.",
    },
  };
