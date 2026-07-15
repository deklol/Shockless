import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { CastMember, CastRegistry } from "../../src/director/members";
import { SpriteChannel } from "../../src/director/sprites";
import { LINGO_VOID, symbol, type LingoValue } from "../../src/director/values";

function moduleFor(
  scriptName: string,
  scriptType: "behavior" | "cast" | "movie",
  handlers: GeneratedScriptModule["handlers"],
): GeneratedScriptModule {
  return { scriptName, scriptType, scriptProperties: [], scriptGlobals: [], handlers };
}

function manifest(frameScript = false): MovieManifest {
  return {
    stage: { width: 320, height: 240, backgroundColor: "#000000" },
    casts: [
      {
        number: 1,
        name: "test",
        members: [
          { number: 10, name: "cast-target", type: "bitmap" },
          { number: 20, name: "frame-behavior", type: "script" },
          { number: 30, name: "movie-script", type: "script" },
        ],
      },
    ],
    score: {
      frameRate: 12,
      markers: [],
      behaviors: frameScript
        ? [{ startFrame: 1, endFrame: 1, channel: 0, script: { castLib: 1, member: 20 } }]
        : [],
      frames: [{ index: 1 }],
    },
  };
}

function createMovie(frameScript = false): DirectorMovie {
  const movieManifest = manifest(frameScript);
  return new DirectorMovie(
    movieManifest,
    { log: () => {} },
    async () => {},
    async () => "",
    new CastRegistry({ movie: movieManifest, textFields: [], bitmaps: [] }, "/assets/"),
  );
}

function clickableMember(number = 10, name = "cast-target"): CastMember {
  return new CastMember("test", 1, number, name, "bitmap", {
    bitmap: { width: 32, height: 32, regX: 0, regY: 0, pngUrl: `/${name}.png` },
  });
}

function configureSprite(movie: DirectorMovie, number: number, member: CastMember | null = null): SpriteChannel {
  const sprite = movie.runtime.call("sprite", [number]) as SpriteChannel;
  if (member) movie.setProp(sprite, "member", member);
  movie.setProp(sprite, "loc", movie.runtime.call("point", [20, 20]));
  movie.setProp(sprite, "puppet", 1);
  movie.setProp(sprite, "visible", 1);
  return sprite;
}

describe("Director event dispatch hierarchy", () => {
  it("routes primary input through behavior, cast, frame, and movie tiers in order", () => {
    const movie = createMovie(true);
    const calls: string[] = [];
    const sprite = configureSprite(movie, 5, clickableMember());
    const pass = (name: string) => (ctx: Parameters<GeneratedScriptModule["handlers"][string]>[0]) => {
      calls.push(name);
      ctx.call("pass", []);
      calls.push(`${name}:after-pass`);
      return 1;
    };

    movie.runtime.register(moduleFor("Cast Target", "cast", { mousedown: pass("cast") }), "test", {
      memberNumber: 10,
    });
    movie.runtime.register(moduleFor("Frame Behavior", "behavior", { mousedown: pass("frame") }), "test", {
      memberNumber: 20,
    });
    movie.runtime.register(
      moduleFor("Movie Events", "movie", {
        primarymouse: pass("primary"),
        mousedown() {
          calls.push("movie");
          return 1;
        },
      }),
      "test",
      { memberNumber: 30 },
    );
    sprite.scriptInstanceList.items.push(
      new ScriptInstance(moduleFor("Sprite Behavior", "behavior", { mousedown: pass("behavior") })),
    );
    movie.runtime.setTheProp("mouseDownScript", "primaryMouse");

    movie.pointerMove(25, 25);
    movie.pointerDown();

    expect(calls).toEqual(["primary", "behavior", "cast", "frame", "movie"]);
  });

  it("stopEvent prevents later attached behaviors and lower hierarchy tiers", () => {
    const movie = createMovie();
    const calls: string[] = [];
    const sprite = configureSprite(movie, 5, clickableMember());
    movie.runtime.register(
      moduleFor("Cast Target", "cast", {
        mousedown() {
          calls.push("cast");
          return 1;
        },
      }),
      "test",
      { memberNumber: 10 },
    );
    sprite.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("First Behavior", "behavior", {
          mousedown(ctx) {
            calls.push("first");
            ctx.call("stopEvent", []);
            calls.push("first:after-stop");
            return 1;
          },
        }),
      ),
      new ScriptInstance(
        moduleFor("Second Behavior", "behavior", {
          mousedown() {
            calls.push("second");
            return 1;
          },
        }),
      ),
    );

    movie.pointerMove(25, 25);
    movie.pointerDown();

    expect(calls).toEqual(["first", "first:after-stop"]);
  });

  it("treats dontPassEvent as the source-used legacy event stop command", () => {
    const movie = createMovie();
    const calls: string[] = [];
    const sprite = configureSprite(movie, 5, clickableMember());
    sprite.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("FUSE Screen", "behavior", {
          mousedown(ctx) {
            calls.push("fuse");
            ctx.call("dontPassEvent", []);
            return 1;
          },
        }),
      ),
      new ScriptInstance(
        moduleFor("Later Behavior", "behavior", {
          mousedown() {
            calls.push("later");
            return 1;
          },
        }),
      ),
    );

    movie.pointerMove(25, 25);
    movie.pointerDown();

    expect(calls).toEqual(["fuse"]);
  });

  it("keeps cast scripts member-scoped instead of promoting them to movie globals", () => {
    const movie = createMovie();
    movie.runtime.register(moduleFor("Cast Target", "cast", { custom: () => 1 }), "test", {
      memberNumber: 10,
    });

    expect(movie.runtime.hasGlobalHandler("custom")).toBe(false);
    expect(movie.runtime.findScriptModuleByMember("test", 10)?.scriptName).toBe("Cast Target");
  });

  it("implements the source game_chooserhilite cast-script sendSprite route", () => {
    const movie = createMovie();
    const calls: Array<[string, LingoValue]> = [];
    const target = configureSprite(movie, 5);
    const chooser = configureSprite(movie, 6, clickableMember(10, "game_chooserhilite"));
    target.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("Chooser Target", "behavior", {
          mousedown(_ctx, _me, args) {
            calls.push(["target", args[1] ?? LINGO_VOID]);
            return 1;
          },
        }),
      ),
    );
    movie.runtime.register(
      moduleFor("game_chooserhilite", "cast", {
        mouseup(ctx) {
          calls.push(["chooser", LINGO_VOID]);
          return ctx.call("sendSprite", [5, symbol("mouseDown"), "payload"]);
        },
      }),
      "test",
      { memberNumber: 10 },
    );

    expect(movie.runtime.call("sendSprite", [target, symbol("mouseDown"), "direct"])).toBe(1);
    movie.pointerMove(25, 25);
    expect(movie.inputSpriteAt(25, 25, ["mouseup"])).toBe(chooser);
    movie.pointerDown();
    movie.pointerUp();

    expect(calls).toEqual([
      ["target", "direct"],
      ["chooser", LINGO_VOID],
      ["target", "payload"],
    ]);
  });

  it("resolves sendSprite object, number, and sprite-name targets", () => {
    const movie = createMovie();
    const target = configureSprite(movie, 5);
    movie.setProp(target, "name", "named-target");
    let count = 0;
    target.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("Named Target", "behavior", {
          ping() {
            count += 1;
            return 1;
          },
        }),
      ),
    );

    expect(movie.runtime.call("sendSprite", [target, symbol("ping")])).toBe(1);
    expect(movie.runtime.call("sendSprite", [5, symbol("ping")])).toBe(1);
    expect(movie.runtime.call("sendSprite", ["named-target", symbol("ping")])).toBe(1);
    expect(count).toBe(3);
  });

  it("broadcasts sendAllSprites and supports the _movie method form", () => {
    const movie = createMovie();
    const first = configureSprite(movie, 5);
    const second = configureSprite(movie, 6);
    let count = 0;
    for (const sprite of [first, second]) {
      sprite.scriptInstanceList.items.push(
        new ScriptInstance(
          moduleFor(`Target ${sprite.number}`, "behavior", {
            ping() {
              count += 1;
              return 1;
            },
          }),
        ),
      );
    }

    expect(movie.runtime.call("sendAllSprites", [symbol("ping")])).toBe(1);
    const movieRef = movie.runtime.call("_movie", []);
    expect(movie.runtime.callMethod(movieRef, "sendSprite", [5, symbol("ping")])).toBe(1);
    expect(count).toBe(3);
  });

  it("keeps nested sendSprite pass state isolated from the outer event", () => {
    const movie = createMovie();
    const calls: string[] = [];
    const outer = configureSprite(movie, 5, clickableMember(11, "outer"));
    const inner = configureSprite(movie, 6);
    movie.setProp(inner, "visible", 0);
    inner.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("Inner Passer", "behavior", {
          ping(ctx) {
            calls.push("inner");
            ctx.call("pass", []);
            return 1;
          },
        }),
      ),
    );
    outer.scriptInstanceList.items.push(
      new ScriptInstance(
        moduleFor("Outer Consumer", "behavior", {
          mousedown(ctx) {
            calls.push("outer:start");
            ctx.call("sendSprite", [6, symbol("ping")]);
            calls.push("outer:end");
            return 1;
          },
        }),
      ),
    );
    movie.runtime.register(
      moduleFor("Movie Events", "movie", {
        mousedown() {
          calls.push("movie");
          return 1;
        },
      }),
      "test",
    );

    movie.pointerMove(25, 25);
    movie.pointerDown();

    expect(calls).toEqual(["outer:start", "inner", "outer:end"]);
  });
});
