import { describe, expect, it } from "vitest";
import { LingoColor } from "../../src/director/geometry";
import {
  applyDirectorMaskCoveragePixels,
  bufferSpriteInkUsesColorKey,
  bufferSpriteInkUsesBoundaryWhiteCoverage,
  bufferSpriteInkUsesDirectorMask,
  bufferSpriteInkUsesMatteCoverage,
  bufferSpriteInkUsesMultiplyTint,
  boundaryConnectedDominantBorderMask,
  directBitmapInkIsInvisibleHitProxy,
  directBitmapInkNeedsRuntimePixels,
  directBitmapInkRequiresPixelProcessing,
  directorSpriteAlphaForInk,
  directorSpriteBlendModeForInk,
  directorMaskCoverageAlpha,
  directorSpriteTintForDirectBitmap,
  bitmapUrlForInk,
  boundaryConnectedWhiteMask,
  imagePixelsHaveNonOpaqueAlpha,
  processedDirectBitmapInkUsesGpuTint,
  subtractInkSourceIsNoop,
} from "../../src/render/ink";

describe("Director sprite ink presentation", () => {
  it("tints direct matte bitmap sprites from sprite.bgColor when source assigned a real colour", () => {
    expect(directorSpriteTintForDirectBitmap(8, true, 0, new LingoColor(255, 34, 0))).toBe(0xff2200);
  });

  it("keeps default matte bitmap sprites untinted", () => {
    expect(directorSpriteTintForDirectBitmap(8, true, 0, 0)).toBe(0xffffff);
    expect(directorSpriteTintForDirectBitmap(8, true, 0, new LingoColor(255, 255, 255))).toBe(0xffffff);
    expect(directorSpriteTintForDirectBitmap(8, true, 0, new LingoColor(255, 255, 255, 0))).toBe(0xffffff);
  });

  it("leaves buffer-backed sprites to the Director image ink processor", () => {
    expect(directorSpriteTintForDirectBitmap(8, false, 0, new LingoColor(255, 34, 0))).toBe(0xffffff);
    expect(directorSpriteTintForDirectBitmap(41, false, 0, new LingoColor(255, 221, 63))).toBe(0xffffff);
  });

  it("preserves Darken direct bitmap tint semantics", () => {
    expect(directorSpriteTintForDirectBitmap(41, true, 0, new LingoColor(255, 221, 63))).toBe(0xffdd3f);
    expect(directorSpriteTintForDirectBitmap(41, true, 0, 0)).toBe(0xffffff);
  });

  it("mattes buffer-backed Darken sprites before applying the colour filter", () => {
    expect(bufferSpriteInkUsesMatteCoverage(8)).toBe(true);
    expect(bufferSpriteInkUsesColorKey(36)).toBe(true);
    expect(bufferSpriteInkUsesColorKey(33)).toBe(false);
    expect(bufferSpriteInkUsesMatteCoverage(33)).toBe(true);
    expect(bufferSpriteInkUsesBoundaryWhiteCoverage(33)).toBe(true);
    expect(bufferSpriteInkUsesMultiplyTint(41)).toBe(true);
    expect(bufferSpriteInkUsesMatteCoverage(41)).toBe(true);
    expect(bufferSpriteInkUsesBoundaryWhiteCoverage(41)).toBe(true);
    expect(bufferSpriteInkUsesBoundaryWhiteCoverage(8, true)).toBe(true);
    expect(bufferSpriteInkUsesBoundaryWhiteCoverage(8, false)).toBe(true);
    expect(bufferSpriteInkUsesDirectorMask(9)).toBe(true);
    expect(bufferSpriteInkUsesDirectorMask(8)).toBe(false);
  });

  it("applies Director Mask ink coverage from black opaque to white transparent", () => {
    expect(directorMaskCoverageAlpha(0, 0, 0, 255)).toBe(255);
    expect(directorMaskCoverageAlpha(255, 255, 255, 255)).toBe(0);
    expect(directorMaskCoverageAlpha(128, 128, 128, 255)).toBe(127);
    expect(directorMaskCoverageAlpha(0, 0, 0, 0)).toBe(0);

    const source = new Uint8ClampedArray([
      20, 30, 40, 255,
      50, 60, 70, 255,
      80, 90, 100, 200,
      110, 120, 130, 255,
    ]);
    const mask = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
      128, 128, 128, 255,
      0, 0, 0, 128,
    ]);

    applyDirectorMaskCoveragePixels(source, mask, 2, 2);

    expect(source[3]).toBe(255);
    expect(source[7]).toBe(0);
    expect(source[11]).toBe(100);
    expect(source[15]).toBe(128);
  });

  it("keeps closed white artwork while removing boundary white for buffer-backed Darken", () => {
    const width = 5;
    const height = 5;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
    const setBlack = (x: number, y: number): void => {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
    };
    for (let x = 1; x <= 3; x += 1) {
      setBlack(x, 1);
      setBlack(x, 3);
    }
    setBlack(1, 2);
    setBlack(3, 2);

    const mask = boundaryConnectedWhiteMask(pixels, width, height);
    expect(mask[0]).toBe(1);
    expect(mask[2 * width + 2]).toBe(0);
  });

  it("uses boundary-connected white coverage for direct Matte sprites", () => {
    const width = 5;
    const height = 5;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
    const setBlack = (x: number, y: number): void => {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
    };
    for (let x = 1; x <= 3; x += 1) {
      setBlack(x, 1);
      setBlack(x, 3);
    }
    setBlack(1, 2);
    setBlack(3, 2);

    const mask = boundaryConnectedWhiteMask(pixels, width, height);

    expect(bufferSpriteInkUsesBoundaryWhiteCoverage(8, false)).toBe(true);
    expect(mask[0]).toBe(1);
    expect(mask[2 * width + 2]).toBe(0);
  });

  it("detects alpha-backed direct bitmap sources before applying Matte keying", () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 0,
      255, 255, 255, 255,
      20, 30, 40, 255,
    ]);

    expect(imagePixelsHaveNonOpaqueAlpha(pixels)).toBe(true);
  });

  it("removes boundary-connected dominant backing without dropping interior artwork", () => {
    const width = 5;
    const height = 5;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const set = (x: number, y: number, r: number, g: number, b: number): void => {
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) set(x, y, 255, 0, 255);
    }
    for (let x = 1; x <= 3; x += 1) {
      set(x, 1, 0, 0, 0);
      set(x, 3, 0, 0, 0);
    }
    set(1, 2, 0, 0, 0);
    set(3, 2, 0, 0, 0);
    set(2, 2, 255, 0, 255);

    const mask = boundaryConnectedDominantBorderMask(pixels, width, height);

    expect(mask[0]).toBe(1);
    expect(mask[2 * width + 2]).toBe(0);
  });

  it("routes direct Matte door and blended mask bitmaps through the engine pixel processor", () => {
    expect(directBitmapInkRequiresPixelProcessing(8, "leftdoor_open", 100)).toBe(true);
    expect(directBitmapInkRequiresPixelProcessing(8, "leftdoor_open_mask", 20)).toBe(true);
    expect(directBitmapInkRequiresPixelProcessing(8, "plant_bonsai_a_0_1_1_0_0", 100)).toBe(true);
    expect(directBitmapInkRequiresPixelProcessing(9, "vesi1", 60)).toBe(true);
    expect(directBitmapInkRequiresPixelProcessing(36, "leftdoor_open", 100)).toBe(true);
    expect(directBitmapInkRequiresPixelProcessing(41, "leftdoor_open", 100)).toBe(true);
  });

  it("routes direct bitmap ink through runtime composition even when generated variants exist", () => {
    expect(directBitmapInkNeedsRuntimePixels(36, "Habbo UK tower", 100, true)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(41, "corner_element", 20, true)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(33, "light1", 100, true)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(9, "vesi1", 60, true)).toBe(true);
  });

  it("does not apply a second GPU tint after direct Darken pixels are processed", () => {
    expect(processedDirectBitmapInkUsesGpuTint(8)).toBe(true);
    expect(processedDirectBitmapInkUsesGpuTint(41)).toBe(false);
    expect(processedDirectBitmapInkUsesGpuTint(36)).toBe(false);
    expect(processedDirectBitmapInkUsesGpuTint(33)).toBe(false);
  });

  it("keeps scaled 1x1 Ghost-family bitmap hit proxies visually invisible", () => {
    expect(directBitmapInkIsInvisibleHitProxy(7, 1, 1)).toBe(true);
    expect(directBitmapInkIsInvisibleHitProxy(3, 1, 1)).toBe(true);
    expect(directBitmapInkIsInvisibleHitProxy(7, 2, 1)).toBe(false);
    expect(directBitmapInkIsInvisibleHitProxy(8, 1, 1)).toBe(false);
  });

  it("maps arithmetic sprite ink to GPU compositing for every sprite media type", () => {
    expect(directorSpriteBlendModeForInk(33)).toBe("add");
    expect(directorSpriteBlendModeForInk(34)).toBe("add");
    expect(directorSpriteBlendModeForInk(35)).toBe("subtract");
    expect(directorSpriteBlendModeForInk(37)).toBe("lighten");
    expect(directorSpriteBlendModeForInk(38)).toBe("subtract");
    expect(directorSpriteBlendModeForInk(39)).toBe("darken");
    expect(directorSpriteBlendModeForInk(8)).toBe("normal");
    expect(directorSpriteBlendModeForInk(41)).toBe("normal");
  });

  it("keeps arithmetic ink at full operation strength regardless of sprite blend", () => {
    for (const ink of [33, 34, 35, 37, 38, 39]) {
      expect(directorSpriteAlphaForInk(ink, 30)).toBe(1);
    }
    expect(directorSpriteAlphaForInk(8, 30)).toBe(0.3);
    expect(directorSpriteAlphaForInk(36, 125)).toBe(1);
  });

  it("selects the exact direct bitmap ink asset when one exists", () => {
    const bitmap = {
      pngUrl: "/raw.png",
      inkUrls: {
        "8": "/matte.png",
        "36": "/background-transparent.png",
      },
    };

    expect(bitmapUrlForInk(bitmap, 8)).toBe("/matte.png");
    expect(bitmapUrlForInk(bitmap, 36)).toBe("/background-transparent.png");
    expect(bitmapUrlForInk(bitmap, 33)).toBe("/raw.png");
    expect(bitmapUrlForInk(bitmap, 41)).toBe("/matte.png");
    expect(bitmapUrlForInk(bitmap, 0)).toBe("/raw.png");
  });

  it("uses runtime direct bitmap ink for channel-state-dependent presentation", () => {
    expect(directBitmapInkNeedsRuntimePixels(36, "Habbo UK tower", 100, false)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(8, "leftdoor_open", 100, true)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(8, "leftdoor_open_mask", 20, true)).toBe(true);
    expect(directBitmapInkNeedsRuntimePixels(0, "Habbo UK tower", 100, false)).toBe(false);
  });

  it("treats solid black Subtract sprites as no-op presentation", () => {
    expect(subtractInkSourceIsNoop(35, new LingoColor(0, 0, 0))).toBe(true);
    expect(subtractInkSourceIsNoop(38, new LingoColor(0, 0, 0))).toBe(true);
    expect(subtractInkSourceIsNoop(35, new LingoColor(1, 0, 0))).toBe(false);
    expect(subtractInkSourceIsNoop(8, new LingoColor(0, 0, 0))).toBe(false);
  });
});
