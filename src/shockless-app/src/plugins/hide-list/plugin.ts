import type { PluginDefinition } from "../../shared/plugin.js";

export const hideListPlugin: PluginDefinition = {
  id: "hide-list",
  name: "Hide List",
  category: "user",
  icon: "user",
  enabledByDefault: false,
  status: "ready",
  summary: "Hide selected users by Habbo name or account id and ignore their room chat locally.",
  capabilities: [
    "Persistent username/account id block list",
    "Optional reason per hidden user",
    "Hide matching avatar sprites in the rendered room",
    "Filter matching say, shout, and whisper chat from Shockless chat history",
    "Reusable filters.setHiddenUsers API for custom plugins",
  ],
  permissions: ["ui.panel", "engine.control", "engine.snapshot", "events.room", "events.chat", "storage"],
  uiSurfaces: [
    {
      id: "panel",
      kind: "panel",
      label: "Hide List Panel",
      enabledByDefault: true,
      summary: "Add, remove, and clear locally hidden users.",
    },
  ],
  sourceMapping: {
    habbpyV3: ["New Shockless-native plugin; no direct Habbpy v3 tab equivalent."],
    shockless: [
      "src/renderer/ui/App.tsx hide-list schema panel",
      "src/renderer/userPluginHost.ts filters hidden-user APIs",
      "engine/src/app/main.ts setHiddenUserFilter and manual hidden channel collector",
      "engine/src/habbo/userNameLabels.ts room user list helpers",
    ],
    notes:
      "Hide List persists its user/reason records through schema values. The engine receives only target names/ids and filters local rendering/chat while the plugin is enabled.",
  },
};
