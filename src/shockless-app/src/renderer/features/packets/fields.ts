import type { RelayLogEntry } from "../../../shared/window-api";

export function packetFieldMap(entry: RelayLogEntry): globalThis.Map<string, string> {
  const map = new globalThis.Map<string, string>();
  for (const field of entry.decodedFields) {
    map.set(field.label, field.value);
  }
  return map;
}

export function parsedCount(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
