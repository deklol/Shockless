import type { PluginDefinition } from "../../shared/plugin.js";

export const roomPlugin: PluginDefinition = {
    id: "room",
    name: "Room",
    category: "room",
    icon: "map",
    enabledByDefault: false,
    status: "mapped",
    summary: "Room details, heightmap, users, furni, overlays, and chat tail.",
    capabilities: [
      "Room info and owner/layout facts",
      "Private and public room entry",
      "Walk/stage click test controls",
      "Heightmap and compact map overlay",
      "Room users and status",
      "Floor and wall item summaries",
      "Room chat log",
    ],
    uiSurfaces: [
      {
        id: "panel",
        kind: "panel",
        label: "Room Panel",
        enabledByDefault: true,
        summary: "Room facts, entry controls, walk/stage click, users, heightmap, item counts, and chat tail.",
      },
      {
        id: "overlay",
        kind: "overlay",
        label: "Room Overlay",
        enabledByDefault: true,
        summary: "Optional room labels and hover hints above the game.",
      },
      {
        id: "status",
        kind: "status",
        label: "Room Status",
        enabledByDefault: true,
        summary: "Current room summary in the bottom strip.",
      },
    ],
    sourceMapping: {
      habbpyV3: ["habbpy/tabs/room_tab.py", "habbpy/heightmap_3d.py", "habbpy/shockwave_parser.py"],
      shockless: ["docs/DEV_AUTOMATION_API.md", "docs/REMOTE_PLAY_API.md", "window.__engine.dev.stageClick"],
    },
  };
