import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PROFILE_RUNTIME_DATA_SCHEMA_VERSION, type ProfileValidationSummary } from "../common/types.js";
import { assetIndexFiles, optionalRuntimeDataFiles, requiredRuntimeDataFiles } from "./originsRuntimeAdapter.js";
import { collectReferencedProfileMedia, profileMediaLooksValid } from "./profileMediaAssets.js";

export type ProfileValidationSeverity = "error" | "warning";
export type ProfileValidationState = "pass" | "warning" | "fail";

export interface ProfileValidationIssue {
  readonly severity: ProfileValidationSeverity;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly count?: number;
  readonly sample?: string[];
}

export interface ProfileValidationCheck {
  readonly name: string;
  readonly state: ProfileValidationState;
  readonly summary: string;
  readonly counts?: Record<string, number>;
  readonly samples?: string[];
}

export interface ProfileValidationReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly versionId: string;
  readonly ready: boolean;
  readonly completion: ProfileValidationCompletion;
  readonly issues: ProfileValidationIssue[];
  readonly checks: ProfileValidationCheck[];
  readonly diagnostics: ProfileCompilerDiagnostics;
  readonly inventory: {
    readonly requiredRuntimeFiles: Record<string, boolean>;
    readonly optionalRuntimeFiles: Record<string, boolean>;
    readonly assetReferences: number;
    readonly assetFilesReady: number;
    readonly assetFilesMissing: number;
    readonly assetFilesInvalid: number;
    readonly scriptRegistryEntries: number;
    readonly extractedOutputPresent: boolean;
  };
}

export interface ProfileValidationCompletion {
  readonly launchable: boolean;
  readonly materializedReferenceComplete: boolean;
  readonly sourceExtractionComplete: boolean;
  readonly fidelityComplete: boolean;
}

export interface ProfileCompilerDiagnostics {
  readonly soundInventory: SoundInventoryDiagnostics;
  readonly unsupportedBitmapRecords: {
    readonly total: number;
    readonly byFile: UnsupportedBitmapFileSummary[];
    readonly byReason: UnsupportedBitmapReasonSummary[];
  };
  readonly visualLayoutClosure: {
    readonly totalLayouts: number;
    readonly partialLayouts: number;
    readonly exteriorPartialLayouts: number;
    readonly unresolvedReferenceCount: number;
    readonly gaps: VisualLayoutGap[];
  };
}

export interface SoundInventoryDiagnostics {
  readonly declared: number;
  readonly extracted: number;
  readonly unsupported: number;
  readonly accounted: number;
  readonly missing: number;
  readonly extra: number;
  readonly duplicate: number;
  readonly invalidMetadata: number;
  readonly byContainer: NamedCountSummary[];
  readonly byCodec: NamedCountSummary[];
  readonly bySourceFourCC: NamedCountSummary[];
  readonly unsupportedByReason: UnsupportedBitmapReasonSummary[];
  readonly samples: string[];
}

export interface NamedCountSummary {
  readonly name: string;
  readonly count: number;
}

export interface UnsupportedBitmapFileSummary {
  readonly file: string;
  readonly count: number;
}

export interface UnsupportedBitmapReasonSummary {
  readonly reason: string;
  readonly count: number;
  readonly samples: string[];
}

export interface VisualLayoutGap {
  readonly visualName: string;
  readonly memberName?: string;
  readonly castName?: string;
  readonly bitmapElementCount: number;
  readonly materializedAssetCount: number;
  readonly indexedBitmapReferenceCount: number;
  readonly unresolvedReferences: string[];
  readonly missingBitmapReferences: VisualBitmapReferenceDiagnostic[];
}

export interface VisualBitmapReferenceDiagnostic {
  readonly castName: string;
  readonly member: number;
  readonly memberChunkId?: number;
  readonly memberName: string;
  readonly bitDepth?: number;
  readonly bitdExists?: boolean;
  readonly bitdBytes?: number;
  readonly paletteId?: number;
  readonly reason: string;
  readonly sourceRecovery?: VisualBitmapSourceRecoveryDiagnostic;
}

export interface VisualBitmapSourceRecoveryDiagnostic {
  readonly kind: string;
  readonly sectionID?: number;
  readonly candidateCount?: number;
  readonly candidateSectionIds?: number[];
}

export interface ProfileValidationOptions {
  readonly versionId: string;
  readonly runtimeDataRoot: string;
  readonly assetsRoot?: string;
  readonly scriptsRoot?: string;
  readonly extractedRoot?: string;
  readonly runtimeDataSchemaVersion?: number;
  readonly validateAssetContents?: boolean;
  readonly generatedAssetStats?: {
    readonly referenced: number;
    readonly ready: number;
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

interface RuntimeDataRelease {
  readonly assets?: Record<string, unknown>[];
  readonly sourceEmpty?: Record<string, unknown>[];
  readonly unsupported?: Record<string, unknown>[];
  readonly visuals?: Record<string, unknown>[];
  readonly casts?: Record<string, unknown>[];
}

interface AssetStats {
  readonly referenceCount: number;
  readonly ready: number;
  readonly missing: string[];
  readonly invalid: string[];
}

const ISSUE_SAMPLE_LIMIT = 20;

export function validateProfileContract(options: ProfileValidationOptions): ProfileValidationReport {
  const issues: ProfileValidationIssue[] = [];
  const checks: ProfileValidationCheck[] = [];
  const requiredRuntimeFiles = runtimeFilePresence(options.runtimeDataRoot, requiredRuntimeDataFiles(options.versionId));
  const optionalRuntimeFiles = runtimeFilePresence(options.runtimeDataRoot, optionalRuntimeDataFiles(options.versionId));

  const missingRequired = Object.entries(requiredRuntimeFiles)
    .filter(([, present]) => !present)
    .map(([file]) => file);
  addCheck(checks, issues, {
    name: "runtime-data-files",
    state: missingRequired.length === 0 ? "pass" : "fail",
    summary:
      missingRequired.length === 0
        ? "All required runtime-data files are present."
        : `Missing ${missingRequired.length} required runtime-data file(s).`,
    counts: { required: Object.keys(requiredRuntimeFiles).length, missing: missingRequired.length },
    samples: missingRequired,
    issue: {
      severity: "error",
      code: "missing-runtime-data",
      message: "The profile compiler did not produce every required runtime-data file.",
      sample: missingRequired,
      count: missingRequired.length,
    },
  });

  const schemaMatches = options.runtimeDataSchemaVersion === PROFILE_RUNTIME_DATA_SCHEMA_VERSION;
  addCheck(checks, issues, {
    name: "runtime-data-schema",
    state: schemaMatches ? "pass" : "fail",
    summary: schemaMatches
      ? `Runtime-data schema v${PROFILE_RUNTIME_DATA_SCHEMA_VERSION} is current.`
      : `Runtime-data schema is not v${PROFILE_RUNTIME_DATA_SCHEMA_VERSION}.`,
    counts: { expected: PROFILE_RUNTIME_DATA_SCHEMA_VERSION, actual: Number(options.runtimeDataSchemaVersion ?? 0) },
    issue: {
      severity: "error",
      code: "runtime-data-schema",
      message: "Re-import the compiled client so the profile is generated with the current runtime-data schema.",
    },
  });

  const extractionPresent = options.extractedRoot ? hasExtractedProjectorRaysOutput(options.extractedRoot) : false;
  addCheck(checks, issues, {
    name: "projectorrays-output",
    state: extractionPresent ? "pass" : "fail",
    summary: extractionPresent ? "ProjectorRays extraction output is present." : "ProjectorRays extraction output is missing.",
    issue: {
      severity: "error",
      code: "missing-projectorrays-output",
      message: "The profile has no usable extracted Director source/chunk data.",
    },
  });

  const scriptRegistry = readScriptRegistry(options.scriptsRoot);
  addCheck(checks, issues, {
    name: "profile-script-registry",
    state: scriptRegistry.present && scriptRegistry.count > 0 ? "pass" : "fail",
    summary:
      scriptRegistry.present && scriptRegistry.count > 0
        ? `Profile script registry has ${scriptRegistry.count.toLocaleString()} script member(s).`
        : "Profile script registry is missing or empty.",
    counts: { scripts: scriptRegistry.count },
    issue: {
      severity: "error",
      code: "missing-profile-script-registry",
      message: "The profile compiler must index every imported Lingo script member.",
    },
  });

  const assetStats = options.generatedAssetStats
    ? {
        referenceCount: options.generatedAssetStats.referenced,
        ready: options.generatedAssetStats.ready,
        missing: [...options.generatedAssetStats.missing],
        invalid: [...options.generatedAssetStats.invalid],
      }
    : collectProfileAssetStats(options.runtimeDataRoot, options.versionId, options.assetsRoot, options.validateAssetContents !== false);
  addCheck(checks, issues, {
    name: "materialized-assets",
    state: assetStats.missing.length === 0 && assetStats.invalid.length === 0 && assetStats.referenceCount > 0 ? "pass" : "fail",
    summary:
      assetStats.referenceCount === 0
        ? "No media asset references were found."
        : `${assetStats.ready.toLocaleString()} / ${assetStats.referenceCount.toLocaleString()} referenced media asset file(s) are ready.`,
    counts: {
      referenced: assetStats.referenceCount,
      ready: assetStats.ready,
      missing: assetStats.missing.length,
      invalid: assetStats.invalid.length,
    },
    samples: [...assetStats.missing, ...assetStats.invalid].slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "error",
      code: "materialized-assets",
      message: "Referenced bitmap and sound media files must exist and match their declared media type before the profile can launch.",
      count: assetStats.missing.length + assetStats.invalid.length,
      sample: [...assetStats.missing, ...assetStats.invalid].slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });

  const bitmapChecks = validateBitmapIndexes(options.runtimeDataRoot, options.versionId);
  for (const check of bitmapChecks.checks) checks.push(check);
  issues.push(...bitmapChecks.issues);

  const castRangeChecks = validateExternalCastRanges(options.runtimeDataRoot, options.versionId);
  for (const check of castRangeChecks.checks) checks.push(check);
  issues.push(...castRangeChecks.issues);

  const visualChecks = validateVisualLayoutClosure(options.runtimeDataRoot, options.versionId);
  for (const check of visualChecks.checks) checks.push(check);
  issues.push(...visualChecks.issues);

  const diagnostics = buildCompilerDiagnostics(options.runtimeDataRoot, options.versionId, options.extractedRoot);
  addSoundInventoryCheck(checks, issues, diagnostics.soundInventory);
  addRecoverableVisualSourceCheck(checks, issues, diagnostics);
  const errors = issues.filter((issue) => issue.severity === "error");
  const completion = profileValidationCompletion(checks, errors.length === 0);
  return {
    schemaVersion: PROFILE_RUNTIME_DATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    versionId: options.versionId,
    ready: completion.launchable,
    completion,
    issues,
    checks,
    diagnostics,
    inventory: {
      requiredRuntimeFiles,
      optionalRuntimeFiles,
      assetReferences: assetStats.referenceCount,
      assetFilesReady: assetStats.ready,
      assetFilesMissing: assetStats.missing.length,
      assetFilesInvalid: assetStats.invalid.length,
      scriptRegistryEntries: scriptRegistry.count,
      extractedOutputPresent: extractionPresent,
    },
  };
}

function addSoundInventoryCheck(
  checks: ProfileValidationCheck[],
  issues: ProfileValidationIssue[],
  inventory: SoundInventoryDiagnostics,
): void {
  const failureCount =
    inventory.unsupported + inventory.missing + inventory.extra + inventory.duplicate + inventory.invalidMetadata;
  const complete = failureCount === 0 && inventory.accounted === inventory.declared;
  addCheck(checks, issues, {
    name: "director-sound-inventory",
    state: complete ? "pass" : "fail",
    summary: complete
      ? `All ${inventory.declared.toLocaleString()} declared Director sound member(s) have valid extracted media.`
      : `${inventory.extracted.toLocaleString()} of ${inventory.declared.toLocaleString()} declared Director sound member(s) are playable; ${failureCount.toLocaleString()} inventory defect(s) remain.`,
    counts: {
      declared: inventory.declared,
      extracted: inventory.extracted,
      unsupported: inventory.unsupported,
      missing: inventory.missing,
      extra: inventory.extra,
      duplicate: inventory.duplicate,
      invalidMetadata: inventory.invalidMetadata,
    },
    samples: inventory.samples,
    issue: {
      severity: "error",
      code: "director-sound-inventory",
      message: "Every declared Director sound member must resolve to one valid extracted media record before launch.",
      count: failureCount,
      sample: inventory.samples,
    },
  });
}

function addRecoverableVisualSourceCheck(
  checks: ProfileValidationCheck[],
  issues: ProfileValidationIssue[],
  diagnostics: ProfileCompilerDiagnostics,
): void {
  const recoverable = diagnostics.visualLayoutClosure.gaps.flatMap((gap) =>
    gap.missingBitmapReferences
      .filter((reference) => typeof reference.sourceRecovery?.sectionID === "number")
      .map((reference) => `${gap.visualName}: ${reference.castName}#${reference.member} ${reference.memberName} -> BITD-${reference.sourceRecovery?.sectionID}`),
  );
  const ambiguous = diagnostics.visualLayoutClosure.gaps.flatMap((gap) =>
    gap.missingBitmapReferences
      .filter((reference) => reference.sourceRecovery && typeof reference.sourceRecovery.sectionID !== "number")
      .map((reference) => `${gap.visualName}: ${reference.castName}#${reference.member} ${reference.memberName} (${reference.sourceRecovery?.kind})`),
  );
  addCheck(checks, issues, {
    name: "visual-layout-source-recovery",
    state: recoverable.length === 0 && ambiguous.length === 0 ? "pass" : "warning",
    summary:
      recoverable.length === 0 && ambiguous.length === 0
        ? "No missing visual layout bitmap references have recoverable source BITD candidates."
        : `${recoverable.length} missing visual bitmap reference(s) have direct source BITD recovery; ${ambiguous.length} have ambiguous source candidates.`,
    counts: {
      directRecoverable: recoverable.length,
      ambiguousCandidates: ambiguous.length,
    },
    samples: [...recoverable, ...ambiguous].slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "warning",
      code: "recoverable-visual-layout-assets",
      message: "Some missing visual layout assets are recoverable from extracted Director chunks; regenerate or rerun the visual asset materializer instead of patching rendering.",
      count: recoverable.length + ambiguous.length,
      sample: [...recoverable, ...ambiguous].slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });
}

export function summarizeProfileValidation(report: ProfileValidationReport): ProfileValidationSummary {
  return {
    ready: report.ready,
    launchable: report.completion.launchable,
    materializedReferenceComplete: report.completion.materializedReferenceComplete,
    sourceExtractionComplete: report.completion.sourceExtractionComplete,
    fidelityComplete: report.completion.fidelityComplete,
    errorCount: report.issues.filter((issue) => issue.severity === "error").length,
    warningCount: report.issues.filter((issue) => issue.severity === "warning").length,
    checkCount: report.checks.length,
  };
}

function validateBitmapIndexes(runtimeDataRoot: string, versionId: string): { checks: ProfileValidationCheck[]; issues: ProfileValidationIssue[] } {
  const checks: ProfileValidationCheck[] = [];
  const issues: ProfileValidationIssue[] = [];
  const assets = [
    ...bitmapAssetsFromFile(join(runtimeDataRoot, `external-bitmap-assets.${versionId}.json`)),
    ...bitmapAssetsFromFile(join(runtimeDataRoot, `visual-bitmap-assets.${versionId}.json`)),
    ...bitmapAssetsFromFile(join(runtimeDataRoot, `button-bitmap-assets.${versionId}.json`)),
  ];
  const missingRegPoint = assets.filter((asset) => !hasPoint(asset.regPoint));
  const missingInitialRect = assets.filter((asset) => !hasRect(asset.initialRect));
  const indexed = assets.filter(isMaterializedIndexedBitmap);
  const sourcePlaceholderBitmaps = assets.filter(
    (asset) => isIndexedBitDepth(bitmapBitDepth(asset)) && !hasPositiveBitmapGeometry(asset),
  );
  const indexedMissingPalette = indexed.filter((asset) => !hasIndexedPaletteData(asset));
  const externalIndexed = bitmapAssetsFromFile(join(runtimeDataRoot, `external-bitmap-assets.${versionId}.json`))
    .filter(isMaterializedIndexedBitmap);
  const externalMissingPaletteProvenance = externalIndexed.filter((asset) => !hasPaletteProvenance(asset));
  const externalGraphRelease = readRuntimeRelease(join(runtimeDataRoot, `external-cast-graph.${versionId}.json`));
  const externalBitmapRelease = readRuntimeRelease(join(runtimeDataRoot, `external-bitmap-assets.${versionId}.json`));
  const expectedExternalBitmapMembers = Array.isArray(externalGraphRelease?.casts)
    ? externalGraphRelease.casts
        .filter((cast) => cast.resolved !== false)
        .flatMap((cast) => Array.isArray(cast.members) ? cast.members : [])
        .filter((member) => member.type === "bitmap").length
    : 0;
  const externalAssets = Array.isArray(externalBitmapRelease?.assets) ? externalBitmapRelease.assets.length : 0;
  const externalSourceEmpty = Array.isArray(externalBitmapRelease?.sourceEmpty) ? externalBitmapRelease.sourceEmpty.length : 0;
  const externalUnsupported = Array.isArray(externalBitmapRelease?.unsupported) ? externalBitmapRelease.unsupported.length : 0;
  const accountedExternalBitmapMembers = externalAssets + externalSourceEmpty + externalUnsupported;

  addCheck(checks, issues, {
    name: "external-bitmap-member-closure",
    state: expectedExternalBitmapMembers === accountedExternalBitmapMembers ? "pass" : "fail",
    summary:
      expectedExternalBitmapMembers === accountedExternalBitmapMembers
        ? `All ${expectedExternalBitmapMembers.toLocaleString()} live external bitmap members are materialized or explicitly source-authored empty.`
        : `${Math.abs(expectedExternalBitmapMembers - accountedExternalBitmapMembers)} external bitmap member(s) are missing from extractor accounting.`,
    counts: {
      expected: expectedExternalBitmapMembers,
      materialized: externalAssets,
      sourceAuthoredEmpty: externalSourceEmpty,
      unsupported: externalUnsupported,
      accounted: accountedExternalBitmapMembers,
    },
    samples: [],
    issue: {
      severity: "error",
      code: "external-bitmap-member-closure",
      message: "Every live external bitmap member must be materialized or explicitly identified as source-authored empty.",
      count: Math.abs(expectedExternalBitmapMembers - accountedExternalBitmapMembers),
      sample: [],
    },
  });

  addCheck(checks, issues, {
    name: "bitmap-director-metadata",
    state: missingRegPoint.length === 0 && missingInitialRect.length === 0 ? "pass" : "fail",
    summary:
      missingRegPoint.length === 0 && missingInitialRect.length === 0
        ? `All ${assets.length.toLocaleString()} bitmap records carry Director registration metadata.`
        : `${missingRegPoint.length} bitmap(s) lack regPoint and ${missingInitialRect.length} lack initialRect.`,
    counts: { assets: assets.length, missingRegPoint: missingRegPoint.length, missingInitialRect: missingInitialRect.length },
    samples: assetSamples([...missingRegPoint, ...missingInitialRect]),
    issue: {
      severity: "error",
      code: "bitmap-director-metadata",
      message: "Bitmap records must preserve Director regPoint and initialRect metadata.",
      count: missingRegPoint.length + missingInitialRect.length,
      sample: assetSamples([...missingRegPoint, ...missingInitialRect]),
    },
  });

  addCheck(checks, issues, {
    name: "indexed-bitmap-palette-provenance",
    state: externalMissingPaletteProvenance.length === 0 ? "pass" : "fail",
    summary:
      externalMissingPaletteProvenance.length === 0
        ? `All ${externalIndexed.length.toLocaleString()} external indexed bitmap records preserve their raw Director palette reference and resolution path.`
        : `${externalMissingPaletteProvenance.length} external indexed bitmap(s) lack exact palette provenance.`,
    counts: { indexed: externalIndexed.length, missingProvenance: externalMissingPaletteProvenance.length },
    samples: assetSamples(externalMissingPaletteProvenance),
    issue: {
      severity: "error",
      code: "indexed-bitmap-palette-provenance",
      message: "Re-import the client so every indexed bitmap records its raw CASt palette reference and exact Director resolution path.",
      count: externalMissingPaletteProvenance.length,
      sample: assetSamples(externalMissingPaletteProvenance),
    },
  });

  addCheck(checks, issues, {
    name: "indexed-bitmap-palettes",
    state: indexedMissingPalette.length === 0 ? "pass" : "warning",
    summary:
      indexedMissingPalette.length === 0
        ? `All ${indexed.length.toLocaleString()} indexed bitmap records carry palette data.`
        : `${indexedMissingPalette.length} indexed bitmap(s) lack paletteIndexData or paletteColors.`,
    counts: {
      indexed: indexed.length,
      missingPalette: indexedMissingPalette.length,
      sourcePlaceholderBitmaps: sourcePlaceholderBitmaps.length,
    },
    samples: assetSamples(indexedMissingPalette),
    issue: {
      severity: "warning",
      code: "indexed-bitmap-palettes",
      message: "Indexed bitmap records should preserve palette indices and palette colours for Director-perfect recolour and ink behavior.",
      count: indexedMissingPalette.length,
      sample: assetSamples(indexedMissingPalette),
    },
  });

  const unsupportedByFile = unsupportedEntries(runtimeDataRoot, versionId);
  const unsupportedTotal = unsupportedByFile.reduce((sum, entry) => sum + entry.entries.length, 0);
  addCheck(checks, issues, {
    name: "extractor-unsupported-bitmap-records",
    state: unsupportedTotal === 0 ? "pass" : "fail",
    summary:
      unsupportedTotal === 0
        ? "Bitmap extractors did not report unsupported records."
        : `Bitmap extractors reported ${unsupportedTotal.toLocaleString()} unsupported record(s).`,
    counts: Object.fromEntries(unsupportedByFile.map((entry) => [entry.file, entry.entries.length])),
    samples: unsupportedByFile.flatMap((entry) => entry.entries.map((item) => `${entry.file}: ${unsupportedLabel(item)}`)).slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "error",
      code: "extractor-unsupported-bitmap-records",
      message: "Unsupported extractor records are not room patches, but they should be resolved from source metadata for full layout coverage.",
      count: unsupportedTotal,
      sample: unsupportedByFile.flatMap((entry) => entry.entries.map((item) => `${entry.file}: ${unsupportedLabel(item)}`)).slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });

  return { checks, issues };
}

function validateExternalCastRanges(runtimeDataRoot: string, versionId: string): { checks: ProfileValidationCheck[]; issues: ProfileValidationIssue[] } {
  const checks: ProfileValidationCheck[] = [];
  const issues: ProfileValidationIssue[] = [];
  const release = readRuntimeRelease(join(runtimeDataRoot, `external-cast-graph.${versionId}.json`));
  const casts = Array.isArray(release?.casts) ? release.casts.filter((cast) => cast.resolved !== false) : [];
  const missingRange = casts.filter(
    (cast) => !Number.isInteger(Number(cast.minMember)) || !Number.isInteger(Number(cast.maxMember)),
  );
  const outOfRange = casts.flatMap((cast) => {
    const min = Number(cast.minMember);
    const max = Number(cast.maxMember);
    if (!Number.isInteger(min) || !Number.isInteger(max)) return [];
    const members = Array.isArray(cast.members) ? cast.members : [];
    return members
      .filter((member) => Number(member.number) < min || Number(member.number) > max)
      .map((member) => `${String(cast.name ?? "cast")}#${String(member.number ?? "?")} outside ${min}..${max}`);
  });
  const failed = missingRange.length + outOfRange.length;
  addCheck(checks, issues, {
    name: "director-cast-member-ranges",
    state: failed === 0 ? "pass" : "fail",
    summary:
      failed === 0
        ? `All ${casts.length.toLocaleString()} resolved external casts use their extracted DRCF member ranges.`
        : `${missingRange.length} cast(s) lack DRCF ranges and ${outOfRange.length} member(s) fall outside their authored range.`,
    counts: { casts: casts.length, missingRange: missingRange.length, outOfRange: outOfRange.length },
    samples: [
      ...missingRange.map((cast) => `${String(cast.name ?? "cast")}: missing minMember/maxMember`),
      ...outOfRange,
    ].slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "error",
      code: "director-cast-member-ranges",
      message: "External cast member numbers must be derived from DRCF minMember, not raw CAS array indexes.",
      count: failed,
      sample: [
        ...missingRange.map((cast) => `${String(cast.name ?? "cast")}: missing minMember/maxMember`),
        ...outOfRange,
      ].slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });
  return { checks, issues };
}

function buildCompilerDiagnostics(
  runtimeDataRoot: string,
  versionId: string,
  extractedRoot: string | undefined,
): ProfileCompilerDiagnostics {
  const unsupportedByFile = unsupportedEntries(runtimeDataRoot, versionId);
  const unsupportedReasonMap = new Map<string, { count: number; samples: string[] }>();
  for (const fileEntry of unsupportedByFile) {
    for (const entry of fileEntry.entries) {
      const reason = String(entry.reason ?? "unsupported");
      const existing = unsupportedReasonMap.get(reason) ?? { count: 0, samples: [] };
      existing.count += 1;
      if (existing.samples.length < ISSUE_SAMPLE_LIMIT) {
        existing.samples.push(`${fileEntry.file}: ${unsupportedLabel(entry)}`);
      }
      unsupportedReasonMap.set(reason, existing);
    }
  }

  const visualLayoutClosure = buildVisualLayoutClosureDiagnostics(runtimeDataRoot, versionId, extractedRoot);
  return {
    soundInventory: buildSoundInventoryDiagnostics(runtimeDataRoot, versionId),
    unsupportedBitmapRecords: {
      total: unsupportedByFile.reduce((sum, entry) => sum + entry.entries.length, 0),
      byFile: unsupportedByFile.map((entry) => ({ file: entry.file, count: entry.entries.length })),
      byReason: [...unsupportedReasonMap.entries()]
        .map(([reason, value]) => ({ reason, count: value.count, samples: value.samples }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    },
    visualLayoutClosure,
  };
}

function buildSoundInventoryDiagnostics(runtimeDataRoot: string, versionId: string): SoundInventoryDiagnostics {
  const manifest = readJsonObject(join(runtimeDataRoot, `${versionId}-projectorrays-manifest.json`));
  const externalGraphRelease = readRuntimeRelease(join(runtimeDataRoot, `external-cast-graph.${versionId}.json`));
  const index = readJsonObject(join(runtimeDataRoot, `sound-assets.${versionId}.json`));
  const manifestRelease = firstReleaseObject(manifest);
  const casts = arrayOfObjects(manifestRelease?.casts);
  const declaredIds: string[] = [];
  const movieMemberKeys = new Set<string>();
  for (const cast of casts) {
    const castNumber = Number(cast.number);
    const castName = String(cast.name ?? `cast-${castNumber}`);
    for (const member of arrayOfObjects(cast.members)) {
      if (member.type !== "sound") continue;
      declaredIds.push(`${versionId}:${castNumber}:${Number(member.number)}`);
      movieMemberKeys.add(soundLedgerMemberKey(castName, Number(member.number)));
    }
  }
  for (const cast of arrayOfObjects(externalGraphRelease?.casts)) {
    const castOrder = Number(cast.order);
    const castName = String(cast.name ?? `external-cast-${castOrder}`);
    for (const member of arrayOfObjects(cast.members)) {
      if (member.type !== "sound") continue;
      if (movieMemberKeys.has(soundLedgerMemberKey(castName, Number(member.number)))) continue;
      declaredIds.push(
        `${versionId}:external:${castOrder}:${soundLedgerSafeName(castName)}:${Number(member.number)}`,
      );
    }
  }

  const sounds = arrayOfObjects(index?.sounds);
  const unsupported = arrayOfObjects(index?.unsupported);
  const ledger = [...sounds, ...unsupported];
  const countsById = countStrings(ledger.map((entry) => String(entry.id ?? "")));
  const declared = new Set(declaredIds);
  const missing = declaredIds.filter((id) => (countsById.get(id) ?? 0) === 0);
  const extra = [...countsById.keys()].filter((id) => id.length === 0 || !declared.has(id));
  const duplicate = [...countsById.entries()].filter(([, count]) => count > 1);
  const invalid = sounds.filter((record) => !validSoundRecord(record));
  const unsupportedReasons = summarizeReasons(unsupported);
  const samples = [
    ...unsupported.slice(0, ISSUE_SAMPLE_LIMIT).map((entry) => `unsupported ${soundLedgerLabel(entry)}: ${String(entry.reason ?? entry.code ?? "unknown")}`),
    ...missing.slice(0, ISSUE_SAMPLE_LIMIT).map((id) => `missing ${id}`),
    ...extra.slice(0, ISSUE_SAMPLE_LIMIT).map((id) => `extra ${id || "<missing id>"}`),
    ...duplicate.slice(0, ISSUE_SAMPLE_LIMIT).map(([id, count]) => `duplicate ${id || "<missing id>"} x${count}`),
    ...invalid.slice(0, ISSUE_SAMPLE_LIMIT).map((entry) => `invalid metadata ${soundLedgerLabel(entry)}`),
  ].slice(0, ISSUE_SAMPLE_LIMIT);

  return {
    declared: declaredIds.length,
    extracted: sounds.length,
    unsupported: unsupported.length,
    accounted: ledger.length,
    missing: missing.length,
    extra: extra.length,
    duplicate: duplicate.length,
    invalidMetadata: invalid.length,
    byContainer: summarizeNamedCounts(sounds, "container"),
    byCodec: summarizeNamedCounts(sounds, "codec"),
    bySourceFourCC: summarizeNamedCounts(
      sounds.map((entry) => ({ value: objectOf(entry.source)?.fourCC })),
      "value",
    ),
    unsupportedByReason: unsupportedReasons,
    samples,
  };
}

function soundLedgerMemberKey(castName: string, memberNumber: number): string {
  return `${castName.normalize("NFKC").trim().toLowerCase()}:${memberNumber}`;
}

function soundLedgerSafeName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "unnamed";
}

function validSoundRecord(record: Record<string, unknown>): boolean {
  const source = objectOf(record.source);
  return (
    typeof record.id === "string" && record.id.length > 0 &&
    typeof record.castName === "string" &&
    Number.isInteger(Number(record.castOrder)) &&
    Number.isInteger(Number(record.member)) &&
    (record.codec === "mp3" || record.codec === "pcm") &&
    typeof record.container === "string" && record.container.length > 0 &&
    Number(record.sampleRate) > 0 &&
    (Number(record.channels) === 1 || Number(record.channels) === 2) &&
    Number(record.sampleCount) >= 0 &&
    Number(record.durationMs) >= 0 &&
    typeof record.assetPath === "string" && record.assetPath.length > 0 &&
    typeof record.assetSha256 === "string" && /^[a-f0-9]{64}$/.test(record.assetSha256) &&
    typeof source?.fourCC === "string" && (source.fourCC === "ediM" || source.fourCC === "snd ")
  );
}

function summarizeNamedCounts(records: Record<string, unknown>[], key: string): NamedCountSummary[] {
  const counts = countStrings(records.map((record) => String(record[key] ?? "unknown")));
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function summarizeReasons(records: Record<string, unknown>[]): UnsupportedBitmapReasonSummary[] {
  const grouped = new Map<string, { count: number; samples: string[] }>();
  for (const record of records) {
    const reason = String(record.code ?? record.reason ?? "unsupported");
    const value = grouped.get(reason) ?? { count: 0, samples: [] };
    value.count += 1;
    if (value.samples.length < ISSUE_SAMPLE_LIMIT) value.samples.push(soundLedgerLabel(record));
    grouped.set(reason, value);
  }
  return [...grouped.entries()]
    .map(([reason, value]) => ({ reason, count: value.count, samples: value.samples }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function soundLedgerLabel(record: Record<string, unknown>): string {
  return `${String(record.castName ?? "cast")}#${String(record.member ?? "?")} ${String(record.memberName ?? "")}`.trim();
}

function countStrings(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    : [];
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return objectOf(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function firstReleaseObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const releases = value?.releases;
  if (Array.isArray(releases)) return objectOf(releases[0]);
  if (releases && typeof releases === "object") return objectOf(Object.values(releases)[0]);
  return value;
}

function buildVisualLayoutClosureDiagnostics(
  runtimeDataRoot: string,
  versionId: string,
  extractedRoot: string | undefined,
): ProfileCompilerDiagnostics["visualLayoutClosure"] {
  const visualBitmapRelease = readRuntimeRelease(join(runtimeDataRoot, `visual-bitmap-assets.${versionId}.json`));
  const visualLayoutRelease = readRuntimeRelease(join(runtimeDataRoot, `external-cast-visual-layout-index.${versionId}.json`));
  const materializedVisuals = Array.isArray(visualBitmapRelease?.visuals) ? visualBitmapRelease.visuals : [];
  const indexedVisuals = Array.isArray(visualLayoutRelease?.visuals) ? visualLayoutRelease.visuals : [];
  const materializedAssets = Array.isArray(visualBitmapRelease?.assets) ? visualBitmapRelease.assets : [];
  const assetById = new Map(materializedAssets.map((asset) => [String(asset.id ?? ""), asset]));
  const indexedByIdentity = new Map(indexedVisuals.map((visual) => [visualLayoutIdentityKey(visual), visual]));
  const indexedByName = new Map<string, Record<string, unknown>>();
  for (const visual of indexedVisuals) {
    const name = String(visual.visualName ?? visual.memberName ?? "");
    if (name && !indexedByName.has(name)) indexedByName.set(name, visual);
  }
  const gaps: VisualLayoutGap[] = [];
  let unresolvedReferenceCount = 0;

  for (const visual of materializedVisuals) {
    const visualName = String(visual.visualName ?? visual.memberName ?? "");
    const indexed = indexedByIdentity.get(visualLayoutIdentityKey(visual)) ?? indexedByName.get(visualName);
    const unresolvedReferences = visualUnresolvedReferences(indexed);
    unresolvedReferenceCount += unresolvedReferences.length;
    const bitmapElementCount = visualBitmapElementCount(visual);
    const assetIds = Array.isArray(visual.assetIds) ? visual.assetIds.map((value) => String(value)) : [];
    const materializedAssetCount = assetIds.length;
    const missingBitmapReferences =
      materializedAssetCount < bitmapElementCount
        ? missingBitmapReferencesForVisual(indexed, assetIds, assetById, extractedRoot)
        : [];
    if (materializedAssetCount >= bitmapElementCount && unresolvedReferences.length === 0 && missingBitmapReferences.length === 0) continue;
    gaps.push({
      visualName,
      memberName: typeof visual.memberName === "string" ? visual.memberName : undefined,
      castName: indexed && typeof indexed.castName === "string" ? indexed.castName : undefined,
      bitmapElementCount,
      materializedAssetCount,
      indexedBitmapReferenceCount: Array.isArray(indexed?.bitmapReferences) ? indexed.bitmapReferences.length : 0,
      unresolvedReferences,
      missingBitmapReferences,
    });
  }

  return {
    totalLayouts: materializedVisuals.length,
    partialLayouts: gaps.length,
    exteriorPartialLayouts: gaps.filter((gap) => isExteriorVisual(gap.visualName)).length,
    unresolvedReferenceCount,
    gaps: gaps.sort((left, right) => {
      const leftExterior = isExteriorVisual(left.visualName) ? 0 : 1;
      const rightExterior = isExteriorVisual(right.visualName) ? 0 : 1;
      return leftExterior - rightExterior || left.visualName.localeCompare(right.visualName);
    }),
  };
}

function visualLayoutIdentityKey(visual: Record<string, unknown>): string {
  const textChunkPath = typeof visual.textChunkPath === "string" ? visual.textChunkPath : "";
  if (textChunkPath) return `text:${normalizePathKey(textChunkPath)}`;
  const castName = typeof visual.castName === "string" ? visual.castName : "";
  const visualName = String(visual.visualName ?? visual.memberName ?? "");
  return `name:${normalizePathKey(castName)}:${normalizePathKey(visualName)}`;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}

function missingBitmapReferencesForVisual(
  indexed: Record<string, unknown> | undefined,
  assetIds: string[],
  assetById: Map<string, Record<string, unknown>>,
  extractedRoot: string | undefined,
): VisualBitmapReferenceDiagnostic[] {
  if (!indexed || !Array.isArray(indexed.bitmapReferences)) return [];
  const materializedKeys = new Set<string>();
  for (const assetId of assetIds) {
    const asset = assetById.get(assetId);
    if (!asset) continue;
    materializedKeys.add(bitmapReferenceKey(asset));
  }

  const missing = new Map<string, VisualBitmapReferenceDiagnostic>();
  for (const reference of indexed.bitmapReferences) {
    if (!reference || typeof reference !== "object") continue;
    const record = reference as Record<string, unknown>;
    const key = bitmapReferenceKey(record);
    if (materializedKeys.has(key) || missing.has(key)) continue;
    missing.set(key, bitmapReferenceDiagnostic(record, extractedRoot));
  }
  return [...missing.values()];
}

function bitmapReferenceDiagnostic(
  reference: Record<string, unknown>,
  extractedRoot: string | undefined,
): VisualBitmapReferenceDiagnostic {
  const bitmap = reference.bitmap && typeof reference.bitmap === "object" ? (reference.bitmap as Record<string, unknown>) : undefined;
  const bitDepth = bitmapNumber(bitmap?.bitDepth);
  const bitdBytes = bitmapNumber(bitmap?.bitdBytes);
  const bitdExists = typeof bitmap?.bitdExists === "boolean" ? bitmap.bitdExists : undefined;
  const paletteId = bitmapNumber(bitmap?.paletteId);
  const sourceRecovery = probeRecoverableBitdSource(extractedRoot, reference, bitmap);
  const reason = sourceRecovery
    ? `recoverable-bitd:${sourceRecovery.kind}`
    : missingBitmapReason({ bitDepth, bitdExists, bitdBytes, paletteId });
  return {
    castName: String(reference.castName ?? "cast"),
    member: Number(reference.member ?? 0),
    memberChunkId: bitmapNumber(reference.memberChunkId),
    memberName: String(reference.memberName ?? "member"),
    bitDepth,
    bitdExists,
    bitdBytes,
    paletteId,
    reason,
    ...(sourceRecovery ? { sourceRecovery } : {}),
  };
}

function missingBitmapReason(input: {
  readonly bitDepth?: number;
  readonly bitdExists?: boolean;
  readonly bitdBytes?: number;
  readonly paletteId?: number;
}): string {
  if (input.bitdExists === false || input.bitdBytes === 0) return "missing-bitd";
  if (input.bitDepth !== undefined && input.bitDepth > 8) return `unsupported-bit-depth-${input.bitDepth}`;
  if (input.paletteId !== undefined && input.paletteId < -3) return `unresolved-palette-${input.paletteId}`;
  return "not-materialized";
}

function probeRecoverableBitdSource(
  extractedRoot: string | undefined,
  reference: Record<string, unknown>,
  bitmap: Record<string, unknown> | undefined,
): VisualBitmapSourceRecoveryDiagnostic | undefined {
  const castName = typeof reference.castName === "string" ? reference.castName : undefined;
  const memberChunkId = bitmapNumber(reference.memberChunkId);
  if (!extractedRoot || !castName || memberChunkId === undefined || !bitmap) return undefined;

  const chunksRoot = join(extractedRoot, castName, "chunks");
  if (!existsSync(chunksRoot)) return undefined;
  const keyEntries = readDirectorKeyEntries(chunksRoot);
  const keyed = keyEntries.find((entry) => entry.castID === memberChunkId && entry.fourCC === "BITD");
  if (keyed && existsSync(join(chunksRoot, `BITD-${keyed.sectionID}.bin`))) {
    return { kind: "key", sectionID: keyed.sectionID, candidateCount: 1, candidateSectionIds: [keyed.sectionID] };
  }

  const expectedBytes = expectedBitmapSourceBytes(bitmap);
  if (expectedBytes <= 0) return undefined;
  const claimedSectionIds = new Set(keyEntries.filter((entry) => entry.fourCC === "BITD").map((entry) => entry.sectionID));
  const candidates = bitdEntries(chunksRoot)
    .filter((entry) => !claimedSectionIds.has(entry.sectionID))
    .filter((entry) => entry.rawBytes === expectedBytes || (entry.rawBytes < expectedBytes && entry.packBitsValid && entry.packBitsBytes === expectedBytes));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!candidate) return undefined;
    return {
      kind: candidate.rawBytes === expectedBytes ? "orphan-raw-exact-length" : "orphan-packbits-exact-length",
      sectionID: candidate.sectionID,
      candidateCount: 1,
      candidateSectionIds: [candidate.sectionID],
    };
  }

  const casOrdered = casOrderedBitdCandidate(chunksRoot, memberChunkId, expectedBytes, candidates, claimedSectionIds);
  if (casOrdered) {
    return {
      kind: casOrdered.rawBytes === expectedBytes ? "orphan-cas-order-raw-exact-length" : "orphan-cas-order-packbits-exact-length",
      sectionID: casOrdered.sectionID,
      candidateCount: candidates.length,
      candidateSectionIds: candidates.map((entry) => entry.sectionID),
    };
  }

  return {
    kind: "orphan-ambiguous",
    candidateCount: candidates.length,
    candidateSectionIds: candidates.map((entry) => entry.sectionID),
  };
}

function expectedBitmapSourceBytes(bitmap: Record<string, unknown>): number {
  const width = Math.max(0, Number(bitmap.width) || 0);
  const height = Math.max(0, Number(bitmap.height) || 0);
  const bitDepth = Math.max(0, Number(bitmap.bitDepth) || 0);
  const pitch = Math.max(0, Number(bitmap.pitch) || Math.ceil((width * bitDepth) / 8));
  return pitch * height;
}

function readDirectorKeyEntries(chunksRoot: string): Array<{ sectionID: number; castID: number; fourCC: string }> {
  const entries: Array<{ sectionID: number; castID: number; fourCC: string }> = [];
  for (const fileName of readdirSync(chunksRoot).filter((entry) => /^KEY_.*\.bin$/i.test(entry)).sort()) {
    const bytes = readFileSync(join(chunksRoot, fileName));
    for (let offset = 12; offset + 12 <= bytes.length; offset += 12) {
      const sectionID = bytes.readUInt32BE(offset);
      const castID = bytes.readUInt32BE(offset + 4);
      const fourCC = bytes.subarray(offset + 8, offset + 12).toString("latin1");
      if (sectionID === 0 && castID === 0) continue;
      entries.push({ sectionID, castID, fourCC });
    }
  }
  return entries;
}

function bitdEntries(chunksRoot: string): Array<{
  sectionID: number;
  rawBytes: number;
  packBitsBytes: number;
  packBitsValid: boolean;
}> {
  return readdirSync(chunksRoot)
    .filter((entry) => /^BITD-\d+\.bin$/i.test(entry))
    .sort(numericChunkSort)
    .map((fileName) => {
      const sectionID = Number(fileName.match(/^BITD-(\d+)\.bin$/i)?.[1] ?? 0);
      const source = readFileSync(join(chunksRoot, fileName));
      const packBits = packBitsDecodedLength(source);
      return { sectionID, rawBytes: source.length, packBitsBytes: packBits.decodedBytes, packBitsValid: packBits.valid };
    });
}

function casOrderedBitdCandidate(
  chunksRoot: string,
  memberChunkId: number,
  expectedBytes: number,
  candidates: Array<{ sectionID: number; rawBytes: number; packBitsBytes: number; packBitsValid: boolean }>,
  claimedSectionIds: Set<number>,
): { sectionID: number; rawBytes: number } | undefined {
  const clusters = sameSizedCandidateClusters(candidates);
  for (const registry of readCastRegistries(chunksRoot)) {
    const sameSizedMembers = sameSizedUnkeyedBitmapMembers(chunksRoot, registry, expectedBytes, claimedSectionIds);
    const memberIndex = sameSizedMembers.indexOf(memberChunkId);
    if (memberIndex < 0) continue;
    const exactCluster = clusters.find((cluster) => cluster.length === sameSizedMembers.length);
    const rankedCandidates = exactCluster;
    if (!rankedCandidates || memberIndex >= rankedCandidates.length) continue;
    return rankedCandidates[memberIndex];
  }
  return undefined;
}

function sameSizedCandidateClusters<T extends { sectionID: number }>(candidates: T[]): T[][] {
  const sorted = [...candidates].sort(compareSectionId);
  const clusters: T[][] = [];
  let current: T[] = [];
  for (const candidate of sorted) {
    const previous = current[current.length - 1];
    if (previous && candidate.sectionID - previous.sectionID >= 64) {
      clusters.push(current);
      current = [];
    }
    current.push(candidate);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function sameSizedUnkeyedBitmapMembers(
  chunksRoot: string,
  registry: { memberIDs?: number[] },
  expectedBytes: number,
  claimedSectionIds: Set<number>,
): number[] {
  const keyedCastIds = new Set(
    readDirectorKeyEntries(chunksRoot)
      .filter((entry) => entry.fourCC === "BITD" && claimedSectionIds.has(entry.sectionID))
      .map((entry) => entry.castID),
  );
  const members: number[] = [];
  for (const memberChunkId of registry.memberIDs ?? []) {
    if (!memberChunkId || keyedCastIds.has(memberChunkId)) continue;
    const bitmap = readCastBitmapMetadata(chunksRoot, memberChunkId);
    if (!bitmap) continue;
    if (expectedBitmapSourceBytes(bitmap) !== expectedBytes) continue;
    members.push(memberChunkId);
  }
  return members;
}

function readCastRegistries(chunksRoot: string): Array<{ memberIDs?: number[] }> {
  return readdirSync(chunksRoot)
    .filter((entry) => /^CAS_.*\.json$/i.test(entry))
    .sort(numericChunkSort)
    .flatMap((fileName) => {
      try {
        const parsed = JSON.parse(readFileSync(join(chunksRoot, fileName), "utf8")) as { memberIDs?: number[] };
        return Array.isArray(parsed.memberIDs) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function readCastBitmapMetadata(chunksRoot: string, memberChunkId: number): Record<string, unknown> | undefined {
  const memberPath = join(chunksRoot, `CASt-${memberChunkId}.bin`);
  if (!existsSync(memberPath)) return undefined;
  const chunk = readFileSync(memberPath);
  if (chunk.length < 12) return undefined;
  const infoLen = chunk.readUInt32BE(4);
  const specificDataLen = chunk.readUInt32BE(8);
  const offset = 12 + infoLen;
  if (chunk.length < offset + specificDataLen || specificDataLen < 10) return undefined;
  const data = chunk.subarray(offset, offset + specificDataLen);
  const rawPitch = data.readUInt16BE(0);
  const top = data.readInt16BE(2);
  const left = data.readInt16BE(4);
  const bottom = data.readInt16BE(6);
  const right = data.readInt16BE(8);
  const hasColorImageFlag = (rawPitch & 0x8000) !== 0;
  return {
    width: right - left,
    height: bottom - top,
    bitDepth: hasColorImageFlag && data.length > 23 ? data.readUInt8(23) : 1,
    pitch: rawPitch & 0x3fff,
  };
}

function packBitsDecodedLength(source: Buffer): { decodedBytes: number; valid: boolean } {
  let sourceOffset = 0;
  let decodedBytes = 0;
  while (sourceOffset < source.length) {
    const control = source[sourceOffset++] ?? 0;
    if (control < 0x80) {
      const count = control + 1;
      if (sourceOffset + count > source.length) return { decodedBytes, valid: false };
      sourceOffset += count;
      decodedBytes += count;
    } else if (control > 0x80) {
      if (sourceOffset >= source.length) return { decodedBytes, valid: false };
      sourceOffset += 1;
      decodedBytes += 257 - control;
    }
  }
  return { decodedBytes, valid: sourceOffset === source.length };
}

function visualUnresolvedReferences(indexed: Record<string, unknown> | undefined): string[] {
  if (!indexed || !Array.isArray(indexed.unresolvedReferences)) return [];
  return indexed.unresolvedReferences.map((ref) =>
    ref && typeof ref === "object"
      ? `${String((ref as Record<string, unknown>).castName ?? "cast")}/${String((ref as Record<string, unknown>).memberName ?? "member")}`
      : String(ref),
  );
}

function bitmapReferenceKey(record: Record<string, unknown>): string {
  return `${String(record.castName ?? "cast").toLowerCase()}:${Number(record.member ?? record.sourceBitmapMember ?? 0)}`;
}

function bitmapNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function compareSectionId(left: { sectionID: number }, right: { sectionID: number }): number {
  return left.sectionID - right.sectionID;
}

function numericChunkSort(left: string, right: string): number {
  const leftId = Number(left.match(/-(\d+)\./)?.[1] ?? 0);
  const rightId = Number(right.match(/-(\d+)\./)?.[1] ?? 0);
  return leftId - rightId || left.localeCompare(right);
}

function validateVisualLayoutClosure(runtimeDataRoot: string, versionId: string): { checks: ProfileValidationCheck[]; issues: ProfileValidationIssue[] } {
  const checks: ProfileValidationCheck[] = [];
  const issues: ProfileValidationIssue[] = [];
  const visualBitmapPath = join(runtimeDataRoot, `visual-bitmap-assets.${versionId}.json`);
  const visualLayoutPath = join(runtimeDataRoot, `external-cast-visual-layout-index.${versionId}.json`);
  const visualBitmapRelease = readRuntimeRelease(visualBitmapPath);
  const visualLayoutRelease = readRuntimeRelease(visualLayoutPath);
  const materializedVisuals = Array.isArray(visualBitmapRelease?.visuals) ? visualBitmapRelease.visuals : [];
  const indexedVisuals = Array.isArray(visualLayoutRelease?.visuals) ? visualLayoutRelease.visuals : [];
  const incomplete = materializedVisuals.filter((visual) => visualBitmapElementCount(visual) > visualAssetCount(visual));
  const unresolved = indexedVisuals.flatMap((visual) => {
    const refs = Array.isArray(visual.unresolvedReferences) ? visual.unresolvedReferences : [];
    return refs.map((ref) => `${String(visual.visualName ?? visual.memberName ?? "visual")}: ${String((ref as Record<string, unknown>)?.memberName ?? "unknown")}`);
  });
  const exteriorIncomplete = incomplete.filter((visual) => isExteriorVisual(String(visual.visualName ?? visual.memberName ?? "")));

  addCheck(checks, issues, {
    name: "visual-layout-closure",
    state: incomplete.length === 0 && unresolved.length === 0 ? "pass" : "warning",
    summary:
      incomplete.length === 0 && unresolved.length === 0
        ? `All ${materializedVisuals.length.toLocaleString()} visual layout records have complete materialized bitmap closures.`
        : `${incomplete.length} visual layout(s) have partial materialized bitmap coverage and ${unresolved.length} unresolved reference(s).`,
    counts: {
      visualLayouts: materializedVisuals.length,
      partialMaterializedClosures: incomplete.length,
      unresolvedReferences: unresolved.length,
      exteriorPartialClosures: exteriorIncomplete.length,
    },
    samples: [
      ...incomplete.map((visual) => `${String(visual.visualName ?? visual.memberName ?? "visual")}: ${visualAssetCount(visual)}/${visualBitmapElementCount(visual)} assets`),
      ...unresolved,
    ].slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "warning",
      code: "visual-layout-closure",
      message: "Some visual layouts reference bitmap members that were not materialized; resolve these through Director source metadata instead of room patches.",
      count: incomplete.length + unresolved.length,
      sample: [
        ...incomplete.map((visual) => `${String(visual.visualName ?? visual.memberName ?? "visual")}: ${visualAssetCount(visual)}/${visualBitmapElementCount(visual)} assets`),
        ...unresolved,
      ].slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });

  addCheck(checks, issues, {
    name: "exterior-visual-layout-coverage",
    state: exteriorIncomplete.length === 0 ? "pass" : "warning",
    summary:
      exteriorIncomplete.length === 0
        ? "Exterior/Horizon visual layouts have complete materialized bitmap closures."
        : `${exteriorIncomplete.length} exterior/Horizon visual layout(s) have partial materialized bitmap closures.`,
    counts: { exteriorPartialClosures: exteriorIncomplete.length },
    samples: exteriorIncomplete
      .map((visual) => `${String(visual.visualName ?? visual.memberName ?? "visual")}: ${visualAssetCount(visual)}/${visualBitmapElementCount(visual)} assets`)
      .slice(0, ISSUE_SAMPLE_LIMIT),
    issue: {
      severity: "warning",
      code: "exterior-visual-layout-coverage",
      message: "Exterior/Horizon coverage is incomplete; the importer should continue recovering the missing assets generically.",
      count: exteriorIncomplete.length,
      sample: exteriorIncomplete
        .map((visual) => `${String(visual.visualName ?? visual.memberName ?? "visual")}: ${visualAssetCount(visual)}/${visualBitmapElementCount(visual)} assets`)
        .slice(0, ISSUE_SAMPLE_LIMIT),
    },
  });

  return { checks, issues };
}

function addCheck(
  checks: ProfileValidationCheck[],
  issues: ProfileValidationIssue[],
  input: ProfileValidationCheck & { readonly issue?: ProfileValidationIssue },
): void {
  const { issue, ...check } = input;
  checks.push(check);
  if (check.state !== "pass" && issue && (issue.count === undefined || issue.count > 0)) {
    issues.push(issue);
  }
}

function runtimeFilePresence(root: string, files: string[]): Record<string, boolean> {
  return Object.fromEntries(files.map((file) => [file, existsSync(join(root, file))]));
}

function readScriptRegistry(scriptsRoot: string | undefined): { present: boolean; count: number } {
  if (!scriptsRoot) return { present: false, count: 0 };
  const registryPath = join(scriptsRoot, "profile-script-registry.json");
  if (!existsSync(registryPath)) return { present: false, count: 0 };
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { scripts?: unknown };
    return { present: true, count: Array.isArray(parsed.scripts) ? parsed.scripts.length : 0 };
  } catch {
    return { present: true, count: 0 };
  }
}

function collectProfileAssetStats(
  runtimeDataRoot: string,
  versionId: string,
  assetsRoot: string | undefined,
  validateAssetContents: boolean,
): AssetStats {
  const references = collectReferencedProfileMedia(runtimeDataRoot, versionId);
  if (!assetsRoot) {
    return { referenceCount: references.length, ready: 0, missing: references.map((reference) => reference.path), invalid: [] };
  }
  let ready = 0;
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const reference of references) {
    const assetPath = reference.path;
    const fullPath = join(assetsRoot, assetPath);
    if (!existsSync(fullPath)) {
      missing.push(assetPath);
      continue;
    }
    if (validateAssetContents && !profileMediaLooksValid(reference, assetsRoot)) {
      invalid.push(assetPath);
      continue;
    }
    ready += 1;
  }
  return { referenceCount: references.length, ready, missing, invalid };
}

function bitmapAssetsFromFile(filePath: string): Record<string, unknown>[] {
  const release = readRuntimeRelease(filePath);
  return Array.isArray(release?.assets) ? release.assets : [];
}

function unsupportedEntries(runtimeDataRoot: string, versionId: string): Array<{ file: string; entries: Record<string, unknown>[] }> {
  return assetIndexFiles(versionId)
    .map((file) => {
      const release = readRuntimeRelease(join(runtimeDataRoot, file));
      return { file, entries: Array.isArray(release?.unsupported) ? release.unsupported : [] };
    })
    .filter((entry) => entry.entries.length > 0);
}

function readRuntimeRelease(filePath: string): RuntimeDataRelease | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { releases?: RuntimeDataRelease[] | Record<string, RuntimeDataRelease> };
  if (Array.isArray(parsed.releases)) return parsed.releases[0];
  if (parsed.releases && typeof parsed.releases === "object") return Object.values(parsed.releases)[0];
  return undefined;
}

function bitmapBitDepth(asset: Record<string, unknown>): number {
  return Number(asset.bitDepth ?? 0);
}

function isMaterializedIndexedBitmap(asset: Record<string, unknown>): boolean {
  return isIndexedBitDepth(bitmapBitDepth(asset)) && hasPositiveBitmapGeometry(asset);
}

function isIndexedBitDepth(bitDepth: number): boolean {
  return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
}

function hasPositiveBitmapGeometry(asset: Record<string, unknown>): boolean {
  return Number(asset.width ?? 0) > 0 && Number(asset.height ?? 0) > 0;
}

function profileValidationCompletion(
  checks: readonly ProfileValidationCheck[],
  launchable: boolean,
): ProfileValidationCompletion {
  const passes = (name: string): boolean => checks.find((check) => check.name === name)?.state === "pass";
  const materializedReferenceComplete =
    passes("materialized-assets") &&
    passes("bitmap-director-metadata") &&
    passes("director-sound-inventory");
  const sourceExtractionComplete =
    passes("indexed-bitmap-palettes") &&
    passes("indexed-bitmap-palette-provenance") &&
    passes("director-cast-member-ranges") &&
    passes("external-bitmap-member-closure") &&
    passes("extractor-unsupported-bitmap-records") &&
    passes("director-sound-inventory") &&
    passes("visual-layout-closure") &&
    passes("visual-layout-source-recovery");
  return {
    launchable,
    materializedReferenceComplete,
    sourceExtractionComplete,
    fidelityComplete: launchable && materializedReferenceComplete && sourceExtractionComplete,
  };
}

function hasPaletteProvenance(asset: Record<string, unknown>): boolean {
  return (
    Number.isInteger(Number(asset.sourcePaletteCastLib)) &&
    Number.isInteger(Number(asset.sourcePaletteMember)) &&
    Number.isInteger(Number(asset.resolvedPaletteCastLib)) &&
    Number.isInteger(Number(asset.resolvedPaletteMember)) &&
    typeof asset.sourcePaletteKind === "string" &&
    asset.sourcePaletteKind.length > 0 &&
    typeof asset.paletteResolution === "string" &&
    asset.paletteResolution.length > 0 &&
    typeof asset.sourcePaletteReferenceValid === "boolean"
  );
}

function hasIndexedPaletteData(asset: Record<string, unknown>): boolean {
  return (
    typeof asset.paletteIndexData === "string" &&
    asset.paletteIndexData.length > 0 &&
    Array.isArray(asset.paletteColors) &&
    asset.paletteColors.length > 0
  );
}

function hasPoint(value: unknown): boolean {
  return !!value && typeof value === "object" && Number.isFinite(Number((value as { x?: unknown }).x)) && Number.isFinite(Number((value as { y?: unknown }).y));
}

function hasRect(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite(Number((value as { left?: unknown }).left)) &&
    Number.isFinite(Number((value as { top?: unknown }).top)) &&
    Number.isFinite(Number((value as { right?: unknown }).right)) &&
    Number.isFinite(Number((value as { bottom?: unknown }).bottom))
  );
}

function visualBitmapElementCount(visual: Record<string, unknown>): number {
  return Number(visual.bitmapElementCount ?? 0);
}

function visualAssetCount(visual: Record<string, unknown>): number {
  return Array.isArray(visual.assetIds) ? visual.assetIds.length : 0;
}

function isExteriorVisual(name: string): boolean {
  return /^(exterior|horizon|hrz|sakura)|(?:exterior|horizon|hrz|sakura)/i.test(name);
}

function assetSamples(assets: Record<string, unknown>[]): string[] {
  return assets
    .map((asset) => `${String(asset.castName ?? "cast")}/${String(asset.memberName ?? asset.member ?? "member")}`)
    .slice(0, ISSUE_SAMPLE_LIMIT);
}

function unsupportedLabel(entry: Record<string, unknown>): string {
  const layout = String(entry.layoutName ?? entry.castName ?? "layout");
  const member = String(entry.memberName ?? entry.member ?? "member");
  const reason = String(entry.reason ?? "unsupported");
  return `${layout}/${member}: ${reason}`;
}

function hasExtractedProjectorRaysOutput(extractedRoot: string): boolean {
  if (!existsSync(extractedRoot)) return false;
  const stack = [extractedRoot];
  let scanned = 0;
  while (stack.length > 0 && scanned < 5000) {
    const root = stack.pop()!;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      scanned += 1;
      if (entry.isDirectory()) {
        stack.push(join(root, entry.name));
      } else if (entry.isFile() && /\.(ls|lasm|json|txt)$/i.test(entry.name) && statSync(join(root, entry.name)).size > 0) {
        return true;
      }
    }
  }
  return false;
}

export function profileValidationReportPath(profileRoot: string): string {
  return join(profileRoot, "profile-validation-report.json");
}

export function profileRelativePath(profileRoot: string, filePath: string): string {
  return relative(profileRoot, filePath).replace(/\\/g, "/");
}
