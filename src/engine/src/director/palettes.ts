import { LingoColor } from "./geometry";

/**
 * Director built-in palettes. Sprite foreColor/backColor are 8-bit palette
 * indexes; ink processing (Darken's bgColor tint, Background Transparent's
 * key color) resolves them through the member's palette. release306 members
 * default to #systemMac. Layout evidence: LibreShockwave Palette.java /
 * ScummVM director; index 0 is white, 255 is black.
 */

const RAMP_STEPS = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
const CUBE_STEPS = [0xff, 0xcc, 0x99, 0x66, 0x33, 0x00];
const DIRECTOR_SYSTEM_WIN_DIR4 = [
  0xffffff, 0x00ffff, 0xff00ff, 0x0000ff, 0xffff00, 0x00ff00, 0xff0000, 0x808080,
  0xa0a0a4, 0xfffbf0, 0x333333, 0x996600, 0x336633, 0x003399, 0xcc00ff, 0x880000,
  0xffcc66, 0xff99cc, 0xdddddd, 0xff9900, 0xff66ff, 0xff66cc, 0xff6699, 0xff6666,
  0xff6633, 0xff6600, 0xff33ff, 0xff33cc, 0xff3399, 0xff3366, 0xff3333, 0xff3300,
  0xff00cc, 0xff0099, 0xff0066, 0xff0033, 0xccffff, 0xccffcc, 0xccff99, 0xccff66,
  0xccff33, 0xccff00, 0xccccff, 0xcccccc, 0xcccc99, 0xcccc66, 0xcccc33, 0xcccc00,
  0xcc99ff, 0xcc99cc, 0xcc9999, 0xcc9966, 0xcc9933, 0xcc9900, 0xcc66ff, 0xcc66cc,
  0xcc6699, 0xcc6666, 0xcc6633, 0xcc6600, 0xcc33ff, 0xcc33cc, 0xcc3399, 0xcc3366,
  0xcc3333, 0xcc3300, 0xd408ff, 0xcc00cc, 0xcc0099, 0xcc0066, 0xcc0033, 0xcc0000,
  0x99ffff, 0x99ffcc, 0x99ff99, 0x99ff66, 0x99ff33, 0x99ff00, 0x99ccff, 0x99cccc,
  0x99cc99, 0x99cc66, 0x99cc33, 0x99cc00, 0x9999ff, 0x9999cc, 0x999999, 0x999966,
  0x999933, 0x999900, 0x9966ff, 0x9966cc, 0x996699, 0x996666, 0x996633, 0xa16600,
  0x9933ff, 0x9933cc, 0x993399, 0x993366, 0x993333, 0x993300, 0x9900ff, 0x9900cc,
  0x990099, 0x990066, 0x990033, 0x990000, 0x66ffff, 0x66ffcc, 0x66ff99, 0x66ff66,
  0x66ff33, 0x66ff00, 0x66ccff, 0x66cccc, 0x66cc99, 0x66cc66, 0x66cc33, 0x66cc00,
  0x6699ff, 0x6699cc, 0x669999, 0x669966, 0x669933, 0x669900, 0x6666ff, 0x6666cc,
  0x666699, 0x666666, 0x666633, 0x666600, 0x6633ff, 0x6633cc, 0x663399, 0x663366,
  0x663333, 0x663300, 0x6600ff, 0x6600cc, 0x660099, 0x660066, 0x660033, 0x660000,
  0x33ffff, 0x33ffcc, 0x33ff99, 0x33ff66, 0x33ff33, 0x33ff00, 0x33ccff, 0x33cccc,
  0x33cc99, 0x33cc66, 0x33cc33, 0x33cc00, 0x3399ff, 0x3399cc, 0x339999, 0x339966,
  0x339933, 0x339900, 0x3366ff, 0x3366cc, 0x336699, 0x336666, 0x336e33, 0x336600,
  0x3333ff, 0x3333cc, 0x333399, 0x333366, 0x33333b, 0x333300, 0x3300ff, 0x3300cc,
  0x330099, 0x330066, 0x330033, 0x330000, 0x00ffcc, 0x00ff99, 0x00ff66, 0x00ff33,
  0x00ccff, 0x00cccc, 0x00cc99, 0x00cc66, 0x00cc33, 0x00cc00, 0x0099ff, 0x0099cc,
  0x009999, 0x009966, 0x009933, 0x009900, 0x0066ff, 0x0066cc, 0x006699, 0x006666,
  0x006633, 0x006600, 0x0033ff, 0x0033cc, 0x0033a1, 0x003366, 0x003333, 0x003300,
  0x0000cc, 0x000099, 0x000066, 0x000033, 0xee0000, 0xdd0000, 0xaa0000, 0x900000,
  0x770000, 0x550000, 0x440000, 0x220000, 0x110000, 0x00ee00, 0x00dd00, 0x00aa00,
  0x008800, 0x007700, 0x005500, 0x004400, 0x002200, 0x001100, 0x0000ee, 0x0000dd,
  0x0000aa, 0x000088, 0x000077, 0x000055, 0x000044, 0x000022, 0x000011, 0x222230,
  0xff9999, 0xffccff, 0x99d4ff, 0x99d499, 0xffff99, 0xf0f0f0, 0xa4c8f0, 0xc0dcc0,
  0xc0c0c0, 0x00bfbf, 0xbf00bf, 0x0000bf, 0xbfbf00, 0x00bf00, 0xbf0000, 0x000000,
];

function buildSystemMacPalette(): number[] {
  const colors: number[] = [];
  // Indices 0..214: 6x6x6 cube, each channel descending ff,cc,99,66,33,00.
  // The all-black cube entry is not stored here; black lives at index 255.
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        if (r === 5 && g === 5 && b === 5) break;
        colors.push((CUBE_STEPS[r]! << 16) | (CUBE_STEPS[g]! << 8) | CUBE_STEPS[b]!);
      }
    }
  }
  // 215..244: red, green, blue ramps with the intermediate steps the cube
  // does not already provide; 245..254: gray ramp; 255: black.
  for (const step of RAMP_STEPS) colors.push(step << 16);
  for (const step of RAMP_STEPS) colors.push(step << 8);
  for (const step of RAMP_STEPS) colors.push(step);
  for (const step of RAMP_STEPS) colors.push((step << 16) | (step << 8) | step);
  colors.push(0x000000);
  return colors;
}

function buildGrayscalePalette(): number[] {
  const colors: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    const v = 255 - i;
    colors.push((v << 16) | (v << 8) | v);
  }
  return colors;
}

function buildSystemWinD5Palette(): number[] {
  const colors = [...DIRECTOR_SYSTEM_WIN_DIR4];
  colors[246] = 0xa6c8f0;
  colors[249] = 0x008080;
  colors[250] = 0x800080;
  colors[251] = 0x000080;
  colors[252] = 0x808000;
  colors[253] = 0x008000;
  colors[254] = 0x800000;
  return colors;
}

const SYSTEM_MAC = buildSystemMacPalette();
const GRAYSCALE = buildGrayscalePalette();
const SYSTEM_WIN_DIR4 = DIRECTOR_SYSTEM_WIN_DIR4;
const SYSTEM_WIN_D5 = buildSystemWinD5Palette();
const DIRECTOR_1BIT = [0xffffff, 0x000000];
const DIRECTOR_2BIT_GRAYSCALE = [0xffffff, 0xa3a3a3, 0x656565, 0x000000];
// Director's 4-bit (16-level) grayscale ramp: index 0 = white .. index 15 = black, the
// standard Mac 16-gray CLUT. Without this, depth-4 grayscale bitmaps fell through to the
// 256-entry grayscale table whose first 16 entries are all near-white (255..240), so a
// 4-bit grayscale image collapsed to flat near-white and its dark indices (e.g. the
// window clouds' black outline at index 15) never reached black.
const DIRECTOR_4BIT_GRAYSCALE = [
  0xffffff, 0xeeeeee, 0xdddddd, 0xcccccc, 0xbbbbbb, 0xaaaaaa, 0x999999, 0x888888,
  0x777777, 0x666666, 0x555555, 0x444444, 0x333333, 0x222222, 0x111111, 0x000000,
];

export function paletteTable(paletteName: string): readonly number[] {
  const normalized = paletteName.toLowerCase();
  if (normalized === "grayscale") return GRAYSCALE;
  if (normalized === "systemwindir4") return SYSTEM_WIN_DIR4;
  if (normalized === "systemwin") return SYSTEM_WIN_D5;
  return SYSTEM_MAC;
}

export function paletteTableForBitmapDepth(paletteName: string, bitDepth: number | null | undefined): readonly number[] {
  const depth = Math.trunc(Number(bitDepth) || 0);
  if (depth <= 1 && depth > 0) return DIRECTOR_1BIT;
  if (depth === 2) return DIRECTOR_2BIT_GRAYSCALE;
  if (depth === 4 && paletteName.toLowerCase() === "grayscale") return DIRECTOR_4BIT_GRAYSCALE;
  return paletteTable(paletteName);
}

export function paletteRgb(paletteName: string, index: number): number {
  const table = paletteTable(paletteName);
  const clamped = Math.min(255, Math.max(0, Math.trunc(index)));
  return table[clamped] ?? 0;
}

export function paletteColor(paletteName: string, index: number): LingoColor {
  const rgb = paletteRgb(paletteName, index);
  return new LingoColor((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
}
