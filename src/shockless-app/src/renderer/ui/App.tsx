import { startTransition,useCallback,useDeferredValue,useEffect,useMemo,useReducer,useRef,useState,type UIEvent } from "react";
import { initialAppState } from "../../core/sampleState";
import { shellReducer } from "../../core/shellStore";
import {
runtimeItemRows,
runtimeRoomId,
runtimeRoomName,
runtimeRoomType,
summarizeRuntimeSnapshot
} from "../../engine-adapter/shocklessSessionAdapter";
import { getPluginById,plugins } from "../../plugins/registry";
import { redactConsoleCommandInput,type ConsoleRendererAction } from "../../shared/consoleCommand";
import type { PluginDefinition,PluginRegistryState } from "../../shared/plugin";
import { RELAY_LOG_HISTORY_ENTRY_LIMIT } from "../../shared/relayLogWindow";
import type { AppUpdateState } from "../../shared/update";
import type {
AppPreferencesPatch,
AppPreferencesState,
ClientLibraryState,
ClientSessionList,
ClientSnapshot,
ConsoleCommandStateSnapshot,
EngineLaunchState,
FurniMetadataSnapshot,
MimicStateSnapshot,
OriginsUserLookupResult,
RelayLogDeltaSnapshot,
RelayLogEntry,
RelayLogSnapshot,
SocialRelayAction,
UserRelayAction,
WallMoverRelayAction
} from "../../shared/window-api";
import {
readEngineRuntimeSnapshot,
runEngineRuntimeAction,
type EngineRuntimeAction,
type EngineRuntimeActionResult,
type EngineRuntimeSnapshot,
type EngineRuntimeSnapshotScope,
type EngineWebviewElement,
type RuntimeChatEntry
} from "../engineRuntime";
import { useRoomSessionEffects } from "../features/chat/useRoomSessionEffects";
import { useEngineLifecycleActions } from "../features/client-import/useEngineLifecycleActions";
import { useProfileImportLifecycle } from "../features/client-import/useProfileImportLifecycle";
import { usePanelAutoScroll } from "../features/common/usePanelAutoScroll";
import {
parseHideListEntries,
serializeHideListEntries,
type HideListEntry
} from "../features/hide-list/model";
import { useInjectionActions } from "../features/injection/useInjectionActions";
import { useVisibleClientAutoLogin } from "../features/multi-account/useVisibleClientAutoLogin";
import { consoleSuggestionParts,packetConsoleSuggestionsForInput } from "../features/packet-console/suggestions";
import { usePacketConsoleCommand } from "../features/packet-console/usePacketConsoleCommand";
import { useRelayLogPolling } from "../features/packets/useRelayLogPolling";
import { buildBuiltInRuntimeUi } from "../features/plugins/buildBuiltInRuntimeUi";
import { handleUserPluginRequest } from "../features/plugins/handleUserPluginRequest";
import type { RuntimePluginUiState } from "../features/plugins/runtimeUiState";
import { loadPersistedPluginRuntimeUiValues,persistedPluginValue } from "../features/plugins/runtimeUiState";
import { type SchemaPrimitiveValue } from "../features/plugins/schemaBuilders";
import { usePluginManagerActions } from "../features/plugins/usePluginManagerActions";
import { usePluginRuntimeOverrides } from "../features/plugins/usePluginRuntimeOverrides";
import { usePluginSchemaActions } from "../features/plugins/usePluginSchemaActions";
import { useUserPluginEvents } from "../features/plugins/useUserPluginEvents";
import { useRuntimeHealthMonitoring } from "../features/runtime-health/useRuntimeHealthMonitoring";
import { useRuntimeSnapshotPolling } from "../features/runtime/useRuntimeSnapshotPolling";
import { clampNameLabelOffset,normalizeNameLabelColor,normalizeNativeBindValue } from "../features/settings/normalization";
import { useAppSettingsSchema } from "../features/settings/useAppSettingsSchema";
import { useLocalFeaturePersistence } from "../features/settings/useLocalFeaturePersistence";
import { useRuntimePreferenceSync } from "../features/settings/useRuntimePreferenceSync";
import { useSettingsActions } from "../features/settings/useSettingsActions";
import {
socialDmNotificationsEnabled
} from "../features/social/dmNotifications";
import { useDmNotifications } from "../features/social/useDmNotifications";
import type { PendingStageClickRequest } from "../features/stage/capture";
import { normalizeStageInputMetrics,stagePointFromWebviewPoint,type StageInputMetrics } from "../features/stage/inputCoordinates";
import { useUpdateActions } from "../features/updates/useUpdateActions";
import { useUserTools } from "../features/user/useUserTools";
import { useVisitorTracking } from "../features/visitors/useVisitorTracking";
import { RendererUserPluginHost,type UserPluginHostRequest } from "../userPluginHost";
import { BootSplash } from "./BootSplash";
import { GameStage } from "./GameStage";
import {
PACKET_CONSOLE_OVERSCAN_ROWS,
PACKET_CONSOLE_RENDER_ROWS,
PACKET_CONSOLE_ROW_HEIGHT,
PluginIcon,
bindingKeyFromKeyboardEvent,
chatEntryKind,
clampMultiAccountConcurrency,
clampMultiAccountCount,
clientPluginSnapshotMapFromSources,
clientSessionTitle,
commandRefreshesEngineLaunch,
compactValue,
defaultInjectionDraft,
delay,
disabledManagedClientRights,
emptyPacketInfoState,
emptyPacketInventoryState,
emptyPacketProfileIndex,
emptyPacketWallItemState,
emptyProfileImportUiState,
emptyVisitorState,
furniInfoForObject,
gameWebviewPartitionForClient,
ingestClientPluginRelaySnapshot,
isTextEntryTarget,
itemRowSearchText,
loadAutomationPrefs,
loadStoredUserLooks,
matchingClientRights,
mergeClientSummaryIntoList,
mergeRelayLogSnapshot,
objectNumericId,
packetChatRuntimeEntry,
packetClientMatches,
packetFriendSearchText,
packetInventoryDisplayRow,
packetWallItemRow,
pluginHasPermission,
pluginRelayPacketPayload,
profileLine,
profileValue,
relayBodyLoggingSummary,
relayDerivedStateFromSnapshot,
relayEncryptionSummary,
relayEntryPlain,
relayEntrySearchText,
relayModeSummary,
removeClientRightOwners,
reuseStableRuntimeDetails,
runtimeInventoryDisplayRow,
selectPacketProfileUser,
uniqueUsefulNames,
userDisplayName,
userPosition,
virtualPacketRange,
visitorSearchText,
wallMoverLocation,
withVisibleConsoleContext,
type GameWebviewMount,
type InjectionCommandDraft,
type InjectionHistoryEntry,
type InjectionSnippet,
type ItemRow,
type PacketConsoleEntry,
type PacketMessengerMessage,
type PluginClientRightsOwners,
type ProfileImportUiState,
type UserPluginChatCache,
type UserPluginRoomObjectCache,
type UserPluginRoomUserCache,
type VisitorTrackerState
} from "./helpers";
import { IconRail } from "./IconRail";
import { PacketConsoleOverlay } from "./PacketConsoleOverlay";
import { PluginStoreModal } from "./PluginStoreModal";
import { RoomOverlays } from "./RoomOverlays";
import { SettingsModal } from "./SettingsModal";
import { TopBar } from "./TopBar";
import { UpdateModal } from "./UpdateModal";
export function App() {
  const [state, dispatch] = useReducer(shellReducer, initialAppState);
  const [booting, setBooting] = useState(true);
  const [query, setQuery] = useState("");
  const [appInfo, setAppInfo] = useState<{ readonly name: string; readonly version: string; readonly mode: "desktop" | "browser-preview" } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);
  const [appPreferences, setAppPreferences] = useState<AppPreferencesState | null>(null);
  const [shellUiHidden, setShellUiHidden] = useState(false);
  const [pluginRegistryState, setPluginRegistryState] = useState<PluginRegistryState | null>(null);
  const [pluginManagerMessage, setPluginManagerMessage] = useState("");
  const [newPluginId, setNewPluginId] = useState("my-plugin");
  const [newPluginName, setNewPluginName] = useState("My Plugin");
  const [pluginStoreOpen, setPluginStoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginRuntimeUiById, setPluginRuntimeUiById] =
    useState<Readonly<Record<string, RuntimePluginUiState | undefined>>>(loadPersistedPluginRuntimeUiValues);
  const [settingsBindKey, setSettingsBindKey] = useState("F1");
  const [settingsBindCommand, setSettingsBindCommand] = useState("mimic status");
  const [nativeBindShift, setNativeBindShift] = useState("Shift");
  const [nativeBindControl, setNativeBindControl] = useState("Control");
  const [nativeBindOption, setNativeBindOption] = useState("Alt");
  const [nativeBindCommand, setNativeBindCommand] = useState("Control");
  const [smoothAvatars, setSmoothAvatars] = useState(true);
  const [smoothUi, setSmoothUi] = useState(true);
  const [perfTrace, setPerfTrace] = useState(false);
  const [customHabboCursor, setCustomHabboCursor] = useState(true);
  const [libraryState, setLibraryState] = useState<ClientLibraryState | null>(null);
  const [clientSessions, setClientSessions] = useState<ClientSessionList | null>(null);
  const [selectedClientSnapshot, setSelectedClientSnapshot] = useState<ClientSnapshot | null>(null);
  const [engineLaunch, setEngineLaunch] = useState<EngineLaunchState | null>(null);
  const [relayLog, setRelayLog] = useState<RelayLogSnapshot | null>(null);
  const [furniMetadata, setFurniMetadata] = useState<FurniMetadataSnapshot | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [profileImportUi, setProfileImportUi] = useState<ProfileImportUiState>(emptyProfileImportUiState);
  const [profileImportNow, setProfileImportNow] = useState(() => Date.now());
  const [versionCheckDraft, setVersionCheckDraft] = useState("");
  const [bridgeMessage, setBridgeMessage] = useState("");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<EngineRuntimeSnapshot | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [privateRoomId, setPrivateRoomId] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [chatClearOffset, setChatClearOffset] = useState(0);
  const [chatRoomMarkers, setChatRoomMarkers] = useState<RuntimeChatEntry[]>([]);
  const [chatFilters, setChatFilters] = useState({
    talk: true,
    whisper: true,
    shout: true,
    system: true,
    autoscroll: true,
  });
  const [packetFilters, setPacketFilters] = useState({
    client: true,
    server: true,
    relay: true,
    wrap: true,
    autoscroll: true,
    clientSession: "All",
    session: "All",
    search: "",
  });
  const [packetClearAfterLine, setPacketClearAfterLine] = useState(0);
  const [selectedPacketKey, setSelectedPacketKey] = useState("");
  const [packetExportMessage, setPacketExportMessage] = useState("");
  const [packetHistory, setPacketHistory] = useState<{
    readonly logPath: string;
    readonly clientId: number;
    readonly entries: readonly RelayLogEntry[];
    readonly hasMore: boolean;
  } | null>(null);
  const [packetHistoryLoading, setPacketHistoryLoading] = useState(false);
  const [packetConsoleOpen, setPacketConsoleOpen] = useState(false);
  const [packetConsoleQuery, setPacketConsoleQuery] = useState("");
  const [packetConsoleClientFilter, setPacketConsoleClientFilter] = useState("All");
  const [packetConsoleInput, setPacketConsoleInput] = useState("");
  const [packetConsoleEntries, setPacketConsoleEntries] = useState<PacketConsoleEntry[]>([]);
  const [consoleCommandState, setConsoleCommandState] = useState<ConsoleCommandStateSnapshot | null>(null);
  const [mimicState, setMimicState] = useState<MimicStateSnapshot | null>(null);
  const [multiAccountFile, setMultiAccountFile] = useState("multiclient-accounts.txt");
  const [multiAccountCount, setMultiAccountCount] = useState("3");
  const [multiAccountConcurrency, setMultiAccountConcurrency] = useState("2");
  const [multiAccountKeyEnv, setMultiAccountKeyEnv] = useState("SHOCKLESS_ACCOUNT_STORE_KEY");
  const [multiAccountSummonTarget, setMultiAccountSummonTarget] = useState("headless");
  const [multiAccountLoadMode, setMultiAccountLoadMode] = useState<"headless" | "visible">("headless");
  const [multiAccountMessage, setMultiAccountMessage] = useState("");
  const [packetConsoleHistoryIndex, setPacketConsoleHistoryIndex] = useState<number | null>(null);
  const [packetListScrollTop, setPacketListScrollTop] = useState(0);
  const [packetConsoleScrollTop, setPacketConsoleScrollTop] = useState(0);
  const [socialFriendFilter, setSocialFriendFilter] = useState("");
  const [inventoryFilter, setInventoryFilter] = useState("");
  const [selectedInventoryKey, setSelectedInventoryKey] = useState("");
  const [gameZoom, setGameZoom] = useState<1 | 2>(1);
  const [injectionDraft, setInjectionDraft] = useState<InjectionCommandDraft>(() => ({
    ...defaultInjectionDraft,
    rawDirection: String(persistedPluginValue("injection", "injectionRawDirection", "SERVER")).toUpperCase() === "CLIENT" ? "CLIENT" : "SERVER",
    rawText: String(persistedPluginValue("injection", "injectionRawText", "")),
  }));
  const [injectionSendAll, setInjectionSendAll] = useState(() => Boolean(persistedPluginValue("injection", "injectionSendAll", false)));
  const [injectionRepeatCount, setInjectionRepeatCount] = useState(() => String(persistedPluginValue("injection", "injectionRepeatCount", "1")));
  const [injectionRepeatInterval, setInjectionRepeatInterval] = useState(() => String(persistedPluginValue("injection", "injectionRepeatInterval", "1000")));
  const [injectionSnippets, setInjectionSnippets] = useState<InjectionSnippet[]>([]);
  const [selectedInjectionSnippetId, setSelectedInjectionSnippetId] = useState("");
  const [injectionHistory, setInjectionHistory] = useState<InjectionHistoryEntry[]>([]);
  const [injectionMessage, setInjectionMessage] = useState("");
  const [visitorFilter, setVisitorFilter] = useState("");
  const [visitorState, setVisitorState] = useState<VisitorTrackerState>(emptyVisitorState);
  const [itemFilter, setItemFilter] = useState("");
  const [selectedItemKey, setSelectedItemKey] = useState("");
  const [publicRoomQuery, setPublicRoomQuery] = useState("");
  const [roomStageClickX, setRoomStageClickX] = useState("480");
  const [roomStageClickY, setRoomStageClickY] = useState("270");
  const [selectedWallMoverKey, setSelectedWallMoverKey] = useState("");
  const [wallMoverStep, setWallMoverStep] = useState("1");
  const [wallMoverMessage, setWallMoverMessage] = useState("");
  const [wallAnywhereMessage, setWallAnywhereMessage] = useState("");
  const [floorAnywhereMessage, setFloorAnywhereMessage] = useState("");
  const [hideListTarget, setHideListTarget] = useState(() => String(persistedPluginValue("hide-list", "target", "")));
  const [hideListReason, setHideListReason] = useState(() => String(persistedPluginValue("hide-list", "reason", "")));
  const [hideListRecords, setHideListRecords] = useState<readonly HideListEntry[]>(() =>
    parseHideListEntries(persistedPluginValue("hide-list", "entries", persistedPluginValue("hide-list", "hiddenUsers", ""))),
  );
  const [hideListMessage, setHideListMessage] = useState("");
  const [apiHiddenUserEntriesByPluginId, setApiHiddenUserEntriesByPluginId] = useState<Readonly<Record<string, readonly string[]>>>({});
  const pendingStageClickRequestsRef = useRef<PendingStageClickRequest[]>([]);
  const [stageClickCaptureCount, setStageClickCaptureCount] = useState(0);
  const [selectedUserKey, setSelectedUserKey] = useState("");
  const [engineUserNameLabels, setEngineUserNameLabels] = useState(false);
  const [userNameLabelOffset, setUserNameLabelOffset] = useState(40);
  const [userNameLabelSelfColor, setUserNameLabelSelfColor] = useState("#ffffff");
  const [userNameLabelOtherColor, setUserNameLabelOtherColor] = useState("#ffffff");
  const [userStoredLooks, setUserStoredLooks] = useState<string[]>(loadStoredUserLooks);
  const [selectedStoredUserLook, setSelectedStoredUserLook] = useState("");
  const [userToolMessage, setUserToolMessage] = useState("");
  const [automationPrefs, setAutomationPrefs] = useState(loadAutomationPrefs);
  const [automationMessage, setAutomationMessage] = useState("");
  const [socialMessage, setSocialMessage] = useState("");
  const [socialTarget, setSocialTarget] = useState("");
  const [socialDraft, setSocialDraft] = useState("");
  const [publicLookupName, setPublicLookupName] = useState("");
  const [publicLookupBusy, setPublicLookupBusy] = useState(false);
  const [publicLookupResult, setPublicLookupResult] = useState<OriginsUserLookupResult | null>(null);
  const [visitorLookupBusy, setVisitorLookupBusy] = useState(false);
  const [visitorLookupMessage, setVisitorLookupMessage] = useState("");
  const [visitorPublicProfiles, setVisitorPublicProfiles] = useState<Readonly<Record<string, OriginsUserLookupResult>>>({});
  const webviewRef = useRef<EngineWebviewElement | null>(null);
  const gameWebviewRefs = useRef<globalThis.Map<number, EngineWebviewElement>>(new globalThis.Map());
  const gameWebviewRefCallbacks = useRef<globalThis.Map<number, (element: Element | null) => void>>(new globalThis.Map());
  const runtimeSnapshotRef = useRef<EngineRuntimeSnapshot | null>(null);
  const relayLogRef = useRef<RelayLogSnapshot | null>(null);
  const relayLogCursorRef = useRef<{ logPath: string | null; lineNumber: number }>({ logPath: null, lineNumber: 0 });
  const relayLogRefreshPromiseRef = useRef<Promise<RelayLogSnapshot | null> | null>(null);
  const clientSessionsRef = useRef<ClientSessionList | null>(null);
  const selectedClientIdRef = useRef(1);
  const selectedRuntimeSnapshotRef = useRef<EngineRuntimeSnapshot | null>(null);
  const gameWebviewRecoveryAtRef = useRef<globalThis.Map<number, number>>(new globalThis.Map());
  const userPluginHostRef = useRef<RendererUserPluginHost | null>(null);

  const setPluginUiValue = useCallback((pluginId: string, key: string, value: SchemaPrimitiveValue) => {
    setPluginRuntimeUiById((current) => {
      const existing = current[pluginId] ?? {};
      return {
        ...current,
        [pluginId]: {
          ...existing,
          values: {
            ...(existing.values ?? {}),
            [key]: value,
          },
        },
      };
    });
  }, []);

  const setPersistentHideListRecords = useCallback((records: readonly HideListEntry[]) => {
    setHideListRecords(records);
    setPluginUiValue("hide-list", "entries", serializeHideListEntries(records));
  }, [setPluginUiValue]);
  const userPluginRequestHandlerRef = useRef<(plugin: PluginDefinition, request: UserPluginHostRequest) => Promise<unknown>>(
    async () => {
      throw new Error("Plugin host is not ready.");
    },
  );
  const userPluginLogHandlerRef = useRef<(plugin: PluginDefinition, level: "info" | "warning" | "error", message: string) => void>(() => undefined);
  const userPluginRoomUsersRef = useRef<UserPluginRoomUserCache | null>(null);
  const userPluginRoomObjectsRef = useRef<UserPluginRoomObjectCache | null>(null);
  const userPluginChatRef = useRef<UserPluginChatCache | null>(null);
  const userPluginPacketCursorRef = useRef<{ readonly logPath: string | null; readonly lineNumber: number; readonly initialized: boolean }>({
    logPath: null,
    lineNumber: 0,
    initialized: false,
  });
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const packetListRef = useRef<HTMLDivElement | null>(null);
  const packetListScrollFrameRef = useRef<number | null>(null);
  const packetConsoleListRef = useRef<HTMLDivElement | null>(null);
  const packetConsolePacketListRef = useRef<HTMLDivElement | null>(null);
  const packetConsoleScrollFrameRef = useRef<number | null>(null);
  const injectionFileInputRef = useRef<HTMLInputElement | null>(null);
  const dmNotificationInitializedRef = useRef(false);
  const dmNotificationSeenKeysRef = useRef<globalThis.Map<number, globalThis.Set<string>>>(new globalThis.Map());
  const dmNotificationQueueRef = useRef<globalThis.Map<number, PacketMessengerMessage[]>>(new globalThis.Map());
  const dmNotificationFlushInFlightRef = useRef(false);
  const pluginClientRightsOwnersRef = useRef<PluginClientRightsOwners>(new globalThis.Map());
  const managedRuntimeCleanupInFlightRef = useRef(false);
  const preferenceDefaultsAppliedRef = useRef(false);
  const shellUiMenuEventSeenRef = useRef(false);
  const [gameWebviewMountEpoch, setGameWebviewMountEpoch] = useState(0);
  const [mountedVisibleClientIds, setMountedVisibleClientIds] = useState<ReadonlySet<number>>(() => new globalThis.Set([1]));

  const availablePlugins = pluginRegistryState?.plugins ?? plugins;
  const availablePluginById = useMemo(
    () => new globalThis.Map(availablePlugins.map((plugin) => [plugin.id, plugin] as const)),
    [availablePlugins],
  );
  const pluginEnabledById = pluginRegistryState?.enabledById ?? state.plugins.enabledById;
  const disabledRuntimeManagedClientRights = useMemo(
    () => disabledManagedClientRights(availablePlugins, pluginEnabledById),
    [availablePlugins, pluginEnabledById],
  );
  const pluginSurfaceEnabledByPluginId = pluginRegistryState?.uiSurfaceEnabledByPluginId ?? state.plugins.uiSurfaceEnabledByPluginId;
  const socialPrivateMessageNotificationsEnabled = socialDmNotificationsEnabled(pluginEnabledById, pluginSurfaceEnabledByPluginId);
  const pinnedPluginIds = useMemo(
    () => new Set(pluginRegistryState?.pinnedPluginIds ?? ["connection", "plugin-manager", "settings"]),
    [pluginRegistryState?.pinnedPluginIds],
  );

  const railPlugins = useMemo(() => {
    return availablePlugins.filter((plugin) =>
      plugin.id !== "plugin-manager" &&
      plugin.id !== "settings" &&
      (pinnedPluginIds.has(plugin.id) || pluginEnabledById[plugin.id] !== false),
    );
  }, [availablePlugins, pinnedPluginIds, pluginEnabledById]);

  const filteredPlugins = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return railPlugins;
    return railPlugins.filter((plugin) => {
      const text = [plugin.name, plugin.category, plugin.summary, ...plugin.capabilities].join(" ").toLowerCase();
      return text.includes(normalized);
    });
  }, [query, railPlugins]);
  const savedSelectedPlugin = availablePlugins.find((plugin) => plugin.id === state.selectedPluginId) ?? getPluginById(state.selectedPluginId) ?? availablePlugins[0] ?? plugins[0];
  const selectedPlugin = savedSelectedPlugin;
  const selectedProfile =
    libraryState?.profiles.find((profile) => profile.profileRoot === libraryState.selectedProfileRoot) ??
    engineLaunch?.profile ??
    null;
  const selectedClientSession =
    clientSessions?.sessions.find((session) => session.id === clientSessions.selectedClientId) ??
    clientSessions?.sessions.find((session) => session.selected) ??
    clientSessions?.sessions[0] ??
    null;
  const selectedClientId = selectedClientSession?.id ?? selectedClientSnapshot?.selectedClientId ?? clientSessions?.selectedClientId ?? 1;
  const selectedClientIsVisible = selectedClientSession?.visible !== false;
  const selectedClientEngineUrl =
    selectedClientSession && selectedClientIsVisible && selectedClientSession.status === "running"
      ? selectedClientSession.embeddedUrl ?? ""
      : "";
  const engineUrl = selectedClientSession
    ? selectedClientIsVisible
      ? selectedClientEngineUrl || (selectedClientId === 1 ? engineLaunch?.embeddedUrl ?? "" : "")
      : ""
    : engineLaunch?.embeddedUrl ?? "";
  const availableVisibleGameViews = useMemo(() => {
    const byClientId = new globalThis.Map<number, GameWebviewMount>();
    for (const session of clientSessions?.sessions ?? []) {
      if (!session.visible || session.headless || session.status !== "running") continue;
      const url = session.embeddedUrl || (session.id === 1 ? engineLaunch?.embeddedUrl ?? "" : "");
      if (!url) continue;
      byClientId.set(session.id, {
        id: session.id,
        label: session.label,
        url,
        partition: gameWebviewPartitionForClient(session.id),
      });
    }
    if (engineLaunch?.embeddedUrl && !byClientId.has(1)) {
      byClientId.set(1, {
        id: 1,
        label: clientSessions?.sessions.find((session) => session.id === 1)?.label ?? "Main",
        url: engineLaunch.embeddedUrl,
        partition: gameWebviewPartitionForClient(1),
      });
    }
    return [...byClientId.values()].sort((left, right) => left.id - right.id);
  }, [clientSessions?.sessions, engineLaunch?.embeddedUrl]);
  const availableVisibleGameViewKey = availableVisibleGameViews.map((view) => `${view.id}:${view.url}`).join("|");
  const mountedVisibleGameViews = useMemo(
    () =>
      availableVisibleGameViews.filter(
        (view) => mountedVisibleClientIds.has(view.id) || (view.id === selectedClientId && selectedClientIsVisible),
      ),
    [availableVisibleGameViews, mountedVisibleClientIds, selectedClientId, selectedClientIsVisible],
  );
  const hasMountedVisibleGameViews = mountedVisibleGameViews.length > 0;
  const selectedRuntimeSnapshot = selectedClientIsVisible ? runtimeSnapshot : null;
  const roomReady = Boolean(selectedRuntimeSnapshot?.roomReady?.ready ?? selectedRuntimeSnapshot?.roomEntryState?.roomReady?.ready);
  const privateRoomReady = roomReady && runtimeRoomType(selectedRuntimeSnapshot) === "private";
  const desktopBridgeAvailable = Boolean(window.shockless);
  const profileImportRunning = profileImportUi.running;
  const profileImportElapsedMs =
    profileImportRunning && profileImportUi.startedAt
      ? Math.max(0, profileImportNow - profileImportUi.startedAt)
      : profileImportUi.latest?.elapsedMs ?? (profileImportUi.startedAt ? Math.max(0, profileImportNow - profileImportUi.startedAt) : 0);
  const mainMimicSourceId = clientSessions?.mainClientId ?? 1;
  const mainClientSession = clientSessions?.sessions.find((session) => session.id === mainMimicSourceId) ?? null;
  const mimicSourceSession = clientSessions?.sessions.find((session) => session.id === mimicState?.sourceClientId) ?? null;
  const mimicTargetSessions = (clientSessions?.sessions ?? []).filter((session) => mimicState?.targetClientIds.includes(session.id));
  const packetEntries = relayLog?.entries ?? [];
  useEffect(() => {
    clientSessionsRef.current = clientSessions;
  }, [clientSessions]);
  useEffect(() => {
    selectedClientIdRef.current = selectedClientId;
  }, [selectedClientId]);
  useEffect(() => {
    selectedRuntimeSnapshotRef.current = selectedRuntimeSnapshot;
  }, [selectedRuntimeSnapshot]);
  const clientPluginSnapshotsById = useMemo(
    () =>
      clientPluginSnapshotMapFromSources({
        relayLog,
        sessions: clientSessions?.sessions ?? [],
        selectedClientId,
        selectedRuntimeSnapshot,
        selectedClientSnapshot,
      }),
    [clientSessions?.sessions, relayLog, selectedClientId, selectedClientSnapshot, selectedRuntimeSnapshot],
  );
  const clientPluginSnapshotList = useMemo(() => [...clientPluginSnapshotsById.values()], [clientPluginSnapshotsById]);
  const selectedClientPluginSnapshot = clientPluginSnapshotsById.get(selectedClientId) ?? null;
  const selectedClientRelayLog = selectedClientPluginSnapshot?.relay ?? null;
  const packetPanelActive = selectedPlugin.id === "packet-log";
  const relayDerivedState = useMemo(() => relayDerivedStateFromSnapshot(selectedClientRelayLog), [selectedClientRelayLog]);
  const packetInfoState = selectedClientPluginSnapshot?.packetInfo ?? emptyPacketInfoState;
  const packetInventoryState = selectedClientPluginSnapshot?.packetInventory ?? emptyPacketInventoryState;
  const packetWallItemState = selectedClientPluginSnapshot?.packetWallItems ?? emptyPacketWallItemState;
  const userPluginsNeedRelayLog = useMemo(
    () =>
      availablePlugins.some((plugin) =>
        plugin.origin === "user" &&
        pluginEnabledById[plugin.id] !== false &&
        (
          pluginHasPermission(plugin, "events.packet") ||
          pluginHasPermission(plugin, "packet.read") ||
          pluginHasPermission(plugin, "packet.intercept") ||
          pluginHasPermission(plugin, "packet.inject")
        ),
      ),
    [availablePlugins, pluginEnabledById],
  );
  const latestClientPacket = relayDerivedState.latestClientPacket;
  const latestServerPacket = relayDerivedState.latestServerPacket;
  const relaySessionId = compactValue(relayDerivedState.latestSessionId);
  const relayEncryptionState = relayEncryptionSummary(relayDerivedState);
  const relayBodyLoggingState = relayBodyLoggingSummary(relayDerivedState);
  const relayClientModes = relayModeSummary(relayDerivedState.clientModes);
  const relayServerModes = relayModeSummary(relayDerivedState.serverModes);
  const userRows = selectedRuntimeSnapshot?.userState?.users ?? [];
  const selectedUser = userRows.find((user) => user.rowId === selectedUserKey) ?? userRows[0] ?? null;
  const selectedUserName = userDisplayName(selectedUser, selectedRuntimeSnapshot?.userState?.sessionUserName);
  const selfUser = useMemo(() => {
    const sessionName = String(selectedRuntimeSnapshot?.userState?.sessionUserName ?? "").trim().toLowerCase();
    if (!sessionName) return selectedUser;
    return userRows.find((user) => userDisplayName(user, selectedRuntimeSnapshot?.userState?.sessionUserName).trim().toLowerCase() === sessionName) ?? selectedUser;
  }, [selectedRuntimeSnapshot?.userState?.sessionUserName, selectedUser, userRows]);
  const packetProfileUsers = selectedClientPluginSnapshot?.profileUsers ?? [];
  const packetProfileIndex = selectedClientPluginSnapshot?.profileIndex ?? emptyPacketProfileIndex;
  const visibleActiveAccountNames = useMemo(
    () =>
      uniqueUsefulNames([
        selectedRuntimeSnapshot?.userState?.sessionUserName,
        selectedClientSession?.username,
        selectedClientSnapshot?.client?.username,
        selectedClientSnapshot?.runtime?.userName,
        userRows.find((user) => user.rowId === "0") ? userDisplayName(userRows.find((user) => user.rowId === "0") ?? null, selectedRuntimeSnapshot?.userState?.sessionUserName) : null,
      ]),
    [
      selectedClientSession?.username,
      selectedClientSnapshot?.client?.username,
      selectedClientSnapshot?.runtime?.userName,
      selectedRuntimeSnapshot?.userState?.sessionUserName,
      userRows,
    ],
  );
  const selectedPacketProfileUser = useMemo(
    () => selectPacketProfileUser(packetProfileIndex, selectedUserName, selectedUser),
    [packetProfileIndex, selectedUser, selectedUserName],
  );
  const packetChatEntries = selectedClientPluginSnapshot?.packetChatEntries ?? [];
  const packetChatHistory = useMemo(
    () =>
      packetChatEntries.map((entry) =>
        packetChatRuntimeEntry(entry, packetProfileIndex, userRows, selectedRuntimeSnapshot?.userState?.sessionUserName),
      ),
    [packetChatEntries, packetProfileIndex, selectedRuntimeSnapshot?.userState?.sessionUserName, userRows],
  );
  const filteredPacketFriends = useMemo(() => {
    const normalized = socialFriendFilter.trim().toLowerCase();
    if (!normalized) return packetInfoState.friends;
    return packetInfoState.friends.filter((friend) => packetFriendSearchText(friend).includes(normalized));
  }, [packetInfoState.friends, socialFriendFilter]);
  const onlinePacketFriends = packetInfoState.friends.filter((friend) => friend.online).length;
  const socialRequestCount = packetInfoState.friendRequests.length > 0
    ? String(packetInfoState.friendRequests.length)
    : packetInfoState.messengerRequestCount;
  const socialMessageCount = packetInfoState.privateMessages.length > 0
    ? String(packetInfoState.privateMessages.length)
    : packetInfoState.messengerMessageCount;
  const visiblePrivateMessages = packetInfoState.privateMessages.slice(-6).reverse();
  const visibleFriendRequests = packetInfoState.friendRequests.slice(-6).reverse();
  const runtimeInventoryItems = selectedRuntimeSnapshot?.inventory?.items ?? [];
  const runtimeInventoryRows = useMemo(
    () => runtimeInventoryItems.map((item) => runtimeInventoryDisplayRow(item, furniMetadata)),
    [furniMetadata, runtimeInventoryItems],
  );
  const packetInventoryRows = useMemo(
    () => packetInventoryState.items.map((item) => packetInventoryDisplayRow(item, furniMetadata)),
    [furniMetadata, packetInventoryState.items],
  );
  const inventoryUsesPacketRows = runtimeInventoryRows.length === 0 && packetInventoryRows.length > 0;
  const inventoryRows = inventoryUsesPacketRows ? packetInventoryRows : runtimeInventoryRows;
  const filteredInventoryRows = useMemo(() => {
    const normalized = inventoryFilter.trim().toLowerCase();
    if (!normalized) return inventoryRows;
    return inventoryRows.filter((row) => row.searchText.includes(normalized));
  }, [inventoryFilter, inventoryRows]);
  const selectedInventoryRow = filteredInventoryRows.find((row) => row.key === selectedInventoryKey) ?? filteredInventoryRows[0] ?? null;
  const inventoryTotalCount = inventoryUsesPacketRows
    ? packetInventoryState.totalCount
    : selectedRuntimeSnapshot?.inventory?.totalCount ?? selectedRuntimeSnapshot?.inventory?.itemCount ?? packetInventoryState.totalCount;
  const inventoryRowCount = inventoryUsesPacketRows ? packetInventoryState.totalCount : selectedRuntimeSnapshot?.inventory?.itemCount ?? runtimeInventoryRows.length;
  const inventoryFloorCount = inventoryUsesPacketRows ? packetInventoryState.floorCount : selectedRuntimeSnapshot?.inventory?.floorCount ?? 0;
  const inventoryWallCount = inventoryUsesPacketRows ? packetInventoryState.wallCount : selectedRuntimeSnapshot?.inventory?.wallCount ?? 0;
  const selectedUserAccountId = profileValue(selectedUser?.accountId, selectedPacketProfileUser?.accountId);
  const selectedUserIndex = profileValue(selectedUser?.roomIndex, selectedPacketProfileUser?.index);
  const selectedUserGender = profileValue(selectedUser?.gender, selectedPacketProfileUser?.gender);
  const selectedUserType = profileValue(selectedUser?.userType ?? selectedUser?.objectClass ?? selectedUser?.className, selectedPacketProfileUser?.userType);
  const selectedUserBadgeCode = profileValue(selectedUser?.badgeCode, selectedPacketProfileUser?.badgeCode);
  const selectedUserMotto = profileValue(selectedUser?.motto, selectedPacketProfileUser?.motto);
  const selectedUserPosition = profileValue(userPosition(selectedUser), selectedPacketProfileUser?.position);
  const selectedUserFigure = profileValue(selectedUser?.figure, selectedPacketProfileUser?.figure);
  const selectedUserPoolFigure = profileValue(selectedUser?.poolFigure, selectedPacketProfileUser?.poolFigure);
  const activeStoredUserLook = selectedStoredUserLook || userStoredLooks[0] || "";
  const sourceChatHistory = selectedRuntimeSnapshot?.chatHistory ?? [];
  const activeChatSourceHistory = sourceChatHistory.length > 0 ? sourceChatHistory : packetChatHistory;
  const chatHistory = useMemo(() => [...chatRoomMarkers, ...activeChatSourceHistory], [activeChatSourceHistory, chatRoomMarkers]);
  const visibleChatHistory = chatHistory
    .slice(Math.min(chatClearOffset, chatHistory.length))
    .filter((entry) => chatFilters[chatEntryKind(entry)]);
  const visitorRoomKey = roomReady ? `${runtimeRoomType(selectedRuntimeSnapshot)}:${runtimeRoomId(selectedRuntimeSnapshot)}` : "";
  const visitorRoomName = roomReady ? runtimeRoomName(selectedRuntimeSnapshot) : "-";
  const visitorEntries = useMemo(
    () =>
      Object.values(visitorState.entries).sort((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [visitorState.entries],
  );
  const enrichedVisitorEntries = useMemo(
    () =>
      visitorEntries.map((entry) => {
        if (entry.accountId !== "-") return entry;
        const profile = visitorPublicProfiles[entry.name.trim().toLowerCase()];
        if (!profile?.ok || !profile.id) return entry;
        return {
          ...entry,
          accountId: profile.id,
          sourceKeys: [...entry.sourceKeys, "official-origins-public-api"],
        };
      }),
    [visitorEntries, visitorPublicProfiles],
  );
  const filteredVisitorEntries = useMemo(() => {
    const normalized = visitorFilter.trim().toLowerCase();
    if (!normalized) return enrichedVisitorEntries;
    return enrichedVisitorEntries.filter((entry) => visitorSearchText(entry).includes(normalized));
  }, [enrichedVisitorEntries, visitorFilter]);
  const missingVisitorAccountIds = enrichedVisitorEntries.filter((entry) => entry.accountId === "-").length;
  const runtimeSourceItemRows = useMemo<readonly ItemRow[]>(() => runtimeItemRows(selectedRuntimeSnapshot), [selectedRuntimeSnapshot?.roomObjects]);
  const packetWallItemRows = useMemo<readonly ItemRow[]>(
    () => packetWallItemState.items.map((item) => packetWallItemRow(item)),
    [packetWallItemState.items],
  );
  const runtimeWallItemRows = runtimeSourceItemRows.filter((row) => row.kind === "wall");
  const itemRows = useMemo<readonly ItemRow[]>(() => {
    if (runtimeWallItemRows.length > 0 || packetWallItemRows.length === 0) return runtimeSourceItemRows;
    return [...runtimeSourceItemRows, ...packetWallItemRows];
  }, [packetWallItemRows, runtimeSourceItemRows, runtimeWallItemRows.length]);
  const filteredItemRows = useMemo(() => {
    const normalized = itemFilter.trim().toLowerCase();
    if (!normalized) return itemRows;
    return itemRows.filter((row) => itemRowSearchText(row, furniMetadata).includes(normalized));
  }, [furniMetadata, itemFilter, itemRows]);
  const selectedItemRow = itemRows.find((row) => row.key === selectedItemKey) ?? filteredItemRows[0] ?? null;
  const selectedItemMetadata = furniInfoForObject(furniMetadata, selectedItemRow?.item);
  const itemWallCount =
    runtimeWallItemRows.length > 0
      ? selectedRuntimeSnapshot?.roomObjects?.counts.wallItems ?? runtimeWallItemRows.length
      : packetWallItemState.itemCount;
  const wallMoverRows = useMemo(() => itemRows.filter((row) => row.kind === "wall"), [itemRows]);
  const selectedWallMoverRow = wallMoverRows.find((row) => row.key === selectedWallMoverKey) ?? wallMoverRows[0] ?? null;
  const selectedWallMoverLocation = wallMoverLocation(selectedWallMoverRow?.item);
  const selectedWallMoverItemId = objectNumericId(selectedWallMoverRow?.item);
  const wallItemAnywhereEnabled = pluginEnabledById["wall-item-anywhere"] !== false;
  const floorItemAnywhereEnabled = pluginEnabledById["floor-item-anywhere"] !== false;
  const hideListPluginEnabled = pluginEnabledById["hide-list"] !== false;
  const hideListEntries = useMemo(() => hideListRecords.map((entry) => entry.target), [hideListRecords]);
  const effectiveHiddenUserEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: string[] = [];
    const push = (value: string) => {
      const clean = value.trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(clean);
    };
    if (hideListPluginEnabled) for (const entry of hideListEntries) push(entry);
    for (const entriesForPlugin of Object.values(apiHiddenUserEntriesByPluginId)) {
      for (const entry of entriesForPlugin) push(entry);
    }
    return entries;
  }, [apiHiddenUserEntriesByPluginId, hideListEntries, hideListPluginEnabled]);
  const effectiveHiddenUserSignature = effectiveHiddenUserEntries.join("\n");

  usePluginRuntimeOverrides({
    availablePlugins,
    pluginEnabledById,
    apiHiddenUserEntriesByPluginId,
    effectiveHiddenUserEntries,
    effectiveHiddenUserSignature,
    engineUrl,
    gameWebviewMountEpoch,
    selectedClientId,
    selectedClientIsVisible,
    wallItemAnywhereEnabled,
    floorItemAnywhereEnabled,
    webviewRef,
    setApiHiddenUserEntriesByPluginId,
    setHideListMessage,
    setWallAnywhereMessage,
    setFloorAnywhereMessage,
  });
  const deferredPacketSearch = useDeferredValue(packetFilters.search);
  const deferredPacketConsoleQuery = useDeferredValue(packetConsoleQuery);
  const historyFilterClientId = packetConsoleOpen
    ? Number(packetConsoleClientFilter)
    : Number(packetFilters.clientSession);
  const packetEntriesWithHistory = useMemo(() => {
    if (
      !packetHistory ||
      !relayLog ||
      packetHistory.logPath !== relayLog.logPath ||
      !Number.isInteger(historyFilterClientId) ||
      historyFilterClientId !== packetHistory.clientId
    ) {
      return packetEntries;
    }
    const bySourceLine = new globalThis.Map<string, RelayLogEntry>();
    for (const entry of packetHistory.entries) {
      bySourceLine.set(`${entry.clientId ?? packetHistory.clientId}:${entry.sourceLineNumber}`, entry);
    }
    for (const entry of packetEntries) {
      bySourceLine.set(`${entry.clientId ?? 1}:${entry.sourceLineNumber}`, entry);
    }
    return [...bySourceLine.values()].sort((left, right) => left.sourceLineNumber - right.sourceLineNumber);
  }, [historyFilterClientId, packetEntries, packetHistory, relayLog]);
  const packetSessionChoices = relayDerivedState.sessionChoices;
  const packetClientChoices = useMemo(() => {
    const choices = new globalThis.Map<string, string>();
    for (const session of clientSessions?.sessions ?? []) {
      choices.set(String(session.id), `client${session.id} ${session.label}`);
    }
    for (const entry of packetEntries) {
      if (entry.clientId === null) continue;
      choices.set(String(entry.clientId), `client${entry.clientId} ${entry.clientLabel ?? ""}`.trim());
    }
    return [
      { value: "All", label: "All clients" },
      ...[...choices.entries()]
        .sort((left, right) => Number(left[0]) - Number(right[0]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [clientSessions?.sessions, packetEntries]);
  const visiblePacketEntries = useMemo(() => {
    if (!packetPanelActive) return [];
    const search = deferredPacketSearch.trim().toLowerCase();
    return packetEntriesWithHistory.filter((entry) => {
      if (entry.lineNumber <= packetClearAfterLine) return false;
      if (entry.direction === "CLIENT" && !packetFilters.client) return false;
      if (entry.direction === "SERVER" && !packetFilters.server) return false;
      if (entry.direction === "RELAY" && !packetFilters.relay) return false;
      if (!packetClientMatches(entry, packetFilters.clientSession)) return false;
      if (packetFilters.session !== "All" && entry.sessionId !== packetFilters.session) return false;
      if (search && !relayEntrySearchText(entry).includes(search)) return false;
      return true;
    });
  }, [deferredPacketSearch, packetClearAfterLine, packetEntriesWithHistory, packetFilters.client, packetFilters.clientSession, packetFilters.relay, packetFilters.server, packetFilters.session, packetPanelActive]);
  const packetConsolePacketEntries = useMemo(() => {
    if (!packetConsoleOpen) return [];
    const search = deferredPacketConsoleQuery.trim().toLowerCase();
    return packetEntriesWithHistory.filter((entry) => {
      if (entry.lineNumber <= packetClearAfterLine) return false;
      if (!packetClientMatches(entry, packetConsoleClientFilter)) return false;
      if (!search) return true;
      return relayEntrySearchText(entry).includes(search);
    });
  }, [deferredPacketConsoleQuery, packetClearAfterLine, packetConsoleClientFilter, packetConsoleOpen, packetEntriesWithHistory]);
  const packetConsoleSuggestions = useMemo(
    () => packetConsoleOpen ? packetConsoleSuggestionsForInput(packetConsoleInput, consoleCommandState, pluginRegistryState) : [],
    [consoleCommandState, packetConsoleInput, packetConsoleOpen, pluginRegistryState],
  );
  const packetConsoleTranscript = useMemo(() => {
    let commandIndex = -1;
    for (let index = packetConsoleEntries.length - 1; index >= 0; index -= 1) {
      const entry = packetConsoleEntries[index];
      if (entry?.kind === "command") {
        commandIndex = index;
        break;
      }
    }
    return {
      command: commandIndex >= 0 ? packetConsoleEntries[commandIndex] ?? null : null,
      output: packetConsoleEntries
        .slice(commandIndex >= 0 ? commandIndex + 1 : Math.max(0, packetConsoleEntries.length - 80))
        .filter((entry) => entry.kind !== "command")
        .slice(-80),
    };
  }, [packetConsoleEntries]);
  const packetConsoleSuggestionTargetPrefix = useMemo(
    () => consoleSuggestionParts(packetConsoleInput).targetPrefix,
    [packetConsoleInput],
  );
  const packetVirtualRange = useMemo(
    () => virtualPacketRange(visiblePacketEntries.length, packetListScrollTop),
    [packetListScrollTop, visiblePacketEntries.length],
  );
  const renderedPacketEntries = useMemo(
    () => visiblePacketEntries.slice(packetVirtualRange.start, packetVirtualRange.end),
    [packetVirtualRange.end, packetVirtualRange.start, visiblePacketEntries],
  );
  const packetConsoleVirtualRange = useMemo(
    () =>
      virtualPacketRange(
        packetConsolePacketEntries.length,
        packetConsoleScrollTop,
        PACKET_CONSOLE_ROW_HEIGHT,
        PACKET_CONSOLE_RENDER_ROWS,
        PACKET_CONSOLE_OVERSCAN_ROWS,
      ),
    [packetConsolePacketEntries.length, packetConsoleScrollTop],
  );
  const renderedPacketConsoleEntries = useMemo(
    () => packetConsolePacketEntries.slice(packetConsoleVirtualRange.start, packetConsoleVirtualRange.end),
    [packetConsolePacketEntries, packetConsoleVirtualRange.end, packetConsoleVirtualRange.start],
  );
  const selectedPacketEntry = packetPanelActive
    ? packetEntries.find((entry) => entry.id === selectedPacketKey) ?? visiblePacketEntries[visiblePacketEntries.length - 1] ?? null
    : null;
  const handlePacketListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (packetListScrollFrameRef.current !== null) window.cancelAnimationFrame(packetListScrollFrameRef.current);
    packetListScrollFrameRef.current = window.requestAnimationFrame(() => {
      packetListScrollFrameRef.current = null;
      startTransition(() => {
        setPacketListScrollTop(nextScrollTop);
      });
    });
  }, []);
  const handlePacketConsoleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (packetConsoleScrollFrameRef.current !== null) window.cancelAnimationFrame(packetConsoleScrollFrameRef.current);
    packetConsoleScrollFrameRef.current = window.requestAnimationFrame(() => {
      packetConsoleScrollFrameRef.current = null;
      startTransition(() => {
        setPacketConsoleScrollTop(nextScrollTop);
      });
    });
  }, []);
  const selectedInjectionSnippet = injectionSnippets.find((snippet) => snippet.id === selectedInjectionSnippetId) ?? null;

  const applyEngineLaunch = useCallback((launch: EngineLaunchState) => {
    setEngineLaunch(launch);
    dispatch({
      type: "mergeEngineStatus",
      status: {
        running: launch.status === "running",
        embedded: Boolean(launch.embeddedUrl),
        profileLabel: launch.profile ? profileLine(launch.profile) : "No Shockless profile attached",
        buildLabel: launch.buildLabel,
        location:
          launch.status === "running"
            ? "Shockless embedded"
            : launch.status === "ready"
              ? "Shockless ready"
              : launch.status === "error"
                ? "Embed error"
                : "Shell preview",
      },
    });
  }, []);

  const appendTimeline = useCallback((severity: "info" | "success" | "warning" | "error", message: string) => {
    dispatch({
      type: "appendTimeline",
      entry: {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: new Date().toLocaleTimeString(),
        severity,
        message,
      },
    });
  }, []);

  const updateAppPreferencePatch = useCallback(
    async (patch: AppPreferencesPatch, message: string, severity: "success" | "warning" = "success") => {
      if (!window.shockless?.setAppPreferences) return;
      const next = await window.shockless.setAppPreferences(patch);
      setAppPreferences(next);
      setBridgeMessage(message);
      appendTimeline(severity, message);
    },
    [appendTimeline],
  );

  const saveAppPreferencePatchQuietly = useCallback(async (patch: AppPreferencesPatch) => {
    if (!window.shockless?.setAppPreferences) return;
    const next = await window.shockless.setAppPreferences(patch);
    setAppPreferences(next);
  }, []);

  const updateHardwareAccelerationPreference = useCallback(
    async (enabled: boolean) => {
      const restartRequired = enabled !== (appPreferences?.hardwareAccelerationActive ?? true);
      const restartNote = restartRequired ? " Restart Shockless to apply it." : "";
      await updateAppPreferencePatch(
        { hardwareAcceleration: enabled },
        `Hardware acceleration preference ${enabled ? "enabled" : "disabled"}.${restartNote}`,
        restartRequired ? "warning" : "success",
      );
    },
    [appPreferences?.hardwareAccelerationActive, updateAppPreferencePatch],
  );

  const saveSessionDefaultPreferences = useCallback(async () => {
    const patch: AppPreferencesPatch = {
      defaultAccountFile: multiAccountFile,
      defaultAccountCount: clampMultiAccountCount(multiAccountCount),
      defaultAccountConcurrency: clampMultiAccountConcurrency(multiAccountConcurrency),
      defaultAccountKeyEnv: multiAccountKeyEnv,
      defaultSummonTarget: multiAccountSummonTarget,
      defaultLoadMode: multiAccountLoadMode,
      autoSubmitVisibleLogin: appPreferences?.autoSubmitVisibleLogin !== false,
    };
    await updateAppPreferencePatch(patch, "Session defaults saved.");
  }, [
    appPreferences?.autoSubmitVisibleLogin,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    multiAccountKeyEnv,
    multiAccountLoadMode,
    multiAccountSummonTarget,
    updateAppPreferencePatch,
  ]);

  const openMultiAccountPanel = useCallback(() => {
    dispatch({ type: "selectPlugin", pluginId: "multi-account" });
    setPluginStoreOpen(true);
    setMultiAccountMessage("Choose Load Visible to start another switchable client, or Load Headless for background clients.");
    appendTimeline("info", "Opened Multi Account controls.");
  }, [appendTimeline]);

  const refreshClientSessions = useCallback(async () => {
    if (!window.shockless) return null;
    const sessions = await window.shockless.getClientSessions();
    setClientSessions(sessions);
    return sessions;
  }, []);

  const refreshSelectedClientSnapshot = useCallback(async (clientId?: number, options: { readonly updateSelectedSnapshot?: boolean } = {}) => {
    if (!window.shockless?.getClientSnapshot) return null;
    const snapshot = await window.shockless.getClientSnapshot(clientId);
    const shouldUpdateSelectedSnapshot =
      options.updateSelectedSnapshot !== false &&
      (clientId === undefined || clientId === selectedClientIdRef.current);
    if (shouldUpdateSelectedSnapshot) setSelectedClientSnapshot(snapshot);
    setClientSessions((current) => mergeClientSummaryIntoList(current, snapshot));
    return snapshot;
  }, []);

  const refreshConsoleCommandState = useCallback(async () => {
    if (!window.shockless?.getConsoleCommandState) return null;
    const snapshot = await window.shockless.getConsoleCommandState();
    setConsoleCommandState(snapshot);
    return snapshot;
  }, []);

  const refreshMimicState = useCallback(async () => {
    if (!window.shockless?.getMimicState) return null;
    const snapshot = await window.shockless.getMimicState();
    setMimicState(snapshot);
    return snapshot;
  }, []);

  const selectClientSession = useCallback(
    async (clientId: number) => {
      if (!window.shockless) return;
      const sessions = await window.shockless.selectClientSession(clientId);
      setClientSessions(sessions);
      const launch = await window.shockless.getEngineLaunchState().catch(() => null);
      if (launch) applyEngineLaunch(launch);
      void refreshSelectedClientSnapshot(clientId);
      void refreshMimicState();
      appendTimeline(sessions.selectedClientId === clientId ? "success" : "warning", sessions.message);
    },
    [appendTimeline, applyEngineLaunch, refreshMimicState, refreshSelectedClientSnapshot],
  );

  const setGameWebviewElement = useCallback((clientId: number, element: Element | null) => {
    const webview = element as EngineWebviewElement | null;
    const current = gameWebviewRefs.current.get(clientId) ?? null;
    if (webview) {
      if (current === webview) return;
      gameWebviewRefs.current.set(clientId, webview);
      setGameWebviewMountEpoch((epoch) => epoch + 1);
      return;
    }
    if (current) {
      gameWebviewRefs.current.delete(clientId);
      setGameWebviewMountEpoch((epoch) => epoch + 1);
    }
  }, []);

  const gameWebviewRefForClient = useCallback(
    (clientId: number) => {
      const current = gameWebviewRefCallbacks.current.get(clientId);
      if (current) return current;
      const callback = (element: Element | null) => setGameWebviewElement(clientId, element);
      gameWebviewRefCallbacks.current.set(clientId, callback);
      return callback;
    },
    [setGameWebviewElement],
  );

  const waitForVisibleClientWebview = useCallback(
    async (clientId: number): Promise<EngineWebviewElement | null> => {
      setMountedVisibleClientIds((current) => (current.has(clientId) ? current : new globalThis.Set([...current, clientId])));
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const webview = gameWebviewRefs.current.get(clientId);
        if (webview) return webview;
        await delay(250);
      }
      return null;
    },
    [],
  );

  useEffect(() => {
    if (availableVisibleGameViews.length === 0) return;
    setMountedVisibleClientIds((current) => {
      let changed = false;
      const next = new globalThis.Set(current);
      for (const view of availableVisibleGameViews) {
        if (next.has(view.id)) continue;
        next.add(view.id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [availableVisibleGameViewKey, availableVisibleGameViews]);

  useEffect(() => {
    const availableIds = new globalThis.Set(availableVisibleGameViews.map((view) => view.id));
    setMountedVisibleClientIds((current) => {
      const next = new globalThis.Set([...current].filter((clientId) => availableIds.has(clientId)));
      return next.size === current.size && [...next].every((clientId) => current.has(clientId)) ? current : next;
    });
  }, [availableVisibleGameViewKey, availableVisibleGameViews]);

  useEffect(() => {
    webviewRef.current = gameWebviewRefs.current.get(selectedClientId) ?? null;
  }, [gameWebviewMountEpoch, mountedVisibleGameViews, selectedClientId]);

  const recoverGameWebview = useCallback((clientId: number, reason: string) => {
    const now = Date.now();
    const previous = gameWebviewRecoveryAtRef.current.get(clientId) ?? Number.NEGATIVE_INFINITY;
    if (now - previous < 60_000) return false;
    const webview = gameWebviewRefs.current.get(clientId);
    if (!webview?.reload) return false;
    gameWebviewRecoveryAtRef.current.set(clientId, now);
    window.shockless?.reportRuntimeHealth({
      at: new Date(now).toISOString(),
      scope: "game-webview",
      clientId,
      state: "recovery-started",
      details: { reason },
    });
    window.setTimeout(() => webview.reload?.(), 500);
    return true;
  }, []);

  const applyRuntimeSnapshot = useCallback((snapshot: EngineRuntimeSnapshot) => {
    const stableSnapshot = reuseStableRuntimeDetails(runtimeSnapshotRef.current, snapshot);
    runtimeSnapshotRef.current = stableSnapshot;
    const rendererHealth = stableSnapshot.rendererHealth;
    if (rendererHealth?.contextState) {
      window.shockless?.reportRuntimeHealth({
        at: new Date().toISOString(),
        scope: "engine-renderer",
        clientId: selectedClientIdRef.current,
        state: `context-${rendererHealth.contextState}`,
        details: {
          backend: rendererHealth.backend ?? "unknown",
          contextLossCount: rendererHealth.contextLossCount ?? 0,
          contextRestoreCount: rendererHealth.contextRestoreCount ?? 0,
          lastContextLossAt: rendererHealth.lastContextLossAt ?? null,
          lastContextRestoreAt: rendererHealth.lastContextRestoreAt ?? null,
        },
      });
      if (rendererHealth.contextState === "lost" && Number(rendererHealth.contextLostForMs ?? 0) >= 8_000) {
        recoverGameWebview(selectedClientIdRef.current, "webgl-context-not-restored");
      }
    }
    const summary = summarizeRuntimeSnapshot(stableSnapshot);
    startTransition(() => {
      setRuntimeSnapshot(stableSnapshot);
      dispatch({
        type: "mergeEngineStatus",
        status: summary.engine,
      });
      dispatch({
        type: "mergeRoomSummary",
        room: summary.room,
      });
      dispatch({
        type: "mergeAccountSummary",
        account: summary.account,
      });
    });
  }, [recoverGameWebview]);

  const refreshRuntimeSnapshot = useCallback(async (scopes: readonly EngineRuntimeSnapshotScope[] = ["full"]) => {
    const webview = webviewRef.current;
    if (!webview || !engineUrl) return null;
    const snapshot = await readEngineRuntimeSnapshot(webview, scopes);
    applyRuntimeSnapshot(snapshot);
    return snapshot;
  }, [applyRuntimeSnapshot, engineUrl, selectedClientId]);

  const dispatchUserPluginRelayBatch = useCallback((snapshot: RelayLogDeltaSnapshot) => {
    const cursor = userPluginPacketCursorRef.current;
    if (snapshot.reset || !cursor.initialized || cursor.logPath !== snapshot.logPath) {
      userPluginPacketCursorRef.current = {
        logPath: snapshot.logPath,
        lineNumber: snapshot.reset ? snapshot.nextLineNumber : snapshot.afterLineNumber,
        initialized: true,
      };
      if (snapshot.reset) return;
    }

    const host = userPluginHostRef.current;
    let nextLineNumber = userPluginPacketCursorRef.current.lineNumber;
    if (host) {
      for (const entry of snapshot.entries) {
        if (entry.lineNumber <= nextLineNumber || entry.header === null) continue;
        const packet = pluginRelayPacketPayload(entry, snapshot.updatedAt);
        host.dispatchEvent("packet", packet);
        if (packet.direction === "client" || packet.direction === "server") {
          host.dispatchEvent(`packet.${packet.direction}`, packet);
        }
      }
    }
    nextLineNumber = Math.max(nextLineNumber, snapshot.nextLineNumber);
    userPluginPacketCursorRef.current = {
      logPath: snapshot.logPath,
      lineNumber: nextLineNumber,
      initialized: true,
    };
  }, []);

  const refreshRelayLog = useCallback((): Promise<RelayLogSnapshot | null> => {
    const api = window.shockless;
    if (!api) return Promise.resolve(null);
    if (relayLogRefreshPromiseRef.current) return relayLogRefreshPromiseRef.current;

    const task = (async () => {
      let current = relayLogRef.current;
      if (!current) {
        const snapshot = await api.getRelayLogSnapshot();
        ingestClientPluginRelaySnapshot(snapshot);
        current = mergeRelayLogSnapshot(null, snapshot);
        relayLogCursorRef.current = { logPath: snapshot.logPath, lineNumber: snapshot.totalLines };
        if (!userPluginPacketCursorRef.current.initialized || userPluginPacketCursorRef.current.logPath !== snapshot.logPath) {
          userPluginPacketCursorRef.current = { logPath: snapshot.logPath, lineNumber: snapshot.totalLines, initialized: true };
        }
      } else {
        let cursor = relayLogCursorRef.current.logPath === current.logPath
          ? relayLogCursorRef.current.lineNumber
          : current.totalLines;
        for (let chunk = 0; chunk < 100; chunk += 1) {
          const delta = await api.getRelayLogDeltaSnapshot(current.logPath, cursor);
          ingestClientPluginRelaySnapshot(delta);
          dispatchUserPluginRelayBatch(delta);
          current = mergeRelayLogSnapshot(current, delta);
          cursor = delta.nextLineNumber;
          relayLogCursorRef.current = { logPath: delta.logPath, lineNumber: cursor };
          if (!delta.hasMore) break;
        }
      }

      relayLogRef.current = current;
      setRelayLog(current);
      return current;
    })();
    relayLogRefreshPromiseRef.current = task;
    const release = () => {
      if (relayLogRefreshPromiseRef.current === task) relayLogRefreshPromiseRef.current = null;
    };
    void task.then(release, release);
    return task;
  }, [dispatchUserPluginRelayBatch]);

  const loadOlderPacketHistory = useCallback(async () => {
    const clientId = Number(packetConsoleOpen ? packetConsoleClientFilter : packetFilters.clientSession);
    if (!window.shockless || !relayLog || !Number.isInteger(clientId) || clientId <= 0 || packetHistoryLoading) return;
    const existing = packetHistory?.logPath === relayLog.logPath && packetHistory.clientId === clientId
      ? packetHistory.entries
      : [];
    const live = relayLog.entries.filter((entry) => entry.clientId === clientId || (clientId === 1 && entry.clientId === null));
    const firstSourceLineNumber = [...existing, ...live].reduce(
      (first, entry) => Math.min(first, entry.sourceLineNumber),
      Number.POSITIVE_INFINITY,
    );
    setPacketHistoryLoading(true);
    try {
      const page = await window.shockless.getRelayLogHistoryPage(
        clientId,
        Number.isFinite(firstSourceLineNumber) ? firstSourceLineNumber : null,
        500,
      );
      setPacketHistory((current) => {
        const currentEntries = current?.logPath === relayLog.logPath && current.clientId === clientId ? current.entries : [];
        const byLine = new globalThis.Map<number, RelayLogEntry>();
        for (const entry of page.entries) byLine.set(entry.sourceLineNumber, entry);
        for (const entry of currentEntries) byLine.set(entry.sourceLineNumber, entry);
        const entries = [...byLine.values()].sort((left, right) => left.sourceLineNumber - right.sourceLineNumber);
        return {
          logPath: relayLog.logPath,
          clientId,
          entries: entries.length > RELAY_LOG_HISTORY_ENTRY_LIMIT ? entries.slice(0, RELAY_LOG_HISTORY_ENTRY_LIMIT) : entries,
          hasMore: page.hasMore,
        };
      });
    } finally {
      setPacketHistoryLoading(false);
    }
  }, [packetConsoleClientFilter, packetConsoleOpen, packetFilters.clientSession, packetHistory, packetHistoryLoading, relayLog]);

  useEffect(() => {
    if (packetHistory && relayLog?.logPath !== packetHistory.logPath) setPacketHistory(null);
  }, [packetHistory, relayLog?.logPath]);

  const refreshFurniMetadata = useCallback(async () => {
    if (!window.shockless) return null;
    const snapshot = await window.shockless.getFurniMetadataSnapshot();
    setFurniMetadata(snapshot);
    return snapshot;
  }, []);

  useEffect(() => {
    return window.shockless?.onShowAbout?.(() => setAboutOpen(true));
  }, []);

  useEffect(() => {
    return window.shockless?.onShellUiHiddenChanged?.((hidden) => {
      shellUiMenuEventSeenRef.current = true;
      setShellUiHidden(hidden);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.code !== "Backquote" && event.key !== "`") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTextEntryTarget(event.target)) return;
      event.preventDefault();
      setPacketConsoleOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    void refreshConsoleCommandState();
  }, [refreshConsoleCommandState]);

  useEffect(() => {
    void refreshMimicState();
  }, [refreshMimicState]);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    void refreshSelectedClientSnapshot(clientSessions?.selectedClientId);
  }, [clientSessions?.selectedClientId, desktopBridgeAvailable, refreshSelectedClientSnapshot]);

  useEffect(() => {
    if (!packetConsoleOpen) return;
    void refreshRelayLog();
    void refreshConsoleCommandState();
  }, [packetConsoleOpen, refreshConsoleCommandState, refreshRelayLog]);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    if (selectedPlugin.id !== "multi-account" && !packetConsoleOpen && !mimicState?.enabled) return;
    const timer = window.setInterval(() => {
      void refreshMimicState();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [desktopBridgeAvailable, mimicState?.enabled, packetConsoleOpen, refreshMimicState, selectedPlugin.id]);

  useEffect(() => {
    relayLogRef.current = relayLog;
  }, [relayLog]);

  useEffect(
    () => () => {
      if (packetListScrollFrameRef.current !== null) window.cancelAnimationFrame(packetListScrollFrameRef.current);
      if (packetConsoleScrollFrameRef.current !== null) window.cancelAnimationFrame(packetConsoleScrollFrameRef.current);
    },
    [],
  );

  const exportVisiblePacketLog = useCallback(() => {
    if (visiblePacketEntries.length === 0) {
      setPacketExportMessage("No visible packet rows to export.");
      return;
    }
    const body = visiblePacketEntries.map((entry) => relayEntryPlain(entry, relayLog?.updatedAt)).join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `shockless-packets-${stamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setPacketExportMessage(`Prepared export for ${visiblePacketEntries.length} visible rows.`);
  }, [relayLog?.updatedAt, visiblePacketEntries]);

  const runRuntimeAction = useCallback(
    async (action: EngineRuntimeAction) => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl) {
        setRuntimeMessage("Start the embedded client before using actions.");
        return;
      }
      setRuntimeBusy(true);
      try {
        const result = await runEngineRuntimeAction(webview, action);
        setRuntimeMessage(result.message);
        appendTimeline(result.ok ? "success" : "warning", result.message);
        await refreshRuntimeSnapshot();
      } finally {
        setRuntimeBusy(false);
      }
    },
    [appendTimeline, engineUrl, refreshRuntimeSnapshot, selectedClientId],
  );

  const readStageInputMetrics = useCallback(async (): Promise<StageInputMetrics | null> => {
    const webview = webviewRef.current;
    if (!webview || !engineUrl || !selectedClientIsVisible) return null;
    const value = await webview.executeJavaScript("(() => window.__engine?.dev?.stageInputMetrics?.() ?? null)()");
    return normalizeStageInputMetrics(value);
  }, [engineUrl, selectedClientIsVisible, selectedClientId]);

  const userNameLabelSettings = useMemo(
    () => ({
      sourceYOffset: clampNameLabelOffset(userNameLabelOffset),
      selfColor: normalizeNameLabelColor(userNameLabelSelfColor),
      otherColor: normalizeNameLabelColor(userNameLabelOtherColor),
    }),
    [userNameLabelOffset, userNameLabelOtherColor, userNameLabelSelfColor],
  );

  const nativeKeyBindSettings = useMemo(
    () => ({
      shift: normalizeNativeBindValue(nativeBindShift, "Shift"),
      control: normalizeNativeBindValue(nativeBindControl, "Control"),
      option: normalizeNativeBindValue(nativeBindOption, "Alt"),
      command: normalizeNativeBindValue(nativeBindCommand, "Control"),
    }),
    [nativeBindCommand, nativeBindControl, nativeBindOption, nativeBindShift],
  );

  const applyUserNameLabelRuntime = useCallback(
    async (
      enabled = engineUserNameLabels,
      settings = userNameLabelSettings,
      options: { readonly announce?: boolean } = {},
    ): Promise<EngineRuntimeActionResult | null> => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl || !selectedClientIsVisible) {
        if (options.announce) setRuntimeMessage("Start a visible embedded client before using username labels.");
        return null;
      }
      const result = await runEngineRuntimeAction(webview, { kind: "setUserNameLabels", enabled, settings });
      setRuntimeMessage(result.message);
      if (options.announce) appendTimeline(result.ok ? "success" : "warning", result.message);
      return result;
    },
    [appendTimeline, engineUrl, engineUserNameLabels, selectedClientIsVisible, userNameLabelSettings],
  );

  const applyNativeKeyBindsRuntime = useCallback(
    async (
      bindings = nativeKeyBindSettings,
      options: { readonly announce?: boolean } = {},
    ): Promise<EngineRuntimeActionResult | null> => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl || !selectedClientIsVisible) {
        if (options.announce) setRuntimeMessage("Start a visible embedded client before using native in-game binds.");
        return null;
      }
      const result = await runEngineRuntimeAction(webview, { kind: "setNativeKeyBinds", bindings });
      setRuntimeMessage(result.message);
      if (options.announce) appendTimeline(result.ok ? "success" : "warning", result.message);
      return result;
    },
    [appendTimeline, engineUrl, nativeKeyBindSettings, selectedClientIsVisible],
  );

  const applyCustomHabboCursorRuntime = useCallback(
    async (
      enabled = customHabboCursor,
      options: { readonly announce?: boolean } = {},
    ): Promise<EngineRuntimeActionResult | null> => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl || !selectedClientIsVisible) {
        if (options.announce) setRuntimeMessage("Start a visible embedded client before changing the Habbo cursor.");
        return null;
      }
      const result = await runEngineRuntimeAction(webview, { kind: "setCustomHabboCursor", enabled });
      setRuntimeMessage(result.message);
      if (options.announce) appendTimeline(result.ok ? "success" : "warning", result.message);
      return result;
    },
    [appendTimeline, customHabboCursor, engineUrl, selectedClientIsVisible],
  );

  const applyPerformanceOverridesRuntime = useCallback(
    async (
      values = { smoothAvatars, smoothUi, perfTrace },
      options: { readonly announce?: boolean } = {},
    ): Promise<EngineRuntimeActionResult[] | null> => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl || !selectedClientIsVisible) {
        if (options.announce) setRuntimeMessage("Start a visible embedded client before changing performance overrides.");
        return null;
      }
      const actions: EngineRuntimeAction[] = [
        { kind: "setSmoothAvatars", enabled: values.smoothAvatars },
        { kind: "setSmoothUi", enabled: values.smoothUi },
        { kind: "setPerfTrace", enabled: values.perfTrace },
      ];
      const results: EngineRuntimeActionResult[] = [];
      for (const action of actions) {
        const result = await runEngineRuntimeAction(webview, action);
        results.push(result);
      }
      const failed = results.find((result) => !result.ok);
      setRuntimeMessage(failed?.message ?? "Performance overrides updated.");
      if (options.announce) appendTimeline(failed ? "warning" : "success", failed?.message ?? "Performance overrides updated.");
      return results;
    },
    [appendTimeline, engineUrl, perfTrace, selectedClientIsVisible, smoothAvatars, smoothUi],
  );

  const setEmbeddedRoomZoom = useCallback(
    async (scale: 1 | 2) => {
      const normalized = scale === 2 ? 2 : 1;
      const webview = webviewRef.current;
      if (!webview || !engineUrl) {
        if (normalized === 1) setGameZoom(1);
        setRuntimeMessage("Start the embedded client before using room zoom.");
        return;
      }
      setRuntimeBusy(true);
      try {
        const result = await runEngineRuntimeAction(webview, { kind: "setRoomStageZoom", scale: normalized });
        setRuntimeMessage(result.message);
        appendTimeline(result.ok ? "success" : "warning", result.message);
        if (result.ok) setGameZoom(normalized);
        await refreshRuntimeSnapshot();
      } finally {
        setRuntimeBusy(false);
      }
    },
    [appendTimeline, engineUrl, refreshRuntimeSnapshot, selectedClientId],
  );

  useEffect(() => {
    if (!privateRoomReady && gameZoom !== 1) void setEmbeddedRoomZoom(1);
  }, [gameZoom, privateRoomReady, setEmbeddedRoomZoom]);

  const sendUserAction = useCallback(
    async (action: UserRelayAction, label: string, clientId?: number) => {
      if (!window.shockless) {
        const message = "Run the Electron shell before sending User packets.";
        setRuntimeMessage(message);
        return;
      }
      setRuntimeBusy(true);
      try {
        const targetClientId = clientId ?? selectedClientId;
        const result = await window.shockless.sendUserRelayAction(action, targetClientId);
        setRuntimeMessage(result.message);
        appendTimeline(result.ok ? "success" : "warning", `${label}: ${result.message}`);
        await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      } finally {
        setRuntimeBusy(false);
      }
    },
    [appendTimeline, refreshRelayLog, refreshRuntimeSnapshot, selectedClientId],
  );

  const sendSocialAction = useCallback(
    async (action: SocialRelayAction, label: string, clientId?: number) => {
      if (!window.shockless) {
        const message = "Run the Electron shell before sending Social packets.";
        setSocialMessage(message);
        appendTimeline("warning", message);
        return { ok: false, message };
      }
      const targetClientId = clientId ?? selectedClientId;
      const result = await window.shockless.sendSocialRelayAction(action, targetClientId);
      setSocialMessage(result.message);
      appendTimeline(result.ok ? "success" : "warning", `${label}: ${result.message}`);
      await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      return result;
    },
    [appendTimeline, refreshRelayLog, refreshRuntimeSnapshot, selectedClientId],
  );

  const sendWallMoverAction = useCallback(
    async (action: WallMoverRelayAction, label: string, clientId?: number) => {
      if (!window.shockless) {
        const message = "Run the Electron shell before sending Wall Mover packets.";
        setWallMoverMessage(message);
        appendTimeline("warning", message);
        return { ok: false, message };
      }
      const targetClientId = clientId ?? selectedClientId;
      const result = await window.shockless.sendWallMoverRelayAction(action, targetClientId);
      setWallMoverMessage(result.message);
      appendTimeline(result.ok ? "success" : "warning", `${label}: ${result.message}`);
      await Promise.all([refreshRuntimeSnapshot().catch(() => null), refreshRelayLog().catch(() => null)]);
      return result;
    },
    [appendTimeline, refreshRelayLog, refreshRuntimeSnapshot, selectedClientId],
  );

  const sendWallMoverMove = useCallback(
    async (dx: number, dy: number, orientationOverride?: "l" | "r") => {
      const row = selectedWallMoverRow;
      const itemId = objectNumericId(row?.item);
      const location = wallMoverLocation(row?.item);
      const step = Math.max(1, Math.min(50, Math.trunc(Number.parseInt(wallMoverStep, 10) || 1)));
      setWallMoverStep(String(step));
      if (!row || itemId === null || !location) {
        const message = "Select a wall item with parsed wall/local coordinates first.";
        setWallMoverMessage(message);
        appendTimeline("warning", message);
        return;
      }
      const orientation = orientationOverride ?? location.orientation;
      const action: WallMoverRelayAction = {
        action: "moveItem",
        itemId,
        wallX: location.wallX,
        wallY: location.wallY,
        localX: location.localX + dx * step,
        localY: location.localY + dy * step,
        orientation,
        className: compactValue(row.item.className ?? row.item.name),
      };
      await sendWallMoverAction(action, `Wall move item ${itemId}`);
    },
    [appendTimeline, selectedWallMoverRow, sendWallMoverAction, wallMoverStep],
  );

  const sendWallMoverPickup = useCallback(async () => {
    const row = selectedWallMoverRow;
    const itemId = objectNumericId(row?.item);
    if (!row || itemId === null) {
      const message = "Select a wall item before pickup.";
      setWallMoverMessage(message);
      appendTimeline("warning", message);
      return;
    }
    await sendWallMoverAction(
      {
        action: "pickup",
        itemId,
        className: compactValue(row.item.className ?? row.item.name),
      },
      `Wall pickup item ${itemId}`,
    );
  }, [appendTimeline, selectedWallMoverRow, sendWallMoverAction]);

  const refreshStageClickCaptureCount = useCallback(() => {
    setStageClickCaptureCount(pendingStageClickRequestsRef.current.length);
  }, []);

  const rejectPendingStageClicksForPlugin = useCallback((pluginId: string, message: string) => {
    const remaining: typeof pendingStageClickRequestsRef.current = [];
    for (const request of pendingStageClickRequestsRef.current) {
      if (request.pluginId !== pluginId) {
        remaining.push(request);
        continue;
      }
      if (request.timeout !== null) window.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    pendingStageClickRequestsRef.current = remaining;
    refreshStageClickCaptureCount();
  }, [refreshStageClickCaptureCount]);

  const handleStageCapturePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      const localX = event.clientX - target.getBoundingClientRect().left;
      const localY = event.clientY - target.getBoundingClientRect().top;
      void (async () => {
        const metrics = await readStageInputMetrics().catch(() => null);
        const point = stagePointFromWebviewPoint(localX, localY, metrics);
        const pending = pendingStageClickRequestsRef.current;
        pendingStageClickRequestsRef.current = [];
        for (const request of pending) {
          if (request.timeout !== null) window.clearTimeout(request.timeout);
          request.resolve({ ...point, clientId: selectedClientId });
        }
        refreshStageClickCaptureCount();
      })();
    },
    [readStageInputMetrics, refreshStageClickCaptureCount, selectedClientId],
  );

  useEffect(() => {
    for (const plugin of availablePlugins) {
      if (pluginEnabledById[plugin.id] !== false) continue;
      rejectPendingStageClicksForPlugin(plugin.id, `${plugin.name} is disabled.`);
    }
  }, [availablePlugins, pluginEnabledById, rejectPendingStageClicksForPlugin]);

  const appendPacketConsole = useCallback((kind: PacketConsoleEntry["kind"], text: string) => {
    setPacketConsoleEntries((current) => {
      const next = [
        ...current,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          time: new Date().toLocaleTimeString(),
          kind,
          text,
        },
      ];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const executeConsoleRendererActions = useCallback(
    async (actions: readonly ConsoleRendererAction[], output: (kind: PacketConsoleEntry["kind"], text: string) => void = appendPacketConsole) => {
      if (actions.length === 0) return;
      setRuntimeBusy(true);
      try {
        for (const action of actions) {
          if (action.kind === "enterPrivateRoom") {
            const webview = await waitForVisibleClientWebview(action.clientId);
            if (!webview) {
              output("warning", `client${action.clientId}: visible runtime did not mount for room entry.`);
              continue;
            }
            const result = await runEngineRuntimeAction(webview, {
              kind: "enterPrivateRoom",
              flatId: action.flatId,
              waitUntilReady: action.reason !== "summon",
              timeoutMs: action.reason === "summon" ? 15000 : undefined,
            });
            output(result.ok ? "success" : "warning", `client${action.clientId}: ${result.message}`);
            if (result.ok) {
              const snapshot = await readEngineRuntimeSnapshot(webview, ["core", "room"]).catch(() => null);
              if (snapshot && action.clientId === selectedClientIdRef.current) applyRuntimeSnapshot(snapshot);
            }
            await refreshSelectedClientSnapshot(action.clientId, { updateSelectedSnapshot: action.clientId === selectedClientIdRef.current }).catch(() => null);
            await refreshClientSessions().catch(() => null);
          }
        }
      } finally {
        setRuntimeBusy(false);
      }
    },
    [
      appendPacketConsole,
      applyRuntimeSnapshot,
      refreshClientSessions,
      refreshSelectedClientSnapshot,
      waitForVisibleClientWebview,
    ],
  );

  const runMultiAccountCommand = useCallback(
    async (input: string): Promise<void> => {
      if (!window.shockless?.runConsoleCommand) {
        setMultiAccountMessage("Desktop bridge is not available.");
        return;
      }
      const busInput = withVisibleConsoleContext(input, selectedClientIsVisible ? selectedRuntimeSnapshot : null, visibleActiveAccountNames);
      const result = await window.shockless.runConsoleCommand(busInput);
      const actionCount = result.rendererActions?.length ?? 0;
      const message = [result.lines.join("\n"), actionCount > 0 ? `${actionCount} visible runtime action(s) queued.` : ""].filter(Boolean).join("\n");
      setMultiAccountMessage(message);
      appendTimeline(result.ok ? "success" : "warning", message || redactConsoleCommandInput(input));
      await refreshConsoleCommandState().catch(() => null);
      const sessions = await refreshClientSessions().catch(() => null);
      await refreshMimicState().catch(() => null);
      const nextSelectedClientId = sessions?.selectedClientId ?? clientSessions?.selectedClientId;
      await refreshSelectedClientSnapshot(nextSelectedClientId).catch(() => null);
      if (actionCount > 0) {
        await executeConsoleRendererActions(result.rendererActions ?? [], (kind, text) => {
          appendTimeline(kind === "success" ? "success" : kind === "error" ? "error" : "warning", text);
          setMultiAccountMessage((current) => `${current}\n${text}`.trim());
        });
      }
      if (commandRefreshesEngineLaunch(result.command?.command ?? "", result.command?.args[0] ?? "")) {
        const launch = await window.shockless.getEngineLaunchState().catch(() => null);
        if (launch) applyEngineLaunch(launch);
      }
    },
    [
      appendTimeline,
      applyEngineLaunch,
      clientSessions?.selectedClientId,
      executeConsoleRendererActions,
      refreshClientSessions,
      refreshConsoleCommandState,
      refreshMimicState,
      refreshSelectedClientSnapshot,
      selectedClientIsVisible,
      selectedRuntimeSnapshot,
      visibleActiveAccountNames,
    ],
  );

  const addManualVisibleClient = useCallback(async () => {
    openMultiAccountPanel();
    await runMultiAccountCommand("newclient");
  }, [openMultiAccountPanel, runMultiAccountCommand]);

  const consoleBindingMap = useMemo(
    () => new globalThis.Map((consoleCommandState?.bindings ?? []).map((binding) => [binding.key, binding.command] as const)),
    [consoleCommandState?.bindings],
  );

  useEffect(() => {
    if (consoleBindingMap.size === 0 || !window.shockless?.runConsoleBinding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isTextEntryTarget(event.target)) return;
      const key = bindingKeyFromKeyboardEvent(event);
      if (!key || key === "Backquote") return;
      const boundCommand = consoleBindingMap.get(key);
      if (!boundCommand) return;
      event.preventDefault();
      setPacketConsoleOpen(true);
      appendPacketConsole("command", `[${key}] ${redactConsoleCommandInput(boundCommand)}`);
      void (async () => {
        const result = await window.shockless?.runConsoleBinding?.(key);
        if (!result) return;
        for (const line of result.lines) appendPacketConsole(result.level, line);
        await refreshConsoleCommandState().catch(() => null);
        await refreshClientSessions().catch(() => null);
        await refreshSelectedClientSnapshot(result.targetClientIds?.[0] ?? clientSessions?.selectedClientId).catch(() => null);
        if ((result.rendererActions?.length ?? 0) > 0) {
          await executeConsoleRendererActions(result.rendererActions ?? []);
        }
        if (commandRefreshesEngineLaunch(result.command?.command ?? "", result.command?.args[0] ?? "")) {
          const launch = await window.shockless?.getEngineLaunchState().catch(() => null);
          if (launch) applyEngineLaunch(launch);
        }
      })();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appendPacketConsole,
    applyEngineLaunch,
    clientSessions?.selectedClientId,
    consoleBindingMap,
    executeConsoleRendererActions,
    refreshClientSessions,
    refreshConsoleCommandState,
    refreshSelectedClientSnapshot,
  ]);

  const runConsoleRuntimeAction = useCallback(
    async (action: EngineRuntimeAction): Promise<EngineRuntimeActionResult> => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl) return { ok: false, message: "Start the embedded client first." };
      setRuntimeBusy(true);
      try {
        const result = await runEngineRuntimeAction(webview, action);
        setRuntimeMessage(result.message);
        appendTimeline(result.ok ? "success" : "warning", result.message);
        await refreshRuntimeSnapshot();
        return result;
      } finally {
        setRuntimeBusy(false);
      }
    },
    [appendTimeline, engineUrl, refreshRuntimeSnapshot, selectedClientId],
  );

  useEffect(() => {
    if (disabledRuntimeManagedClientRights.length === 0) return;
    if (!engineUrl || !selectedRuntimeSnapshot?.userState) return;
    const rights = matchingClientRights(selectedRuntimeSnapshot.userState.rights, disabledRuntimeManagedClientRights);
    if (rights.length === 0) return;
    if (managedRuntimeCleanupInFlightRef.current) return;
    managedRuntimeCleanupInFlightRef.current = true;
    void runConsoleRuntimeAction({
      kind: "clientRights",
      mode: "remove",
      rights,
    }).then((result) => {
      if (!result.ok) return;
      for (const plugin of availablePlugins) {
        if (pluginEnabledById[plugin.id] !== false) continue;
        removeClientRightOwners(pluginClientRightsOwnersRef.current, selectedClientId, plugin.id, rights);
      }
    }).finally(() => {
      managedRuntimeCleanupInFlightRef.current = false;
    });
  }, [availablePlugins, disabledRuntimeManagedClientRights, engineUrl, pluginEnabledById, runConsoleRuntimeAction, selectedClientId, selectedRuntimeSnapshot?.userState]);

  userPluginLogHandlerRef.current = (plugin, level, message) => {
    const severity = level === "error" ? "error" : level === "warning" ? "warning" : "info";
    appendTimeline(severity, `${plugin.name}: ${message}`);
  };

    userPluginRequestHandlerRef.current = (plugin, request) =>
    handleUserPluginRequest(
      {
        apiHiddenUserEntriesByPluginId,
        clientPluginSnapshotsById,
        clientSessionsRef,
        engineUrl,
        furniMetadata,
        gameWebviewRefs,
        pendingStageClickRequestsRef,
        pluginClientRightsOwnersRef,
        pluginEnabledById,
        refreshRelayLog,
        refreshRuntimeSnapshot,
        refreshStageClickCaptureCount,
        relayLogRef,
        runConsoleRuntimeAction,
        selectedClientIdRef,
        selectedClientIsVisible,
        selectedRuntimeSnapshotRef,
        setApiHiddenUserEntriesByPluginId,
        setFloorAnywhereMessage,
        setPluginRuntimeUiById,
        setWallAnywhereMessage,
        webviewRef,
      },
      plugin,
      request,
    );

    useUserPluginEvents({
    availablePlugins,
    chatHistory,
    clientSessions,
    furniMetadata,
    pluginEnabledById,
    relayLog,
    roomReady,
    selectedClientId,
    selectedClientSession,
    selectedRuntimeSnapshot,
    userPluginChatRef,
    userPluginHostRef,
    userPluginLogHandlerRef,
    userPluginPacketCursorRef,
    userPluginRequestHandlerRef,
    userPluginRoomObjectsRef,
    userPluginRoomUsersRef,
  });

  const executePacketConsoleCommand = usePacketConsoleCommand({
    appPreferences,
    applyEngineLaunch,
    applyUserNameLabelRuntime,
    appendPacketConsole,
    clientSessions,
    executeConsoleRendererActions,
    packetClientChoices,
    packetConsoleInput,
    packetInfoState,
    packetProfileIndex,
    perfTrace,
    refreshClientSessions,
    refreshConsoleCommandState,
    refreshRelayLog,
    refreshRuntimeSnapshot,
    refreshSelectedClientSnapshot,
    runConsoleRuntimeAction,
    selectedClientIsVisible,
    selectedRuntimeSnapshot,
    selectedUserAccountId,
    selectedUserFigure,
    selectedUserName,
    selectedUserPosition,
    sendSocialAction,
    setEngineUserNameLabels,
    setPacketConsoleClientFilter,
    setPacketConsoleEntries,
    setPacketConsoleHistoryIndex,
    setPacketConsoleInput,
    setPacketConsoleQuery,
    setPerfTrace,
    setSmoothAvatars,
    setSmoothUi,
    smoothAvatars,
    smoothUi,
    updateAppPreferencePatch,
    userNameLabelSettings,
    userRows,
    visibleActiveAccountNames,
  });

  const hideBulletinBoard = useCallback(
    async (mode: "auto" | "manual") => {
      const webview = webviewRef.current;
      if (!webview || !engineUrl) {
        const message = "Start the embedded client before hiding the Bulletin Board.";
        setAutomationMessage(message);
        if (mode === "manual") appendTimeline("warning", message);
        return;
      }
      if (mode === "manual") setRuntimeBusy(true);
      try {
        const result = await runEngineRuntimeAction(webview, { kind: "hideBulletinBoard" });
        const message = mode === "auto" ? `Auto-hide Bulletin: ${result.message}` : result.message;
        setAutomationMessage(message);
        if (result.ok && result.result && typeof result.result === "object" && "closed" in result.result && (result.result as { closed?: unknown }).closed === false) {
          return;
        }
        appendTimeline(result.ok ? "success" : "warning", message);
        await refreshRuntimeSnapshot();
      } finally {
        if (mode === "manual") setRuntimeBusy(false);
      }
    },
    [appendTimeline, engineUrl, refreshRuntimeSnapshot, selectedClientId],
  );

    useDmNotifications({
    clientPluginSnapshotList,
    clientPluginSnapshotsById,
    dmNotificationFlushInFlightRef,
    dmNotificationInitializedRef,
    dmNotificationQueueRef,
    dmNotificationSeenKeysRef,
    engineUrl,
    gameWebviewMountEpoch,
    gameWebviewRefs,
    selectedClientId,
    selectedClientIsVisible,
    setSocialMessage,
    socialPrivateMessageNotificationsEnabled,
    webviewRef,
  });

    const {
    clearStoredUserLooks,
    copySelectedUserProfile,
    copyStoredUserLook,
    lookupMissingVisitorProfiles,
    lookupPublicUser,
    storeSelectedUserLook,
  } = useUserTools({
    activeStoredUserLook,
    appendTimeline,
    filteredVisitorEntries,
    publicLookupName,
    selectedUser,
    selectedUserAccountId,
    selectedUserBadgeCode,
    selectedUserFigure,
    selectedUserGender,
    selectedUserIndex,
    selectedUserMotto,
    selectedUserName,
    selectedUserPoolFigure,
    selectedUserPosition,
    selectedUserType,
    setPublicLookupBusy,
    setPublicLookupName,
    setPublicLookupResult,
    setSelectedStoredUserLook,
    setUserStoredLooks,
    setUserToolMessage,
    setVisitorLookupBusy,
    setVisitorLookupMessage,
    setVisitorPublicProfiles,
  });

    const {
    addInjectionSnippet,
    executeInjectionCommand,
    exportInjectionSnippets,
    importInjectionSnippets,
    loadInjectionSnippet,
    updateInjectionDraft,
  } = useInjectionActions({
    appendTimeline,
    clientSessions,
    injectionDraft,
    injectionRepeatCount,
    injectionRepeatInterval,
    injectionSendAll,
    injectionSnippets,
    refreshRelayLog,
    selectedClientId,
    setInjectionDraft,
    setInjectionHistory,
    setInjectionMessage,
    setInjectionSnippets,
    setRuntimeBusy,
    setRuntimeMessage,
    setSelectedInjectionSnippetId,
  });

  const refreshLibrary = useCallback(async () => {
    if (!window.shockless) {
      setBridgeMessage("Run the Electron shell to import or embed a Shockless client.");
      return;
    }
    const [nextAppInfo, nextPreferences, nextUpdate, nextPlugins, nextLibrary, nextLaunch] = await Promise.all([
      window.shockless.getAppInfo(),
      window.shockless.getAppPreferences(),
      window.shockless.getUpdateState(),
      window.shockless.getPluginRegistryState(),
      window.shockless.getClientLibraryState(),
      window.shockless.getEngineLaunchState(),
      refreshClientSessions(),
      refreshFurniMetadata(),
    ]);
    setAppInfo(nextAppInfo);
    setAppPreferences(nextPreferences);
    setUpdateState(nextUpdate);
    setPluginRegistryState(nextPlugins);
    setLibraryState(nextLibrary);
    setBridgeMessage(nextLibrary.message);
    applyEngineLaunch(nextLaunch);
  }, [applyEngineLaunch, refreshClientSessions, refreshFurniMetadata]);

  const { refreshUpdateState, checkForUpdates, downloadUpdate, installDownloadedUpdate, skipUpdate } = useUpdateActions({
    appendTimeline,
    setUpdateModalOpen,
    setUpdateState,
  });

  useEffect(() => {
    if (!appPreferences || preferenceDefaultsAppliedRef.current) return;
    preferenceDefaultsAppliedRef.current = true;
    setPacketFilters((current) => ({
      ...current,
      wrap: appPreferences.packetOutputWrap,
      autoscroll: appPreferences.packetOutputAutoScroll,
    }));
    if (!shellUiMenuEventSeenRef.current) setShellUiHidden(appPreferences.shellUiHidden);
    setSmoothAvatars(appPreferences.smoothAvatars);
    setSmoothUi(appPreferences.smoothUi);
    setPerfTrace(appPreferences.perfTrace);
    setMultiAccountFile(appPreferences.defaultAccountFile);
    setMultiAccountCount(String(appPreferences.defaultAccountCount));
    setMultiAccountConcurrency(String(appPreferences.defaultAccountConcurrency));
    setMultiAccountKeyEnv(appPreferences.defaultAccountKeyEnv);
    setMultiAccountSummonTarget(appPreferences.defaultSummonTarget);
    setMultiAccountLoadMode(appPreferences.defaultLoadMode);
    setEngineUserNameLabels(appPreferences.engineUserNameLabels);
    setCustomHabboCursor(appPreferences.customHabboCursor);
    setUserNameLabelOffset(clampNameLabelOffset(appPreferences.userNameLabelOffset));
    setUserNameLabelSelfColor(normalizeNameLabelColor(appPreferences.userNameLabelSelfColor));
    setUserNameLabelOtherColor(normalizeNameLabelColor(appPreferences.userNameLabelOtherColor));
    setNativeBindShift(normalizeNativeBindValue(appPreferences.nativeBindShift, "Shift"));
    setNativeBindControl(normalizeNativeBindValue(appPreferences.nativeBindControl, "Control"));
    setNativeBindOption(normalizeNativeBindValue(appPreferences.nativeBindOption, "Alt"));
    setNativeBindCommand(normalizeNativeBindValue(appPreferences.nativeBindCommand, "Control"));
  }, [appPreferences]);

  const setFallbackPluginEnabled = useCallback(
    (pluginId: string, enabled: boolean) => dispatch({ type: "setPluginEnabled", pluginId, enabled }),
    [],
  );
  const setFallbackSurfaceEnabled = useCallback(
    (pluginId: string, surfaceId: string, enabled: boolean) =>
      dispatch({ type: "setPluginUiSurfaceEnabled", pluginId, surfaceId, enabled }),
    [],
  );
  const {
    refreshPluginRegistry,
    setPluginEnabled,
    setPluginSurfaceEnabled,
    reloadPlugins,
    openPluginsFolder,
    createPluginFromTemplate,
    installPluginFromFolder,
    uninstallPlugin,
  } = usePluginManagerActions({
    appendTimeline,
    newPluginId,
    newPluginName,
    setPluginRegistryState,
    setPluginManagerMessage,
    setPluginRuntimeUiById,
    setFallbackPluginEnabled,
    setFallbackSurfaceEnabled,
  });

  const {
    importClientReference,
    selectClientProfile,
    startEngine,
    stopEngine,
    updateEngineLaunchSettings,
    applyVersionCheckBuild,
    setRealm,
    setHotelView,
  } = useEngineLifecycleActions({
    appendTimeline,
    applyEngineLaunch,
    refreshClientSessions,
    versionCheckDraft,
    setLibraryState,
    setBridgeMessage,
    setProfileImportUi,
    setEngineBusy,
  });

  const currentHotelView = engineLaunch?.settings?.customHotelView
    ? "custom"
    : engineLaunch?.settings?.entryView ?? "custom";
  const currentRealm = engineLaunch?.settings?.realm ?? "ous";
  const currentResizablePresentation = engineLaunch?.settings?.resizablePresentation !== false;
  const resizeSensitiveHotelViewSelected =
    currentResizablePresentation &&
    (currentHotelView === "hh_entry_uk" || currentHotelView === "hh_entry_es" || currentHotelView === "hh_entry_br" || currentHotelView === "hh_entry_ru");

    const { appSettingsLayout, appSettingsValues } = useAppSettingsSchema({
    appPreferences,
    automationPrefs,
    currentHotelView,
    currentRealm,
    customHabboCursor,
    engineLaunch,
    engineUserNameLabels,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    multiAccountKeyEnv,
    multiAccountLoadMode,
    multiAccountSummonTarget,
    nativeBindCommand,
    nativeBindControl,
    nativeBindOption,
    nativeBindShift,
    packetFilters,
    perfTrace,
    resizeSensitiveHotelViewSelected,
    settingsBindCommand,
    settingsBindKey,
    smoothAvatars,
    smoothUi,
    updateState,
    userNameLabelOffset,
    userNameLabelOtherColor,
    userNameLabelSelfColor,
    versionCheckDraft,
  });

    const builtInRuntimeUiById = buildBuiltInRuntimeUi({
    activeStoredUserLook,
    automationMessage,
    automationPrefs,
    availablePlugins,
    chatDraft,
    chatFilters,
    clientSessions,
    effectiveHiddenUserEntries,
    engineLaunch,
    engineProfileLabel: state.engine.profileLabel,
    engineUserNameLabels,
    filteredInventoryRows,
    filteredItemRows,
    filteredPacketFriends,
    filteredVisitorEntries,
    floorAnywhereMessage,
    floorItemAnywhereEnabled,
    furniMetadata,
    gameZoom,
    hideListMessage,
    hideListPluginEnabled,
    hideListReason,
    hideListRecords,
    hideListTarget,
    injectionDraft,
    injectionHistory,
    injectionMessage,
    injectionRepeatCount,
    injectionRepeatInterval,
    injectionSendAll,
    injectionSnippets,
    inventoryFilter,
    inventoryFloorCount,
    inventoryRowCount,
    inventoryTotalCount,
    inventoryUsesPacketRows,
    inventoryWallCount,
    itemFilter,
    itemRows,
    itemWallCount,
    latestClientPacket,
    latestServerPacket,
    mimicState,
    missingVisitorAccountIds,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    multiAccountLoadMode,
    multiAccountMessage,
    multiAccountSummonTarget,
    onlinePacketFriends,
    packetClientChoices,
    packetEntries,
    packetExportMessage,
    packetFilters,
    packetInfoState,
    packetProfileIndex,
    packetSessionChoices,
    pinnedPluginIds,
    pluginEnabledById,
    pluginRegistryState,
    publicLookupBusy,
    publicLookupName,
    publicLookupResult,
    publicRoomQuery,
    relayBodyLoggingState,
    relayClientModes,
    relayEncryptionState,
    relayLog,
    relayServerModes,
    relaySessionId,
    roomStageClickX,
    roomStageClickY,
    selectedClientId,
    selectedClientIsVisible,
    selectedClientSession,
    selectedInjectionSnippetId,
    selectedInventoryRow,
    selectedItemMetadata,
    selectedItemRow,
    selectedPacketEntry,
    selectedProfile,
    selectedRuntimeSnapshot,
    selectedStoredUserLook,
    selectedUser,
    selectedUserAccountId,
    selectedUserBadgeCode,
    selectedUserFigure,
    selectedUserGender,
    selectedUserIndex,
    selectedUserMotto,
    selectedUserName,
    selectedUserPosition,
    selectedWallMoverItemId,
    selectedWallMoverLocation,
    selectedWallMoverRow,
    socialDraft,
    socialFriendFilter,
    socialMessage,
    socialMessageCount,
    socialRequestCount,
    socialTarget,
    userRows,
    userStoredLooks,
    userToolMessage,
    visibleChatHistory,
    visibleFriendRequests,
    visiblePacketEntries,
    visiblePrivateMessages,
    visitorEntries,
    visitorFilter,
    visitorLookupBusy,
    visitorLookupMessage,
    visitorRoomName,
    visitorState,
    wallAnywhereMessage,
    wallItemAnywhereEnabled,
    wallMoverMessage,
    wallMoverRows,
    wallMoverStep,
  });

  const effectivePluginRuntimeUiById: Readonly<Record<string, RuntimePluginUiState | undefined>> = {
    ...pluginRuntimeUiById,
    ...builtInRuntimeUiById,
  };

    const handlePluginSchemaAction = usePluginSchemaActions({
    activeStoredUserLook,
    addInjectionSnippet,
    appendTimeline,
    applyUserNameLabelRuntime,
    availablePluginById,
    chatDraft,
    chatHistory,
    clearStoredUserLooks,
    copySelectedUserProfile,
    copyStoredUserLook,
    executeInjectionCommand,
    exportInjectionSnippets,
    exportVisiblePacketLog,
    gameZoom,
    hideBulletinBoard,
    hideListReason,
    hideListRecords,
    hideListTarget,
    importClientReference,
    injectionDraft,
    installPluginFromFolder,
    loadInjectionSnippet,
    lookupMissingVisitorProfiles,
    lookupPublicUser,
    multiAccountConcurrency,
    multiAccountCount,
    multiAccountFile,
    openPluginsFolder,
    packetClientChoices,
    packetEntries,
    pluginEnabledById,
    pluginSurfaceEnabledByPluginId,
    publicRoomQuery,
    refreshLibrary,
    refreshRelayLog,
    refreshRuntimeSnapshot,
    reloadPlugins,
    roomStageClickX,
    roomStageClickY,
    runConsoleRuntimeAction,
    runMultiAccountCommand,
    runRuntimeAction,
    selectClientSession,
    selectedClientId,
    selectedInjectionSnippet,
    selectedItemRow,
    sendUserAction,
    sendWallMoverMove,
    sendWallMoverPickup,
    setAutomationPrefs,
    setChatClearOffset,
    setChatDraft,
    setChatFilters,
    setEmbeddedRoomZoom,
    setEngineUserNameLabels,
    setHideListMessage,
    setHideListReason,
    setHideListTarget,
    setInjectionHistory,
    setInjectionMessage,
    setInjectionRepeatCount,
    setInjectionRepeatInterval,
    setInjectionSendAll,
    setInventoryFilter,
    setItemFilter,
    setMultiAccountConcurrency,
    setMultiAccountCount,
    setMultiAccountFile,
    setMultiAccountLoadMode,
    setPacketClearAfterLine,
    setPacketConsoleOpen,
    setPacketFilters,
    setPersistentHideListRecords,
    setPluginRuntimeUiById,
    setPluginUiValue,
    setPublicLookupName,
    setPublicRoomQuery,
    setRoomStageClickX,
    setRoomStageClickY,
    setSelectedInjectionSnippetId,
    setSelectedInventoryKey,
    setSelectedItemKey,
    setSelectedPacketKey,
    setSelectedStoredUserLook,
    setSelectedUserKey,
    setSelectedWallMoverKey,
    setSocialDraft,
    setSocialFriendFilter,
    setSocialTarget,
    setVisitorFilter,
    setWallMoverStep,
    socialDraft,
    socialTarget,
    startEngine,
    stopEngine,
    storeSelectedUserLook,
    updateAppPreferencePatch,
    updateInjectionDraft,
    userNameLabelSettings,
    userPluginHostRef,
  });

    const handleSettingsAction = useSettingsActions({
    applyCustomHabboCursorRuntime,
    applyNativeKeyBindsRuntime,
    applyPerformanceOverridesRuntime,
    applyUserNameLabelRuntime,
    applyVersionCheckBuild,
    checkForUpdates,
    engineUserNameLabels,
    nativeKeyBindSettings,
    perfTrace,
    runMultiAccountCommand,
    runRuntimeAction,
    saveAppPreferencePatchQuietly,
    saveSessionDefaultPreferences,
    setAutomationPrefs,
    setCustomHabboCursor,
    setEngineUserNameLabels,
    setRealm,
    setHotelView,
    setMultiAccountConcurrency,
    setMultiAccountCount,
    setMultiAccountFile,
    setMultiAccountKeyEnv,
    setMultiAccountLoadMode,
    setMultiAccountSummonTarget,
    setNativeBindCommand,
    setNativeBindControl,
    setNativeBindOption,
    setNativeBindShift,
    setPacketFilters,
    setPerfTrace,
    setSettingsBindCommand,
    setSettingsBindKey,
    setSmoothAvatars,
    setSmoothUi,
    settingsBindCommand,
    settingsBindKey,
    setUserNameLabelOffset,
    setUserNameLabelOtherColor,
    setUserNameLabelSelfColor,
    setVersionCheckDraft,
    smoothAvatars,
    smoothUi,
    updateAppPreferencePatch,
    updateEngineLaunchSettings,
    updateHardwareAccelerationPreference,
    userNameLabelSettings,
  });

  useProfileImportLifecycle({
    profileImportUi,
    profileImportRunning,
    refreshLibrary,
    setBooting,
    setBridgeMessage,
    setProfileImportUi,
    setProfileImportNow,
  });

  useEffect(() => {
    if (availablePlugins.some((plugin) => plugin.id === state.selectedPluginId)) return;
    dispatch({ type: "selectPlugin", pluginId: railPlugins[0]?.id ?? "connection" });
  }, [availablePlugins, railPlugins, state.selectedPluginId]);

  useEffect(() => {
    const value = engineLaunch?.settings?.versionCheckBuild ?? selectedProfile?.versionCheckBuild ?? null;
    setVersionCheckDraft(value ? String(value) : "");
  }, [engineLaunch?.settings?.versionCheckBuild, selectedProfile?.id, selectedProfile?.versionCheckBuild]);

  useLocalFeaturePersistence({
    injectionSnippets,
    injectionHistory,
    userStoredLooks,
    selectedStoredUserLook,
    automationPrefs,
    pluginRuntimeUiById,
    setInjectionSnippets,
    setInjectionHistory,
    setSelectedStoredUserLook,
  });

  useRelayLogPolling({
    packetConsoleOpen,
    selectedPluginId: selectedPlugin.id,
    userPluginsNeedRelayLog,
    refreshRelayLog,
    relayLogRef,
    relayLogCursorRef,
    setRelayLog,
  });

  useRuntimeHealthMonitoring({
    selectedClientId,
    mountedVisibleGameViews,
    gameWebviewMountEpoch,
    gameWebviewRefs,
    recoverGameWebview,
  });

  const markRuntimeLoading = useCallback(() => {
    dispatch({
      type: "mergeEngineStatus",
      status: { location: "Shockless loading" },
    });
  }, []);

  useRuntimeSnapshotPolling({
    webviewRef,
    engineUrl,
    selectedClientId,
    selectedPlugin,
    applyRuntimeSnapshot,
    markLoading: markRuntimeLoading,
  });

  useVisibleClientAutoLogin({
    enabled: appPreferences?.autoSubmitVisibleLogin !== false,
    clientSessions,
    gameWebviewMountEpoch,
    mountedVisibleGameViews,
    gameWebviewRefs,
    appendTimeline,
    refreshClientSessions,
    refreshSelectedClientSnapshot,
  });

  useRuntimePreferenceSync({
    webviewRef,
    engineUrl,
    gameWebviewMountEpoch,
    selectedClientId,
    selectedClientIsVisible,
    engineUserNameLabels,
    userNameLabelSettings,
    nativeKeyBindSettings,
    customHabboCursor,
    smoothAvatars,
    smoothUi,
    perfTrace,
    setRuntimeMessage,
  });

  useRoomSessionEffects({
    selectedRuntimeSnapshot,
    engineUrl,
    roomReady,
    autoHideBulletin: automationPrefs.autoHideBulletin,
    hideBulletinBoard,
    setChatRoomMarkers,
  });

  usePanelAutoScroll({
    selectedPluginId: selectedPlugin.id,
    chatAutoscroll: chatFilters.autoscroll,
    visibleChatCount: visibleChatHistory.length,
    packetAutoscroll: packetFilters.autoscroll,
    visiblePacketCount: visiblePacketEntries.length,
    packetConsoleOpen,
    packetConsoleEntryCount: packetConsoleEntries.length,
    packetConsolePacketCount: packetConsolePacketEntries.length,
    packetConsoleLatestPacketKey: packetConsolePacketEntries.at(-1)?.id ?? "",
    chatListRef,
    packetListRef,
    packetConsoleListRef,
    packetConsolePacketListRef,
    setPacketListScrollTop,
    setPacketConsoleScrollTop,
  });

  useVisitorTracking({
    selectedRuntimeSnapshot,
    packetProfileIndex,
    packetProfileUsers,
    roomReady,
    visitorRoomKey,
    setVisitorState,
  });

  return (
    <main className={`app-shell ${shellUiHidden ? "shell-ui-hidden" : ""}`}>
      <BootSplash booting={booting} />

      <section className="game-region" aria-label="Embedded Shockless game area">
        <TopBar
          desktopBridgeAvailable={desktopBridgeAvailable}
          engineBusy={engineBusy}
          profileImportRunning={profileImportRunning}
          engineUrl={engineUrl}
          engineLaunch={engineLaunch}
          selectedProfile={selectedProfile}
          clientSessions={clientSessions}
          selectedClientSession={selectedClientSession}
          selectedClientSnapshotLabel={state.engine.profileLabel}
          updateState={updateState}
          engineLocation={state.engine.location}
          engineEmbedded={state.engine.embedded}
          clientSessionTitle={clientSessionTitle}
          onRefresh={() => void refreshLibrary()}
          onStop={() => void stopEngine()}
          onStart={() => void startEngine()}
          onOpenPlugins={() => setPluginStoreOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUpdates={() => setUpdateModalOpen(true)}
          onSelectClientSession={(id) => void selectClientSession(id)}
          onAddManualVisibleClient={() => void addManualVisibleClient()}
        />

        <div className={`game-frame ${hasMountedVisibleGameViews ? "embedded" : ""}`}>
          <div className="game-toolbar">
            <span>GameHost</span>
            <span>{state.engine.profileLabel}</span>
          </div>
          <GameStage
            mountedVisibleGameViews={mountedVisibleGameViews}
            selectedClientId={selectedClientId}
            engineUrl={engineUrl}
            stageClickCaptureCount={stageClickCaptureCount}
            selectedClientSession={selectedClientSession}
            selectedClientIsVisible={selectedClientIsVisible}
            desktopBridgeAvailable={desktopBridgeAvailable}
            bridgeMessage={bridgeMessage}
            engineBusy={engineBusy}
            profileImportRunning={profileImportRunning}
            engineLaunch={engineLaunch}
            profileImportElapsedMs={profileImportElapsedMs}
            profileImportUi={profileImportUi}
            profiles={libraryState?.profiles ?? []}
            selectedProfile={selectedProfile}
            updateState={updateState}
            versionCheckDraft={versionCheckDraft}
            gameWebviewRefForClient={gameWebviewRefForClient}
            onStageCapturePointerDown={handleStageCapturePointerDown}
            onImport={() => void importClientReference()}
            onRefresh={() => void refreshLibrary()}
            onStart={() => void startEngine()}
            onOpenUpdates={() => setUpdateModalOpen(true)}
            onSetRealm={setRealm}
            onSetHotelView={setHotelView}
            onSetResizablePresentation={(enabled) =>
              void updateEngineLaunchSettings(
                { resizablePresentation: enabled },
                `Responsive stage resize ${enabled ? "enabled" : "disabled"}.`,
              )
            }
            onSetVersionCheckBuild={applyVersionCheckBuild}
            onVersionCheckDraftChange={setVersionCheckDraft}
          />
          <PacketConsoleOverlay
            open={packetConsoleOpen}
            packetEntriesCount={packetEntries.length}
            packetConsolePacketEntriesCount={packetConsolePacketEntries.length}
            packetConsoleQuery={packetConsoleQuery}
            packetConsoleClientFilter={packetConsoleClientFilter}
            packetClientChoices={packetClientChoices}
            packetHistoryLoading={packetHistoryLoading}
            packetHistory={packetHistory}
            relayLog={relayLog}
            transcript={packetConsoleTranscript}
            packetConsoleListRef={packetConsoleListRef}
            packetConsolePacketListRef={packetConsolePacketListRef}
            virtualRange={packetConsoleVirtualRange}
            renderedEntries={renderedPacketConsoleEntries}
            suggestions={packetConsoleSuggestions}
            suggestionTargetPrefix={packetConsoleSuggestionTargetPrefix}
            input={packetConsoleInput}
            historyIndex={packetConsoleHistoryIndex}
            commandState={consoleCommandState}
            onClientFilterChange={setPacketConsoleClientFilter}
            onLoadOlderHistory={() => void loadOlderPacketHistory()}
            onClose={() => setPacketConsoleOpen(false)}
            onPacketScroll={handlePacketConsoleScroll}
            onInputChange={setPacketConsoleInput}
            onHistoryIndexChange={setPacketConsoleHistoryIndex}
            onExecute={() => void executePacketConsoleCommand()}
          />
          <RoomOverlays
            roomPluginEnabled={pluginEnabledById.room !== false}
            roomOverlayEnabled={Boolean(pluginSurfaceEnabledByPluginId.room?.overlay)}
            devToolsPluginEnabled={pluginEnabledById["dev-tools"] !== false}
            devToolsStatusEnabled={Boolean(pluginSurfaceEnabledByPluginId["dev-tools"]?.status)}
            roomReady={roomReady}
            privateRoomReady={privateRoomReady}
            runtimeSnapshot={selectedRuntimeSnapshot}
            gameZoom={gameZoom}
            fps={state.engine.fps ?? selectedRuntimeSnapshot?.performanceStats?.currentFps ?? selectedRuntimeSnapshot?.performanceStats?.rafPerSecond ?? null}
            onCloseRoomOverlay={() => void setPluginSurfaceEnabled("room", "overlay", false)}
            onCloseFpsOverlay={() => void setPluginSurfaceEnabled("dev-tools", "status", false)}
            onZoomToggle={() => void setEmbeddedRoomZoom(gameZoom === 1 ? 2 : 1)}
          />
        </div>
      </section>

      <aside className="plugin-dock" aria-label="Plugin dock" data-selected-plugin={selectedPlugin.id}>
        <IconRail
          filteredPlugins={filteredPlugins}
          pluginEnabledById={pluginEnabledById}
          selectedPluginId={selectedPlugin.id}
          PluginIcon={PluginIcon}
          onOpenPluginManager={() => setPluginStoreOpen(true)}
          onSelectPlugin={(pluginId) => {
            dispatch({ type: "selectPlugin", pluginId });
            setPluginStoreOpen(true);
          }}
          onReorderPlugins={() => undefined}
        />
      </aside>

      <PluginStoreModal
        open={pluginStoreOpen}
        desktopBridgeAvailable={desktopBridgeAvailable}
        pluginRegistryState={pluginRegistryState}
        availablePlugins={availablePlugins}
        selectedPluginId={selectedPlugin.id}
        pluginEnabledById={pluginEnabledById}
        pluginSurfaceEnabledByPluginId={pluginSurfaceEnabledByPluginId}
        pinnedPluginIds={pinnedPluginIds}
        pluginRuntimeUiById={effectivePluginRuntimeUiById}
        pluginManagerMessage={pluginManagerMessage}
        newPluginId={newPluginId}
        newPluginName={newPluginName}
        onClose={() => setPluginStoreOpen(false)}
        onSelectPlugin={(pluginId) => dispatch({ type: "selectPlugin", pluginId })}
        onOpenPluginsFolder={() => void openPluginsFolder()}
        onInstallPluginFromFolder={() => void installPluginFromFolder()}
        onSetNewPluginId={setNewPluginId}
        onSetNewPluginName={setNewPluginName}
        onCreatePluginFromTemplate={() => void createPluginFromTemplate()}
        onSetPluginEnabled={(plugin, enabled) => void setPluginEnabled(plugin, enabled)}
        onSetPluginSurfaceEnabled={(pluginId, surfaceId, enabled) => void setPluginSurfaceEnabled(pluginId, surfaceId, enabled)}
        onUninstallPlugin={(plugin) => void uninstallPlugin(plugin)}
        onPluginSchemaAction={handlePluginSchemaAction}
        onRunCommand={(command) => {
          setPacketConsoleOpen(true);
          setPacketConsoleInput(command);
          void runMultiAccountCommand(command);
        }}
      />

      <SettingsModal
        open={settingsOpen}
        layout={appSettingsLayout}
        values={appSettingsValues}
        onClose={() => setSettingsOpen(false)}
        onAction={handleSettingsAction}
      />

      <AboutModal open={aboutOpen} appInfo={appInfo} onClose={() => setAboutOpen(false)} />
      <UpdateModal
        open={updateModalOpen}
        state={updateState}
        onClose={() => setUpdateModalOpen(false)}
        onCheck={() => void checkForUpdates()}
        onDownload={() => void downloadUpdate()}
        onInstall={() => void installDownloadedUpdate()}
        onSkip={(version) => void skipUpdate(version)}
      />
    </main>
  );
}
function AboutModal({
  open,
  appInfo,
  onClose,
}: {
  readonly open: boolean;
  readonly appInfo: { readonly name: string; readonly version: string; readonly mode: "desktop" | "browser-preview" } | null;
  readonly onClose: () => void;
}): React.ReactElement | null {
  if (!open) return null;
  return (
    <div className="about-overlay" role="presentation" onMouseDown={onClose}>
      <section className="about-modal" role="dialog" aria-modal="true" aria-label="About Shockless" onMouseDown={(event) => event.stopPropagation()}>
        <img className="about-image" src="./img/aboutimg.png" alt="Shockless" />
        <div className="about-crew">dek - jephyrr - sonicmouse - scott</div>
        <strong>Shockless Engine</strong>
        <span className="about-version">{appInfo?.version ? `v${appInfo.version}` : "development build"}</span>
        <p>Game engine &amp; companion application for Habbo Origins.</p>
        <nav className="about-links" aria-label="Shockless links">
          <a href="https://github.com/deklol/Shockless" target="_blank" rel="noreferrer">Shockless GitHub</a>
          <a href="https://discord.gg/rXgvjE4y3G" target="_blank" rel="noreferrer">Shockless Discord</a>
          <a href="https://x.com/digitalm1nd" target="_blank" rel="noreferrer">@digitalm1nd (Personal)</a>
          <a href="https://x.com/dekHabbo" target="_blank" rel="noreferrer">@dekHabbo (Habbo)</a>
        </nav>
        <p className="about-disclaimer">Shockless is not affiliated with, endorsed, sponsored, or specifically approved by Sulake Corporation Oy or its affiliates.</p>
        <button className="about-close" type="button" onClick={onClose}>Close</button>
      </section>
    </div>
  );
}
