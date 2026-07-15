import type { PluginDefinition } from "../../shared/plugin.js";

export const infoPlugin: PluginDefinition = {
    id: "info",
    name: "Info",
    category: "social",
    icon: "info",
    enabledByDefault: true,
    status: "mapped",
    summary: "Account, room, inventory, rights, badges, effects, and profile lookup.",
    capabilities: [
      "Account and room summary",
      "Official Origins public user lookup",
      "Inventory and rights counts",
      "Rights list",
      "Packet-backed friend, badge, preference, and status-effect summaries",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Info Panel",
        enabledByDefault: true,
        summary: "Compact account and room facts.",
      },
      {
        id: "status",
        kind: "status",
        label: "Info Status",
        enabledByDefault: true,
        summary: "Account, room, inventory, and rights status.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Info Commands",
        enabledByDefault: false,
        summary: "Request friends/badges/preferences, comfort toggles, badge override, and minigames once mapped.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/info_tab.py", "habbpy/gui_dashboard.py get_session_snapshot"],
      shockless: [
        "Session.pitemlist",
        "window.__engine.roomObjects().users",
        "Room_container.pItemList",
        "%APPDATA%/Shockless/logs/shockless-relay.log",
        "src/main/relayLog.ts",
        "Official Origins public users API for explicit name lookup",
      ],
      notes:
        "Explicit public user lookup is mapped through the official Origins public users API. Friends, available badges, active badge, preferences, and status effects are populated from parsed relay packets when present. Comfort toggles, badge override apply, and minigame commands stay out of the normal panel until mapped.",
    },
  };
