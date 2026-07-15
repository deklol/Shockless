import { formatShockwavePacketParts } from "../../../shared/shockwavePacketText";
import { mergeRelayLogTail, relayLogTail, relayRetainedRange } from "../../../shared/relayLogWindow";
import type { RelayLogDeltaSnapshot, RelayLogEntry, RelayLogSnapshot } from "../../../shared/window-api";
import { compactValue } from "../common/model";

export function relayEntryLabel(entry: RelayLogEntry): string {
  const client = entry.clientId ? `c${entry.clientId} ` : "";
  if (entry.direction === "RELAY") return `${client}relay #${entry.sessionId ?? "-"}`;
  return `${client}${entry.direction} h${compactValue(entry.header)} ${compactValue(entry.size)}B`;
}

export function relayEntryDisplayName(entry: RelayLogEntry): string {
  const name = entry.packetName ?? "UNKNOWN_HEADER";
  return name === "UNKNOWN_HEADER" ? "[UNKNOWN_HEADER]" : name;
}

export interface RelayDerivedState {
  readonly entryCount: number;
  readonly latestClientPacket: RelayLogEntry | null;
  readonly latestServerPacket: RelayLogEntry | null;
  readonly latestSessionId: string;
  readonly clientModes: readonly string[];
  readonly serverModes: readonly string[];
  readonly sessionChoices: readonly string[];
  readonly sampledBodies: number;
  readonly redactedBodies: number;
  readonly hasServerCrypto: boolean;
  readonly hasClientKeySwap: boolean;
}

export const emptyRelayDerivedState: RelayDerivedState = {
  entryCount: 0,
  latestClientPacket: null,
  latestServerPacket: null,
  latestSessionId: "-",
  clientModes: [],
  serverModes: [],
  sessionChoices: ["All"],
  sampledBodies: 0,
  redactedBodies: 0,
  hasServerCrypto: false,
  hasClientKeySwap: false,
};

let relayDerivedCache:
  | {
      readonly logPath: string;
      readonly totalLines: number;
      readonly lastSourceLineNumber: number;
      readonly state: RelayDerivedState;
    }
  | null = null;

export function relayDerivedStateFromSnapshot(snapshot: RelayLogSnapshot | null): RelayDerivedState {
  if (!snapshot || snapshot.entries.length === 0) {
    relayDerivedCache = null;
    return emptyRelayDerivedState;
  }
  const cache = relayDerivedCache;
  const latestSourceLineNumber = snapshot.entries.reduce(
    (latest, entry) => Math.max(latest, entry.sourceLineNumber),
    0,
  );
  const canAppend =
    cache !== null &&
    cache.logPath === snapshot.logPath &&
    cache.totalLines <= snapshot.totalLines &&
    (latestSourceLineNumber >= cache.lastSourceLineNumber || snapshot.totalLines === cache.totalLines);
  const previous = canAppend ? cache.state : emptyRelayDerivedState;
  const entries = canAppend
    ? snapshot.entries.filter((entry) => entry.sourceLineNumber > cache.lastSourceLineNumber)
    : snapshot.entries;
  let latestClientPacket = previous.latestClientPacket;
  let latestServerPacket = previous.latestServerPacket;
  let latestSessionId = previous.latestSessionId;
  const clientModes = new globalThis.Set(previous.clientModes);
  const serverModes = new globalThis.Set(previous.serverModes);
  const sessions = new globalThis.Set(previous.sessionChoices.filter((session) => session !== "All"));
  let sampledBodies = previous.sampledBodies;
  let redactedBodies = previous.redactedBodies;
  let hasServerCrypto = previous.hasServerCrypto;
  let hasClientKeySwap = previous.hasClientKeySwap;

  for (const entry of entries) {
    if (entry.sessionId) {
      latestSessionId = entry.sessionId;
      sessions.add(entry.sessionId);
    }
    if (entry.header !== null) {
      if (entry.direction === "CLIENT") latestClientPacket = entry;
      if (entry.direction === "SERVER") latestServerPacket = entry;
      const mode = compactValue(entry.mode);
      if (mode !== "-") {
        if (entry.direction === "CLIENT") clientModes.add(mode);
        if (entry.direction === "SERVER") serverModes.add(mode);
      }
    }
    if (entry.bodyStatus === "sampled") sampledBodies += 1;
    if (entry.bodyStatus === "redacted") redactedBodies += 1;
    if (/SECRET_KEY|BobbaCrypto/i.test(entry.message)) hasServerCrypto = true;
    if (/GENERATEKEY|public key/i.test(entry.message)) hasClientKeySwap = true;
  }

  const state: RelayDerivedState = {
    entryCount: snapshot.entries.length,
    latestClientPacket,
    latestServerPacket,
    latestSessionId,
    clientModes: [...clientModes],
    serverModes: [...serverModes],
    sessionChoices: ["All", ...sessions],
    sampledBodies,
    redactedBodies,
    hasServerCrypto,
    hasClientKeySwap,
  };
  relayDerivedCache = {
    logPath: snapshot.logPath,
    totalLines: snapshot.totalLines,
    lastSourceLineNumber: entries.reduce(
      (latest, entry) => Math.max(latest, entry.sourceLineNumber),
      canAppend ? cache.lastSourceLineNumber : 0,
    ),
    state,
  };
  return state;
}

export function relayModeSummary(modes: readonly string[]): string {
  return modes.length > 0 ? modes.join(" / ") : "-";
}

export function relayEncryptionSummary(state: RelayDerivedState): string {
  if (state.hasServerCrypto && state.hasClientKeySwap) return "BobbaCrypto active / key swap routed";
  if (state.hasServerCrypto) return "BobbaCrypto active";
  if (state.hasClientKeySwap) return "key swap routed";
  return state.entryCount > 0 ? "pending handshake evidence" : "-";
}

export function relayBodyLoggingSummary(state: RelayDerivedState): string {
  if (state.sampledBodies === 0 && state.redactedBodies === 0) return "-";
  return `${state.sampledBodies} sampled / ${state.redactedBodies} redacted`;
}

export function relayPacketSummary(entry: RelayLogEntry | null): string {
  if (!entry) return "-";
  const client = entry.clientId ? `client${entry.clientId} / ` : "";
  return `${client}${relayEntryDisplayName(entry)} h${compactValue(entry.header)} #${compactValue(entry.sessionId)}`;
}

export function bytesFromHex(hex: string | null): readonly number[] {
  if (!hex) return [];
  return hex
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 16))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 255);
}

export function formatHabbpyV3PacketText(entry: RelayLogEntry): string {
  if (entry.header === null) return entry.message;
  if (entry.bodyStatus === "redacted") return "<redacted>";
  if (entry.bodyStatus !== "sampled") return entry.message;
  return formatShockwavePacketParts(entry.header, bytesFromHex(entry.bodyHex));
}

export function packetLogTimeLabel(updatedAt?: string | null): string {
  if (!updatedAt) return "--:--:--";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relayEntryV3Line(entry: RelayLogEntry, updatedAt?: string | null): string {
  const clientPrefix = entry.clientId ? `[client${entry.clientId}] ` : "";
  if (entry.header === null) return `${packetLogTimeLabel(updatedAt)}  ${clientPrefix}[RELAY ] ${entry.message}`;
  const sidPrefix = entry.sessionId ? `[${entry.sessionId.slice(0, 6)}] ` : "";
  const name = relayEntryDisplayName(entry);
  const header = compactValue(entry.header);
  const size = compactValue(entry.size);
  return `${packetLogTimeLabel(updatedAt)}  ${clientPrefix}${sidPrefix}[${entry.direction.padEnd(6, " ")}] ${name} [${header}] (${size}B)  ${formatHabbpyV3PacketText(entry)}`;
}

export function relayEntryPlain(entry: RelayLogEntry, updatedAt?: string | null): string {
  return relayEntryV3Line(entry, updatedAt);
}

export function relayEntrySearchText(entry: RelayLogEntry): string {
  const cached = relayEntrySearchCache.get(entry);
  if (cached) return cached;
  const text = [
    entry.direction,
    entry.clientId ? `client${entry.clientId}` : "",
    entry.clientLabel,
    entry.route,
    entry.mode,
    entry.header,
    entry.packetName,
    entry.size,
    entry.payloadBytes,
    entry.bodyStatus,
    entry.bodyText,
    entry.bodyAscii,
    entry.bodyHex,
    entry.message,
    ...entry.decodedFields.flatMap((field) => [field.label, field.value]),
  ]
    .map((value) => compactValue(value).toLowerCase())
    .join(" ");
  relayEntrySearchCache.set(entry, text);
  return text;
}

const relayEntrySearchCache = new WeakMap<RelayLogEntry, string>();

export function packetClientMatches(entry: RelayLogEntry, clientFilter: string): boolean {
  return clientFilter === "All" || String(entry.clientId ?? "") === clientFilter;
}

export function normalizePacketClientFilter(value: string, choices: readonly { readonly value: string; readonly label: string }[]): string {
  const text = String(value || "All").trim().toLowerCase();
  if (!text || text === "all" || text === "all-clients") return "All";
  const numeric = text.replace(/^client/i, "");
  const match = choices.find((choice) => choice.value.toLowerCase() === numeric || choice.label.toLowerCase() === text || `client${choice.value}`.toLowerCase() === text);
  return match?.value ?? "All";
}

export const PACKET_ROW_HEIGHT = 42;

export const PACKET_RENDER_ROWS = 110;

export const PACKET_OVERSCAN_ROWS = 18;

export const PACKET_CONSOLE_ROW_HEIGHT = 18;

export const PACKET_CONSOLE_RENDER_ROWS = 180;

export const PACKET_CONSOLE_OVERSCAN_ROWS = 30;

export function virtualPacketRange(
  totalRows: number,
  scrollTop: number,
  rowHeight = PACKET_ROW_HEIGHT,
  renderRows = PACKET_RENDER_ROWS,
  overscanRows = PACKET_OVERSCAN_ROWS,
): { start: number; end: number; top: number; height: number } {
  if (totalRows <= 0) return { start: 0, end: 0, top: 0, height: 0 };
  const rawStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const start = Math.min(rawStart, Math.max(0, totalRows - renderRows));
  const end = Math.min(totalRows, start + renderRows);
  return {
    start,
    end,
    top: start * rowHeight,
    height: totalRows * rowHeight,
  };
}

export function mergeRelayLogSnapshot(
  current: RelayLogSnapshot | null,
  incoming: RelayLogSnapshot | RelayLogDeltaSnapshot,
): RelayLogSnapshot {
  const delta = incoming as RelayLogDeltaSnapshot;
  if (!current || !("reset" in incoming) || delta.reset || current.logPath !== incoming.logPath) {
    const entries = relayLogTail(incoming.entries);
    return {
      logPath: incoming.logPath,
      exists: incoming.exists,
      fileSize: incoming.fileSize,
      updatedAt: incoming.updatedAt,
      totalLines: incoming.totalLines,
      packetCount: incoming.packetCount,
      clientCount: incoming.clientCount,
      serverCount: incoming.serverCount,
      ...relayRetainedRange(entries, incoming.totalLines),
      clients: incoming.clients,
      entries,
      message: incoming.message,
    };
  }
  if (
    current.fileSize === incoming.fileSize &&
    current.updatedAt === incoming.updatedAt &&
    current.totalLines === incoming.totalLines &&
    incoming.entries.length === 0
  ) {
    return current;
  }
  const entries = mergeRelayLogTail(current.entries, incoming.entries);
  return {
    logPath: incoming.logPath,
    exists: incoming.exists,
    fileSize: incoming.fileSize,
    updatedAt: incoming.updatedAt,
    totalLines: incoming.totalLines,
    packetCount: incoming.packetCount,
    clientCount: incoming.clientCount,
    serverCount: incoming.serverCount,
    ...relayRetainedRange(entries, incoming.totalLines),
    clients: incoming.clients,
    entries,
    message: incoming.message,
  };
}

export function relayLogSnapshotForClient(snapshot: RelayLogSnapshot | null, clientId: number | null): RelayLogSnapshot | null {
  if (!snapshot || !Number.isInteger(clientId) || (clientId ?? 0) <= 0) return null;
  const selectedClientId = clientId as number;
  const entries = snapshot.entries.filter((entry) => entry.clientId === selectedClientId || (selectedClientId === 1 && entry.clientId === null));
  const summary = snapshot.clients.find((entry) => entry.clientId === selectedClientId);
  const totalLines = summary?.totalLines ?? entries.length;
  return {
    ...snapshot,
    logPath: `${snapshot.logPath}#client-${selectedClientId}`,
    exists: summary?.exists ?? snapshot.exists,
    fileSize: summary?.fileSize ?? snapshot.fileSize,
    updatedAt: summary?.updatedAt ?? snapshot.updatedAt,
    totalLines,
    packetCount: summary?.packetCount ?? entries.filter((entry) => entry.header !== null).length,
    clientCount: summary?.clientCount ?? entries.filter((entry) => entry.direction === "CLIENT" && entry.header !== null).length,
    serverCount: summary?.serverCount ?? entries.filter((entry) => entry.direction === "SERVER" && entry.header !== null).length,
    ...relayRetainedRange(entries, totalLines),
    clients: summary ? [summary] : [],
    entries,
    message: entries.length > 0
      ? `Selected client${selectedClientId} relay view active.`
      : `No relay rows for selected client${selectedClientId}.`,
  };
}
