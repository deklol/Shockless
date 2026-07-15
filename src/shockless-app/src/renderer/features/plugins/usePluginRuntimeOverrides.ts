import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PluginDefinition } from "../../../shared/plugin";
import { runEngineRuntimeAction, type EngineWebviewElement } from "../../engineRuntime";

interface UsePluginRuntimeOverridesOptions {
  readonly availablePlugins: readonly PluginDefinition[];
  readonly pluginEnabledById: Readonly<Record<string, boolean | undefined>>;
  readonly apiHiddenUserEntriesByPluginId: Readonly<Record<string, readonly string[]>>;
  readonly effectiveHiddenUserEntries: readonly string[];
  readonly effectiveHiddenUserSignature: string;
  readonly engineUrl: string | null;
  readonly gameWebviewMountEpoch: number;
  readonly selectedClientId: number;
  readonly selectedClientIsVisible: boolean;
  readonly wallItemAnywhereEnabled: boolean;
  readonly floorItemAnywhereEnabled: boolean;
  readonly webviewRef: MutableRefObject<EngineWebviewElement | null>;
  readonly setApiHiddenUserEntriesByPluginId: Dispatch<SetStateAction<Record<string, readonly string[]>>>;
  readonly setHideListMessage: Dispatch<SetStateAction<string>>;
  readonly setWallAnywhereMessage: Dispatch<SetStateAction<string>>;
  readonly setFloorAnywhereMessage: Dispatch<SetStateAction<string>>;
}

/** Applies enabled plugin compatibility features to the selected engine runtime. */
export function usePluginRuntimeOverrides(options: UsePluginRuntimeOverridesOptions): void {
  useEffect(() => {
    const enabledPluginIds = new Set(
      options.availablePlugins
        .filter((plugin) => options.pluginEnabledById[plugin.id] !== false)
        .map((plugin) => plugin.id),
    );
    options.setApiHiddenUserEntriesByPluginId((current) => {
      let changed = false;
      const next: Record<string, readonly string[]> = {};
      for (const [pluginId, entries] of Object.entries(current)) {
        if (!enabledPluginIds.has(pluginId)) {
          changed = true;
          continue;
        }
        next[pluginId] = entries;
      }
      return changed ? next : current;
    });
  }, [options.availablePlugins, options.pluginEnabledById, options.setApiHiddenUserEntriesByPluginId]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    void runEngineRuntimeAction(webview, { kind: "setHiddenUserFilter", entries: options.effectiveHiddenUserEntries })
      .then((result) => {
        if (!result.ok) options.setHideListMessage(result.message);
      })
      .catch((error) => options.setHideListMessage(error instanceof Error ? error.message : String(error)));
  }, [
    options.effectiveHiddenUserSignature,
    options.engineUrl,
    options.gameWebviewMountEpoch,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setHideListMessage,
    options.webviewRef,
  ]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    void runEngineRuntimeAction(webview, {
      kind: "setWallItemAnywherePlacement",
      enabled: options.wallItemAnywhereEnabled,
    })
      .then((result) => options.setWallAnywhereMessage(result.message))
      .catch((error) => options.setWallAnywhereMessage(error instanceof Error ? error.message : String(error)));
  }, [
    options.engineUrl,
    options.gameWebviewMountEpoch,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setWallAnywhereMessage,
    options.wallItemAnywhereEnabled,
    options.webviewRef,
  ]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    void runEngineRuntimeAction(webview, {
      kind: "setFloorItemAnywherePlacement",
      enabled: options.floorItemAnywhereEnabled,
    })
      .then((result) => options.setFloorAnywhereMessage(result.message))
      .catch((error) => options.setFloorAnywhereMessage(error instanceof Error ? error.message : String(error)));
  }, [
    options.engineUrl,
    options.floorItemAnywhereEnabled,
    options.gameWebviewMountEpoch,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setFloorAnywhereMessage,
    options.webviewRef,
  ]);
}
