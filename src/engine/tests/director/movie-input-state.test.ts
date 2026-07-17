import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { ScriptInstance } from "../../src/director/Runtime";
import { LingoPoint, LingoRect } from "../../src/director/geometry";
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
  it("preserves Director keyboard focus modes across pointer clicks", () => {
    const movie = createMovie();
    const firstField = new CastMember("Internal", 1, 2, "first field", "field", { text: "" });
    const secondField = new CastMember("Internal", 1, 3, "second field", "field", { text: "" });
    const buttonMember = new CastMember("Internal", 1, 4, "button", "bitmap", {
      bitmap: { width: 20, height: 10, regX: 0, regY: 0, pngUrl: null },
    });
    buttonMember.image = new LingoImage(20, 10, 32);

    for (const member of [firstField, secondField]) {
      member.style.set("editable", 1);
      member.style.set("rect", new LingoRect(0, 0, 20, 10));
    }

    const first = movie.runtime.call("sprite", [5]) as SpriteChannel;
    const button = movie.runtime.call("sprite", [6]) as SpriteChannel;
    const second = movie.runtime.call("sprite", [7]) as SpriteChannel;
    for (const [sprite, member, x] of [
      [first, firstField, 10],
      [button, buttonMember, 40],
      [second, secondField, 70],
    ] as const) {
      sprite.puppet = 1;
      sprite.visible = 1;
      sprite.locH = x;
      sprite.locV = 10;
      sprite.member = member;
    }

    expect(movie.keyboardFocusSprite).toBe(-1);

    movie.pointerMove(15, 15);
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(5);

    movie.pointerMove(45, 15);
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(5);

    movie.pointerMove(75, 15);
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(7);

    movie.keyboardFocusSprite = 0;
    movie.pointerMove(15, 15);
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(0);

    movie.keyboardFocusSprite = -1;
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(5);
  });

  it("places and extends the native editable-field selection from pointer coordinates", () => {
    const movie = createMovie();
    const member = new CastMember("Internal", 1, 2, "editable field", "field", { text: "abcdef" });
    member.style.set("editable", 1);
    member.style.set("rect", new LingoRect(0, 0, 120, 20));
    const sprite = movie.runtime.call("sprite", [5]) as SpriteChannel;
    sprite.puppet = 1;
    sprite.visible = 1;
    sprite.locH = 10;
    sprite.locV = 10;
    sprite.member = member;

    const secondCharacter = movie.callMethod(member, "charpostoloc", [2]) as LingoPoint;
    const sixthCharacter = movie.callMethod(member, "charpostoloc", [6]) as LingoPoint;
    const secondPoint = new LingoPoint(sprite.locH + secondCharacter.x, sprite.locV + secondCharacter.y + 1);
    const sixthPoint = new LingoPoint(sprite.locH + sixthCharacter.x, sprite.locV + sixthCharacter.y + 1);

    expect(movie.callMethod(sprite, "pointtochar", [secondPoint])).toBe(2);
    expect(movie.callMethod(sprite, "pointtochar", [new LingoPoint(250, 200)])).toBe(-1);

    movie.pointerMove(secondPoint.x, secondPoint.y);
    movie.pointerDown();
    expect(movie.keyboardFocusSprite).toBe(5);
    expect(movie.selStart).toBe(2);
    expect(movie.selEnd).toBe(2);

    movie.pointerMove(sixthPoint.x, sixthPoint.y);
    expect(movie.selStart).toBe(2);
    expect(movie.selEnd).toBe(6);

    movie.pointerUp();
    movie.pointerMove(secondPoint.x, secondPoint.y);
    expect(movie.selStart).toBe(2);
    expect(movie.selEnd).toBe(6);
  });

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
