import type { PluginDefinition, PluginUiDefinition, PluginUiElement, PluginUiSurface } from "./plugin.js";

export function withPluginSchemaDefaults(plugin: PluginDefinition): PluginDefinition {
  const preview = plugin.ui?.preview && plugin.ui.preview.length > 0 ? plugin.ui.preview : defaultPreviewLayout(plugin);
  const settings = plugin.ui?.settings;
  const ui: PluginUiDefinition = settings && settings.length > 0 ? { preview, settings } : { preview };
  return {
    ...plugin,
    ui,
    uiSurfaces: plugin.uiSurfaces.map((surface) => ({
      ...surface,
      layout: surface.layout && surface.layout.length > 0 ? surface.layout : defaultSurfaceLayout(plugin, surface),
    })),
  };
}

export function defaultPreviewLayout(plugin: PluginDefinition): readonly PluginUiElement[] {
  const rows = [
    { key: "Status", value: labelCase(plugin.status) },
    { key: "Category", value: labelCase(plugin.category) },
    { key: "Surfaces", value: plugin.uiSurfaces.length },
    { key: "Permissions", value: plugin.permissions?.length ?? 0 },
  ];
  return [
    { type: "header", text: plugin.name, level: 3 },
    { type: "text", text: plugin.summary },
    { type: "kv", rows },
    capabilitiesTable(plugin),
  ];
}

function defaultSurfaceLayout(plugin: PluginDefinition, surface: PluginUiSurface): readonly PluginUiElement[] {
  const base: PluginUiElement[] = [
    { type: "header", text: surface.label || plugin.name, level: 3 },
    { type: "text", text: surface.summary || plugin.summary },
  ];

  if (surface.kind === "commands") {
    return [
      ...base,
      commandTable(plugin),
      hotkeyTable(plugin),
      plugin.commands?.length ? { type: "notice", tone: "info", text: "Commands are routed through the Shockless command registry or backtick console." } : { type: "text", tone: "default", text: "No commands declared for this plugin." },
    ];
  }

  if (surface.kind === "panel") {
    return [
      ...base,
      capabilitiesTable(plugin),
      commandTable(plugin),
      { type: "notice", tone: "info", text: "This panel is schema-rendered from the plugin definition. Add ui.preview, ui.settings, or surface layout entries to customize it." },
    ];
  }

  return [
    ...base,
    {
      type: "kv",
      rows: [
        { key: "Kind", value: labelCase(surface.kind) },
        { key: "Default", value: surface.enabledByDefault ? "Enabled" : "Disabled" },
        { key: "Plugin", value: plugin.name },
      ],
    },
  ];
}

function capabilitiesTable(plugin: PluginDefinition): PluginUiElement {
  return {
    type: "table",
    label: "Capabilities",
    columns: [{ key: "capability", label: "Capability" }],
    rows: plugin.capabilities.length > 0
      ? plugin.capabilities.map((capability) => ({ capability }))
      : [{ capability: "No capabilities declared." }],
  };
}

function commandTable(plugin: PluginDefinition): PluginUiElement {
  return {
    type: "table",
    label: "Commands",
    columns: [
      { key: "name", label: "Command" },
      { key: "usage", label: "Usage" },
      { key: "description", label: "Description" },
    ],
    rows: (plugin.commands ?? []).length > 0
      ? (plugin.commands ?? []).map((command) => ({
          name: command.label ?? command.name,
          usage: command.usage ?? command.name,
          description: command.description,
        }))
      : [{ name: "-", usage: "-", description: "No commands declared." }],
  };
}

function hotkeyTable(plugin: PluginDefinition): PluginUiElement {
  return {
    type: "table",
    label: "Hotkeys",
    columns: [
      { key: "key", label: "Key" },
      { key: "command", label: "Command" },
      { key: "label", label: "Label" },
    ],
    rows: (plugin.hotkeys ?? []).length > 0
      ? (plugin.hotkeys ?? []).map((hotkey) => ({
          key: hotkey.key,
          command: hotkey.command,
          label: hotkey.label ?? "-",
        }))
      : [{ key: "-", command: "-", label: "No hotkeys declared." }],
  };
}

function labelCase(value: string): string {
  if (!value) return "";
  return value
    .replace(/([A-Z])/g, " $1")
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}
