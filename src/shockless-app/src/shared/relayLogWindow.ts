import type { RelayLogEntry } from "./window-api.js";

export const RELAY_LOG_LIVE_ENTRY_LIMIT = 1_000;
export const RELAY_LOG_HISTORY_PAGE_LIMIT = 500;
export const RELAY_LOG_HISTORY_ENTRY_LIMIT = 5_000;
export const RELAY_LOG_DELTA_ENTRY_LIMIT = 1_000;
export const RELAY_LOG_DELTA_BUFFER_LIMIT = 10_000;

export function relayLogTail(
  entries: readonly RelayLogEntry[],
  limit = RELAY_LOG_LIVE_ENTRY_LIMIT,
): RelayLogEntry[] {
  const safeLimit = normalizedRelayLimit(limit, RELAY_LOG_LIVE_ENTRY_LIMIT);
  return entries.length <= safeLimit ? [...entries] : entries.slice(entries.length - safeLimit);
}

export function mergeRelayLogTail(
  current: readonly RelayLogEntry[],
  incoming: readonly RelayLogEntry[],
  limit = RELAY_LOG_LIVE_ENTRY_LIMIT,
): RelayLogEntry[] {
  if (incoming.length === 0) return current as RelayLogEntry[];
  const safeLimit = normalizedRelayLimit(limit, RELAY_LOG_LIVE_ENTRY_LIMIT);
  if (incoming.length >= safeLimit) return incoming.slice(incoming.length - safeLimit);
  const keepCurrent = Math.max(0, safeLimit - incoming.length);
  return [...current.slice(Math.max(0, current.length - keepCurrent)), ...incoming];
}

export function normalizedRelayLimit(value: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

export function relayRetainedRange(
  entries: readonly RelayLogEntry[],
  totalLines: number,
): { readonly retainedFromLine: number; readonly retainedToLine: number; readonly historyComplete: boolean } {
  const retainedFromLine = entries[0]?.lineNumber ?? totalLines + 1;
  const retainedToLine = entries.at(-1)?.lineNumber ?? totalLines;
  return {
    retainedFromLine,
    retainedToLine,
    historyComplete: totalLines === 0 || (retainedFromLine === 1 && retainedToLine === totalLines),
  };
}
