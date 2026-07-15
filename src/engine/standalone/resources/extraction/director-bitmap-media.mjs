import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { readDirectorKeyEntries } from "./director-bitd-recovery.mjs";

export function resolveDirectorBitmapMediaSource(chunksRoot, memberChunkId) {
  const entries = readDirectorKeyEntries(chunksRoot).filter((entry) => entry.castID === memberChunkId);
  const media = entries.find((entry) => entry.fourCC === "ediM");
  if (!media) return undefined;

  const mediaPath = path.join(chunksRoot, `ediM-${media.sectionID}.bin`);
  if (!existsSync(mediaPath) || !looksLikeJpeg(readFileSync(mediaPath))) return undefined;

  const alpha = entries.find((entry) => entry.fourCC === "ALFA");
  const alphaPath = alpha ? path.join(chunksRoot, `ALFA-${alpha.sectionID}.bin`) : undefined;
  return {
    kind: "keyed-edim-jpeg",
    fourCC: "ediM",
    format: "jpeg",
    sectionID: media.sectionID,
    mediaPath,
    ...(alpha && alphaPath && existsSync(alphaPath) ? { alphaSectionID: alpha.sectionID, alphaPath } : {}),
  };
}

export function decodeDirectorJpegMedia(sourcePath, width, height, alphaPath) {
  let decoded;
  try {
    decoded = jpeg.decode(readFileSync(sourcePath), { useTArray: true });
  } catch {
    return undefined;
  }
  if (decoded.width !== width || decoded.height !== height) return undefined;

  const rgba = Buffer.from(decoded.data);
  if (alphaPath && existsSync(alphaPath)) {
    const alpha = decompressPackBits(readFileSync(alphaPath), width * height);
    for (let index = 0; index < alpha.length; index += 1) {
      rgba[index * 4 + 3] = alpha[index];
    }
  }
  return rgba;
}

function looksLikeJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function decompressPackBits(source, expectedLength) {
  const output = Buffer.alloc(expectedLength);
  let sourceOffset = 0;
  let outputOffset = 0;
  while (sourceOffset < source.length && outputOffset < output.length) {
    const control = source[sourceOffset++];
    if (control < 0x80) {
      const count = control + 1;
      source.copy(output, outputOffset, sourceOffset, Math.min(sourceOffset + count, source.length));
      sourceOffset += count;
      outputOffset += count;
    } else if (control > 0x80 && sourceOffset < source.length) {
      const count = 257 - control;
      output.fill(source[sourceOffset++], outputOffset, Math.min(outputOffset + count, output.length));
      outputOffset += count;
    }
  }
  return output;
}
