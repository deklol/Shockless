import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";

function emptyManifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

function createMovie(fetchText: (url: string) => Promise<string>): DirectorMovie {
  return new DirectorMovie(
    emptyManifest(),
    { log: () => undefined },
    async () => undefined,
    fetchText,
    new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/origins-data/assets/"),
  );
}

async function settleNetJobs(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Director network host", () => {
  it("retains only a bounded set of completed getNetText results", async () => {
    const movie = createMovie(async (url) => `body:${url}`);
    const ids: number[] = [];

    for (let index = 0; index < 35; index += 1) {
      ids.push(movie.runtime.call("getNetText", [`https://example.test/${index}.txt`]) as number);
    }
    await settleNetJobs();

    expect(movie.runtime.call("netTextResult", [ids[0]!])).toBe("");
    expect(movie.runtime.call("netTextResult", [ids[1]!])).toBe("");
    expect(movie.runtime.call("netTextResult", [ids[2]!])).toBe("");
    expect(movie.runtime.call("netTextResult", [ids[3]!])).toContain("/3.txt");
    expect(movie.runtime.call("netTextResult", [ids[34]!])).toContain("/34.txt");
  });

  it("does not evict loading network jobs while trimming completed results", async () => {
    const pending = { resolve: null as ((value: string) => void) | null };
    const movie = createMovie((url) => {
      if (url.endsWith("/pending.txt")) {
        return new Promise<string>((resolve) => {
          pending.resolve = resolve;
        });
      }
      return Promise.resolve(`body:${url}`);
    });

    const pendingId = movie.runtime.call("getNetText", ["https://example.test/pending.txt"]) as number;
    for (let index = 0; index < 35; index += 1) {
      movie.runtime.call("getNetText", [`https://example.test/${index}.txt`]);
    }
    await settleNetJobs();

    expect(movie.runtime.call("netDone", [pendingId])).toBe(0);
    expect(movie.runtime.call("getStreamStatus", [pendingId])).toMatchObject({ values: expect.arrayContaining(["InProgress"]) });

    if (!pending.resolve) throw new Error("pending network job did not start");
    pending.resolve("pending");
    await settleNetJobs();

    expect(movie.runtime.call("netDone", [pendingId])).toBe(1);
  });
});
