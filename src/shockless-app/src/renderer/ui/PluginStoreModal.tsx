import React, { useMemo, useState } from "react";
import { FolderInput, Plus, Puzzle, Search, Settings, Trash2, X } from "lucide-react";
import type { PluginDefinition, PluginRegistryState, PluginUiElement } from "../../shared/plugin";
import { PluginIcon, labelCase, originLabel } from "./helpers";
import { UserPluginPanel, type RuntimePluginUiState } from "./UserPluginPanel";
import type { PluginDetailTab } from "./pluginSurfaceGuards";
import type { PluginSchemaActionEvent } from "./PluginSchemaSurface";
import { useDraggablePopout } from "./useDraggablePopout";

interface PluginStoreModalProps {
  readonly open: boolean;
  readonly desktopBridgeAvailable: boolean;
  readonly pluginRegistryState: PluginRegistryState | null;
  readonly availablePlugins: readonly PluginDefinition[];
  readonly selectedPluginId: string;
  readonly pluginEnabledById: Readonly<Record<string, boolean | undefined>>;
  readonly pluginSurfaceEnabledByPluginId: Record<string, Record<string, boolean> | undefined>;
  readonly pinnedPluginIds: ReadonlySet<string>;
  readonly pluginRuntimeUiById: Readonly<Record<string, RuntimePluginUiState | undefined>>;
  readonly pluginManagerMessage: string;
  readonly newPluginId: string;
  readonly newPluginName: string;
  readonly onClose: () => void;
  readonly onSelectPlugin: (pluginId: string) => void;
  readonly onOpenPluginsFolder: () => void;
  readonly onInstallPluginFromFolder: () => void;
  readonly onSetNewPluginId: (value: string) => void;
  readonly onSetNewPluginName: (value: string) => void;
  readonly onCreatePluginFromTemplate: () => void;
  readonly onSetPluginEnabled: (plugin: PluginDefinition, enabled: boolean) => void;
  readonly onSetPluginSurfaceEnabled: (pluginId: string, surfaceId: string, enabled: boolean) => void;
  readonly onUninstallPlugin: (plugin: PluginDefinition) => void;
  readonly onPluginSchemaAction: (event: PluginSchemaActionEvent) => void;
  readonly onRunCommand: (command: string) => void;
}

type PluginStoreFilter = "all" | "enabled" | "client" | "interface" | "room" | "user" | "items" | "automation" | "development" | "errors";

const pluginStoreFilters: readonly { readonly id: PluginStoreFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "client", label: "Client" },
  { id: "interface", label: "Interface" },
  { id: "room", label: "Room" },
  { id: "user", label: "User" },
  { id: "items", label: "Items" },
  { id: "automation", label: "Automation" },
  { id: "development", label: "Development" },
  { id: "enabled", label: "Enabled" },
  { id: "errors", label: "Errors" },
];

export function PluginStoreModal({
  open,
  desktopBridgeAvailable,
  pluginRegistryState,
  availablePlugins,
  selectedPluginId,
  pluginEnabledById,
  pluginSurfaceEnabledByPluginId,
  pinnedPluginIds,
  pluginRuntimeUiById,
  pluginManagerMessage,
  newPluginId,
  newPluginName,
  onClose,
  onSelectPlugin,
  onOpenPluginsFolder,
  onInstallPluginFromFolder,
  onSetNewPluginId,
  onSetNewPluginName,
  onCreatePluginFromTemplate,
  onSetPluginEnabled,
  onSetPluginSurfaceEnabled,
  onUninstallPlugin,
  onPluginSchemaAction,
  onRunCommand,
}: PluginStoreModalProps): React.ReactElement | null {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginStoreFilter>("all");
  const [detailTab, setDetailTab] = useState<PluginDetailTab>("panel");
  const drag = useDraggablePopout(open);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePlugins = useMemo(() => {
    return availablePlugins.filter((plugin) => {
      if (normalizedQuery) return pluginSearchText(plugin, pluginRuntimeUiById[plugin.id]).includes(normalizedQuery);
      return matchesPluginStoreFilter(plugin, filter, pluginEnabledById);
    });
  }, [availablePlugins, filter, normalizedQuery, pluginEnabledById, pluginRuntimeUiById]);
  const selectedPlugin =
    visiblePlugins.find((plugin) => plugin.id === selectedPluginId) ??
    visiblePlugins[0] ??
    (normalizedQuery || filter !== "all" ? null : availablePlugins.find((plugin) => plugin.id === selectedPluginId) ?? availablePlugins[0]) ??
    null;
  const selectedPluginClass = selectedPlugin ? `plugin-detail-${selectedPlugin.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}` : "";
  const filterCounts = useMemo(() => {
    return Object.fromEntries(
      pluginStoreFilters.map((entry) => [
        entry.id,
        availablePlugins.filter((plugin) => matchesPluginStoreFilter(plugin, entry.id, pluginEnabledById)).length,
      ]),
    ) as Readonly<Record<PluginStoreFilter, number>>;
  }, [availablePlugins, pluginEnabledById]);

  if (!open) return null;

  const selectedEnabled = selectedPlugin ? pluginEnabledById[selectedPlugin.id] !== false : false;
  const selectedPinned = selectedPlugin ? pinnedPluginIds.has(selectedPlugin.id) : false;
  const selectedSettingsAvailable = Boolean(selectedPlugin && ((selectedPlugin.ui?.settings?.length ?? 0) > 0 || (pluginRuntimeUiById[selectedPlugin.id]?.settings?.length ?? 0) > 0));

  return (
    <div className="app-popout-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={drag.ref} className="app-popout plugin-store-popout" role="dialog" aria-modal="true" aria-label="Plugins" style={drag.style} onMouseDown={(event) => event.stopPropagation()}>
        <header className="app-popout-header" onPointerDown={drag.onHeaderPointerDown}>
          <div>
            <h2><Puzzle size={17} /> Plugins</h2>
            <p>{pluginManagerMessage || pluginRegistryState?.message || "Manage installed plugins, surfaces, permissions, commands, and user additions."}</p>
          </div>
          <button type="button" className="icon-action" onClick={onClose} aria-label="Close plugins"><X size={16} /></button>
        </header>

        <div className="plugin-store-layout">
          <aside className="plugin-store-sidebar" aria-label="Plugin filters">
            <label className="search-field plugin-store-sidebar-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search plugins..." />
            </label>
            <div className="plugin-store-filter-list">
              {pluginStoreFilters.map((entry) => (
                <button key={entry.id} type="button" className={filter === entry.id ? "active" : ""} onClick={() => setFilter(entry.id)}>
                  <span>{entry.label}</span>
                  <strong>{filterCounts[entry.id] ?? 0}</strong>
                </button>
              ))}
            </div>
            <div className="plugin-store-sidebar-footer">
              <div className="plugin-store-sidebar-actions">
                <button className="wide-action" type="button" disabled={!desktopBridgeAvailable} onClick={() => void onInstallPluginFromFolder()}><Plus size={14} />Install Plugin</button>
                <button className="wide-action" type="button" disabled={!desktopBridgeAvailable} onClick={() => void onOpenPluginsFolder()}><FolderInput size={14} />Plugin Folder</button>
              </div>
              <details className="mini-section create-plugin-card">
                <summary>Create Plugin</summary>
                <label className="field-stack">
                  <span>Plugin Id</span>
                  <input value={newPluginId} onChange={(event) => onSetNewPluginId(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
                </label>
                <label className="field-stack">
                  <span>Name</span>
                  <input value={newPluginName} onChange={(event) => onSetNewPluginName(event.currentTarget.value)} />
                </label>
                <button className="wide-action" type="button" disabled={!desktopBridgeAvailable || !newPluginId.trim()} onClick={() => void onCreatePluginFromTemplate()}><Plus size={14} />Create Template</button>
              </details>
            </div>
          </aside>

          <section className="plugin-store-list-column" aria-label="Installed plugins">
            <div className="plugin-store-section-title">
              <strong>Installed Plugins ({visiblePlugins.length})</strong>
              <span>{availablePlugins.length} total</span>
            </div>
            <div className="plugin-store-list">
              {visiblePlugins.map((plugin) => {
                const enabled = pluginEnabledById[plugin.id] !== false;
                const pinned = pinnedPluginIds.has(plugin.id);
                return (
                  <div
                    key={plugin.id}
                    role="button"
                    tabIndex={0}
                    className={`plugin-store-row ${selectedPlugin?.id === plugin.id ? "active" : ""} ${enabled ? "enabled" : "disabled"}`}
                    onClick={() => {
                      setDetailTab("panel");
                      onSelectPlugin(plugin.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setDetailTab("panel");
                        onSelectPlugin(plugin.id);
                      }
                    }}
                  >
                    <span className="panel-icon"><PluginIcon plugin={plugin} /></span>
                    <span className="plugin-store-row-copy">
                      <strong>{plugin.name}</strong>
                      <small>{plugin.summary}</small>
                    </span>
                    <span className={`store-status-chip ${enabled ? "enabled" : "disabled"}`}>{pinned ? "Pinned" : enabled ? "Enabled" : "Disabled"}</span>
                    <label className="store-row-switch" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={pinned || !desktopBridgeAvailable}
                        onChange={(event) => void onSetPluginEnabled(plugin, event.currentTarget.checked)}
                        aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.name}`}
                      />
                      <span />
                    </label>
                  </div>
                );
              })}
              {visiblePlugins.length === 0 ? <p className="empty-panel-note">No plugins match this search.</p> : null}
            </div>
          </section>

          <article className={`plugin-store-detail ${selectedPluginClass}`} aria-label="Plugin details">
            {selectedPlugin ? (
              <>
                <div className="plugin-store-detail-head">
                  <div className="panel-icon"><PluginIcon plugin={selectedPlugin} /></div>
                  <div>
                    <h3>{selectedPlugin.name}</h3>
                    <p>{selectedPlugin.version ? `v${selectedPlugin.version}` : "Bundled"} by {selectedPlugin.author || originLabel(selectedPlugin.origin ?? "built-in")}</p>
                  </div>
                  <span className={`store-status-chip ${selectedEnabled ? "enabled" : "disabled"}`}>{selectedPinned ? "Pinned" : selectedEnabled ? "Enabled" : "Disabled"}</span>
                </div>

                <p className="plugin-store-detail-summary">{selectedPlugin.summary}</p>

                <div className="plugin-detail-main plugin-detail-workspace">
                  <section className="plugin-detail-page" aria-label="Selected plugin page">
                    <UserPluginPanel
                      selectedPlugin={selectedPlugin}
                      runtimeUi={pluginRuntimeUiById[selectedPlugin.id] ?? null}
                      pluginEnabled={selectedEnabled}
                      surfaceEnabledById={pluginSurfaceEnabledByPluginId[selectedPlugin.id]}
                      activeTab={detailTab}
                      onActiveTabChange={setDetailTab}
                      onPluginSchemaAction={onPluginSchemaAction}
                      onRunCommand={onRunCommand}
                    />
                  </section>

                  <section className="plugin-feature-card" aria-label="Plugin features">
                    <div className="plugin-feature-card-head">
                      <h4>Surfaces</h4>
                      <span>{selectedPlugin.uiSurfaces.length} feature{selectedPlugin.uiSurfaces.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="plugin-store-surface-list">
                      {selectedPlugin.uiSurfaces.length > 0 ? selectedPlugin.uiSurfaces.map((surface) => (
                        <label className="toggle-row checkbox-first-row" key={surface.id}>
                          <input
                            type="checkbox"
                            checked={pluginSurfaceEnabledByPluginId[selectedPlugin.id]?.[surface.id] ?? surface.enabledByDefault}
                            disabled={!desktopBridgeAvailable || pluginEnabledById[selectedPlugin.id] === false}
                            onChange={(event) => void onSetPluginSurfaceEnabled(selectedPlugin.id, surface.id, event.currentTarget.checked)}
                          />
                          <span>
                            <strong>{surface.label}</strong>
                            <small>{labelCase(surface.kind)} / {surface.summary}</small>
                          </span>
                        </label>
                      )) : <p className="empty-panel-note">No toggleable surfaces declared.</p>}
                    </div>
                  </section>
                </div>
                <footer className="plugin-detail-actions">
                  <button className="wide-action" type="button" disabled={!selectedSettingsAvailable} onClick={() => setDetailTab("settings")}><Settings size={14} />Settings</button>
                  <button
                    className={`wide-action ${selectedEnabled ? "warning-action" : "primary-action"}`}
                    type="button"
                    disabled={selectedPinned || !desktopBridgeAvailable}
                    onClick={() => void onSetPluginEnabled(selectedPlugin, !selectedEnabled)}
                  >
                    {selectedEnabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="wide-action danger-action"
                    type="button"
                    disabled={!desktopBridgeAvailable || selectedPlugin.origin !== "user"}
                    title={selectedPlugin.origin === "user" ? "Remove this installed addon folder" : "Only user-installed addons can be removed"}
                    aria-label={`Remove addon ${selectedPlugin.name}`}
                    onClick={() => void onUninstallPlugin(selectedPlugin)}
                  >
                    <Trash2 size={14} />Remove Addon
                  </button>
                </footer>
              </>
            ) : null}
          </article>
        </div>
        <div className="app-popout-resize-handle" role="presentation" onPointerDown={drag.onResizePointerDown} />
      </section>
    </div>
  );
}

function matchesPluginStoreFilter(plugin: PluginDefinition, filter: PluginStoreFilter, enabledById: Readonly<Record<string, boolean | undefined>>): boolean {
  const enabled = enabledById[plugin.id] !== false;
  switch (filter) {
    case "all": return true;
    case "enabled": return enabled;
    case "client": return plugin.category === "session";
    case "interface": return plugin.category === "core";
    case "room": return plugin.category === "room";
    case "user": return plugin.category === "user" || plugin.category === "social";
    case "items": return plugin.category === "inventory";
    case "automation": return plugin.category === "automation";
    case "development": return plugin.category === "developer";
    case "errors": return Boolean(plugin.loadError);
  }
}

function pluginSearchText(plugin: PluginDefinition, runtimeUi?: RuntimePluginUiState): string {
  const uiText = [
    ...flattenElements(plugin.ui?.preview ?? []),
    ...flattenElements(plugin.ui?.settings ?? []),
    ...plugin.uiSurfaces.flatMap((surface) => [surface.id, surface.label, surface.kind, surface.summary, ...flattenElements(surface.layout ?? [])]),
    ...flattenElements(runtimeUi?.preview ?? []),
    ...flattenElements(runtimeUi?.settings ?? []),
    ...Object.values(runtimeUi?.surfaces ?? {}).flatMap((layout) => flattenElements(layout)),
  ];
  return [
    plugin.id,
    plugin.name,
    plugin.category,
    plugin.summary,
    plugin.status,
    plugin.origin ?? "built-in",
    ...(plugin.capabilities ?? []),
    ...(plugin.permissions ?? []),
    ...(plugin.commands ?? []).flatMap((command) => [command.name, command.label ?? "", command.description, command.usage ?? "", ...(command.aliases ?? [])]),
    ...(plugin.hotkeys ?? []).flatMap((hotkey) => [hotkey.key, hotkey.command, hotkey.label ?? ""]),
    ...uiText,
  ].join(" ").toLowerCase();
}

function flattenElements(elements: readonly PluginUiElement[]): readonly string[] {
  const values: string[] = [];
  for (const element of elements) {
    values.push(element.type);
    if ("label" in element && element.label) values.push(element.label);
    if ("description" in element && element.description) values.push(element.description);
    if ("text" in element && element.text) values.push(element.text);
    if ("title" in element && element.title) values.push(element.title);
    if (element.type === "section") values.push(...flattenElements(element.children));
    if (element.type === "buttonGrid") values.push(...flattenElements(element.buttons));
    if (element.type === "table") {
      values.push(...element.columns.flatMap((column) => [column.key, column.label]));
      values.push(...element.rows.flatMap((row) => Object.values(row).map(String)));
    }
    if (element.type === "kv") values.push(...element.rows.flatMap((row) => [row.key, String(row.value ?? "")]));
    if (element.type === "log") values.push(...element.rows);
  }
  return values;
}
