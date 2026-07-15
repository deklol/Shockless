import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Reads the Director configuration chunk which defines the authored cast
 * member range. CAS_ stores a zero-based array relative to minMember; its
 * array index is not itself a Director member number.
 */
export function readDirectorCastMetadata(chunksRoot) {
  const configJsonPath = firstChunkPath(chunksRoot, "DRCF", ".json");
  if (!configJsonPath) {
    throw new Error(`Director cast configuration (DRCF) was not extracted: ${chunksRoot}`);
  }

  const config = readProjectorRaysJson(configJsonPath);
  const minMember = finiteInteger(config.minMember, "DRCF minMember", configJsonPath);
  const maxMember = finiteInteger(config.maxMember, "DRCF maxMember", configJsonPath);
  if (minMember < 1 || maxMember < minMember) {
    throw new Error(`Invalid Director cast member range ${minMember}..${maxMember}: ${configJsonPath}`);
  }

  const configBinPath = firstChunkPath(chunksRoot, "DRCF", ".bin");
  return {
    minMember,
    maxMember,
    slotCount: maxMember - minMember + 1,
    sourceConfigPath: configJsonPath,
    defaultPalette: configBinPath ? readDirectorDefaultPalette(configBinPath) : undefined,
  };
}

export function directorMemberNumber(registryIndex, castMetadata) {
  if (!Number.isInteger(registryIndex) || registryIndex < 0) {
    throw new Error(`Invalid Director cast registry index: ${registryIndex}`);
  }
  return castMetadata.minMember + registryIndex;
}

/**
 * Director 5+ stores its movie default palette at DRCF offsets 76/78. Built-in
 * palette members use the header encoding where 0 is System Mac and each
 * negative value advances to the next built-in palette.
 */
export function readDirectorDefaultPalette(configBinPath) {
  const bytes = readFileSync(configBinPath);
  if (bytes.length < 80) return undefined;

  const fileVersion = bytes.readInt16BE(2);
  if (fileVersion < 500) return undefined;

  const sourceCastLib = bytes.readInt16BE(76);
  const sourceMember = bytes.readInt16BE(78);
  const resolvedMember = sourceMember <= 0 ? sourceMember - 1 : sourceMember;
  const builtInName = sourceMember <= 0 ? directorBuiltInPaletteName(resolvedMember) : undefined;
  return {
    sourceCastLib,
    sourceMember,
    resolvedCastLib: sourceMember <= 0 ? -1 : sourceCastLib,
    resolvedMember,
    kind: sourceMember <= 0 ? "builtin" : "cast-member",
    ...(builtInName ? { name: builtInName } : {}),
  };
}

export function directorBuiltInPaletteName(internalMember) {
  switch (internalMember) {
    case -1:
      return "systemMac";
    case -2:
      return "rainbow";
    case -3:
      return "grayscale";
    case -4:
      return "pastels";
    case -5:
      return "vivid";
    case -6:
      return "ntsc";
    case -7:
      return "metallic";
    case -8:
      return "web216";
    case -9:
      return "vga";
    case -101:
      return "systemWinDir4";
    case -102:
      return "systemWin";
    default:
      return undefined;
  }
}

export function readProjectorRaysJson(filePath) {
  const source = readFileSync(filePath, "utf8");
  return JSON.parse(source.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1"));
}

function firstChunkPath(chunksRoot, fourCC, extension) {
  if (!existsSync(chunksRoot)) return undefined;
  const fileName = readdirSync(chunksRoot)
    .filter((entry) => entry.startsWith(`${fourCC}-`) && entry.endsWith(extension))
    .sort(numericChunkSort)[0];
  return fileName ? path.join(chunksRoot, fileName) : undefined;
}

function finiteInteger(value, label, sourcePath) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`${label} is missing or invalid in ${sourcePath}`);
  }
  return number;
}

function numericChunkSort(left, right) {
  const leftId = Number(left.match(/-(\d+)\./)?.[1] ?? 0);
  const rightId = Number(right.match(/-(\d+)\./)?.[1] ?? 0);
  return leftId - rightId || left.localeCompare(right);
}
