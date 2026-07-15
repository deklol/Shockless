import React, { useMemo, useState } from "react";
import type { PluginDefinition, PluginUiElement } from "../../shared/plugin";
import type { RuntimePluginUiState } from "../features/plugins/runtimeUiState";
import { PluginSchemaSurface, type PluginSchemaActionEvent } from "./PluginSchemaSurface";
import { firstEnabledPanelSurface, pluginDetailTabs, type PluginDetailTab } from "./pluginSurfaceGuards";

interface UserPluginPanelProps {
  readonly selectedPlugin: PluginDefinition;
  readonly runtimeUi?: RuntimePluginUiState | null;
  readonly pluginEnabled?: boolean;
  readonly surfaceEnabledById?: Readonly<Record<string, boolean | undefined>> | null;
  readonly onPluginSchemaAction?: (event: PluginSchemaActionEvent) => void;
  readonly onRunCommand?: (command: string) => void;
  readonly activeTab?: PluginDetailTab;
  readonly onActiveTabChange?: (tab: PluginDetailTab) => void;
}

export type { RuntimePluginUiState } from "../features/plugins/runtimeUiState";

export function UserPluginPanel({
  selectedPlugin,
  runtimeUi,
  pluginEnabled = true,
  surfaceEnabledById,
  onPluginSchemaAction,
  onRunCommand,
  activeTab: controlledActiveTab,
  onActiveTabChange,
}: UserPluginPanelProps): React.ReactElement {
  const firstPanelSurface = firstEnabledPanelSurface(selectedPlugin, surfaceEnabledById, pluginEnabled);
  const panelLayout = firstPanelSurface ? runtimeUi?.surfaces?.[firstPanelSurface.id] ?? firstPanelSurface.layout ?? [] : [];
  const previewLayout = runtimeUi?.preview ?? selectedPlugin.ui?.preview ?? defaultPreviewLayout(selectedPlugin);
  const settingsLayout = runtimeUi?.settings ?? selectedPlugin.ui?.settings ?? [];
  const availableTabs = useMemo<PluginDetailTab[]>(() => {
    return [...pluginDetailTabs(selectedPlugin, {
      pluginEnabled,
      surfaceEnabledById,
      panelLayoutLength: panelLayout.length,
      settingsLayoutLength: settingsLayout.length,
    })];
  }, [panelLayout.length, pluginEnabled, selectedPlugin, settingsLayout.length, surfaceEnabledById]);
  const [localActiveTab, setLocalActiveTab] = useState<PluginDetailTab>("panel");
  const requestedTab = controlledActiveTab ?? localActiveTab;
  const tab = availableTabs.includes(requestedTab) ? requestedTab : availableTabs[0];
  const selectTab = (entry: PluginDetailTab) => {
    setLocalActiveTab(entry);
    onActiveTabChange?.(entry);
  };

  return (
    <div className="runtime-panel user-plugin-panel plugin-detail-panel">
      <div className="plugin-detail-tabs" role="tablist" aria-label={`${selectedPlugin.name} pages`}>
        {availableTabs.map((entry) => (
          <button key={entry} type="button" className={entry === tab ? "active" : ""} onClick={() => selectTab(entry)}>
            {labelCase(entry)}
          </button>
        ))}
      </div>

      {tab === "preview" ? (
        <PluginSchemaSurface
          plugin={selectedPlugin}
          surfaceId="preview"
          layout={previewLayout}
          values={runtimeUi?.values}
          onAction={onPluginSchemaAction}
          onRunCommand={pluginEnabled ? onRunCommand : undefined}
        />
      ) : null}

      {tab === "settings" ? (
        <PluginSchemaSurface
          plugin={selectedPlugin}
          surfaceId="settings"
          layout={settingsLayout}
          values={runtimeUi?.values}
          emptyMessage="This plugin has no custom settings page."
          onAction={onPluginSchemaAction}
          onRunCommand={pluginEnabled ? onRunCommand : undefined}
        />
      ) : null}

      {tab === "panel" && firstPanelSurface ? (
        <PluginSchemaSurface
          plugin={selectedPlugin}
          surfaceId={firstPanelSurface.id}
          layout={panelLayout}
          values={runtimeUi?.values}
          emptyMessage="This panel is enabled, but no custom layout is declared."
          onAction={onPluginSchemaAction}
          onRunCommand={pluginEnabled ? onRunCommand : undefined}
        />
      ) : null}

      {tab === "commands" ? <CommandsAndHotkeys plugin={selectedPlugin} /> : null}
    </div>
  );
}

function CommandsAndHotkeys({ plugin }: { readonly plugin: PluginDefinition }): React.ReactElement {
  return (
    <div className="mini-section">
      <h3>Commands</h3>
      <div className="mini-table">
        {(plugin.commands ?? []).map((command) => (
          <p key={command.name}>
            <span>{command.label ?? command.name}</span>
            <strong>{command.usage || command.description}</strong>
          </p>
        ))}
        {(plugin.commands?.length ?? 0) === 0 ? <p><span>Commands</span><strong>No commands declared.</strong></p> : null}
      </div>
      <h3>Hotkeys</h3>
      <div className="mini-table">
        {(plugin.hotkeys ?? []).map((hotkey) => (
          <p key={hotkey.id ?? `${hotkey.key}:${hotkey.command}`}>
            <span>{hotkey.key}</span>
            <strong>{hotkey.command}</strong>
          </p>
        ))}
        {(plugin.hotkeys?.length ?? 0) === 0 ? <p><span>Hotkeys</span><strong>No hotkeys declared.</strong></p> : null}
      </div>
    </div>
  );
}

function defaultPreviewLayout(plugin: PluginDefinition): readonly PluginUiElement[] {
  return [
    { type: "header", text: plugin.name, level: 3 },
    { type: "text", text: plugin.summary },
    {
      type: "kv",
      rows: [
        { key: "Status", value: statusLabel(plugin.status) },
        { key: "Version", value: plugin.version ?? "-" },
        { key: "Author", value: plugin.author ?? "-" },
        { key: "Category", value: labelCase(plugin.category) },
      ],
    },
    { type: "notice", tone: "info", title: "Custom UI", text: "Add ui.preview, ui.settings, or surface layout entries in shockless.plugin.json to replace this generated preview." },
  ];
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

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
    case "error":
      return "Error";
    default:
      return labelCase(status);
  }
}
