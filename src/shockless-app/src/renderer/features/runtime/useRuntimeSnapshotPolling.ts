import { useEffect, type MutableRefObject } from "react";
import type { PluginDefinition } from "../../../shared/plugin";
import {
  readEngineRuntimeSnapshot,
  type EngineRuntimeSnapshot,
  type EngineWebviewElement,
} from "../../engineRuntime";
import { pluginHasPermission } from "../plugins/permissions";
import { runtimeProbeScopesForPlugin } from "./snapshotStability";

interface UseRuntimeSnapshotPollingOptions {
  readonly webviewRef: MutableRefObject<EngineWebviewElement | null>;
  readonly engineUrl: string | null;
  readonly selectedClientId: number;
  readonly selectedPlugin: PluginDefinition;
  readonly applyRuntimeSnapshot: (snapshot: EngineRuntimeSnapshot) => void;
  readonly markLoading: () => void;
}

/** Polls only the runtime scopes needed by the selected plugin. */
export function useRuntimeSnapshotPolling(options: UseRuntimeSnapshotPollingOptions): void {
  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl) return;
    let cancelled = false;
    let inFlight = false;
    const scopes =
      options.selectedPlugin.origin === "user" && pluginHasPermission(options.selectedPlugin, "engine.snapshot")
        ? ["core", "room"] as const
        : runtimeProbeScopesForPlugin(options.selectedPlugin.id);

    const readRuntimeProbe = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const probe = await readEngineRuntimeSnapshot(webview, scopes);
        if (!cancelled) options.applyRuntimeSnapshot(probe);
      } catch {
        if (!cancelled) options.markLoading();
      } finally {
        inFlight = false;
      }
    };

    const onLoad = () => void readRuntimeProbe();
    webview.addEventListener("did-finish-load", onLoad);
    const interval = window.setInterval(() => void readRuntimeProbe(), 2500);
    void readRuntimeProbe();

    return () => {
      cancelled = true;
      webview.removeEventListener("did-finish-load", onLoad);
      window.clearInterval(interval);
    };
  }, [
    options.applyRuntimeSnapshot,
    options.engineUrl,
    options.markLoading,
    options.selectedClientId,
    options.selectedPlugin,
    options.webviewRef,
  ]);
}
