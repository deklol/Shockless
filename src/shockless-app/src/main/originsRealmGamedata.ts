import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { OriginsRealmDefinition } from "../shared/originsRealm.js";
import { originsRealmGamedataUrl } from "../shared/originsRealm.js";

export interface OriginsRealmBootData {
  readonly variables: string;
  readonly texts: string;
  readonly variablesSource: "network" | "cache" | "profile";
  readonly textsSource: "network" | "cache" | "profile";
}

const REALM_FETCH_TIMEOUT_MS = 8_000;
const MINIMUM_PROFILE_KEY_COVERAGE = 0.75;
const WINDOWS_1252_DECODER = new TextDecoder("windows-1252");

export class OriginsRealmGamedataCache {
  private readonly pending = new Map<string, Promise<OriginsRealmBootData>>();

  constructor(private readonly cacheRoot: string) {}

  load(
    realm: OriginsRealmDefinition,
    profileVariables: string,
    profileTexts: string,
  ): Promise<OriginsRealmBootData> {
    let pending = this.pending.get(realm.id);
    if (!pending) {
      pending = this.loadUncached(realm, profileVariables, profileTexts);
      this.pending.set(realm.id, pending);
    }
    return pending;
  }

  clear(): void {
    this.pending.clear();
  }

  private async loadUncached(
    realm: OriginsRealmDefinition,
    profileVariables: string,
    profileTexts: string,
  ): Promise<OriginsRealmBootData> {
    const realmCacheRoot = join(this.cacheRoot, "gamedata", "realms", realm.id);
    mkdirSync(realmCacheRoot, { recursive: true });

    const variablesResult = await fetchWithCache(
      originsRealmGamedataUrl(realm, "external_variables/1"),
      join(realmCacheRoot, "external_variables.txt"),
      profileVariables,
    );
    const externalTextsUrl = lastExternalVariableValue(variablesResult.text, "external.texts.txt");
    const trustedTextsUrl = externalTextsUrl && trustedRealmGamedataUrl(externalTextsUrl, realm)
      ? externalTextsUrl
      : null;
    const textsResult = trustedTextsUrl
      ? await fetchWithCache(
          trustedTextsUrl,
          join(realmCacheRoot, "external_texts.txt"),
          profileTexts,
          {
            decode: decodeOriginsExternalTexts,
            validate: (text) => isCompatibleOriginsExternalTexts(text, profileTexts),
          },
        )
      : cachedOrFallback(
          join(realmCacheRoot, "external_texts.txt"),
          profileTexts,
          (text) => isCompatibleOriginsExternalTexts(text, profileTexts),
        );

    return {
      variables: variablesResult.text,
      texts: textsResult.text,
      variablesSource: variablesResult.source,
      textsSource: textsResult.source,
    };
  }
}

export function lastExternalVariableValue(text: string, key: string): string | null {
  const normalizedKey = key.trim().toLowerCase();
  let result: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== normalizedKey) continue;
    result = line.slice(separator + 1).trim();
  }
  return result;
}

function trustedRealmGamedataUrl(value: string, realm: OriginsRealmDefinition): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const realmHost = new URL(realm.gamedataOrigin).hostname.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    return hostname === realmHost;
  } catch {
    return false;
  }
}

async function fetchWithCache(
  url: string,
  cachePath: string,
  fallback: string,
  options: {
    readonly decode?: (bytes: Uint8Array) => string;
    readonly validate?: (text: string) => boolean;
  } = {},
): Promise<{ readonly text: string; readonly source: OriginsRealmBootData["variablesSource"] }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REALM_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = options.decode ? options.decode(bytes) : new TextDecoder().decode(bytes);
    if (!text.trim()) throw new Error("empty response");
    if (options.validate && !options.validate(text)) throw new Error("incompatible response");
    writeFileSync(cachePath, text, "utf8");
    return { text, source: "network" };
  } catch {
    return cachedOrFallback(cachePath, fallback, options.validate);
  }
}

function cachedOrFallback(
  cachePath: string,
  fallback: string,
  validate?: (text: string) => boolean,
): { readonly text: string; readonly source: "cache" | "profile" } {
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8");
    if (cached.trim() && (!validate || validate(cached))) return { text: cached, source: "cache" };
    unlinkSync(cachePath);
  }
  return { text: fallback, source: "profile" };
}

export function decodeOriginsExternalTexts(bytes: Uint8Array): string {
  return WINDOWS_1252_DECODER.decode(bytes);
}

export function isCompatibleOriginsExternalTexts(candidate: string, profileTexts: string): boolean {
  const expectedKeys = externalTextKeys(profileTexts);
  if (expectedKeys.size === 0) return externalTextKeys(candidate).size > 0;

  const candidateKeys = externalTextKeys(candidate);
  let matches = 0;
  for (const key of expectedKeys) {
    if (candidateKeys.has(key)) matches += 1;
  }
  return matches / expectedKeys.size >= MINIMUM_PROFILE_KEY_COVERAGE;
}

function externalTextKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key) keys.add(key);
  }
  return keys;
}
