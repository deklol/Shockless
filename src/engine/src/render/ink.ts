import { LingoColor } from "../director/geometry";
import { paletteRgb } from "../director/palettes";
import type { LingoValue } from "../director/values";

const WHITE_RGB = 0xffffff;

function colorRgb(color: LingoColor): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function isWhite(color: LingoColor): boolean {
  return color.r === 255 && color.g === 255 && color.b === 255;
}

/**
 * GPU tint for already-materialized direct bitmap sprites.
 *
 * Buffer-backed sprites are preprocessed by LingoImage/copyPixels before
 * presentation. Direct bitmap sprites need their remaining Director
 * sprite-level colour filter represented on the Pixi node itself.
 */
export function directorSpriteTintForDirectBitmap(
  ink: number,
  directPngTexture: boolean,
  backColor: number,
  spriteBgColor: LingoValue,
): number {
  if (!directPngTexture) return WHITE_RGB;

  if (ink === 41) {
    return spriteBgColor instanceof LingoColor ? colorRgb(spriteBgColor) : paletteRgb("systemMac", backColor);
  }

  if (ink === 8 && spriteBgColor instanceof LingoColor && !isWhite(spriteBgColor)) {
    return colorRgb(spriteBgColor);
  }

  return WHITE_RGB;
}

export function directBitmapInkRequiresPixelProcessing(ink: number, memberName = "", blend = 100): boolean {
  void memberName;
  void blend;
  if (!directBitmapInkUsesSpriteProcessing(ink)) return false;
  // Native Director keeps member pixels, sprite ink, bgColor/backColor,
  // blend, and palette state as separate compositor inputs. Pre-generated
  // ink PNGs are diagnostics/import artifacts, not authoritative stage
  // output, because they bake one caller's ink/key choice into reusable
  // member content.
  return true;
}

export function directBitmapInkUsesSpriteProcessing(ink: number): boolean {
  return ink === 8 || ink === 9 || ink === 36 || ink === 41 || ink === 33;
}

export function directBitmapInkIsInvisibleHitProxy(
  ink: number,
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
): boolean {
  // Origins public rooms use scaled 1x1 bitmap sprites with the Ghost family
  // inks as Director hit proxies. They must remain in sprite state for input,
  // but drawing the source pixel as Copy exposes a white rectangular click box.
  return (ink === 3 || ink === 7) && sourceWidth === 1 && sourceHeight === 1;
}

export function processedDirectBitmapInkUsesGpuTint(ink: number): boolean {
  // After CPU pixel processing, Darken has already applied its bgColor filter.
  // Matte still needs the sprite tint path for source-authored colour swaps.
  return ink === 8;
}

export function directorSpriteBlendModeForInk(
  ink: number,
): "normal" | "add" | "subtract" | "lighten" | "darken" {
  if (ink === 33 || ink === 34) return "add";
  if (ink === 35 || ink === 38) return "subtract";
  if (ink === 37) return "lighten";
  if (ink === 39) return "darken";
  return "normal";
}

export function directorSpriteAlphaForInk(ink: number, blend: number): number {
  // Director's arithmetic transfer modes write their channel result directly;
  // the sprite blend property does not attenuate that operation.
  if (ink === 33 || ink === 34 || ink === 35 || ink === 37 || ink === 38 || ink === 39) return 1;
  return Math.max(0, Math.min(1, blend / 100));
}

export function bitmapUrlForInk(
  bitmap: { pngUrl: string | null; inkUrls?: Record<string, string> },
  ink: number,
): string | null {
  const exact = bitmap.inkUrls?.[String(ink)];
  if (exact) return exact;
  if (ink === 33 || ink === 34) {
    // Arithmetic inks consume the authored source pixels directly. Add Pin
    // saturates channel sums; it does not apply Background Transparent's key.
    return bitmap.inkUrls?.["33"] ?? bitmap.pngUrl;
  }
  if (ink === 41) {
    // Direct sprite Darken still uses the pre-matted asset source when one
    // exists; the ink itself is the bgColor filter, not another matte pass.
    return bitmap.inkUrls?.["8"] ?? bitmap.inkUrls?.["36"] ?? bitmap.pngUrl;
  }
  if (ink !== 0) {
    return bitmap.inkUrls?.["36"] ?? bitmap.inkUrls?.["8"] ?? bitmap.pngUrl;
  }
  return bitmap.pngUrl;
}

export function bufferSpriteInkUsesMatteCoverage(ink: number): boolean {
  // Director's Add Pin compositor treats the white backing connected to the
  // bitmap boundary as absent before adding source RGB. Enclosed white pixels
  // remain authored artwork (for example, the Cinder Pumpkin's face).
  return ink === 8 || ink === 33 || ink === 41;
}

export function bufferSpriteInkUsesDirectorMask(ink: number): boolean {
  return ink === 9;
}

export function bufferSpriteInkUsesBoundaryWhiteCoverage(ink: number, runtimeImageBuffer = false): boolean {
  void runtimeImageBuffer;
  return ink === 8 || ink === 33 || ink === 41;
}

export function imagePixelsHaveNonOpaqueAlpha(pixels: Uint8ClampedArray): boolean {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset]! < 255) return true;
  }
  return false;
}

export function bufferSpriteInkUsesColorKey(ink: number): boolean {
  return ink === 36;
}

export function bufferSpriteInkUsesMultiplyTint(ink: number): boolean {
  return ink === 41;
}

export function directBitmapInkNeedsRuntimePixels(
  ink: number,
  memberName: string,
  blend: number,
  hasPreprocessedInk: boolean,
): boolean {
  if (!directBitmapInkUsesSpriteProcessing(ink)) return false;
  return directBitmapInkRequiresPixelProcessing(ink, memberName, blend) || !hasPreprocessedInk;
}

export function subtractInkSourceIsNoop(ink: number, color: LingoColor): boolean {
  return (ink === 35 || ink === 38) && color.r === 0 && color.g === 0 && color.b === 0;
}

export function boundaryConnectedWhiteMask(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  return boundaryConnectedColorMask(pixels, width, height, 255, 255, 255);
}

export function dominantOpaqueBorderRgb(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } | null {
  if (width <= 0 || height <= 0) return null;
  const counts = new Map<number, number>();
  const add = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    if ((pixels[offset + 3] ?? 0) <= 0) return;
    const rgb = ((pixels[offset] ?? 0) << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0);
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  };
  for (let x = 0; x < width; x += 1) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y);
    add(width - 1, y);
  }
  let bestRgb: number | null = null;
  let bestCount = 0;
  for (const [rgb, count] of counts) {
    if (count <= bestCount) continue;
    bestRgb = rgb;
    bestCount = count;
  }
  return bestRgb === null
    ? null
    : { r: (bestRgb >> 16) & 0xff, g: (bestRgb >> 8) & 0xff, b: bestRgb & 0xff };
}

export function boundaryConnectedDominantBorderMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const color = dominantOpaqueBorderRgb(pixels, width, height) ?? { r: 255, g: 255, b: 255 };
  return boundaryConnectedColorMask(pixels, width, height, color.r, color.g, color.b);
}

export function boundaryConnectedColorMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, width * height));
  if (width <= 0 || height <= 0) return mask;
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const isWhite = (index: number): boolean => {
    const offset = index * 4;
    return (
      pixels[offset + 3]! > 0 &&
      pixels[offset]! === r &&
      pixels[offset + 1]! === g &&
      pixels[offset + 2]! === b
    );
  };
  const enqueue = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (mask[index] || !isWhite(index)) return;
    mask[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
  return mask;
}

export function directorMaskCoverageAlpha(r: number, g: number, b: number, alpha: number): number {
  const maskAlpha = Math.max(0, Math.min(255, Math.trunc(alpha)));
  if (maskAlpha <= 0) return 0;
  const luminance = Math.max(0, Math.min(255, Math.round((r + g + b) / 3)));
  return Math.round((maskAlpha * (255 - luminance)) / 255);
}

export function applyDirectorMaskCoveragePixels(
  source: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const pixels = Math.max(0, width * height);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const coverage = directorMaskCoverageAlpha(
      mask[offset] ?? 255,
      mask[offset + 1] ?? 255,
      mask[offset + 2] ?? 255,
      mask[offset + 3] ?? 0,
    );
    source[offset + 3] = Math.round(((source[offset + 3] ?? 0) * coverage) / 255);
  }
}
