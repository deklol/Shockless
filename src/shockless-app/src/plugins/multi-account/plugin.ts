import type { PluginDefinition } from "../../shared/plugin.js";

export const multiAccountPlugin: PluginDefinition = {
    id: "multi-account",
    name: "Multi Account",
    category: "session",
    icon: "bot",
    enabledByDefault: false,
    status: "mapped",
    summary: "Client sessions, manual visible clients, account loading, main/summon routing, and mimic controls.",
    capabilities: [
      "Session list and selected/main switching",
      "Manual visible client creation",
      "Plain account-file and encrypted-store load commands",
      "Main/summoner assignment",
      "Summon by friend-follow or private-room entry",
      "Mimic enable/source controls",
      "Movement, speech, action, and room-follow mimic toggles",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Multi Account Panel",
        enabledByDefault: true,
        summary: "Sessions, loading, summon, and mimic controls in one module.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Multi Account Commands",
        enabledByDefault: true,
        summary: "newclient/load/accounts/main/summon/mimic commands through the backtick console.",
      },
    ],
    sourceMapping: {
      habbpyV3: [
        "habbpy/tabs/connection_tab.py mimic controls",
        "habbpy/tabs/user_tab.py mimic controls",
        "habbpy/gui_dashboard.py MIMIC_WHITELIST and _mimic_forward",
      ],
      shockless: [
        "src/main/multiSessionManager.ts",
        "src/main/relay/originsRelayV4.ts scoped relay control packets",
        "src/shared/mimicRelayPackets.ts",
        "window.__engine.dev.enterPrivateRoom",
      ],
      notes:
        "Multi Account owns session orchestration. Mimic tails source-client relay logs, filters categories, forwards whitelisted packets through target relay controls, and copies private room joins through the Shockless Navigator route.",
    },
  };
