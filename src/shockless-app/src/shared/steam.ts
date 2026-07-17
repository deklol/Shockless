export const ORIGINS_STEAM_APP_ID = 3_809_900;

export const STEAM_GUEST_IPC_CHANNEL = "shockless:steam-guest-call";

export type SteamGuestMethod =
  | "steamapi_init"
  | "steamapi_issteamrunning"
  | "steamapi_runcallbacks"
  | "steamapi_shutdown"
  | "isteamuser_getsteamid"
  | "isteamuser_getauthsessionticket"
  | "isteamutils_isoverlayenabled";

export type SteamGuestResult = number | string;

export interface SteamGuestApi {
  steamapi_init(): SteamGuestResult;
  steamapi_issteamrunning(): SteamGuestResult;
  steamapi_runcallbacks(): SteamGuestResult;
  steamapi_shutdown(): SteamGuestResult;
  isteamuser_getsteamid(): SteamGuestResult;
  isteamuser_getauthsessionticket(): SteamGuestResult;
  isteamutils_isoverlayenabled(): SteamGuestResult;
}

export function unavailableSteamGuestResult(method: SteamGuestMethod): SteamGuestResult {
  return method === "isteamuser_getsteamid" || method === "isteamuser_getauthsessionticket" ? "" : 0;
}

export function isSteamGuestMethod(value: unknown): value is SteamGuestMethod {
  return (
    value === "steamapi_init" ||
    value === "steamapi_issteamrunning" ||
    value === "steamapi_runcallbacks" ||
    value === "steamapi_shutdown" ||
    value === "isteamuser_getsteamid" ||
    value === "isteamuser_getauthsessionticket" ||
    value === "isteamutils_isoverlayenabled"
  );
}
