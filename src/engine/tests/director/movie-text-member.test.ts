import { describe, expect, it } from "vitest";
import { DirectorMovie, MovieManifest } from "../../src/director/Movie";
import { LingoColor, LingoPoint, LingoRect } from "../../src/director/geometry";
import { LingoImage } from "../../src/director/imaging";
import { CastMember, CastRegistry } from "../../src/director/members";
import { SpriteChannel } from "../../src/director/sprites";
import { LingoList, LingoSymbol } from "../../src/director/values";

function createMovie(): DirectorMovie {
  const manifest: MovieManifest = {
    stage: { width: 640, height: 480, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [] },
  };
  const members = new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/assets/");
  return new DirectorMovie(
    manifest,
    { log: () => {} },
    async () => {},
    async () => "",
    members,
  );
}

describe("Director text members", () => {
  it("uses manifest member text as field contents when no auxiliary text field exists", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 2,
              name: "fuse_client",
              members: [
                {
                  number: 1,
                  name: "System Props",
                  type: "text",
                  text: "connection.info.id=#info",
                },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
      },
      "/assets/",
    );

    members.loadCast("fuse_client");

    expect(members.fieldText("System Props")).toBe("connection.info.id=#info");
  });

  it("uses text member rect for width, height, and rendered image size", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_test", "text", { text: "Hello" });

    movie.setProp(member, "rect", new LingoRect(0, 0, 120, 32));
    movie.setProp(member, "boxtype", LingoSymbol.for("fixed"));
    movie.setProp(member, "fontsize", 10);
    movie.setProp(member, "color", new LingoColor(20, 30, 40));

    expect(movie.getProp(member, "width")).toBe(120);
    expect(movie.getProp(member, "height")).toBe(32);
    const image = movie.getProp(member, "image");
    expect(image).toBeInstanceOf(LingoImage);
    expect((image as LingoImage).width).toBe(120);
    expect((image as LingoImage).height).toBe(32);
  });

  it("lets adjust text members expand height from one-pixel measurement rects", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_measure", "text", {
      text: "one two three four five",
    });

    movie.setProp(member, "rect", new LingoRect(0, 0, 40, 1));
    movie.setProp(member, "fontsize", 10);
    movie.setProp(member, "wordwrap", 1);

    expect(movie.getProp(member, "width")).toBe(40);
    expect(movie.getProp(member, "height")).toBeGreaterThan(1);
    const image = movie.getProp(member, "image");
    expect(image).toBeInstanceOf(LingoImage);
    expect((image as LingoImage).height).toBeGreaterThan(1);
  });

  it("preserves assigned adjust text width when wordWrap is disabled", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "login_field", "text", { text: "<private-test-value-redacted>" });

    movie.setProp(member, "rect", new LingoRect(0, 0, 180, 18));
    movie.setProp(member, "boxtype", LingoSymbol.for("adjust"));
    movie.setProp(member, "wordwrap", 0);
    movie.setProp(member, "fontsize", 9);

    expect(movie.getProp(member, "width")).toBe(180);
    const image = movie.getProp(member, "image");
    expect(image).toBeInstanceOf(LingoImage);
    expect((image as LingoImage).width).toBe(180);
  });

  it("maps character positions to text-member coordinates", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_test", "text", { text: "abc\rde" });
    movie.setProp(member, "fontsize", 10);
    movie.setProp(member, "fixedlinespace", 12);

    expect(movie.callMethod(member, "charpostoloc", [1])).toEqual(new LingoPoint(0, 0));
    const afterThird = movie.callMethod(member, "charpostoloc", [4]);
    expect(afterThird).toBeInstanceOf(LingoPoint);
    expect((afterThird as LingoPoint).x).toBeGreaterThan(0);
    expect(movie.callMethod(member, "charpostoloc", [5])).toEqual(new LingoPoint(0, 12));
  });

  it("maps aligned text positions in the same coordinates used for rendering", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "centered_field", "field", { text: "abc" });
    movie.setProp(member, "rect", new LingoRect(0, 0, 100, 18));
    movie.setProp(member, "alignment", LingoSymbol.for("center"));
    movie.setProp(member, "fontsize", 10);

    const firstCharacter = movie.callMethod(member, "charpostoloc", [1]);

    expect(firstCharacter).toBeInstanceOf(LingoPoint);
    expect((firstCharacter as LingoPoint).x).toBeGreaterThan(0);
    expect(movie.callMethod(member, "loctocharpos", [firstCharacter as LingoPoint])).toBe(1);
  });

  it("keeps text advances as Director-style fractional pen positions", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "fractional_writer_test", "text", { text: "abc" });
    movie.setProp(member, "font", "V");
    movie.setProp(member, "fontsize", 9);
    (
      movie as unknown as {
        textMeasureContext: {
          font: string;
          measureText: (text: string) => { width: number };
        };
      }
    ).textMeasureContext = {
      font: "",
      measureText: (text: string) => ({ width: text === " " ? 3.6 : 1.4 }),
    };

    const width = (
      movie as unknown as { measureTextSpan(member: CastMember, text: string, position: number): number }
    ).measureTextSpan(member, "abc", 1);

    expect(width).toBeCloseTo(4.21875, 5);
  });

  it("wraps field text at word boundaries before splitting inside words", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "club_elapsed_label", "field", { text: "Elapsed Months" });
    movie.setProp(member, "rect", new LingoRect(0, 0, 57, 25));
    movie.setProp(member, "font", "V");
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "wordwrap", 1);
    (
      movie as unknown as {
        textMeasureContext: {
          font: string;
          measureText: (text: string) => { width: number };
        };
      }
    ).textMeasureContext = {
      font: "",
      measureText: (text: string) => ({ width: text === " " ? 3 : 5 }),
    };

    const rows = (
      movie as unknown as {
        layoutTextMember(member: CastMember): Array<{ text: string }>;
      }
    ).layoutTextMember(member);

    expect(rows.map((row) => row.text)).toEqual(["Elapsed", "Months"]);
  });

  it("treats Director lineHeight as the fixed text row spacing source uses", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "line_height_test", "text", { text: "abc\rde" });
    movie.setProp(member, "fontsize", 9);

    expect(movie.setProp(member, "lineheight", 14)).toBe(true);

    expect(movie.getProp(member, "fixedlinespace")).toBe(14);
    expect(movie.getProp(member, "lineheight")).toBe(14);
    expect(movie.getProp(member, "topspacing")).toBe(5);
    expect(movie.callMethod(member, "charpostoloc", [5])).toEqual(new LingoPoint(0, 14));
  });

  it("keeps Writer topSpacing glyph bands inside adjust text images", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_topspacing", "text", {
      text: "Go for a stroll outdoors or visit the Infobus",
    });
    movie.setProp(member, "rect", new LingoRect(0, 0, 245, 38));
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 9);
    movie.setProp(member, "topspacing", 9);
    movie.setProp(member, "wordwrap", 1);

    const image = movie.getProp(member, "image");

    expect(image).toBeInstanceOf(LingoImage);
    expect((image as LingoImage).height).toBeGreaterThan(9);
  });

  it("centres fixedLineSpace-only text inside the Director line cell", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "dropdown_text", "text", { text: "Say" });
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 18);

    const inset = (
      movie as unknown as {
        memberTextDrawTopInset(member: CastMember, lineHeight: number, fontSize: number, descent: number): number;
      }
    ).memberTextDrawTopInset(member, 18, 9, 2);

    expect(inset).toBe(7);
  });

  it("lets explicit topSpacing override fixedLineSpace-only text centring", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_text", "text", { text: "Say" });
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 18);
    movie.setProp(member, "topspacing", 3);

    const inset = (
      movie as unknown as {
        memberTextDrawTopInset(member: CastMember, lineHeight: number, fontSize: number, descent: number): number;
      }
    ).memberTextDrawTopInset(member, 18, 9, 2);

    expect(inset).toBe(3);
  });

  it("adds the source-compatible top guard for compact Volter text cells", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_link_text", "text", { text: "Hide Full Rooms" });
    movie.setProp(member, "font", "V");
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 9);

    const inset = (
      movie as unknown as {
        memberTextDrawTopInset(member: CastMember, lineHeight: number, fontSize: number, descent: number): number;
      }
    ).memberTextDrawTopInset(member, 9, 9, 2);

    expect(inset).toBe(1);
  });

  it("clamps oversized browser font boxes to the requested Director text cell", () => {
    const movie = createMovie();
    (
      movie as unknown as {
        textMeasureContext: { font: string; measureText: () => { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } };
      }
    ).textMeasureContext = {
      font: "",
      measureText: () => ({ fontBoundingBoxAscent: 42, fontBoundingBoxDescent: 28 }),
    };

    const metrics = (
      movie as unknown as { fontMetrics(font: string): { ascent: number; descent: number } }
    ).fontMetrics('bold 18px "Volter Goldfish"');

    expect(metrics.ascent).toBe(18);
    expect(metrics.descent).toBeLessThanOrEqual(6);
  });

  it("keeps compact Volter descent so Writer link underlines are not clipped", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_link_text", "text", { text: "Hide Full Rooms" });
    movie.setProp(member, "font", "V");
    movie.setProp(member, "fontsize", 9);
    (
      movie as unknown as {
        textMeasureContext: { font: string; measureText: () => { actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } };
      }
    ).textMeasureContext = {
      font: "",
      measureText: () => ({ actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 2 }),
    };

    const descent = (
      movie as unknown as { textDrawDescent(member: CastMember, position: number, font: string): number }
    ).textDrawDescent(member, 1, '9px "Volter Goldfish"');

    expect(descent).toBe(2);
  });

  it("detects when snapped bitmap text can use one exact source color", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_link_text", "text", { text: "Hide Full Rooms" });
    movie.setProp(member, "color", new LingoColor(123, 148, 152));

    const singleColor = (
      movie as unknown as { singleTextColor(member: CastMember): { r: number; g: number; b: number } | null }
    ).singleTextColor(member);

    expect(singleColor).toEqual({ r: 123, g: 148, b: 152 });

    member.setTextStyleRange(1, 4, "color", new LingoColor(1, 2, 3));

    expect(
      (movie as unknown as { singleTextColor(member: CastMember): { r: number; g: number; b: number } | null }).singleTextColor(
        member,
      ),
    ).toBeNull();
  });

  it("drops low-coverage colored antialias fringe when snapping bitmap text", () => {
    const movie = createMovie();
    const matches = (
      movie as unknown as {
        textPixelMatchesSingleColorStrike(red: number, green: number, blue: number, color: { r: number; g: number; b: number }): boolean;
      }
    ).textPixelMatchesSingleColorStrike.bind(movie);
    const linkColor = { r: 123, g: 148, b: 152 };

    expect(matches(123, 148, 152, linkColor)).toBe(true);
    expect(matches(123, 147, 152, linkColor)).toBe(true);
    expect(matches(122, 147, 152, linkColor)).toBe(true);
    expect(matches(122, 145, 153, linkColor)).toBe(false);
  });

  it("maps imported Director font fallback lists back to Volter Goldfish", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "font_test", "text", { text: "Habbo" });
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "font", '"vb", Arial, Helvetica, sans-serif');
    movie.setProp(member, "fontstyle", "plain");

    const cssFont = (movie as unknown as { canvasFont(member: CastMember, position: number): string }).canvasFont(
      member,
      1,
    );

    expect(cssFont).toBe('bold 9px "Volter Goldfish", Arial, Helvetica, sans-serif');
  });

  it("maps the source Volter-Bold goldfish family to the embedded bold font", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "font_test", "text", { text: "Habbo" });
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "font", '"Volter-Bold (goldfish)", Arial, Helvetica, sans-serif');
    movie.setProp(member, "fontstyle", "plain");

    const cssFont = (movie as unknown as { canvasFont(member: CastMember, position: number): string }).canvasFont(
      member,
      1,
    );

    expect(cssFont).toBe('bold 9px "Volter Goldfish", Arial, Helvetica, sans-serif');
  });

  it("uses a stricter bitmap alpha cutoff for bright glyph pixels than dark UI glyph pixels", () => {
    const movie = createMovie();
    const threshold = (
      movie as unknown as { textPixelAlphaThreshold(red: number, green: number, blue: number): number }
    ).textPixelAlphaThreshold.bind(movie);

    expect(threshold(0, 0, 0)).toBe(64);
    expect(threshold(51, 102, 102)).toBe(64);
    expect(threshold(255, 255, 255)).toBe(160);
  });

  it("does not double-apply topSpacing to the presentation caret origin", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_test", "text", { text: "ab\rcd" });
    const sprite = movie.call("sprite", [1]) as SpriteChannel;
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 10);
    movie.setProp(member, "topspacing", 1);
    movie.setProp(member, "editable", 1);
    movie.setProp(sprite, "member", member);
    movie.setProp(sprite, "editable", 1);
    movie.setProp(sprite, "puppet", 1);
    movie.setProp(sprite, "visible", 1);
    movie.keyboardFocusSprite = 1;
    movie.selEnd = 5;

    movie.prepareTextSpriteImages(1);

    expect(member.presentationCaretLoc?.y).toBe(10);
  });

  it("prepares focused editable selection rectangles from Director selStart and selEnd", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_test", "text", { text: "hello" });
    const sprite = movie.call("sprite", [1]) as SpriteChannel;
    movie.setProp(member, "fontsize", 9);
    movie.setProp(member, "fixedlinespace", 10);
    movie.setProp(member, "wordwrap", 0);
    movie.setProp(member, "editable", 1);
    movie.setProp(sprite, "member", member);
    movie.setProp(sprite, "editable", 1);
    movie.setProp(sprite, "puppet", 1);
    movie.setProp(sprite, "visible", 1);
    movie.keyboardFocusSprite = 1;
    movie.selStart = 1;
    movie.selEnd = 6;

    movie.prepareTextSpriteImages(1);

    expect(member.presentationSelectionRects).toHaveLength(1);
    expect(member.presentationSelectionRects?.[0]?.x).toBe(0);
    expect(member.presentationSelectionRects?.[0]?.y).toBe(0);
    expect(member.presentationSelectionRects?.[0]?.width).toBeGreaterThan(0);
    expect(member.presentationSelectionRects?.[0]?.height).toBe(10);
  });

  it("preserves mutable member char ranges for Writer style writes", () => {
    const movie = createMovie();
    const member = new CastMember("bin", 1, 1, "writer_test", "text", { text: "Hello" });
    const charRange = movie.runtime.getIndex(movie.getProp(member, "char")!, [2], 4);
    const bold = new LingoList([LingoSymbol.for("bold")]);

    movie.runtime.setProp(charRange, "fontstyle", bold);

    expect(member.textStyleRuns).toEqual([
      { start: 2, end: 4, property: "fontstyle", value: bold },
    ]);
    expect(movie.runtime.call("string", [charRange])).toBe("ell");
  });

  it("duplicates cast member contents into a destination member", () => {
    const movie = createMovie();
    const source = new CastMember("bin", 1, 1, "source", "text", { text: "Hello" });
    const target = new CastMember("bin", 1, 2, "target", "field", { text: "" });
    movie.setProp(source, "fontsize", 14);
    movie.setProp(source, "color", new LingoColor(10, 20, 30));
    source.setTextStyleRange(1, 2, "fontstyle", new LingoList([LingoSymbol.for("bold")]));

    expect(movie.callMethod(source, "duplicate", [target])).toBe(target);

    expect(target.type).toBe("text");
    expect(target.text).toBe("Hello");
    expect(movie.getProp(target, "fontsize")).toBe(14);
    expect(movie.getProp(target, "color")).toEqual(new LingoColor(10, 20, 30));
    expect(target.textStyleRuns).toHaveLength(1);
  });

  it("duplicates palette member data for layout-private palette copies", () => {
    const movie = createMovie();
    const source = new CastMember("hh_messenger", 3, 10, "interface palette_messenger", "palette");
    const target = new CastMember("bin", 99, 1, "interface palette_messenger Duplicate", "palette");
    source.paletteColors = [0x000000, 0xf4b24a];
    movie.setProp(source, "paletteref", LingoSymbol.for("systemMac"));
    movie.setProp(source, "palette", LingoSymbol.for("systemMac"));

    expect(movie.callMethod(source, "duplicate", [target])).toBe(target);

    expect(target.type).toBe("palette");
    expect(target.paletteColors).toEqual([0x000000, 0xf4b24a]);
    expect(movie.getProp(target, "paletteref")).toBe(LingoSymbol.for("systemMac"));
    expect(movie.getProp(target, "palette")).toBe(LingoSymbol.for("systemMac"));
  });

  it("stores Director sprite skew values", () => {
    const movie = createMovie();
    const sprite = movie.call("sprite", [1])!;

    movie.setProp(sprite, "skew", 180);

    expect(movie.getProp(sprite, "skew")).toBe(180);
  });
});
