export interface MimicRelayPacketInput {
  readonly header?: unknown;
  readonly bodyHex?: unknown;
  readonly packetName?: unknown;
}

export interface MimicRelayPacket {
  readonly header: number;
  readonly body: Uint8Array;
  readonly bodyHex: string;
  readonly packetName: string | null;
  readonly note: string;
}

export type MimicRelayPacketResult =
  | { readonly ok: true; readonly packet: MimicRelayPacket }
  | { readonly ok: false; readonly message: string };

const sensitiveClientHeaders = new Set([4, 6, 202]);
const legacySafeFallbackHeaders = new Set([55, 80, 93, 94]);
const allowedPacketNames = new Set([
  "carrydrink",
  "carryitem",
  "chat",
  "dance",
  "lookto",
  "move",
  "originsmove",
  "shout",
  "sign",
  "swimsuit",
  "update",
  "usercanceltyping",
  "userstarttyping",
  "wave",
  "whisper",
]);
const maxBodyBytes = 8192;

export function buildMimicRelayPacketFromControl(record: MimicRelayPacketInput): MimicRelayPacketResult {
  const header = parsePositiveInteger(record.header, "header");
  if (!header.ok) return header;
  const packetName = normalizedPacketName(record.packetName);
  const bodyHex = normalizeMimicBodyHex(record.bodyHex);
  if (!bodyHex.ok) return bodyHex;
  const allowed = isAllowedMimicPacket({ header: header.value, packetName });
  if (!allowed.ok) return allowed;

  const body = hexToBytes(bodyHex.value);
  return {
    ok: true,
    packet: {
      header: header.value,
      body,
      bodyHex: bodyHex.value,
      packetName,
      note: `Mimic ${packetName ?? "UNKNOWN_HEADER"} header=${header.value} bodyLen=${body.length}`,
    },
  };
}

export function isAllowedMimicPacket(input: {
  readonly header: number;
  readonly packetName?: string | null;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (!Number.isInteger(input.header) || input.header <= 0) {
    return { ok: false, message: `Invalid Mimic header: ${String(input.header)}.` };
  }
  if (sensitiveClientHeaders.has(input.header)) {
    return { ok: false, message: `Mimic refuses sensitive client header ${input.header}.` };
  }

  const packetName = normalizedPacketName(input.packetName);
  if (packetName && allowedPacketNames.has(packetName)) return { ok: true };
  if (legacySafeFallbackHeaders.has(input.header)) return { ok: true };

  return {
    ok: false,
    message: `Mimic packet is not whitelisted: ${input.packetName || "UNKNOWN_HEADER"} header=${input.header}.`,
  };
}

export function normalizeMimicBodyHex(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const normalized = String(value ?? "").replace(/\s+/g, "").toLowerCase();
  if (normalized.length === 0) return { ok: true, value: "" };
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    return { ok: false, message: "Mimic packet body must be even-length hexadecimal." };
  }
  const bodyBytes = normalized.length / 2;
  if (bodyBytes > maxBodyBytes) {
    return { ok: false, message: `Mimic packet body is too large: ${bodyBytes} bytes.` };
  }
  return { ok: true, value: normalized };
}

function normalizedPacketName(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parsePositiveInteger(value: unknown, label: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, message: `Invalid Mimic ${label}: ${String(value ?? "")}.` };
  return { ok: true, value: parsed };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
