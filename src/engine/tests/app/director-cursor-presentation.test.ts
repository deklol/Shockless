import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { LingoRect } from "../../src/director/geometry";
import { CastMember, CastRegistry } from "../../src/director/members";
import { SpriteChannel } from "../../src/director/sprites";
import {
  DirectorCursorPresentation,
  applyDirectorCursorMask,
} from "../../src/habbo/ui/cursor/DirectorCursorPresentation";

function createMovie(): { movie: DirectorMovie; members: CastRegistry } {
  const manifest: MovieManifest = {
    stage: { width: 320, height: 240, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [] },
  };
  const members = new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/assets/");
  return {
    movie: new DirectorMovie(manifest, { log: () => {} }, async () => {}, async () => "", members),
    members,
  };
}

function addEditableField(movie: DirectorMovie, channelNumber: number): SpriteChannel {
  const member = new CastMember("Internal", 1, channelNumber, `field ${channelNumber}`, "field", { text: "Room name" });
  member.style.set("editable", 1);
  member.style.set("rect", new LingoRect(0, 0, 100, 20));
  const sprite = movie.runtime.call("sprite", [channelNumber]) as SpriteChannel;
  sprite.puppet = 1;
  sprite.visible = 1;
  sprite.locH = 10;
  sprite.locV = 10;
  sprite.member = member;
  return sprite;
}

function createPresentation(movie: DirectorMovie, members: CastRegistry): DirectorCursorPresentation {
  const canvas = { style: { cursor: "" } } as unknown as HTMLCanvasElement;
  return new DirectorCursorPresentation({ movie, members, canvas });
}

describe("Director cursor presentation", () => {
  it("uses Director's native I-beam over an editable field even while the global watch cursor is active", () => {
    const { movie, members } = createMovie();
    addEditableField(movie, 5);
    movie.globalCursor = 4;
    movie.pointerMove(20, 15);

    const state = createPresentation(movie, members).sync();

    expect(state).toMatchObject({
      cssCursor: "text",
      source: "sprite",
      value: 1,
    });
  });

  it("keeps an authored sprite cursor above the editable-field default", () => {
    const { movie, members } = createMovie();
    const field = addEditableField(movie, 5);
    field.cursor = 2;
    movie.globalCursor = 4;
    movie.pointerMove(20, 15);

    const state = createPresentation(movie, members).sync();

    expect(state).toMatchObject({
      cssCursor: "crosshair",
      source: "sprite",
      value: 2,
    });
  });

  it("uses the active global cursor away from editable fields", () => {
    const { movie, members } = createMovie();
    addEditableField(movie, 5);
    movie.globalCursor = 4;
    movie.pointerMove(200, 150);

    const state = createPresentation(movie, members).sync();

    expect(state).toMatchObject({
      cssCursor: "wait",
      source: "global",
      value: 4,
    });
  });

  it("uses the 1-bit mask as direct opacity without erasing a white cursor interior", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 12,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    const mask = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);

    applyDirectorCursorMask(source, mask);

    expect([...source]).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
      255, 255, 255, 0,
    ]);
  });

  it("keeps pixels outside a shorter mask transparent", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);
    const mask = new Uint8ClampedArray([0, 0, 0, 255]);

    applyDirectorCursorMask(source, mask);

    expect(source[3]).toBe(255);
    expect(source[7]).toBe(0);
  });
});
