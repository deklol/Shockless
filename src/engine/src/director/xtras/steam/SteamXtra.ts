import type { DirectorHostXtraProvider } from "../../hostXtras";
import type { LingoObjectLike, LingoValue } from "../../values";

export type SteamXtraMethod =
  | "steamapi_init"
  | "steamapi_issteamrunning"
  | "steamapi_runcallbacks"
  | "steamapi_shutdown"
  | "isteamuser_getsteamid"
  | "isteamuser_getauthsessionticket"
  | "isteamutils_isoverlayenabled";

export interface SteamXtraHost {
  steamapi_init(): unknown;
  steamapi_issteamrunning(): unknown;
  steamapi_runcallbacks(): unknown;
  steamapi_shutdown(): unknown;
  isteamuser_getsteamid(): unknown;
  isteamuser_getauthsessionticket(): unknown;
  isteamutils_isoverlayenabled(): unknown;
}

class SteamXtraRef implements LingoObjectLike {
  readonly lingoType = "xtraRef";

  lingoToString(): string {
    return 'xtra("SteamXtra")';
  }
}

class SteamXtraInstance implements LingoObjectLike {
  readonly lingoType = "xtra";

  constructor(private readonly host: () => SteamXtraHost | null) {}

  lingoToString(): string {
    return "<SteamXtra host>";
  }

  callMethod(methodName: string): LingoValue | undefined {
    const method = normalizeSteamMethod(methodName);
    if (!method) return undefined;
    const host = this.host();
    if (!host) return unavailableResult(method);
    try {
      const value = host[method]();
      if (method === "isteamuser_getsteamid" || method === "isteamuser_getauthsessionticket") {
        return typeof value === "string" ? value : "";
      }
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return unavailableResult(method);
    }
  }
}

export class SteamXtraProvider implements DirectorHostXtraProvider {
  constructor(private readonly host: () => SteamXtraHost | null) {}

  createXtra(name: string): LingoValue | undefined {
    return name.trim().toLowerCase() === "steamxtra" ? new SteamXtraRef() : undefined;
  }

  createXtraInstance(reference: LingoValue): LingoValue | undefined {
    return reference instanceof SteamXtraRef ? new SteamXtraInstance(this.host) : undefined;
  }

  callMethod(receiver: LingoValue, method: string): LingoValue | undefined {
    return receiver instanceof SteamXtraInstance ? receiver.callMethod(method) : undefined;
  }
}

export function createBrowserSteamXtraProvider(): DirectorHostXtraProvider {
  return new SteamXtraProvider(() => {
    const scope = globalThis as typeof globalThis & { readonly shocklessSteamHost?: unknown };
    return isSteamXtraHost(scope.shocklessSteamHost) ? scope.shocklessSteamHost : null;
  });
}

function normalizeSteamMethod(value: string): SteamXtraMethod | null {
  const method = value.trim().toLowerCase();
  switch (method) {
    case "steamapi_init":
    case "steamapi_issteamrunning":
    case "steamapi_runcallbacks":
    case "steamapi_shutdown":
    case "isteamuser_getsteamid":
    case "isteamuser_getauthsessionticket":
    case "isteamutils_isoverlayenabled":
      return method;
    default:
      return null;
  }
}

function unavailableResult(method: SteamXtraMethod): LingoValue {
  return method === "isteamuser_getsteamid" || method === "isteamuser_getauthsessionticket" ? "" : 0;
}

function isSteamXtraHost(value: unknown): value is SteamXtraHost {
  if (!value || typeof value !== "object") return false;
  const host = value as Partial<SteamXtraHost>;
  return (
    typeof host.steamapi_init === "function" &&
    typeof host.steamapi_issteamrunning === "function" &&
    typeof host.steamapi_runcallbacks === "function" &&
    typeof host.steamapi_shutdown === "function" &&
    typeof host.isteamuser_getsteamid === "function" &&
    typeof host.isteamuser_getauthsessionticket === "function" &&
    typeof host.isteamutils_isoverlayenabled === "function"
  );
}
