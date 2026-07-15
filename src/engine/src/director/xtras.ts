export type DirectorXtraStatus = "implemented" | "absent" | "fatal";
export type DirectorXtraProvider = "runtime" | "host" | "none";

export interface DirectorXtraRegistration {
  readonly name: string;
  readonly status: DirectorXtraStatus;
  readonly provider: DirectorXtraProvider;
  readonly detail: string;
}

const REGISTRATIONS: readonly DirectorXtraRegistration[] = [
  {
    name: "XMLParser",
    status: "implemented",
    provider: "runtime",
    detail: "Director XML Parser compatibility object",
  },
  {
    name: "Multiuser",
    status: "implemented",
    provider: "host",
    detail: "Origins relay-backed Multiuser transport",
  },
  {
    name: "BobbaXtra",
    status: "implemented",
    provider: "host",
    detail: "Origins relay-terminated crypto compatibility object",
  },
  {
    name: "Curl",
    status: "absent",
    provider: "none",
    detail: "Native Curl Xtra is not executed by the browser runtime",
  },
  {
    name: "FileIO",
    status: "absent",
    provider: "none",
    detail: "Native filesystem Xtra is not exposed to imported movies",
  },
  {
    name: "SteamXtra",
    status: "absent",
    provider: "none",
    detail: "Steam integration is not available in the browser runtime",
  },
];

const REGISTRATION_BY_NAME = new Map(
  REGISTRATIONS.map((registration) => [normalizeXtraName(registration.name), registration]),
);

export function directorXtraRegistration(name: string): DirectorXtraRegistration | null {
  return REGISTRATION_BY_NAME.get(normalizeXtraName(name)) ?? null;
}

export function directorXtraRegistrations(): readonly DirectorXtraRegistration[] {
  return REGISTRATIONS;
}

function normalizeXtraName(name: string): string {
  return name.trim().toLowerCase();
}
