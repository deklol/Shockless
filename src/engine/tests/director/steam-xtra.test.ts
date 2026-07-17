import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";
import { SteamXtraProvider, type SteamXtraHost } from "../../src/director/xtras/steam/SteamXtra";

function emptyManifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

function createMovie(provider: SteamXtraProvider): DirectorMovie {
  return new DirectorMovie(
    emptyManifest(),
    { log: () => undefined },
    async () => undefined,
    async () => "",
    new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/origins-data/assets/"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    provider,
  );
}

describe("SteamXtra host provider", () => {
  it("constructs through the source-shaped xtra(\"SteamXtra\").new() dispatch", () => {
    const provider = new SteamXtraProvider(() => ({
      steamapi_init: () => 1,
      steamapi_issteamrunning: () => 1,
      steamapi_runcallbacks: () => 1,
      steamapi_shutdown: () => 1,
      isteamuser_getsteamid: () => "76561198000000000",
      isteamuser_getauthsessionticket: () => "a1b2c3d4",
      isteamutils_isoverlayenabled: () => 0,
    }));
    const movie = createMovie(provider);

    const reference = movie.runtime.call("xtra", ["SteamXtra"]);
    const instance = movie.runtime.callMethod(reference, "new", []);

    expect(movie.runtime.callMethod(instance, "steamapi_init", [])).toBe(1);
    expect(movie.runtime.callMethod(instance, "isteamuser_getauthsessionticket", [])).toBe("a1b2c3d4");
  });

  it("matches the imported client method surface case-insensitively", () => {
    const calls: string[] = [];
    const host: SteamXtraHost = {
      steamapi_init: () => (calls.push("init"), 1),
      steamapi_issteamrunning: () => (calls.push("running"), 1),
      steamapi_runcallbacks: () => (calls.push("callbacks"), 1),
      steamapi_shutdown: () => (calls.push("shutdown"), 1),
      isteamuser_getsteamid: () => (calls.push("steamId"), "76561198000000000"),
      isteamuser_getauthsessionticket: () => (calls.push("ticket"), "a1b2c3d4"),
      isteamutils_isoverlayenabled: () => (calls.push("overlay"), 0),
    };
    const provider = new SteamXtraProvider(() => host);
    const reference = provider.createXtra("  sTeAmXtRa  ");
    expect(reference).toBeDefined();
    const instance = provider.createXtraInstance(reference!);
    expect(instance).toBeDefined();

    expect(provider.callMethod(instance!, "STEAMAPI_INIT")).toBe(1);
    expect(provider.callMethod(instance!, "SteamApi_IsSteamRunning")).toBe(1);
    expect(provider.callMethod(instance!, "isteamuser_getsteamid")).toBe("76561198000000000");
    expect(provider.callMethod(instance!, "ISTEAMUSER_GETAUTHSESSIONTICKET")).toBe("a1b2c3d4");
    expect(provider.callMethod(instance!, "isteamutils_isoverlayenabled")).toBe(0);
    expect(calls).toEqual(["init", "running", "steamId", "ticket", "overlay"]);
    expect(provider.callMethod(instance!, "not_a_source_method")).toBeUndefined();
  });

  it("returns source-compatible unavailable values without inventing credentials", () => {
    const provider = new SteamXtraProvider(() => null);
    const reference = provider.createXtra("SteamXtra")!;
    const instance = provider.createXtraInstance(reference)!;

    expect(provider.callMethod(instance, "steamapi_init")).toBe(0);
    expect(provider.callMethod(instance, "steamapi_issteamrunning")).toBe(0);
    expect(provider.callMethod(instance, "isteamutils_isoverlayenabled")).toBe(0);
    expect(provider.callMethod(instance, "isteamuser_getsteamid")).toBe("");
    expect(provider.callMethod(instance, "isteamuser_getauthsessionticket")).toBe("");
  });

  it("normalizes invalid host return types and host failures", () => {
    const host = {
      steamapi_init: () => "not-a-number",
      steamapi_issteamrunning: () => Number.NaN,
      steamapi_runcallbacks: () => { throw new Error("host failure"); },
      steamapi_shutdown: () => 1,
      isteamuser_getsteamid: () => 123,
      isteamuser_getauthsessionticket: () => null,
      isteamutils_isoverlayenabled: () => 1,
    } satisfies SteamXtraHost;
    const provider = new SteamXtraProvider(() => host);
    const instance = provider.createXtraInstance(provider.createXtra("SteamXtra")!)!;

    expect(provider.callMethod(instance, "steamapi_init")).toBe(0);
    expect(provider.callMethod(instance, "steamapi_issteamrunning")).toBe(0);
    expect(provider.callMethod(instance, "steamapi_runcallbacks")).toBe(0);
    expect(provider.callMethod(instance, "isteamuser_getsteamid")).toBe("");
    expect(provider.callMethod(instance, "isteamuser_getauthsessionticket")).toBe("");
  });
});
