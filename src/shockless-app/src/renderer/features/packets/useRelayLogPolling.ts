import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RelayLogSnapshot } from "../../../shared/window-api";

interface RelayLogCursor {
  logPath: string | null;
  lineNumber: number;
}

interface UseRelayLogPollingOptions {
  readonly packetConsoleOpen: boolean;
  readonly selectedPluginId: string;
  readonly userPluginsNeedRelayLog: boolean;
  readonly refreshRelayLog: () => Promise<RelayLogSnapshot | null>;
  readonly relayLogRef: MutableRefObject<RelayLogSnapshot | null>;
  readonly relayLogCursorRef: MutableRefObject<RelayLogCursor>;
  readonly setRelayLog: Dispatch<SetStateAction<RelayLogSnapshot | null>>;
}

const relayBackedPluginIds = new Set([
  "connection",
  "packet-log",
  "automation",
  "chat",
  "dev-tools",
  "info",
  "inventory",
  "items",
  "social",
  "user",
  "visitors",
  "wall-mover",
]);

/** Polls relay data only while a relay-backed surface or user plugin needs it. */
export function useRelayLogPolling(options: UseRelayLogPollingOptions): void {
  useEffect(() => {
    if (!window.shockless) return;
    const active =
      options.packetConsoleOpen ||
      relayBackedPluginIds.has(options.selectedPluginId) ||
      options.userPluginsNeedRelayLog;
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    const readLog = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await options.refreshRelayLog();
      } catch {
        if (!cancelled) {
          options.relayLogRef.current = null;
          options.relayLogCursorRef.current = { logPath: null, lineNumber: 0 };
          options.setRelayLog(null);
        }
      } finally {
        inFlight = false;
      }
    };
    void readLog();
    const interval = window.setInterval(
      () => void readLog(),
      options.packetConsoleOpen ? 100 : 500,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    options.packetConsoleOpen,
    options.refreshRelayLog,
    options.relayLogCursorRef,
    options.relayLogRef,
    options.selectedPluginId,
    options.setRelayLog,
    options.userPluginsNeedRelayLog,
  ]);
}
