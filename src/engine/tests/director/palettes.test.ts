import { describe, expect, it } from "vitest";
import { paletteColor, paletteRgb, paletteTable, paletteTableForBitmapDepth } from "../../src/director/palettes";

describe("Director built-in palettes", () => {
  it("resolves Windows system palette symbols separately from systemMac", () => {
    expect(paletteTable("systemWin")).toHaveLength(256);
    expect(paletteTable("systemWinDir4")).toHaveLength(256);
    expect(paletteRgb("systemWin", 0)).toBe(0xffffff);
    expect(paletteRgb("systemWin", 8)).toBe(0xa0a0a4);
    expect(paletteRgb("systemWin", 255)).toBe(0x000000);
    expect(paletteRgb("systemWin", 254)).toBe(0x800000);
    expect(paletteRgb("systemWinDir4", 249)).toBe(0x00bfbf);
    expect(paletteRgb("systemWin", 249)).toBe(0x008080);
    expect(paletteRgb("systemMac", 1)).not.toBe(paletteRgb("systemWin", 1));
  });

  it("uses the selected palette when resolving Director color indexes", () => {
    const color = paletteColor("systemWin", 8);
    expect(color.r).toBe(0xa0);
    expect(color.g).toBe(0xa0);
    expect(color.b).toBe(0xa4);
  });

  it("uses Director depth-specific palettes for 1-bit and 2-bit bitmap sources", () => {
    expect(paletteTableForBitmapDepth("systemWin", 1)).toEqual([0xffffff, 0x000000]);
    expect(paletteTableForBitmapDepth("systemWin", 2)).toEqual([0xffffff, 0xa3a3a3, 0x656565, 0x000000]);
    expect(paletteTableForBitmapDepth("systemWin", 8)).toBe(paletteTable("systemWin"));
  });
});
