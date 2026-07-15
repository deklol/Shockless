import { readShocklessStorage } from "../../storage/shocklessStorage";
import type { PluginUiElement } from "../../../shared/plugin";
import { schemaPrimitive, type SchemaPrimitiveValue } from "./schemaBuilders";

export interface RuntimePluginUiState {
  readonly preview?: readonly PluginUiElement[];
  readonly settings?: readonly PluginUiElement[];
  readonly surfaces?: Readonly<Record<string, readonly PluginUiElement[]>>;
  readonly values?: Readonly<Record<string, SchemaPrimitiveValue>>;
}

export type PluginRuntimeUiStateById = Readonly<Record<string, RuntimePluginUiState | undefined>>;

const pluginUiValuesStorageKey = "shockless:plugin-ui-values";

function loadPersistedPluginRuntimeUiValues(): PluginRuntimeUiStateById {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(readShocklessStorage(window.localStorage, pluginUiValuesStorageKey) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, RuntimePluginUiState> = {};
    for (const [pluginId, rawValues] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[a-z0-9._-]{1,80}$/i.test(pluginId)) continue;
      if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) continue;
      const values: Record<string, SchemaPrimitiveValue> = {};
      for (const [key, value] of Object.entries(rawValues as Record<string, unknown>)) {
        if (!/^[a-z0-9._:-]{1,80}$/i.test(key)) continue;
        const primitive = schemaPrimitive(value);
        if (primitive !== null || value === null) values[key] = primitive;
      }
      if (Object.keys(values).length > 0) next[pluginId] = { values };
    }
    return next;
  } catch {
    return {};
  }
}

function pluginRuntimeUiValueSnapshot(
  state: PluginRuntimeUiStateById,
): Readonly<Record<string, Readonly<Record<string, SchemaPrimitiveValue>>>> {
  const snapshot: Record<string, Record<string, SchemaPrimitiveValue>> = {};
  for (const [pluginId, runtimeUi] of Object.entries(state)) {
    const values = runtimeUi?.values;
    if (!values || Object.keys(values).length === 0) continue;
    snapshot[pluginId] = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, schemaPrimitive(value)]));
  }
  return snapshot;
}

function persistedPluginValue(pluginId: string, key: string, fallback: SchemaPrimitiveValue): SchemaPrimitiveValue {
  return loadPersistedPluginRuntimeUiValues()[pluginId]?.values?.[key] ?? fallback;
}

export { pluginUiValuesStorageKey, loadPersistedPluginRuntimeUiValues, pluginRuntimeUiValueSnapshot, persistedPluginValue };
