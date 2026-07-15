import type { PluginDefinition } from "../../shared/plugin.js";

export const floorItemAnywherePlugin: PluginDefinition = {
  id: "floor-item-anywhere",
  name: "Floor Item Anywhere",
  category: "automation",
  icon: "sofa",
  enabledByDefault: false,
  status: "ready",
  summary: "Let Habbo's native floor item mover place items outside visible room tiles.",
  capabilities: [
    "Native floor item drag/drop remains the placement flow",
    "Off-room cursor positions are projected onto the same floor coordinate plane",
    "Dragged floor items switch from faded to valid while outside visible floor bounds",
    "Synthetic off-room move commits use Origins' source precise floor-location packet",
    "Reusable furni.setAnywherePlacementEnabled API for custom plugins",
    "Reusable furni.setFloorItemLocation API for explicit precise floor moves",
  ],
  permissions: ["ui.panel", "engine.control", "actions.furni"],
  uiSurfaces: [
    {
      id: "panel",
      kind: "panel",
      label: "Floor Item Anywhere Panel",
      enabledByDefault: true,
      summary: "Native Object Mover compatibility toggle and status.",
    },
  ],
  sourceMapping: {
    habbpyV3: ["habbpy/tabs/wallmover_tab.py", "habbpy/wallmover.py"],
    shockless: [
      "engine/src/habbo/floorItemAnywhereCompatibility.ts",
      "src/renderer/ui/App.tsx floor-item-anywhere runtime flag sync",
      "src/renderer/userPluginHost.ts furni.setAnywherePlacementEnabled",
      "src/shared/furniRelayPackets.ts ORIGINS_SET_FURNI_LOCATION relay builder",
    ],
    notes:
      "This plugin toggles a narrow runtime compatibility hook so Object Mover treats projected off-room floor coordinates as valid while enabled. If the source mover commits one of those projected coordinates, the hook rewrites that single MOVESTUFF commit to the same ORIGINS_SET_FURNI_LOCATION packet used by Habbo's precise mover.",
  },
};
