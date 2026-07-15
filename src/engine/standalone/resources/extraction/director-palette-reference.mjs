import {
  createDirectorBuiltInPalette,
  createDirectorSystemMacPalette,
} from "./director-built-in-palettes.mjs";

/**
 * Resolves the palette identity stored in a bitmap CASt chunk. No name
 * matching, inferred member offsets, or arbitrary palette selection is used.
 */
export function resolveDirectorBitmapPalette({
  sourceCast,
  bitmap,
  movieCastsByNumber = new Map(),
  readPalette,
}) {
  const sourceCastLib = Number(bitmap.paletteCastLib ?? -1);
  const sourceMember = Number(bitmap.paletteMemberNumber ?? 0);

  if (!Number.isInteger(sourceCastLib) || !Number.isInteger(sourceMember)) {
    return unresolvedReference(sourceCastLib, sourceMember, "invalid-palette-reference-fields");
  }

  if (sourceMember <= 0) {
    const internalMember = sourceMember - 1;
    const palette = createDirectorBuiltInPalette(internalMember);
    if (!palette) {
      return systemMacFallback({
        sourceCastLib,
        sourceMember,
        sourceKind: "builtin",
        resolution: "invalid-built-in-system-mac-fallback",
      });
    }
    return {
      palette,
      sourceCastLib,
      sourceMember,
      resolvedCastLib: -1,
      resolvedMember: internalMember,
      sourceKind: "builtin",
      resolution: "exact-built-in",
      sourceReferenceValid: true,
      sourcePaletteName: palette.name,
    };
  }

  const targetCast = sourceCastLib === -1 ? sourceCast : movieCastsByNumber.get(sourceCastLib);
  const targetMember = targetCast?.members?.find(
    (member) => member.type === "palette" && member.number === sourceMember,
  );
  const palette = targetCast && targetMember ? readPalette(targetCast, targetMember) : undefined;
  if (palette) {
    return {
      palette,
      sourceCastLib,
      sourceMember,
      resolvedCastLib: sourceCastLib === -1 ? sourceCast.order ?? sourceCast.number ?? -1 : sourceCastLib,
      resolvedMember: sourceMember,
      sourceKind: "cast-member",
      resolution: "exact-cast-member",
      sourceReferenceValid: true,
      sourcePaletteName: palette.name,
    };
  }

  // Director accepts stale/invalid saved CLUT IDs. Its bitmap render path uses
  // System Mac when the referenced palette is not loaded instead of choosing
  // another cast palette.
  return systemMacFallback({
    sourceCastLib,
    sourceMember,
    sourceKind: "cast-member",
    resolution: "invalid-cast-member-system-mac-fallback",
  });
}

export function paletteProvenance(reference) {
  return {
    sourcePaletteCastLib: reference.sourceCastLib,
    sourcePaletteMember: reference.sourceMember,
    resolvedPaletteCastLib: reference.resolvedCastLib,
    resolvedPaletteMember: reference.resolvedMember,
    sourcePaletteKind: reference.sourceKind,
    paletteResolution: reference.resolution,
    sourcePaletteReferenceValid: reference.sourceReferenceValid,
    ...(reference.sourcePaletteName ? { sourcePaletteName: reference.sourcePaletteName } : {}),
  };
}

function systemMacFallback({ sourceCastLib, sourceMember, sourceKind, resolution }) {
  return {
    palette: {
      castName: "builtin",
      member: 0,
      memberChunkId: 0,
      name: "systemMac",
      sectionId: 0,
      chunkPath: "builtin/systemMac",
      colors: createDirectorSystemMacPalette(),
    },
    sourceCastLib,
    sourceMember,
    resolvedCastLib: -1,
    resolvedMember: -1,
    sourceKind,
    resolution,
    sourceReferenceValid: false,
  };
}
