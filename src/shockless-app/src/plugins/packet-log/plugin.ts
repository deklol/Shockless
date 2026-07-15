import type { PluginDefinition } from "../../shared/plugin.js";

export const packetLogPlugin: PluginDefinition = {
    id: "packet-log",
    name: "Packet Log",
    category: "developer",
    icon: "list",
    enabledByDefault: false,
    status: "mapped",
    summary: "Relay packet rows, decrypted body, and room-object inspector.",
    capabilities: [
      "Relay log presence and packet counts",
      "Recent client/server header rows with v3 packet names",
      "Direction and session filters",
      "Display clear, export, wrap, and autoscroll",
      "Selected relay row detail",
      "Payload byte count, decrypted body, ASCII/hex, and decoded fields",
      "Room-object packet fields for objects, updates, adds, removes, plant data, and stuff data",
      "Full escaped v4 relay bodies with sensitive client payload redaction",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Packet Log Panel",
        enabledByDefault: false,
        summary: "Packet/action log filters and detail view.",
      },
      {
        id: "status",
        kind: "status",
        label: "Traffic Status",
        enabledByDefault: false,
        summary: "Compact traffic/error count readout.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/packet_log_tab.py", "habbpy/gui_dashboard.py"],
      shockless: [
        "resources/relay/origins-relay.mjs ORIGINS_LOG_PACKETS",
        "src/main/relay/originsRelayV4.ts",
        "%APPDATA%/Shockless/logs/shockless-relay.log",
        "src/main/relayLog.ts",
      ],
      notes:
        "Current Shockless slice reads relay header/size rows, annotates names from Habbpy v3 packet_names.json, shows payload byte count, parses full sanitized packet bodies when the Shockless relay wrapper is active, and decodes the v3 room-object packet family. Remaining field decoders should be added packet family by packet family.",
    },
  };
