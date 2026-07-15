import { useEffect, type MutableRefObject } from "react";
import type { EngineWebviewElement } from "../../engineRuntime";
import type { GameWebviewMount } from "../common/model";

interface UseRuntimeHealthMonitoringOptions {
  readonly selectedClientId: number;
  readonly mountedVisibleGameViews: readonly GameWebviewMount[];
  readonly gameWebviewMountEpoch: number;
  readonly gameWebviewRefs: MutableRefObject<Map<number, EngineWebviewElement>>;
  readonly recoverGameWebview: (clientId: number, reason: string) => boolean;
}

/** Reports renderer liveness and attaches health listeners to mounted game views. */
export function useRuntimeHealthMonitoring(options: UseRuntimeHealthMonitoringOptions): void {
  useEffect(() => {
    const report = () => {
      window.shockless?.reportRendererHeartbeat({
        at: new Date().toISOString(),
        visibilityState: document.visibilityState,
        selectedClientId: options.selectedClientId,
        mountedGameViews: options.mountedVisibleGameViews.length,
      });
    };
    report();
    const interval = window.setInterval(report, 5_000);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
    };
  }, [options.mountedVisibleGameViews.length, options.selectedClientId]);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const view of options.mountedVisibleGameViews) {
      const webview = options.gameWebviewRefs.current.get(view.id);
      if (!webview) continue;
      const onRendererGone = (event: Event) => {
        const details = (event as Event & { details?: { reason?: string; exitCode?: number } }).details;
        window.shockless?.reportRuntimeHealth({
          at: new Date().toISOString(),
          scope: "game-webview",
          clientId: view.id,
          state: "render-process-gone",
          details: {
            reason: details?.reason ?? "unknown",
            exitCode: details?.exitCode ?? 0,
          },
        });
        options.recoverGameWebview(view.id, `render-process-${details?.reason ?? "gone"}`);
      };
      const onLoadFailed = (event: Event) => {
        const details = event as Event & {
          errorCode?: number;
          errorDescription?: string;
          validatedURL?: string;
          isMainFrame?: boolean;
        };
        if (details.errorCode === -3) return;
        window.shockless?.reportRuntimeHealth({
          at: new Date().toISOString(),
          scope: "game-webview",
          clientId: view.id,
          state: "did-fail-load",
          details: {
            errorCode: details.errorCode ?? 0,
            errorDescription: details.errorDescription ?? "",
            validatedURL: details.validatedURL ?? "",
            isMainFrame: details.isMainFrame ?? false,
          },
        });
      };
      webview.addEventListener("render-process-gone", onRendererGone);
      webview.addEventListener("did-fail-load", onLoadFailed);
      cleanups.push(() => {
        webview.removeEventListener("render-process-gone", onRendererGone);
        webview.removeEventListener("did-fail-load", onLoadFailed);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [
    options.gameWebviewMountEpoch,
    options.gameWebviewRefs,
    options.mountedVisibleGameViews,
    options.recoverGameWebview,
  ]);
}
