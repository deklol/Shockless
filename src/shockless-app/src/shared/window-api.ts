import type { ConsoleCommandResult } from "./consoleCommand.js";
import type { PluginCreateRequest, PluginEntrySourceResult, PluginInstallResult, PluginRegistryState } from "./plugin.js";
import type { PluginPacketInput } from "./shockwavePluginPacketBuilder.js";
import type { AppUpdateState } from "./update.js";

export type { PluginPacketInput } from "./shockwavePluginPacketBuilder.js";

export interface ClientProfileSummary {
  readonly id: string;
  readonly label: string;
  readonly versionId: string;
  readonly buildNumber: number | null;
  readonly versionCheckBuild: number | null;
  readonly importedAt: string;
  readonly sourceFolderName: string;
  readonly profileRoot: string;
  readonly ready: boolean;
  readonly reason: string | null;
  readonly fidelityComplete: boolean | null;
  readonly fidelityWarningCount: number;
  readonly storageMode: "referenced";
}

export interface ClientLibraryState {
  readonly profiles: readonly ClientProfileSummary[];
  readonly selectedProfileRoot: string | null;
  readonly selectedProfileId: string | null;
  readonly message: string;
}

export interface AppPreferencesState {
  readonly shellUiHidden: boolean;
  readonly hardwareAcceleration: boolean;
  readonly packetOutputWrap: boolean;
  readonly packetOutputAutoScroll: boolean;
  readonly smoothAvatars: boolean;
  readonly smoothUi: boolean;
  readonly perfTrace: boolean;
  readonly engineUserNameLabels: boolean;
  readonly customHabboCursor: boolean;
  readonly userNameLabelOffset: number;
  readonly userNameLabelSelfColor: string;
  readonly userNameLabelOtherColor: string;
  readonly nativeBindShift: string;
  readonly nativeBindControl: string;
  readonly nativeBindOption: string;
  readonly nativeBindCommand: string;
  readonly defaultAccountFile: string;
  readonly defaultAccountCount: number;
  readonly defaultAccountConcurrency: number;
  readonly defaultAccountKeyEnv: string;
  readonly defaultSummonTarget: string;
  readonly defaultLoadMode: "headless" | "visible";
  readonly autoSubmitVisibleLogin: boolean;
  readonly hardwareAccelerationActive: boolean;
  readonly hardwareAccelerationRestartRequired: boolean;
  readonly gpuLaunchSwitches: readonly string[];
}

export interface AppPreferencesPatch {
  readonly shellUiHidden?: boolean;
  readonly hardwareAcceleration?: boolean;
  readonly packetOutputWrap?: boolean;
  readonly packetOutputAutoScroll?: boolean;
  readonly smoothAvatars?: boolean;
  readonly smoothUi?: boolean;
  readonly perfTrace?: boolean;
  readonly engineUserNameLabels?: boolean;
  readonly customHabboCursor?: boolean;
  readonly userNameLabelOffset?: number;
  readonly userNameLabelSelfColor?: string;
  readonly userNameLabelOtherColor?: string;
  readonly nativeBindShift?: string;
  readonly nativeBindControl?: string;
  readonly nativeBindOption?: string;
  readonly nativeBindCommand?: string;
  readonly defaultAccountFile?: string;
  readonly defaultAccountCount?: number;
  readonly defaultAccountConcurrency?: number;
  readonly defaultAccountKeyEnv?: string;
  readonly defaultSummonTarget?: string;
  readonly defaultLoadMode?: "headless" | "visible";
  readonly autoSubmitVisibleLogin?: boolean;
}

export type ProfileImportStage =
  | "validate"
  | "sanitize"
  | "projectorrays"
  | "index-casts"
  | "text-fields"
  | "materialize-bitmaps"
  | "generate-scripts"
  | "validate-profile";

export type ProfileImportStageState = "pending" | "running" | "done" | "warning" | "failed" | "skipped";

export interface ProfileImportProgress {
  readonly jobId: string;
  readonly sourceName: string;
  readonly stage: ProfileImportStage;
  readonly state: ProfileImportStageState;
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
  readonly logPath?: string | null;
  readonly updatedAt: string;
}

export interface EngineLaunchState {
  readonly status: "not-configured" | "ready" | "running" | "error";
  readonly embeddedUrl: string | null;
  readonly profile: ClientProfileSummary | null;
  readonly buildLabel: string;
  readonly message: string;
  readonly settings: {
    readonly realm: import("./originsRealm.js").OriginsRealmId;
    readonly resizablePresentation: boolean;
    readonly customHotelView: boolean;
    readonly entryView: string | null;
    readonly versionCheckBuild: number | null;
  } | null;
}

export interface EngineLaunchSettingsPatch {
  readonly realm?: import("./originsRealm.js").OriginsRealmId;
  readonly resizablePresentation?: boolean;
  readonly customHotelView?: boolean;
  readonly entryView?: string | null;
  readonly versionCheckBuild?: number | null;
}

export type ClientSessionStatus = "not-configured" | "ready" | "running" | "error" | "offline";

export interface ConsoleAliasSummary {
  readonly name: string;
  readonly expansion: string;
}

export interface ConsoleBindingSummary {
  readonly key: string;
  readonly command: string;
}

export interface ConsoleCommandStateSnapshot {
  readonly aliases: readonly ConsoleAliasSummary[];
  readonly bindings: readonly ConsoleBindingSummary[];
  readonly history: readonly string[];
}

export type MimicCategory = "movement" | "speech" | "actions" | "rooms";

export interface MimicStateSnapshot {
  readonly enabled: boolean;
  readonly sourceClientId: number;
  readonly targetClientIds: readonly number[];
  readonly categories: Readonly<Record<MimicCategory, boolean>>;
  readonly polling: boolean;
  readonly forwardedCount: number;
  readonly blockedCount: number;
  readonly lastForwardAt: string | null;
  readonly lastError: string | null;
}

export interface ClientSessionSummary {
  readonly id: number;
  readonly label: string;
  readonly username: string | null;
  readonly status: ClientSessionStatus;
  readonly headless: boolean;
  readonly visible: boolean;
  readonly selected: boolean;
  readonly main: boolean;
  readonly profileId: string | null;
  readonly profileLabel: string;
  readonly buildLabel: string;
  readonly embeddedUrl: string | null;
  readonly relayWsPort: number | null;
  readonly relayControlPort: number | null;
  readonly roomName: string | null;
  readonly lastError: string | null;
}

export interface ClientSessionList {
  readonly selectedClientId: number;
  readonly mainClientId: number;
  readonly sessions: readonly ClientSessionSummary[];
  readonly message: string;
}

export interface ClientRuntimeSummary {
  readonly clientId: number;
  readonly source: "visible-renderer" | "hidden-runtime" | "none";
  readonly updatedAt: string | null;
  readonly roomReady: boolean | null;
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly roomType: string | null;
  readonly roomOwner: string | null;
  readonly userName: string | null;
  readonly userCount: number | null;
  readonly fps: number | null;
  readonly frame: number | null;
  readonly error: string | null;
}

export interface ClientRelaySummary {
  readonly clientId: number;
  readonly logPath: string;
  readonly exists: boolean;
  readonly updatedAt: string | null;
  readonly totalLines: number;
  readonly packetCount: number;
  readonly clientCount: number;
  readonly serverCount: number;
  readonly latestClientPacket: string | null;
  readonly latestServerPacket: string | null;
}

export interface ClientSnapshot {
  readonly selectedClientId: number;
  readonly mainClientId: number;
  readonly client: ClientSessionSummary | null;
  readonly runtime: ClientRuntimeSummary | null;
  readonly relay: ClientRelaySummary | null;
  readonly message: string;
}

export interface ClientSnapshotList {
  readonly selectedClientId: number;
  readonly mainClientId: number;
  readonly clients: readonly ClientSnapshot[];
  readonly message: string;
}

export interface RelayLogEntry {
  readonly id: string;
  /** Stable line number inside the owning client's on-disk relay log. */
  readonly sourceLineNumber: number;
  /** Presentation-order line number. Aggregate snapshots may differ from sourceLineNumber. */
  readonly lineNumber: number;
  readonly clientId: number | null;
  readonly clientLabel: string | null;
  readonly sessionId: string | null;
  readonly direction: "CLIENT" | "SERVER" | "RELAY";
  readonly route: string;
  readonly mode: string | null;
  readonly header: number | null;
  readonly packetName: string | null;
  readonly size: number | null;
  readonly payloadBytes: number | null;
  readonly bodyStatus: "sampled" | "redacted" | "not-persisted" | "not-a-packet";
  readonly bodyText: string | null;
  readonly bodyHex: string | null;
  readonly bodyAscii: string | null;
  readonly bodyTruncated: boolean;
  readonly decodedFields: readonly RelayLogDecodedField[];
  readonly bodyNote: string;
  readonly message: string;
}

export interface RelayLogClientSummary {
  readonly clientId: number;
  readonly clientLabel: string;
  readonly logPath: string;
  readonly exists: boolean;
  readonly fileSize: number;
  readonly updatedAt: string | null;
  readonly totalLines: number;
  readonly packetCount: number;
  readonly clientCount: number;
  readonly serverCount: number;
}

export interface RelayLogDecodedField {
  readonly label: string;
  readonly value: string;
}

export interface RelayLogSnapshot {
  readonly logPath: string;
  readonly exists: boolean;
  readonly fileSize: number;
  readonly updatedAt: string | null;
  readonly totalLines: number;
  readonly packetCount: number;
  readonly clientCount: number;
  readonly serverCount: number;
  /** First presentation-order line retained in entries, or totalLines + 1 when empty. */
  readonly retainedFromLine: number;
  /** Last presentation-order line retained in entries, or totalLines when empty. */
  readonly retainedToLine: number;
  /** True only when entries contains the complete current log history. */
  readonly historyComplete: boolean;
  readonly clients: readonly RelayLogClientSummary[];
  readonly entries: readonly RelayLogEntry[];
  readonly message: string;
}

export interface RelayLogDeltaSnapshot extends RelayLogSnapshot {
  readonly afterLineNumber: number;
  readonly reset: boolean;
  readonly nextLineNumber: number;
  readonly hasMore: boolean;
}

export interface RelayLogHistoryPage {
  readonly clientId: number;
  readonly clientLabel: string;
  readonly logPath: string;
  readonly beforeSourceLineNumber: number;
  readonly firstSourceLineNumber: number | null;
  readonly lastSourceLineNumber: number | null;
  readonly hasMore: boolean;
  readonly entries: readonly RelayLogEntry[];
}

export interface FurniMetadataEntry {
  readonly id: string;
  readonly className: string;
  readonly kind: "floor" | "wall";
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly rare: boolean;
}

export interface FurniMetadataSnapshot {
  readonly source: "cache" | "network" | "none";
  readonly fetchedAt: string;
  readonly entryCount: number;
  readonly entriesByClass: Readonly<Record<string, FurniMetadataEntry>>;
  readonly message: string;
}

export interface OriginsUserLookupResult {
  readonly ok: boolean;
  readonly query: string;
  readonly source: "official-origins-public-api";
  readonly id: string;
  readonly name: string;
  readonly figureString: string;
  readonly motto: string;
  readonly memberSince: string;
  readonly profileVisible: boolean | null;
  readonly selectedBadges: readonly string[];
  readonly message: string;
}

export type GardeningRelayAction =
  | {
      readonly action: "move";
      readonly objectId: number;
      readonly x: number;
      readonly y: number;
      readonly direction: number;
    }
  | {
      readonly action: "water" | "harvest" | "compost";
      readonly objectId: number;
    };

export type RoomRelayAction =
  | {
      readonly action: "move";
      readonly x: number;
      readonly y: number;
      readonly furniId?: number;
    }
  | {
      readonly action: "leave";
    }
  | {
      readonly action: "visitPrivateRoom";
      readonly roomId?: number;
      readonly flatId?: number;
    };

export type FishingRelayAction =
  | { readonly action: "startFishing"; readonly areaId: number }
  | { readonly action: "minigameInput"; readonly direction: "L" | "R" }
  | { readonly action: "purchaseProduct"; readonly productCode: string }
  | {
      readonly action:
        | "registerDerby"
        | "requestTokens"
        | "requestProducts"
        | "requestRodLevel"
        | "requestStats"
        | "requestFishopedia";
    };

export interface GardeningRelayResult {
  readonly ok: boolean;
  readonly message: string;
  readonly sessionId?: number;
  readonly roomReady?: boolean | null;
}

export type UserRelayAction =
  | { readonly action: "wave" }
  | { readonly action: "dance"; readonly number: number }
  | { readonly action: "stopDance" }
  | { readonly action: "hcdance"; readonly number?: number }
  | { readonly action: "carryDrink" }
  | { readonly action: "applyLook"; readonly figure: string };

export type SocialRelayAction =
  | { readonly action: "message"; readonly accountId: number; readonly message: string; readonly recipient?: string }
  | { readonly action: "addUser"; readonly name: string }
  | { readonly action: "refreshFriendRequests" }
  | { readonly action: "acceptRequest"; readonly accountId: number }
  | { readonly action: "declineRequest"; readonly accountId: number }
  | { readonly action: "removeFriend"; readonly accountId: number; readonly name?: string }
  | { readonly action: "followFriend"; readonly accountId: number; readonly name?: string };

export type WallMoverRelayAction =
  | {
      readonly action: "moveItem";
      readonly itemId: number;
      readonly wallX: number;
      readonly wallY: number;
      readonly localX: number;
      readonly localY: number;
      readonly orientation: "l" | "r";
      readonly className?: string;
    }
  | { readonly action: "pickup"; readonly itemId: number; readonly className?: string };

export type FurniRelayAction =
  | {
      readonly action: "moveFloorItem" | "rotateFloorItem";
      readonly objectId: number;
      readonly x: number;
      readonly y: number;
      readonly direction: number;
      readonly className?: string;
    }
  | {
      readonly action: "setFloorItemLocation";
      readonly objectId: number;
      readonly x: number;
      readonly y: number;
      readonly height?: number | string;
      readonly className?: string;
    }
  | {
      readonly action: "useFloorItem";
      readonly objectId: number;
      readonly value?: string | number;
      readonly className?: string;
    }
  | { readonly action: "pickupFloorItem"; readonly objectId: number; readonly className?: string }
  | {
      readonly action: "moveWallItem";
      readonly itemId: number;
      readonly wallX: number;
      readonly wallY: number;
      readonly localX: number;
      readonly localY: number;
      readonly orientation: "l" | "r";
      readonly className?: string;
    }
  | { readonly action: "pickupWallItem"; readonly itemId: number; readonly className?: string };

export interface RendererHeartbeat {
  readonly at: string;
  readonly visibilityState: string;
  readonly selectedClientId: number | null;
  readonly mountedGameViews: number;
}

export interface RuntimeHealthReport {
  readonly at: string;
  readonly scope: "game-webview" | "engine-renderer";
  readonly clientId: number | null;
  readonly state: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AppReliabilityEvent {
  readonly sequence: number;
  readonly at: string;
  readonly scope: "main-renderer" | "gpu-process" | "game-webview" | "engine-renderer" | "application";
  readonly type: string;
  readonly severity: "info" | "warning" | "error";
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AppReliabilityState {
  readonly events: readonly AppReliabilityEvent[];
  readonly lastRendererHeartbeat: RendererHeartbeat | null;
  readonly lastRuntimeHealth: RuntimeHealthReport | null;
  readonly recovery: {
    readonly inProgress: boolean;
    readonly attemptCount: number;
    readonly lastAttemptAt: string | null;
    readonly lastReason: string | null;
    readonly lastOutcome: "pending" | "recovered" | "failed" | null;
  };
  readonly logPath: string;
}

export interface ShocklessApi {
  getAppInfo(): Promise<{
    name: string;
    version: string;
    mode: "desktop" | "browser-preview";
  }>;
  getReliabilityState(): Promise<AppReliabilityState>;
  reportRendererHeartbeat(heartbeat: RendererHeartbeat): void;
  reportRuntimeHealth(report: RuntimeHealthReport): void;
  getAppPreferences(): Promise<AppPreferencesState>;
  setAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferencesState>;
  onShellUiHiddenChanged(listener: (hidden: boolean) => void): () => void;
  getUpdateState(): Promise<AppUpdateState>;
  checkForUpdates(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  installDownloadedUpdate(): Promise<AppUpdateState>;
  skipUpdate(version: string): Promise<AppUpdateState>;
  onUpdateState(listener: (state: AppUpdateState) => void): () => void;
  getPluginRegistryState(): Promise<PluginRegistryState>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryState>;
  setPluginSurfaceEnabled(pluginId: string, surfaceId: string, enabled: boolean): Promise<PluginRegistryState>;
  reloadPlugins(): Promise<PluginRegistryState>;
  openPluginsFolder(): Promise<PluginInstallResult>;
  createPluginFromTemplate(request: PluginCreateRequest): Promise<PluginInstallResult>;
  installPluginFromFolder(): Promise<PluginInstallResult>;
  uninstallPlugin(pluginId: string): Promise<PluginInstallResult>;
  readPluginEntrySource(pluginId: string): Promise<PluginEntrySourceResult>;
  getClientLibraryState(): Promise<ClientLibraryState>;
  getClientSessions(): Promise<ClientSessionList>;
  getClientSnapshot(clientId?: number): Promise<ClientSnapshot>;
  getClientSnapshots(): Promise<ClientSnapshotList>;
  selectClientSession(clientId: number): Promise<ClientSessionList>;
  renameClientSession(clientId: number, label: string): Promise<ClientSessionList>;
  runConsoleCommand(input: string): Promise<ConsoleCommandResult>;
  runConsoleBinding(key: string): Promise<ConsoleCommandResult>;
  getConsoleCommandState(): Promise<ConsoleCommandStateSnapshot>;
  getMimicState(): Promise<MimicStateSnapshot>;
  importClientReference(): Promise<ClientLibraryState>;
  onProfileImportProgress(listener: (progress: ProfileImportProgress) => void): () => void;
  onShowAbout(listener: () => void): () => void;
  setActiveClientProfile(profileRoot: string): Promise<ClientLibraryState>;
  getEngineLaunchState(): Promise<EngineLaunchState>;
  setEngineLaunchSettings(patch: EngineLaunchSettingsPatch): Promise<EngineLaunchState>;
  startEmbeddedEngine(): Promise<EngineLaunchState>;
  stopEmbeddedEngine(): Promise<EngineLaunchState>;
  submitVisibleClientLogin(clientId: number, webContentsId: number): Promise<GardeningRelayResult>;
  getRelayLogSnapshot(): Promise<RelayLogSnapshot>;
  getRelayLogDeltaSnapshot(currentLogPath: string | null, afterLineNumber: number): Promise<RelayLogDeltaSnapshot>;
  getRelayLogHistoryPage(clientId: number, beforeSourceLineNumber?: number | null, limit?: number): Promise<RelayLogHistoryPage>;
  getFurniMetadataSnapshot(): Promise<FurniMetadataSnapshot>;
  lookupOriginsUser(name: string): Promise<OriginsUserLookupResult>;
  sendRoomRelayAction(action: RoomRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendFishingRelayAction(action: FishingRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendGardeningRelayAction(action: GardeningRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendUserRelayAction(action: UserRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendSocialRelayAction(action: SocialRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendWallMoverRelayAction(action: WallMoverRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendFurniRelayAction(action: FurniRelayAction, clientId?: number): Promise<GardeningRelayResult>;
  sendPluginPacket(packet: PluginPacketInput, clientId?: number): Promise<GardeningRelayResult>;
}

declare global {
  interface Window {
    shockless?: ShocklessApi;
  }
}

export {};
