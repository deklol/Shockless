import React, { useEffect, useMemo, useState } from "react";
import type { PluginDefinition, PluginUiElement } from "../../shared/plugin";
import type { PluginSchemaActionEvent } from "../features/plugins/schemaAction";

export type { PluginSchemaActionEvent } from "../features/plugins/schemaAction";

interface PluginSchemaSurfaceProps {
  readonly plugin: PluginDefinition;
  readonly surfaceId: string;
  readonly layout: readonly PluginUiElement[];
  readonly values?: Readonly<Record<string, string | number | boolean | null>>;
  readonly emptyMessage?: string;
  readonly onAction?: (event: PluginSchemaActionEvent) => void;
  readonly onRunCommand?: (command: string) => void;
}

export function PluginSchemaSurface({
  plugin,
  surfaceId,
  layout,
  values,
  emptyMessage = "This plugin has not declared a custom surface yet.",
  onAction,
  onRunCommand,
}: PluginSchemaSurfaceProps): React.ReactElement {
  const defaults = useMemo(() => collectDefaultValues(layout), [layout]);
  const [localValues, setLocalValues] = useState<Readonly<Record<string, string | number | boolean | null>>>({ ...defaults, ...(values ?? {}) });

  useEffect(() => {
    setLocalValues((current) => ({ ...defaults, ...current, ...(values ?? {}) }));
  }, [defaults, values]);

  const emitAction = (element: PluginUiElement, value?: string | number | boolean | null) => {
    const elementId = "id" in element && typeof element.id === "string" ? element.id : undefined;
    const action = "action" in element && typeof element.action === "string" && element.action ? element.action : elementId ?? element.type;
    const command = "command" in element && typeof element.command === "string" && element.command ? element.command : undefined;
    if (command) onRunCommand?.(command);
    onAction?.({ pluginId: plugin.id, surfaceId, action, elementId, value, command });
  };

  const setValue = (element: PluginUiElement, value: string | number | boolean | null) => {
    const elementId = "id" in element && typeof element.id === "string" ? element.id : "";
    if (!elementId) return;
    setLocalValues((current) => ({ ...current, [elementId]: value }));
    emitAction(element, value);
  };

  if (layout.length === 0) {
    return <p className="empty-panel-note">{emptyMessage}</p>;
  }

  return <div className="plugin-schema-surface">{layout.map((element, index) => renderElement(element, index, localValues, setValue, emitAction))}</div>;
}

function renderElement(
  element: PluginUiElement,
  index: number,
  values: Readonly<Record<string, string | number | boolean | null>>,
  setValue: (element: PluginUiElement, value: string | number | boolean | null) => void,
  emitAction: (element: PluginUiElement, value?: string | number | boolean | null) => void,
): React.ReactElement {
  const key = `${element.type}:${"id" in element ? element.id ?? index : index}`;
  switch (element.type) {
    case "header": {
      const Tag = element.level === 2 ? "h2" : element.level === 4 ? "h4" : "h3";
      return <Tag key={key} className="plugin-schema-header">{element.text}</Tag>;
    }
    case "text":
      return <p key={key} className={`plugin-schema-text ${element.tone ?? "default"}`}>{element.text}</p>;
    case "divider":
      return <hr key={key} className="plugin-schema-divider" />;
    case "section":
      return (
        <section key={key} className="mini-section plugin-schema-section">
          {element.title ? <h3>{element.title}</h3> : null}
          {element.description ? <p className="runtime-message">{element.description}</p> : null}
          {element.children.map((child, childIndex) => renderElement(child, childIndex, values, setValue, emitAction))}
        </section>
      );
    case "notice":
      return (
        <div key={key} className={`plugin-schema-notice ${element.tone ?? "default"}`}>
          {element.title ? <strong>{element.title}</strong> : null}
          <span>{element.text}</span>
        </div>
      );
    case "button":
      return (
        <button key={key} type="button" className={`wide-action plugin-schema-button ${element.variant ?? "default"}`} onClick={() => emitAction(element)}>
          {element.label}
        </button>
      );
    case "buttonGrid": {
      const columns = Math.max(1, Math.min(6, Math.trunc(element.columns ?? 2)));
      return (
        <div key={key} className="plugin-schema-button-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {element.buttons.map((button, buttonIndex) => renderElement(button, buttonIndex, values, setValue, emitAction))}
        </div>
      );
    }
    case "toggle":
    case "checkbox": {
      const checked = Boolean(values[element.id] ?? element.defaultValue ?? false);
      return (
        <label key={key} className="toggle-row checkbox-first-row plugin-schema-control">
          <input type="checkbox" checked={checked} onChange={(event) => setValue(element, event.currentTarget.checked)} />
          <span>
            <strong>{element.label}</strong>
            {element.description ? <small>{element.description}</small> : null}
          </span>
        </label>
      );
    }
    case "textInput":
    case "keybind": {
      const value = String(values[element.id] ?? element.defaultValue ?? "");
      return (
        <label key={key} className="field-stack plugin-schema-control">
          <span>{element.label}</span>
          <input value={value} placeholder={element.type === "textInput" ? element.placeholder : undefined} onChange={(event) => setValue(element, event.currentTarget.value)} />
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "textArea": {
      const value = String(values[element.id] ?? element.defaultValue ?? "");
      return (
        <label key={key} className="field-stack plugin-schema-control plugin-schema-textarea-control">
          <span>{element.label}</span>
          <textarea
            value={value}
            rows={Math.max(2, Math.min(20, Math.trunc(element.rows ?? 6)))}
            placeholder={element.placeholder}
            className={element.monospace === false ? undefined : "monospace"}
            spellCheck={false}
            onChange={(event) => setValue(element, event.currentTarget.value)}
          />
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "numberInput": {
      const value = String(values[element.id] ?? element.defaultValue ?? 0);
      return (
        <label key={key} className="field-stack plugin-schema-control">
          <span>{element.label}</span>
          <input
            type="number"
            value={value}
            min={element.min}
            max={element.max}
            step={element.step}
            onChange={(event) => setValue(element, Number(event.currentTarget.value))}
          />
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "slider": {
      const min = Number.isFinite(element.min) ? element.min : 0;
      const max = Number.isFinite(element.max) ? element.max : 100;
      const step = Number.isFinite(element.step) && element.step ? element.step : 1;
      const value = numericControlValue(values[element.id], element.defaultValue ?? min, min, max);
      return (
        <label key={key} className="field-stack plugin-schema-control plugin-schema-slider-control">
          <span>{element.label} <strong>{value}</strong></span>
          <input
            type="range"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(event) => setValue(element, Number(event.currentTarget.value))}
          />
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "colorInput": {
      const value = colorControlValue(values[element.id], element.defaultValue);
      return (
        <label key={key} className="field-stack plugin-schema-control plugin-schema-color-control">
          <span>{element.label}</span>
          <span className="plugin-schema-color-row">
            <input type="color" value={value} onChange={(event) => setValue(element, event.currentTarget.value.toLowerCase())} />
            <code>{value}</code>
          </span>
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "select": {
      const value = String(values[element.id] ?? element.defaultValue ?? element.options[0]?.value ?? "");
      return (
        <label key={key} className="field-stack plugin-schema-control">
          <span>{element.label}</span>
          <select value={value} onChange={(event) => setValue(element, event.currentTarget.value)}>
            {element.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {element.description ? <small>{element.description}</small> : null}
        </label>
      );
    }
    case "table": {
      const rows = element.maxRows ? element.rows.slice(0, Math.max(0, element.maxRows)) : element.rows;
      return (
        <div key={key} className="plugin-schema-table-wrap">
          {element.label ? <h3>{element.label}</h3> : null}
          <table className="plugin-schema-table">
            <thead>
              <tr>{element.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const rowKey = element.rowKey ? compactValue(row[element.rowKey]) : "";
                const selected = Boolean(rowKey && element.selectedRowKey && rowKey === element.selectedRowKey);
                const clickable = Boolean(element.rowAction && rowKey);
                return (
                  <tr
                    key={rowKey || rowIndex}
                    className={`${clickable ? "selectable" : ""} ${selected ? "selected" : ""}`}
                    onClick={clickable ? () => emitAction({ type: "button", label: element.label ?? "Select", action: element.rowAction }, rowKey) : undefined}
                  >
                    {element.columns.map((column) => <td key={column.key}>{compactValue(row[column.key])}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }
    case "kv":
      return (
        <div key={key} className="mini-table plugin-schema-kv">
          {element.rows.map((row) => <p key={row.key}><span>{row.key}</span><strong>{compactValue(row.value)}</strong></p>)}
        </div>
      );
    case "log":
      return (
        <div key={key} className="plugin-schema-log">
          {element.label ? <h3>{element.label}</h3> : null}
          {element.rows.map((row, rowIndex) => <code key={rowIndex}>{row}</code>)}
        </div>
      );
  }
}

function collectDefaultValues(layout: readonly PluginUiElement[]): Readonly<Record<string, string | number | boolean | null>> {
  const values: Record<string, string | number | boolean | null> = {};
  for (const element of layout) {
    if (element.type === "section") Object.assign(values, collectDefaultValues(element.children));
    if (element.type === "buttonGrid") Object.assign(values, collectDefaultValues(element.buttons));
    if (["toggle", "checkbox", "textInput", "textArea", "numberInput", "slider", "colorInput", "select", "keybind"].includes(element.type)) {
      const id = "id" in element ? element.id : "";
      if (!id) continue;
      if (element.type === "toggle" || element.type === "checkbox") values[id] = element.defaultValue ?? false;
      if (element.type === "textInput" || element.type === "textArea" || element.type === "keybind") values[id] = element.defaultValue ?? "";
      if (element.type === "numberInput") values[id] = element.defaultValue ?? 0;
      if (element.type === "slider") values[id] = element.defaultValue ?? element.min;
      if (element.type === "colorInput") values[id] = colorControlValue(element.defaultValue, "#ffffff");
      if (element.type === "select") values[id] = element.defaultValue ?? element.options[0]?.value ?? "";
    }
  }
  return values;
}

function numericControlValue(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  const next = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(min, Math.min(max, next));
}

function colorControlValue(value: unknown, fallback: unknown = "#ffffff"): string {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim().toLowerCase();
  if (typeof fallback === "string" && /^#[0-9a-fA-F]{6}$/.test(fallback.trim())) return fallback.trim().toLowerCase();
  return "#ffffff";
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
