export type StageState = "pending" | "running" | "done" | "warning" | "failed" | "skipped";

export type ProfileImportStage =
  | "validate"
  | "sanitize"
  | "projectorrays"
  | "index-casts"
  | "text-fields"
  | "materialize-bitmaps"
  | "generate-scripts"
  | "validate-profile";

export interface ImportProgress {
  readonly stage: ProfileImportStage;
  readonly state: StageState;
  readonly message: string;
  readonly detail?: string;
  readonly percent: number;
  readonly current?: number;
  readonly total?: number;
  readonly elapsedMs?: number;
  readonly bytesProcessed?: number;
  readonly bytesTotal?: number;
  readonly workers?: number;
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  readonly reusedBytes?: number;
  readonly etaMs?: number;
}

export interface RuntimeProfilePaths {
  readonly client: string;
  readonly extracted: string;
  readonly runtimeData: string;
  readonly assets: string;
  readonly scripts: string;
  readonly report: string;
}

export interface RuntimeReadiness {
  readonly ready: boolean;
  readonly reason?: string;
  readonly missingFiles: string[];
  readonly executableScriptsSupported?: boolean;
  readonly executableScriptVersion?: string;
  readonly assetReferences?: number;
  readonly assetFilesReady?: number;
  readonly assetFilesMissing?: number;
  readonly assetFilesInvalid?: number;
  readonly validation?: ProfileValidationSummary;
}

export interface ProfileValidationSummary {
  readonly ready: boolean;
  readonly launchable: boolean;
  readonly materializedReferenceComplete: boolean;
  readonly sourceExtractionComplete: boolean;
  readonly fidelityComplete: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly checkCount: number;
}

export interface RuntimeProfile {
  readonly id: string;
  readonly profileRoot?: string;
  readonly displayName: string;
  readonly versionId: string;
  readonly buildNumber: number | null;
  readonly versionCheckBuild: number;
  readonly importedAt: string;
  readonly sourceFolderName: string;
  readonly entryMovie: string;
  readonly alternateEntryMovies: string[];
  readonly status: "imported" | "failed";
  readonly fixedStage: boolean;
  readonly resizablePresentation: boolean;
  readonly paths: RuntimeProfilePaths;
  readonly runtime: RuntimeReadiness;
  readonly importReportPath: string;
  readonly runtimeDataSchemaVersion?: number;
  readonly sourceFingerprint?: string;
  readonly pipelineFingerprint?: string;
  readonly artifactCacheKey?: string;
}

export interface ImportReport {
  readonly profileId: string;
  readonly generatedAt: string;
  readonly runtimeDataSchemaVersion?: number;
  readonly sourceFolderName: string;
  readonly versionCheckBuild: number;
  readonly entryMovie: string;
  readonly alternateEntryMovies: string[];
  readonly skippedZeroByteFiles: string[];
  readonly warnings: string[];
  readonly source?: {
    readonly fingerprint: string;
    readonly fileCount: number;
    readonly byteCount: number;
  };
  readonly pipelineFingerprint?: string;
  readonly performance?: {
    readonly totalMs: number;
    readonly cacheHit: boolean;
  };
  readonly stages: ImportProgress[];
  readonly projectorrays: {
    readonly executable: string;
    readonly exitCode: number | null;
    readonly logPath: string;
    readonly versionOutput: string;
  };
  readonly runtime: RuntimeReadiness;
  readonly profileValidation?: ProfileValidationSummary;
  readonly assets?: {
    readonly referenced: number;
    readonly copied: number;
    readonly reused: number;
    readonly missing: number;
    readonly invalid: number;
  };
}

export interface LauncherSettings {
  readonly activeProfileId: string | null;
  readonly fixedStage: boolean;
  readonly resizablePresentation: boolean;
  readonly customHotelView: boolean;
  readonly rememberCredentials: boolean;
  readonly versionCheckBuild: number | null;
}

export interface LauncherState {
  readonly cacheRoot: string;
  readonly clientsRoot?: string;
  readonly profiles: RuntimeProfile[];
  readonly settings: LauncherSettings;
  readonly credentialsSaved: boolean;
}

export interface ImportProfileRequest {
  readonly clientRoot: string;
  readonly fixedStage: boolean;
  readonly resizablePresentation: boolean;
  readonly customHotelView?: boolean;
  readonly versionCheckBuild?: number | null;
}

export interface UpdateLauncherSettingsRequest {
  readonly fixedStage?: boolean;
  readonly resizablePresentation?: boolean;
  readonly customHotelView?: boolean;
  readonly versionCheckBuild?: number | null;
}

export interface CredentialsInput {
  readonly email: string;
  readonly password: string;
}

export const DEFAULT_VERSION_CHECK_BUILD = 1128;
export const ORIGINS_MINIMUM_BUILD_NUMBER = 306;
export const PROFILE_RUNTIME_DATA_SCHEMA_VERSION = 4;
