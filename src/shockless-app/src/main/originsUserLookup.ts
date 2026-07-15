import type { OriginsUserLookupResult } from "../shared/window-api.js";
import {
  DEFAULT_ORIGINS_REALM,
  originsRealmDefinition,
  originsRealmUserLookupUrl,
  type OriginsRealmId,
} from "../shared/originsRealm.js";

export function normalizeOriginsUserLookup(record: unknown, query: string): OriginsUserLookupResult {
  const source = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
  const id = stringField(source, ["uniqueId", "id", "userId"]);
  const name = stringField(source, ["name", "username"]) || query.trim();
  return {
    ok: Boolean(id || name),
    query: query.trim(),
    source: "official-origins-public-api",
    id,
    name,
    figureString: stringField(source, ["figureString", "figure", "look"]),
    motto: stringField(source, ["motto", "mission"]),
    memberSince: stringField(source, ["memberSince", "createdAt", "creationTime"]),
    profileVisible: booleanField(source, ["profileVisible", "profileVisibility"]),
    selectedBadges: arrayField(source, ["selectedBadges", "badges"]),
    message: id || name ? "Loaded public Origins user profile." : "No public Origins user profile was returned.",
  };
}

export async function lookupOriginsUser(
  query: string,
  realmId: OriginsRealmId = DEFAULT_ORIGINS_REALM,
): Promise<OriginsUserLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      ok: false,
      query: "",
      source: "official-origins-public-api",
      id: "",
      name: "",
      figureString: "",
      motto: "",
      memberSince: "",
      profileVisible: null,
      selectedBadges: [],
      message: "Enter a Habbo name to look up.",
    };
  }

  const url = new URL(originsRealmUserLookupUrl(originsRealmDefinition(realmId)));
  url.searchParams.set("name", trimmed);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
    });
    if (!response.ok) {
      return emptyLookup(trimmed, `Origins user lookup failed with HTTP ${response.status}.`);
    }
    const json = (await response.json()) as unknown;
    const firstRecord = firstUserRecord(json);
    if (!firstRecord) return emptyLookup(trimmed, "No public Origins user profile matched that name.");
    return normalizeOriginsUserLookup(firstRecord, trimmed);
  } catch (error) {
    return emptyLookup(trimmed, error instanceof Error ? error.message : "Origins user lookup failed.");
  }
}

function firstUserRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value[0] ?? null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["user", "profile", "data"]) {
    if (record[key] && typeof record[key] === "object") return record[key];
  }
  if (Array.isArray(record.users)) return record.users[0] ?? null;
  if (Array.isArray(record.results)) return record.results[0] ?? null;
  return record;
}

function emptyLookup(query: string, message: string): OriginsUserLookupResult {
  return {
    ok: false,
    query,
    source: "official-origins-public-api",
    id: "",
    name: query,
    figureString: "",
    motto: "",
    memberSince: "",
    profileVisible: null,
    selectedBadges: [],
    message,
  };
}

function stringField(source: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function booleanField(source: Record<string, unknown>, names: readonly string[]): boolean | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return null;
}

function arrayField(source: Record<string, unknown>, names: readonly string[]): readonly string[] {
  for (const name of names) {
    const value = source[name];
    if (!Array.isArray(value)) continue;
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") return stringField(entry as Record<string, unknown>, ["code", "badgeCode", "id"]);
        return "";
      })
      .filter(Boolean);
  }
  return [];
}
