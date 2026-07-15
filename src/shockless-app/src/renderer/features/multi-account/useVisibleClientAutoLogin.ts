import { useEffect, useRef, type MutableRefObject } from "react";
import type { ClientSessionList } from "../../../shared/window-api";
import type { EngineWebviewElement } from "../../engineRuntime";
import type { GameWebviewMount } from "../common/model";

type TimelineSeverity = "info" | "success" | "warning" | "error";

interface UseVisibleClientAutoLoginOptions {
  readonly enabled: boolean;
  readonly clientSessions: ClientSessionList | null;
  readonly gameWebviewMountEpoch: number;
  readonly mountedVisibleGameViews: readonly GameWebviewMount[];
  readonly gameWebviewRefs: MutableRefObject<Map<number, EngineWebviewElement>>;
  readonly appendTimeline: (severity: TimelineSeverity, message: string) => void;
  readonly refreshClientSessions: () => Promise<unknown>;
  readonly refreshSelectedClientSnapshot: (clientId?: number) => Promise<unknown>;
}

/** Automatically submits stored credentials for mounted non-main visible clients. */
export function useVisibleClientAutoLogin(options: UseVisibleClientAutoLoginOptions): void {
  const submittedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const warnedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!options.enabled) return;
    const submitBridge = window.shockless?.submitVisibleClientLogin;
    if (!submitBridge) return;
    let cancelled = false;
    const timers: number[] = [];
    const listenerCleanups: Array<() => void> = [];
    const sessionById = new globalThis.Map((options.clientSessions?.sessions ?? []).map((session) => [session.id, session]));

    const submitVisibleLogin = async (view: GameWebviewMount) => {
      const loginKey = `${view.id}:${view.url}`;
      if (cancelled || view.id === 1 || submittedRef.current.has(loginKey) || inFlightRef.current.has(loginKey)) return;
      const session = sessionById.get(view.id);
      if (!session?.visible || session.headless || session.status !== "running") return;
      const webview = options.gameWebviewRefs.current.get(view.id);
      if (!webview || typeof webview.getWebContentsId !== "function") return;
      const webContentsId = Number(webview.getWebContentsId());
      if (!Number.isFinite(webContentsId) || webContentsId <= 0) return;
      inFlightRef.current.add(loginKey);
      try {
        const result = await submitBridge(view.id, webContentsId);
        if (!result || cancelled) return;
        if (result.ok) {
          submittedRef.current.add(loginKey);
          warnedRef.current.delete(loginKey);
          options.appendTimeline("success", result.message);
          await options.refreshClientSessions().catch(() => null);
          await options.refreshSelectedClientSnapshot(view.id).catch(() => null);
          return;
        }
        if (!warnedRef.current.has(loginKey)) {
          warnedRef.current.add(loginKey);
          options.appendTimeline("warning", result.message);
        }
      } finally {
        inFlightRef.current.delete(loginKey);
      }
    };

    for (const view of options.mountedVisibleGameViews) {
      if (view.id === 1) continue;
      const webview = options.gameWebviewRefs.current.get(view.id);
      if (!webview) continue;
      const onLoad = () => {
        const timer = window.setTimeout(() => void submitVisibleLogin(view), 750);
        timers.push(timer);
      };
      webview.addEventListener("did-finish-load", onLoad);
      listenerCleanups.push(() => webview.removeEventListener("did-finish-load", onLoad));
      timers.push(window.setTimeout(() => void submitVisibleLogin(view), 750));
      timers.push(window.setInterval(() => void submitVisibleLogin(view), 5000));
    }

    return () => {
      cancelled = true;
      for (const cleanup of listenerCleanups) cleanup();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [
    options.appendTimeline,
    options.clientSessions?.sessions,
    options.enabled,
    options.gameWebviewMountEpoch,
    options.gameWebviewRefs,
    options.mountedVisibleGameViews,
    options.refreshClientSessions,
    options.refreshSelectedClientSnapshot,
  ]);
}
