import { contextBridge, ipcRenderer } from "electron";
import type { SteamGuestApi, SteamGuestMethod, SteamGuestResult } from "../shared/steam.js";

// Keep the webview preload runtime-self-contained. It is emitted as CommonJS,
// while the desktop app's shared modules are emitted as ESM; a runtime import
// here prevents the preload from executing before the context bridge is exposed.
const STEAM_GUEST_IPC_CHANNEL = "shockless:steam-guest-call";

const call = (method: SteamGuestMethod): SteamGuestResult =>
  ipcRenderer.sendSync(STEAM_GUEST_IPC_CHANNEL, method) as SteamGuestResult;

const api: SteamGuestApi = Object.freeze({
  steamapi_init: () => call("steamapi_init"),
  steamapi_issteamrunning: () => call("steamapi_issteamrunning"),
  steamapi_runcallbacks: () => call("steamapi_runcallbacks"),
  steamapi_shutdown: () => call("steamapi_shutdown"),
  isteamuser_getsteamid: () => call("isteamuser_getsteamid"),
  isteamuser_getauthsessionticket: () => call("isteamuser_getauthsessionticket"),
  isteamutils_isoverlayenabled: () => call("isteamutils_isoverlayenabled"),
});

contextBridge.exposeInMainWorld("shocklessSteamHost", api);
