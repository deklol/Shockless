import type { PluginDefinition } from "../../shared/plugin.js";

export const userPlugin: PluginDefinition = {
    id: "user",
    name: "User",
    category: "user",
    icon: "user",
    enabledByDefault: false,
    status: "mapped",
    summary: "Room user/session state plus wave/dance controls.",
    capabilities: [
      "Room user selector",
      "Session username, room, owner, and rights",
      "User position, direction, sprite, and appearance fields",
      "Local copy/profile snapshot and parsed-look storage tools",
      "Wave, dance, carry drink, and apply-look controls",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "User Panel",
        enabledByDefault: true,
        summary: "Selected user details and safe mapped user actions.",
      },
      {
        id: "overlay",
        kind: "overlay",
        label: "User Overlay",
        enabledByDefault: false,
        summary: "Optional user hover labels above the game view.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "User Commands",
        enabledByDefault: false,
        summary: "Wave and dance controls.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/user_tab.py", "habbpy/gui_dashboard.py"],
      shockless: [
        "window.__engine.roomObjects().users",
        "window.__engine.objectProps('Session').pitemlist",
        "src/main/relay/originsRelayV4.ts scoped User control packets",
        "src/main/relay/originsRelayV4.ts mimic control scope",
        "src/shared/userRelayPackets.ts",
        "src/shared/mimicRelayPackets.ts",
        "docs/DEV_AUTOMATION_API.md",
      ],
      notes:
        "Local copy/store tools use parsed panel data only. Wave, dance, carry drink, and apply-look use scoped v3-equivalent relay packets. Mimic tails decoded source-client relay logs and forwards only whitelisted avatar/chat/action packets through target client relay controls.",
    },
  };
