import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";
import { ScriptInstance } from "../../src/director/Runtime";
import { LINGO_VOID, symbol } from "../../src/director/values";

function emptyManifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

function createMovie(): DirectorMovie {
  return createMovieWithManifest(emptyManifest());
}

function createMovieWithManifest(manifest: MovieManifest): DirectorMovie {
  const members = new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/origins-data/assets/");
  return new DirectorMovie(manifest, { log: () => {} }, async () => {}, async () => "", members);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Director timeout objects", () => {
  it("keeps first-match marker semantics for frame lookup and go marker", () => {
    const manifest = emptyManifest();
    manifest.score.frames = [{ index: 1 }, { index: 2 }, { index: 3 }];
    manifest.score.markers = [
      { name: "Start", frame: 2 },
      { name: "start", frame: 3 },
      { name: "Later", frame: 3 },
    ];
    const movie = createMovieWithManifest(manifest);

    expect(movie.markerName(3)).toBe("start");

    movie.runtime.call("go", ["START"]);
    movie.tick();

    expect(movie.frame).toBe(2);
  });

  it("dispatches method-syntax timeout new calls to script instances", async () => {
    const movie = createMovie();
    let calls = 0;
    let sawTargetAsMe = false;
    let timeoutName = "";
    const target = new ScriptInstance({
      scriptName: "Delay Target",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        executedelay(ctx, _me, args) {
          calls += 1;
          sawTargetAsMe = args[0] === target;
          timeoutName = String(ctx.getProp(args[1] ?? LINGO_VOID, "name"));
          return 1;
        },
      },
    });

    const timeout = movie.call("timeout", ["Delay navigator_component 1"]);
    expect(timeout).toBeTruthy();
    movie.runtime.callMethod(timeout ?? LINGO_VOID, "new", [1, symbol("executeDelay"), target]);

    await wait(4);
    movie.tick();

    expect(calls).toBe(1);
    expect(sawTargetAsMe).toBe(true);
    expect(timeoutName).toBe("delay navigator_component 1");
  });

  it("cancels method-syntax timeout forget calls", async () => {
    const movie = createMovie();
    let calls = 0;
    const target = new ScriptInstance({
      scriptName: "Delay Target",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        executedelay() {
          calls += 1;
          return 1;
        },
      },
    });

    const timeout = movie.call("timeout", ["Delay navigator_component 2"]);
    expect(timeout).toBeTruthy();
    movie.runtime.callMethod(timeout ?? LINGO_VOID, "new", [1, symbol("executeDelay"), target]);
    movie.runtime.callMethod(timeout ?? LINGO_VOID, "forget", []);

    await wait(4);
    movie.tick();

    expect(calls).toBe(0);
  });

  it("updateStage pumps timeout prepareFrame targets without advancing or firing timeouts", () => {
    const movie = createMovie();
    let prepareFrames = 0;
    let timeoutCalls = 0;
    const target = new ScriptInstance({
      scriptName: "Object Manager Stand-In",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        prepareframe(ctx) {
          prepareFrames += 1;
          expect(ctx.theProp("mouseH")).toBe(42);
          expect(ctx.theProp("mouseV")).toBe(77);
          return 1;
        },
        fire() {
          timeoutCalls += 1;
          return 1;
        },
      },
    });

    const timeout = movie.call("timeout", ["objectmanager:update"]);
    expect(timeout).toBeTruthy();
    movie.runtime.callMethod(timeout ?? LINGO_VOID, "new", [60_000, symbol("fire"), target]);
    movie.pointerMove(42, 77);

    movie.runtime.call("updateStage", []);

    expect(prepareFrames).toBe(1);
    expect(timeoutCalls).toBe(0);
    expect(movie.frame).toBe(1);
    expect(movie.tickDiagnostics().tickCount).toBe(0);
  });

  it("guards updateStage recursion while prepareFrame is already dispatching", () => {
    const movie = createMovie();
    let prepareFrames = 0;
    const target = new ScriptInstance({
      scriptName: "Recursive Stage Update",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        prepareframe(ctx, me) {
          prepareFrames += 1;
          ctx.callLocal(me, "updateStage", []);
          return 1;
        },
      },
    });

    const timeout = movie.call("timeout", ["objectmanager:recursive"]);
    expect(timeout).toBeTruthy();
    movie.runtime.callMethod(timeout ?? LINGO_VOID, "new", [60_000, symbol("null"), target]);

    movie.runtime.call("updateStage", []);

    expect(prepareFrames).toBe(1);
  });
});
