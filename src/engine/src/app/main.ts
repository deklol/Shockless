import { Application, TextureSource, TextureStyle } from "pixi.js";
import "./host.css";
// Director arithmetic inks map to GPU blend operations, including subtract,
// Lightest, and Darkest. Pixi only honors these through this extension.
import "pixi.js/advanced-blend-modes";
import { DirectorMovie, MovieManifest } from "@director/Movie";
import { WebAudioBackend } from "@director/audio/WebAudioBackend";
import * as DirectorLingoRuntime from "@director/lingo";
import { LingoRect } from "@director/geometry";
import { CastMember, CastRegistry, setImageDecodeRequester, type BitmapInfo, type CastManifests } from "@director/members";
import { LingoImage } from "@director/imaging";
import { directorKeyForBrowserEvent } from "@director/keyboard";
import { lingoEquals, lingoKeyEquals } from "@director/ops";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { DirectorInputBindings, type DirectorModifierState } from "../habbo/ui/input/DirectorInputBindings";
import { SourceInputAutomation } from "../habbo/ui/input/SourceInputAutomation";
import { DirectorCursorPresentation } from "../habbo/ui/cursor/DirectorCursorPresentation";
import { DirectorTickScheduler } from "./DirectorTickScheduler";
import { createBrowserSteamXtraProvider } from "@director/xtras/steam/SteamXtra";
import { RendererHealthMonitor } from "./RendererHealthMonitor";
import { classifyFrameStutterPhase, FrameStutterDiagnostics } from "./FrameStutterDiagnostics";
import {
  EMPTY_AVATAR_MOTION_DIAGNOSTICS,
  AvatarMotionPresentationCollector,
  type AvatarMotionDiagnostics,
} from "../habbo/user/AvatarMotionPresentation";
import { RoomStagePresentationController } from "../habbo/room/RoomStagePresentationController";
import { RoomVisibilityController } from "../habbo/room/RoomVisibilityController";
import { UserNameLabelController } from "../habbo/user/UserNameLabelController";
import { CustomHotelViewPresentationController } from "../habbo/room/CustomHotelViewPresentationController";
import {
  coerceDebugValue,
  debugValue,
  instancePropValue,
  isSensitiveDiagnosticInvocation,
  objectManagerList,
  propListLookup,
  propListValue,
  resourceMemberIndex,
  setSignature,
  shouldHoldRoomAssetPresentation,
  summarizeList,
  summarizeListSample,
  summarizeObject,
  summarizePropList,
  summarizePropListSample,
  summarizeRoomAssetBuffer,
  summarizeRoomAssetBufferDiagnostics,
  summarizeRoomObjects,
  summarizeSprite,
  summarizeValue,
  summarizeVariables,
  summarizeVisualizer,
} from "../habbo/room/RoomRuntimeDiagnostics";
import { RoomGeometryController } from "../habbo/room/RoomGeometryController";
import { RoomNavigatorController } from "../habbo/room/RoomNavigatorController";
import { RoomReadinessController, type RoomReadySummary } from "../habbo/room/RoomReadinessController";
import { PrivateRoomEntryController } from "../habbo/room/PrivateRoomEntryController";
import { SourceWindowInteractionController } from "../habbo/ui/window/SourceWindowInteractionController";
import { SourceWindowDiagnostics } from "../habbo/ui/window/SourceWindowDiagnostics";
import {
  LINGO_VOID,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoVoid,
  numberOf,
  type LingoValue,
} from "@director/values";
import {
  externalMembersFromCastGraph,
  externalMembersFromGeneratedScripts,
  externalMembersFromVisuals,
  mergeDirectorBitmapAssets,
  palettesFromBitmapAssets,
  releaseArray,
  type BitmapPaletteSource,
  type ExternalCastRecord,
  type GeneratedScriptRecord,
  type RuntimeDataFile,
  type VisualLayoutRecord,
} from "../habbo/runtimeData";
import { installRelease306CastLoadCompatibility } from "../habbo/castLoadCompatibility";
import {
  origins306ClientVersionId,
  origins306ExternalParams,
  origins306VersionCheckClientTypeOverride,
  origins306VersionCheckExternalVariablesUrlOverride,
  overrideOrigins306ExternalVariables,
} from "../habbo/launchParams";
import { installRelease306ResourceManagerCompatibility } from "../habbo/resourceManagerCompatibility";
import { installRelease306RoomBufferCompatibility } from "../habbo/roomBufferCompatibility";
import { enableRelease306RoomAssetVariables } from "../habbo/roomAssetVariables";
import { installRelease306StringServicesCompatibility } from "../habbo/stringServicesCompatibility";
import { installRelease306TextManagerCompatibility } from "../habbo/textManagerCompatibility";
import { installOriginsVariableManagerCompatibility } from "../habbo/variableManagerCompatibility";
import { installFloorItemAnywhereCompatibility } from "../habbo/furni/floor/FloorItemAnywhereCompatibility";
import { installWallItemAnywhereCompatibility } from "../habbo/furni/wall/WallItemAnywhereCompatibility";
import { OriginsResizeEngine, type ResizeEngineSnapshot } from "../habbo/resize/OriginsResizeEngine";
import { type UserNameLabelStyleSettings } from "../habbo/user/UserNameLabels";
import {
  CUSTOM_HOTEL_VIEW_ASSETS,
  customHotelViewToolbarUnderlayHeight,
} from "../habbo/customHotelView";
import { directorCanvasImageRendering, directorRenderResolution } from "./directorPixelPolicy";
import { SceneEffectController } from "../render/SceneEffectController";
import {
  StageRenderer,
  type CustomHotelViewPresentation,
  type PresentationUnderlay,
} from "../render/StageRenderer";
import { createEngineLogger } from "./bootstrap/EnginePageLog";
import {
  FAST_ENTRY_DEFAULT_CAST_KEEP,
  createDecodeScheduler,
  deliverBitmapPixels,
  fetchImageBitmap,
  generatedScriptsForRuntimeVersion,
  limitCastEntryVariables,
  parseCastEntryKeep,
  runtimeVersionFromParams,
} from "./bootstrap/ProfileRuntimeLoader";
import {
  createCopyTraceStats,
  createRollingTimings,
  installSourcePerfTrace,
  type CopyTraceEvent,
  type CopyTraceFilter,
} from "./diagnostics/RuntimePerformanceDiagnostics";

/**
 * Boot harness: loads an Origins profile manifest, registers the generated
 * habbo.dir + fuse_client scripts, and runs the entry movie's score loop.
 * Everything that happens after this file is generated-from-source Lingo.
 */

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const mirrorEngineLogToConsole = new URLSearchParams(window.location.search).get("consoleLog") === "1";
const directorProfileRuntimeGlobal = globalThis as typeof globalThis & {
  __directorProfileRuntime?: { lingo: typeof DirectorLingoRuntime };
};
directorProfileRuntimeGlobal.__directorProfileRuntime = { lingo: DirectorLingoRuntime };
const appendLog = createEngineLogger(logEl, mirrorEngineLogToConsole);

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const traceCopyEnabled = params.get("traceCopy") === "1";
  const renderDiagnosticsEnabled = params.get("renderDiagnostics") === "1";
  const tracePerfEnabled = params.get("tracePerf") === "1";
  const runtimeVersion = runtimeVersionFromParams(params);
  const executableScripts = await generatedScriptsForRuntimeVersion(runtimeVersion, params.get("profile") ?? "");
  const resizablePresentation = params.get("resizablePresentation") === "1";
  const customHotelViewEnabled = params.get("customHotelView") === "1" || params.get("custom-hotelview") === "1";
  if (params.get("standalone") === "1") {
    document.body.dataset.standalone = "1";
  }
  if (resizablePresentation) {
    document.body.dataset.resizablePresentation = "1";
  }
  if (customHotelViewEnabled) {
    document.body.dataset.customHotelView = "1";
  }
  TextureSource.defaultOptions.scaleMode = "nearest";
  TextureStyle.defaultOptions.scaleMode = "nearest";
  const fastVisual = params.get("fastVisual") === "1";
  const defaultCastEntryLimit = params.get("fastEntry") === "1" ? 13 : 0;
  const fastEntryCastLimit = Math.max(0, Number(params.get("castEntryLimit") ?? defaultCastEntryLimit) | 0);
  const castEntryKeep = parseCastEntryKeep(params.get("castEntryKeep"));
  if (params.get("fastEntry") === "1" && params.get("fastEntryEntryOnly") !== "1") {
    for (const castName of FAST_ENTRY_DEFAULT_CAST_KEEP) {
      castEntryKeep.add(castName);
    }
  }
  const decodeConcurrency = Math.max(1, Number(params.get("decodeConcurrency") ?? 8) | 0);
  // Casts with more bitmaps than this defer decoding to on-demand (touched
  // composites decode through setImageDecodeRequester). 0 = defer everything:
  // the furni/avatar casts alone hold ~16k bitmaps / ~150MB RGBA, and eagerly
  // decoding them is what made room entry take a minute.
  const eagerDecodeMaxParam = params.get("eagerDecodeMax");
  const eagerDecodeMax =
    eagerDecodeMaxParam === null ? 120 : Math.max(0, Number(eagerDecodeMaxParam) | 0);
  const scheduleDecode = createDecodeScheduler(decodeConcurrency);
  const textCache = new Map<string, Promise<string>>();
  const bitmapDecodeCache = new Map<string, Promise<ImageBitmap | null>>();
  const runtimeDataUrl = (name: string): string => `/origins-data/runtime-data/${name}`;
  const fetchRuntimeJson = async <T>(name: string): Promise<T> => {
    const response = await fetch(runtimeDataUrl(name));
    if (!response.ok) {
      throw new Error(`Failed to load runtime-data/${name}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  };
  const fetchOptionalRuntimeJson = async <T extends RuntimeDataFile>(name: string, fallback: T): Promise<T> => {
    const response = await fetch(runtimeDataUrl(name));
    return response.ok ? ((await response.json()) as T) : fallback;
  };
  const fetchOptionalJson = async <T>(url: string, fallback: T): Promise<T> => {
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return fallback;
    }
    return (await response.json()) as T;
  };

  const manifest = await fetchRuntimeJson<MovieManifest & {
    stage: { width: number; height: number; backgroundColor: string };
  }>(`${runtimeVersion}-projectorrays-manifest.json`);

  const stageWrapEl = document.getElementById("stage-wrap")!;
  const stageViewportSize = (): { width: number; height: number } => {
    if (!resizablePresentation) {
      return { width: manifest.stage.width, height: manifest.stage.height };
    }
    const rect = stageWrapEl.getBoundingClientRect();
    return {
      width: Math.max(manifest.stage.width, Math.floor(rect.width || window.innerWidth || manifest.stage.width)),
      height: Math.max(manifest.stage.height, Math.floor(rect.height || window.innerHeight || manifest.stage.height)),
    };
  };
  const initialStageViewport = stageViewportSize();
  const renderResolution = (): number => directorRenderResolution(Number(window.devicePixelRatio) || 1);
  const app = new Application();
  await app.init({
    width: initialStageViewport.width,
    height: initialStageViewport.height,
    background: manifest.stage.backgroundColor,
    antialias: false,
    autoStart: false,
    autoDensity: true,
    resolution: renderResolution(),
    roundPixels: true,
    // Advanced blend modes (Director subtract inks) sample the backbuffer.
    useBackBuffer: true,
    // Diagnostic captures need canvas.toDataURL()/screenshots to see the
    // current WebGL frame. Keep it opt-in because preserving the drawing
    // buffer can slow normal play.
    preserveDrawingBuffer: params.get("capture") === "1",
  });
  // Shockless owns the Director tick, presentation sync, smoothing, and final
  // present in one RAF loop. Letting Pixi's ticker render on a separate clock
  // can show high FPS while live room motion appears to hitch between source
  // ticks.
  app.ticker.stop();
  let syncSceneEffectOverlay = (): void => {};
  const stageScreenWidth = (): number => Math.max(1, Math.round(app.screen.width || manifest.stage.width));
  const stageScreenHeight = (): number => Math.max(1, Math.round(app.screen.height || manifest.stage.height));
  const resizePixiStage = (width: number, height: number): boolean => {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const nextResolution = renderResolution();
    const rendererChanged =
      stageScreenWidth() !== nextWidth ||
      stageScreenHeight() !== nextHeight ||
      Math.abs(app.renderer.resolution - nextResolution) > 0.001;
    const cssWidth = `${nextWidth}px`;
    const cssHeight = `${nextHeight}px`;
    const styleChanged = app.canvas.style.width !== cssWidth || app.canvas.style.height !== cssHeight;
    if (rendererChanged) app.renderer.resize(nextWidth, nextHeight, nextResolution);
    if (app.canvas.style.width !== cssWidth) app.canvas.style.width = cssWidth;
    if (app.canvas.style.height !== cssHeight) app.canvas.style.height = cssHeight;
    if (rendererChanged) syncSceneEffectOverlay();
    return rendererChanged || styleChanged;
  };
  resizePixiStage(initialStageViewport.width, initialStageViewport.height);
  app.canvas.style.imageRendering = directorCanvasImageRendering();
  stageWrapEl.appendChild(app.canvas);
  const rendererHealthMonitor = new RendererHealthMonitor(
    app.canvas as HTMLCanvasElement,
    app.renderer.constructor?.name || "UnknownRenderer",
  );
  if (fastEntryCastLimit > 0) {
    appendLog("info", `fast entry cast limit: cast.entry.1..${fastEntryCastLimit}`);
  }
  if (castEntryKeep.size > 0) {
    appendLog("info", `fast entry cast keep (${castEntryKeep.size}): ${[...castEntryKeep].join(", ")}`);
  }
  if (fastVisual) {
    appendLog("info", "fast visual mode: bitmap buffer decode disabled");
  } else if (eagerDecodeMax > 0) {
    appendLog("info", `eager bitmap decode cap: ${eagerDecodeMax} per cast (eagerDecodeMax=0 defers all to on-demand)`);
  } else {
    appendLog("info", "eager bitmap decode disabled: all members decode on demand");
  }

  const [
    textFieldsRaw,
    externalTextFieldsRaw,
    supplementalTextFieldsRaw,
    bitmapsRaw,
    visualBitmapsRaw,
    visualLayoutsRaw,
    externalCastGraphRaw,
    profileScriptsRaw,
  ] = await Promise.all([
    fetchRuntimeJson<RuntimeDataFile>(`projectorrays-text-fields.${runtimeVersion}.json`),
    fetchRuntimeJson<RuntimeDataFile>(`external-cast-text-fields.${runtimeVersion}.json`),
    fetchOptionalRuntimeJson<RuntimeDataFile>(`external-cast-text-fields-supplement.${runtimeVersion}.json`, { releases: [{ fields: [] }] }),
    fetchRuntimeJson<RuntimeDataFile>(`external-bitmap-assets.${runtimeVersion}.json`),
    fetchRuntimeJson<RuntimeDataFile>(`visual-bitmap-assets.${runtimeVersion}.json`),
    fetchRuntimeJson<RuntimeDataFile>(`external-cast-visual-layout-index.${runtimeVersion}.json`),
    fetchRuntimeJson<RuntimeDataFile>(`external-cast-graph.${runtimeVersion}.json`),
    fetchOptionalJson<{ scripts: GeneratedScriptRecord[] }>("/origins-data/scripts/profile-script-registry.json", { scripts: [] }),
  ]);
  const textFields = [
    ...releaseArray<CastManifests["textFields"][number]>(textFieldsRaw, "fields"),
    ...releaseArray<CastManifests["textFields"][number]>(externalTextFieldsRaw, "fields"),
    ...releaseArray<CastManifests["textFields"][number]>(supplementalTextFieldsRaw, "fields"),
  ];
  const profileBitmaps = releaseArray<BitmapPaletteSource>(bitmapsRaw, "assets");
  const visualBitmaps = releaseArray<CastManifests["bitmaps"][number]>(visualBitmapsRaw, "assets");
  const palettes = [
    ...releaseArray<NonNullable<CastManifests["palettes"]>[number]>(bitmapsRaw, "palettes"),
    ...releaseArray<NonNullable<CastManifests["palettes"]>[number]>(visualBitmapsRaw, "palettes"),
    ...palettesFromBitmapAssets([...profileBitmaps, ...visualBitmaps]),
  ];
  const visualLayouts = releaseArray<VisualLayoutRecord>(visualLayoutsRaw, "visuals");
  const externalCasts = releaseArray<ExternalCastRecord>(externalCastGraphRaw, "casts");
  const profileScriptRecords = Array.isArray(profileScriptsRaw.scripts) ? profileScriptsRaw.scripts : [];
  const bitmaps = mergeDirectorBitmapAssets(profileBitmaps, visualBitmaps);
  const externalMembers = [
    ...externalMembersFromCastGraph(externalCasts),
    ...externalMembersFromVisuals(visualLayouts),
    ...externalMembersFromGeneratedScripts([...executableScripts.scripts, ...profileScriptRecords]),
  ];
  const members = new CastRegistry(
    { movie: manifest, textFields, bitmaps, palettes, externalMembers },
    "/origins-data/assets/",
  );
  members.loadCast("Internal");
  members.loadCast("fuse_client");
  appendLog(
    "info",
    `profile ${runtimeVersion}: casts loaded ${members.loaded.join(", ")} (${textFields.length} fields, ${profileBitmaps.length} profile bitmaps, ${visualBitmaps.length} visual bitmaps, ${palettes.length} palettes, ${externalMembers.length} external refs, ${profileScriptRecords.length} profile script members, executable scripts ${executableScripts.version} from ${executableScripts.source}${executableScripts.exact ? "" : " fallback"})`,
  );

  const renderer = new StageRenderer(app.stage);
  let invalidateEngineFeatureCaches = (): void => {};
  let engineFeaturePresentationsDirty = true;
  let userNameLabelsPresentationDirty = false;
  let roomMotionRefreshRequested = true;
  let sourceWindowRefreshRequested = true;
  let lastRoomMotionRefreshAt = 0;
  let lastSourceWindowRefreshAt = 0;
  let cachedManualHiddenChannels: ReadonlySet<number> = new Set();
  let cachedAvatarInterpolationChannels: ReadonlySet<number> = new Set();
  let cachedRoomMotionDiagnostics: AvatarMotionDiagnostics = EMPTY_AVATAR_MOTION_DIAGNOSTICS;
  let cachedSourceWindowChannels: ReadonlySet<number> = new Set();
  let cachedSourceWindowCount = 0;
  let userNameLabelController: UserNameLabelController | null = null;
  let customHotelViewPresentationController: CustomHotelViewPresentationController | null = null;
  let smoothAvatarsEnabled = params.get("smoothAvatars") !== "0";
  let smoothUiEnabled = params.get("smoothUi") !== "0";
  const roomMotionPresentation = new AvatarMotionPresentationCollector();
  let roomMotionPresentationDirty = true;
  let sourceWindowBudgetDirty = true;
  let lastAvatarInterpolationSettingsKey = "";
  let lastSourceWindowBudgetSettingsKey = "";
  const engineBudgetParam = (name: string, fallback: number): number => {
    const value = Number(params.get(name) ?? fallback);
    return Number.isFinite(value) ? Math.max(1, Math.min(200, Math.trunc(value))) : fallback;
  };
  const SOURCE_WINDOW_TEXT_BUDGET_PER_FRAME = engineBudgetParam("sourceWindowTextBudget", 18);
  const SOURCE_WINDOW_SPRITE_BUDGET_PER_FRAME = engineBudgetParam("sourceWindowSpriteBudget", 28);
  const DIRECTOR_CATCHUP_ENABLED = params.get("directorCatchup") === "1";
  const DIRECTOR_MAX_TICKS_PER_RAF = engineBudgetParam("directorMaxTicksPerRaf", 3);
  const DIRECTOR_CATCHUP_BUDGET_MS = engineBudgetParam("directorCatchupBudgetMs", 10);
  const DIRECTOR_CATCHUP_MAX_BACKLOG_MS = engineBudgetParam("directorCatchupMaxBacklogMs", 250);
  const directorTickScheduler = new DirectorTickScheduler({
    enabled: DIRECTOR_CATCHUP_ENABLED,
    maxTicksPerRaf: DIRECTOR_MAX_TICKS_PER_RAF,
    maxBudgetMs: DIRECTOR_CATCHUP_BUDGET_MS,
    maxBacklogMs: DIRECTOR_CATCHUP_MAX_BACKLOG_MS,
  });
  const ROOM_MOTION_REFRESH_INTERVAL_MS = 90;
  const SOURCE_WINDOW_REFRESH_INTERVAL_MS = 250;
  const frameStutterDiagnostics = new FrameStutterDiagnostics();
  frameStutterDiagnostics.setEnabled(params.get("perfTrace") === "1");
  const markEngineFeaturePresentationsDirty = (): void => {
    invalidateEngineFeatureCaches();
    engineFeaturePresentationsDirty = true;
    userNameLabelsPresentationDirty = true;
    roomMotionRefreshRequested = true;
    sourceWindowRefreshRequested = true;
    roomMotionPresentationDirty = true;
    sourceWindowBudgetDirty = true;
  };
  let renderDirty = true;
  const markStageDirty = (): void => {
    if (userNameLabelController?.isEnabled()) userNameLabelsPresentationDirty = true;
    renderDirty = true;
    renderer.markDirty();
  };
  const customHotelViewUnderlayActive = (): boolean => customHotelViewPresentationController?.isActive() ?? false;
  const syncPresentationUnderlays = (snapshot: ResizeEngineSnapshot | null): void => {
    if (!resizablePresentation || !snapshot) {
      renderer.setPresentationUnderlays([]);
      return;
    }
    const customToolbar = customHotelViewUnderlayActive();
    const underlays: PresentationUnderlay[] = [];
    for (const anchor of snapshot.anchors) {
      if (anchor.action !== "toolbar-underlay") continue;
      const sourceHeight = anchor.height ?? 54;
      underlays.push({
        id: anchor.id,
        x: anchor.x ?? 0,
        y: anchor.y ?? 0,
        width: anchor.width ?? manifest.stage.width,
        height: customToolbar ? customHotelViewToolbarUnderlayHeight(sourceHeight) : sourceHeight,
        color: customToolbar ? 0x000000 : 0x555555,
        textureUrl: customToolbar ? undefined : "/presentation/toolbar-bg-54px.png",
      });
    }
    renderer.setPresentationUnderlays(underlays);
  };
  type PresentationRenderOptions = {
    readonly forceFull?: boolean;
    readonly present?: boolean;
    readonly clearRenderDirty?: boolean;
  };
  type PresentationRenderResult = {
    readonly focusedSprite: number;
    readonly held: boolean;
    readonly prepareTextMs: number;
    readonly rendererSyncMs: number;
  };
  let roomAssetPresentationHeld = (): boolean => false;
  let prepareTextForPresentation = (activeMovie: DirectorMovie, focusedSprite: number, _forceFull: boolean): void => {
    activeMovie.prepareTextSpriteImages(focusedSprite);
  };
  let beforePresentationRender = (_activeMovie: DirectorMovie): void => {};
  let markImageMutationSerialSynced = (): void => {};
  const renderScenePresentation = (
    activeMovie: DirectorMovie,
    options: PresentationRenderOptions = {},
  ): PresentationRenderResult => {
    const focusedSprite = Number(activeMovie.keyboardFocusSprite) | 0;
    renderer.beginFrame(performance.now());
    beforePresentationRender(activeMovie);
    renderer.markDirty();
    const prepareStart = performance.now();
    prepareTextForPresentation(activeMovie, focusedSprite, Boolean(options.forceFull));
    const prepareTextMs = performance.now() - prepareStart;
    const held = roomAssetPresentationHeld();
    let rendererSyncMs = 0;
    if (!held) {
      const syncStart = performance.now();
      renderer.sync(activeMovie.channels, focusedSprite);
      rendererSyncMs = performance.now() - syncStart;
      markImageMutationSerialSynced();
      if (options.clearRenderDirty && !renderer.needsSync()) renderDirty = false;
    }
    if (options.present) app.render();
    return { focusedSprite, held, prepareTextMs, rendererSyncMs };
  };

  // Generated code touched a deferred member's image: decode it now so its
  // pending placeholder fills and journaled composites replay. Scheduled so a
  // room-entry burst stays at the decode concurrency limit.
  setImageDecodeRequester((member) => {
    const bitmap = member.bitmap;
    if (!bitmap?.pngUrl) return;
    const url = bitmap.pngUrl;
    void scheduleDecode(() => fetchImageBitmap(url, bitmapDecodeCache))
      .then((decoded) => {
        deliverBitmapPixels(bitmap, decoded);
        renderer.markDirty();
      })
      .catch(() => {
        deliverBitmapPixels(bitmap, null);
      });
  });

  const bundledBulletinImageUrls = new Map<string, string>([
    ["thumb.messenger_alert", "/img/messenger_alert.png"],
  ]);
  const bundledBulletinImageMembers = new Map<string, Promise<string>>();
  const ensureBundledBulletinImageMember = async (imageName: string): Promise<string> => {
    const url = bundledBulletinImageUrls.get(imageName);
    if (!url) return imageName;
    const cached = bundledBulletinImageMembers.get(imageName);
    if (cached) return cached;
    const promise = (async () => {
      const decoded = await scheduleDecode(() => fetchImageBitmap(url, bitmapDecodeCache));
      if (!decoded) return "thumb.system_notification";
      const existing = members.find(imageName, null);
      const member = existing instanceof CastMember && existing.number > 0
        ? existing
        : members.create("Internal", imageName, "bitmap");
      const bitmap: BitmapInfo = {
        width: decoded.width,
        height: decoded.height,
        regX: 0,
        regY: 0,
        pngUrl: url,
        decoded: LingoImage.fromDrawable(decoded, decoded.width, decoded.height),
      };
      member.type = "bitmap";
      member.bitmap = bitmap;
      member.image = null;
      member.imageSource = null;
      member.regPointOverride = { x: 0, y: 0 };
      return imageName;
    })().catch(() => "thumb.system_notification");
    bundledBulletinImageMembers.set(imageName, promise);
    return promise;
  };
  void ensureBundledBulletinImageMember("thumb.messenger_alert");

  let movieForRoomBuffer: DirectorMovie | null = null;
  const getRoomAssetBuffer = (): ScriptInstance | null => {
    const activeMovie = movieForRoomBuffer;
    if (!activeMovie) return null;
    const objectList = objectManagerList(activeMovie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    // Match the live release306 object identity. In this boot path the
    // source-created Buffer Component instance is registered as
    // #buffer_component and owns pPlaceHolderList/pLoadedCasts.
    const threadObject = propListLookup(objectList, "#room_asset_buffer");
    if (threadObject instanceof ScriptInstance) {
      try {
        const component = activeMovie.runtime.callMethod(threadObject, "getcomponent", []);
        if (component instanceof ScriptInstance) return component;
      } catch {
        // Fall through to the object id used by the source method.
      }
    }
    const objectComponent = propListLookup(objectList, "Room Asset Buffer");
    if (objectComponent instanceof ScriptInstance) return objectComponent;
    const bufferComponent = propListLookup(objectList, "#buffer_component");
    return bufferComponent instanceof ScriptInstance ? bufferComponent : null;
  };
  roomAssetPresentationHeld = () => shouldHoldRoomAssetPresentation(getRoomAssetBuffer());

  let movieForStageImage: DirectorMovie | null = null;
  const captureStageImage = (): LingoImage | null => {
    const activeMovie = movieForStageImage;
    if (!activeMovie) return null;
    renderScenePresentation(activeMovie, { forceFull: true, present: true });
    return LingoImage.fromDrawableSnapshot(app.canvas, stageScreenWidth(), stageScreenHeight());
  };

  const audioBackend = new WebAudioBackend();
  const movie = new DirectorMovie(
    manifest,
    { log: appendLog },
    async (fileName) => {
      // The original movie preloads the linked cast file over the network;
      // we fetch the same bytes from the official client distribution.
      const response = await fetch(`/origins-data/client/${fileName}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await response.arrayBuffer();
    },
    async (url) => {
      let promise = textCache.get(url);
      if (!promise) {
        promise = fetch(url).then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.text();
        }).then((text) => {
          if (!/(?:^|\/)external_variables\.txt(?:\?|$)/i.test(url)) return text;
          let variables = text;
          if (params.get("roomDynamicAssets") !== "0") {
            variables = enableRelease306RoomAssetVariables(variables);
          }
          variables = overrideOrigins306ExternalVariables(variables, params);
          variables = limitCastEntryVariables(variables, fastEntryCastLimit, castEntryKeep);
          return variables;
        });
        textCache.set(url, promise);
      }
      return promise;
    },
    members,
    markStageDirty,
    "/origins-data/client/",
    origins306ExternalParams(params),
    async (castName) => {
      // Eagerly decode small/UI casts into image buffers for copyPixels
      // windows. Large avatar/furni casts defer: any member whose image is
      // actually touched by generated code is decoded on demand through the
      // setImageDecodeRequester hook, so deferral never blanks composites.
      if (fastVisual) {
        renderer.markDirty();
        return;
      }
      const candidates = members
        .membersOf(castName)
        .filter((member) => member.bitmap?.pngUrl && !member.bitmap.decoded);
      if (eagerDecodeMax === 0 || candidates.length > eagerDecodeMax) {
        if (candidates.length > 0) {
          appendLog(
            "info",
            `deferred ${candidates.length} bitmap buffer decodes for ${castName} (on-demand decode covers composites)`,
          );
        }
        renderer.markDirty();
        return;
      }
      const work: Promise<void>[] = [];
      for (const member of candidates) {
        const bitmap = member.bitmap;
        if (!bitmap || !bitmap.pngUrl || bitmap.decoded) continue;
        const url = bitmap.pngUrl;
        work.push(
          scheduleDecode(async () => {
            deliverBitmapPixels(bitmap, await fetchImageBitmap(url, bitmapDecodeCache));
          })
            .then(() => {
              renderer.markDirty();
            })
            .catch(() => {
              deliverBitmapPixels(bitmap, null);
            }),
        );
      }
      await Promise.all(work);
      appendLog("info", `decoded ${work.length} bitmaps for ${castName} (limit ${decodeConcurrency})`);
      renderer.markDirty();
    },
    {
      bobbaPublicKey: params.get("bobbaPublicKey") ?? undefined,
      tracePackets: params.get("tracePackets") === "1",
      release306VersionCheckBuild: origins306ClientVersionId(params),
      release306VersionCheckClientType: origins306VersionCheckClientTypeOverride(params),
      release306VersionCheckExternalVariablesUrl: origins306VersionCheckExternalVariablesUrlOverride(params),
      machineId: params.get("machineId")?.trim() || params.get("uniqueId")?.trim() || undefined,
    },
    captureStageImage,
    audioBackend,
    undefined,
    createBrowserSteamXtraProvider(),
  );
  movie.setAudioTraceContext({ profileId: runtimeVersion });
  for (const entry of (params.get("traceMemberImages") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)) {
    movie.traceMemberImages.add(entry);
  }
  if (movie.traceMemberImages.size > 0) {
    appendLog("info", `member image trace: ${[...movie.traceMemberImages].join(", ")}`);
  }
  const directorCursorPresentation = new DirectorCursorPresentation({
    movie,
    members,
    canvas: app.canvas,
  });
  directorCursorPresentation.setEnabled(params.get("customHabboCursor") !== "0");
  const directorInputBindings = new DirectorInputBindings(movie);
  window.addEventListener("blur", () => directorInputBindings.clear());
  movieForStageImage = movie;
  installRelease306CastLoadCompatibility(movie.runtime);
  installRelease306RoomBufferCompatibility(movie.runtime, members);
  installRelease306ResourceManagerCompatibility(movie.runtime, members);
  installOriginsVariableManagerCompatibility(movie.runtime);
  installRelease306StringServicesCompatibility(movie.runtime);
  installRelease306TextManagerCompatibility(movie.runtime);
  const wallItemAnywherePlacement = installWallItemAnywhereCompatibility(movie.runtime);
  const floorItemAnywherePlacement = installFloorItemAnywhereCompatibility(movie.runtime);
  let sourcePerfTraceInstalled = false;
  const ensureSourcePerfTrace = (): void => {
    if (sourcePerfTraceInstalled) return;
    installSourcePerfTrace(movie.runtime, frameStutterDiagnostics, renderDiagnosticsEnabled ? appendLog : undefined);
    sourcePerfTraceInstalled = true;
  };
  if (tracePerfEnabled || renderDiagnosticsEnabled) {
    ensureSourcePerfTrace();
  }
  const resizeEngine = resizablePresentation ? new OriginsResizeEngine(movie) : null;
  let resizeSnapshot: ResizeEngineSnapshot | null = null;
  const applyResizableViewport = (reason: string): void => {
    if (!resizeEngine) return;
    const size = stageViewportSize();
    const rendererResized = resizePixiStage(size.width, size.height);
    resizeSnapshot = resizeEngine.setViewport(size.width, size.height);
    syncPresentationUnderlays(resizeSnapshot);
    if (rendererResized || resizeSnapshot.changed) {
      renderScenePresentation(movie);
    }
    if (resizeSnapshot.errors.length > 0) {
      appendLog("error", `resize engine ${reason}: ${resizeSnapshot.errors.join("; ")}`);
    }
  };
  if (resizeEngine) {
    applyResizableViewport("initial");
    let resizeQueued = false;
    const queueResize = (): void => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        applyResizableViewport("resize");
      });
    };
    new ResizeObserver(queueResize).observe(stageWrapEl);
    window.addEventListener("resize", queueResize);
  }
  movieForRoomBuffer = movie;
  movie.onImageReleased = (image) => renderer.releaseImage(image);
  appendLog("info", `network bridge: ${movie.networkBridgeUrl}`);

  const traceSprites = new Set(
    (params.get("traceSprites") ?? "")
      .split(",")
      .map((entry) => Number(entry.trim()) | 0)
      .filter((entry) => entry > 0),
  );
  if (traceSprites.size > 0) {
    const setProp = movie.setProp;
    movie.setProp = (receiver, property, value) => {
      if (
        receiver instanceof SpriteChannel &&
        traceSprites.has(receiver.number) &&
        ["loc", "loch", "locv", "width", "height", "member", "castnum"].includes(property)
      ) {
        appendLog(
          "info",
          `[sprite ${receiver.number}] ${property} ${JSON.stringify(debugValue(value))} before (${receiver.locH},${receiver.locV})`,
        );
      }
      return setProp(receiver, property, value);
    };
  }

  // Pointer and keyboard events feed Director's sprite event dispatch
  // (Event Broker behaviors, editable-field focus and typing).
  const stagePoint = (event: Pick<MouseEvent, "clientX" | "clientY">): { x: number; y: number } => {
    const bounds = app.canvas.getBoundingClientRect();
    if (resizeEngine) {
      return {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
    }
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * manifest.stage.width,
      y: ((event.clientY - bounds.top) / bounds.height) * manifest.stage.height,
    };
  };
  const stageInputMetrics = (): Record<string, unknown> => {
    const bounds = app.canvas.getBoundingClientRect();
    const wrapBounds = stageWrapEl.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      canvasPixelWidth: app.canvas.width,
      canvasPixelHeight: app.canvas.height,
      canvasStyleWidth: app.canvas.style.width,
      canvasStyleHeight: app.canvas.style.height,
      rendererResolution: app.renderer.resolution,
      rendererBackingWidth: app.renderer.width,
      rendererBackingHeight: app.renderer.height,
      rendererScreenWidth: stageScreenWidth(),
      rendererScreenHeight: stageScreenHeight(),
      devicePixelRatio: window.devicePixelRatio,
      directorRenderResolution: renderResolution(),
      canvasImageRendering: app.canvas.style.imageRendering,
      wrapperWidth: wrapBounds.width,
      wrapperHeight: wrapBounds.height,
      stageWidth: manifest.stage.width,
      stageHeight: manifest.stage.height,
      resizablePresentation: Boolean(resizeEngine),
    };
  };
  const valueToNumber = (value: LingoValue | undefined, fallback = 0): number => {
    if (value === undefined || value instanceof LingoVoid) return fallback;
    try {
      const numeric = numberOf(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    } catch {
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      }
      return fallback;
    }
  };
  const valueToId = (value: LingoValue): string =>
    value instanceof LingoSymbol ? `#${value.name}` : typeof value === "string" ? value : String(debugValue(value));
  const sourceWindowInteraction = new SourceWindowInteractionController({
    movie,
    instancePropValue,
    propListLookup,
    debugValue,
    valueToNumber,
    valueToId,
    render: () => renderScenePresentation(movie),
  });
  const elementRect = sourceWindowInteraction.elementRect.bind(sourceWindowInteraction);
  const sourceWindowManager = sourceWindowInteraction.manager.bind(sourceWindowInteraction);
  const sourceWindowIds = sourceWindowInteraction.ids.bind(sourceWindowInteraction);
  const sourceWindowById = sourceWindowInteraction.windowById.bind(sourceWindowInteraction);
  const sourceWindowVisible = sourceWindowInteraction.windowVisible.bind(sourceWindowInteraction);
  const sourceWindowElements = sourceWindowInteraction.elements.bind(sourceWindowInteraction);
  const sourceWindowSprites = sourceWindowInteraction.sprites.bind(sourceWindowInteraction);
  const sourceWindowContainsPoint = sourceWindowInteraction.containsPoint.bind(sourceWindowInteraction);
  movie.inputHitTestOverride = sourceWindowInteraction.ownsSpriteAt.bind(sourceWindowInteraction);
  const sourceWheelAt = sourceWindowInteraction.wheelAt.bind(sourceWindowInteraction);
  let roomPresentationDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
  const syncCustomHotelViewPresentation = (): CustomHotelViewPresentation | null =>
    customHotelViewPresentationController?.sync() ?? null;
  const canDragCustomHotelViewAt = (x: number, y: number): boolean =>
    customHotelViewPresentationController?.canDragAt(x, y) ?? false;
  let roomStagePresentationController: RoomStagePresentationController | null = null;
  let roomVisibilityController: RoomVisibilityController | null = null;
  const currentPrivateRoomFlatId = (): string | null => roomStagePresentationController?.currentPrivateRoomFlatId() ?? null;
  const roomStageSourcePoint = (point: { x: number; y: number }): { x: number; y: number } =>
    roomStagePresentationController?.sourcePoint(point) ?? point;
  const roomStageDragDeltaScale = (): number => roomStagePresentationController?.dragDeltaScale() ?? 1;
  const setRoomStageZoom = (scale: number): Record<string, unknown> =>
    roomStagePresentationController?.setZoom(scale) ?? { ok: false, scale: 1, reason: "room zoom not initialized" };
  const roomStageZoomDiagnostics = (): Record<string, unknown> =>
    roomStagePresentationController?.diagnostics() ?? { ok: false, scale: 1, active: false, channelCount: 0 };
  const hiddenChatEntryMatches = (entry: Readonly<Record<string, unknown>>): boolean =>
    roomVisibilityController?.hiddenChatEntryMatches(entry) ?? false;
  const manualHiddenChannels = (): Set<number> => roomVisibilityController?.manualHiddenChannels() ?? new Set<number>();
  const setHideFurni = (value: boolean): Record<string, unknown> =>
    roomVisibilityController?.setHideFurni(value) ?? { hideFurni: false };
  const setHideUsers = (value: boolean): Record<string, unknown> =>
    roomVisibilityController?.setHideUsers(value) ?? { hideUsers: false };
  const setHideUi = (value: boolean): Record<string, unknown> => roomVisibilityController?.setHideUi(value) ?? { hideUi: false };
  const setHiddenUserFilter = (entries: unknown): Record<string, unknown> =>
    roomVisibilityController?.setHiddenUserFilter(entries) ?? { entries: [], names: 0, ids: 0 };
  let primaryPointerModifiers: { pointerId: number; modifiers: DirectorModifierState } | null = null;
  const mergedModifierState = (left: DirectorModifierState, right: DirectorModifierState | null): DirectorModifierState => {
    if (!right) return left;
    return {
      shiftDown: left.shiftDown || right.shiftDown,
      controlDown: left.controlDown || right.controlDown,
      optionDown: left.optionDown || right.optionDown,
      commandDown: left.commandDown || right.commandDown,
    };
  };
  const applyPointerGestureModifiers = (event: PointerEvent): DirectorModifierState => {
    const current = directorInputBindings.apply(event);
    const latched = primaryPointerModifiers?.pointerId === event.pointerId ? primaryPointerModifiers.modifiers : null;
    const merged = mergedModifierState(current, latched);
    if (merged !== current) movie.setKeyboardModifierState(merged);
    return merged;
  };
  const customHotelViewDiagnostics = (): Record<string, unknown> =>
    customHotelViewPresentationController?.diagnostics() ?? {
      enabled: customHotelViewEnabled,
      active: false,
      manualOffset: [0, 0],
      presentation: null,
      suppressedChannels: [],
      assetRoutes: CUSTOM_HOTEL_VIEW_ASSETS,
    };
  app.canvas.addEventListener("pointermove", (event) => {
    if ((event.buttons & 1) === 1) {
      applyPointerGestureModifiers(event);
    } else {
      directorInputBindings.apply(event);
    }
    const point = stagePoint(event);
    const sourcePoint = roomStageSourcePoint(point);
    if (customHotelViewPresentationController?.updateDrag(event.pointerId, point.x, point.y)) {
      renderScenePresentation(movie, { clearRenderDirty: true });
      event.preventDefault();
      return;
    }
    if (roomPresentationDrag && resizeEngine && event.pointerId === roomPresentationDrag.pointerId) {
      const dragScale = roomStageDragDeltaScale();
      resizeSnapshot = resizeEngine.dragRoomBy(
        (point.x - roomPresentationDrag.lastX) / dragScale,
        (point.y - roomPresentationDrag.lastY) / dragScale,
      );
      roomPresentationDrag = { pointerId: event.pointerId, lastX: point.x, lastY: point.y };
      syncPresentationUnderlays(resizeSnapshot);
      if (resizeSnapshot.changed) {
        renderScenePresentation(movie, { clearRenderDirty: true });
      }
      event.preventDefault();
      return;
    }
    // Pointer movement updates Director mouse state and sprite hover events.
    // Do not call updateStage here: that pumps prepareFrame/update handlers at
    // mouse-event frequency and makes timeline-style animations speed up when
    // the user moves the mouse quickly.
    movie.pointerMove(sourcePoint.x, sourcePoint.y);
    directorCursorPresentation.sync();
    renderDirty = true;
    renderer.markDirty();
  });
  app.canvas.addEventListener("pointerdown", (event) => {
    void movie.resumeAudio();
    const point = stagePoint(event);
    const sourcePoint = roomStageSourcePoint(point);
    const target = movie.inputSpriteAt(sourcePoint.x, sourcePoint.y, ["mousedown", "mouseup", "mouseupoutside"]);
    if (event.button === 0 && !target && canDragCustomHotelViewAt(point.x, point.y)) {
      customHotelViewPresentationController?.beginDrag(event.pointerId, point.x, point.y);
      app.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (resizeEngine && event.button === 1 && !sourceWindowContainsPoint(point.x, point.y) && resizeEngine.canDragRoomAt(sourcePoint.x, sourcePoint.y)) {
      roomPresentationDrag = { pointerId: event.pointerId, lastX: point.x, lastY: point.y };
      app.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    primaryPointerModifiers = { pointerId: event.pointerId, modifiers: directorInputBindings.apply(event) };
    movie.pointerMove(sourcePoint.x, sourcePoint.y);
    directorCursorPresentation.sync();
    movie.pointerDown();
    sourceWindowRefreshRequested = true;
    try {
      app.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best-effort; Director input still works without it.
    }
    event.preventDefault();
    renderDirty = true;
    renderer.markDirty();
  });
  app.canvas.addEventListener("pointerup", (event) => {
    const point = stagePoint(event);
    const sourcePoint = roomStageSourcePoint(point);
    if (customHotelViewPresentationController?.endDrag(event.pointerId)) {
      app.canvas.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (roomPresentationDrag && event.pointerId === roomPresentationDrag.pointerId) {
      roomPresentationDrag = null;
      app.canvas.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    applyPointerGestureModifiers(event);
    movie.pointerMove(sourcePoint.x, sourcePoint.y);
    directorCursorPresentation.sync();
    movie.pointerUp();
    refreshSourceWindowPresentation();
    if (primaryPointerModifiers?.pointerId === event.pointerId) primaryPointerModifiers = null;
    try {
      app.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be released when the pointer leaves the canvas.
    }
    event.preventDefault();
    renderDirty = true;
    renderer.markDirty();
  });
  app.canvas.addEventListener("pointercancel", (event) => {
    if (customHotelViewPresentationController?.endDrag(event.pointerId)) {
      app.canvas.releasePointerCapture?.(event.pointerId);
    }
    if (roomPresentationDrag?.pointerId === event.pointerId) {
      roomPresentationDrag = null;
      app.canvas.releasePointerCapture?.(event.pointerId);
    }
    if (primaryPointerModifiers?.pointerId === event.pointerId) primaryPointerModifiers = null;
    try {
      app.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be released.
    }
  });
  app.canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  app.canvas.addEventListener(
    "wheel",
    (event) => {
      const modifiers = directorInputBindings.apply(event);
      const point = stagePoint(event);
      const sourcePoint = roomStageSourcePoint(point);
      movie.pointerMove(sourcePoint.x, sourcePoint.y);
      directorCursorPresentation.sync();
      renderDirty = true;
      renderer.markDirty();
      const result = sourceWheelAt(sourcePoint.x, sourcePoint.y, event.deltaY, event.deltaX, modifiers.shiftDown);
      if (result.consumed) {
        sourceWindowRefreshRequested = true;
        event.preventDefault();
      }
    },
    { passive: false },
  );

  const preventBrowserKeyDefault = (event: KeyboardEvent): void => {
    if (
      event.key === "Backspace" ||
      event.key === "Delete" ||
      event.key === "Tab" ||
      event.key === "Enter" ||
      event.key === "Escape" ||
      event.key.startsWith("Arrow")
    ) {
      event.preventDefault();
    }
  };
  const writeClipboardText = async (text: string): Promise<void> => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-10000px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };
  const readClipboardText = async (): Promise<string> => {
    if (!navigator.clipboard?.readText) return "";
    return navigator.clipboard.readText().catch(() => "");
  };
  const handleEditableClipboardShortcut = (event: KeyboardEvent): boolean => {
    if (!movie.hasEditableKeyboardFocus()) return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      movie.selectFocusedEditableText();
      renderDirty = true;
      renderer.markDirty();
      return true;
    }
    if (key === "c") {
      event.preventDefault();
      void writeClipboardText(movie.copyFocusedEditableText() ?? "");
      return true;
    }
    if (key === "x") {
      event.preventDefault();
      void writeClipboardText(movie.cutFocusedEditableText() ?? "");
      renderDirty = true;
      renderer.markDirty();
      return true;
    }
    if (key === "v") {
      event.preventDefault();
      void readClipboardText().then((text) => {
        if (!text) return;
        movie.pasteFocusedEditableText(text);
        renderDirty = true;
        renderer.markDirty();
      });
      return true;
    }
    return false;
  };
  const objectManagerObjectById = (id: string): LingoValue => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    return objectList ? propListLookup(objectList, id) : LINGO_VOID;
  };
  const escapeCancelsObjectMover = (): boolean => {
    const roomInterface = objectManagerObjectById("#room_interface");
    if (!(roomInterface instanceof ScriptInstance)) return false;
    const action = valueToId(instancePropValue(roomInterface, "pclickaction") ?? LINGO_VOID);
    if (
      action !== "moveActive" &&
      action !== "moveItem" &&
      action !== "placeActive" &&
      action !== "placeItem" &&
      action !== "placeCatalogueSandboxActive" &&
      action !== "placeCatalogueSandboxItem"
    ) {
      return false;
    }
    try {
      movie.runtime.callMethod(roomInterface, "cancelobjectmover", []);
      return true;
    } catch (error) {
      appendLog("error", `Escape cancelObjectMover failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  window.addEventListener("keydown", (event) => {
    void movie.resumeAudio();
    directorInputBindings.rememberKeyDown(event);
    if (handleEditableClipboardShortcut(event)) return;
    const mapped = directorKeyForBrowserEvent(event);
    if (!mapped) return;
    const modifiers = directorInputBindings.apply(event);
    preventBrowserKeyDefault(event);
    movie.keyDown(mapped.key, mapped.code, modifiers.shiftDown, modifiers.controlDown, modifiers.optionDown, modifiers.commandDown);
    sourceWindowRefreshRequested = true;
    if (mapped.code === 53 && escapeCancelsObjectMover()) {
      markEngineFeaturePresentationsDirty();
      event.preventDefault();
    }
  });
  window.addEventListener("keyup", (event) => {
    const mapped = directorKeyForBrowserEvent(event);
    directorInputBindings.rememberKeyUp(event);
    const modifiers = directorInputBindings.apply(event, { includeKeyboardKey: false });
    if (!mapped) return;
    movie.keyUp(mapped.key, mapped.code, modifiers.shiftDown, modifiers.controlDown, modifiers.optionDown, modifiers.commandDown);
    sourceWindowRefreshRequested = true;
  });

  for (const entry of executableScripts.scripts) {
    movie.runtime.register(entry.module, entry.castFile, { memberNumber: entry.memberNumber });
  }
  appendLog("info", `registered ${executableScripts.scripts.length} executable generated scripts from ${executableScripts.version}`);

  const copyTraceStats = createCopyTraceStats();
  const phaseTimings = {
    movieTick: createRollingTimings(240),
    prepareTextSpriteImages: createRollingTimings(240),
    rendererSync: createRollingTimings(240),
    appRender: createRollingTimings(240),
    directorTickDelta: createRollingTimings(240),
    directorTickJitter: createRollingTimings(240),
  };
  const copyTraceBaseEnabled = traceCopyEnabled || renderDiagnosticsEnabled;
  let copyTraceFilter: ((info: CopyTraceEvent) => boolean) | null = null;
  let copyTraceLimit = 250;
  let copyTraceEvents: CopyTraceEvent[] = [];
  const copyTraceHandler = (info: CopyTraceEvent): void => {
    copyTraceStats.record(info);
    if (traceCopyEnabled) {
      console.log(
        `[copy] dest ${info.destW}x${info.destH} <- src ${info.srcW}x${info.srcH} dr(${info.destRect}) sr(${info.sourceRect}) ink=${info.ink ?? "-"}${info.journaled ? " journaled" : ""} ${info.directCopyCandidate ? "direct-candidate" : "staged"}`,
      );
    }
    if (copyTraceFilter?.(info)) {
      copyTraceEvents.push({ ...info });
      if (copyTraceEvents.length > copyTraceLimit) copyTraceEvents = copyTraceEvents.slice(-copyTraceLimit);
    }
  };
  const applyCopyTraceHandler = (): void => {
    LingoImage.copyTrace = copyTraceBaseEnabled || copyTraceFilter ? copyTraceHandler : null;
  };
  const setCopyTraceFilter = (filter: CopyTraceFilter = {}): CopyTraceFilter => {
    const normalized = {
      destW: Number.isFinite(Number(filter.destW)) ? Math.trunc(Number(filter.destW)) : undefined,
      destH: Number.isFinite(Number(filter.destH)) ? Math.trunc(Number(filter.destH)) : undefined,
      srcW: Number.isFinite(Number(filter.srcW)) ? Math.trunc(Number(filter.srcW)) : undefined,
      srcH: Number.isFinite(Number(filter.srcH)) ? Math.trunc(Number(filter.srcH)) : undefined,
      ink: filter.ink === "any" ? "any" : Number.isFinite(Number(filter.ink)) ? Math.trunc(Number(filter.ink)) : undefined,
      limit: Number.isFinite(Number(filter.limit)) ? Math.max(1, Math.min(1000, Math.trunc(Number(filter.limit)))) : 250,
    } satisfies CopyTraceFilter;
    copyTraceLimit = normalized.limit ?? 250;
    copyTraceEvents = [];
    copyTraceFilter = (info) =>
      (normalized.destW === undefined || info.destW === normalized.destW) &&
      (normalized.destH === undefined || info.destH === normalized.destH) &&
      (normalized.srcW === undefined || info.srcW === normalized.srcW) &&
      (normalized.srcH === undefined || info.srcH === normalized.srcH) &&
      (normalized.ink === undefined || normalized.ink === "any" || info.ink === normalized.ink);
    applyCopyTraceHandler();
    return normalized;
  };
  const clearCopyTraceFilter = (): number => {
    const count = copyTraceEvents.length;
    copyTraceFilter = null;
    copyTraceEvents = [];
    applyCopyTraceHandler();
    return count;
  };

  // ?traceCopy=1 logs every image copy; ?renderDiagnostics=1 aggregates copy
  // and frame-phase timings for optimization proof without changing pixels.
  applyCopyTraceHandler();

  // ?trace=handler1,handler2 wires the runtime tracer into the page log.
  const traceParam = params.get("trace");
  if (traceParam) {
    for (const name of traceParam.split(",")) {
      movie.runtime.traceHandlers.add(name.trim().toLowerCase());
    }
    movie.runtime.traceSink = (text) => appendLog("info", text);
  }

  // Window composites bake text once; the Volter (Goldfish) faces must be
  // resident before generated code renders its first label.
  try {
    const sizes = [9, 10, 11, 12, 14, 18];
    const fontLoads = sizes.flatMap((size) => [
      document.fonts.load(`${size}px "Volter Goldfish"`),
      document.fonts.load(`bold ${size}px "Volter Goldfish"`),
    ]);
    await Promise.race([
      Promise.all(fontLoads).then(() => document.fonts.ready),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("font timeout")), 3000)),
    ]);
  } catch {
    appendLog("info", "Volter Goldfish webfont unavailable; falling back to system fonts");
  }

  movie.start();
  const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
  const stageClick = (x: number, y: number, modifiers: Partial<DirectorModifierState> = {}): void => {
    const previousModifiers: DirectorModifierState = {
      shiftDown: Boolean(movie.shiftDown),
      controlDown: Boolean(movie.controlDown),
      optionDown: Boolean(movie.optionDown),
      commandDown: Boolean(movie.commandDown),
    };
    const hasModifierOverrides =
      typeof modifiers.shiftDown === "boolean" ||
      typeof modifiers.controlDown === "boolean" ||
      typeof modifiers.optionDown === "boolean" ||
      typeof modifiers.commandDown === "boolean";
    if (hasModifierOverrides) {
      movie.setKeyboardModifierState({
        shiftDown: typeof modifiers.shiftDown === "boolean" ? modifiers.shiftDown : previousModifiers.shiftDown,
        controlDown: typeof modifiers.controlDown === "boolean" ? modifiers.controlDown : previousModifiers.controlDown,
        optionDown: typeof modifiers.optionDown === "boolean" ? modifiers.optionDown : previousModifiers.optionDown,
        commandDown: typeof modifiers.commandDown === "boolean" ? modifiers.commandDown : previousModifiers.commandDown,
      });
    }
    try {
      movie.pointerMove(x, y);
      movie.pointerDown();
      movie.pointerUp();
      refreshSourceWindowPresentation();
    } finally {
      if (hasModifierOverrides) movie.setKeyboardModifierState(previousModifiers);
    }
  };
  const spriteCenter = (spriteNumber: number): { x: number; y: number } | null => {
    const rect = movie.spriteBounds(spriteNumber);
    if (!rect) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const clickSprite = (spriteNumber: number): boolean => {
    const center = spriteCenter(spriteNumber);
    if (!center) return false;
    stageClick(center.x, center.y);
    return true;
  };
  const roomGeometry = new RoomGeometryController({ movie, objectById: objectManagerObjectById, stageClick });
  const roomScreenCoordinate = (x: number, y: number, height?: number): Record<string, unknown> =>
    roomGeometry.screenCoordinate(x, y, height);
  const roomWorldCoordinate = (screenX: number, screenY: number): Record<string, unknown> =>
    roomGeometry.worldCoordinate(screenX, screenY);
  const roomGeometryDiagnostics = (): Record<string, unknown> => roomGeometry.diagnostics();
  const stageClickTile = (x: number, y: number, height?: number): Record<string, unknown> => roomGeometry.clickTile(x, y, height);
  const sourceWindowDiagnostics = new SourceWindowDiagnostics({
    movie,
    interaction: sourceWindowInteraction,
    valueToId,
    stagePointToSource: roomStageSourcePoint,
    stageClick,
  });
  const imageDataSummary = sourceWindowDiagnostics.imageDataSummary.bind(sourceWindowDiagnostics);
  const paletteSample = sourceWindowDiagnostics.paletteSample.bind(sourceWindowDiagnostics);
  const summarizeSourceWindow = sourceWindowDiagnostics.summarizeSourceWindow.bind(sourceWindowDiagnostics);
  const resolvedSpriteSummary = sourceWindowDiagnostics.resolvedSpriteSummary.bind(sourceWindowDiagnostics);
  const sourceInputProbe = sourceWindowDiagnostics.sourceInputProbe.bind(sourceWindowDiagnostics);
  const sourceWindowElementsAtPoint = sourceWindowDiagnostics.elementsAtPoint.bind(sourceWindowDiagnostics);
  const clickWindowElement = sourceWindowDiagnostics.clickWindowElement.bind(sourceWindowDiagnostics);
  const spritePixelAt = sourceWindowDiagnostics.spritePixelAt.bind(sourceWindowDiagnostics);
  const hitProbe = sourceWindowDiagnostics.hitProbe.bind(sourceWindowDiagnostics);
  const sourceInputAutomation = new SourceInputAutomation({
    movie,
    windows: sourceWindowInteraction,
    clickSprite,
    delay,
  });
  const pressKey = sourceInputAutomation.pressKey.bind(sourceInputAutomation);
  const typeText = sourceInputAutomation.typeText.bind(sourceInputAutomation);
  const editableFields = sourceInputAutomation.editableFields.bind(sourceInputAutomation);
  const clearFocusedField = sourceInputAutomation.clearFocusedField.bind(sourceInputAutomation);
  const sourceTimeoutIds = sourceInputAutomation.sourceTimeoutIds.bind(sourceInputAutomation);
  const loginWithSourceEvents = sourceInputAutomation.login.bind(sourceInputAutomation);
  const entryComponentFromObjects = (): ScriptInstance | null => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    for (const id of ["#entry_component", "#entry"]) {
      const object = propListLookup(objectList, id);
      if (object instanceof ScriptInstance && movie.runtime.hasHandler(object, "enterentry")) {
        return object;
      }
      if (object instanceof ScriptInstance && movie.runtime.hasHandler(object, "getcomponent")) {
        try {
          const component = movie.runtime.callMethod(object, "getcomponent", []);
          if (component instanceof ScriptInstance && movie.runtime.hasHandler(component, "enterentry")) {
            return component;
          }
        } catch {
          // Diagnostic fallback only; keep the source message route primary.
        }
      }
    }
    return null;
  };
  const navigatorComponentFromObjects = (): ScriptInstance | null => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    const object = propListLookup(objectList, "#navigator_component");
    if (object instanceof ScriptInstance && movie.runtime.hasHandler(object, "updatestate")) {
      return object;
    }
    return null;
  };
  const navigatorInterfaceFromObjects = (): ScriptInstance | null => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    const direct = propListLookup(objectList, "#navigator_interface");
    if (direct instanceof ScriptInstance && movie.runtime.hasHandler(direct, "shownavigator")) {
      return direct;
    }
    const component = navigatorComponentFromObjects();
    if (component instanceof ScriptInstance && movie.runtime.hasHandler(component, "getinterface")) {
      try {
        const iface = movie.runtime.callMethod(component, "getinterface", []);
        if (iface instanceof ScriptInstance && movie.runtime.hasHandler(iface, "shownavigator")) {
          return iface;
        }
      } catch {
        // Diagnostic helper only; callers report unavailable navigator below.
      }
    }
    return null;
  };
  const showNavigatorWithSource = (view?: string): Record<string, unknown> => {
    const iface = navigatorInterfaceFromObjects();
    const result: Record<string, unknown> = {
      ok: false,
      route: "Navigator Interface",
      requestedView: view ?? null,
      showResult: null,
      viewResult: null,
      errors: [] as string[],
    };
    if (!(iface instanceof ScriptInstance)) {
      (result.errors as string[]).push("navigator interface not available");
      return result;
    }
    try {
      result.showResult = summarizeValue(movie.runtime.callMethod(iface, "shownavigator", []), 2);
    } catch (error) {
      (result.errors as string[]).push(error instanceof Error ? error.message : String(error));
    }
    if (view && view.length > 0) {
      try {
        result.viewResult = summarizeValue(movie.runtime.callMethod(iface, "changewindowview", [view]), 2);
      } catch (error) {
        (result.errors as string[]).push(error instanceof Error ? error.message : String(error));
      }
    }
    renderDirty = true;
    renderer.markDirty();
    result.ok = (result.errors as string[]).length === 0;
    result.window = summarizeSourceWindow("Hotel Navigator", false);
    return result;
  };
  const hideNavigatorWithSource = (mode: string | undefined = "hide"): Record<string, unknown> => {
    const iface = navigatorInterfaceFromObjects();
    const result: Record<string, unknown> = {
      ok: false,
      route: "Navigator Interface.hideNavigator",
      mode,
      hideResult: null,
      errors: [] as string[],
    };
    if (!(iface instanceof ScriptInstance)) {
      (result.errors as string[]).push("navigator interface not available");
      return result;
    }
    const symbol = String(mode ?? "hide").toLowerCase() === "remove" ? LingoSymbol.for("remove") : LingoSymbol.for("hide");
    try {
      result.hideResult = summarizeValue(movie.runtime.callMethod(iface, "hidenavigator", [symbol]), 2);
    } catch (error) {
      (result.errors as string[]).push(error instanceof Error ? error.message : String(error));
    }
    renderDirty = true;
    renderer.markDirty();
    result.ok = (result.errors as string[]).length === 0;
    return result;
  };
  const executeSourceMessage = (message: string, args: unknown[] = []): Record<string, unknown> => {
    const result: Record<string, unknown> = {
      ok: false,
      route: "executeMessage",
      message,
      result: null,
      errors: [] as string[],
    };
    try {
      const messageValue = String(message).startsWith("#") ? coerceDebugValue(message) : LingoSymbol.for(String(message));
      const callArgs = [messageValue, ...args.map((value) => coerceDebugValue(value))];
      result.result = summarizeValue(movie.runtime.call("executemessage", callArgs), 3);
    } catch (error) {
      (result.errors as string[]).push(error instanceof Error ? error.message : String(error));
    }
    result.ok = (result.errors as string[]).length === 0;
    return result;
  };
  const entryStateSummary = (): {
    state: unknown;
    entryBarObject: boolean;
    entryVisualizerObject: boolean;
  } => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return { state: null, entryBarObject: false, entryVisualizerObject: false };
    const component = entryComponentFromObjects();
    const state = component instanceof ScriptInstance ? summarizeValue(instancePropValue(component, "pstate") ?? LINGO_VOID, 1) : null;
    return {
      state,
      entryBarObject: !(propListLookup(objectList, "entry_bar") instanceof LingoVoid),
      entryVisualizerObject: !(propListLookup(objectList, "entry_view") instanceof LingoVoid),
    };
  };
  const entryStateActive = (state: { state: unknown; entryBarObject: boolean; entryVisualizerObject: boolean }): boolean =>
    state.entryBarObject || state.entryVisualizerObject || state.state === "#hotelView" || state.state === "#entryBar";
  const objectById = (id: string): LingoValue => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    return objectList ? propListLookup(objectList, id) : LINGO_VOID;
  };
  const objectExists = (id: string): boolean => {
    return !(objectById(id) instanceof LingoVoid);
  };
  const propListEntries = (value: LingoValue): Array<{ key: unknown; value: unknown }> => {
    if (!(value instanceof LingoPropList)) return [];
    return value.keys.map((key, index) => ({
      key: debugValue(key),
      value: summarizeValue(value.values[index], 2),
    }));
  };
  const sourceObjectIdFor = (object: LingoValue): string | null => {
    if (!(object instanceof ScriptInstance)) return null;
    const id = instancePropValue(object, "pid");
    return id === undefined || id instanceof LingoVoid ? null : valueToId(id);
  };
  const brokerMessageSummary = (message = "toggle_ig"): Record<string, unknown> => {
    const broker = objectById("#broker_manager");
    if (!(broker instanceof ScriptInstance)) return { exists: false, message, subscribers: [] };
    const itemList = instancePropValue(broker, "pitemlist");
    const messageKey = String(message).startsWith("#") ? LingoSymbol.for(String(message).slice(1)) : LingoSymbol.for(String(message));
    const subscribers = itemList instanceof LingoPropList ? propListLookup(itemList, valueToId(messageKey)) : LINGO_VOID;
    return {
      exists: true,
      message: valueToId(messageKey),
      subscriberCount: subscribers instanceof LingoPropList ? subscribers.count() : 0,
      subscribers: propListEntries(subscribers),
    };
  };
  const threadManagerSummary = (): Record<string, unknown> => {
    const threadManager = objectById("#thread_manager");
    if (!(threadManager instanceof ScriptInstance)) return { exists: false, threads: [] };
    const threads = instancePropValue(threadManager, "pthreadlist");
    const entries =
      threads instanceof LingoPropList
        ? threads.keys.map((key, index) => {
            const thread = threads.values[index];
            const threadInstance = thread instanceof ScriptInstance ? thread : null;
            const moduleSummary = (name: string): unknown => {
              if (!threadInstance) return null;
              const module = instancePropValue(threadInstance, name);
              return module instanceof ScriptInstance
                ? {
                    id: sourceObjectIdFor(module),
                    script: module.module.scriptName,
                    object: debugValue(module),
                  }
                : summarizeValue(module, 1);
            };
            return {
              id: debugValue(key),
              object: summarizeValue(thread, 1),
              interface: moduleSummary("interface"),
              component: moduleSummary("component"),
              handler: moduleSummary("handler"),
            };
          })
        : [];
    return {
      exists: true,
      indexField: summarizeValue(instancePropValue(threadManager, "pindexfield"), 1),
      threadCount: entries.length,
      threads: entries,
    };
  };
  const windowWrapperSummary = (id: string): Record<string, unknown> => {
    const wrapper = objectById(id);
    if (!(wrapper instanceof ScriptInstance)) return { id, exists: false };
    const get = (prop: string): unknown => {
      try {
        return summarizeValue(movie.runtime.callMethod(wrapper, "getproperty", [LingoSymbol.for(prop)]), 2);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    return {
      id,
      exists: true,
      script: wrapper.module.scriptName,
      visible: get("visible"),
      partCount: get("part_count"),
      locX: get("locX"),
      locY: get("locY"),
      width: get("width"),
      height: get("height"),
      props: summarizeValue(instancePropValue(wrapper, "pprops"), 2),
    };
  };
  const igStateSummary = (): Record<string, unknown> => {
    const component = objectById("#ig_component");
    const iface = objectById("#ig_interface");
    const components = component instanceof ScriptInstance ? instancePropValue(component, "pigcomponents") : LINGO_VOID;
    return {
      componentExists: component instanceof ScriptInstance,
      interfaceExists: iface instanceof ScriptInstance,
      systemState: component instanceof ScriptInstance ? summarizeValue(instancePropValue(component, "psystemstate"), 2) : null,
      activeMode: component instanceof ScriptInstance ? summarizeValue(instancePropValue(component, "pactivemode"), 2) : null,
      componentKeys:
        components instanceof LingoPropList
          ? components.keys.map((key, index) => ({
              key: debugValue(key),
              object: summarizeValue(components.values[index], 1),
            }))
          : [],
      mainWrapperId: iface instanceof ScriptInstance ? summarizeValue(instancePropValue(iface, "pmainwindowwrapperid"), 2) : null,
      sideWrapperId: iface instanceof ScriptInstance ? summarizeValue(instancePropValue(iface, "psidewindowwrapperid"), 2) : null,
      mainWrapper: windowWrapperSummary("ig_window_wrapper"),
      sideWrapper: windowWrapperSummary("ig_window2_wrapper"),
      sourceWindows: (() => {
        const manager = sourceWindowManager();
        return manager ? sourceWindowIds(manager).map(valueToId).filter((id) => id.toLowerCase().includes("ig")) : [];
      })(),
    };
  };
  let engineFeatureTickSerial = 0;
  const roomReadiness = new RoomReadinessController({
    movie,
    objectExists,
    objectManagerList,
    propListLookup,
    propListValue,
    instancePropValue,
    debugValue,
    tickSerial: () => engineFeatureTickSerial,
    delay,
  });
  invalidateEngineFeatureCaches = (): void => roomReadiness.invalidate();
  const roomReadySummary = (): RoomReadySummary => roomReadiness.summary();
  const waitForRoomReady = (timeoutMs = 10000): Promise<RoomReadySummary> => roomReadiness.wait(timeoutMs);
  const roomEntryState = (): Record<string, unknown> => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    const session = objectList ? propListLookup(objectList, "#session") : LINGO_VOID;
    const navigatorComponent = navigatorComponentFromObjects();
    const roomComponent = objectList ? propListLookup(objectList, "#room_component") : LINGO_VOID;
    const roomSavedData = roomComponent instanceof ScriptInstance ? instancePropValue(roomComponent, "psavedata") : LINGO_VOID;
    const delaySummary = (object: LingoValue): unknown => {
      if (!(object instanceof ScriptInstance)) return null;
      const delays = instancePropValue(object, "delays");
      if (!(delays instanceof LingoPropList)) return { count: 0, entries: [] };
      return {
        count: delays.count(),
        entries: delays.keys.map((key, index) => ({
          key: debugValue(key),
          value: summarizeValue(delays.values[index], 2),
        })),
      };
    };
    const sessionValue = (key: string): unknown => {
      if (!(session instanceof ScriptInstance) || !movie.runtime.hasHandler(session, "get")) return null;
      try {
        return summarizeValue(movie.runtime.callMethod(session, "get", [key]), 2);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const roomReady = roomReadySummary();
    return {
      roomReady,
      directorTick: movie.tickDiagnostics(),
      entryState: entryStateSummary(),
      lastroom: sessionValue("lastroom"),
      navigatorState: navigatorComponent instanceof ScriptInstance
        ? summarizeValue(instancePropValue(navigatorComponent, "pstate") ?? LINGO_VOID, 1)
        : null,
      navigatorDelays: delaySummary(navigatorComponent ?? LINGO_VOID),
      roomComponent: roomComponent instanceof ScriptInstance
        ? {
            pActiveFlag: debugValue(instancePropValue(roomComponent, "pactiveflag")),
            pRoomId: debugValue(instancePropValue(roomComponent, "proomid")),
            pReportRoomId: debugValue(instancePropValue(roomComponent, "preportroomid")),
            pCastLoaded: debugValue(instancePropValue(roomComponent, "pcastloaded")),
            pCommonCastTaskActive: debugValue(instancePropValue(roomComponent, "pcommoncasttaskactive")),
            pRoomConnectionRequested: debugValue(instancePropValue(roomComponent, "proomconnectionrequested")),
            pInterstitialFinishedLogged: debugValue(instancePropValue(roomComponent, "pinterstitialfinishedlogged")),
            pUserObjListCount: roomReady.roomComponentUserCount,
            pActiveObjListCount: roomReady.roomComponentActiveObjectCount,
            pPassiveObjListCount: roomReady.roomComponentPassiveObjectCount,
            pItemObjListCount: roomReady.roomComponentItemObjectCount,
            pSaveData: summarizeValue(roomSavedData, 2),
          }
        : null,
      variables: summarizeVariables(movie.runtime.getGlobal("gcore"), [
        "forward.id",
        "forward.type",
        "friend.id",
        "connection.info.id",
        "connection.room.id",
      ]),
      publicNodes: navigatorPublicNodes().slice(0, 20),
    };
  };
  const waitForHotelViewStable = async (
    timeoutMs = 15000,
    stableMs = 1200,
  ): Promise<{ stable: boolean; state: Record<string, unknown>; samples: number }> => {
    const timeout = Math.max(1, Number(timeoutMs) || 15000);
    const requiredStableMs = Math.max(1, Number(stableMs) || 1200);
    const deadline = performance.now() + timeout;
    let stableSince = 0;
    let samples = 0;
    let state = roomEntryState();
    while (performance.now() < deadline) {
      samples += 1;
      state = roomEntryState();
      const roomReady = state.roomReady as { ready?: boolean; roomId?: unknown } | null;
      const entryState = state.entryState as { entryBarObject?: boolean; entryVisualizerObject?: boolean; state?: unknown } | null;
      const roomIdle =
        !roomReady?.ready &&
        (roomReady?.roomId === "" || roomReady?.roomId === null || typeof roomReady?.roomId === "undefined");
      const entryActive =
        Boolean(entryState?.entryBarObject) ||
        Boolean(entryState?.entryVisualizerObject) ||
        entryState?.state === "#hotelView" ||
        entryState?.state === "#entryBar";
      if (entryActive && roomIdle) {
        if (stableSince === 0) stableSince = performance.now();
        if (performance.now() - stableSince >= requiredStableMs) {
          return { stable: true, state, samples };
        }
      } else {
        stableSince = 0;
      }
      await delay(100);
    }
    return { stable: false, state, samples };
  };
  customHotelViewPresentationController = new CustomHotelViewPresentationController({
    enabled: customHotelViewEnabled,
    resizablePresentation,
    movie,
    renderer,
    objectById,
    instancePropValue,
    roomState: roomReadySummary,
    entryState: entryStateSummary,
    entryStateActive,
    sourceWindowManager,
    sourceWindowById,
    sourceWindowContainsPoint,
    stageViewportSize,
    syncPresentationUnderlays: () => syncPresentationUnderlays(resizeSnapshot),
  });
  const roomStagePresentation = new RoomStagePresentationController({
    movie,
    renderer,
    objectById,
    objectManagerList,
    propListLookup,
    instancePropValue,
    debugValue,
    valueToNumber,
    roomReady: () => roomReadySummary().ready,
    stageViewportSize,
    sourceWindowContainsPoint,
    markPresentationsDirty: markEngineFeaturePresentationsDirty,
  });
  roomStagePresentationController = roomStagePresentation;
  const activePrivateRoomEntryFlatId = (): string | null => roomStagePresentationController?.activePrivateRoomEntryFlatId() ?? null;
  const roomNavigator = new RoomNavigatorController({
    movie,
    navigatorComponent: navigatorComponentFromObjects,
    instancePropValue,
    propListValue,
    debugValue,
    summarizeValue,
    valueToNumber,
    delay,
    waitForRoomReady,
  });
  const navigatorNodes = (): Array<Record<string, unknown>> => roomNavigator.nodes();
  const navigatorPublicNodes = (): Array<Record<string, unknown>> => roomNavigator.publicNodes();
  const ensureNavigatorPublicNodes = roomNavigator.ensurePublicNodes.bind(roomNavigator);
  const beginPublicRoomEntryWithSourceEvents = roomNavigator.beginPublicRoomEntry.bind(roomNavigator);
  const enterPublicRoomWithSourceEvents = roomNavigator.enterPublicRoom.bind(roomNavigator);
  const memberDiagnostics = (names: string[]): Record<string, unknown> => {
    const index = resourceMemberIndex(movie.runtime.getGlobal("gcore"));
    const result: Record<string, unknown> = {};
    for (const rawName of names) {
      const name = String(rawName ?? "");
      const numericId = /^-?\d+$/.test(name.trim()) ? Number(name.trim()) : null;
      const exact = numericId === null ? members.find(name, null) : members.find(numericId, null);
      const loadedMatches = members.loaded.flatMap((castName) =>
        members
          .membersOf(castName)
          .filter((member) =>
            numericId === null
              ? member.name.toLowerCase() === name.toLowerCase()
              : member.slotNumber === numericId || member.number === (numericId & 0xffff),
          )
          .map((member) => ({
            castName,
            member: member.number,
            slotNumber: member.slotNumber,
            type: member.type,
            textLength: member.text.length,
          })),
      );
      const indexed = numericId === null && index ? index.getaProp(name, lingoKeyEquals) : LINGO_VOID;
      result[name] = {
        decodedSlot:
          numericId === null
            ? null
            : {
                castLib: numericId >> 16,
                member: numericId & 0xffff,
              },
        resourceIndex: indexed instanceof LingoVoid ? null : debugValue(indexed),
        member: exact
          ? {
              castName: exact.castName,
              member: exact.number,
              slotNumber: exact.slotNumber,
              castNumber: exact.castNumber,
              type: exact.type,
              textLength: exact.text.length,
              textPreview: exact.text.slice(0, 500),
              hasBitmap: Boolean(exact.bitmap),
            }
          : null,
        loadedMatches,
      };
    }
    return result;
  };
  const sourceResourceDiagnostics = (names: string[]): Record<string, unknown> => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    const resourceManager = objectList ? propListLookup(objectList, "#resource_manager") : LINGO_VOID;
    const rawIndex = resourceMemberIndex(movie.runtime.getGlobal("gcore"));
    const callGlobal = (handler: string, args: LingoValue[]): unknown => {
      try {
        return debugValue(movie.runtime.call(handler, args) ?? LINGO_VOID);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    const callResourceManager = (handler: string, args: LingoValue[]): unknown => {
      if (!(resourceManager instanceof ScriptInstance)) return { error: "Resource Manager unavailable" };
      try {
        return debugValue(movie.runtime.callMethod(resourceManager, handler, args));
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    const result: Record<string, unknown> = {};
    for (const rawName of names) {
      const name = String(rawName ?? "");
      const rawResourceIndex = rawIndex ? rawIndex.getaProp(name, lingoKeyEquals) : LINGO_VOID;
      const sourceGetMemNum = callGlobal("getmemnum", [name]);
      const resourceManagerGetMemNum = callResourceManager("getmemnum", [name]);
      const resolvedNumber =
        typeof sourceGetMemNum === "number"
          ? sourceGetMemNum
          : typeof resourceManagerGetMemNum === "number"
            ? resourceManagerGetMemNum
            : 0;
      const resolvedMember = resolvedNumber !== 0 ? members.find(resolvedNumber, null) : null;
      result[name] = {
        sourceMemberExists: callGlobal("memberexists", [name]),
        sourceGetMemNum,
        resourceManagerExists: callResourceManager("exists", [name]),
        resourceManagerGetMemNum,
        rawResourceIndex: rawResourceIndex instanceof LingoVoid ? null : debugValue(rawResourceIndex),
        rawMember: (() => {
          const rawMember = members.find(name, null);
          return rawMember
            ? {
                castName: rawMember.castName,
                member: rawMember.number,
                slotNumber: rawMember.slotNumber,
                type: rawMember.type,
              }
            : null;
        })(),
        resolvedMember: resolvedMember
          ? {
              castName: resolvedMember.castName,
              member: resolvedMember.number,
              slotNumber: resolvedMember.slotNumber,
              castNumber: resolvedMember.castNumber,
              type: resolvedMember.type,
              name: resolvedMember.name,
            }
          : null,
      };
    }
    return {
      resourceManager:
        resourceManager instanceof ScriptInstance
          ? { exists: true, object: resourceManager.module.scriptName }
          : { exists: false, value: debugValue(resourceManager) },
      members: result,
    };
  };
  const roomProgramDiagnostics = (markerInput?: string): Record<string, unknown> => {
    const roomComponent = objectById("#room_component");
    const savedData = roomComponent instanceof ScriptInstance ? instancePropValue(roomComponent, "psavedata") : LINGO_VOID;
    const markerFromSource = savedData instanceof LingoPropList ? propListLookup(savedData, "marker") : LINGO_VOID;
    const marker = String(markerInput || debugValue(markerFromSource) || "").trim();
    const roomProgramId =
      roomComponent instanceof ScriptInstance ? debugValue(instancePropValue(roomComponent, "proomprgid") ?? LINGO_VOID) : null;
    const roomProgram =
      typeof roomProgramId === "string" && roomProgramId.length > 0 ? objectById(roomProgramId) : objectById("Room Program");
    const names = marker.length > 0 ? [`${marker}.room`, `${marker} Class`] : [];
    return {
      marker: marker || null,
      roomProgramId,
      roomComponent: roomComponent instanceof ScriptInstance ? summarizeObject(roomComponent, 1) : null,
      roomProgram: summarizeObject(roomProgram, 2),
      sourceResolution: names.length > 0 ? sourceResourceDiagnostics(names) : null,
      visualizer: summarizeVisualizer(movie.runtime.getGlobal("gcore"), "Room_visualizer"),
      geometry: roomGeometryDiagnostics(),
      stage: {
        authored: [manifest.stage.width, manifest.stage.height],
        viewport: [movie.stageViewportWidth, movie.stageViewportHeight],
        stageRight: debugValue(movie.runtime.theProp("stageright")),
        stageBottom: debugValue(movie.runtime.theProp("stagebottom")),
        sourceRect: summarizeValue(movie.runtime.getProp(movie.runtime.theProp("stage"), "sourceRect"), 1),
        rect: summarizeValue(movie.runtime.getProp(movie.runtime.theProp("stage"), "rect"), 1),
        drawRect: summarizeValue(movie.runtime.getProp(movie.runtime.theProp("stage"), "drawRect"), 1),
      },
    };
  };
  const memberImageDiagnostics = (names: string[]): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const rawName of names) {
      const name = String(rawName ?? "");
      const numericId = /^-?\d+$/.test(name.trim()) ? Number(name.trim()) : null;
      const member = numericId === null ? members.find(name, null) : members.find(numericId, null);
      if (!member) {
        result[name] = { found: false };
        continue;
      }
      const image = member.effectiveImage();
      const context = image.context;
      if (!context) {
        result[name] = {
          found: true,
          type: member.type,
          width: image.width,
          height: image.height,
          incomplete: image.incomplete,
          hasContext: false,
        };
        continue;
      }
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const samples: Record<string, unknown> = {};
      const points: Array<[string, number, number]> = [
        ["topLeft", 0, 0],
        ["center", Math.floor(image.width / 2), Math.floor(image.height / 2)],
        ["bottomRight", Math.max(0, image.width - 1), Math.max(0, image.height - 1)],
      ];
      for (const [label, x, y] of points) {
        const offset = (y * image.width + x) * 4;
        samples[label] = {
          x,
          y,
          rgba: [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0, pixels[offset + 3] ?? 0],
        };
      }
      let transparent = 0;
      let opaque = 0;
      const colors = new Map<string, number>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3] ?? 0;
        if (alpha === 0) transparent += 1;
        if (alpha === 255) opaque += 1;
        const key = `${pixels[offset] ?? 0},${pixels[offset + 1] ?? 0},${pixels[offset + 2] ?? 0},${alpha}`;
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
      result[name] = {
        found: true,
        castName: member.castName,
        member: member.number,
        slotNumber: member.slotNumber,
        type: member.type,
        width: image.width,
        height: image.height,
        bitDepth: member.bitmap?.bitDepth ?? null,
        paletteName: member.bitmap?.paletteName ?? null,
        hasPaletteIndices: Boolean(member.bitmap?.paletteIndexData),
        incomplete: image.incomplete,
        useAlpha: image.useAlpha,
        transparent,
        opaque,
        samples,
        topColors: [...colors.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
          .map(([rgba, count]) => ({ rgba: rgba.split(",").map(Number), count })),
      };
    }
    return result;
  };
  const roomComponentInstance = (): ScriptInstance | null => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    const rc = objectList ? propListLookup(objectList, "#room_component") : LINGO_VOID;
    return rc instanceof ScriptInstance ? rc : null;
  };
  const privateRoomEntry = new PrivateRoomEntryController({
    movie,
    navigatorComponent: navigatorComponentFromObjects,
    roomComponent: roomComponentInstance,
    currentFlatId: currentPrivateRoomFlatId,
    activeEntryFlatId: activePrivateRoomEntryFlatId,
    roomReady: roomReadySummary,
    waitForRoomReady,
    summarizeValue,
    log: appendLog,
  });
  const enterPrivateRoomWithSourceEvents = privateRoomEntry.enter.bind(privateRoomEntry);
  const roomEntryWatchdogSnapshot = privateRoomEntry.watchdogSnapshot.bind(privateRoomEntry);
  const sessionObjectFromObjects = (): ScriptInstance | null => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    const session = propListLookup(objectList, "#session");
    return session instanceof ScriptInstance ? session : null;
  };
  const sourceSessionGet = (key: string): LingoValue => {
    const session = sessionObjectFromObjects();
    if (!(session instanceof ScriptInstance) || !movie.runtime.hasHandler(session, "get")) return LINGO_VOID;
    try {
      return movie.runtime.callMethod(session, "get", [key]);
    } catch {
      return LINGO_VOID;
    }
  };
  const chatHistoryFromSourceSession = (): Array<Record<string, unknown>> => {
    const history = sourceSessionGet("chat_history");
    if (!(history instanceof LingoList)) return [];
    return history.items.map((entry, index) => {
      if (!(entry instanceof LingoPropList)) {
        return {
          index: index + 1,
          type: "unknown",
          raw: summarizeValue(entry, 2),
        };
      }
      const message = propListValue(entry, "message");
      const messageProps = message instanceof LingoPropList ? message : null;
      return {
        index: index + 1,
        type: debugValue(propListValue(entry, "type")),
        timestamp: debugValue(propListValue(entry, "timeStamp")),
        userName: debugValue(propListValue(entry, "userName")),
        userObject: debugValue(propListValue(entry, "uObject")),
        virtual: debugValue(propListValue(entry, "virtual")),
        mode: messageProps ? debugValue(propListValue(messageProps, "command")) : null,
        userId: messageProps ? debugValue(propListValue(messageProps, "id")) : null,
        text: messageProps ? debugValue(propListValue(messageProps, "message")) : debugValue(message),
      };
    }).filter((entry) => !hiddenChatEntryMatches(entry));
  };
  const sendChatWithSourceEvents = async (
    text: string,
    delayMs = 0,
  ): Promise<{
    ok: boolean;
    route: string;
    field: unknown;
    enterResult: boolean;
    errors: string[];
  }> => {
    const errors: string[] = [];
    const message = String(text ?? "");
    if (message.trim().length === 0) errors.push("chat message is empty");
    if (message.length > 300) errors.push("chat message exceeds 300 characters");
    const fields = editableFields();
    const candidates = fields
      .map((field) => ({
        field,
        width: field.rect[2] - field.rect[0],
        height: field.rect[3] - field.rect[1],
      }))
      .filter((entry) => entry.width >= 120 && entry.height <= 40)
      .sort((left, right) => right.field.rect[1] - left.field.rect[1] || right.width - left.width);
    const target = candidates[0]?.field ?? fields[fields.length - 1] ?? null;
    if (!target) errors.push("no editable chat field is available");
    if (errors.length > 0 || !target) {
      return {
        ok: false,
        route: "Director editable field + Enter",
        field: target,
        enterResult: false,
        errors,
      };
    }
    clickSprite(target.n);
    await clearFocusedField();
    await typeText(message, Math.max(0, Number(delayMs) || 0));
    const enterResult = await pressKey("Enter");
    return {
      ok: enterResult,
      route: "Director editable field + Enter",
      field: target,
      enterResult,
      errors,
    };
  };
  const showHotelViewWithSourceEvents = async (): Promise<{
    route: string;
    primaryResult: unknown;
    changeRoomResult: unknown;
    leaveRoomResult: unknown;
    fallbackResult: unknown;
    state: unknown;
    entryBarObject: boolean;
    entryVisualizerObject: boolean;
    errors: string[];
  }> => {
    const errors: string[] = [];
    let route = "Navigator Component.updateState(enterEntry)";
    let primaryResult: LingoValue = LINGO_VOID;
    let changeRoomResult: LingoValue = LINGO_VOID;
    let leaveRoomResult: LingoValue = LINGO_VOID;
    let fallbackResult: LingoValue = LINGO_VOID;
    const initialRoom = roomReadySummary();
    const navigatorComponent = navigatorComponentFromObjects();
    if (navigatorComponent instanceof ScriptInstance) {
      try {
        // Source-backed path: Navigator Component.updateState("enterEntry")
        // performs executeMessage(#changeRoom) then executeMessage(#leaveRoom).
        // Calling those messages here as well tears the active room down twice.
        if (initialRoom.ready) {
          route = "Navigator Component.updateState(enterEntry)";
        }
        primaryResult = movie.runtime.callMethod(navigatorComponent, "updatestate", ["enterEntry"]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      route = "executemessage(#changeRoom) + executemessage(#leaveRoom)";
      try {
        if (!initialRoom.ready) changeRoomResult = movie.runtime.call("executemessage", [LingoSymbol.for("changeRoom")]);
        if (!initialRoom.ready) leaveRoomResult = movie.runtime.call("executemessage", [LingoSymbol.for("leaveRoom")]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        route = "Entry Component.enterEntry fallback";
      }
    }
    await delay(0);
    let state = entryStateSummary();
    if (!entryStateActive(state)) {
      const component = entryComponentFromObjects();
      if (component instanceof ScriptInstance) {
        try {
          fallbackResult = movie.runtime.callMethod(component, "enterentry", []);
          route = route === "executemessage(#leaveRoom)" ? "executemessage(#leaveRoom) + Entry Component.enterEntry" : route;
          await delay(0);
          state = entryStateSummary();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    return {
      route,
      primaryResult: summarizeValue(primaryResult, 2),
      changeRoomResult: summarizeValue(changeRoomResult, 2),
      leaveRoomResult: summarizeValue(leaveRoomResult, 2),
      fallbackResult: summarizeValue(fallbackResult, 2),
      ...state,
      errors,
    };
  };

  const appStartedAt = performance.now();
  let rafCount = 0;
  let lastRafAt = appStartedAt;
  const rafDeltas: number[] = [];
  const performanceStats = (): Record<string, unknown> => {
    const tick = movie.tickDiagnostics();
    const recent = rafDeltas.slice(-120);
    const averageRafDeltaMs =
      recent.length > 0 ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
    const worstRafDeltaMs = recent.length > 0 ? Math.max(...recent) : 0;
    const elapsedMs = Math.max(1, performance.now() - appStartedAt);
    return {
      elapsedMs: Math.round(elapsedMs),
      rafCount,
      rafPerSecond: Math.round((rafCount / elapsedMs) * 100000) / 100,
      averageRafDeltaMs: Math.round(averageRafDeltaMs * 100) / 100,
      worstRafDeltaMs: Math.round(worstRafDeltaMs * 100) / 100,
      // Live frame rate from the RECENT frame-delta average (not the lifetime rafPerSecond),
      // so a stall shows up immediately: main-thread lag delays RAF, the recent deltas grow,
      // and this number drops — the way a normal game-engine FPS readout behaves.
      currentFps: averageRafDeltaMs > 0 ? Math.round(1000 / averageRafDeltaMs) : 0,
      frameTempo: movie.frameTempo,
      directorTickCount: tick.tickCount,
      directorTicksPerSecond: Math.round((tick.tickCount / elapsedMs) * 100000) / 100,
      directorScheduler: directorTickScheduler.diagnostics(),
      recentDirectorTicksPerSecond:
        phaseTimings.directorTickDelta.values.length > 0
          ? Math.round((1000 / Math.max(0.001, phaseTimings.directorTickDelta.summary().averageMs)) * 100) / 100
          : 0,
      activeTimeoutCount: tick.timeouts.filter((timeout) => timeout.active).length,
      copyPixels: {
        total: copyTraceStats.total(),
        lastSecond: copyTraceStats.lastSecond(performance.now()),
      },
      image: {
        matte: LingoImage.matteDiagnostics(),
        copyPixels: LingoImage.copyPixelsDiagnostics(),
      },
      phases: {
        movieTick: phaseTimings.movieTick.summary(),
        prepareTextSpriteImages: phaseTimings.prepareTextSpriteImages.summary(),
        rendererSync: phaseTimings.rendererSync.summary(),
        appRender: phaseTimings.appRender.summary(),
        directorTickDelta: phaseTimings.directorTickDelta.summary(),
        directorTickJitter: phaseTimings.directorTickJitter.summary(),
      },
      modernPresentation: {
        smoothAvatars: smoothAvatarsEnabled,
        smoothUi: smoothUiEnabled,
        sourceWindowCount: cachedSourceWindowCount,
        sourceWindowChannels: cachedSourceWindowChannels.size,
        roomMotion: cachedRoomMotionDiagnostics,
        ...renderer.presentationDiagnostics(),
      },
      frameStutter: frameStutterDiagnostics.state(),
    };
  };
  const collectUiChannels = (channels: Set<number>): void => {
    const windowManager = sourceWindowManager();
    if (!windowManager) return;
    for (const id of sourceWindowIds(windowManager)) {
      const windowObject = sourceWindowById(windowManager, id);
      if (!windowObject) continue;
      for (const element of sourceWindowElements(windowObject)) {
        const sprite = instancePropValue(element, "psprite");
        if (sprite instanceof SpriteChannel) channels.add(sprite.number);
      }
    }
  };
  roomVisibilityController = new RoomVisibilityController({
    movie,
    renderer,
    objectById,
    instancePropValue,
    debugValue,
    collectUiChannels,
    toolbarTop: () => roomStagePresentation.toolbarTop(),
    markPresentationsDirty: markEngineFeaturePresentationsDirty,
  });
  const sourceWindowChannelSnapshot = (): { readonly channels: ReadonlySet<number>; readonly windowCount: number } => {
    const channels = new Set<number>();
    const windowManager = sourceWindowManager();
    if (!windowManager) return { channels, windowCount: 0 };
    let windowCount = 0;
    for (const id of sourceWindowIds(windowManager)) {
      const windowObject = sourceWindowById(windowManager, id);
      if (!windowObject || !sourceWindowVisible(windowObject)) continue;
      windowCount += 1;
      for (const sprite of sourceWindowSprites(windowObject)) channels.add(sprite.number);
      for (const element of sourceWindowElements(windowObject)) {
        const sprite = instancePropValue(element, "psprite");
        if (sprite instanceof SpriteChannel) channels.add(sprite.number);
      }
    }
    return { channels, windowCount };
  };
  const sceneEffects = new SceneEffectController({ app, stageWidth: stageScreenWidth, stageHeight: stageScreenHeight });
  syncSceneEffectOverlay = sceneEffects.syncOverlay.bind(sceneEffects);
  const animateSceneEffectOverlay = sceneEffects.animate.bind(sceneEffects);
  const sceneEffectOverlayOnTop = sceneEffects.keepOverlayOnTop.bind(sceneEffects);
  const setSceneFilter = sceneEffects.set.bind(sceneEffects);

  userNameLabelController = new UserNameLabelController({
    movie,
    renderer,
    objectManagerList,
    propListLookup,
    sourceSessionText: (key) => sourceSessionText(key),
    hiddenUserMatches: hiddenChatEntryMatches,
    markPresentationsDirty: markEngineFeaturePresentationsDirty,
  });
  const setUserNameLabels = (enabled: boolean, settings: UserNameLabelStyleSettings = {}): Record<string, unknown> =>
    userNameLabelController?.setEnabled(enabled, settings) ?? { enabled: false, settings: {} };
  const modernPresentationSnapshot = (): Record<string, unknown> => ({
    smoothAvatars: smoothAvatarsEnabled,
    smoothUi: smoothUiEnabled,
    sourceWindowCount: cachedSourceWindowCount,
    sourceWindowChannels: cachedSourceWindowChannels.size,
    roomMotion: cachedRoomMotionDiagnostics,
    ...renderer.presentationDiagnostics(),
  });
  const sourceWindowBudgetSettingsKey = (): string =>
    `${smoothUiEnabled ? 1 : 0}|${SOURCE_WINDOW_TEXT_BUDGET_PER_FRAME}|${SOURCE_WINDOW_SPRITE_BUDGET_PER_FRAME}|${setSignature(cachedSourceWindowChannels)}`;
  const applyModernPresentationSettings = (): Record<string, unknown> => {
    if (roomMotionPresentationDirty) {
      const roomComponent = objectById("#room_component");
      const motion = roomMotionPresentation.collect({
        roomComponent: roomComponent instanceof ScriptInstance ? roomComponent : null,
        channels: movie.channels,
        spriteBounds: (channelNumber) => movie.spriteBounds(channelNumber),
        toolbarTop: roomStagePresentation.toolbarTop(),
        nowMs: performance.now(),
      });
      cachedAvatarInterpolationChannels = motion.channels;
      cachedRoomMotionDiagnostics = motion.diagnostics;
      const avatarInterpolationSettingsKey = `${smoothAvatarsEnabled ? 1 : 0}|${movie.frameTempo}|${motion.diagnostics.signature}`;
      if (avatarInterpolationSettingsKey !== lastAvatarInterpolationSettingsKey) {
        renderer.setAvatarInterpolation({
          enabled: smoothAvatarsEnabled,
          channels: cachedAvatarInterpolationChannels,
          frameTempo: movie.frameTempo,
        });
        lastAvatarInterpolationSettingsKey = avatarInterpolationSettingsKey;
      }
      roomMotionPresentationDirty = false;
    }
    if (sourceWindowBudgetDirty) {
      const budgetSettingsKey = sourceWindowBudgetSettingsKey();
      if (budgetSettingsKey !== lastSourceWindowBudgetSettingsKey) {
        renderer.setSourceWindowPresentationBudget({
          enabled: smoothUiEnabled,
          channels: cachedSourceWindowChannels,
          maxTextPreparationsPerFrame: SOURCE_WINDOW_TEXT_BUDGET_PER_FRAME,
          maxSpriteUpdatesPerFrame: SOURCE_WINDOW_SPRITE_BUDGET_PER_FRAME,
        });
        lastSourceWindowBudgetSettingsKey = budgetSettingsKey;
      }
      sourceWindowBudgetDirty = false;
    }
    return {
      ...modernPresentationSnapshot(),
    };
  };
  const setSmoothAvatars = (enabled: boolean): Record<string, unknown> => {
    smoothAvatarsEnabled = Boolean(enabled);
    markEngineFeaturePresentationsDirty();
    renderer.markDirty();
    return applyModernPresentationSettings();
  };
  const setSmoothUi = (enabled: boolean): Record<string, unknown> => {
    smoothUiEnabled = Boolean(enabled);
    markEngineFeaturePresentationsDirty();
    renderer.markDirty();
    return applyModernPresentationSettings();
  };
  const setPerfTrace = (enabled: boolean, clear = false): Record<string, unknown> => {
    if (enabled) ensureSourcePerfTrace();
    frameStutterDiagnostics.setEnabled(Boolean(enabled));
    if (clear) frameStutterDiagnostics.clear();
    return frameStutterDiagnostics.state() as unknown as Record<string, unknown>;
  };
  const refreshSourceWindowPresentation = (): void => {
    const sourceWindows = sourceWindowChannelSnapshot();
    cachedSourceWindowChannels = sourceWindows.channels;
    cachedSourceWindowCount = sourceWindows.windowCount;
    sourceWindowRefreshRequested = false;
    sourceWindowBudgetDirty = true;
    lastSourceWindowRefreshAt = performance.now();
  };
  const refreshEngineFeaturePresentations = (): void => {
    engineFeaturePresentationsDirty = false;
    userNameLabelsPresentationDirty = false;
    syncCustomHotelViewPresentation();
    roomStagePresentationController?.refreshCachedPresentation();
    cachedManualHiddenChannels = manualHiddenChannels();
    userNameLabelController?.refresh();
    refreshSourceWindowPresentation();
  };
  const refreshUserNameLabelPresentation = (): void => {
    userNameLabelsPresentationDirty = false;
    userNameLabelController?.refresh();
  };
  beforePresentationRender = (activeMovie: DirectorMovie): void => {
    if (activeMovie !== movie) return;
    if (engineFeaturePresentationsDirty) refreshEngineFeaturePresentations();
    else if (userNameLabelsPresentationDirty) refreshUserNameLabelPresentation();
    renderer.setRoomStagePresentation(roomStagePresentationController?.presentation() ?? null);
    renderer.setManualHiddenChannels(cachedManualHiddenChannels);
    renderer.setUserNameLabels(userNameLabelController?.presentation() ?? []);
    applyModernPresentationSettings();
  };
  prepareTextForPresentation = (activeMovie: DirectorMovie, focusedSprite: number, forceFull: boolean): void => {
    if (forceFull || activeMovie !== movie) {
      activeMovie.prepareTextSpriteImages(focusedSprite);
      return;
    }
    activeMovie.prepareTextSpriteImages(focusedSprite, {
      shouldPrepareChannel: (channelNumber, focused) => renderer.shouldPrepareTextChannel(channelNumber, focused),
    });
  };

  const sourceSessionText = (key: string): string => {
    const value = sourceSessionGet(key);
    const text = String(debugValue(value))
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text === "<Void>" ? "" : text.slice(0, 64);
  };

  const cleanBulletinText = (value: unknown, fallback: string, maxLength: number): string => {
    const text = String(value ?? "")
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\[/g, "(")
      .replace(/\]/g, ")")
      .replace(/\s+/g, " ")
      .trim();
    return (text || fallback).slice(0, maxLength);
  };

  const cleanBulletinColor = (value: unknown, fallback: string): string => {
    const text = String(value ?? "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
  };

  const cleanBulletinImageName = (value: unknown): string => {
    const text = String(value ?? "").trim();
    if (/^thumb\.[A-Za-z0-9_.-]{1,96}$/.test(text) && text !== "thumb.hobba_notification") return text;
    return "thumb.system_notification";
  };

  const showBulletinNotificationWithSource = async (input: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    const manager = objectList ? propListLookup(objectList, "bulletin_notification_manager") : LINGO_VOID;
    if (!(manager instanceof ScriptInstance)) {
      return { ok: false, message: "bulletin_notification_manager is not available yet." };
    }

    const title = cleanBulletinText(input.title, "Notification", 72);
    const message = cleanBulletinText(input.message ?? input.body ?? input.text, "", 180);
    if (!message) return { ok: false, message: "Notification message is empty." };
    const imageName = await ensureBundledBulletinImageMember(cleanBulletinImageName(input.imageName));
    const titleColor = cleanBulletinColor(input.titleColor, "#2e2e2e");
    const backgroundColor = cleanBulletinColor(input.backgroundColor ?? input.bgColor, "#5994ab");
    const result = movie.runtime.callMethod(manager, "createnotification", [
      title,
      message,
      imageName,
      titleColor,
      backgroundColor,
      0,
      LINGO_VOID,
      LINGO_VOID,
    ]);
    if (resizeEngine) resizeSnapshot = resizeEngine.apply("notification");
    return {
      ok: true,
      message: "Notification queued.",
      title,
      imageName,
      result: debugValue(result),
      resize: resizeSnapshot ? { changed: resizeSnapshot.changed, anchors: resizeSnapshot.anchors.slice(-5) } : null,
    };
  };

  const audioDevEntry = (
    member: string | number | CastMember,
    rawOptions: Record<string, unknown> = {},
  ): LingoValue => {
    const optionNames = new Map([
      ["starttime", "startTime"],
      ["endtime", "endTime"],
      ["loopcount", "loopCount"],
      ["loopstarttime", "loopStartTime"],
      ["loopendtime", "loopEndTime"],
      ["preloadtime", "preLoadTime"],
    ]);
    const pairs: Array<[LingoValue, LingoValue]> = [[LingoSymbol.for("member"), member]];
    for (const [rawKey, rawValue] of Object.entries(rawOptions)) {
      const key = optionNames.get(rawKey.replace(/[^a-z]/gi, "").toLowerCase());
      if (!key) throw new Error(`Unknown Director sound option: ${rawKey}`);
      const value = typeof rawValue === "boolean" ? Number(rawValue) : rawValue;
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Director sound option ${rawKey} must be a string or number.`);
      }
      pairs.push([LingoSymbol.for(key), value]);
    }
    return LingoPropList.fromPairs(pairs);
  };

  // Expose live state for diagnostics/capture.
  (window as unknown as { __engine: unknown }).__engine = {
    dev: {
      setHideFurni,
      setHideUsers,
      setHideUi,
      setHiddenUserFilter,
      setWallItemAnywherePlacement: (enabled: boolean) => wallItemAnywherePlacement.setEnabled(Boolean(enabled)),
      wallItemAnywherePlacement: () => wallItemAnywherePlacement.summary(),
      setFloorItemAnywherePlacement: (enabled: boolean) => floorItemAnywherePlacement.setEnabled(Boolean(enabled)),
      floorItemAnywherePlacement: () => floorItemAnywherePlacement.summary(),
      setSceneFilter,
      stageInputMetrics,
      stageClick,
      stageClickTile,
      roomScreenCoordinate,
      roomWorldCoordinate,
      roomGeometryDiagnostics,
      clickSprite,
      editableFields,
      pressKey,
      typeText,
      login: loginWithSourceEvents,
      sourceTimeoutIds,
      showHotelView: showHotelViewWithSourceEvents,
      enterPrivateRoom: enterPrivateRoomWithSourceEvents,
      beginPublicRoomEntry: beginPublicRoomEntryWithSourceEvents,
      enterPublicRoom: enterPublicRoomWithSourceEvents,
      sendChat: sendChatWithSourceEvents,
      showBulletinNotification: showBulletinNotificationWithSource,
      chatHistory: chatHistoryFromSourceSession,
      navigatorPublicNodes,
      navigatorNodes,
      openNavigator: () => showNavigatorWithSource(),
      hideNavigator: (mode?: string) => hideNavigatorWithSource(mode),
      navigatorView: (view = "nav_pr") => showNavigatorWithSource(String(view)),
      executeMessage: executeSourceMessage,
      brokerMessage: (message = "toggle_ig") => brokerMessageSummary(String(message)),
      threads: threadManagerSummary,
      igState: igStateSummary,
      setTraceHandlers: (handlers: string[] | string) => {
        const list = Array.isArray(handlers) ? handlers : String(handlers ?? "").split(",");
        movie.runtime.traceSink = (text) => appendLog("info", text);
        for (const handler of list) {
          const normalized = String(handler ?? "").trim().toLowerCase();
          if (normalized) movie.runtime.traceHandlers.add(normalized);
        }
        return [...movie.runtime.traceHandlers];
      },
      clearTraceHandlers: () => {
        movie.runtime.traceHandlers.clear();
        return [];
      },
      setCopyTraceFilter,
      copyTraceLog: () => copyTraceEvents.map((event) => ({ ...event })),
      clearCopyTraceFilter,
      xtraDiagnostics: (names: string[] | string) => {
        const requested = Array.isArray(names) ? names : [names];
        return requested.map((name) => {
          const normalizedName = String(name ?? "").trim();
          const reference = movie.runtime.call("xtra", [normalizedName]);
          const instance = movie.runtime.call("new", [reference]);
          return {
            name: normalizedName,
            lookupVoid: reference instanceof LingoVoid,
            instanceVoid: instance instanceof LingoVoid,
            reference: debugValue(reference),
            instance: debugValue(instance),
          };
        });
      },
      unsupportedDiagnostics: () => movie.runtime.unsupportedDiagnostics(),
      sound: () => movie.soundSnapshot(),
      setAudioTrace: (enabled: boolean) => {
        movie.setAudioTraceEnabled(Boolean(enabled));
        return { enabled: Boolean(enabled), events: movie.audioTraceSnapshot().length };
      },
      audioTrace: () => movie.audioTraceSnapshot(),
      exportAudioTrace: () => movie.exportAudioTrace(),
      clearAudioTrace: () => {
        movie.clearAudioTrace();
        return [];
      },
      audioPlay: (channel: number, member: string | number, options: Record<string, unknown> = {}) =>
        movie.audioCommand(channel, "play", [audioDevEntry(member, options)]),
      audioQueue: (channel: number, member: string | number, options: Record<string, unknown> = {}) =>
        movie.audioCommand(channel, "queue", [audioDevEntry(member, options)]),
      audioCommand: (channel: number, command: string, ...args: LingoValue[]) =>
        movie.audioCommand(channel, command, args),
      clearUnsupportedDiagnostics: () => {
        movie.runtime.clearUnsupportedDiagnostics();
        return movie.runtime.unsupportedDiagnostics();
      },
      currentPrivateRoomFlatId,
      memberDiagnostics,
      sourceResourceDiagnostics,
      roomProgramDiagnostics,
      memberImageDiagnostics,
      clickWindowElement,
      windowElements: (id: string, includeImages = false) => summarizeSourceWindow(id, Boolean(includeImages)),
      sourceInputProbe: (x: number, y: number, includeImages = false) => sourceInputProbe(Number(x), Number(y), Boolean(includeImages)),
      sourceWindowElementsAtPoint: (x: number, y: number, includeImages = false) =>
        sourceWindowElementsAtPoint(Number(x), Number(y), Boolean(includeImages)),
      windowIds: () => {
        const windowManager = sourceWindowManager();
        return windowManager ? sourceWindowIds(windowManager).map(valueToId) : [];
      },
      wheelAt: (x: number, y: number, deltaY: number, deltaX = 0, shiftDown = false) =>
        sourceWheelAt(Number(x), Number(y), Number(deltaY), Number(deltaX), Boolean(shiftDown)),
      spriteDebug: (n: number) => {
        const channel = movie.channels[Number(n) | 0];
        if (!channel) return null;
        const rect = movie.spriteBounds(channel.number);
        return {
          ...(summarizeSprite(channel, 4) as Record<string, unknown>),
          rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
        };
      },
      resolvedSpriteDebug: (n: number, includeImages = false) => {
        const channel = movie.channels[Number(n) | 0];
        return channel ? resolvedSpriteSummary(channel, Boolean(includeImages)) : null;
      },
      resolvedSprites: (query = "", includeImages = false) => {
        const needle = String(query ?? "").toLowerCase();
        return movie.channels
          .filter((channel) => {
            if (channel.puppet !== 1 || !channel.member) return false;
            if (!needle) return true;
            const haystack = [
              channel.number,
              channel.member.name,
              channel.member.type,
              debugValue(channel.id),
              channel.member.castName,
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(needle);
          })
          .map((channel) => resolvedSpriteSummary(channel, Boolean(includeImages)));
      },
      hitSprites: (x: number, y: number) => movie.spritesAt(Number(x), Number(y)).map((channel) => summarizeSprite(channel, 3)),
      inputSpriteAt: (x: number, y: number) => {
        const channel = movie.inputSpriteAt(Number(x), Number(y));
        if (!channel) return null;
        const rect = movie.spriteBounds(channel.number);
        return {
          ...(summarizeSprite(channel, 4) as Record<string, unknown>),
          rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
          pixel: spritePixelAt(channel, Number(x), Number(y)),
        };
      },
      hitProbe,
      waitForObject: async (id: string, timeoutMs = 10000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (objectExists(id)) return true;
          await delay(100);
        }
        return false;
      },
      roomReady: roomReadySummary,
      waitForRoomReady,
      roomEntryState,
      roomEntryWatchdog: roomEntryWatchdogSnapshot,
      performanceStats,
      textureCacheDiagnostics: () => renderer.textureCacheDiagnostics(),
      setNativeKeyBinds: (bindings: Record<string, unknown>) => directorInputBindings.setNativeKeyBinds(bindings),
      nativeKeyBinds: () => directorInputBindings.currentBindings(),
      setUserNameLabels,
      userNameLabels: () => userNameLabelController?.summary() ?? { enabled: false, labels: [] },
      setCustomHabboCursor: (enabled: boolean) => directorCursorPresentation.setEnabled(Boolean(enabled)),
      customHabboCursor: () => directorCursorPresentation.state(),
      setSmoothAvatars,
      setSmoothUi,
      setPerfTrace,
      performanceOverrides: () => ({
        smoothAvatars: smoothAvatarsEnabled,
        smoothUi: smoothUiEnabled,
        sourceWindowCount: cachedSourceWindowCount,
        sourceWindowChannels: cachedSourceWindowChannels.size,
        ...renderer.presentationDiagnostics(),
        frameStutter: frameStutterDiagnostics.state(),
      }),
      setRoomStageZoom,
      roomStageZoom: roomStageZoomDiagnostics,
      customHotelView: customHotelViewDiagnostics,
      waitForHotelViewStable,
      scriptBundle: () => ({
        runtimeVersion,
        executableVersion: executableScripts.version,
        exact: executableScripts.exact,
        executableScripts: executableScripts.scripts.length,
        profileScriptRecords: profileScriptRecords.length,
      }),
    },
    activeSprites: () =>
      movie.channels
        .filter((c) => c.puppet === 1 && c.member)
        .map((c) => ({
          n: c.number,
          member: c.member!.name,
          memberNumber: c.member!.number,
          castNum: c.member!.slotNumber,
          castLibNum: c.member!.castNumber,
          type: c.member!.type,
          hasPng: !!c.member!.bitmap?.pngUrl,
          hasImage: !!c.member!.image,
          hasDecoded: !!c.member!.bitmap?.decoded,
          imgSize: c.member!.image ? [c.member!.image.width, c.member!.image.height] : null,
          loc: [c.locH, c.locV],
          z: c.locZ,
          vis: c.visible,
          ink: c.ink,
          blend: c.blend,
          size: [c.width, c.height],
          rotation: c.rotation,
          skew: c.skew,
          regPoint: c.member ? [c.member.regX, c.member.regY] : null,
          id: debugValue(c.id),
          color: debugValue(c.color),
          bgColor: debugValue(c.bgColor),
          flipH: c.flipH,
          bitmapSize: c.member!.bitmap ? [c.member!.bitmap.width, c.member!.bitmap.height] : null,
          editable: c.editable,
          text: c.member!.type === "field" || c.member!.type === "text" ? c.member!.text : undefined,
        })),
    keyboardFocus: () => movie.keyboardFocusSprite,
    stageImageData: () => {
      const image = captureStageImage();
      const el = image?.el as HTMLCanvasElement | undefined;
      return el ? el.toDataURL("image/png") : null;
    },
    memberImageData: (name: string) => {
      const exact = movie.channels.find((c) => c.member?.name === name);
      if (exact?.member) {
        const image = exact.member.image ?? exact.member.bitmap?.decoded;
        const el = image?.el as HTMLCanvasElement | undefined;
        return el ? el.toDataURL() : null;
      }
      for (const c of movie.channels) {
        if (c.member?.name.startsWith(name)) {
          const image = c.member.image ?? c.member.bitmap?.decoded;
          const el = image?.el as HTMLCanvasElement | undefined;
          return el ? el.toDataURL() : null;
        }
      }
      return null;
    },
    objectImageData: (id: string, propName: string) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const object = propListLookup(objectList, id);
      if (!(object instanceof ScriptInstance)) return null;
      const value = object.props.get(String(propName).toLowerCase());
      const image = value instanceof CastMember ? value.image ?? value.bitmap?.decoded : value;
      if (!(image instanceof LingoImage)) return null;
      const el = image.el as HTMLCanvasElement | undefined;
      return el && "toDataURL" in el ? el.toDataURL() : null;
    },
    findMember: (prefix: string) => {
        for (const castName of members.loaded) {
          for (const member of members.membersOf(castName)) {
            if (!member.name.startsWith(prefix)) continue;
            const image = member.image ?? member.bitmap?.decoded;
            const el = image?.el as HTMLCanvasElement | undefined;
          return {
            cast: castName,
            name: member.name,
            type: member.type,
            text: member.text,
            style: Object.fromEntries(member.style),
            imageSize: image ? [image.width, image.height] : null,
              imageIncomplete: image ? image.incomplete : null,
              imageVersion: image ? image.version : null,
              paletteColors: paletteSample(member.paletteColors),
              bitmapPaletteColors: paletteSample(member.bitmap?.paletteColors),
              imageData: el ? el.toDataURL() : null,
            };
          }
      }
      return null;
    },
    frame: () => movie.frame,
    errors: () => movie.errorCount,
    networkBridgeUrl: () => movie.networkBridgeUrl,
    castLoaded: (name: string) => members.loaded.includes(name),
    loadedCasts: () => [...members.loaded],
    brokerMessage: (message = "toggle_ig") => brokerMessageSummary(String(message)),
    threads: threadManagerSummary,
    igState: igStateSummary,
    resourceMembers: (names: string[]) => {
      const index = resourceMemberIndex(movie.runtime.getGlobal("gcore"));
      if (!index) return {};
      const result: Record<string, LingoValue> = {};
      for (const name of names) {
        result[name] = index.getaProp(name, lingoKeyEquals);
      }
      return result;
    },
    sourceResourceDiagnostics,
    roomProgramDiagnostics,
    visualizerDiagnostics: (id = "Room_visualizer") => summarizeVisualizer(movie.runtime.getGlobal("gcore"), String(id)),
    roomScreenCoordinate,
    roomWorldCoordinate,
    roomGeometryDiagnostics,
    objectIds: () => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return [];
      return objectList.keys.map(debugValue);
    },
    objectsWithHandler: (handler: string) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return [];
      const method = String(handler ?? "").trim();
      if (!method) return [];
      const matches: string[] = [];
      for (let index = 0; index < objectList.values.length; index += 1) {
        const object = objectList.values[index];
        if (!(object instanceof ScriptInstance) || !movie.runtime.hasHandler(object, method)) continue;
        matches.push(String(debugValue(objectList.keys[index] ?? "")));
      }
      return matches;
    },
    rerenderRoomShadow: () => {
      const component = roomComponentInstance();
      if (!(component instanceof ScriptInstance) || !movie.runtime.hasHandler(component, "getshadowmanager")) {
        return { ok: false, reason: "room component has no shadow manager route" };
      }
      const manager = movie.runtime.callMethod(component, "getshadowmanager", []);
      if (!(manager instanceof ScriptInstance) || !movie.runtime.hasHandler(manager, "render")) {
        return { ok: false, reason: "room shadow manager has no render handler" };
      }
      const result = movie.runtime.callMethod(manager, "render", []);
      return { ok: true, manager: summarizeObject(manager, 1), result: summarizeValue(result, 2) };
    },
    variables: (names: string[]) => summarizeVariables(movie.runtime.getGlobal("gcore"), names),
    objectProps: (id: string) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const object = propListLookup(objectList, id);
      return summarizeObject(object, 3);
    },
    windowElements: (id: string, includeImages = false) => summarizeSourceWindow(id, Boolean(includeImages)),
    objectMethod: (id: string, method: string, args: unknown[] = []) => {
      if (isSensitiveDiagnosticInvocation(method, args)) return "[REDACTED]";
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const object = propListLookup(objectList, id);
      const result = movie.runtime.callMethod(
        object,
        method,
        args.map((value) => coerceDebugValue(value)),
      );
      return summarizeValue(result, 3);
    },
    writerPreview: (id: string, text: string, width = 245, height = 38) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const writer = propListLookup(objectList, id);
      if (!(writer instanceof ScriptInstance) || !movie.runtime.hasHandler(writer, "render")) {
        return { error: `writer not found: ${id}` };
      }
      const image = movie.runtime.callMethod(writer, "render", [
        text,
        new LingoRect(0, 0, Math.max(1, Number(width) | 0), Math.max(1, Number(height) | 0)),
      ]);
      return imageDataSummary(image);
    },
    writerManagerPreview: (id: string, text: string, width?: number, height?: number) => {
      const manager = movie.runtime.call("getwritermanager", []);
      if (!(manager instanceof ScriptInstance) || !movie.runtime.hasHandler(manager, "get")) {
        return { error: "writer manager not available" };
      }
      const writer = movie.runtime.callMethod(manager, "get", [id]);
      if (!(writer instanceof ScriptInstance) || !movie.runtime.hasHandler(writer, "render")) {
        return { error: `writer not found: ${id}`, writer: summarizeValue(writer, 2) };
      }
      const args: LingoValue[] = [text];
      if (Number.isFinite(width) && Number.isFinite(height)) {
        args.push(new LingoRect(0, 0, Math.max(1, Number(width) | 0), Math.max(1, Number(height) | 0)));
      }
      return {
        writer: summarizeObject(writer, 2),
        image: imageDataSummary(movie.runtime.callMethod(writer, "render", args)),
      };
    },
    objectWriterPreview: (objectId: string, propName: string, text: string, width = 245, height = 38) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const object = propListLookup(objectList, objectId);
      if (!(object instanceof ScriptInstance)) {
        return { error: `object not found: ${objectId}` };
      }
      const writer = object.props.get(String(propName).toLowerCase());
      if (!(writer instanceof ScriptInstance) || !movie.runtime.hasHandler(writer, "render")) {
        return { error: `writer property not found: ${objectId}.${propName}`, value: summarizeValue(writer, 2) };
      }
      const image = movie.runtime.callMethod(writer, "render", [
        text,
        new LingoRect(0, 0, Math.max(1, Number(width) | 0), Math.max(1, Number(height) | 0)),
      ]);
      return imageDataSummary(image);
    },
    connectionCommand: (id: string, command: string) => {
      const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
      if (!objectList) return null;
      const connection = propListLookup(objectList, id);
      if (!(connection instanceof ScriptInstance)) return null;
      const pointer = connection.props.get("pcommandspntr");
      if (!(pointer instanceof LingoPropList)) return null;
      const value = pointer.getaProp(LingoSymbol.for("value"), lingoKeyEquals);
      if (!(value instanceof LingoPropList)) return null;
      return debugValue(value.getaProp(command, lingoKeyEquals));
    },
    spriteDebug: (n: number) => {
      const channel = movie.channels[Number(n) | 0];
      if (!channel) return null;
      const rect = movie.spriteBounds(channel.number);
      return {
        ...(summarizeSprite(channel, 4) as Record<string, unknown>),
        rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
      };
    },
    resolvedSpriteDebug: (n: number, includeImages = false) => {
      const channel = movie.channels[Number(n) | 0];
      return channel ? resolvedSpriteSummary(channel, Boolean(includeImages)) : null;
    },
    resolvedSprites: (query = "", includeImages = false) => {
      const needle = String(query ?? "").toLowerCase();
      return movie.channels
        .filter((channel) => {
          if (channel.puppet !== 1 || !channel.member) return false;
          if (!needle) return true;
          const haystack = [
            channel.number,
            channel.member.name,
            channel.member.type,
            debugValue(channel.id),
            channel.member.castName,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(needle);
        })
        .map((channel) => resolvedSpriteSummary(channel, Boolean(includeImages)));
    },
    rollover: () => debugValue(movie.runtime.theProp("rollover")),
    hitSprites: (x: number, y: number) => movie.spritesAt(Number(x), Number(y)).map((channel) => summarizeSprite(channel, 3)),
    inputSpriteAt: (x: number, y: number) => {
      const channel = movie.inputSpriteAt(Number(x), Number(y));
      if (!channel) return null;
      const rect = movie.spriteBounds(channel.number);
      return {
        ...(summarizeSprite(channel, 4) as Record<string, unknown>),
        rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
        pixel: spritePixelAt(channel, Number(x), Number(y)),
      };
    },
    hitProbe,
    sourceInputProbe: (x: number, y: number, includeImages = false) => sourceInputProbe(Number(x), Number(y), Boolean(includeImages)),
    sourceWindowElementsAtPoint: (x: number, y: number, includeImages = false) =>
      sourceWindowElementsAtPoint(Number(x), Number(y), Boolean(includeImages)),
    roomAssetBuffer: () => summarizeRoomAssetBuffer(getRoomAssetBuffer()),
    roomAssetBufferDiagnostics: (limit = 20) =>
      summarizeRoomAssetBufferDiagnostics(getRoomAssetBuffer(), movie.runtime, Math.max(1, Number(limit) | 0)),
    roomObjects: () => summarizeRoomObjects(movie.runtime.getGlobal("gcore"), movie.runtime),
    visualizer: (id: string) => summarizeVisualizer(movie.runtime.getGlobal("gcore"), id),
    resizeEngine: () => resizeSnapshot ?? resizeEngine?.currentSnapshot() ?? { enabled: false },
    customHotelView: customHotelViewDiagnostics,
    rendererHealth: () => rendererHealthMonitor.snapshot(),
  };

  if (params.get("audioHarness") === "1") {
    const { mountDirectorAudioHarness } = await import("./diagnostics/DirectorAudioHarness");
    mountDirectorAudioHarness({
      movie,
      members,
      manifest,
      generatedScripts: executableScripts.scripts,
      profileId: runtimeVersion,
    });
    appendLog("info", "Director audio harness mounted (audioHarness=1)");
  }

  window.addEventListener("pagehide", () => movie.disposeAudio(), { once: true });
  setupQuickLoginPanel();

  const tempoIntervalMs = (): number => 1000 / Math.max(1, Number(movie.frameTempo) || 1);
  let lastRenderDiagnosticsLogAt = 0;
  let lastRoomAssetPresentationHold = false;
  let lastFocusedSprite = Number(movie.keyboardFocusSprite) | 0;
  let lastCaretBlinkEpoch = Math.floor(performance.now() / 500);
  let lastStatusText = "";
  let lastImageMutationSerial = LingoImage.currentMutationSerial();
  let lastRoomFeatureComponent: ScriptInstance | null = null;
  let lastRoomFeatureKey = "";
  markImageMutationSerialSynced = () => {
    lastImageMutationSerial = LingoImage.currentMutationSerial();
  };
  const idleSyncEnabled = params.get("idlesync") !== "0";
  const roomFeatureIdentity = (): { readonly component: ScriptInstance | null; readonly key: string } => {
    const roomComponent = objectById("#room_component");
    if (!(roomComponent instanceof ScriptInstance)) return { component: null, key: "none" };
    const roomId = String(debugValue(instancePropValue(roomComponent, "proomid")) ?? "");
    const reportRoomId = String(debugValue(instancePropValue(roomComponent, "preportroomid")) ?? "");
    const visualizer = objectById("Room_visualizer") instanceof ScriptInstance ? "visualizer" : "no-visualizer";
    return { component: roomComponent, key: `${roomId}|${reportRoomId}|${visualizer}` };
  };
  const step = (now: number): void => {
    rafCount += 1;
    renderer.beginFrame(now);
    let engineFeaturePresentationsRefreshed = false;
    let userNameLabelsOnlyRefreshed = false;
    let movieTickMs = 0;
    let prepareTextMs = 0;
    let rendererSyncMs = 0;
    let appRenderMs = 0;
    let resizeFrameSyncRequested = false;
    const rafDelta = now - lastRafAt;
    lastRafAt = now;
    if (Number.isFinite(rafDelta) && rafDelta >= 0) {
      rafDeltas.push(rafDelta);
      if (rafDeltas.length > 240) rafDeltas.splice(0, rafDeltas.length - 240);
    }
    const interval = tempoIntervalMs();
    const afterDirectorTick = (): void => {
      engineFeatureTickSerial += 1;
      roomMotionRefreshRequested = true;
      sourceWindowRefreshRequested = true;
      if (userNameLabelController?.isEnabled()) userNameLabelsPresentationDirty = true;
      if (!idleSyncEnabled) renderDirty = true;
      if (resizeEngine?.needsFrameSync()) {
        resizeFrameSyncRequested = true;
      }
      const marker = movie.markerName(movie.frame);
      const statusText = movie.haltedReason
        ? `HALTED at frame ${movie.frame}: ${movie.haltedReason}`
        : `frame ${movie.frame}${marker ? ` (${marker})` : ""} | tempo ${movie.frameTempo}fps`;
      if (statusText !== lastStatusText) {
        statusEl.textContent = statusText;
        lastStatusText = statusText;
      }
    };
    const tickResult = directorTickScheduler.run(now, interval, () => {
      const tickStart = performance.now();
      movie.tick();
      const elapsed = performance.now() - tickStart;
      phaseTimings.movieTick.add(elapsed);
      afterDirectorTick();
      return elapsed;
    });
    movieTickMs = tickResult.movieTickMs;
    for (const tickDelta of tickResult.tickDeltas) phaseTimings.directorTickDelta.add(tickDelta);
    for (const tickJitter of tickResult.tickJitters) phaseTimings.directorTickJitter.add(tickJitter);
    if (tickResult.resynced) {
      phaseTimings.directorTickDelta.add(Math.max(interval, tickResult.backlogMs));
      phaseTimings.directorTickJitter.add(tickResult.backlogMs);
    }
    if (resizeFrameSyncRequested && resizeEngine?.needsFrameSync()) {
      resizeSnapshot = resizeEngine.apply("frame");
      syncPresentationUnderlays(resizeSnapshot);
      if (resizeSnapshot.changed) {
        renderDirty = true;
        renderer.markDirty();
      }
    }
    const imageMutationSerial = LingoImage.currentMutationSerial();
    if (imageMutationSerial !== lastImageMutationSerial) {
      lastImageMutationSerial = imageMutationSerial;
      renderDirty = true;
      renderer.markDirty();
    }
    const focusedSprite = Number(movie.keyboardFocusSprite) | 0;
    const focusedSpriteChanged = focusedSprite !== lastFocusedSprite;
    if (focusedSpriteChanged) {
      lastFocusedSprite = focusedSprite;
      renderDirty = true;
    }
    const caretBlinkEpoch = Math.floor(now / 500);
    if (focusedSprite > 0 && caretBlinkEpoch !== lastCaretBlinkEpoch) {
      lastCaretBlinkEpoch = caretBlinkEpoch;
      renderDirty = true;
    }
    syncCustomHotelViewPresentation();
    const holdRoomAssets = shouldHoldRoomAssetPresentation(getRoomAssetBuffer());
    if (holdRoomAssets !== lastRoomAssetPresentationHold) {
      appendLog(
        "info",
        holdRoomAssets
          ? "room presentation hold: waiting for room asset placeholders to finalize"
          : "room presentation hold released: room asset placeholders finalized",
      );
      lastRoomAssetPresentationHold = holdRoomAssets;
      engineFeaturePresentationsDirty = true;
      renderDirty = true;
    }
    const roomFeature = roomFeatureIdentity();
    if (roomFeature.component !== lastRoomFeatureComponent || roomFeature.key !== lastRoomFeatureKey) {
      lastRoomFeatureComponent = roomFeature.component;
      lastRoomFeatureKey = roomFeature.key;
      markEngineFeaturePresentationsDirty();
    }
    if (!engineFeaturePresentationsDirty) {
      if (roomMotionRefreshRequested && now - lastRoomMotionRefreshAt >= ROOM_MOTION_REFRESH_INTERVAL_MS) {
        roomMotionRefreshRequested = false;
        roomMotionPresentationDirty = true;
        lastRoomMotionRefreshAt = now;
      }
      if (sourceWindowRefreshRequested && now - lastSourceWindowRefreshAt >= SOURCE_WINDOW_REFRESH_INTERVAL_MS) {
        refreshSourceWindowPresentation();
      }
    }
    if (engineFeaturePresentationsDirty) {
      refreshEngineFeaturePresentations();
      engineFeaturePresentationsRefreshed = true;
    } else if (userNameLabelsPresentationDirty) {
      refreshUserNameLabelPresentation();
      userNameLabelsOnlyRefreshed = true;
    }
    if (!holdRoomAssets) {
      if (engineFeaturePresentationsRefreshed) {
        renderer.setRoomStagePresentation(roomStagePresentationController?.presentation() ?? null);
        renderer.setManualHiddenChannels(cachedManualHiddenChannels);
        renderer.setUserNameLabels(userNameLabelController?.presentation() ?? []);
      } else if (userNameLabelsOnlyRefreshed) {
        renderer.setUserNameLabels(userNameLabelController?.presentation() ?? []);
      }
      applyModernPresentationSettings();
      if (renderDirty || renderer.needsSync()) {
        const prepareStart = performance.now();
        movie.prepareTextSpriteImages(focusedSprite, {
          shouldPrepareChannel: (channelNumber, focused) => renderer.shouldPrepareTextChannel(channelNumber, focused),
        });
        prepareTextMs = performance.now() - prepareStart;
        phaseTimings.prepareTextSpriteImages.add(prepareTextMs);
        const syncStart = performance.now();
        renderer.sync(movie.channels, focusedSprite);
        rendererSyncMs = performance.now() - syncStart;
        phaseTimings.rendererSync.add(rendererSyncMs);
        lastImageMutationSerial = LingoImage.currentMutationSerial();
        renderDirty = false;
      }
    } else {
      renderer.setRoomStagePresentation(null);
      renderer.setUserNameLabels([]);
      renderDirty = false;
    }
    if (renderDiagnosticsEnabled && now - lastRenderDiagnosticsLogAt >= 1_000) {
      lastRenderDiagnosticsLogAt = now;
      const copies = copyTraceStats.lastSecond(now);
      const tick = phaseTimings.movieTick.summary();
      const text = phaseTimings.prepareTextSpriteImages.summary();
      const sync = phaseTimings.rendererSync.summary();
      const render = phaseTimings.appRender.summary();
      appendLog(
        "info",
        `[render-diagnostics] copies/s total=${copies.total} staged=${copies.staged} directCandidates=${copies.directCopyCandidates} tick.p95=${tick.p95Ms}ms text.p95=${text.p95Ms}ms sync.p95=${sync.p95Ms}ms appRender.p95=${render.p95Ms}ms`,
      );
    }
    const presentationDiagnostics = renderer.presentationDiagnostics();
    directorCursorPresentation.sync();
    const sampleTimings = {
      rafDeltaMs: Math.round(rafDelta * 100) / 100,
      movieTickMs: Math.round(movieTickMs * 100) / 100,
      prepareTextMs: Math.round(prepareTextMs * 100) / 100,
      rendererSyncMs: Math.round(rendererSyncMs * 100) / 100,
    };
    animateSceneEffectOverlay(now);
    sceneEffectOverlayOnTop();
    const appRenderStart = performance.now();
    app.render();
    rendererHealthMonitor.markFrame();
    appRenderMs = performance.now() - appRenderStart;
    phaseTimings.appRender.add(appRenderMs);
    const roundedAppRenderMs = Math.round(appRenderMs * 100) / 100;
    frameStutterDiagnostics.record({
      atMs: Math.round(now),
      ...sampleTimings,
      appRenderMs: roundedAppRenderMs,
      dominantPhase: classifyFrameStutterPhase({ ...sampleTimings, appRenderMs: roundedAppRenderMs }),
      sourceWindowCount: cachedSourceWindowCount,
      sourceWindowChannelCount: cachedSourceWindowChannels.size,
      avatarInterpolation: presentationDiagnostics.avatarInterpolation,
      roomMotion: cachedRoomMotionDiagnostics,
      sourceWindowBudget: presentationDiagnostics.sourceWindowBudget,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setupQuickLoginPanel(): void {
  const panel = document.getElementById("quick-login-panel");
  const emailInput = document.getElementById("quick-login-email") as HTMLInputElement | null;
  const passwordInput = document.getElementById("quick-login-password") as HTMLInputElement | null;
  const button = document.getElementById("quick-login-submit") as HTMLButtonElement | null;
  const message = document.getElementById("quick-login-message");
  if (!panel || !emailInput || !passwordInput || !button || !message) return;
  const params = new URLSearchParams(location.search);
  if (params.get("standalone") === "1") {
    panel.remove();
    return;
  }
  document.body.dataset.devQuickLogin = "1";
  emailInput.value = params.get("quickEmail") ?? localStorage.getItem("habbo.quick.email") ?? "";
  passwordInput.value = params.get("quickPassword") ?? localStorage.getItem("habbo.quick.password") ?? "";
  for (const input of [emailInput, passwordInput]) {
    input.addEventListener("keydown", (event) => event.stopPropagation());
    input.addEventListener("keyup", (event) => event.stopPropagation());
  }
  button.addEventListener("click", async () => {
    const engine = (window as unknown as {
      __engine?: { dev?: { login?: (email: string, password: string, delayMs?: number) => Promise<unknown> } };
    }).__engine;
    const login = engine?.dev?.login;
    if (!login) {
      message.textContent = "engine not ready";
      return;
    }
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      message.textContent = "enter credentials";
      return;
    }
    localStorage.setItem("habbo.quick.email", email);
    localStorage.setItem("habbo.quick.password", password);
    button.disabled = true;
    message.textContent = "sending login";
    try {
      await login(email, password, 10);
      message.textContent = "login sent";
    } catch (error) {
      message.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}

boot().catch((error) => {
  statusEl.textContent = `boot failed: ${String(error)}`;
  appendLog("error", String(error));
});
