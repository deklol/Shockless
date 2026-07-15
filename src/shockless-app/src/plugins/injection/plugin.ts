import type { PluginDefinition } from "../../shared/plugin.js";

export const injectionPlugin: PluginDefinition = {
    id: "injection",
    name: "Injection",
    category: "developer",
    icon: "terminal",
    enabledByDefault: false,
    status: "ready",
    summary: "Raw Shockwave packet editor with validation, session targeting, repetition, saved packets, and history.",
    permissions: ["ui.panel", "console.commands", "packet.inject", "storage"],
    capabilities: [
      "Raw WEDGIE and expression packet input",
      "Send to server or client",
      "Live header, name, and length validation",
      "Selected-session or all-session targeting",
      "Finite repeat with interval control",
      "Persistent saved packets and sent history",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Injection Panel",
        enabledByDefault: false,
        summary: "Raw Shockwave packet editor, validation, saved packets, and history.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/injection_tab.py", "habbpy/session.py"],
      shockless: [
        "src/shared/shockwavePacketExpression.ts",
        "src/shared/shockwavePluginPacketBuilder.ts",
        "src/main/relay/originsRelayV4.ts packet control scope",
        "packets.send / packets.sendRaw plugin APIs",
      ],
      notes:
        "Uses the permission-gated packet builder and relay path. Packet text supports raw Latin-1, [byte] escapes, and h/i/u/b/s expressions with target-correct WEDGIE encoding.",
    },
  };
