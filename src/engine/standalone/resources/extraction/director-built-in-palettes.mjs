import { DIRECTOR_BUILT_IN_PALETTE_RGB } from "./director-built-in-palette-data.mjs";

const BUILT_IN_MEMBER_NAMES = new Map([
  [-1, "systemMac"],
  [-2, "rainbow"],
  [-3, "grayscale"],
  [-4, "pastels"],
  [-5, "vivid"],
  [-6, "ntsc"],
  [-7, "metallic"],
  [-101, "systemWinDir4"],
  [-102, "systemWin"],
]);

export function createDirectorSystemWinPalette(name = "systemWin") {
  const normalized = String(name).trim().toLowerCase();
  return createPaletteColors(normalized === "systemwindir4" ? "systemWinDir4" : "systemWin");
}

export function createDirectorSystemMacPalette() {
  return createPaletteColors("systemMac");
}

export function createDirectorGrayscalePalette() {
  return createPaletteColors("grayscale");
}

export function createDirectorBuiltInPalette(internalMember) {
  const name = BUILT_IN_MEMBER_NAMES.get(internalMember);
  return name ? builtIn(name, createPaletteColors(name)) : undefined;
}

function createPaletteColors(name) {
  const rgbValues = DIRECTOR_BUILT_IN_PALETTE_RGB[name];
  if (!rgbValues) throw new Error(`Unknown Director built-in palette: ${name}`);
  return rgbValues.map((rgb) => ({
    r: (rgb >> 16) & 0xff,
    g: (rgb >> 8) & 0xff,
    b: rgb & 0xff,
  }));
}

function builtIn(name, colors) {
  return {
    castName: "builtin",
    member: 0,
    memberChunkId: 0,
    name,
    sectionId: 0,
    chunkPath: `builtin/${name}`,
    colors,
  };
}
