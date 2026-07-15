export type OriginsRealmId = "ous" | "oes" | "obr";

export interface OriginsRealmDefinition {
  readonly id: OriginsRealmId;
  readonly label: string;
  readonly webOrigin: string;
  readonly gamedataOrigin: string;
  readonly gameHost: string;
  readonly gamePort: number;
  readonly musHost: string;
  readonly musPort: number;
  readonly nativeEntryView: "hh_entry_uk" | "hh_entry_es" | "hh_entry_br";
  readonly patchCast: "hh_patch_uk" | "hh_patch_es" | "hh_patch_br";
}

export const DEFAULT_ORIGINS_REALM: OriginsRealmId = "ous";

export const ORIGINS_REALMS: readonly OriginsRealmDefinition[] = [
  {
    id: "ous",
    label: "US / UK",
    webOrigin: "https://origins.habbo.com",
    gamedataOrigin: "https://origins-gamedata.habbo.com",
    gameHost: "game-ous.habbo.com",
    gamePort: 40001,
    musHost: "game-ous.habbo.com",
    musPort: 40002,
    nativeEntryView: "hh_entry_uk",
    patchCast: "hh_patch_uk",
  },
  {
    id: "oes",
    label: "Spain",
    webOrigin: "https://origins.habbo.es",
    gamedataOrigin: "https://origins-gamedata.habbo.es",
    gameHost: "game-oes.habbo.com",
    gamePort: 40001,
    musHost: "game-oes.habbo.com",
    musPort: 40002,
    nativeEntryView: "hh_entry_es",
    patchCast: "hh_patch_es",
  },
  {
    id: "obr",
    label: "Brazil / Portugal",
    webOrigin: "https://origins.habbo.com.br",
    gamedataOrigin: "https://origins-gamedata.habbo.com.br",
    gameHost: "game-obr.habbo.com",
    gamePort: 40001,
    musHost: "game-obr.habbo.com",
    musPort: 40002,
    nativeEntryView: "hh_entry_br",
    patchCast: "hh_patch_br",
  },
] as const;

const REALM_BY_ID: ReadonlyMap<OriginsRealmId, OriginsRealmDefinition> = new Map(
  ORIGINS_REALMS.map((realm) => [realm.id, realm]),
);

export function normalizeOriginsRealmId(value: unknown): OriginsRealmId {
  if (typeof value !== "string") return DEFAULT_ORIGINS_REALM;
  const normalized = value.trim().toLowerCase() as OriginsRealmId;
  return REALM_BY_ID.has(normalized) ? normalized : DEFAULT_ORIGINS_REALM;
}

export function originsRealmDefinition(value: unknown): OriginsRealmDefinition {
  return REALM_BY_ID.get(normalizeOriginsRealmId(value)) ?? ORIGINS_REALMS[0]!;
}

export function originsRealmGamedataUrl(realm: OriginsRealmDefinition, endpoint: string): string {
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return `${realm.gamedataOrigin}/${normalizedEndpoint}`;
}

export function originsRealmUserLookupUrl(realm: OriginsRealmDefinition): string {
  return `${realm.webOrigin}/api/public/users`;
}
