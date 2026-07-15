import type { PluginDefinition } from "../../shared/plugin.js";

export const wallItemAnywherePlugin: PluginDefinition = {
  id: "wall-item-anywhere",
  name: "Wall Item Anywhere",
  category: "automation",
  icon: "hammer",
  enabledByDefault: false,
  status: "ready",
  summary: "Let Habbo's native wall item mover place items outside visible wall bounds.",
  capabilities: [
    "Native wall item drag/drop remains the placement flow",
    "Off-wall cursor positions are treated as valid wall item locations",
    "Dragged wall items switch from faded to valid while outside the visible wall",
    "Reusable wallItems.setAnywherePlacementEnabled API for custom plugins",
  ],
  permissions: ["ui.panel", "engine.control", "actions.wallItems"],
  uiSurfaces: [
    {
      id: "panel",
      kind: "panel",
      label: "Wall Item Anywhere Panel",
      enabledByDefault: true,
      summary: "Native Object Mover compatibility toggle and status.",
    },
  ],
  sourceMapping: {
    habbpyV3: ["habbpy/tabs/wallmover_tab.py", "habbpy/wallmover.py"],
    shockless: [
      "engine/src/habbo/wallItemAnywhereCompatibility.ts",
      "src/renderer/ui/App.tsx wall-item-anywhere runtime flag sync",
      "src/renderer/userPluginHost.ts wallItems.setAnywherePlacementEnabled",
    ],
    notes:
      "This plugin does not send a separate placement packet. It toggles a narrow runtime compatibility hook so Object Mover produces a normal itemLocStr for off-wall cursor positions.",
  },
};
