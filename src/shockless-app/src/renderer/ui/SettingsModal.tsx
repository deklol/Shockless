import React, { useMemo, useState } from "react";
import { Search, Settings, X } from "lucide-react";
import type { PluginDefinition, PluginUiElement } from "../../shared/plugin";
import { PluginSchemaSurface, type PluginSchemaActionEvent } from "./PluginSchemaSurface";
import { useDraggablePopout } from "./useDraggablePopout";

interface SettingsModalProps {
  readonly open: boolean;
  readonly layout: readonly PluginUiElement[];
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
  readonly onClose: () => void;
  readonly onAction: (event: PluginSchemaActionEvent) => void;
}

interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly layout: readonly PluginUiElement[];
  readonly controlCount: number;
}

const settingsSurfacePlugin: PluginDefinition = {
  id: "app-settings",
  name: "Settings",
  category: "core",
  icon: "settings",
  enabledByDefault: true,
  status: "ready",
  summary: "Global Shockless app settings.",
  capabilities: ["Interface", "Engine", "Performance", "Console", "Hotkeys", "Session defaults"],
  uiSurfaces: [],
  sourceMapping: { habbpyV3: ["App settings"], shockless: ["App shell"] },
  origin: "built-in",
  core: true,
};

export function SettingsModal({ open, layout, values, onClose, onAction }: SettingsModalProps): React.ReactElement | null {
  const [query, setQuery] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("hotkeys");
  const drag = useDraggablePopout(open);
  const sections = useMemo(() => buildSettingsSections(layout), [layout]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSections = useMemo(
    () => sections.filter((section) => !normalizedQuery || settingsSectionSearchText(section).includes(normalizedQuery)),
    [normalizedQuery, sections],
  );
  const selectedSection =
    visibleSections.find((section) => section.id === selectedSectionId) ??
    visibleSections.find((section) => section.id === "hotkeys") ??
    visibleSections[0] ??
    (normalizedQuery ? null : sections.find((section) => section.id === selectedSectionId) ?? sections[0]) ??
    null;

  if (!open) return null;
  return (
    <div className="app-popout-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={drag.ref} className="app-popout plugin-store-popout settings-popout" role="dialog" aria-modal="true" aria-label="Settings" style={drag.style} onMouseDown={(event) => event.stopPropagation()}>
        <header className="app-popout-header" onPointerDown={drag.onHeaderPointerDown}>
          <div>
            <h2><Settings size={18} /> Settings</h2>
            <p>Global app, engine, performance, console, hotkey, and session defaults.</p>
          </div>
          <button type="button" className="icon-action" onClick={onClose} aria-label="Close settings"><X size={16} /></button>
        </header>

        <div className="plugin-store-layout settings-store-layout">
          <aside className="plugin-store-sidebar settings-store-sidebar" aria-label="Settings categories">
            <label className="search-field plugin-store-sidebar-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search settings..." />
            </label>
            <div className="plugin-store-filter-list">
              {visibleSections.map((section) => (
                <button key={section.id} type="button" className={selectedSection?.id === section.id ? "active" : ""} onClick={() => setSelectedSectionId(section.id)}>
                  <span>{section.title}</span>
                  <strong>{section.controlCount}</strong>
                </button>
              ))}
            </div>
          </aside>


          <article className="plugin-store-detail settings-store-detail" aria-label="Settings detail">
            {selectedSection ? (
              <>
                <div className="plugin-store-detail-head">
                  <div className="panel-icon"><Settings size={16} /></div>
                  <div>
                    <h3>{selectedSection.title}</h3>
                    <p>{selectedSection.description || "Schema-rendered application settings."}</p>
                  </div>
                  <span className="store-status-chip enabled">{selectedSection.controlCount} Controls</span>
                </div>
                <PluginSchemaSurface plugin={settingsSurfacePlugin} surfaceId={selectedSection.id} layout={selectedSection.layout} values={values} onAction={onAction} />
              </>
            ) : null}
          </article>
        </div>
        <div className="app-popout-resize-handle" role="presentation" onPointerDown={drag.onResizePointerDown} />
      </section>
    </div>
  );
}

function buildSettingsSections(layout: readonly PluginUiElement[]): readonly SettingsSection[] {
  return layout.map((element, index) => {
    if (element.type === "section") {
      const title = element.title?.trim() || `Section ${index + 1}`;
      const id = element.id || slug(title) || `section-${index + 1}`;
      return {
        id,
        title,
        description: element.description ?? "",
        layout: element.children,
        controlCount: countControls(element.children),
      };
    }
    const title = element.label || ("title" in element ? element.title : "") || "General";
    return {
      id: element.id || slug(title) || `section-${index + 1}`,
      title,
      description: element.description ?? "",
      layout: [element],
      controlCount: countControls([element]),
    };
  });
}

function settingsSectionSearchText(section: SettingsSection): string {
  return [section.id, section.title, section.description, ...flattenElements(section.layout)].join(" ").toLowerCase();
}

function countControls(elements: readonly PluginUiElement[]): number {
  let count = 0;
  for (const element of elements) {
    if (["button", "toggle", "checkbox", "textInput", "textArea", "numberInput", "slider", "colorInput", "select", "keybind"].includes(element.type)) count += 1;
    if (element.type === "section") count += countControls(element.children);
    if (element.type === "buttonGrid") count += countControls(element.buttons);
  }
  return count;
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
