import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { ScriptInstance } from "../../src/director/Runtime";
import { LingoRect } from "../../src/director/geometry";
import { LingoImage } from "../../src/director/imaging";
import { CastMember, CastRegistry } from "../../src/director/members";
import { SpriteChannel } from "../../src/director/sprites";

function createMovie(): DirectorMovie {
  const manifest: MovieManifest = {
    stage: { width: 320, height: 240, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [] },
  };
  const members = new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/assets/");
  return new DirectorMovie(manifest, { log: () => {} }, async () => {}, async () => "", members);
}

describe("Director movie input state", () => {
  it("exposes clickOn and clickLoc from the selected input sprite", () => {
    const movie = createMovie();
    const sprite = movie.runtime.call("sprite", [12]) as SpriteChannel;
    const member = new CastMember("Internal", 1, 1, "input target", "bitmap", {
      bitmap: { width: 20, height: 10, regX: 0, regY: 0, pngUrl: null },
    });
    member.image = new LingoImage(20, 10, 32);
    member.style.set("rect", new LingoRect(0, 0, 20, 10));
    sprite.puppet = 1;
    sprite.visible = 1;
    sprite.locH = 30;
    sprite.locV = 40;
    sprite.member = member;
    sprite.scriptInstanceList.add(
      new ScriptInstance({
        scriptName: "Click Handler Class",
        scriptType: "behavior",
        scriptProperties: [],
        scriptGlobals: [],
        handlers: {
          mousedown() {
            return 1;
          },
        },
      }),
    );

    movie.pointerMove(35, 45);
    movie.pointerDown();

    expect(movie.runtime.theProp("clickOn")).toBe(12);
    expect(movie.runtime.theProp("clickLoc")).toMatchObject({ x: 35, y: 45 });
  });

  it("exposes lastKey timing and keyPressed polling", () => {
    const movie = createMovie();

    movie.keyDown("a", 0, false);

    expect(movie.runtime.theProp("key")).toBe("a");
    expect(movie.runtime.theProp("keyPressed")).toBe("a");
    expect(movie.runtime.call("keyPressed", ["a"])).toBe(1);
    expect(movie.runtime.call("keyPressed", ["b"])).toBe(0);
    expect(movie.runtime.theProp("lastKey")).toBeLessThan(3);

    movie.keyUp("a", 0, false);
    expect(movie.runtime.call("keyPressed", ["a"])).toBe(0);
  });
});
