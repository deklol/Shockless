import type { PluginDefinition } from "../../shared/plugin.js";

export const wallMoverPlugin: PluginDefinition = {
    id: "wall-mover",
    name: "Wall Mover",
    category: "automation",
    icon: "hammer",
    enabledByDefault: false,
    status: "mapped",
    summary: "Wall item selector and mover controls.",
    capabilities: [
      "Live wall item selector",
      "Packet-backed wall item fallback",
      "Target, owner, wall/local/orientation fields",
      "Step, move pad, flip, and pickup controls",
      "Rights-aware move readiness",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Wall Mover Panel",
        enabledByDefault: false,
        summary: "Compact wall item target and move controls.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Wall Mover Commands",
        enabledByDefault: false,
        summary: "Nudge, flip, pickup, and step commands.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/wallmover_tab.py", "habbpy/wallmover.py"],
      shockless: [
        "window.__engine.roomObjects().wallItems",
        "%APPDATA%/Shockless/logs/shockless-relay.log decoded ITEMS/UPDATEITEM/REMOVEITEM",
        "src/shared/wallMoverRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts Wall Mover control scope",
      ],
      notes:
        "Panel reads live wall item rows, falls back to decoded v3 wall item packet rows, and routes move/pickup controls through scoped v3-equivalent relay packets.",
    },
  };
