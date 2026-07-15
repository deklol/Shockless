import type { AppState } from "../shared/session";
import { createInitialPluginEnabledState, createInitialPluginUiSurfaceState } from "./shellStore";

export const initialAppState: AppState = {
  engine: {
    running: false,
    embedded: false,
    profileLabel: "No Shockless profile attached",
    buildLabel: "Waiting for engine",
    location: "Shell ready",
    fps: null,
    tickRate: null,
    latencyMs: null,
    errors: 0,
  },
  account: {
    name: "-",
    badge: "-",
    credits: null,
    clubDays: null,
  },
  room: {
    id: "-",
    name: "No room",
    owner: "-",
    type: "unknown",
    users: 0,
    floorItems: 0,
    wallItems: 0,
  },
  ui: {
    // Start with the plugin dock CLOSED — no panel opens on launch. Clicking an icon
    // opens it; clicking the open icon closes it (see onSelectPlugin in App.tsx).
    dockCollapsed: true,
  },
  plugins: {
    enabledById: createInitialPluginEnabledState(),
    uiSurfaceEnabledByPluginId: createInitialPluginUiSurfaceState(),
  },
  selectedPluginId: "connection",
  commandTimeline: [
    {
      id: "boot",
      time: "local",
      severity: "info",
      message: "Shockless shell initialized. Embedded profile launch is the next milestone.",
    },
  ],
};
