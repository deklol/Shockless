import type { PluginUiElement } from "../../../shared/plugin";

type SchemaButtonVariant = "default" | "primary" | "danger";

type SchemaButton = Extract<PluginUiElement, { readonly type: "button" }>;

function schemaButton(label: string, action: string, variant?: SchemaButtonVariant): SchemaButton {
  return { type: "button", label, action, variant };
}

function schemaButtonGrid(buttons: readonly SchemaButton[], columns = 2): PluginUiElement {
  return { type: "buttonGrid", columns, buttons };
}

function schemaSection(title: string, children: readonly PluginUiElement[], description?: string): PluginUiElement {
  return { type: "section", title, description, children };
}

function schemaKv(rows: readonly (readonly [string, unknown])[]): PluginUiElement {
  return {
    type: "kv",
    rows: rows.map(([key, value]) => ({ key, value: schemaPrimitive(value) })),
  };
}

function schemaTable(
  label: string,
  columns: readonly (readonly [string, string])[],
  rows: readonly Readonly<Record<string, unknown>>[],
  options: {
    readonly rowKey?: string;
    readonly selectedRowKey?: string | null;
    readonly rowAction?: string;
    readonly maxRows?: number;
  } = {},
): PluginUiElement {
  return {
    type: "table",
    label,
    columns: columns.map(([key, columnLabel]) => ({ key, label: columnLabel })),
    rows: rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, schemaPrimitive(value)])),
    ),
    rowKey: options.rowKey,
    selectedRowKey: options.selectedRowKey ?? undefined,
    rowAction: options.rowAction,
    maxRows: options.maxRows,
  };
}

function schemaLog(label: string, rows: readonly string[]): PluginUiElement {
  return { type: "log", label, rows: rows.length > 0 ? rows : ["-"] };
}

function schemaPrimitive(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

type SchemaPrimitiveValue = string | number | boolean | null;

export { schemaButton, schemaButtonGrid, schemaSection, schemaKv, schemaTable, schemaLog, schemaPrimitive };
export type { SchemaPrimitiveValue };
