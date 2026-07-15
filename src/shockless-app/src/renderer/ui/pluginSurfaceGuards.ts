import type { PluginDefinition, PluginUiSurface } from "../../shared/plugin";

export type PluginDetailTab = "preview" | "settings" | "panel" | "commands";

export interface PluginSchemaActionGate {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export function isPluginSurfaceEnabled(
  plugin: PluginDefinition,
  surfaceId: string,
  surfaceEnabledById?: Readonly<Record<string, boolean | undefined>> | null,
): boolean {
  const surface = plugin.uiSurfaces.find((entry) => entry.id === surfaceId);
  if (!surface) return false;
  return surfaceEnabledById?.[surface.id] ?? surface.enabledByDefault;
}

export function firstEnabledPanelSurface(
  plugin: PluginDefinition,
  surfaceEnabledById?: Readonly<Record<string, boolean | undefined>> | null,
  pluginEnabled = true,
): PluginUiSurface | null {
  if (!pluginEnabled) return null;
  return plugin.uiSurfaces.find((surface) => surface.kind === "panel" && isPluginSurfaceEnabled(plugin, surface.id, surfaceEnabledById)) ?? null;
}

export function pluginDetailTabs(
  plugin: PluginDefinition,
  options: {
    readonly pluginEnabled: boolean;
    readonly surfaceEnabledById?: Readonly<Record<string, boolean | undefined>> | null;
    readonly panelLayoutLength: number;
    readonly settingsLayoutLength: number;
  },
): readonly PluginDetailTab[] {
  const tabs: PluginDetailTab[] = [];
  if (options.pluginEnabled && options.panelLayoutLength > 0) tabs.push("panel");
  tabs.push("preview");
  if (options.settingsLayoutLength > 0) tabs.push("settings");
  if (pluginCommandsSurfaceEnabled(plugin, options.surfaceEnabledById, options.pluginEnabled)) tabs.push("commands");
  return tabs;
}

export function pluginCommandsSurfaceEnabled(
  plugin: PluginDefinition,
  surfaceEnabledById?: Readonly<Record<string, boolean | undefined>> | null,
  pluginEnabled = true,
): boolean {
  if (!pluginEnabled) return false;
  if ((plugin.commands?.length ?? 0) === 0 && (plugin.hotkeys?.length ?? 0) === 0) return false;
  const commandSurfaces = plugin.uiSurfaces.filter((surface) => surface.kind === "commands");
  if (commandSurfaces.length === 0) return true;
  return commandSurfaces.some((surface) => isPluginSurfaceEnabled(plugin, surface.id, surfaceEnabledById));
}

export function pluginSchemaActionGate(
  plugin: PluginDefinition | null | undefined,
  pluginEnabled: boolean,
  surfaceEnabledById: Readonly<Record<string, boolean | undefined>> | undefined,
  surfaceId: string,
): PluginSchemaActionGate {
  if (!plugin) return { allowed: false, reason: "Unknown plugin." };
  if (!pluginEnabled) return { allowed: false, reason: `${plugin.name} is disabled.` };
  if (surfaceId === "preview" || surfaceId === "settings") return { allowed: true, reason: null };
  if (!isPluginSurfaceEnabled(plugin, surfaceId, surfaceEnabledById)) {
    const surface = plugin.uiSurfaces.find((entry) => entry.id === surfaceId);
    const label = surface?.label ?? surfaceId;
    const subject = label.toLowerCase().startsWith(plugin.name.toLowerCase()) ? label : `${plugin.name} ${label}`;
    return { allowed: false, reason: `${subject} is disabled.` };
  }
  return { allowed: true, reason: null };
}
