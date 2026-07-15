import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FurniMetadataEntry, FurniMetadataSnapshot } from "../shared/window-api.js";
import {
  DEFAULT_ORIGINS_REALM,
  originsRealmDefinition,
  originsRealmGamedataUrl,
  type OriginsRealmId,
} from "../shared/originsRealm.js";
import { appDataStorePath, firstExistingAppDataStorePath } from "./appDataPaths.js";

const FURNIDATA_CACHE_FILE = "furnidata.txt";

const XML_FURNI_PATTERN =
  /<furnitype\s+id="(\d+)"\s+classname="([^"]+)">.*?<category>(.*?)<\/category>.*?<name>(.*?)<\/name>.*?<description>(.*?)<\/description>.*?<rare>(\d+)<\/rare>.*?<\/furnitype>/gs;

export function parseFurnidataText(text: string): readonly FurniMetadataEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return parseJsonFurnidata(trimmed);
  if (trimmed.includes("<furnitype")) return parseXmlFurnidata(trimmed);
  return [];
}

export async function readFurniMetadataSnapshot(
  appDataPath: string,
  realmId: OriginsRealmId = DEFAULT_ORIGINS_REALM,
): Promise<FurniMetadataSnapshot> {
  const realm = originsRealmDefinition(realmId);
  const cachePath = firstExistingAppDataStorePath(appDataPath, "gamedata", "realms", realm.id, FURNIDATA_CACHE_FILE);
  const writeCachePath = appDataStorePath(appDataPath, "gamedata", "realms", realm.id, FURNIDATA_CACHE_FILE);
  let text = "";
  let source: FurniMetadataSnapshot["source"] = "none";
  let message = "No furnidata cache is available yet.";

  if (existsSync(cachePath)) {
    text = readFileSync(cachePath, "utf8");
    source = "cache";
    message = "Loaded furnidata from the local Shockless gamedata cache.";
  } else {
    try {
      const response = await fetch(originsRealmGamedataUrl(realm, "furnidata/1"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      mkdirSync(dirname(writeCachePath), { recursive: true });
      writeFileSync(writeCachePath, text, "utf8");
      source = "network";
      message = "Fetched furnidata from Origins and cached it locally.";
    } catch (error) {
      return {
        source: "none",
        fetchedAt: new Date().toISOString(),
        entryCount: 0,
        entriesByClass: {},
        message: error instanceof Error ? `Furnidata unavailable: ${error.message}` : "Furnidata unavailable.",
      };
    }
  }

  const entries = parseFurnidataText(text);
  return {
    source,
    fetchedAt: new Date().toISOString(),
    entryCount: entries.length,
    entriesByClass: Object.fromEntries(entries.map((entry) => [normalizeClassName(entry.className), entry])),
    message,
  };
}

export function normalizeClassName(className: string): string {
  return className.replace(/^ZaC/i, "").trim().toLowerCase();
}

function parseJsonFurnidata(text: string): readonly FurniMetadataEntry[] {
  const rows = parseJsonRowPayloads(text);
  return rows
    .map((row) => (Array.isArray(row) ? jsonRowToEntry(row) : null))
    .filter((entry): entry is FurniMetadataEntry => Boolean(entry));
}

function parseJsonRowPayloads(text: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return parseConcatenatedJsonArrays(text).flatMap((payload) => (Array.isArray(payload) ? payload : []));
  }
}

function parseConcatenatedJsonArrays(text: string): readonly unknown[] {
  const payloads: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          payloads.push(JSON.parse(text.slice(start, index + 1)) as unknown);
        } catch {
          // Ignore malformed segments and keep any complete arrays already found.
        }
        start = -1;
      }
    }
  }

  return payloads;
}

function jsonRowToEntry(row: readonly unknown[]): FurniMetadataEntry | null {
  const kindCode = stringAt(row, 0);
  const id = stringAt(row, 1);
  const className = stringAt(row, 2);
  if (!id || !className) return null;
  return {
    id,
    className,
    kind: kindCode === "i" ? "wall" : "floor",
    name: stringAt(row, 8) || className,
    description: stringAt(row, 9) || "",
    category: stringAt(row, 11) || "",
    width: numberAt(row, 5),
    height: numberAt(row, 6),
    rare: boolLike(row[row.length - 1]),
  };
}

function parseXmlFurnidata(text: string): readonly FurniMetadataEntry[] {
  return [...text.matchAll(XML_FURNI_PATTERN)].map((match) => ({
    id: match[1] ?? "",
    className: match[2] ?? "",
    kind: "floor",
    category: match[3] ?? "",
    name: match[4] ?? match[2] ?? "",
    description: match[5] ?? "",
    rare: match[6] !== "0",
  }));
}

function stringAt(row: readonly unknown[], index: number): string {
  const value = row[index];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function numberAt(row: readonly unknown[], index: number): number | null {
  const parsed = Number(row[index]);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolLike(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  if (typeof value === "number") return value !== 0;
  return false;
}
