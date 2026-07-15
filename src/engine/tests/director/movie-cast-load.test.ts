import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";
import { LingoPropList } from "../../src/director/values";

function emptyManifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [{ number: 10, name: "empty 1", members: [] }],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

describe("Director dynamic cast loading", () => {
  it("notifies when a cast file is attached to a runtime castLib slot", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_interface",
            castOrder: 1,
            member: 504,
            memberName: "controller_icon",
            mediaType: "bitmap",
            width: 25,
            height: 31,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_interface/0504-controller-icon.png",
          },
        ],
      },
      "/origins-data/assets/",
    );
    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    const loaded: Array<{ name: string; number: number }> = [];
    movie.onCastLoaded = (name, number) => loaded.push({ name, number });

    const castLib = movie.call("castlib", [10]);
    expect(castLib).toBeTruthy();
    movie.setProp(castLib!, "filename", "/origins-data/client/hh_interface.cct");

    expect(loaded).toEqual([{ name: "hh_interface", number: 10 }]);
    expect(members.find((10 << 16) | 504, null)?.name).toBe("controller_icon");
  });

  it("reports completed cast preload streams as nonzero progress", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_interface",
            castOrder: 1,
            member: 504,
            memberName: "controller_icon",
            mediaType: "bitmap",
            width: 25,
            height: 31,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_interface/0504-controller-icon.png",
          },
        ],
      },
      "/origins-data/assets/",
    );
    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    const loaded: Array<{ name: string; number: number }> = [];
    movie.onCastLoaded = (name, number) => loaded.push({ name, number });

    const id = movie.call("preloadnetthing", ["/origins-data/client/hh_interface.cct"]);
    expect(typeof id).toBe("number");

    // Preload results are paced: the queued completion is only released by a
    // netDone/preloadDone poll, mirroring release306's CastLoad polling loop,
    // so the first status probe reports the stream as still in progress.
    const pending = movie.call("getstreamstatus", [id ?? 0]);
    expect(pending).toBeInstanceOf(LingoPropList);
    expect(movie.runtime.getProp(pending!, "state")).toBe("InProgress");
    expect(movie.runtime.getProp(pending!, "bytesTotal")).toBe(1);

    expect(movie.call("netdone", [id ?? 0])).toBe(1);
    const status = movie.call("getstreamstatus", [id ?? 0]);
    expect(status).toBeInstanceOf(LingoPropList);
    expect(movie.runtime.getProp(status!, "state")).toBe("Complete");
    expect(movie.runtime.getProp(status!, "bytesSoFar")).toBe(1);
    expect(movie.runtime.getProp(status!, "bytesTotal")).toBe(1);
    expect(loaded).toEqual([]);
    expect(members.loaded).toEqual([]);
  });
});
