import type { PluginDefinition, PluginPermission } from "../../../shared/plugin";
import type { EngineRuntimeActionResult } from "../../engineRuntime";
import { permissionLabel } from "../common/model";

export type PluginClientRightsOwners = Map<number, Map<string, Set<string>>>;

export function pluginHasPermission(plugin: PluginDefinition, permission: PluginPermission): boolean {
  return (plugin.permissions ?? []).includes(permission);
}

export function requirePluginPermission(plugin: PluginDefinition, permissions: readonly PluginPermission[]): void {
  if (permissions.some((permission) => pluginHasPermission(plugin, permission))) return;
  throw new Error(`${plugin.name} needs ${permissions.map(permissionLabel).join(" or ")} permission.`);
}

export function isDisabledPluginCleanupRequest(api: string): boolean {
  return [
    "storage.get",
    "storage.set",
    "storage.delete",
    "client.getRights",
    "client.removeRights",
    "filters.clearHiddenUsers",
    "filters.removeHiddenUser",
    "filters.setHiddenUsers",
  ].includes(api);
}

export function assertDisabledPluginCleanupRequest(plugin: PluginDefinition, api: string, args: Record<string, unknown>): void {
  if (!isDisabledPluginCleanupRequest(api)) {
    throw new Error(`${plugin.name} is disabled.`);
  }
  if (api === "filters.clearHiddenUsers" || api === "filters.removeHiddenUser") return;
  if (api === "filters.setHiddenUsers") {
    const entries = args.entries;
    const empty =
      entries === null ||
      entries === undefined ||
      (typeof entries === "string" && entries.trim() === "") ||
      (Array.isArray(entries) && entries.length === 0);
    if (empty) return;
    throw new Error(`${plugin.name} can only clear its hidden-user filter while disabled.`);
  }
  if (api !== "client.removeRights") return;
  const managedRights = pluginManagedClientRights(plugin);
  const managedKeys = new Set(managedRights.map((right) => right.toLowerCase()));
  const requestedRights = cleanPluginRightsList(args.rights);
  if (requestedRights.length === 0) throw new Error(`${plugin.name} can only remove managed client rights while disabled.`);
  if (requestedRights.some((right) => !managedKeys.has(right.toLowerCase()))) {
    throw new Error(`${plugin.name} can only remove its own managed client rights while disabled.`);
  }
}

export function pluginStorageKey(pluginId: string, key: unknown): string {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey || normalizedKey.length > 120 || /[\x00-\x1f]/.test(normalizedKey)) {
    throw new Error("Plugin storage key must be 1-120 printable characters.");
  }
  return `shockless:user-plugin:${pluginId}:${normalizedKey}`;
}

export function requestedPluginClientId(args: unknown, selectedClientId: number): number {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const direct = Number(record.clientId);
  const options = record.options && typeof record.options === "object" ? (record.options as Record<string, unknown>) : {};
  const nested = Number(options.clientId);
  const candidate = Number.isInteger(direct) && direct > 0 ? direct : Number.isInteger(nested) && nested > 0 ? nested : selectedClientId;
  return candidate;
}

export function cleanPluginRightsList(value: unknown): readonly string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  const seen = new Set<string>();
  const rights: string[] = [];
  for (const entry of raw) {
    const right = String(entry ?? "").trim();
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(right)) continue;
    const key = right.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rights.push(right);
  }
  return rights;
}

export function pluginManagedClientRights(plugin: PluginDefinition): readonly string[] {
  return cleanPluginRightsList(plugin.managedRuntime?.clientRights ?? []);
}

export function disabledManagedClientRights(
  pluginList: readonly PluginDefinition[],
  enabledById: Readonly<Record<string, boolean>>,
): readonly string[] {
  const enabledManaged = new Set<string>();
  for (const plugin of pluginList) {
    if (enabledById[plugin.id] === false) continue;
    for (const right of pluginManagedClientRights(plugin)) enabledManaged.add(right.toLowerCase());
  }

  const seen = new Set<string>();
  const rights: string[] = [];
  for (const plugin of pluginList) {
    if (enabledById[plugin.id] !== false) continue;
    for (const right of pluginManagedClientRights(plugin)) {
      const key = right.toLowerCase();
      if (enabledManaged.has(key) || seen.has(key)) continue;
      seen.add(key);
      rights.push(right);
    }
  }
  return rights;
}

export function matchingClientRights(currentRights: readonly string[] | undefined, wantedRights: readonly string[]): readonly string[] {
  const current = new Set((currentRights ?? []).map((right) => right.toLowerCase()));
  return wantedRights.filter((right) => current.has(right.toLowerCase()));
}

export function clientRightsPayloadRights(value: unknown, key: "before" | "rights"): readonly string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as { readonly result?: unknown; readonly [field: string]: unknown };
  const nested = record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : null;
  return cleanPluginRightsList(nested?.[key] ?? record[key]);
}

export function addClientRightOwners(owners: PluginClientRightsOwners, clientId: number, pluginId: string, rights: readonly string[]): void {
  if (rights.length === 0) return;
  const byRight = owners.get(clientId) ?? new globalThis.Map<string, Set<string>>();
  owners.set(clientId, byRight);
  for (const right of rights) {
    const key = right.toLowerCase();
    const pluginsForRight = byRight.get(key) ?? new Set<string>();
    pluginsForRight.add(pluginId);
    byRight.set(key, pluginsForRight);
  }
}

export function removeClientRightOwners(owners: PluginClientRightsOwners, clientId: number, pluginId: string, rights: readonly string[]): void {
  const byRight = owners.get(clientId);
  if (!byRight) return;
  for (const right of rights) {
    const key = right.toLowerCase();
    const pluginsForRight = byRight.get(key);
    if (!pluginsForRight) continue;
    pluginsForRight.delete(pluginId);
    if (pluginsForRight.size === 0) byRight.delete(key);
  }
  if (byRight.size === 0) owners.delete(clientId);
}

export function updateClientRightOwners(
  owners: PluginClientRightsOwners,
  plugin: PluginDefinition,
  clientId: number,
  mode: "get" | "set" | "grant" | "remove",
  requestedRights: readonly string[],
  actionResult: EngineRuntimeActionResult,
): void {
  if (mode === "get") return;
  const managedRights = pluginManagedClientRights(plugin);
  if (managedRights.length === 0) return;
  const managedKeys = new Set(managedRights.map((right) => right.toLowerCase()));
  const afterKeys = new Set(clientRightsPayloadRights(actionResult.result, "rights").map((right) => right.toLowerCase()));
  if (mode === "remove") {
    removeClientRightOwners(owners, clientId, plugin.id, requestedRights.filter((right) => managedKeys.has(right.toLowerCase())));
    return;
  }
  if (mode === "set") {
    addClientRightOwners(owners, clientId, plugin.id, managedRights.filter((right) => afterKeys.has(right.toLowerCase())));
    removeClientRightOwners(owners, clientId, plugin.id, managedRights.filter((right) => !afterKeys.has(right.toLowerCase())));
    return;
  }
  addClientRightOwners(
    owners,
    clientId,
    plugin.id,
    requestedRights.filter((right) => managedKeys.has(right.toLowerCase()) && afterKeys.has(right.toLowerCase())),
  );
}

export function cleanInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function cleanPositiveInt(value: unknown, fallback: number): number {
  const parsed = cleanInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}
