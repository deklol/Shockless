import { useEffect, type RefObject } from "react";
import {
  runEngineRuntimeAction,
  type EngineRuntimeAction,
  type EngineWebviewElement,
} from "../../engineRuntime";

type UserNameLabelSettings = NonNullable<Extract<EngineRuntimeAction, { kind: "setUserNameLabels" }>["settings"]>;
type NativeKeyBindSettings = Extract<EngineRuntimeAction, { kind: "setNativeKeyBinds" }>["bindings"];

interface UseRuntimePreferenceSyncOptions {
  readonly webviewRef: RefObject<EngineWebviewElement | null>;
  readonly engineUrl: string | null;
  readonly gameWebviewMountEpoch: number;
  readonly selectedClientId: number;
  readonly selectedClientIsVisible: boolean;
  readonly engineUserNameLabels: boolean;
  readonly userNameLabelSettings: UserNameLabelSettings;
  readonly nativeKeyBindSettings: NativeKeyBindSettings;
  readonly customHabboCursor: boolean;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly perfTrace: boolean;
  readonly setRuntimeMessage: (message: string) => void;
}

/** Applies persisted interface and performance preferences to the active game runtime. */
export function useRuntimePreferenceSync(options: UseRuntimePreferenceSyncOptions): void {
  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    if (!options.engineUserNameLabels) {
      void runEngineRuntimeAction(webview, {
        kind: "setUserNameLabels",
        enabled: false,
        settings: options.userNameLabelSettings,
      });
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let applied = false;
    let attempts = 0;
    let interval: number | null = null;
    const applyNameLabels = async () => {
      if (cancelled || inFlight || applied) return;
      attempts += 1;
      inFlight = true;
      try {
        const result = await runEngineRuntimeAction(webview, {
          kind: "setUserNameLabels",
          enabled: true,
          settings: options.userNameLabelSettings,
        });
        if (!cancelled && result.ok) {
          applied = true;
          options.setRuntimeMessage(result.message);
          if (interval !== null) {
            window.clearInterval(interval);
            interval = null;
          }
        }
      } finally {
        inFlight = false;
      }
      if (attempts >= 20 && interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const onLoad = () => {
      applied = false;
      attempts = 0;
      window.setTimeout(() => void applyNameLabels(), 750);
    };
    webview.addEventListener("did-finish-load", onLoad);
    const timer = window.setTimeout(() => void applyNameLabels(), 1200);
    interval = window.setInterval(() => void applyNameLabels(), 1000);
    return () => {
      cancelled = true;
      webview.removeEventListener("did-finish-load", onLoad);
      window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [
    options.engineUrl,
    options.engineUserNameLabels,
    options.gameWebviewMountEpoch,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setRuntimeMessage,
    options.userNameLabelSettings,
    options.webviewRef,
  ]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    let cancelled = false;
    const applyBinds = async () => {
      const result = await runEngineRuntimeAction(webview, {
        kind: "setNativeKeyBinds",
        bindings: options.nativeKeyBindSettings,
      });
      if (!cancelled && result.ok) options.setRuntimeMessage(result.message);
    };
    const onLoad = () => window.setTimeout(() => void applyBinds(), 500);
    webview.addEventListener("did-finish-load", onLoad);
    const timer = window.setTimeout(() => void applyBinds(), 750);
    return () => {
      cancelled = true;
      webview.removeEventListener("did-finish-load", onLoad);
      window.clearTimeout(timer);
    };
  }, [
    options.engineUrl,
    options.gameWebviewMountEpoch,
    options.nativeKeyBindSettings,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setRuntimeMessage,
    options.webviewRef,
  ]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    let cancelled = false;
    const applyCursor = async () => {
      const result = await runEngineRuntimeAction(webview, {
        kind: "setCustomHabboCursor",
        enabled: options.customHabboCursor,
      });
      if (!cancelled && !result.ok) options.setRuntimeMessage(result.message);
    };
    const onLoad = () => window.setTimeout(() => void applyCursor(), 500);
    webview.addEventListener("did-finish-load", onLoad);
    const timer = window.setTimeout(() => void applyCursor(), 750);
    return () => {
      cancelled = true;
      webview.removeEventListener("did-finish-load", onLoad);
      window.clearTimeout(timer);
    };
  }, [
    options.customHabboCursor,
    options.engineUrl,
    options.gameWebviewMountEpoch,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setRuntimeMessage,
    options.webviewRef,
  ]);

  useEffect(() => {
    const webview = options.webviewRef.current;
    if (!webview || !options.engineUrl || !options.selectedClientIsVisible) return;
    let cancelled = false;
    const applyOverrides = async () => {
      const actions: EngineRuntimeAction[] = [
        { kind: "setSmoothAvatars", enabled: options.smoothAvatars },
        { kind: "setSmoothUi", enabled: options.smoothUi },
        { kind: "setPerfTrace", enabled: options.perfTrace },
      ];
      for (const action of actions) {
        const result = await runEngineRuntimeAction(webview, action);
        if (!cancelled && !result.ok) options.setRuntimeMessage(result.message);
      }
    };
    const onLoad = () => window.setTimeout(() => void applyOverrides(), 500);
    webview.addEventListener("did-finish-load", onLoad);
    const timer = window.setTimeout(() => void applyOverrides(), 750);
    return () => {
      cancelled = true;
      webview.removeEventListener("did-finish-load", onLoad);
      window.clearTimeout(timer);
    };
  }, [
    options.engineUrl,
    options.gameWebviewMountEpoch,
    options.perfTrace,
    options.selectedClientId,
    options.selectedClientIsVisible,
    options.setRuntimeMessage,
    options.smoothAvatars,
    options.smoothUi,
    options.webviewRef,
  ]);
}
