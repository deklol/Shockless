import type { PluginDefinition } from "../../shared/plugin.js";

export const visitorsPlugin: PluginDefinition = {
    id: "visitors",
    name: "Visitors",
    category: "social",
    icon: "user",
    enabledByDefault: false,
    status: "mapped",
    summary: "Current and seen room visitor tracker from live room user state.",
    capabilities: ["Current visitor count", "Seen visitor ledger", "Search", "Entered/left times", "Visit count"],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Visitors Panel",
        enabledByDefault: true,
        summary: "Compact visitor list with v3 current/seen tracking.",
      },
      {
        id: "status",
        kind: "status",
        label: "Visitors Status",
        enabledByDefault: true,
        summary: "Current and seen visitor counts in the dock.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/visitors_tab.py", "habbpy/tabs/room_tab.py _update_visitors"],
      shockless: ["window.__engine.roomObjects().users", "Session.pitemlist lastroom"],
      notes: "Account id is shown only when Shockless exposes it; otherwise the v3 name fallback key is used.",
    },
  };
