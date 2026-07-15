function parseHiddenUserEntries(input: unknown): readonly string[] {
  const source = Array.isArray(input) ? input.join("\n") : String(input ?? "");
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of source.split(/[\n,;]+/)) {
    const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(cleaned.slice(0, 64));
  }
  return entries;
}

interface HideListEntry {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
  readonly createdAt: string;
}

function hideListTargetKey(target: string): string {
  return target.trim().toLowerCase();
}

function hideListEntryId(target: string): string {
  return hideListTargetKey(target).replace(/[^a-z0-9_.:-]+/gi, "-").slice(0, 80) || "entry";
}

function normalizeHideListReason(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function parseHideListEntries(input: unknown): readonly HideListEntry[] {
  const records: HideListEntry[] = [];
  const seen = new Set<string>();
  const push = (target: unknown, reason: unknown = "", createdAt: unknown = "") => {
    const parsed = parseHiddenUserEntries(String(target ?? ""))[0] ?? "";
    if (!parsed) return;
    const key = hideListTargetKey(parsed);
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      id: hideListEntryId(parsed),
      target: parsed,
      reason: normalizeHideListReason(reason),
      createdAt: typeof createdAt === "string" && createdAt ? createdAt : new Date().toISOString(),
    });
  };

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            push(record.target ?? record.name ?? record.id, record.reason, record.createdAt);
          } else {
            push(entry);
          }
        }
        return records;
      }
    } catch {
      // Legacy plain-text lists are handled below.
    }
  }

  for (const target of parseHiddenUserEntries(input)) push(target);
  return records;
}

function serializeHideListEntries(entries: readonly HideListEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({
    target: entry.target,
    reason: entry.reason,
    createdAt: entry.createdAt,
  })));
}

function hideListEntryLine(entry: HideListEntry): string {
  return entry.reason ? `${entry.target} - ${entry.reason}` : entry.target;
}

export { parseHiddenUserEntries, hideListTargetKey, hideListEntryId, normalizeHideListReason, parseHideListEntries, serializeHideListEntries, hideListEntryLine };
export type { HideListEntry };
