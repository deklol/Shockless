import { packetNameFor, packetNames } from "./packetNames.js";
import { defaultSensitiveClientHeaders } from "./pluginRelayHooks.js";
import { parseShockwavePacketExpression, type ShockwavePacketTarget } from "./shockwavePacketExpression.js";
import { encodeShockwaveBase64Int, formatShockwavePacketText } from "./shockwavePacketText.js";

export const SHOCKWAVE_PLUGIN_PACKET_MAX_BODY_BYTES = 32768;
export const SHOCKWAVE_CLIENT_PACKET_HEADER_MAX = 4095;

export interface PluginPacketInput {
  readonly target?: unknown;
  readonly header?: unknown;
  readonly packetName?: unknown;
  readonly bodyBytes?: unknown;
  readonly bodyHex?: unknown;
  readonly bodyText?: unknown;
  readonly bodyEscapedText?: unknown;
  readonly packetText?: unknown;
}

export interface BuiltShockwavePluginPacket {
  readonly target: ShockwavePacketTarget;
  readonly header: number;
  readonly packetName: string | null;
  readonly body: Uint8Array;
  readonly bodyHex: string;
  readonly packet: Uint8Array;
  readonly packetText: string;
  readonly note: string;
}

export type ShockwavePluginPacketBuildResult =
  | { readonly ok: true; readonly packet: BuiltShockwavePluginPacket }
  | { readonly ok: false; readonly message: string };

type HeaderResolution =
  | { readonly ok: true; readonly header: number }
  | { readonly ok: false; readonly message: string };

type BodyResolution =
  | { readonly ok: true; readonly body: Uint8Array; readonly source: string }
  | { readonly ok: false; readonly message: string };

const normalizedPacketNameIndexes = {
  server: buildPacketNameIndex(packetNames.outgoing),
  client: buildPacketNameIndex(packetNames.incoming),
} as const;

export function buildShockwavePluginPacketFromControl(input: unknown): ShockwavePluginPacketBuildResult {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "Plugin packet must be an object." };
  }

  const record = input as PluginPacketInput;
  const target = parsePacketTarget(record.target);
  if (!target.ok) return target;
  const packetTextBytes = hasValue(record.packetText) ? parseShockwavePacketExpression(record.packetText, target.target) : null;
  if (packetTextBytes && !packetTextBytes.ok) return packetTextBytes;
  if (packetTextBytes?.ok && packetTextBytes.bytes.length < 2) {
    return { ok: false, message: "packetText must include the two-byte Shockwave header." };
  }

  const packetTextHeader = packetTextBytes?.ok ? decodeShockwaveBase64Header(packetTextBytes.bytes.subarray(0, 2)) : null;
  if (packetTextHeader && !packetTextHeader.ok) return packetTextHeader;

  const header = resolvePluginPacketHeader(record, packetTextHeader?.ok ? packetTextHeader.header : null, target.target);
  if (!header.ok) return header;

  const body = resolvePluginPacketBody(record, packetTextBytes?.ok ? packetTextBytes.bytes.subarray(2) : null);
  if (!body.ok) return body;
  if (body.body.length > SHOCKWAVE_PLUGIN_PACKET_MAX_BODY_BYTES) {
    return { ok: false, message: `Plugin packet body is too large: ${body.body.length} bytes.` };
  }

  const sensitivity = target.target === "server" ? validateInjectableClientHeader(header.header) : { ok: true as const };
  if (!sensitivity.ok) return sensitivity;

  const tableName = packetNameFor(target.target === "server" ? "CLIENT" : "SERVER", header.header);
  const packetName = tableName && tableName !== "UNKNOWN_HEADER" ? tableName : null;
  const packet = new Uint8Array([...encodeShockwaveBase64Int(header.header, 2), ...body.body]);
  const bodyHex = bytesToHex(body.body);
  const displayName = packetName ?? "UNKNOWN_HEADER";

  return {
    ok: true,
    packet: {
      target: target.target,
      header: header.header,
      packetName,
      body: body.body,
      bodyHex,
      packet,
      packetText: formatShockwavePacketText(packet),
      note: `Plugin packet to ${target.target} ${displayName} [${header.header}] bodyLen=${body.body.length}`,
    },
  };
}

export function pluginPacketRelayControlPayload(input: unknown): { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  const built = buildShockwavePluginPacketFromControl(input);
  if (!built.ok) return built;
  return {
    ok: true,
    payload: {
      scope: "packet",
      target: built.packet.target,
      header: built.packet.header,
      packetName: built.packet.packetName ?? "UNKNOWN_HEADER",
      bodyHex: built.packet.bodyHex,
    },
  };
}

function resolvePluginPacketHeader(record: PluginPacketInput, packetTextHeader: number | null, target: ShockwavePacketTarget): HeaderResolution {
  const explicitHeader = parseOptionalHeader(record.header);
  if (!explicitHeader.ok) return explicitHeader;
  const packetNameHeader = resolveOptionalPacketNameHeader(record.packetName, target);
  if (!packetNameHeader.ok) return packetNameHeader;

  const candidates = [
    explicitHeader.header === null ? null : { source: "header", value: explicitHeader.header },
    packetNameHeader.header === null ? null : { source: "packetName", value: packetNameHeader.header },
    packetTextHeader === null ? null : { source: "packetText", value: packetTextHeader },
  ].filter((candidate): candidate is { readonly source: string; readonly value: number } => Boolean(candidate));

  if (candidates.length === 0) return { ok: false, message: "Plugin packet requires header, packetName, or packetText." };

  const first = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.value !== first.value) {
      return {
        ok: false,
        message: `Plugin packet ${candidate.source} header ${candidate.value} does not match ${first.source} header ${first.value}.`,
      };
    }
  }

  const requestedName = normalizePacketName(record.packetName);
  if (requestedName === "unknownheader") {
    const tableName = packetNameFor(target === "server" ? "CLIENT" : "SERVER", first.value);
    if (tableName && tableName !== "UNKNOWN_HEADER") {
      return { ok: false, message: `Plugin packet header ${first.value} is known as ${tableName}, not UNKNOWN_HEADER.` };
    }
  }

  return { ok: true, header: first.value };
}

function parseOptionalHeader(value: unknown): { readonly ok: true; readonly header: number | null } | { readonly ok: false; readonly message: string } {
  if (!hasValue(value)) return { ok: true, header: null };
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    parsed = Number.parseInt(value.trim(), 10);
  } else {
    return { ok: false, message: `Invalid plugin packet header: ${String(value)}.` };
  }
  const valid = validateClientHeaderRange(parsed);
  if (!valid.ok) return valid;
  return { ok: true, header: parsed };
}

function resolveOptionalPacketNameHeader(value: unknown, target: ShockwavePacketTarget): { readonly ok: true; readonly header: number | null } | { readonly ok: false; readonly message: string } {
  if (!hasValue(value)) return { ok: true, header: null };
  const normalized = normalizePacketName(value);
  if (!normalized) return { ok: true, header: null };
  if (normalized === "unknownheader") return { ok: true, header: null };

  const headers = normalizedPacketNameIndexes[target].get(normalized);
  if (!headers || headers.length === 0) return { ok: false, message: `Unknown client packet name: ${String(value)}.` };
  if (headers.length > 1) {
    return {
      ok: false,
      message: `Client packet name ${String(value)} is ambiguous (${headers.join(", ")}); use numeric header instead.`,
    };
  }
  const header = headers[0]!;
  const valid = validateClientHeaderRange(header);
  if (!valid.ok) return valid;
  return { ok: true, header };
}

function resolvePluginPacketBody(record: PluginPacketInput, packetTextBody: Uint8Array | null): BodyResolution {
  const sources = [
    packetTextBody === null ? null : "packetText",
    hasValue(record.bodyBytes) ? "bodyBytes" : null,
    hasValue(record.bodyHex) ? "bodyHex" : null,
    hasValue(record.bodyText) ? "bodyText" : null,
    hasValue(record.bodyEscapedText) ? "bodyEscapedText" : null,
  ].filter((source): source is string => Boolean(source));

  if (sources.length === 0) return { ok: true, body: new Uint8Array(), source: "empty" };
  if (sources.length > 1) {
    return { ok: false, message: `Plugin packet body must use exactly one body source; received ${sources.join(", ")}.` };
  }

  const source = sources[0]!;
  if (source === "packetText") return { ok: true, body: packetTextBody ?? new Uint8Array(), source };
  if (source === "bodyBytes") return parseBodyBytes(record.bodyBytes);
  if (source === "bodyHex") return parseBodyHex(record.bodyHex);
  if (source === "bodyText") {
    const parsed = parseLiteralLatin1Text(record.bodyText, "bodyText");
    return parsed.ok ? { ok: true, body: parsed.bytes, source } : parsed;
  }
  const parsed = parseEscapedLatin1Text(record.bodyEscapedText, "bodyEscapedText");
  return parsed.ok ? { ok: true, body: parsed.bytes, source } : parsed;
}

function parseBodyBytes(value: unknown): BodyResolution {
  if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
    return { ok: false, message: "bodyBytes must be an array of byte values." };
  }
  const values = Array.from(value as ArrayLike<unknown>);
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const byte = Number(values[index]);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      return { ok: false, message: `bodyBytes[${index}] is not a byte: ${String(values[index])}.` };
    }
    bytes[index] = byte;
  }
  return { ok: true, body: bytes, source: "bodyBytes" };
}

function parseBodyHex(value: unknown): BodyResolution {
  const normalized = String(value ?? "").replace(/[\s:_-]+/g, "").toLowerCase();
  if (normalized.length === 0) return { ok: true, body: new Uint8Array(), source: "bodyHex" };
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    return { ok: false, message: "bodyHex must be even-length hexadecimal." };
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return { ok: true, body: bytes, source: "bodyHex" };
}

function parseLiteralLatin1Text(value: unknown, label: string): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly message: string } {
  const text = String(value ?? "");
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) return { ok: false, message: `${label} must be Latin-1 byte text; character ${index} is ${code}.` };
    bytes[index] = code;
  }
  return { ok: true, bytes };
}

function parseEscapedLatin1Text(value: unknown, label: string): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly message: string } {
  const text = String(value ?? "");
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (text[index] !== "[") {
      if (code > 0xff) return { ok: false, message: `${label} must be Latin-1 byte text; character ${index} is ${code}.` };
      bytes.push(code);
      continue;
    }

    const close = text.indexOf("]", index + 1);
    if (close < 0) return { ok: false, message: `${label} has an unclosed byte escape at character ${index}.` };
    const rawValue = text.slice(index + 1, close);
    if (!/^[0-9]{1,3}$/.test(rawValue)) return { ok: false, message: `${label} has invalid byte escape [${rawValue}].` };
    const byte = Number.parseInt(rawValue, 10);
    if (byte < 0 || byte > 255) return { ok: false, message: `${label} byte escape [${rawValue}] is outside 0..255.` };
    bytes.push(byte);
    index = close;
  }
  return { ok: true, bytes: new Uint8Array(bytes) };
}

function decodeShockwaveBase64Header(bytes: Uint8Array): HeaderResolution {
  if (bytes.length !== 2) return { ok: false, message: "Shockwave packet headers must be two bytes." };
  let header = 0;
  for (const byte of bytes) {
    if (byte < 0x40 || byte > 0x7f) {
      return { ok: false, message: `packetText header byte ${byte} is not Shockwave base64.` };
    }
    header = (header << 6) | (byte - 0x40);
  }
  return validateClientHeaderRange(header);
}

function validateClientHeaderRange(header: number): HeaderResolution {
  if (!Number.isInteger(header) || header <= 0) return { ok: false, message: `Invalid plugin packet header: ${String(header)}.` };
  if (header > SHOCKWAVE_CLIENT_PACKET_HEADER_MAX) {
    return { ok: false, message: `Plugin packet header ${header} does not fit the two-byte Shockwave client header.` };
  }
  return { ok: true, header };
}

function validateInjectableClientHeader(header: number): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (defaultSensitiveClientHeaders().includes(header)) {
    const packetName = packetNameFor("CLIENT", header);
    const displayName = packetName && packetName !== "UNKNOWN_HEADER" ? packetName : "sensitive client";
    return { ok: false, message: `Plugin packet injection refuses ${displayName} header ${header}.` };
  }
  return { ok: true };
}

function normalizePacketName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function buildPacketNameIndex(source: Readonly<Record<string, string>>): Map<string, readonly number[]> {
  const mutable = new Map<string, number[]>();
  for (const [rawHeader, rawName] of Object.entries(source)) {
    const header = Number(rawHeader);
    const normalized = normalizePacketName(rawName);
    if (!Number.isInteger(header) || !normalized) continue;
    const headers = mutable.get(normalized) ?? [];
    headers.push(header);
    mutable.set(normalized, headers);
  }
  return new Map([...mutable.entries()].map(([name, headers]) => [name, [...new Set(headers)].sort((a, b) => a - b)]));
}

function parsePacketTarget(value: unknown): { readonly ok: true; readonly target: ShockwavePacketTarget } | { readonly ok: false; readonly message: string } {
  const normalized = String(value ?? "server").trim().toLowerCase();
  if (normalized === "server" || normalized === "toserver" || normalized === "outgoing") return { ok: true, target: "server" };
  if (normalized === "client" || normalized === "toclient" || normalized === "incoming") return { ok: true, target: "client" };
  return { ok: false, message: `Plugin packet target must be server or client, not ${String(value)}.` };
}
