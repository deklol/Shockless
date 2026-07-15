import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PluginDefinition, PluginRegistryState } from "../../../shared/plugin";
import type { RuntimePluginUiState } from "./runtimeUiState";

type AppendTimeline = (severity: "info" | "success" | "warning" | "error", message: string) => void;

interface UsePluginManagerActionsOptions {
  readonly appendTimeline: AppendTimeline;
  readonly newPluginId: string;
  readonly newPluginName: string;
  readonly setPluginRegistryState: Dispatch<SetStateAction<PluginRegistryState | null>>;
  readonly setPluginManagerMessage: Dispatch<SetStateAction<string>>;
  readonly setPluginRuntimeUiById: Dispatch<SetStateAction<Readonly<Record<string, RuntimePluginUiState | undefined>>>>;
  readonly setFallbackPluginEnabled: (pluginId: string, enabled: boolean) => void;
  readonly setFallbackSurfaceEnabled: (pluginId: string, surfaceId: string, enabled: boolean) => void;
}

/** Plugin installation, enablement, surface, folder, and template IPC actions. */
export function usePluginManagerActions(options: UsePluginManagerActionsOptions) {
  const applyRegistryResult = useCallback(
    (next: PluginRegistryState) => {
      options.setPluginRegistryState(next);
      options.setPluginManagerMessage(next.message);
    },
    [options.setPluginManagerMessage, options.setPluginRegistryState],
  );

  const refreshPluginRegistry = useCallback(async () => {
    if (!window.shockless?.getPluginRegistryState) return;
    applyRegistryResult(await window.shockless.getPluginRegistryState());
  }, [applyRegistryResult]);

  const setPluginEnabled = useCallback(
    async (plugin: PluginDefinition, enabled: boolean) => {
      if (!window.shockless?.setPluginEnabled) {
        options.setFallbackPluginEnabled(plugin.id, enabled);
        return;
      }
      const next = await window.shockless.setPluginEnabled(plugin.id, enabled);
      applyRegistryResult(next);
      options.appendTimeline(enabled ? "success" : "info", next.message);
    },
    [applyRegistryResult, options.appendTimeline, options.setFallbackPluginEnabled],
  );

  const setPluginSurfaceEnabled = useCallback(
    async (pluginId: string, surfaceId: string, enabled: boolean) => {
      if (!window.shockless?.setPluginSurfaceEnabled) {
        options.setFallbackSurfaceEnabled(pluginId, surfaceId, enabled);
        return;
      }
      const next = await window.shockless.setPluginSurfaceEnabled(pluginId, surfaceId, enabled);
      applyRegistryResult(next);
      options.appendTimeline("info", next.message);
    },
    [applyRegistryResult, options.appendTimeline, options.setFallbackSurfaceEnabled],
  );

  const reloadPlugins = useCallback(async () => {
    if (!window.shockless?.reloadPlugins) return;
    const next = await window.shockless.reloadPlugins();
    applyRegistryResult(next);
    options.appendTimeline("success", next.message);
  }, [applyRegistryResult, options.appendTimeline]);

  const openPluginsFolder = useCallback(async () => {
    if (!window.shockless?.openPluginsFolder) return;
    const result = await window.shockless.openPluginsFolder();
    applyRegistryResult(result.state);
    options.setPluginManagerMessage(result.message);
    options.appendTimeline(result.ok ? "success" : "warning", result.message);
  }, [applyRegistryResult, options.appendTimeline, options.setPluginManagerMessage]);

  const createPluginFromTemplate = useCallback(async () => {
    if (!window.shockless?.createPluginFromTemplate) return;
    const result = await window.shockless.createPluginFromTemplate({ id: options.newPluginId, name: options.newPluginName });
    applyRegistryResult(result.state);
    options.setPluginManagerMessage(result.message);
    options.appendTimeline(result.ok ? "success" : "warning", result.message);
  }, [applyRegistryResult, options.appendTimeline, options.newPluginId, options.newPluginName, options.setPluginManagerMessage]);

  const installPluginFromFolder = useCallback(async () => {
    if (!window.shockless?.installPluginFromFolder) return;
    const result = await window.shockless.installPluginFromFolder();
    applyRegistryResult(result.state);
    options.setPluginManagerMessage(result.message);
    options.appendTimeline(result.ok ? "success" : "warning", result.message);
  }, [applyRegistryResult, options.appendTimeline, options.setPluginManagerMessage]);

  const uninstallPlugin = useCallback(
    async (plugin: PluginDefinition) => {
      if (!window.shockless?.uninstallPlugin) return;
      if (!window.confirm(`Remove ${plugin.name}? This deletes the installed addon folder.`)) return;
      const result = await window.shockless.uninstallPlugin(plugin.id);
      applyRegistryResult(result.state);
      options.setPluginManagerMessage(result.message);
      options.appendTimeline(result.ok ? "success" : "warning", result.message);
      if (!result.ok) return;
      options.setPluginRuntimeUiById((current) => {
        const next = { ...current };
        delete next[plugin.id];
        return next;
      });
    },
    [
      applyRegistryResult,
      options.appendTimeline,
      options.setPluginManagerMessage,
      options.setPluginRuntimeUiById,
    ],
  );

  return {
    refreshPluginRegistry,
    setPluginEnabled,
    setPluginSurfaceEnabled,
    reloadPlugins,
    openPluginsFolder,
    createPluginFromTemplate,
    installPluginFromFolder,
    uninstallPlugin,
  };
}
