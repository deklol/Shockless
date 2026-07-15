import type { PluginDefinition } from "../../shared/plugin.js";

export const chatPlugin: PluginDefinition = {
    id: "chat",
    name: "Chat",
    category: "social",
    icon: "messages",
    enabledByDefault: false,
    status: "mapped",
    summary: "Room chat send, runtime/packet chat history, room markers, and v3-style filters.",
    capabilities: [
      "Send room chat",
      "Talk/whisper/shout/system filters",
      "Display clear",
      "Runtime chat history",
      "Packet-backed CHAT/CHAT_2/CHAT_3 fallback rows",
      "Room entry/clear markers from runtime room events",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Chat Panel",
        enabledByDefault: true,
        summary: "Compact chat send and chat history.",
      },
      {
        id: "status",
        kind: "status",
        label: "Chat Status",
        enabledByDefault: false,
        summary: "Chat availability and recent line count.",
      },
      {
        id: "commands",
        kind: "commands",
        label: "Chat Commands",
        enabledByDefault: true,
        summary: "Send chat through the live Director room chat field.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/chat_tab.py", "habbpy/gui_dashboard.py _handle_chat"],
      shockless: [
        "docs/DEV_AUTOMATION_API.md window.__engine.dev.sendChat",
        "window.__engine.dev.chatHistory",
        "%APPDATA%/Shockless/logs/shockless-relay.log",
        "src/main/relayLog.ts CHAT/CHAT_2/CHAT_3 decoders",
        "src/renderer/ui/App.tsx runtime room event markers",
      ],
      notes:
        "Clear is display-local like v3's text widget clear; runtime chat history is not mutated. Room entry/clear markers are generated from runtime room-ready transitions. When source chatHistory is empty, the panel falls back to v3-equivalent decoded room chat packets.",
    },
  };
