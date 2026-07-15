import { describe, expect, it } from "vitest";
import { CastRegistry } from "../../src/director/members";
import { LingoColor } from "../../src/director/geometry";
import { LingoList, LingoSymbol } from "../../src/director/values";

function withPixelCanvas(test: () => void): void {
  const previousDocument = globalThis.document;

  class FakeCanvas {
    width = 1;
    height = 1;
    readonly context = new FakeContext(this);

    getContext(): FakeContext {
      return this.context;
    }
  }

  class FakeContext {
    private data = new Uint8ClampedArray(4);
    fillStyle = "rgb(0, 0, 0)";

    constructor(public readonly canvas: FakeCanvas) {}

    createImageData(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    }

    putImageData(image: { data: Uint8ClampedArray; width?: number; height?: number }, x: number, y: number): void {
      this.ensureSize();
      const width = image.width ?? this.canvas.width;
      const height = image.height ?? this.canvas.height;
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const dst = ((y + row) * this.canvas.width + x + col) * 4;
          const src = (row * width + col) * 4;
          this.data.set(image.data.slice(src, src + 4), dst);
        }
      }
    }

    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } {
      this.ensureSize();
      const out = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const src = ((y + row) * this.canvas.width + x + col) * 4;
          const dst = (row * width + col) * 4;
          out.set(this.data.slice(src, src + 4), dst);
        }
      }
      return { data: out };
    }

    clearRect(x: number, y: number, width: number, height: number): void {
      this.ensureSize();
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const dst = ((y + row) * this.canvas.width + x + col) * 4;
          this.data[dst] = 0;
          this.data[dst + 1] = 0;
          this.data[dst + 2] = 0;
          this.data[dst + 3] = 0;
        }
      }
    }

    drawImage(source: FakeCanvas, dx: number, dy: number): void {
      const sourceContext = source.context;
      const image = sourceContext.getImageData(0, 0, source.width, source.height);
      this.putImageData({ ...image, width: source.width, height: source.height }, dx, dy);
    }

    private ensureSize(): void {
      const size = Math.max(1, this.canvas.width) * Math.max(1, this.canvas.height) * 4;
      if (this.data.length !== size) this.data = new Uint8ClampedArray(size);
    }
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new FakeCanvas() },
  });
  try {
    test();
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
}

describe("Director cast members", () => {
  it("counts sparse cast member slots by highest member number", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 1,
              name: "sparse_cast",
              members: [
                { number: 1, name: "First Class", type: "script" },
                { number: 5, name: "Sparse Class", type: "script" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
      },
      "/assets/",
    );

    members.loadCast("sparse_cast");

    expect(members.memberCount("sparse_cast")).toBe(5);
    expect(members.find(5, "sparse_cast")?.name).toBe("Sparse Class");
  });

  it("links adjacent loaded cast members for Director Mask ink lookup", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 7,
              name: "mask_cast",
              members: [
                { number: 10, name: "water", type: "bitmap" },
                { number: 11, name: "water_mask", type: "bitmap" },
                { number: 13, name: "later_member", type: "bitmap" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
      },
      "/assets/",
    );

    expect(members.loadCast("mask_cast")).toBe(true);

    const water = members.find(10, "mask_cast");
    const mask = members.find(11, "mask_cast");
    const later = members.find(13, "mask_cast");
    expect(water?.nextCastMember).toBe(mask);
    expect(mask?.nextCastMember).toBeNull();
    expect(later?.nextCastMember).toBeNull();
  });

  it("synthesizes external cast members from generated release manifests", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_entry_uk",
            castOrder: 11,
            member: 4,
            memberName: "entry.visual",
            memberType: "text",
            text: "<visual />",
          },
        ],
        bitmaps: [
          {
            castName: "hh_entry_uk",
            castOrder: 11,
            member: 6,
            memberName: "sky",
            mediaType: "bitmap",
            width: 10,
            height: 20,
            regPoint: { x: 1, y: 2 },
            pngPath: "generated/assets/hh_entry_uk/sky.png",
            inkAssetPaths: {
              "36": "generated/assets/hh_entry_uk/sky-ink36.png",
            },
          },
        ],
        externalMembers: [
          {
            castName: "hh_entry_uk",
            castOrder: 11,
            member: 7,
            memberName: "box",
            memberType: "shape",
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_entry_uk.cct")).toBe(true);

    const visual = members.find("entry.visual", "hh_entry_uk");
    expect(visual?.text).toBe("<visual />");
    expect(visual?.type).toBe("text");
    expect(members.find(visual!.slotNumber, null)).toBe(visual);
    expect(members.find("sky", "hh_entry_uk.cct")?.bitmap?.pngUrl).toBe("/assets/hh_entry_uk/sky.png");
    expect(members.find("sky", "hh_entry_uk.cct")?.bitmap?.inkUrls?.["36"]).toBe(
      "/assets/hh_entry_uk/sky-ink36.png",
    );
    expect(members.find("box", "hh_entry_uk")?.type).toBe("shape");
    expect(members.memberCount("hh_entry_uk.cct")).toBe(7);
  });

  it("resolves slot-encoded member numbers through the current castLib occupant", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_room_lobby",
            castOrder: 573,
            member: 1,
            memberName: "lobby_a.room",
            memberType: "text",
            text: "<room><name>lobby_a</name></room>",
          },
          {
            castName: "hh_room_nlobby",
            castOrder: 573,
            member: 1,
            memberName: "newbie_lobby.room",
            memberType: "text",
            text: "<room><name>newbie_lobby</name></room>",
          },
        ],
        bitmaps: [],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_room_lobby", 573)).toBe(true);
    const firstSlot = (573 << 16) | 1;
    expect(members.find(firstSlot, null)?.name).toBe("lobby_a.room");
    expect(members.find("lobby_a.room", null)?.text).toContain("lobby_a");

    expect(members.loadCast("hh_room_nlobby", 573)).toBe(true);
    expect(members.find(firstSlot, null)?.name).toBe("newbie_lobby.room");
    expect(members.find("newbie_lobby.room", null)?.text).toContain("newbie_lobby");
  });

  it("hydrates extracted text member style metadata from profile manifests", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 2,
              name: "hh_test",
              members: [
                {
                  number: 3,
                  name: "caption",
                  type: "text",
                  text: "Update Habbo ID",
                  fontFamily: '"vb", Arial, Helvetica, sans-serif',
                  fontSize: 9,
                  lineHeight: 10,
                  wordWrap: false,
                  fontWeight: "700",
                  textAlign: "center",
                  color: "#f0f0b4",
                  underline: true,
                  textSpans: [{ start: 7, end: 12, underline: true }],
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

    expect(members.loadCast("hh_test")).toBe(true);

    const member = members.find("caption", "hh_test")!;
    expect(member.style.get("font")).toBe('"vb", Arial, Helvetica, sans-serif');
    expect(member.style.get("fontsize")).toBe(9);
    expect(member.style.get("fixedlinespace")).toBe(10);
    expect(member.style.get("topspacing")).toBe(1);
    expect(member.style.get("wordwrap")).toBe(0);
    expect(member.style.get("alignment")).toEqual(LingoSymbol.for("center"));
    expect(member.style.get("color")).toEqual(new LingoColor(240, 240, 180));
    const styles = member.style.get("fontstyle") as LingoList;
    expect(styles.items).toEqual([LingoSymbol.for("bold"), LingoSymbol.for("underline")]);
    expect(member.textStyleRuns).toEqual([
      { start: 8, end: 12, property: "fontstyle", value: new LingoList([LingoSymbol.for("underline")]) },
    ]);
  });

  it("lets release-local visual bitmap supplements override the same member slot", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 41,
            memberName: "flat_floor_0_a_0_0_0",
            width: 130,
            height: 71,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_room_private/0041-floor.png",
          },
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 41,
            memberName: "flat_floor_0_a_0_0_0",
            width: 130,
            height: 71,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/visual-bitmaps/release306/hh_room_private/041-floor-floor_basic.png",
          },
        ],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    expect(members.find("flat_floor_0_a_0_0_0", "hh_room_private")?.bitmap?.pngUrl).toBe(
      "/origins-data/assets/visual-bitmaps/release306/hh_room_private/041-floor-floor_basic.png",
    );
  });

  it("normalizes absolute profile asset paths to browser asset URLs", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 544,
            memberName: "Horizon_Sakura_Background",
            width: 960,
            height: 488,
            regPoint: { x: 0, y: 0 },
            pngPath:
              "C:/Users/example/AppData/Roaming/ShocklessEngine/profiles/release320-d4b58070/assets/visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background.png",
            inkAssetPaths: {
              "36":
                "C:/Users/example/AppData/Roaming/ShocklessEngine/profiles/release320-d4b58070/assets/visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background-ink36.png",
            },
          },
        ],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    const bitmap = members.find("Horizon_Sakura_Background", "hh_room_private")?.bitmap;
    expect(bitmap?.pngUrl).toBe(
      "/origins-data/assets/visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background.png",
    );
    expect(bitmap?.inkUrls?.["36"]).toBe(
      "/origins-data/assets/visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background-ink36.png",
    );
  });

  it("hydrates source bitmap members referenced by visual bitmap supplements", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 76,
              name: "hh_room_private",
              members: [
                { number: 41, name: "flat_floor_0_a_0_0_0", type: "bitmap" },
                { number: 76, name: "flat_floor_0_a_0_0_0", type: "bitmap" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 41,
            sourceBitmapMember: 76,
            memberName: "flat_floor_0_a_0_0_0",
            width: 130,
            height: 71,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/visual-bitmaps/release306/hh_room_private/041-floor-floor_basic.png",
          },
        ],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    expect(members.find(41, "hh_room_private")?.bitmap?.pngUrl).toBe(
      "/origins-data/assets/visual-bitmaps/release306/hh_room_private/041-floor-floor_basic.png",
    );
    expect(members.find(76, "hh_room_private")?.bitmap?.pngUrl).toBe(
      "/origins-data/assets/visual-bitmaps/release306/hh_room_private/041-floor-floor_basic.png",
    );
  });

  it("selects the bitmap candidate matching the source member name when recovered aliases share a slot", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 76,
              name: "hh_room_private",
              members: [{ number: 79, name: "blockhilite", type: "bitmap" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 79,
            memberName: "blockhilite",
            width: 64,
            height: 32,
            regPoint: { x: 0, y: 15 },
            pngPath: "external-bitmaps/release320/hh_room_private/0079-blockhilite.png",
            inkAssetPaths: {
              "36": "external-bitmaps/release320/hh_room_private/0079-blockhilite-ink36.png",
            },
          },
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 79,
            memberName: "flat_stair_1_a_0_0_0",
            width: 130,
            height: 103,
            regPoint: { x: 0, y: 0 },
            pngPath: "external-bitmaps/release320/hh_room_private/0079-flat-stair-1-a-0-0-0.png",
            inkAssetPaths: {
              "36": "external-bitmaps/release320/hh_room_private/0079-flat-stair-1-a-0-0-0-ink36.png",
            },
          },
        ],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    const hiliter = members.find("blockhilite", "hh_room_private")?.bitmap;
    expect(hiliter?.width).toBe(64);
    expect(hiliter?.height).toBe(32);
    expect(hiliter?.pngUrl).toBe("/origins-data/assets/external-bitmaps/release320/hh_room_private/0079-blockhilite.png");
    expect(hiliter?.inkUrls?.["36"]).toBe(
      "/origins-data/assets/external-bitmaps/release320/hh_room_private/0079-blockhilite-ink36.png",
    );
  });

  it("preserves text member identity when supplemental cast records reuse the same slot", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 118,
            memberName: "model_a.room",
            memberType: "text",
            text: "<room><name>model_a</name></room>",
          },
        ],
        bitmaps: [],
        externalMembers: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 118,
            memberName: "right_sstairs1_0_a_0_2_0",
            memberType: "bitmap",
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    const model = members.find("model_a.room", "hh_room_private");
    expect(model?.type).toBe("text");
    expect(model?.text).toBe("<room><name>model_a</name></room>");
    expect(members.find(118, "hh_room_private")).toBe(model);
    expect(members.find("right_sstairs1_0_a_0_2_0", "hh_room_private")).toBeNull();
  });

  it("renders palette-indexed bitmap members through the currently assigned palette", () => {
    withPixelCanvas(() => {
      const members = new CastRegistry(
        {
          movie: {
            casts: [
              {
                number: 76,
                name: "hh_room_private",
                members: [
                  { number: 4, name: "left_wallpart_0_a_0_0_0", type: "bitmap" },
                  { number: 80, name: "wall_white", type: "palette" },
                  { number: 81, name: "wall_testpattern2", type: "palette" },
                ],
              },
            ],
          },
          textFields: [],
          bitmaps: [
            {
              castName: "hh_room_private",
              castOrder: 76,
              member: 4,
              memberName: "left_wallpart_0_a_0_0_0",
              width: 2,
              height: 1,
              regPoint: { x: 0, y: 0 },
              pngPath: "generated/assets/visual-bitmaps/release306/hh_room_private/004-wall.png",
              paletteIndexData: Buffer.from([0, 1]).toString("base64"),
              paletteColors: [0xffffff, 0x000000],
            },
          ],
          palettes: [
            {
              castName: "hh_room_private",
              castOrder: 76,
              member: 80,
              memberName: "wall_white",
              colors: [0xffffff, 0xbcbfce],
            },
            {
              castName: "hh_room_private",
              castOrder: 76,
              member: 81,
              memberName: "wall_testpattern2",
              colors: [0x000000, 0xff00ff],
            },
          ],
        },
        "/assets/",
      );

      members.loadCast("hh_room_private");
      const wall = members.find(4, "hh_room_private")!;
      const white = members.find("wall_white", "hh_room_private")!;
      const testPattern = members.find("wall_testpattern2", "hh_room_private")!;

      expect(wall.effectiveImage().getPixel(1, 0).hex).toBe(0x000000);

      wall.palette = white;
      const whiteImage = wall.effectiveImage();
      expect(whiteImage.getPixel(1, 0).hex).toBe(0xbcbfce);

      wall.palette = testPattern;
      const testPatternImage = wall.effectiveImage();
      expect(testPatternImage.getPixel(1, 0).hex).toBe(0xff00ff);

      wall.paletteRef = white;
      expect(wall.effectiveImage().getPixel(1, 0).hex).toBe(0xbcbfce);

      wall.paletteRef = testPattern;
      expect(wall.effectiveImage().getPixel(1, 0).hex).toBe(0xff00ff);

      wall.palette = white;
      expect(testPatternImage).not.toBe(whiteImage);
      expect(wall.effectiveImage()).toBe(whiteImage);
    });
  });

  it("preserves imported 2-bit bitmap depth when source assigns a built-in palette", () => {
    withPixelCanvas(() => {
      const members = new CastRegistry(
        {
          movie: {
            casts: [
              {
                number: 648,
                name: "hh_interface",
                members: [{ number: 165, name: "info_stand_txt_bg", type: "bitmap" }],
              },
            ],
          },
          textFields: [],
          bitmaps: [
            {
              castName: "hh_interface",
              castOrder: 648,
              member: 165,
              memberName: "info_stand_txt_bg",
              width: 4,
              height: 1,
              regPoint: { x: 0, y: 0 },
              pngPath: "generated/assets/external-bitmaps/release323/hh_interface/0165-info-stand-txt-bg.png",
              bitDepth: 2,
              paletteIndexData: Buffer.from([0, 1, 2, 3]).toString("base64"),
              paletteColors: [0xffffff, 0xa3a3a3, 0x656565, 0x000000],
              paletteName: "systemMac",
            },
          ],
        },
        "/assets/",
      );

      members.loadCast("hh_interface");
      const strip = members.find("info_stand_txt_bg", "hh_interface")!;
      expect(strip.effectiveImage().getPixel(3, 0).hex).toBe(0x000000);

      strip.palette = LingoSymbol.for("systemWin");
      strip.paletteRef = LingoSymbol.for("systemWin");

      expect(strip.effectiveImage().getPixel(1, 0).hex).toBe(0xa3a3a3);
      expect(strip.effectiveImage().getPixel(2, 0).hex).toBe(0x656565);
      expect(strip.effectiveImage().getPixel(3, 0).hex).toBe(0x000000);
    });
  });

  it("initializes indexed bitmap members with their extracted palette member", () => {
    withPixelCanvas(() => {
      const members = new CastRegistry(
        {
          movie: {
            casts: [
              {
                number: 54,
                name: "hh_cat_gfx_all",
                members: [
                  { number: 469, name: "cat_colors Palette", type: "palette" },
                  { number: 470, name: "tree_col1_unselected", type: "bitmap" },
                ],
              },
            ],
          },
          textFields: [],
          bitmaps: [
            {
              castName: "hh_cat_gfx_all",
              castOrder: 54,
              member: 470,
              memberName: "tree_col1_unselected",
              width: 1,
              height: 1,
              regPoint: { x: 0, y: 0 },
              pngPath: "generated/assets/external-bitmaps/release306/hh_cat_gfx_all/0470-tree-col1-unselected.png",
              paletteIndexData: Buffer.from([1]).toString("base64"),
              paletteColors: [0x000000, 0x75a8c0],
              paletteCastName: "hh_cat_gfx_all",
              paletteMember: 469,
              paletteName: "cat_colors Palette",
            },
          ],
          palettes: [
            {
              castName: "hh_cat_gfx_all",
              castOrder: 54,
              member: 469,
              memberName: "cat_colors Palette",
              colors: [0x000000, 0x75a8c0],
            },
          ],
        },
        "/assets/",
      );

      members.loadCast("hh_cat_gfx_all");
      const row = members.find("tree_col1_unselected", "hh_cat_gfx_all")!;
      const palette = members.find("cat_colors Palette", "hh_cat_gfx_all")!;

      expect(row.paletteRef).toBe(palette);
      expect(row.effectiveImage().getPixel(0, 0).hex).toBe(0x75a8c0);
    });
  });

  it("preserves imported edge-connected matte provenance for indexed bitmap members", () => {
    withPixelCanvas(() => {
      const sourcePixels = [
        0, 0, 0, 0, 0,
        0, 1, 1, 1, 0,
        0, 1, 0, 1, 0,
        0, 1, 1, 1, 0,
        0, 0, 0, 0, 0,
      ];
      const manifests = {
        movie: {
          casts: [
            {
              number: 76,
              name: "hh_room_private",
              members: [
                { number: 43, name: "flat_floor_2_a_0_0_0", type: "bitmap" },
                { number: 44, name: "flat_floor_exact", type: "bitmap" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 43,
            memberName: "flat_floor_2_a_0_0_0",
            width: 5,
            height: 5,
            regPoint: { x: 0, y: 0 },
            pngPath: "external-bitmaps/release320/hh_room_private/0043-flat-floor.png",
            paletteIndexData: Buffer.from(sourcePixels).toString("base64"),
            paletteColors: [0xffffff, 0x000000],
            ink8AlphaPolicy: "edge-connected-white-transparent",
          },
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 44,
            memberName: "flat_floor_exact",
            width: 5,
            height: 5,
            regPoint: { x: 0, y: 0 },
            pngPath: "external-bitmaps/release320/hh_room_private/0044-flat-floor-exact.png",
            paletteIndexData: Buffer.from(sourcePixels).toString("base64"),
            paletteColors: [0xffffff, 0x000000],
          },
        ],
      };

      const members = new CastRegistry(manifests, "/origins-data/assets/");
      members.loadCast("hh_room_private");
      const edgeImage = members.find(43, "hh_room_private")!.effectiveImage();
      const exactImage = members.find(44, "hh_room_private")!.effectiveImage();

      expect(edgeImage.matteCoveragePolicyForDebug()).toBe("edge-connected-white-transparent");
      expect(edgeImage.createMatte().getPixel(2, 2).hex).toBe(0x000000);
      expect(exactImage.matteCoveragePolicyForDebug()).toBe("exact-white-transparent");
      expect(exactImage.createMatte().getPixel(2, 2).hex).toBe(0x000000);
      expect(exactImage.createMatte().getPixelAlpha(0, 0)).toBe(0);
    });
  });

  it("merges extracted bitmap members into casts already present in the movie manifest", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 648,
              name: "hh_interface",
              members: [{ number: 83, name: "mes_dark_icon", type: "bitmap" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_interface",
            castOrder: 1,
            member: 504,
            memberName: "controller_icon",
            width: 25,
            height: 31,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_interface/0504-controller-icon.png",
          },
        ],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_interface")).toBe(true);
    expect(members.find("mes_dark_icon", "hh_interface")?.number).toBe(83);
    expect(members.find("controller_icon", "hh_interface")?.slotNumber).toBe((648 << 16) | 504);
    expect(members.find("controller_icon", "hh_interface")?.bitmap?.pngUrl).toBe(
      "/origins-data/assets/external-bitmaps/release306/hh_interface/0504-controller-icon.png",
    );
  });

  it("resolves slot-encoded members to the loaded external cast before empty placeholders", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 40,
              name: "empty 37",
              members: [{ number: 1, name: "", type: "script" }],
            },
          ],
        },
        textFields: [
          {
            castName: "hh_bulletin",
            castOrder: 40,
            member: 2,
            memberName: "variable.index",
            memberType: "text",
            text: "bulletin.notification.margin.top=4",
          },
        ],
        bitmaps: [],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_bulletin")).toBe(true);

    const variableIndex = members.find("variable.index", "hh_bulletin");
    expect(variableIndex?.slotNumber).toBe((40 << 16) | 2);
    expect(members.find((40 << 16) | 2, null)).toBe(variableIndex);
  });

  it("indexes synthesized external script members by name and slot", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_entry_uk",
            castOrder: 11,
            member: 4,
            memberName: "entry.visual",
            memberType: "text",
            text: "<visual />",
          },
        ],
        bitmaps: [],
        externalMembers: [
          {
            castName: "hh_entry_uk",
            member: 23,
            memberName: "Entry Cloud Class",
            memberType: "script",
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_entry_uk")).toBe(true);

    const script = members.find("Entry Cloud Class", null);
    expect(script?.type).toBe("script");
    expect(script?.slotNumber).toBe((11 << 16) | 23);
    expect(members.find((11 << 16) | 23, null)).toBe(script);
  });

  it("resolves same-named members through loaded cast state instead of raw manifest order", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_first",
            castOrder: 40,
            member: 1,
            memberName: "thread.index",
            memberType: "text",
            text: "thread.id = first",
          },
          {
            castName: "hh_second",
            castOrder: 41,
            member: 1,
            memberName: "thread.index",
            memberType: "text",
            text: "thread.id = second",
          },
        ],
        bitmaps: [],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_second")).toBe(true);
    expect(members.find("thread.index", null)?.castName).toBe("hh_second");
    expect(members.find("thread.index", null)?.text).toContain("second");

    expect(members.loadCast("hh_first")).toBe(true);
    expect(members.find("thread.index", null)?.castName).toBe("hh_second");
    expect(members.find("thread.index", "hh_first")?.text).toContain("first");
  });

  it("hydrates playable media for a sound member sourced from an external cast graph", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [],
        externalMembers: [{
          castName: "hh_soundmachine",
          castOrder: 74,
          member: 103,
          memberName: "sound_machine_sample_0",
          memberType: "sound",
          sound: {
            container: "director-edim-mp3",
            codec: "mp3",
            sampleRate: 44100,
            channels: 1,
            sampleSize: null,
            sampleCount: 88200,
            durationMs: 2000,
            loopStart: null,
            loopEnd: null,
            assetPath: "sounds/release331/hh_soundmachine/0103-sound_machine_sample_0.mp3",
            assetSha256: "a".repeat(64),
            sourceFourCC: "ediM",
          },
        }],
      },
      "/origins-data/assets/",
    );

    expect(members.loadCast("hh_soundmachine")).toBe(true);
    const silence = members.find("sound_machine_sample_0", "hh_soundmachine");
    expect(silence?.type).toBe("sound");
    expect(silence?.sound).toMatchObject({
      codec: "mp3",
      durationMs: 2000,
      sampleCount: 88200,
      assetUrl: "/origins-data/assets/sounds/release331/hh_soundmachine/0103-sound_machine_sample_0.mp3",
    });
  });

  it("keeps source script identity when recovered bitmap metadata conflicts on the same slot", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 29,
            memberName: "left_wallend_0_b_0_0_0",
            mediaType: "bitmap",
            width: 8,
            height: 32,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release320/hh_room_private/0029-left-wallend.png",
          },
        ],
        externalMembers: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 29,
            memberName: "Private Room Engine Class",
            memberType: "script",
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);

    const script = members.find("Private Room Engine Class", "hh_room_private");
    expect(script?.type).toBe("script");
    expect(script?.number).toBe(29);
    expect(script?.bitmap).toBeNull();
    // The script identity keeps the slot; the recovered bitmap metadata is
    // relocated instead of discarded so room parts stay findable by name.
    const recoveredBitmap = members.find("left_wallend_0_b_0_0_0", "hh_room_private");
    expect(recoveredBitmap).not.toBeNull();
    expect(recoveredBitmap).not.toBe(script);
    expect(recoveredBitmap?.number).not.toBe(29);
    expect(recoveredBitmap?.bitmap?.pngUrl).toContain("0029-left-wallend.png");
    expect(members.find((76 << 16) | 29, null)).toBe(script);
  });

  it("resolves unprefixed catalog palette names used by room visualizers", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 54,
              name: "hh_cat_gfx_all",
              members: [{ number: 421, name: "catalog_wall_color_invaders", type: "palette" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
        palettes: [
          {
            castName: "hh_cat_gfx_all",
            castOrder: 54,
            member: 421,
            memberName: "catalog_wall_color_invaders",
            colors: [0xffffff, 0xbc5acd],
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_cat_gfx_all")).toBe(true);
    const catalogPalette = members.find("catalog_wall_color_invaders", null);

    expect(catalogPalette?.type).toBe("palette");
    expect(members.find("wall_color_invaders", null)).toBe(catalogPalette);
    expect(members.find("wall_color_invaders", "hh_cat_gfx_all")).toBe(catalogPalette);
  });

  it("keeps exact unprefixed member names ahead of catalog palette aliases", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 54,
              name: "hh_cat_gfx_all",
              members: [
                { number: 421, name: "catalog_wall_color_invaders", type: "palette" },
                { number: 422, name: "wall_color_invaders", type: "palette" },
                { number: 423, name: "catalog_not_a_palette", type: "bitmap" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
        palettes: [
          {
            castName: "hh_cat_gfx_all",
            castOrder: 54,
            member: 421,
            memberName: "catalog_wall_color_invaders",
            colors: [0xffffff, 0xbc5acd],
          },
          {
            castName: "hh_cat_gfx_all",
            castOrder: 54,
            member: 422,
            memberName: "wall_color_invaders",
            colors: [0xffffff, 0xaabbcc],
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_cat_gfx_all")).toBe(true);

    expect(members.find("wall_color_invaders", null)?.number).toBe(422);
    expect(members.find("not_a_palette", null)).toBeNull();
  });

  it("uses a color-backed catalog palette when the exact room palette is only a colorless shell", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 76,
              name: "hh_room_private",
              members: [{ number: 242, name: "wall_color_invaders", type: "palette" }],
            },
            {
              number: 54,
              name: "hh_cat_gfx_all",
              members: [{ number: 421, name: "catalog_wall_color_invaders", type: "palette" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
        palettes: [
          {
            castName: "hh_cat_gfx_all",
            castOrder: 54,
            member: 421,
            memberName: "catalog_wall_color_invaders",
            colors: [0xffffff, 0x84523b],
          },
        ],
      },
      "/assets/",
    );

    expect(members.loadCast("hh_room_private")).toBe(true);
    expect(members.loadCast("hh_cat_gfx_all")).toBe(true);

    expect(members.find("wall_color_invaders", null)?.slotNumber).toBe((54 << 16) | 421);
    expect(members.find("wall_color_invaders", null)?.paletteColors?.[1]).toBe(0x84523b);
  });

  it("uses catalog palette aliases when rendering indexed room wall members", () => {
    withPixelCanvas(() => {
      const members = new CastRegistry(
        {
          movie: {
            casts: [
              {
                number: 76,
                name: "hh_room_private",
                members: [
                  { number: 4, name: "left_wallpart_0_a_0_0_0", type: "bitmap" },
                  { number: 421, name: "catalog_wall_color_invaders", type: "palette" },
                ],
              },
            ],
          },
          textFields: [],
          bitmaps: [
            {
              castName: "hh_room_private",
              castOrder: 76,
              member: 4,
              memberName: "left_wallpart_0_a_0_0_0",
              width: 2,
              height: 1,
              regPoint: { x: 0, y: 0 },
              pngPath: "generated/assets/external-bitmaps/release306/hh_room_private/0004-wall.png",
              paletteIndexData: Buffer.from([0, 1]).toString("base64"),
              paletteColors: [0xffffff, 0x00ff00],
            },
          ],
          palettes: [
            {
              castName: "hh_room_private",
              castOrder: 76,
              member: 421,
              memberName: "catalog_wall_color_invaders",
              colors: [0xffffff, 0x84523b],
            },
          ],
        },
        "/assets/",
      );

      expect(members.loadCast("hh_room_private")).toBe(true);
      const wall = members.find("left_wallpart_0_a_0_0_0", "hh_room_private")!;
      const palette = members.find("wall_color_invaders", null)!;

      expect(wall.effectiveImage().getPixel(1, 0).hex).toBe(0x00ff00);
      wall.paletteRef = palette;
      expect(wall.effectiveImage().getPixel(1, 0).hex).toBe(0x84523b);
    });
  });
});
