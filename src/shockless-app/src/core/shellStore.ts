import { isPinnedPlugin, plugins } from "../plugins/registry";
import type { PluginDefinition } from "../shared/plugin";
import type { AccountSummary, AppState, EngineStatus, RoomSummary, TimelineEntry } from "../shared/session";

export type ShellAction =
  | { readonly type: "selectPlugin"; readonly pluginId: string }
  | { readonly type: "toggleDockCollapsed" }
  | { readonly type: "setPluginEnabled"; readonly pluginId: string; readonly enabled: boolean }
  | {
      readonly type: "setPluginUiSurfaceEnabled";
      readonly pluginId: string;
      readonly surfaceId: string;
      readonly enabled: boolean;
    }
  | { readonly type: "appendTimeline"; readonly entry: TimelineEntry }
  | { readonly type: "mergeEngineStatus"; readonly status: Partial<EngineStatus> }
  | { readonly type: "mergeRoomSummary"; readonly room: Partial<RoomSummary> }
  | { readonly type: "mergeAccountSummary"; readonly account: Partial<AccountSummary> };

export function createInitialPluginEnabledState(pluginDefinitions: readonly PluginDefinition[] = plugins): Readonly<Record<string, boolean>> {
  return Object.fromEntries(pluginDefinitions.map((plugin) => [plugin.id, isPinnedPlugin(plugin) ? true : plugin.enabledByDefault]));
}

export function createInitialPluginUiSurfaceState(): Readonly<
  Record<string, Readonly<Record<string, boolean>>>
> {
  return createPluginUiSurfaceState(plugins);
}

export function createPluginUiSurfaceState(pluginDefinitions: readonly PluginDefinition[]): Readonly<
  Record<string, Readonly<Record<string, boolean>>>
> {
  return Object.fromEntries(
    pluginDefinitions.map((plugin) => [
      plugin.id,
      Object.fromEntries(
        plugin.uiSurfaces.map((surface) => [surface.id, surface.enabledByDefault]),
      ),
    ]),
  );
}

export function shellReducer(state: AppState, action: ShellAction): AppState {
  switch (action.type) {
    case "selectPlugin":
      return {
        ...state,
        selectedPluginId: action.pluginId,
      };
    case "toggleDockCollapsed":
      return {
        ...state,
        ui: {
          ...state.ui,
          dockCollapsed: !state.ui.dockCollapsed,
        },
      };
    case "setPluginEnabled":
      if (action.enabled === false && isPinnedPluginById(action.pluginId)) return state;
      return {
        ...state,
        plugins: {
          ...state.plugins,
          enabledById: {
            ...state.plugins.enabledById,
            [action.pluginId]: action.enabled,
          },
        },
      };
    case "setPluginUiSurfaceEnabled":
      return {
        ...state,
        plugins: {
          ...state.plugins,
          uiSurfaceEnabledByPluginId: {
            ...state.plugins.uiSurfaceEnabledByPluginId,
            [action.pluginId]: {
              ...state.plugins.uiSurfaceEnabledByPluginId[action.pluginId],
              [action.surfaceId]: action.enabled,
            },
          },
        },
      };
    case "appendTimeline": {
      const maxTimelineEntries = 500;
      const nextTimeline = [...state.commandTimeline, action.entry];
      return {
        ...state,
        commandTimeline: nextTimeline.length > maxTimelineEntries ? nextTimeline.slice(-maxTimelineEntries) : nextTimeline,
      };
    }
    case "mergeEngineStatus":
      return {
        ...state,
        engine: {
          ...state.engine,
          ...action.status,
        },
      };
    case "mergeRoomSummary":
      return {
        ...state,
        room: {
          ...state.room,
          ...action.room,
        },
      };
    case "mergeAccountSummary":
      return {
        ...state,
        account: {
          ...state.account,
          ...action.account,
        },
      };
    default:
      return state;
  }
}

function isPinnedPluginById(pluginId: string): boolean {
  const plugin = plugins.find((entry) => entry.id === pluginId);
  return plugin ? isPinnedPlugin(plugin) : false;
}
