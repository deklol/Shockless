import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { packetNameFor } from "../shared/packetNames.js";
import {
  RELAY_LOG_DELTA_BUFFER_LIMIT,
  RELAY_LOG_DELTA_ENTRY_LIMIT,
  RELAY_LOG_HISTORY_PAGE_LIMIT,
  RELAY_LOG_LIVE_ENTRY_LIMIT,
  mergeRelayLogTail,
  normalizedRelayLimit,
  relayLogTail,
  relayRetainedRange,
} from "../shared/relayLogWindow.js";
import type {
  RelayLogClientSummary,
  RelayLogDeltaSnapshot,
  RelayLogEntry,
  RelayLogHistoryPage,
  RelayLogSnapshot,
} from "../shared/window-api.js";
import { firstExistingAppDataStorePath } from "./appDataPaths.js";

const LOG_NAME = "shockless-relay.log";

export interface RelayLogClientSource {
  readonly id: number;
  readonly label: string;
}

interface RelayLogCache {
  readonly logPath: string;
  readonly clientId: number | null;
  readonly clientLabel: string | null;
  fileSize: number;
  updatedAt: string | null;
  totalLines: number;
  packetCount: number;
  clientCount: number;
  serverCount: number;
  entries: RelayLogEntry[];
  deltaEntries: RelayLogEntry[];
  partialLine: string;
  snapshot: RelayLogSnapshot;
}

interface RelayLogSource {
  readonly clientId: number;
  readonly clientLabel: string;
  readonly logPath: string;
}

interface AggregateRelayLogCache {
  readonly key: string;
  readonly logPath: string;
  nextLineNumber: number;
  readonly sourceLineCounts: Map<string, number>;
  entries: RelayLogEntry[];
  deltaEntries: RelayLogEntry[];
  snapshot: RelayLogSnapshot;
}

const relayLogCaches = new Map<string, RelayLogCache>();
const aggregateRelayLogCaches = new Map<string, AggregateRelayLogCache>();

export function readRelayLogSnapshot(appDataPath: string, clients: readonly RelayLogClientSource[] = []): RelayLogSnapshot {
  return readAggregateRelayLogSnapshot(relayLogSources(appDataPath, clients));
}

function readRelayLogSourceSnapshot(source: RelayLogSource): RelayLogSnapshot {
  const logPath = source.logPath;
  if (!existsSync(logPath)) {
    const client = relayLogClientSummaryForSource(source);
    return {
      logPath,
      exists: false,
      fileSize: 0,
      updatedAt: null,
      totalLines: 0,
      packetCount: 0,
      clientCount: 0,
      serverCount: 0,
      retainedFromLine: 1,
      retainedToLine: 0,
      historyComplete: true,
      clients: [client],
      entries: [],
      message: "Relay log has not been created yet.",
    };
  }

  const stat = statSync(logPath);
  const updatedAt = stat.mtime.toISOString();
  const existing = relayLogCaches.get(logPath);
  if (existing && existing.fileSize === stat.size && existing.updatedAt === updatedAt) {
    return existing.snapshot;
  }

  if (!existing || stat.size < existing.fileSize) {
    const content = readFileSync(logPath, "utf8");
    const split = splitRelayLogText(content);
    const tailStart = Math.max(0, split.lines.length - RELAY_LOG_LIVE_ENTRY_LIMIT);
    const entries = split.lines
      .slice(tailStart)
      .map((line, index) => parseRelayLine(line, tailStart + index, source))
      .filter((entry): entry is RelayLogEntry => entry !== null);
    const cache = makeRelayLogCache(
      source,
      stat.size,
      updatedAt,
      split.lines.length,
      entries,
      split.partialLine,
      countPacketDirectionsFromLines(split.lines),
    );
    relayLogCaches.set(logPath, cache);
    return cache.snapshot;
  }

  const appended = readFileSlice(logPath, existing.fileSize, stat.size - existing.fileSize);
  const parsed = parseRelayLogText(existing.partialLine + appended, existing.totalLines, source);
  if (parsed.entries.length > 0 || parsed.lines.length > 0 || parsed.partialLine !== existing.partialLine) {
    existing.entries = mergeRelayLogTail(existing.entries, parsed.entries);
    existing.deltaEntries = mergeRelayLogTail(existing.deltaEntries, parsed.entries, RELAY_LOG_DELTA_BUFFER_LIMIT);
    existing.totalLines += parsed.lines.length;
    existing.partialLine = parsed.partialLine;
    const appendedCounts = countPacketDirections(parsed.entries);
    existing.packetCount += appendedCounts.packetCount;
    existing.clientCount += appendedCounts.clientCount;
    existing.serverCount += appendedCounts.serverCount;
  }
  existing.fileSize = stat.size;
  existing.updatedAt = updatedAt;
  existing.snapshot = makeRelayLogSnapshot(existing);
  return existing.snapshot;
}

export function readRelayLogDeltaSnapshot(
  appDataPath: string,
  currentLogPath: string | null,
  afterLineNumber: number,
  clients: readonly RelayLogClientSource[] = [],
): RelayLogDeltaSnapshot {
  const snapshot = readRelayLogSnapshot(appDataPath, clients);
  const safeAfterLineNumber = Number.isFinite(afterLineNumber) ? Math.max(0, Math.trunc(afterLineNumber)) : 0;
  const deltaEntries = relayDeltaBuffer(snapshot.logPath);
  const deltaFromLine = deltaEntries[0]?.lineNumber ?? snapshot.totalLines + 1;
  const reset =
    !snapshot.exists ||
    !currentLogPath ||
    currentLogPath !== snapshot.logPath ||
    safeAfterLineNumber <= 0 ||
    safeAfterLineNumber > snapshot.totalLines ||
    safeAfterLineNumber < deltaFromLine - 1;
  if (reset) {
    return {
      ...snapshot,
      afterLineNumber: safeAfterLineNumber,
      reset: true,
      nextLineNumber: snapshot.totalLines,
      hasMore: false,
      entries: snapshot.entries,
    };
  }

  const available = relayEntriesAfterLineNumber(deltaEntries, safeAfterLineNumber);
  const entries = available.slice(0, RELAY_LOG_DELTA_ENTRY_LIMIT);
  const hasMore = available.length > entries.length;
  return {
    ...snapshot,
    afterLineNumber: safeAfterLineNumber,
    reset: false,
    nextLineNumber: hasMore ? entries.at(-1)?.lineNumber ?? safeAfterLineNumber : snapshot.totalLines,
    hasMore,
    entries,
  };
}

export function readRelayLogHistoryPage(
  appDataPath: string,
  clientId: number,
  beforeSourceLineNumber: number | null = null,
  limit = RELAY_LOG_HISTORY_PAGE_LIMIT,
  clients: readonly RelayLogClientSource[] = [],
): RelayLogHistoryPage {
  const sources = relayLogSources(appDataPath, clients);
  const source = sources.find((entry) => entry.clientId === clientId) ?? sources[0];
  if (!source) throw new Error(`Relay client ${clientId} is not available.`);
  const safeLimit = Math.min(2_000, normalizedRelayLimit(limit, RELAY_LOG_HISTORY_PAGE_LIMIT));
  if (!existsSync(source.logPath)) {
    return {
      clientId: source.clientId,
      clientLabel: source.clientLabel,
      logPath: source.logPath,
      beforeSourceLineNumber: 1,
      firstSourceLineNumber: null,
      lastSourceLineNumber: null,
      hasMore: false,
      entries: [],
    };
  }

  const lines = splitRelayLogText(readFileSync(source.logPath, "utf8")).lines;
  const before = Math.min(
    lines.length + 1,
    beforeSourceLineNumber === null || !Number.isFinite(beforeSourceLineNumber)
      ? lines.length + 1
      : Math.max(1, Math.trunc(beforeSourceLineNumber)),
  );
  const endIndex = Math.max(0, before - 1);
  const startIndex = Math.max(0, endIndex - safeLimit);
  const entries = lines
    .slice(startIndex, endIndex)
    .map((line, index) => parseRelayLine(line, startIndex + index, source))
    .filter((entry): entry is RelayLogEntry => entry !== null)
    .map((entry) => ({ ...entry, id: `history-client-${source.clientId}-${entry.id}` }));
  return {
    clientId: source.clientId,
    clientLabel: source.clientLabel,
    logPath: source.logPath,
    beforeSourceLineNumber: before,
    firstSourceLineNumber: entries[0]?.sourceLineNumber ?? null,
    lastSourceLineNumber: entries.at(-1)?.sourceLineNumber ?? null,
    hasMore: startIndex > 0,
    entries,
  };
}

export function findRelayLogEntryReverse(
  appDataPath: string,
  clients: readonly RelayLogClientSource[],
  clientIds: ReadonlySet<number>,
  predicate: (entry: RelayLogEntry) => boolean,
): RelayLogEntry | null {
  const sources = relayLogSources(appDataPath, clients).filter(
    (source) => clientIds.size === 0 || clientIds.has(source.clientId),
  );
  for (const source of sources) {
    if (!existsSync(source.logPath)) continue;
    const lines = splitRelayLogText(readFileSync(source.logPath, "utf8")).lines;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseRelayLine(lines[index]!, index, source);
      if (entry && predicate(entry)) return entry;
    }
  }
  return null;
}

function relayLogSources(appDataPath: string, clients: readonly RelayLogClientSource[]): readonly RelayLogSource[] {
  const normalized = clients.length > 0 ? clients : [{ id: 1, label: "Main" }];
  return normalized
    .filter((client) => Number.isInteger(client.id) && client.id > 0)
    .map((client) => ({
      clientId: client.id,
      clientLabel: client.label || `client${client.id}`,
      logPath:
        client.id === 1
          ? firstExistingAppDataStorePath(appDataPath, "logs", LOG_NAME)
          : firstExistingAppDataStorePath(appDataPath, `client-${client.id}`, "logs", LOG_NAME),
    }))
    .sort((left, right) => left.clientId - right.clientId);
}

function readAggregateRelayLogSnapshot(sources: readonly RelayLogSource[]): RelayLogSnapshot {
  if (sources.length === 1) {
    return readRelayLogSourceSnapshot(sources[0]!);
  }

  const key = sources.map((source) => `${source.clientId}:${source.logPath}`).join("|");
  const logPath = `aggregate://shockless-relay/${key}`;
  let aggregate = aggregateRelayLogCaches.get(key);
  if (!aggregate) {
    aggregate = {
      key,
      logPath,
      nextLineNumber: 1,
      sourceLineCounts: new Map<string, number>(),
      entries: [],
      deltaEntries: [],
      snapshot: emptyAggregateSnapshot(logPath, "Relay logs have not been created yet."),
    };
    aggregateRelayLogCaches.set(key, aggregate);
  }

  let reset = aggregate.sourceLineCounts.size === 0;
  const sourceSnapshots = sources.map((source) => ({ source, snapshot: readRelayLogSourceSnapshot(source) }));
  for (const { source, snapshot } of sourceSnapshots) {
    const previousLines = aggregate.sourceLineCounts.get(source.logPath) ?? 0;
    if (snapshot.totalLines < previousLines || !sourceDeltaAvailable(source.logPath, previousLines)) {
      reset = true;
      break;
    }
  }
  if (reset) {
    const perSourceLimit = Math.max(1, Math.floor(RELAY_LOG_LIVE_ENTRY_LIMIT / Math.max(1, sourceSnapshots.length)));
    const retained = sourceSnapshots.flatMap(({ snapshot }) => snapshot.entries.slice(-perSourceLimit));
    const totalLines = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.totalLines, 0);
    let lineNumber = Math.max(1, totalLines - retained.length + 1);
    aggregate.entries = relayLogTail(retained.map((entry) => ({
      ...entry,
      id: `client-${entry.clientId ?? 1}-${entry.id}`,
      lineNumber: lineNumber++,
    })));
    aggregate.deltaEntries = [...aggregate.entries];
    aggregate.sourceLineCounts.clear();
    for (const { source, snapshot } of sourceSnapshots) {
      aggregate.sourceLineCounts.set(source.logPath, snapshot.totalLines);
    }
    aggregate.nextLineNumber = totalLines + 1;
  } else {
    const appended: RelayLogEntry[] = [];
    for (const { source, snapshot } of sourceSnapshots) {
      const previousLines = aggregate.sourceLineCounts.get(source.logPath) ?? 0;
      for (const entry of sourceDeltaEntriesAfter(source.logPath, previousLines)) {
        appended.push({
          ...entry,
          id: `client-${source.clientId}-${entry.id}`,
          lineNumber: aggregate.nextLineNumber++,
        });
      }
      aggregate.sourceLineCounts.set(source.logPath, snapshot.totalLines);
    }
    aggregate.entries = mergeRelayLogTail(aggregate.entries, appended);
    aggregate.deltaEntries = mergeRelayLogTail(aggregate.deltaEntries, appended, RELAY_LOG_DELTA_BUFFER_LIMIT);
  }

  const packetCount = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.packetCount, 0);
  const clientCount = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.clientCount, 0);
  const serverCount = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.serverCount, 0);
  const updatedAt = latestUpdatedAt(sourceSnapshots.map(({ snapshot }) => snapshot.updatedAt));
  const fileSize = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.fileSize, 0);
  const totalLines = sourceSnapshots.reduce((sum, { snapshot }) => sum + snapshot.totalLines, 0);
  const exists = sourceSnapshots.some(({ snapshot }) => snapshot.exists);
  const range = relayRetainedRange(aggregate.entries, totalLines);
  aggregate.snapshot = {
    logPath,
    exists,
    fileSize,
    updatedAt,
    totalLines,
    packetCount,
    clientCount,
    serverCount,
    ...range,
    clients: sourceSnapshots.flatMap(({ snapshot }) => snapshot.clients),
    entries: aggregate.entries,
    message: exists
      ? `Aggregated relay packet logs for ${sources.length} client sessions.`
      : "Relay logs have not been created yet.",
  };
  return aggregate.snapshot;
}

function emptyAggregateSnapshot(logPath: string, message: string): RelayLogSnapshot {
  return {
    logPath,
    exists: false,
    fileSize: 0,
    updatedAt: null,
    totalLines: 0,
    packetCount: 0,
    clientCount: 0,
    serverCount: 0,
    retainedFromLine: 1,
    retainedToLine: 0,
    historyComplete: true,
    clients: [],
    entries: [],
    message,
  };
}

function latestUpdatedAt(values: readonly (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function relayEntriesAfterLineNumber(entries: readonly RelayLogEntry[], afterLineNumber: number): readonly RelayLogEntry[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((entries[mid]?.lineNumber ?? 0) <= afterLineNumber) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return entries.slice(low);
}

function relayDeltaBuffer(logPath: string): readonly RelayLogEntry[] {
  const source = relayLogCaches.get(logPath);
  if (source) return source.deltaEntries;
  for (const aggregate of aggregateRelayLogCaches.values()) {
    if (aggregate.logPath === logPath) return aggregate.deltaEntries;
  }
  return [];
}

function sourceDeltaAvailable(logPath: string, afterSourceLineNumber: number): boolean {
  const cache = relayLogCaches.get(logPath);
  if (!cache || afterSourceLineNumber > cache.totalLines) return false;
  if (afterSourceLineNumber === cache.totalLines) return true;
  const first = cache.deltaEntries[0]?.sourceLineNumber ?? cache.totalLines + 1;
  return afterSourceLineNumber >= first - 1;
}

function sourceDeltaEntriesAfter(logPath: string, afterSourceLineNumber: number): readonly RelayLogEntry[] {
  const cache = relayLogCaches.get(logPath);
  if (!cache) return [];
  return cache.deltaEntries.filter((entry) => entry.sourceLineNumber > afterSourceLineNumber);
}

function parseRelayLogText(text: string, lineOffset: number, source?: RelayLogSource): {
  readonly lines: readonly string[];
  readonly entries: readonly RelayLogEntry[];
  readonly partialLine: string;
} {
  const { lines, partialLine } = splitRelayLogText(text);
  const entries = lines
    .map((line, index) => parseRelayLine(line, lineOffset + index, source))
    .filter((entry): entry is RelayLogEntry => entry !== null);
  return { lines, entries, partialLine };
}

function splitRelayLogText(text: string): { readonly lines: readonly string[]; readonly partialLine: string } {
  const endsWithNewline = /\r?\n$/.test(text);
  const rawLines = text.split(/\r?\n/);
  const partialLine = endsWithNewline ? "" : rawLines.pop() ?? "";
  return {
    lines: rawLines.filter((line) => line.trim().length > 0),
    partialLine,
  };
}

function makeRelayLogCache(
  source: RelayLogSource,
  fileSize: number,
  updatedAt: string | null,
  totalLines: number,
  entries: readonly RelayLogEntry[],
  partialLine: string,
  counts = countPacketDirections(entries),
): RelayLogCache {
  const entryList = relayLogTail(entries);
  const cache: RelayLogCache = {
    logPath: source.logPath,
    clientId: source.clientId,
    clientLabel: source.clientLabel,
    fileSize,
    updatedAt,
    totalLines,
    packetCount: counts.packetCount,
    clientCount: counts.clientCount,
    serverCount: counts.serverCount,
    entries: entryList,
    deltaEntries: [...entryList],
    partialLine,
    snapshot: emptyAggregateSnapshot(source.logPath, "Relay packet log active."),
  };
  cache.snapshot = makeRelayLogSnapshot(cache);
  return cache;
}

function countPacketDirectionsFromLines(lines: readonly string[]): Pick<RelayLogCache, "packetCount" | "clientCount" | "serverCount"> {
  let packetCount = 0;
  let clientCount = 0;
  let serverCount = 0;
  for (const line of lines) {
    const match = line.match(/^\[origins-relay(?: #\d+)?\]\s*(browser -> official|habbpy-control -> official|official -> browser)\s+.*?\sheader=-?\d+(?=\s|$)/);
    if (!match) continue;
    packetCount += 1;
    if (match[1] === "official -> browser") serverCount += 1;
    else clientCount += 1;
  }
  return { packetCount, clientCount, serverCount };
}

function makeRelayLogSnapshot(cache: RelayLogCache): RelayLogSnapshot {
  const range = relayRetainedRange(cache.entries, cache.totalLines);
  return {
    logPath: cache.logPath,
    exists: true,
    fileSize: cache.fileSize,
    updatedAt: cache.updatedAt,
    totalLines: cache.totalLines,
    packetCount: cache.packetCount,
    clientCount: cache.clientCount,
    serverCount: cache.serverCount,
    ...range,
    clients: [relayLogClientSummary(cache)],
    entries: cache.entries,
    message: cache.packetCount > 0 ? "Relay packet log active." : "Relay log active; waiting for packet tracing rows.",
  };
}

function relayLogClientSummary(cache: RelayLogCache): RelayLogClientSummary {
  return {
    clientId: cache.clientId ?? 1,
    clientLabel: cache.clientLabel ?? "Main",
    logPath: cache.logPath,
    exists: true,
    fileSize: cache.fileSize,
    updatedAt: cache.updatedAt,
    totalLines: cache.totalLines,
    packetCount: cache.packetCount,
    clientCount: cache.clientCount,
    serverCount: cache.serverCount,
  };
}

function relayLogClientSummaryForSource(source: RelayLogSource): RelayLogClientSummary {
  return {
    clientId: source.clientId,
    clientLabel: source.clientLabel,
    logPath: source.logPath,
    exists: false,
    fileSize: 0,
    updatedAt: null,
    totalLines: 0,
    packetCount: 0,
    clientCount: 0,
    serverCount: 0,
  };
}

function countPacketDirections(entries: readonly RelayLogEntry[]): Pick<RelayLogCache, "packetCount" | "clientCount" | "serverCount"> {
  let packetCount = 0;
  let clientCount = 0;
  let serverCount = 0;
  for (const entry of entries) {
    if (entry.header === null) continue;
    packetCount += 1;
    if (entry.direction === "CLIENT") clientCount += 1;
    if (entry.direction === "SERVER") serverCount += 1;
  }
  return { packetCount, clientCount, serverCount };
}

function readFileSlice(path: string, offset: number, length: number): string {
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function parseRelayLine(line: string, index: number, source?: RelayLogSource): RelayLogEntry | null {
  const match = line.match(/^\[origins-relay(?: #(?<sessionId>\d+))?\]\s*(?<message>.*)$/);
  if (!match?.groups) return null;
  const message = match.groups.message.trim();
  const packet = message.match(
    /^(?<route>browser -> official|habbpy-control -> official|official -> browser)\s+(?<mode>\S+)(?:\s+(?<note>.*?))?\s+header=(?<header>-?\d+)(?=\s+(?:bytes|keyLength|bodyStatus)=|$)(?:\s+bytes=(?<bytes>\d+)|\s+keyLength=(?<keyLength>\d+))?/,
  );
  const body = message.match(
    /\sbodyStatus=(?<bodyStatus>sampled|redacted)(?:\s+bodyLen=(?<bodyLen>\d+))?(?:\s+bodySample=(?<bodySample>"(?:\\.|[^"\\])*"))?(?:\s+bodyTruncated=(?<bodyTruncated>[01]))?/,
  );
  const route = packet?.groups?.route ?? null;
  const direction =
    route === "browser -> official" || route === "habbpy-control -> official" ? "CLIENT" : packet ? "SERVER" : "RELAY";
  const header = packet?.groups?.header ? Number(packet.groups.header) : null;
  const sizeText = packet?.groups?.bytes ?? packet?.groups?.keyLength ?? null;
  const size = sizeText ? Number(sizeText) : null;
  const parsedHeader = Number.isFinite(header) ? header : null;
  const parsedSize = Number.isFinite(size) ? size : null;
  const parsedBodyLength = body?.groups?.bodyLen ? Number(body.groups.bodyLen) : null;
  const safeBodyLength = Number.isFinite(parsedBodyLength) ? parsedBodyLength : null;
  const payloadBytes =
    parsedHeader !== null && safeBodyLength !== null
      ? safeBodyLength
      : parsedHeader !== null && parsedSize !== null
        ? Math.max(0, parsedSize - 2)
        : null;
  const loggedBodyStatus = body?.groups?.bodyStatus;
  const bodyStatus: RelayLogEntry["bodyStatus"] =
    parsedHeader === null
      ? "not-a-packet"
      : loggedBodyStatus === "sampled" || loggedBodyStatus === "redacted"
        ? loggedBodyStatus
        : "not-persisted";
  const bodyText = bodyStatus === "sampled" ? parseRelayJsonString(body?.groups?.bodySample) : null;
  const bodyBytes = bodyText === null ? null : decodeEscapedPacketBody(bodyText);
  const packetName = packetNameFor(direction, parsedHeader);
  const decodedFields = bodyBytes === null ? [] : decodeBodyFields(parsedHeader, direction, bodyBytes, packetName);
  const bodyNote = bodyNoteFor(bodyStatus);

  return {
    id: `${index}-${match.groups.sessionId ?? "relay"}-${parsedHeader ?? "life"}`,
    sourceLineNumber: index + 1,
    lineNumber: index + 1,
    clientId: source?.clientId ?? null,
    clientLabel: source?.clientLabel ?? null,
    sessionId: match.groups.sessionId ?? null,
    direction,
    route: packet?.groups?.route ?? "relay",
    mode: packet?.groups?.mode ?? null,
    header: parsedHeader,
    packetName,
    size: parsedSize,
    payloadBytes,
    bodyStatus,
    bodyText,
    bodyHex: bodyBytes === null ? null : bodyBytes.toString("hex").replace(/(.{2})/g, "$1 ").trim(),
    bodyAscii: bodyBytes === null ? null : printableBodyText(bodyBytes),
    bodyTruncated: body?.groups?.bodyTruncated === "1",
    decodedFields,
    bodyNote,
    message: maskSensitiveRelayText(message),
  };
}

function bodyNoteFor(status: RelayLogEntry["bodyStatus"]): string {
  switch (status) {
    case "sampled":
      return "Sanitized relay body captured by the Shockless relay wrapper; sensitive client payloads are redacted.";
    case "redacted":
      return "Sensitive client payload redacted by the Shockless relay wrapper.";
    case "not-a-packet":
      return "Relay lifecycle line; no packet payload exists.";
    case "not-persisted":
      return "Shockless relay logPacket records route, mode, header, and byte count only; payload body bytes are not persisted.";
  }
}

function parseRelayJsonString(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeEscapedPacketBody(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = value[index + 1];
    if (next === "x" && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 2, index + 4))) {
      bytes.push(Number.parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
    } else if (next === "t") {
      bytes.push(0x09);
      index += 1;
    } else if (next === "n") {
      bytes.push(0x0a);
      index += 1;
    } else if (next === "r") {
      bytes.push(0x0d);
      index += 1;
    } else if (next === "\\") {
      bytes.push(0x5c);
      index += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes);
}

function printableBodyText(bytes: Buffer): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0x02) text += "<STX>";
    else if (byte === 0x09) text += "<TAB>";
    else if (byte === 0x0a) text += "<LF>";
    else if (byte === 0x0d) text += "<CR>";
    else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
    else text += ".";
  }
  return text;
}

function decodeBodyFields(
  header: number | null,
  direction: RelayLogEntry["direction"],
  bytes: Buffer,
  packetName: string | null,
): RelayLogEntry["decodedFields"] {
  const fields: Array<{ label: string; value: string }> = [];
  fields.push({ label: "decryptedBytes", value: String(bytes.length) });
  fields.push({ label: "ascii", value: printableBodyText(bytes) });

  const separatorParts = bytes
    .toString("latin1")
    .split(String.fromCharCode(2))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  separatorParts.forEach((part, index) => {
    fields.push({ label: `field ${index + 1}`, value: printableBodyText(Buffer.from(part, "latin1")) });
  });

  if (direction === "SERVER" && (header === 24 || header === 25 || header === 26)) {
    addChatPacketHints(fields, header, bytes);
  }
  if (direction === "SERVER" && header === 34 && separatorParts.length > 0) {
    fields.push({ label: "statusRows", value: String(separatorParts.length) });
    addStatusRowHints(fields, separatorParts);
  }
  if (direction === "SERVER" && header === 12) {
    addMessengerInitHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 13) {
    addFriendListUpdateHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 132) {
    addFriendRequestHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 134) {
    addMessengerMessageHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 28) {
    addUsersPacketHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 32) {
    addFloorObjectsPacketHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 45) {
    addWallItemsPacketHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 87) {
    addPlantDataUpdateHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 88) {
    addFloorItemDataUpdateHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 93) {
    addActiveObjectAddHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 94) {
    addActiveObjectRemoveHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 95) {
    addFloorObjectUpdateHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 84) {
    addWallItemRemoveHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 85) {
    addWallItemUpdateHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 99) {
    addInventoryItemRemoveHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 50 && separatorParts.length > 0) {
    fields.push({ label: "pingToken", value: separatorParts[0] });
  }
  if (direction === "SERVER" && header === 137) {
    addFriendAddedHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 140) {
    addInventoryItemsHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 228) {
    addActiveBadgeHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 229) {
    addAvailableBadgesHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 308) {
    addAccountPreferencesHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 313) {
    addMessengerMessagesHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 314) {
    addFriendRequestListHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 362) {
    addHighlightUserFriendsHints(fields, bytes);
  }
  if (direction === "SERVER" && header === 1242) {
    addStatusEffectsHints(fields, bytes);
  }
  if (direction === "SERVER") {
    addFishingServerHints(fields, header, bytes);
  }
  if (direction === "CLIENT") {
    addFishingClientHints(fields, header, bytes);
  }
  if (direction === "SERVER") {
    addNamedPacketHints(fields, header, packetName, separatorParts);
  }

  return fields;
}

function addNamedPacketHints(
  fields: Array<{ label: string; value: string }>,
  header: number | null,
  packetName: string | null,
  separatorParts: readonly string[],
): void {
  if (separatorParts.length === 0) return;
  switch (packetName) {
    case "FRIEND_LIST_UPDATE":
    case header === 13 ? "FRIEND_LIST_UPDATE" : "":
      fields.push({ label: "friendUpdateFields", value: String(separatorParts.length) });
      addReadableRows(fields, "friendUpdate", separatorParts, 8);
      return;
    case "ARTICLES_PAGE":
    case header === 681 ? "ARTICLES_PAGE" : "":
      fields.push({ label: "articleRows", value: String(separatorParts.length) });
      addReadableRows(fields, "article", separatorParts, 8);
      return;
    case "CALENDAR_EVENTS":
    case header === 683 ? "CALENDAR_EVENTS" : "":
      fields.push({ label: "calendarRows", value: String(separatorParts.length) });
      addReadableRows(fields, "calendar", separatorParts, 8);
      return;
    case "STATUS_EFFECTS":
    case header === 1242 ? "STATUS_EFFECTS" : "":
      fields.push({ label: "statusEffectFields", value: String(separatorParts.length) });
      addReadableRows(fields, "statusEffect", separatorParts, 8);
      return;
    case "SLIDEOBJECTBUNDLE":
    case header === 230 ? "SLIDEOBJECTBUNDLE" : "":
      fields.push({ label: "slideObjectFields", value: String(separatorParts.length) });
      addReadableRows(fields, "slideObject", separatorParts, 8);
      return;
    case "REMOVE_BUDDY":
    case header === 138 ? "REMOVE_BUDDY" : "":
      fields.push({ label: "buddyRemovePayload", value: printableBodyText(Buffer.from(separatorParts[0] ?? "", "latin1")) });
      return;
  }
}

interface UsersPacketUser {
  readonly index: number;
  readonly accountId: number;
  readonly name: string;
  readonly figure: string;
  readonly gender: string;
  readonly custom: string;
  readonly x: number;
  readonly y: number;
  readonly z: string;
  readonly poolFigure: string;
  readonly badgeCode: string;
  readonly userType: number;
}

interface MessengerFriendPacketRow {
  readonly accountId: number;
  readonly name: string;
  readonly gender: number;
  readonly motto: string;
  readonly online: boolean;
  readonly canFollow: boolean;
  readonly location: string;
  readonly lastAccess: string;
  readonly figure: string;
  readonly categoryId: number;
}

interface MessengerMessagePacketRow {
  readonly id: string;
  readonly senderAccountId: number;
  readonly sentAt: string;
  readonly text: string;
}

interface FriendRequestPacketRow {
  readonly accountId: number;
  readonly name: string;
  readonly requestId: string;
}

interface StatusEffectPacketRow {
  readonly name: string;
  readonly value: number;
}

interface InventoryVl64Token {
  readonly raw: string;
  readonly value: number;
}

interface InventoryPacketItem {
  readonly itemId: string;
  readonly itemIdValue: number;
  readonly slotId: number | null;
  readonly itemType: string;
  readonly inventoryKind: "floor" | "wall";
  readonly objectId: number | null;
  readonly className: string;
  readonly width: number | null;
  readonly length: number | null;
  readonly colors: string;
  readonly data: string;
  readonly head: string;
  readonly body: string;
  readonly meta: string;
  readonly headTokenValues: readonly number[];
  readonly bodyTokenValues: readonly number[];
  readonly metaTokenValues: readonly number[];
}

interface FloorObjectPacketRow {
  readonly objectId: number;
  readonly className: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly direction: number;
  readonly z: string;
  readonly colors: string;
  readonly runtimeData: string;
  readonly extra: number;
  readonly stuffData: string;
  readonly rawPosition: string;
  readonly trailingData: string;
}

interface WallLocationPacketRow {
  readonly wallX: number;
  readonly wallY: number;
  readonly localX: number;
  readonly localY: number;
  readonly orientation: string;
  readonly raw: string;
}

interface WallItemPacketRow {
  readonly itemId: number;
  readonly className: string;
  readonly ownerName: string;
  readonly location: WallLocationPacketRow;
  readonly data: string;
}

interface ActiveObjectAddPacketRow {
  readonly objectId: number;
  readonly className: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly direction: number;
  readonly rawPosition: string;
  readonly runtimeData: string;
  readonly stuffData: string;
  readonly trailingData: string;
}

interface FloorPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly direction: number;
}

class PacketBodyReader {
  private offset = 0;

  public constructor(private readonly bytes: Buffer) {}

  public get position(): number {
    return this.offset;
  }

  public get length(): number {
    return this.bytes.length;
  }

  public readInteger(): number {
    const [value, nextOffset] = readVl64(this.bytes, this.offset);
    this.offset = nextOffset;
    return value;
  }

  public readBoolean(): boolean {
    const value = this.readInteger();
    if (value !== 0 && value !== 1) throw new Error(`invalid boolean value: ${value}`);
    return value === 1;
  }

  public readString(): string {
    const end = this.bytes.indexOf(0x02, this.offset);
    const safeEnd = end >= 0 ? end : this.bytes.length;
    const value = this.bytes.subarray(this.offset, safeEnd).toString("latin1");
    this.offset = end >= 0 ? end + 1 : safeEnd;
    return value;
  }

  public skipLiteral(literal: string): boolean {
    const expected = Buffer.from(literal, "latin1");
    if (this.offset + expected.length > this.bytes.length) return false;
    if (!this.bytes.subarray(this.offset, this.offset + expected.length).equals(expected)) return false;
    this.offset += expected.length;
    return true;
  }

  public remainingText(): string {
    return this.bytes.subarray(this.offset).toString("latin1").replace(/\x02+$/g, "");
  }

  public sliceText(start: number, end: number): string {
    return this.bytes.subarray(start, end).toString("latin1");
  }
}

function readVl64(bytes: Buffer, offset: number): [number, number] {
  if (offset >= bytes.length) throw new Error("VL64 read out of range");
  const totalBytes = (bytes[offset] >> 3) & 7;
  if (totalBytes <= 0 || totalBytes > 6 || offset + totalBytes > bytes.length) {
    throw new Error("invalid VL64 byte-length");
  }

  const negative = (bytes[offset] & 4) === 4;
  let value = bytes[offset] & 3;
  let shift = 2;
  for (let index = 1; index < totalBytes; index += 1) {
    value |= (bytes[offset + index] & 0x3f) << shift;
    shift = 2 + 6 * index;
  }
  return [negative ? -value : value, offset + totalBytes];
}

function parseUsersPacketBody(bytes: Buffer): UsersPacketUser[] {
  const reader = new PacketBodyReader(bytes);
  const count = reader.readInteger();
  if (count < 0 || count > 5000) throw new Error(`invalid user count: ${count}`);

  const users: UsersPacketUser[] = [];
  for (let index = 0; index < count; index += 1) {
    reader.skipLiteral("PAH");
    const user: UsersPacketUser = {
      index: reader.readInteger(),
      accountId: reader.readInteger(),
      name: reader.readString().trim(),
      figure: reader.readString(),
      gender: reader.readString(),
      custom: reader.readString(),
      x: reader.readInteger(),
      y: reader.readInteger(),
      z: reader.readString(),
      poolFigure: reader.readString(),
      badgeCode: reader.readString(),
      userType: reader.readInteger(),
    };

    if (user.userType === 1) {
      reader.readString();
      reader.readString();
      reader.readInteger();
      reader.readInteger();
      reader.readInteger();
    } else if (user.userType === 3 || user.userType === 4) {
      reader.readInteger();
    }

    users.push(user);
  }

  return users;
}

function addUsersPacketHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const users = parseUsersPacketBody(bytes);
    fields.push({ label: "userCount", value: String(users.length) });
    users.forEach((user, index) => {
      const row = index + 1;
      fields.push({ label: `user ${row} name`, value: printableBodyText(Buffer.from(user.name, "latin1")) });
      fields.push({ label: `user ${row} accountId`, value: String(user.accountId) });
      fields.push({ label: `user ${row} index`, value: String(user.index) });
      fields.push({ label: `user ${row} figure`, value: printableBodyText(Buffer.from(user.figure, "latin1")) });
      fields.push({ label: `user ${row} gender`, value: printableBodyText(Buffer.from(user.gender, "latin1")) });
      fields.push({ label: `user ${row} motto`, value: printableBodyText(Buffer.from(user.custom, "latin1")) });
      fields.push({ label: `user ${row} position`, value: `${user.x}, ${user.y}, ${printableBodyText(Buffer.from(user.z, "latin1"))}` });
      fields.push({ label: `user ${row} poolFigure`, value: printableBodyText(Buffer.from(user.poolFigure, "latin1")) });
      fields.push({ label: `user ${row} badge`, value: printableBodyText(Buffer.from(user.badgeCode, "latin1")) });
      fields.push({ label: `user ${row} type`, value: String(user.userType) });
    });
  } catch (error) {
    fields.push({ label: "usersParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function parseMessengerFriend(reader: PacketBodyReader): MessengerFriendPacketRow {
  return {
    accountId: reader.readInteger(),
    name: reader.readString(),
    gender: reader.readInteger(),
    motto: reader.readString(),
    online: reader.readBoolean(),
    canFollow: reader.readBoolean(),
    location: reader.readString(),
    lastAccess: reader.readString(),
    figure: reader.readString(),
    categoryId: reader.readInteger(),
  };
}

function addMessengerInitHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const persistentMessage = reader.readString();
    const userLimit = reader.readInteger();
    const normalLimit = reader.readInteger();
    const extendedLimit = reader.readInteger();
    const friendCount = reader.readInteger();
    if (friendCount < 0 || friendCount > 5000) throw new Error(`invalid friend init count: ${friendCount}`);
    fields.push({ label: "messenger persistentMessage", value: printableBodyText(Buffer.from(persistentMessage, "latin1")) });
    fields.push({ label: "messenger userLimit", value: String(userLimit) });
    fields.push({ label: "messenger normalLimit", value: String(normalLimit) });
    fields.push({ label: "messenger extendedLimit", value: String(extendedLimit) });
    fields.push({ label: "messengerFriendCount", value: String(friendCount) });
    for (let index = 0; index < friendCount; index += 1) {
      addMessengerFriendFields(fields, `friend ${index + 1}`, parseMessengerFriend(reader));
    }
    fields.push({ label: "messenger requestLimit", value: String(reader.readInteger()) });
    fields.push({ label: "messenger requestCount", value: String(reader.readInteger()) });
    fields.push({ label: "messenger messageLimit", value: String(reader.readInteger()) });
    fields.push({ label: "messenger messageCount", value: String(reader.readInteger()) });
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "messenger trailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "messengerInitParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFriendListUpdateHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const count = reader.readInteger();
    if (count < 0 || count > 5000) throw new Error(`invalid friend update count: ${count}`);
    fields.push({ label: "friendUpdateCount", value: String(count) });
    for (let index = 0; index < count; index += 1) {
      addMessengerFriendFields(fields, `friendUpdate ${index + 1}`, parseMessengerFriend(reader));
    }
  } catch (error) {
    fields.push({ label: "friendUpdateParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFriendAddedHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    addMessengerFriendFields(fields, "friendAdded", parseMessengerFriend(new PacketBodyReader(bytes)));
  } catch (error) {
    fields.push({ label: "friendAddedParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function parseMessengerMessage(reader: PacketBodyReader): MessengerMessagePacketRow {
  return {
    id: reader.readString(),
    senderAccountId: reader.readInteger(),
    sentAt: reader.readString(),
    text: reader.readString(),
  };
}

function addMessengerMessagesHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const count = reader.readInteger();
    const unreadCount = reader.readInteger();
    if (count < 0 || count > 5000) throw new Error(`invalid private message count: ${count}`);
    if (unreadCount < 0 || unreadCount > 5000) throw new Error(`invalid private message unread count: ${unreadCount}`);
    fields.push({ label: "privateMessageCount", value: String(count) });
    fields.push({ label: "privateMessageUnreadCount", value: String(unreadCount) });
    for (let index = 0; index < count; index += 1) {
      addMessengerMessageFields(fields, `privateMessage ${index + 1}`, parseMessengerMessage(reader));
    }
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "privateMessageTrailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "privateMessageListParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addMessengerMessageHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    fields.push({ label: "privateMessageCount", value: "1" });
    fields.push({ label: "privateMessageUnreadCount", value: "1" });
    addMessengerMessageFields(fields, "privateMessage 1", parseMessengerMessage(reader));
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "privateMessageTrailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "privateMessageParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function parseFriendRequest(reader: PacketBodyReader): FriendRequestPacketRow {
  const accountId = reader.readInteger();
  return {
    accountId,
    name: reader.readString(),
    requestId: reader.readString() || String(accountId),
  };
}

function addFriendRequestListHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const count = reader.readInteger();
    const pendingCount = reader.readInteger();
    if (count < 0 || count > 5000) throw new Error(`invalid friend request count: ${count}`);
    if (pendingCount < 0 || pendingCount > 5000) throw new Error(`invalid friend request pending count: ${pendingCount}`);
    fields.push({ label: "friendRequestCount", value: String(count) });
    fields.push({ label: "friendRequestPendingCount", value: String(pendingCount) });
    for (let index = 0; index < count; index += 1) {
      addFriendRequestFields(fields, `friendRequest ${index + 1}`, parseFriendRequest(reader));
    }
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "friendRequestTrailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "friendRequestListParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFriendRequestHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    fields.push({ label: "friendRequestCount", value: "1" });
    fields.push({ label: "friendRequestPendingCount", value: "1" });
    addFriendRequestFields(fields, "friendRequest 1", parseFriendRequest(reader));
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "friendRequestTrailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "friendRequestParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addHighlightUserFriendsHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const totalChunks = reader.readInteger();
    const chunkIndex = reader.readInteger();
    const count = reader.readInteger();
    if (count < 0 || count > 5000) throw new Error(`invalid highlight friend count: ${count}`);
    fields.push({ label: "highlightFriendTotalChunks", value: String(totalChunks) });
    fields.push({ label: "highlightFriendChunkIndex", value: String(chunkIndex) });
    fields.push({ label: "highlightFriendCount", value: String(count) });
    for (let index = 0; index < count; index += 1) {
      addMessengerFriendFields(fields, `highlightFriend ${index + 1}`, parseMessengerFriend(reader));
    }
  } catch (error) {
    fields.push({ label: "highlightFriendParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addAvailableBadgesHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const count = reader.readInteger();
    if (count < 0 || count > 1000) throw new Error(`invalid badge count: ${count}`);
    fields.push({ label: "badgeCount", value: String(count) });
    for (let index = 0; index < count; index += 1) {
      fields.push({ label: `badge ${index + 1} code`, value: printableBodyText(Buffer.from(reader.readString(), "latin1")) });
    }
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "badge trailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "badgeParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addActiveBadgeHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    fields.push({ label: "activeBadgeSlot", value: String(reader.readInteger()) });
    fields.push({ label: "activeBadgeCode", value: printableBodyText(Buffer.from(reader.readString(), "latin1")) });
  } catch (error) {
    fields.push({ label: "activeBadgeParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addAccountPreferencesHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const values: number[] = [];
    while (reader.position < reader.length) {
      values.push(reader.readInteger());
    }
    fields.push({ label: "accountPreferenceCount", value: String(values.length) });
    values.forEach((value, index) => fields.push({ label: `accountPreference ${index + 1}`, value: String(value) }));
  } catch (error) {
    fields.push({ label: "accountPreferencesParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addStatusEffectsHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const effects = parseStatusEffectsPacketBody(bytes);
    fields.push({ label: "statusEffectCount", value: String(effects.length) });
    effects.forEach((effect, index) => {
      fields.push({ label: `statusEffect ${index + 1} name`, value: printableBodyText(Buffer.from(effect.name, "latin1")) });
      fields.push({ label: `statusEffect ${index + 1} value`, value: String(effect.value) });
    });
  } catch (error) {
    fields.push({ label: "statusEffectsParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function parseStatusEffectsPacketBody(bytes: Buffer): StatusEffectPacketRow[] {
  const reader = new PacketBodyReader(bytes);
  const count = reader.readInteger();
  if (count < 0 || count > 1000) throw new Error(`invalid status effect count: ${count}`);
  const effects: StatusEffectPacketRow[] = [];
  for (let index = 0; index < count; index += 1) {
    effects.push({ name: reader.readString(), value: reader.readInteger() });
  }
  return effects;
}

function addMessengerFriendFields(fields: Array<{ label: string; value: string }>, prefix: string, friend: MessengerFriendPacketRow): void {
  fields.push({ label: `${prefix} accountId`, value: String(friend.accountId) });
  fields.push({ label: `${prefix} name`, value: printableBodyText(Buffer.from(friend.name, "latin1")) });
  fields.push({ label: `${prefix} gender`, value: String(friend.gender) });
  fields.push({ label: `${prefix} motto`, value: printableBodyText(Buffer.from(friend.motto, "latin1")) });
  fields.push({ label: `${prefix} online`, value: String(friend.online) });
  fields.push({ label: `${prefix} canFollow`, value: String(friend.canFollow) });
  fields.push({ label: `${prefix} location`, value: printableBodyText(Buffer.from(friend.location, "latin1")) });
  fields.push({ label: `${prefix} lastAccess`, value: printableBodyText(Buffer.from(friend.lastAccess, "latin1")) });
  fields.push({ label: `${prefix} figure`, value: printableBodyText(Buffer.from(friend.figure, "latin1")) });
  fields.push({ label: `${prefix} categoryId`, value: String(friend.categoryId) });
}

function addMessengerMessageFields(fields: Array<{ label: string; value: string }>, prefix: string, message: MessengerMessagePacketRow): void {
  fields.push({ label: `${prefix} id`, value: printableBodyText(Buffer.from(message.id, "latin1")) });
  fields.push({ label: `${prefix} senderAccountId`, value: String(message.senderAccountId) });
  fields.push({ label: `${prefix} sentAt`, value: printableBodyText(Buffer.from(message.sentAt, "latin1")) });
  fields.push({ label: `${prefix} text`, value: printableBodyText(Buffer.from(message.text, "latin1")) });
}

function addFriendRequestFields(fields: Array<{ label: string; value: string }>, prefix: string, request: FriendRequestPacketRow): void {
  fields.push({ label: `${prefix} accountId`, value: String(request.accountId) });
  fields.push({ label: `${prefix} name`, value: printableBodyText(Buffer.from(request.name, "latin1")) });
  fields.push({ label: `${prefix} requestId`, value: printableBodyText(Buffer.from(request.requestId, "latin1")) });
}

function addChatPacketHints(fields: Array<{ label: string; value: string }>, header: number, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const index = reader.readInteger();
    const text = reader.readString();
    const [chatType, activity] = chatKindForHeader(header);
    fields.push({ label: "chatIndex", value: String(index) });
    fields.push({ label: "chatText", value: printableBodyText(Buffer.from(text, "latin1")) });
    fields.push({ label: "chatType", value: chatType });
    fields.push({ label: "chatActivity", value: activity });
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "chatTrailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "chatParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function chatKindForHeader(header: number): readonly [string, string] {
  if (header === 25) return ["whisper", "WHISPERING"];
  if (header === 26) return ["shout", "SHOUTING"];
  return ["talk", "TALKING"];
}

function addFishingServerHints(fields: Array<{ label: string; value: string }>, header: number | null, bytes: Buffer): void {
  switch (header) {
    case 680:
      addFishingBulletinHints(fields, bytes);
      return;
    case 1101:
      addFishingChatHints(fields, bytes);
      return;
    case 1102:
      addFishTokenHints(fields, bytes);
      return;
    case 1107:
      fields.push({ label: "fishingMinigameActive", value: "true" });
      fields.push({ label: "fishingStatus", value: "minigame-started" });
      return;
    case 1108:
      addFishingStatusHints(fields, bytes);
      return;
    case 1109:
      fields.push({ label: "fishingMinigameActive", value: "false" });
      fields.push({ label: "fishingStatus", value: "minigame-ended" });
      return;
    case 1115:
      addFishopediaSnapshotHints(fields, bytes);
      return;
    case 1116:
      addFishopediaFishHints(fields, "fishopediaFish", bytes);
      return;
    default:
      return;
  }
}

function addFishingClientHints(fields: Array<{ label: string; value: string }>, header: number | null, bytes: Buffer): void {
  switch (header) {
    case 1100:
      addClientStartFishingHints(fields, bytes);
      return;
    case 1101:
      addClientFishingInputHints(fields, bytes);
      return;
    case 1102:
      fields.push({ label: "fishingClientRequest", value: "fish-tokens" });
      return;
    case 1103:
      fields.push({ label: "fishingClientRequest", value: "store-products" });
      return;
    case 1105:
      fields.push({ label: "fishingClientRequest", value: "rod-level" });
      return;
    case 1106:
      fields.push({ label: "fishingClientRequest", value: "stats" });
      return;
    case 1107:
      fields.push({ label: "fishingClientRequest", value: "fishopedia-fishes" });
      return;
    case 1108:
      fields.push({ label: "fishingClientRequest", value: "derby-register" });
      return;
    default:
      return;
  }
}

function addFishingChatHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  const text = latin1PacketText(bytes);
  fields.push({ label: "fishingChatText", value: printableBodyText(bytes) });
  if (/slipped away/i.test(text)) {
    fields.push({ label: "fishingSlipAway", value: "true" });
    fields.push({ label: "fishingStatus", value: "minigame-failed" });
    return;
  }

  const match = text.match(/(You caught(?: a)? .*?)\s*\(\+(\d+)\s+XP\)/i);
  if (!match) return;
  const message = match[1]!.trim();
  const xp = Number.parseInt(match[2]!, 10);
  fields.push({ label: "fishingCatchMessage", value: printableLatin1(message) });
  fields.push({ label: "fishingCatchName", value: printableLatin1(fishingCatchName(message)) });
  fields.push({ label: "fishingCatchXp", value: Number.isFinite(xp) ? String(xp) : "0" });
  fields.push({ label: "fishingCatchGolden", value: String(/\bgolden\b/i.test(message)) });
  fields.push({ label: "fishingStatus", value: "catch" });
}

function addFishTokenHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    fields.push({ label: "fishTokens", value: String(reader.readInteger()) });
  } catch (error) {
    fields.push({ label: "fishTokensParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFishingStatusHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const values: number[] = [];
    while (reader.position < reader.length && values.length < 8) {
      values.push(reader.readInteger());
    }
    fields.push({ label: "fishingStatusValueCount", value: String(values.length) });
    values.forEach((value, index) => fields.push({ label: `fishingStatus ${index + 1}`, value: String(value) }));
    if (values.length > 0) {
      fields.push({ label: "fishingMinigamePin", value: String(values[0]) });
      fields.push({ label: "fishingMinigameValues", value: values.join(", ") });
    }
  } catch (error) {
    fields.push({ label: "fishingStatusParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFishingBulletinHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  const parts = splitBodyTextParts(bytes);
  if (parts.length === 0) return;
  const joined = parts.join(" ");
  fields.push({ label: "fishingBulletinText", value: printableLatin1(joined) });
  if (/frenzy/i.test(joined)) {
    fields.push({ label: "fishingFrenzyActive", value: "true" });
    fields.push({ label: "fishingFrenzyDurationSec", value: "600" });
  }
  if (/Fishing Derby/i.test(joined)) {
    fields.push({ label: "fishingDerbyMessage", value: printableLatin1(joined) });
  }

  const title = stripFishingPrefixNoise(parts[0] ?? "");
  const message = parts[1] ?? "";
  if (/fishing level/i.test(message) || /leveled up/i.test(title)) {
    fields.push({ label: "fishingLevelTitle", value: printableLatin1(title) });
    fields.push({ label: "fishingLevelMessage", value: printableLatin1(message) });
    const match = message.match(/fishing level\s+(\d+)/i);
    if (match) fields.push({ label: "fishingLevel", value: match[1]! });
  }
}

function addFishopediaSnapshotHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  const parts = splitBodyTextParts(bytes);
  let count = 0;
  for (let index = 0; index < parts.length; index += 5) {
    const row = parts.slice(index, index + 5);
    const fishName = extractLastFishNameToken(row[0] ?? "");
    if (!fishName) continue;
    count += 1;
    addFishopediaFields(fields, `fishopedia ${count}`, row);
  }
  fields.push({ label: "fishopediaCount", value: String(count) });
}

function addFishopediaFishHints(fields: Array<{ label: string; value: string }>, prefix: string, bytes: Buffer): void {
  const parts = splitBodyTextParts(bytes);
  if (parts.length === 0) return;
  addFishopediaFields(fields, prefix, parts.slice(0, 5));
}

function addFishopediaFields(fields: Array<{ label: string; value: string }>, prefix: string, parts: readonly string[]): void {
  const fishName = extractLastFishNameToken(parts[0] ?? "");
  if (!fishName) return;
  fields.push({ label: `${prefix} name`, value: printableLatin1(fishName) });
  const xp = firstInteger(parts[1]);
  if (xp !== null) fields.push({ label: `${prefix} xp`, value: String(xp) });
  const catches = firstInteger(parts[2]);
  if (catches !== null) fields.push({ label: `${prefix} catches`, value: String(catches) });
  if (parts[3]) fields.push({ label: `${prefix} completion`, value: printableLatin1(parts[3]) });
  if (parts[4]) fields.push({ label: `${prefix} location`, value: printableLatin1(parts[4]) });
}

function addClientStartFishingHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    fields.push({ label: "fishingClientAction", value: "start" });
    fields.push({ label: "fishingClientTargetId", value: String(reader.readInteger()) });
  } catch (error) {
    fields.push({ label: "fishingClientStartParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addClientFishingInputHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  const value = decodeOutgoingString(bytes);
  fields.push({ label: "fishingClientAction", value: "minigame-input" });
  fields.push({ label: "fishingClientInput", value: printableLatin1(value || latin1PacketText(bytes)) });
}

function latin1PacketText(bytes: Buffer): string {
  return bytes.toString("latin1").replace(/\x02+$/g, "");
}

function printableLatin1(value: string): string {
  return printableBodyText(Buffer.from(value, "latin1"));
}

function splitBodyTextParts(bytes: Buffer): string[] {
  return latin1PacketText(bytes)
    .split("\x02")
    .map((part) => part.trim())
    .filter(Boolean);
}

function fishingCatchName(message: string): string {
  return message.replace(/^You caught(?: a)?\s+/i, "").replace(/[!.]+$/g, "").trim() || message;
}

function stripFishingPrefixNoise(value: string): string {
  const cleaned = value.trim();
  const match = cleaned.match(/(You leveled up!.*)$/i);
  if (match) return match[1]!.trim();
  return cleaned.replace(/^[^A-Za-z]+/, "").trim();
}

function extractLastFishNameToken(value: string): string | null {
  const matches = value.trim().toLowerCase().match(/[a-z]+(?:_[a-z]+)*/g);
  return matches?.at(-1) ?? null;
}

function firstInteger(value: unknown): number | null {
  const match = String(value ?? "").match(/(-?\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeOutgoingString(bytes: Buffer): string {
  if (bytes.length < 2) return "";
  const length = decodeShockwaveBase64(bytes.subarray(0, 2));
  if (length <= 0 || bytes.length < 2 + length) return "";
  return bytes.subarray(2, 2 + length).toString("latin1");
}

function decodeShockwaveBase64(bytes: Buffer): number {
  let value = 0;
  for (const byte of bytes) value = value * 64 + (byte & 0x3f);
  return value;
}

function parseInventoryItemsPacketBody(bytes: Buffer): InventoryPacketItem[] {
  const reader = new PacketBodyReader(bytes);
  const count = reader.readInteger();
  if (count < 0 || count > 5000) throw new Error(`invalid inventory item count: ${count}`);

  const body = bytes.subarray(reader.position).toString("latin1");
  const segments = body.split("\x02");
  while (segments.length > 0 && !segments.at(-1)) segments.pop();
  if (segments.length === count * 3 + 1) segments.pop();
  if (segments.length !== count * 3) {
    throw new Error(`invalid inventory segment count: expected ${count * 3}, got ${segments.length}`);
  }

  const items: InventoryPacketItem[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(parseInventoryTriplet(segments[index * 3]!, segments[index * 3 + 1]!, segments[index * 3 + 2]!));
  }
  return items;
}

function parseInventoryTriplet(head: string, body: string, meta: string): InventoryPacketItem {
  const [headTokens, itemType] = parseInventoryHead(head);
  const [bodyTokens, className] = parseInventoryBody(body);
  if (!className) throw new Error("missing inventory class name");
  if (headTokens.length === 0) throw new Error("missing inventory item id token");

  const itemId = headTokens[0]!.raw;
  const itemIdValue = headTokens[0]!.value;
  const slotId = headTokens.length >= 2 ? headTokens[1]!.value : null;
  const objectId = bodyTokens.length > 0 ? bodyTokens[0]!.value : null;
  let width: number | null = null;
  let length: number | null = null;
  let colors = "";
  let data = meta;
  let metaTokenValues: readonly number[] = [];

  if (itemType === "S") {
    const [metaTokens, parsedColors] = parseInventoryMeta(meta);
    width = metaTokens.length >= 1 ? metaTokens[0]!.value : null;
    length = metaTokens.length >= 2 ? metaTokens[1]!.value : null;
    colors = parsedColors;
    data = parsedColors;
    metaTokenValues = metaTokens.map((token) => token.value);
  } else if (itemType !== "I") {
    throw new Error(`invalid inventory item type: ${JSON.stringify(itemType)}`);
  }

  return {
    itemId,
    itemIdValue,
    slotId,
    itemType,
    inventoryKind: itemType === "S" ? "floor" : "wall",
    objectId,
    className,
    width,
    length,
    colors,
    data,
    head,
    body,
    meta,
    headTokenValues: headTokens.map((token) => token.value),
    bodyTokenValues: bodyTokens.map((token) => token.value),
    metaTokenValues,
  };
}

function parseInventoryHead(segment: string): readonly [readonly InventoryVl64Token[], string] {
  const data = Buffer.from(segment, "latin1");
  if (data.length === 0) throw new Error("empty inventory head segment");
  const itemType = String.fromCharCode(data[data.length - 1]!);
  const tokens: InventoryVl64Token[] = [];
  let index = 0;
  while (index < data.length - 1) {
    const token = readInventoryVl64Token(data, index, data.length - 1);
    tokens.push(token);
    index += token.raw.length;
  }
  if (index !== data.length - 1) throw new Error("invalid inventory head alignment");
  return [tokens, itemType];
}

function parseInventoryBody(segment: string): readonly [readonly InventoryVl64Token[], string] {
  const data = Buffer.from(segment, "latin1");
  const tokens: InventoryVl64Token[] = [];
  let index = 0;
  for (let count = 0; count < 3; count += 1) {
    const token = readInventoryVl64Token(data, index, data.length);
    tokens.push(token);
    index += token.raw.length;
  }
  return [tokens, data.subarray(index).toString("latin1")];
}

function parseInventoryMeta(segment: string): readonly [readonly InventoryVl64Token[], string] {
  const data = Buffer.from(segment, "latin1");
  const tokens: InventoryVl64Token[] = [];
  let index = 0;
  for (let count = 0; count < 2; count += 1) {
    const token = readInventoryVl64Token(data, index, data.length);
    tokens.push(token);
    index += token.raw.length;
  }
  return [tokens, data.subarray(index).toString("latin1")];
}

function readInventoryVl64Token(data: Buffer, index: number, limit: number): InventoryVl64Token {
  if (index >= limit) throw new Error("inventory token read out of range");
  const totalBytes = (data[index]! >> 3) & 7;
  if (totalBytes <= 0 || totalBytes > 6 || index + totalBytes > limit) {
    throw new Error("invalid inventory VL64 token");
  }
  const [value] = readVl64(data, index);
  return {
    raw: data.subarray(index, index + totalBytes).toString("latin1"),
    value,
  };
}

function addInventoryItemsHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const items = parseInventoryItemsPacketBody(bytes);
    fields.push({ label: "inventoryItemCount", value: String(items.length) });
    items.slice(0, 80).forEach((item, index) => addInventoryItemFields(fields, `inventoryItem ${index + 1}`, item));
    if (items.length > 80) fields.push({ label: "inventoryRowsOmitted", value: String(items.length - 80) });
  } catch (error) {
    fields.push({ label: "inventoryParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addInventoryItemRemoveHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const token = bytes.toString("latin1").replace(/\x02+$/g, "");
    if (!token) throw new Error("missing inventory remove token");
    fields.push({ label: "inventoryRemove id", value: printableBodyText(Buffer.from(token, "latin1")) });
    fields.push({ label: "inventoryRemove raw", value: token });
  } catch (error) {
    fields.push({ label: "inventoryRemoveParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addInventoryItemFields(fields: Array<{ label: string; value: string }>, prefix: string, item: InventoryPacketItem): void {
  fields.push({ label: `${prefix} id`, value: printableBodyText(Buffer.from(item.itemId, "latin1")) });
  fields.push({ label: `${prefix} rawId`, value: item.itemId });
  fields.push({ label: `${prefix} idValue`, value: String(item.itemIdValue) });
  fields.push({ label: `${prefix} slotId`, value: item.slotId === null ? "-" : String(item.slotId) });
  fields.push({ label: `${prefix} objectId`, value: item.objectId === null ? "-" : String(item.objectId) });
  fields.push({ label: `${prefix} type`, value: item.itemType });
  fields.push({ label: `${prefix} kind`, value: item.inventoryKind });
  fields.push({ label: `${prefix} class`, value: printableBodyText(Buffer.from(item.className, "latin1")) });
  fields.push({ label: `${prefix} size`, value: item.width === null && item.length === null ? "-" : `${item.width ?? "-"}x${item.length ?? "-"}` });
  if (item.colors) fields.push({ label: `${prefix} colors`, value: printableBodyText(Buffer.from(item.colors, "latin1")) });
  if (item.data) fields.push({ label: `${prefix} data`, value: printableBodyText(Buffer.from(item.data, "latin1")) });
  fields.push({ label: `${prefix} head`, value: printableBodyText(Buffer.from(item.head, "latin1")) });
  fields.push({ label: `${prefix} body`, value: printableBodyText(Buffer.from(item.body, "latin1")) });
  fields.push({ label: `${prefix} meta`, value: printableBodyText(Buffer.from(item.meta, "latin1")) });
  fields.push({ label: `${prefix} headTokens`, value: item.headTokenValues.join(",") });
  fields.push({ label: `${prefix} bodyTokens`, value: item.bodyTokenValues.join(",") });
  if (item.metaTokenValues.length > 0) fields.push({ label: `${prefix} metaTokens`, value: item.metaTokenValues.join(",") });
}

function parseWallItemsPacketBody(bytes: Buffer): WallItemPacketRow[] {
  const reader = new PacketBodyReader(bytes);
  const items: WallItemPacketRow[] = [];
  while (reader.position < reader.length) {
    const rawItem = reader.readString().replace(/\r+$/g, "");
    if (!rawItem) continue;
    items.push(parseWallItemString(rawItem));
  }
  return items;
}

function parseWallItemPacketBody(bytes: Buffer): WallItemPacketRow {
  const rawItem = bytes.toString("latin1").replace(/[\x02\r]+$/g, "");
  return parseWallItemString(rawItem);
}

function parseWallItemString(value: string): WallItemPacketRow {
  const parts = value.split("\t");
  if (parts.length !== 4 && parts.length !== 5) {
    throw new Error(`invalid wall item field count: ${parts.length}`);
  }
  const itemId = Number.parseInt(parts[0]!, 10);
  if (!Number.isFinite(itemId)) throw new Error(`invalid wall item id: ${JSON.stringify(parts[0])}`);
  return {
    itemId,
    className: parts[1]!,
    ownerName: parts[2]!,
    location: parseWallLocation(parts[3]!),
    data: parts[4] ?? "",
  };
}

function parseWallLocation(value: string): WallLocationPacketRow {
  const match = value.trim().match(/^:w=(-?\d+),(-?\d+)\s+l=(-?\d+),(-?\d+)\s+([lr])$/);
  if (!match) throw new Error(`invalid wall location: ${JSON.stringify(value)}`);
  return {
    wallX: Number.parseInt(match[1]!, 10),
    wallY: Number.parseInt(match[2]!, 10),
    localX: Number.parseInt(match[3]!, 10),
    localY: Number.parseInt(match[4]!, 10),
    orientation: match[5]!,
    raw: value,
  };
}

function addWallItemsPacketHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const items = parseWallItemsPacketBody(bytes);
    fields.push({ label: "wallItemCount", value: String(items.length) });
    items.slice(0, 80).forEach((item, index) => addWallItemFields(fields, `wallItem ${index + 1}`, item));
    if (items.length > 80) fields.push({ label: "wallItemRowsOmitted", value: String(items.length - 80) });
  } catch (error) {
    fields.push({ label: "wallItemsParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addWallItemUpdateHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    addWallItemFields(fields, "wallItemUpdate", parseWallItemPacketBody(bytes));
  } catch (error) {
    fields.push({ label: "wallItemUpdateParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addWallItemRemoveHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const match = bytes.toString("latin1").match(/(\d+)/);
    if (!match) throw new Error("missing wall item remove id");
    fields.push({ label: "wallItemRemove id", value: match[1]! });
  } catch (error) {
    fields.push({ label: "wallItemRemoveParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addWallItemFields(fields: Array<{ label: string; value: string }>, prefix: string, item: WallItemPacketRow): void {
  const state = wallItemState(item.data);
  fields.push({ label: `${prefix} id`, value: String(item.itemId) });
  fields.push({ label: `${prefix} class`, value: printableBodyText(Buffer.from(item.className, "latin1")) });
  fields.push({ label: `${prefix} owner`, value: printableBodyText(Buffer.from(item.ownerName, "latin1")) });
  fields.push({ label: `${prefix} wall`, value: `${item.location.wallX},${item.location.wallY}` });
  fields.push({ label: `${prefix} local`, value: `${item.location.localX},${item.location.localY}` });
  fields.push({ label: `${prefix} orientation`, value: item.location.orientation });
  fields.push({ label: `${prefix} rawLocation`, value: printableBodyText(Buffer.from(item.location.raw, "latin1")) });
  if (item.data) fields.push({ label: `${prefix} data`, value: printableBodyText(Buffer.from(item.data, "latin1")) });
  if (state !== null) fields.push({ label: `${prefix} state`, value: String(state) });
}

function wallItemState(value: string): number | null {
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

function parseFloorObjectsPacketBody(bytes: Buffer): FloorObjectPacketRow[] {
  const reader = new PacketBodyReader(bytes);
  const count = reader.readInteger();
  if (count < 0 || count > 10000) throw new Error(`invalid floor object count: ${count}`);

  const objects: FloorObjectPacketRow[] = [];
  for (let index = 0; index < count; index += 1) {
    objects.push(parseFloorObject(reader));
  }
  return objects;
}

function parseFloorObject(reader: PacketBodyReader): FloorObjectPacketRow {
  const objectId = extractFirstInt(reader.readString());
  const className = reader.readString();
  const rawPositionStart = reader.position;
  const x = reader.readInteger();
  const y = reader.readInteger();
  const width = reader.readInteger();
  const height = reader.readInteger();
  const direction = reader.readInteger();
  const z = reader.readString();
  const rawPosition = reader.sliceText(rawPositionStart, Math.max(rawPositionStart, reader.position - 1));
  const colors = reader.readString();
  const runtimeData = reader.readString();
  const extra = reader.readInteger();
  const stuffData = reader.readString();
  const trailingData =
    className.includes("stall") && !className.includes("stallspace") ? consumeFloorObjectTail(reader).join("\x02") : "";
  return {
    objectId,
    className,
    x,
    y,
    width,
    height,
    direction,
    z,
    colors,
    runtimeData,
    extra,
    stuffData,
    rawPosition,
    trailingData,
  };
}

function parseActiveObjectAddPacketBody(bytes: Buffer): ActiveObjectAddPacketRow {
  const reader = new PacketBodyReader(bytes);
  const objectId = extractFirstInt(reader.readString());
  const className = reader.readString();
  const rawPosition = reader.readString();
  const position = decodeFloorPosition(rawPosition);
  const runtimeData = reader.readString();
  const stuffData = reader.readString();
  const trailingData = reader.remainingText();
  return { objectId, className, ...position, rawPosition, runtimeData, stuffData, trailingData };
}

function decodeFloorPosition(value: string): FloorPosition {
  const bytes = Buffer.from(value, "latin1");
  let index = 0;
  const [x, xEnd] = readVl64(bytes, index);
  index = xEnd;
  const [y, yEnd] = readVl64(bytes, index);
  index = yEnd;
  const [width, widthEnd] = readVl64(bytes, index);
  index = widthEnd;
  const [height, heightEnd] = readVl64(bytes, index);
  index = heightEnd;
  const [direction] = readVl64(bytes, index);
  return { x, y, width: Math.max(width, 1), height: Math.max(height, 1), direction };
}

function consumeFloorObjectTail(reader: PacketBodyReader): string[] {
  const segments: string[] = [];
  while (reader.position < reader.length) {
    if (looksLikeFloorObjectBoundary(reader, reader.position)) break;
    segments.push(reader.readString());
  }
  return segments;
}

function looksLikeFloorObjectBoundary(reader: PacketBodyReader, position: number): boolean {
  const first = peekIncomingSegment(reader, position);
  if (!first.value) return false;
  try {
    extractFirstInt(first.value);
  } catch {
    return false;
  }

  const second = peekIncomingSegment(reader, first.next);
  const third = peekIncomingSegment(reader, second.next);
  if (!second.value || !third.value) return false;
  return looksLikeFloorPositionSegment(third.value);
}

function peekIncomingSegment(reader: PacketBodyReader, position: number): { readonly value: string; readonly next: number } {
  const start = Math.max(0, position);
  let end = start;
  while (end < reader.length && reader.sliceText(end, end + 1) !== "\x02") {
    end += 1;
  }
  return { value: reader.sliceText(start, end), next: end < reader.length ? end + 1 : end };
}

function looksLikeFloorPositionSegment(value: string): boolean {
  const bytes = Buffer.from(value, "latin1");
  let index = 0;
  try {
    for (let count = 0; count < 5; count += 1) {
      [, index] = readVl64(bytes, index);
    }
  } catch {
    return false;
  }

  const remainder = bytes.subarray(index).toString("latin1");
  return /^-?\d+(?:\.\d+)?(?:E-?\d+)?$/.test(remainder);
}

function addFloorObjectsPacketHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const objects = parseFloorObjectsPacketBody(bytes);
    fields.push({ label: "floorObjectCount", value: String(objects.length) });
    objects.slice(0, 40).forEach((object, index) => addFloorObjectFields(fields, `floorObject ${index + 1}`, object));
    if (objects.length > 40) fields.push({ label: "floorObjectRowsOmitted", value: String(objects.length - 40) });
  } catch (error) {
    fields.push({ label: "floorObjectsParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addPlantDataUpdateHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const objectId = extractFirstInt(reader.readString());
    const stageText = reader.readString().trim();
    const data = reader.readString();
    fields.push({ label: "plantData id", value: String(objectId) });
    if (stageText) fields.push({ label: "plantData stage", value: stageText });
    if (data) fields.push({ label: "plantData data", value: printableBodyText(Buffer.from(data, "latin1")) });
  } catch (error) {
    fields.push({ label: "plantDataParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFloorItemDataUpdateHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const objectId = extractFirstInt(reader.readString());
    const data = reader.readString();
    fields.push({ label: "floorItemData id", value: String(objectId) });
    fields.push({ label: "floorItemData data", value: printableBodyText(Buffer.from(data, "latin1")) });
  } catch (error) {
    fields.push({ label: "floorItemDataParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addActiveObjectAddHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const object = parseActiveObjectAddPacketBody(bytes);
    fields.push({ label: "activeObjectAdd id", value: String(object.objectId) });
    fields.push({ label: "activeObjectAdd class", value: printableBodyText(Buffer.from(object.className, "latin1")) });
    fields.push({ label: "activeObjectAdd tile", value: `${object.x}, ${object.y}` });
    fields.push({ label: "activeObjectAdd size", value: `${object.width}x${object.height}` });
    fields.push({ label: "activeObjectAdd direction", value: String(object.direction) });
    fields.push({ label: "activeObjectAdd rawPosition", value: printableBodyText(Buffer.from(object.rawPosition, "latin1")) });
    if (object.runtimeData) {
      fields.push({ label: "activeObjectAdd runtime", value: printableBodyText(Buffer.from(object.runtimeData, "latin1")) });
    }
    if (object.stuffData) {
      fields.push({ label: "activeObjectAdd stuff", value: printableBodyText(Buffer.from(object.stuffData, "latin1")) });
    }
    if (object.trailingData) {
      fields.push({ label: "activeObjectAdd trailing", value: printableBodyText(Buffer.from(object.trailingData, "latin1")) });
    }
  } catch (error) {
    fields.push({ label: "activeObjectAddParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addActiveObjectRemoveHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    fields.push({ label: "activeObjectRemove id", value: String(extractFirstInt(bytes.toString("latin1"))) });
  } catch (error) {
    fields.push({ label: "activeObjectRemoveParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFloorObjectUpdateHints(fields: Array<{ label: string; value: string }>, bytes: Buffer): void {
  try {
    const reader = new PacketBodyReader(bytes);
    const object = parseFloorObject(reader);
    addFloorObjectFields(fields, "floorObjectUpdate", object);
    const trailing = reader.remainingText();
    if (trailing) fields.push({ label: "floorObjectUpdate trailing", value: printableBodyText(Buffer.from(trailing, "latin1")) });
  } catch (error) {
    fields.push({ label: "floorObjectUpdateParseStatus", value: error instanceof Error ? error.message : "failed" });
  }
}

function addFloorObjectFields(fields: Array<{ label: string; value: string }>, prefix: string, object: FloorObjectPacketRow): void {
  fields.push({ label: `${prefix} id`, value: String(object.objectId) });
  fields.push({ label: `${prefix} class`, value: printableBodyText(Buffer.from(object.className, "latin1")) });
  fields.push({ label: `${prefix} tile`, value: `${object.x}, ${object.y}, ${printableBodyText(Buffer.from(object.z, "latin1"))}` });
  fields.push({ label: `${prefix} size`, value: `${object.width}x${object.height}` });
  fields.push({ label: `${prefix} direction`, value: String(object.direction) });
  if (object.rawPosition) fields.push({ label: `${prefix} rawPosition`, value: printableBodyText(Buffer.from(object.rawPosition, "latin1")) });
  if (object.colors) fields.push({ label: `${prefix} colors`, value: printableBodyText(Buffer.from(object.colors, "latin1")) });
  if (object.runtimeData) fields.push({ label: `${prefix} runtime`, value: printableBodyText(Buffer.from(object.runtimeData, "latin1")) });
  fields.push({ label: `${prefix} state`, value: String(object.extra) });
  if (object.stuffData) fields.push({ label: `${prefix} stuff`, value: printableBodyText(Buffer.from(object.stuffData, "latin1")) });
  if (object.trailingData) fields.push({ label: `${prefix} trailing`, value: printableBodyText(Buffer.from(object.trailingData, "latin1")) });
}

function extractFirstInt(value: string): number {
  const match = value.match(/-?\d+/);
  if (!match) throw new Error(`unable to parse integer from ${JSON.stringify(value)}`);
  return Number.parseInt(match[0], 10);
}

function addReadableRows(
  fields: Array<{ label: string; value: string }>,
  prefix: string,
  separatorParts: readonly string[],
  _limit: number,
): void {
  separatorParts
    .map((part) => printableBodyText(Buffer.from(part, "latin1")))
    .filter((part) => /[A-Za-z0-9]/.test(part))
    .forEach((part, index) => {
      fields.push({ label: `${prefix} ${index + 1}`, value: part });
    });
}

function addStatusRowHints(fields: Array<{ label: string; value: string }>, separatorParts: readonly string[]): void {
  separatorParts.forEach((part, index) => {
    const printable = printableBodyText(Buffer.from(part, "latin1"));
    const segments = printable.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      fields.push({ label: `statusRow ${index + 1}`, value: printable });
      return;
    }
    const actorParts = segments[1].split(/\s+/).filter(Boolean);
    fields.push({ label: `statusRow ${index + 1}`, value: printable });
    if (actorParts[0]) fields.push({ label: `statusActor ${index + 1}`, value: actorParts[0] });
    if (actorParts.length > 1) fields.push({ label: `statusRole ${index + 1}`, value: actorParts.slice(1).join(" ") });
    if (segments[2]) fields.push({ label: `statusState ${index + 1}`, value: segments[2] });
  });
}

function maskSensitiveRelayText(message: string): string {
  return message
    .replace(/keyLength=\d+/g, "keyLength=<redacted>")
    .replace(/public key length \d+/g, "public key length <redacted>")
    .replace(/SECRET_KEY received length \d+/g, "SECRET_KEY received length <redacted>")
    .replace(
      /(browser -> official\s+\S+\s+header=(?:4|6|202)\b[^\n]*?\sbodySample=)"(?:\\.|[^"\\])*"/g,
      "$1<redacted>",
    );
}
