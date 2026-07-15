import { describe, expect, it } from "vitest";
import type { Runtime } from "../../src/director/Runtime";
import { CastRegistry } from "../../src/director/members";
import { LINGO_VOID, LingoList, LingoSymbol } from "../../src/director/values";
import {
  isRelease306SmallScaleFurnitureCastName,
  release306CastDefinesFurnitureClass,
  release306DynamicFurnitureCastNamesFromValue,
  release306FurnitureCastMemberCountFast,
  release306FurnitureScaleFromGeometry,
  shouldUseRelease306SmallRoomMembers,
} from "../../src/habbo/roomBufferCompatibility";

describe("release306 room buffer compatibility", () => {
  it("keeps preview furniture thumbnails out of the small-scale room cast classifier", () => {
    expect(isRelease306SmallScaleFurnitureCastName("hh_furni_s_assets_3")).toBe(true);
    expect(isRelease306SmallScaleFurnitureCastName("hh_furni_special_50")).toBe(true);
    expect(isRelease306SmallScaleFurnitureCastName("hh_furni_2025_small")).toBe(true);
    expect(isRelease306SmallScaleFurnitureCastName("hh_furni_small")).toBe(false);
    expect(isRelease306SmallScaleFurnitureCastName("hh_furni_special")).toBe(false);
  });

  it("uses release306 room geometry for furniture member scale", () => {
    expect(shouldUseRelease306SmallRoomMembers(LingoSymbol.for("small"), 1)).toBe(true);
    expect(shouldUseRelease306SmallRoomMembers(LingoSymbol.for("large"), 1)).toBe(true);
    expect(shouldUseRelease306SmallRoomMembers(LingoSymbol.for("small"), 0)).toBe(false);
    expect(shouldUseRelease306SmallRoomMembers(LINGO_VOID, 1)).toBe(false);

    expect(release306FurnitureScaleFromGeometry(LingoSymbol.for("small"), 0)).toEqual(LingoSymbol.for("large"));
    expect(release306FurnitureScaleFromGeometry(LingoSymbol.for("small"), 1)).toEqual(LingoSymbol.for("small"));
    expect(release306FurnitureScaleFromGeometry(LingoSymbol.for("large"), 1)).toEqual(LingoSymbol.for("small"));
    expect(release306FurnitureScaleFromGeometry(LINGO_VOID, 1)).toBe(LINGO_VOID);
  });

  it("derives Buffer Component dynamic cast names from a list variable", () => {
    expect(
      release306DynamicFurnitureCastNamesFromValue(
        new LingoList([
          "hh_furni_items",
          "hh_furni_items",
          "hh_furni_small",
          "hh_furni_s_assets_3",
          "hh_pets_50",
        ]),
      ),
    ).toEqual(["hh_furni_items", "hh_furni_s_assets_3"]);
    expect(release306DynamicFurnitureCastNamesFromValue(LINGO_VOID)).toEqual([]);
  });

  it("identifies a release306 dynamic furniture class from unloaded cast definitions", () => {
    const registry = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_furni_2025",
            castOrder: 50,
            member: 10,
            memberName: "lc_glass_floor.props",
            text: "[:]",
          },
          {
            castName: "hh_furni_2025_small",
            castOrder: 62,
            member: 10,
            memberName: "s_lc_glass_floor.props",
            text: "[:]",
          },
        ],
        bitmaps: [
          {
            castName: "hh_furni_2025",
            castOrder: 50,
            member: 11,
            memberName: "lc_glass_floor_a_0_2_3_0_0",
            width: 16,
            height: 16,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/lc.png",
          },
          {
            castName: "hh_furni_items",
            castOrder: 45,
            member: 12,
            memberName: "chair_a_0_1_1_0_0",
            width: 16,
            height: 16,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/chair.png",
          },
        ],
      },
      "/assets/",
    );

    expect(release306CastDefinesFurnitureClass(registry, "hh_furni_2025", "lc_glass_floor")).toBe(true);
    expect(release306CastDefinesFurnitureClass(registry, "hh_furni_2025_small", "s_lc_glass_floor")).toBe(true);
    expect(release306CastDefinesFurnitureClass(registry, "hh_furni_items", "lc_glass_floor")).toBe(false);
  });

  it("counts furniture cast members through the current castLib owner", () => {
    const registry = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 7,
              name: "hh_furni_items",
              members: [
                { number: 1, name: "asset.index", type: "field" },
                { number: 12, name: "chair_a_0_1_1_0_0", type: "bitmap" },
              ],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
      },
      "/assets/",
    );
    registry.loadCast("hh_furni_items", 7);

    const fakeRuntime = (castName: string): Runtime => ({
      countOf: (type: string) => (type === "castlib" ? 7 : 0),
      call: (_name: string, args: unknown[]) => {
        const number = Number(args[0]);
        if (number === 7) return { name: castName, fileName: `${castName}.cct` };
        return { name: `empty ${number}`, fileName: "empty.cct" };
      },
    } as unknown as Runtime);

    expect(release306FurnitureCastMemberCountFast(fakeRuntime("hh_furni_items"), registry, "hh_furni_items")).toBe(12);
    expect(release306FurnitureCastMemberCountFast(fakeRuntime("empty 5"), registry, "hh_furni_items")).toBe(0);
    expect(release306FurnitureCastMemberCountFast(fakeRuntime("hh_furni_items"), registry, "[hh_furni_items]?cache=1")).toBe(12);
  });
});
