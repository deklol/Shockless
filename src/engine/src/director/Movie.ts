import {
  ChunkRef,
  DirectorHost,
  type GeneratedScriptModule,
  MissingScriptRef,
  Runtime,
  ScriptInstance,
  ScriptingObjectRef,
  UnsupportedFeatureError,
} from "./Runtime";
import { normalizeDirectorCursorValue } from "./cursor";
import { inspectDirectorBitmapMedia, type DirectorBitmapMediaInspection } from "./directorBitmapMedia";
import {
  dispatchDirectorEvent,
  type DirectorEventDispatchResult,
  type DirectorEventHandler,
  type DirectorEventLocation,
} from "./eventDispatch";
import { LingoColor, LingoDate, LingoPoint, LingoRect } from "./geometry";
import { LingoBitmapMedia, LingoImage } from "./imaging";
import {
  LINGO_VOID,
  LingoList,
  LingoObjectLike,
  LingoPropList,
  LingoSymbol,
  LingoValue,
  LingoVoid,
  duplicateValue,
  isNumber,
  numberOf,
} from "./values";
import { CastMember, CastRegistry } from "./members";
import { SystemDirectorAudioClock, type DirectorAudioClock } from "./audio/clock";
import { DirectorSoundRef, DirectorSoundSystem } from "./audio/DirectorSoundSystem";
import { SoundChannelRef } from "./audio/DirectorSoundChannel";
import type { DirectorSoundManifestMedia } from "./audio/media";
import type { DirectorSoundBackend, DirectorSoundChannelSnapshot } from "./audio/types";
import { VirtualAudioBackend } from "./audio/VirtualAudioBackend";
import {
  DirectorAudioTraceBuffer,
  TracingAudioBackend,
  type DirectorAudioTraceContext,
  type DirectorAudioTraceEvent,
} from "./audio/TracingAudioBackend";
import {
  createDirectorNetworkHost,
  type DirectorNetworkBridgeOptions,
  type DirectorNetworkHost,
} from "./network";
import { LAST_CHANNEL, SpriteChannel, createChannels } from "./sprites";
import * as ops from "./ops";
import { CastLibRef, StageRef, TimeoutRef, formatDirectorTime } from "./movieObjects";
import { DirectorNetJobs } from "./movieNetJobs";
import { DirectorSpriteInput } from "./spriteInput";
export { SoundChannelRef } from "./audio/DirectorSoundChannel";
export { CastLibRef, StageRef, TimeoutRef } from "./movieObjects";

/**
 * Minimal Director movie host: score frame loop, markers, frame behaviors,
 * tempo, castLib references, and the network-preload builtins the release306
 * entry movie uses (preloadNetThing/netDone). Rendering is delegated to a
 * presenter callback; game behavior comes entirely from generated code.
 */

export interface ManifestCast {
  number: number;
  name: string;
  members: {
    number: number;
    name: string;
    type: string;
    sound?: DirectorSoundManifestMedia;
  }[];
}

export interface ManifestScore {
  frameRate: number;
  markers: { name: string; frame: number }[];
  behaviors: {
    startFrame: number;
    endFrame: number;
    channel: number;
    script: { castLib: number; member: number };
  }[];
  frames: { index: number }[];
}

export interface MovieManifest {
  stage: { width: number; height: number; backgroundColor: string };
  casts: ManifestCast[];
  score: ManifestScore;
}

type ScoreBehavior = ManifestScore["behaviors"][number];
type TextLayoutRow = { text: string; start: number; end: number; line: number };

const TEXT_CHUNK_STYLE_PROPERTIES = new Set(["color", "font", "fontsize", "fontstyle"]);
const POINTER_TARGET_EVENTS = ["mouseenter", "mouseleave", "mousewithin", "mousedown", "mouseup", "mouseupoutside"];
const DOUBLE_CLICK_INTERVAL_MS = 500;
const DOUBLE_CLICK_DISTANCE_PX = 4;
const DIRECTOR_TEXT_ANTIALIAS_THRESHOLD = 14;
const DARK_TEXT_BITMAP_ALPHA_THRESHOLD = 64;
const LIGHT_TEXT_BITMAP_ALPHA_THRESHOLD = 160;
const MAX_DIAGNOSTIC_DEDUPE_KEYS = 512;

export interface MovieLogSink {
  log(kind: "info" | "error" | "put", text: string): void;
}

export class DirectorMovie implements DirectorHost {
  /** Diagnostic-only member image trace. Names are lower-case cast member names
   * or numeric slot ids, wired from app query parameters when needed. */
  readonly traceMemberImages = new Set<string>();
  readonly runtime: Runtime;
  private readonly network: DirectorNetworkHost;
  private readonly spriteInput: DirectorSpriteInput;
  private currentFrame = 1;
  private nextFrameOverride: number | null = null;
  private tempo: number;
  private readonly castLibs: CastLibRef[];
  private readonly stage = new StageRef();
  private stageViewport = { width: 0, height: 0 };
  private readonly behaviorInstances = new Map<string, ScriptInstance>();
  private readonly markerNameByFrame = new Map<number, string>();
  private readonly markerFrameByName = new Map<string, number>();
  private readonly behaviorsByFrame = new Map<number, ScoreBehavior[]>();
  private readonly primaryEventScripts = new Map<string, LingoValue>();
  private readonly textLayoutCache = new WeakMap<CastMember, { version: number; rows: TextLayoutRow[] }>();
  private preloads = new Map<string, "loading" | "done" | "failed">();
  private halted: string | null = null;
  private readonly netJobs: DirectorNetJobs;
  private readonly timeouts = new Map<string, TimeoutRef>();
  private readonly soundSystem: DirectorSoundSystem;
  private readonly audioTrace: DirectorAudioTraceBuffer;
  private tickCounter = 0;
  private lastTickTimeMs = 0;
  private prepareFrameDispatchDepth = 0;

  dropTimeout(name: string): void {
    this.timeouts.delete(name.toLowerCase());
  }

  /** Director resolves relative net URLs against the movie path. Dead
   * origins-gamedata.habbo.com endpoints mirror to the local client files
   * (same approach as the original hotel page's sw-param overrides). */
  private resolveUrl(url: string): string {
    const gamedata = /^https?:\/\/origins-gamedata\.habbo\.com\/([a-z_]+)\/\d+/i.exec(url);
    if (gamedata) {
      const fileByEndpoint: Record<string, string> = {
        external_variables: "external_variables.txt",
        external_texts: "external_texts.txt",
        figuredata_xml: "figuredata.xml",
      };
      const file = fileByEndpoint[gamedata[1]!.toLowerCase()];
      if (file) return this.moviePath + file;
    }
    if (/^(https?:)?\/\//i.test(url) || url.startsWith("/")) {
      return url;
    }
    return this.moviePath + url;
  }

  /** Fires due timeouts; called from tick(). */
  private fireTimeouts(): void {
    const now = Date.now();
    for (const timeoutRef of [...this.timeouts.values()]) {
      if (!timeoutRef.active || now < timeoutRef.nextFireAt) continue;
      timeoutRef.nextFireAt = now + timeoutRef.periodMs;
      const handlerName =
        timeoutRef.handler instanceof LingoSymbol
          ? timeoutRef.handler.name
          : ops.stringOf(timeoutRef.handler);
      const target = timeoutRef.target;
      this.guard(`timeout ${timeoutRef.name}`, () => {
        if (target instanceof ScriptInstance) {
          this.runtime.callMethod(target, handlerName.toLowerCase(), [timeoutRef]);
        } else {
          this.runtime.call(handlerName.toLowerCase(), [timeoutRef]);
        }
      });
    }
  }

  /** Director updateStage runs prepareFrame work before redrawing the stage.
   * Habbo's Object Manager uses a timeout target prepareFrame handler to pump
   * its #prepare/#update lists, including active window drags. */
  private dispatchPrepareFrameTargets(reason: string): void {
    this.prepareFrameDispatchDepth += 1;
    try {
      for (const timeoutRef of [...this.timeouts.values()]) {
        const target = timeoutRef.target;
        if (
          timeoutRef.active &&
          target instanceof ScriptInstance &&
          this.runtime.hasHandler(target, "prepareframe")
        ) {
          this.guard(`${reason}:prepareFrame(${timeoutRef.name})`, () => {
            this.runtime.callMethod(target, "prepareframe", []);
          });
        }
      }
    } finally {
      this.prepareFrameDispatchDepth = Math.max(0, this.prepareFrameDispatchDepth - 1);
    }
  }

  updateStage(): void {
    if (this.halted) return;
    if (this.prepareFrameDispatchDepth === 0) {
      this.dispatchPrepareFrameTargets("updateStage");
    }
    this.onStageChange();
  }

  centerStage = 0;
  exitLock = 0;
  alertHook: LingoValue = LINGO_VOID;
  stageBgColor: LingoValue = 0;
  /** Live pointer position over the stage (updated by the app shell). */
  mouseH = 0;
  mouseV = 0;
  /** Director global cursor command state. Sprite-channel cursors still win
   * while the pointer is over a sprite with its own cursor property. */
  globalCursor: LingoValue = 0;
  mouseDownFlag = 0;
  private clickOnSprite = 0;
  private clickLocH = 0;
  private clickLocV = 0;
  private doubleClickFlag = 0;
  private lastMouseDownTimeMs = 0;
  private lastMouseDownH = Number.NaN;
  private lastMouseDownV = Number.NaN;
  private lastMouseDownDoubleClickSprite: SpriteChannel | null = null;
  private pendingDoubleClickFlag = 0;
  keyboardFocusSprite: LingoValue = 0;
  /** `the key` / `the keyCode` of the most recent keyboard event. */
  lastKey = "";
  lastKeyCode = 0;
  private lastKeyTimeMs = Date.now();
  /** Director keeps the currently pressed key available during key handlers. */
  keyPressed = "";
  shiftDown = 0;
  controlDown = 0;
  optionDown = 0;
  commandDown = 0;
  /** Global text selection endpoints used by Director text/field editing. */
  selStart = 0;
  selEnd = 0;
  /** Sprite that received the last mouseDown (mouseUp vs mouseUpOutSide). */
  private mouseDownSprite: SpriteChannel | null = null;
  private hoverSprite: SpriteChannel | null = null;
  private rolloverSprite: SpriteChannel | null = null;
  private textMeasureContext: CanvasRenderingContext2D | null | undefined;

  readonly channels = createChannels();
  onObjectRegistered: (id: LingoValue, object: LingoValue, classList: LingoValue) => void = () => {};
  onCastLoaded: (castName: string, castNumber: number) => void = () => {};
  /** Notified when a runtime image buffer is permanently replaced, so the
   * presenter can destroy its GPU texture instead of leaking it. */
  onImageReleased: (image: LingoImage) => void = () => {};
  /** Optional app-level hit override for source-owned UI sprites. */
  inputHitTestOverride: (channel: SpriteChannel, x: number, y: number) => boolean | null = () => null;

  constructor(
    private readonly manifest: MovieManifest,
    private readonly log: MovieLogSink,
    private readonly fetchPreload: (fileName: string) => Promise<void>,
    private readonly fetchText: (url: string) => Promise<string>,
    private readonly members: CastRegistry,
    private readonly onStageChange: () => void = () => {},
    /** Base URL the original movie lives at; cast fileNames resolve here. */
    private readonly moviePath = "/origins-data/source/",
    /** Shockwave embed parameters (sw1..sw9): the original hotel page's
     * config-injection mechanism (Core Thread parses them in Plugin mode). */
    private readonly externalParams = new Map<string, string>(),
    /** Decodes a loaded cast's bitmap PNGs into image buffers (browser);
     * no-op in the Node simulator. */
    private readonly decodeCastImages: (castName: string) => Promise<void> = async () => {},
    /** Director Multiuser/BobbaXtra shim backed by the local Origins 306
     * relay. The browser side stays plaintext; the relay owns BobbaCrypto. */
    networkOptions: DirectorNetworkBridgeOptions = {},
    /** Live stage-image snapshot provider for `(the stage).image`. The
     * Director host owns the API shape; the browser app supplies Pixi pixels. */
    private readonly stageImageProvider: () => LingoImage | null = () => null,
    soundBackend: DirectorSoundBackend = new VirtualAudioBackend(),
    audioClock: DirectorAudioClock = new SystemDirectorAudioClock(),
  ) {
    this.runtime = new Runtime(this);
    this.audioTrace = new DirectorAudioTraceBuffer(audioClock);
    this.soundSystem = new DirectorSoundSystem({
      findMember: (value) => this.members.find(value, null),
      backend: new TracingAudioBackend(soundBackend, this.audioTrace),
      clock: audioClock,
      reportError: (message, error) => {
        const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`;
        this.log.log("error", `${message}${detail}`);
      },
    });
    this.runtime.setGlobal("_sound", this.soundSystem.object);
    this.netJobs = new DirectorNetJobs({
      members,
      resolveUrl: (url) => this.resolveUrl(url),
      fetchText,
      tickCounter: () => this.tickCounter,
      log: (kind, message) => this.log.log(kind, message),
    });
    this.spriteInput = new DirectorSpriteInput({
      channels: this.channels,
      spriteRect: (sprite) => this.spriteRect(sprite),
      channelEditable: (channel) => this.channelEditable(channel),
      channelHasAnyHandler: (channel, events) => this.channelHasAnyHandler(channel, events),
      inputHitTestOverride: (channel, x, y) => this.inputHitTestOverride(channel, x, y),
      spriteWidth: (sprite) => this.spriteWidth(sprite),
      spriteHeight: (sprite) => this.spriteHeight(sprite),
      memberWidth: (member) => this.memberWidth(member),
      memberHeight: (member) => this.memberHeight(member),
      aliasMirrorTransform: (sprite) => this.isAliasMirrorTransform(sprite),
      degreesToRadians: (value) => this.degreesToRadians(value),
      spriteRegX: (sprite) => this.spriteRegX(sprite),
      spriteRegY: (sprite) => this.spriteRegY(sprite),
    });
    this.network = createDirectorNetworkHost(
      networkOptions,
      (target, handlerName) => {
        this.runtime.callMethod(target, handlerName, []);
      },
      (message) => this.log.log("info", message),
    );
    this.tempo = manifest.score.frameRate;
    this.castLibs = manifest.casts.map((cast) => new CastLibRef(cast.number, cast.name));
    this.indexScore(manifest.score);
    this.stageViewport = {
      width: manifest.stage.width,
      height: manifest.stage.height,
    };
  }

  private shouldTraceMemberImage(member: CastMember): boolean {
    if (this.traceMemberImages.size === 0) return false;
    const keys = [
      member.name.toLowerCase(),
      String(member.number),
      String(member.slotNumber),
      `${member.castName.toLowerCase()}:${member.number}`,
      `${member.castName.toLowerCase()}:${member.name.toLowerCase()}`,
    ];
    return this.traceMemberImages.has("*") || keys.some((key) => this.traceMemberImages.has(key));
  }

  private traceMemberImage(member: CastMember, operation: string, image: LingoImage): void {
    if (!this.shouldTraceMemberImage(member)) return;
    const bitmapSize = member.bitmap ? `${member.bitmap.width}x${member.bitmap.height}` : "-";
    const existingSize = member.image ? `${member.image.width}x${member.image.height}` : "-";
    const stack = this.runtime.callStack.slice(-8).join(" > ") || "(host)";
    this.log.log(
      "info",
      `[member-image] ${operation} ${member.castName}.${member.name || `member ${member.number}`} ` +
        `member=${member.number} slot=${member.slotNumber} bitmap=${bitmapSize} existing=${existingSize} ` +
        `image=${image.width}x${image.height} depth=${image.depth} reg=${member.regX},${member.regY} stack=${stack}`,
    );
  }

  private traceMemberMutation(member: CastMember, operation: string, details: string): void {
    if (!this.shouldTraceMemberImage(member)) return;
    const bitmapSize = member.bitmap ? `${member.bitmap.width}x${member.bitmap.height}` : "-";
    const existingSize = member.image ? `${member.image.width}x${member.image.height}` : "-";
    const stack = this.runtime.callStack.slice(-8).join(" > ") || "(host)";
    this.log.log(
      "info",
      `[member-image] ${operation} ${member.castName}.${member.name || `member ${member.number}`} ` +
        `member=${member.number} slot=${member.slotNumber} bitmap=${bitmapSize} existing=${existingSize} ${details} stack=${stack}`,
    );
  }

  private indexScore(score: ManifestScore): void {
    for (const marker of score.markers) {
      if (!this.markerNameByFrame.has(marker.frame)) {
        this.markerNameByFrame.set(marker.frame, marker.name);
      }
      const nameKey = marker.name.toLowerCase();
      if (!this.markerFrameByName.has(nameKey)) {
        this.markerFrameByName.set(nameKey, marker.frame);
      }
    }
    for (const behavior of score.behaviors) {
      for (let frame = behavior.startFrame; frame <= behavior.endFrame; frame += 1) {
        const entries = this.behaviorsByFrame.get(frame);
        if (entries) entries.push(behavior);
        else this.behaviorsByFrame.set(frame, [behavior]);
      }
    }
  }

  get frame(): number {
    return this.currentFrame;
  }

  get frameTempo(): number {
    return this.tempo;
  }

  get haltedReason(): string | null {
    return this.halted;
  }

  tickDiagnostics(): {
    tickCount: number;
    lastTickTimeMs: number;
    timeouts: Array<{
      name: string;
      active: boolean;
      periodMs: number;
      dueInMs: number;
      handler: string;
      targetType: string;
      targetScript: string | null;
    }>;
  } {
    const now = Date.now();
    return {
      tickCount: this.tickCounter,
      lastTickTimeMs: this.lastTickTimeMs,
      timeouts: [...this.timeouts.values()].map((timeoutRef) => ({
        name: timeoutRef.name,
        active: timeoutRef.active,
        periodMs: timeoutRef.periodMs,
        dueInMs: timeoutRef.active ? Math.max(0, timeoutRef.nextFireAt - now) : 0,
        handler:
          timeoutRef.handler instanceof LingoSymbol
            ? `#${timeoutRef.handler.name}`
            : ops.displayString(timeoutRef.handler),
        targetType:
          timeoutRef.target instanceof LingoVoid
            ? "void"
            : typeof timeoutRef.target === "object" && timeoutRef.target && "lingoType" in timeoutRef.target
              ? String((timeoutRef.target as LingoObjectLike).lingoType)
              : typeof timeoutRef.target,
        targetScript: timeoutRef.target instanceof ScriptInstance ? timeoutRef.target.module.scriptName : null,
      })),
    };
  }

  get stageViewportWidth(): number {
    return this.stageViewport.width;
  }

  get stageViewportHeight(): number {
    return this.stageViewport.height;
  }

  get manifestStageWidth(): number {
    return this.manifest.stage.width;
  }

  get manifestStageHeight(): number {
    return this.manifest.stage.height;
  }

  setStageViewport(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (nextWidth === this.stageViewport.width && nextHeight === this.stageViewport.height) return;
    this.stageViewport = { width: nextWidth, height: nextHeight };
    this.onStageChange();
  }

  resetStageViewport(): void {
    this.setStageViewport(this.manifest.stage.width, this.manifest.stage.height);
  }

  get networkBridgeUrl(): string {
    return this.network.bridgeUrl;
  }

  objectRegistered = (id: LingoValue, object: LingoValue, classList: LingoValue): void => {
    this.onObjectRegistered(id, object, classList);
  };

  markerName(frame: number): string | null {
    return this.markerNameByFrame.get(frame) ?? null;
  }

  private castLibNameForNumber(castNumber: number): string | null {
    return this.castLibs.find((cast) => cast.number === castNumber)?.name ?? null;
  }

  private ensureCastLib(name: string): CastLibRef {
    const existing = this.castLibs.find((cast) => cast.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const nextNumber = Math.max(0, ...this.castLibs.map((cast) => cast.number)) + 1;
    const cast = new CastLibRef(nextNumber, name);
    this.castLibs.push(cast);
    return cast;
  }

  private assignSpriteMember(channel: SpriteChannel, value: LingoValue, castName: string | null = null): void {
    const previousMember = channel.member;
    const previousCastLibNum = channel.castLibNum;
    if (value instanceof CastMember) {
      channel.member = value;
      channel.castLibNum = value.castNumber;
      if (channel.member !== previousMember || channel.castLibNum !== previousCastLibNum) channel.markChanged();
      return;
    }
    if (value === 0 || value instanceof LingoVoid) {
      channel.member = null;
      if (previousMember !== null) channel.markChanged();
      return;
    }
    const member = this.members.find(value, castName);
    channel.member = member;
    if (member) {
      channel.castLibNum = member.castNumber;
    }
    if (channel.member !== previousMember || channel.castLibNum !== previousCastLibNum) channel.markChanged();
  }

  private setSpriteNumberProperty(channel: SpriteChannel, key: keyof SpriteChannel & string, value: number): boolean {
    if (channel[key] === value) return false;
    (channel as unknown as Record<string, unknown>)[key] = value;
    channel.markChanged();
    return true;
  }

  private setSpriteValueProperty(channel: SpriteChannel, key: keyof SpriteChannel & string, value: LingoValue): boolean {
    if (channel[key] === value) return false;
    (channel as unknown as Record<string, unknown>)[key] = value;
    channel.markChanged();
    return true;
  }

  private soundChannel(value: LingoValue): SoundChannelRef {
    return this.soundSystem.channel(value);
  }

  /** Director legacy facade. `puppetSound sound` targets channel 1, while
   * `puppetSound channel, sound` targets the requested one of eight channels.
   * Both forms feed the same modern sound-channel implementation. */
  private puppetSound(args: LingoValue[]): number {
    if (args.length < 1) return 0;
    const channelValue = args.length >= 2 ? args[0] ?? 1 : 1;
    const memberValue = args.length >= 2 ? args[1] ?? LINGO_VOID : args[0] ?? LINGO_VOID;
    return this.soundChannel(channelValue).play(memberValue);
  }

  async resumeAudio(): Promise<void> {
    await this.soundSystem.resume();
  }

  soundSnapshot(): readonly DirectorSoundChannelSnapshot[] {
    return this.soundSystem.snapshot();
  }

  setAudioTraceEnabled(enabled: boolean): void {
    this.audioTrace.setEnabled(enabled);
  }

  setAudioTraceContext(context: DirectorAudioTraceContext): void {
    this.audioTrace.setContext(context);
  }

  audioTraceSnapshot(): readonly DirectorAudioTraceEvent[] {
    return this.audioTrace.snapshot();
  }

  exportAudioTrace(): string {
    return this.audioTrace.exportJson();
  }

  clearAudioTrace(): void {
    this.audioTrace.clear();
  }

  audioCommand(channel: LingoValue, command: string, args: LingoValue[] = []): LingoValue {
    return this.runtime.callMethod(this.soundChannel(channel), command, args);
  }

  disposeAudio(): void {
    this.soundSystem.dispose();
  }

  /** Run prepareMovie (movie scripts), then the frame loop begins. */
  start(): void {
    this.guard("prepareMovie", () => {
      this.runtime.call("preparemovie", []);
    });
  }

  /** One score tick: prepareFrame to timeout targets (Director sends frame
   * events to timeout targets; the Object Manager's 1-hour #null timeout
   * exists precisely to receive prepareFrame and pump #prepare/#update),
   * then exitFrame to frame behaviors, then advance the playback head. */
  tick(): void {
    this.soundSystem.update();
    this.tickCounter += 1;
    this.lastTickTimeMs = Date.now();
    if (this.halted) return;
    this.nextFrameOverride = null;
    this.dispatchPrepareFrameTargets("tick");
    const behaviors = this.behaviorsByFrame.get(this.currentFrame) ?? [];
    for (const behavior of behaviors) {
      const instance = this.scoreBehaviorInstance(behavior, true);
      if (!instance) continue;
      const target = instance;
      this.guard(`exitFrame @${this.currentFrame}`, () => {
        if (target.module.handlers["exitframe"]) {
          this.runtime.callMethod(target, "exitframe", []);
        }
      });
      if (this.halted) return;
    }
    this.fireTimeouts();
    const total = this.manifest.score.frames.length;
    const next = this.nextFrameOverride ?? this.currentFrame + 1;
    this.currentFrame = Math.max(1, Math.min(total, next));
  }

  private resolveScript(castLibNumber: number, memberNumber: number) {
    const cast = this.manifest.casts.find((entry) => entry.number === castLibNumber);
    const member = cast?.members.find((entry) => entry.number === memberNumber);
    if (!cast || !member) return null;
    return (
      this.runtime.findScriptByMember(cast.name, member.number)?.module ??
      this.runtime.findScript(member.name)?.module ??
      null
    );
  }

  private scoreBehaviorInstance(behavior: ScoreBehavior, reportMissing: boolean): ScriptInstance | null {
    const key = `${behavior.script.castLib}:${behavior.script.member}:${behavior.startFrame}`;
    const existing = this.behaviorInstances.get(key);
    if (existing) return existing;
    const module = this.resolveScript(behavior.script.castLib, behavior.script.member);
    if (!module) {
      if (reportMissing) {
        this.log.log(
          "error",
          `missing behavior script castLib ${behavior.script.castLib} member ${behavior.script.member}`,
        );
      }
      return null;
    }
    const instance = new ScriptInstance(module);
    this.behaviorInstances.set(key, instance);
    return instance;
  }

  // -- Input event dispatch ---------------------------------------------------

  /** Topmost visible puppet sprite whose rect contains the stage point. */
  spriteAt(x: number, y: number): SpriteChannel | null {
    return this.spriteInput.spriteAt(x, y);
  }

  spritesAt(x: number, y: number): SpriteChannel[] {
    return this.spriteInput.spritesAt(x, y);
  }

  spriteBounds(channelNumber: number): LingoRect | null {
    return this.spriteInput.spriteBounds(channelNumber);
  }

  inputSpriteAt(x: number, y: number, events: readonly string[] = POINTER_TARGET_EVENTS): SpriteChannel | null {
    return this.spriteInput.eventSpriteAt(x, y, events);
  }

  private channelHasHandler(channel: SpriteChannel, event: string): boolean {
    for (const instance of channel.scriptInstanceList.items) {
      if (instance instanceof ScriptInstance && this.runtime.hasHandler(instance, event)) {
        return true;
      }
    }
    return this.castScriptForChannel(channel)?.handlers[event.toLowerCase()] !== undefined;
  }

  private channelHasAnyHandler(channel: SpriteChannel, events: readonly string[]): boolean {
    return events.some((event) => this.channelHasHandler(channel, event));
  }

  /** Director exposes `the rollover` as the current effective sprite channel
   * under the pointer, using the same target filtering as primary input. */
  private currentRolloverSprite(events: readonly string[] = POINTER_TARGET_EVENTS): SpriteChannel | null {
    return this.spriteInput.eventSpriteAt(this.mouseH, this.mouseV, events);
  }

  private updateRolloverSprite(events: readonly string[]): SpriteChannel | null {
    this.rolloverSprite = this.currentRolloverSprite(events);
    return this.rolloverSprite;
  }

  private castScriptForChannel(channel: SpriteChannel | null): GeneratedScriptModule | null {
    const member = channel?.member;
    if (!member) return null;
    const module = this.runtime.findScriptModuleByMember(member.castName, member.number);
    return module?.scriptType === "cast" ? module : null;
  }

  private currentFrameHandlers(event: string, args: LingoValue[]): DirectorEventHandler[] {
    const handlers: DirectorEventHandler[] = [];
    for (const behavior of this.behaviorsByFrame.get(this.currentFrame) ?? []) {
      if (behavior.channel !== 0) continue;
      const instance = this.scoreBehaviorInstance(behavior, false);
      if (!instance || !this.runtime.hasHandler(instance, event)) continue;
      handlers.push({
        tier: "frame",
        label: `${instance.module.scriptName}.${event}`,
        invoke: () => this.runtime.callMethod(instance, event, args),
      });
    }
    return handlers;
  }

  private movieHandlerLocations(event: string, args: LingoValue[]): DirectorEventLocation[] {
    return this.runtime.movieEventModules(event).map((module) => ({
      tier: "movie" as const,
      handlers: [
        {
          tier: "movie" as const,
          label: `${module.scriptName}.${event}`,
          invoke: () => this.runtime.callScriptHandler(module, event, LINGO_VOID, args),
        },
      ],
    }));
  }

  private primaryHandler(event: string, args: LingoValue[]): DirectorEventHandler[] {
    const value = this.primaryEventScripts.get(`${event}script`);
    if (value === undefined || value instanceof LingoVoid || value === 0 || value === "") return [];
    const handlerName = value instanceof LingoSymbol ? value.name : ops.stringOf(value);
    if (!handlerName) return [];
    return [
      {
        tier: "primary",
        label: `primary.${handlerName.toLowerCase()}`,
        invoke: () => this.runtime.call(handlerName, args),
      },
    ];
  }

  private eventLocations(
    channel: SpriteChannel | null,
    event: string,
    args: LingoValue[],
    includePrimary: boolean,
  ): DirectorEventLocation[] {
    const locations: DirectorEventLocation[] = [];
    if (includePrimary) {
      locations.push({ tier: "primary", handlers: this.primaryHandler(event, args) });
    }

    const behaviors: DirectorEventHandler[] = [];
    if (channel) {
      for (const instance of [...channel.scriptInstanceList.items]) {
        if (!(instance instanceof ScriptInstance) || !this.runtime.hasHandler(instance, event)) continue;
        behaviors.push({
          tier: "behavior",
          label: `${instance.module.scriptName}.${event}`,
          invoke: () => this.runtime.callMethod(instance, event, args),
        });
      }
    }
    locations.push({ tier: "behavior", handlers: behaviors, broadcast: true });

    const castScript = this.castScriptForChannel(channel);
    locations.push({
      tier: "cast",
      handlers:
        castScript?.handlers[event] !== undefined
          ? [
              {
                tier: "cast",
                label: `${castScript.scriptName}.${event}`,
                invoke: () => this.runtime.callScriptHandler(castScript, event, LINGO_VOID, args),
              },
            ]
          : [],
    });
    locations.push({ tier: "frame", handlers: this.currentFrameHandlers(event, args), broadcast: true });
    locations.push(...this.movieHandlerLocations(event, args));
    return locations;
  }

  private dispatchEvent(
    label: string,
    locations: readonly DirectorEventLocation[],
  ): DirectorEventDispatchResult {
    let result: DirectorEventDispatchResult = {
      handled: false,
      consumed: false,
      defaultAllowed: true,
      stopped: false,
      passed: false,
      behaviorHandlerFound: false,
      lastResult: LINGO_VOID,
      route: [],
    };
    this.guard(label, () => {
      result = dispatchDirectorEvent(this.runtime, locations);
    });
    return result;
  }

  /** Sends a primary Director event through behavior, cast, frame, and movie tiers. */
  private sendSpriteEvent(channel: SpriteChannel | null, event: string): boolean {
    const normalized = event.toLowerCase();
    return this.dispatchEvent(
      `${normalized}(sprite ${channel?.number ?? 0})`,
      this.eventLocations(channel, normalized, [], true),
    ).consumed;
  }

  private eventName(value: LingoValue): string {
    return (value instanceof LingoSymbol ? value.name : ops.stringOf(value)).toLowerCase();
  }

  private spriteTarget(value: LingoValue): SpriteChannel | null {
    if (value instanceof SpriteChannel) return value;
    if (isNumber(value)) return this.channels[numberOf(value) | 0] ?? null;
    const name = ops.stringOf(value).toLowerCase();
    if (!name) return null;
    const numeric = Number(name);
    if (Number.isInteger(numeric) && numeric >= 0) return this.channels[numeric] ?? null;
    return (
      this.channels.find(
        (channel) =>
          channel.name.toLowerCase() === name ||
          (channel.name === "" && channel.member?.name.toLowerCase() === name),
      ) ?? null
    );
  }

  private sendSprite(target: LingoValue, eventValue: LingoValue, args: LingoValue[]): number {
    const channel = this.spriteTarget(target);
    const event = this.eventName(eventValue);
    if (!channel || !event) return 0;
    const result = this.dispatchEvent(
      `sendSprite ${event}(sprite ${channel.number})`,
      this.eventLocations(channel, event, args, false),
    );
    return result.behaviorHandlerFound ? 1 : 0;
  }

  private sendAllSprites(eventValue: LingoValue, args: LingoValue[]): number {
    const event = this.eventName(eventValue);
    if (!event) return 0;
    const channels = this.channels.filter(
      (channel) => channel.puppet === 1 && (channel.member !== null || channel.scriptInstanceList.count() > 0),
    );
    const behaviorHandlers: DirectorEventHandler[] = [];
    const castHandlers: DirectorEventHandler[] = [];
    for (const channel of channels) {
      for (const instance of channel.scriptInstanceList.items) {
        if (!(instance instanceof ScriptInstance) || !this.runtime.hasHandler(instance, event)) continue;
        behaviorHandlers.push({
          tier: "behavior",
          label: `sprite ${channel.number}:${instance.module.scriptName}.${event}`,
          invoke: () => this.runtime.callMethod(instance, event, args),
        });
      }
      const castScript = this.castScriptForChannel(channel);
      if (castScript?.handlers[event] !== undefined) {
        castHandlers.push({
          tier: "cast",
          label: `sprite ${channel.number}:${castScript.scriptName}.${event}`,
          invoke: () => this.runtime.callScriptHandler(castScript, event, LINGO_VOID, args),
        });
      }
    }
    const result = this.dispatchEvent(`sendAllSprites ${event}`, [
      { tier: "behavior", handlers: behaviorHandlers, broadcast: true },
      { tier: "cast", handlers: castHandlers, broadcast: true },
      { tier: "frame", handlers: this.currentFrameHandlers(event, args), broadcast: true },
      ...this.movieHandlerLocations(event, args),
    ]);
    return result.behaviorHandlerFound ? 1 : 0;
  }

  pointerMove(x: number, y: number): void {
    this.mouseH = Math.round(x);
    this.mouseV = Math.round(y);
    const over = this.updateRolloverSprite(["mouseenter", "mouseleave", "mousewithin", "mousedown", "mouseup"]);
    if (over !== this.hoverSprite) {
      this.sendSpriteEvent(this.hoverSprite, "mouseleave");
      this.hoverSprite = over;
      this.sendSpriteEvent(over, "mouseenter");
    } else {
      this.sendSpriteEvent(over, "mousewithin");
    }
  }

  /** A sprite takes keystrokes when the sprite or its field member is
   * editable (Field Wrapper sets member.editable = 1). */
  channelEditable(channel: SpriteChannel | null): boolean {
    if (!channel || !channel.member) return false;
    if (channel.editable === 1) return true;
    return Number(channel.member.style.get("editable") ?? 0) === 1;
  }

  private isKeyPressed(query: LingoValue): boolean {
    if (this.keyPressed === "") return false;
    if (isNumber(query)) {
      const code = numberOf(query);
      return code === this.lastKeyCode || code === this.keyPressed.charCodeAt(0);
    }
    const text = ops.stringOf(query);
    return text.length > 0 && text === this.keyPressed;
  }

  pointerDown(): void {
    this.mouseDownFlag = 1;
    const target = this.updateRolloverSprite(["mousedown", "mouseup", "mouseupoutside"]);
    this.clickOnSprite = target?.number ?? 0;
    this.clickLocH = this.mouseH;
    this.clickLocV = this.mouseV;
    const now = Date.now();
    const isDoubleClick =
      target !== null &&
      this.lastMouseDownDoubleClickSprite?.number === target.number &&
      now - this.lastMouseDownTimeMs <= DOUBLE_CLICK_INTERVAL_MS &&
      Math.abs(this.mouseH - this.lastMouseDownH) <= DOUBLE_CLICK_DISTANCE_PX &&
      Math.abs(this.mouseV - this.lastMouseDownV) <= DOUBLE_CLICK_DISTANCE_PX;
    this.pendingDoubleClickFlag = isDoubleClick ? 1 : 0;
    this.doubleClickFlag = this.pendingDoubleClickFlag;
    if (isDoubleClick) {
      this.lastMouseDownTimeMs = 0;
      this.lastMouseDownH = Number.NaN;
      this.lastMouseDownV = Number.NaN;
      this.lastMouseDownDoubleClickSprite = null;
    } else {
      this.lastMouseDownTimeMs = now;
      this.lastMouseDownH = this.mouseH;
      this.lastMouseDownV = this.mouseV;
      this.lastMouseDownDoubleClickSprite = target;
    }
    this.mouseDownSprite = target;
    // Director gives editable field sprites keyboard focus on click and
    // blurs them when the click lands elsewhere.
    this.keyboardFocusSprite = this.channelEditable(target) ? target!.number : 0;
    this.sendSpriteEvent(target, "mousedown");
  }

  pointerUp(): void {
    this.mouseDownFlag = 0;
    const downSprite = this.mouseDownSprite;
    this.mouseDownSprite = null;
    const target = this.updateRolloverSprite(["mouseup", "mouseupoutside", "mousedown"]);
    if (!downSprite) {
      this.sendSpriteEvent(null, "mouseup");
      this.pendingDoubleClickFlag = 0;
      this.doubleClickFlag = 0;
      return;
    }
    if (target === downSprite) {
      this.doubleClickFlag = this.pendingDoubleClickFlag;
      this.sendSpriteEvent(downSprite, "mouseup");
    } else {
      this.doubleClickFlag = this.pendingDoubleClickFlag;
      this.sendSpriteEvent(downSprite, "mouseupoutside");
    }
    this.pendingDoubleClickFlag = 0;
    this.doubleClickFlag = 0;
  }

  setKeyboardModifierState(modifiers: {
    readonly shiftDown?: boolean;
    readonly controlDown?: boolean;
    readonly optionDown?: boolean;
    readonly commandDown?: boolean;
  }): void {
    this.shiftDown = modifiers.shiftDown ? 1 : 0;
    this.controlDown = modifiers.controlDown ? 1 : 0;
    this.optionDown = modifiers.optionDown ? 1 : 0;
    this.commandDown = modifiers.commandDown ? 1 : 0;
  }

  keyDown(key: string, keyCode: number, shiftDown: boolean, controlDown = false, optionDown = false, commandDown = false): void {
    this.lastKey = key;
    this.lastKeyCode = keyCode;
    this.lastKeyTimeMs = Date.now();
    this.keyPressed = key;
    this.setKeyboardModifierState({ shiftDown, controlDown, optionDown, commandDown });
    const focus = Number(this.keyboardFocusSprite) | 0;
    const channel = focus > 0 ? (this.channels[focus] ?? null) : null;
    const editableMember = channel && this.channelEditable(channel) ? channel.member : null;
    const consumed = this.sendSpriteEvent(channel, "keydown");
    if (editableMember && key !== "\t" && !consumed) {
      this.applyFieldKey(editableMember, key);
    }
    if (editableMember && key === "\t" && !consumed && this.memberAutoTab(editableMember)) {
      this.focusAdjacentEditableSprite(focus, shiftDown);
    }
  }

  keyUp(key: string, keyCode: number, shiftDown: boolean, controlDown = false, optionDown = false, commandDown = false): void {
    this.lastKey = key;
    this.lastKeyCode = keyCode;
    this.keyPressed = "";
    this.setKeyboardModifierState({ shiftDown, controlDown, optionDown, commandDown });
    const focus = Number(this.keyboardFocusSprite) | 0;
    const channel = focus > 0 ? (this.channels[focus] ?? null) : null;
    this.sendSpriteEvent(channel, "keyup");
  }

  hasEditableKeyboardFocus(): boolean {
    return this.focusedEditableMember() !== null;
  }

  selectFocusedEditableText(): boolean {
    const member = this.focusedEditableMember();
    if (!member) return false;
    this.selStart = 1;
    this.selEnd = member.text.length + 1;
    this.onStageChange();
    return true;
  }

  copyFocusedEditableText(): string | null {
    const member = this.focusedEditableMember();
    if (!member) return null;
    const range = this.editableSelectionRange(member);
    if (range.start === range.end) return member.text;
    return member.text.slice(range.start, range.end);
  }

  cutFocusedEditableText(): string | null {
    const member = this.focusedEditableMember();
    if (!member) return null;
    const range = this.editableSelectionRange(member);
    const text = member.text.slice(range.start, range.end);
    if (range.start !== range.end) this.replaceEditableRange(member, range.start, range.end, "");
    return text;
  }

  pasteFocusedEditableText(text: string): boolean {
    const member = this.focusedEditableMember();
    if (!member) return false;
    const normalized = String(text ?? "").replace(/\r\n/g, "\r").replace(/\n/g, "\r");
    const range = this.editableSelectionRange(member);
    this.replaceEditableRange(member, range.start, range.end, normalized);
    return true;
  }

  private focusedEditableMember(): CastMember | null {
    const focus = Number(this.keyboardFocusSprite) | 0;
    const channel = focus > 0 ? (this.channels[focus] ?? null) : null;
    return channel && this.channelEditable(channel) ? channel.member : null;
  }

  /** Director's default editable-field behavior for unconsumed keystrokes. */
  private applyFieldKey(member: CastMember, key: string): void {
    const range = this.editableSelectionRange(member);
    if (key === "\b") {
      if (range.start !== range.end) {
        this.replaceEditableRange(member, range.start, range.end, "");
      } else if (range.start > 0) {
        this.replaceEditableRange(member, range.start - 1, range.start, "");
      }
      return;
    } else if (key.charCodeAt(0) === 127) {
      if (range.start !== range.end) {
        this.replaceEditableRange(member, range.start, range.end, "");
      } else if (range.start < member.text.length) {
        this.replaceEditableRange(member, range.start, range.start + 1, "");
      }
      return;
    } else if (key === "\r" || key === "\n" || key === "\t") {
      return; // return/tab are source-handler territory, not text insertion
    } else if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127) {
      this.replaceEditableRange(member, range.start, range.end, key);
      return;
    }
  }

  private editableSelectionRange(member: CastMember): { start: number; end: number } {
    const textLength = member.text.length;
    const rawStart = Number(this.selStart) | 0;
    const rawEnd = Number(this.selEnd) | 0;
    if (rawStart > 0 && rawEnd > 0) {
      const start = Math.max(0, Math.min(textLength, Math.min(rawStart, rawEnd) - 1));
      const end = Math.max(0, Math.min(textLength, Math.max(rawStart, rawEnd) - 1));
      return { start, end };
    }
    const caret = rawEnd > 0 ? Math.max(0, Math.min(textLength, rawEnd - 1)) : textLength;
    return { start: caret, end: caret };
  }

  private replaceEditableRange(member: CastMember, start: number, end: number, replacement: string): void {
    const textLength = member.text.length;
    const cleanStart = Math.max(0, Math.min(textLength, Math.trunc(start)));
    const cleanEnd = Math.max(cleanStart, Math.min(textLength, Math.trunc(end)));
    const nextText = `${member.text.slice(0, cleanStart)}${replacement}${member.text.slice(cleanEnd)}`;
    if (nextText === member.text && cleanStart === cleanEnd && replacement.length === 0) return;
    member.text = nextText;
    const caret = cleanStart + replacement.length + 1;
    this.selStart = caret;
    this.selEnd = caret;
    member.textVersion += 1;
    this.onStageChange();
  }

  private memberAutoTab(member: CastMember): boolean {
    const value = member.style.get("autotab");
    return value === undefined ? true : ops.truthy(value);
  }

  private focusAdjacentEditableSprite(current: number, reverse: boolean): void {
    const editable = this.channels
      .filter((channel) => channel.puppet === 1 && channel.visible === 1 && this.channelEditable(channel))
      .sort((left, right) => left.number - right.number);
    if (editable.length === 0) {
      this.keyboardFocusSprite = 0;
      return;
    }
    const index = editable.findIndex((channel) => channel.number === current);
    const nextIndex =
      index === -1
        ? reverse
          ? editable.length - 1
          : 0
        : reverse
          ? (index - 1 + editable.length) % editable.length
          : (index + 1) % editable.length;
    this.keyboardFocusSprite = editable[nextIndex]!.number;
  }

  private readonly seenErrors = new Set<string>();
  private readonly seenScriptMisses = new Set<string>();
  errorCount = 0;

  /** Director semantics: a script error aborts the current event handler and
   * the movie continues (the original client even routes errors through
   * `the alertHook`). Unique errors are logged once. */
  private guard(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.errorCount += 1;
      const message =
        error instanceof UnsupportedFeatureError
          ? error.feature
          : error instanceof Error
            ? error.message
            : String(error);
      if (this.rememberDiagnosticKey(this.seenErrors, message, "script errors", "error")) {
        this.log.log("error", `${what}: ${message}`);
      }
    }
  }

  private rememberDiagnosticKey(
    keys: Set<string>,
    key: string,
    label: string,
    severity: "info" | "error",
  ): boolean {
    if (keys.has(key)) return false;
    if (keys.size >= MAX_DIAGNOSTIC_DEDUPE_KEYS - 1) {
      const notice = `[${label} truncated at ${MAX_DIAGNOSTIC_DEDUPE_KEYS} unique entries]`;
      if (!keys.has(notice)) {
        keys.add(notice);
        this.log.log(severity, notice);
      }
      return false;
    }
    keys.add(key);
    return true;
  }

  // -- DirectorHost ----------------------------------------------------------

  put = (text: string): void => {
    this.log.log("put", text);
  };

  call = (name: string, args: LingoValue[]): LingoValue | undefined => {
    const netResult = this.netJobs.call(name, args);
    if (netResult !== undefined) return netResult;
    switch (name) {
      case "keypressed":
        return this.isKeyPressed(args[0] ?? LINGO_VOID) ? 1 : 0;
      case "sendsprite":
        return this.sendSprite(args[0] ?? LINGO_VOID, args[1] ?? LINGO_VOID, args.slice(2));
      case "sendallsprites":
        return this.sendAllSprites(args[0] ?? LINGO_VOID, args.slice(1));
      case "puppettempo":
        this.tempo = Number(args[0] ?? this.tempo) || this.tempo;
        return 1;
      case "movetofront":
        return 1;
      case "go": {
        const target = args[0] ?? LINGO_VOID;
        if (typeof target === "number") {
          this.nextFrameOverride = target;
        } else if (typeof target === "string") {
          const markerFrame = this.markerFrameByName.get(target.toLowerCase());
          if (markerFrame !== undefined) this.nextFrameOverride = markerFrame;
        }
        return 1;
      }
      case "castlib": {
        const id = args[0] ?? LINGO_VOID;
        const ref =
          typeof id === "number"
            ? this.castLibs.find((cast) => cast.number === id)
            : this.castLibs.find((cast) => cast.name.toLowerCase() === ops.stringOf(id).toLowerCase());
        if (ref) return ref;
        if (typeof id === "string" && id.trim().length > 0) {
          return this.ensureCastLib(id);
        }
        return undefined;
      }
      case "field": {
        const castArg = args[1];
        const cast =
          castArg instanceof CastLibRef
            ? castArg
            : typeof castArg === "number"
              ? this.castLibs.find((entry) => entry.number === castArg)
              : typeof castArg === "string"
                ? this.castLibs.find((entry) => entry.name.toLowerCase() === castArg.toLowerCase())
                : undefined;
        const member = this.members.find(args[0] ?? LINGO_VOID, cast?.name ?? null);
        return member ? member.text : LINGO_VOID;
      }
      case "member": {
        const castArg = args[1];
        const cast =
          castArg instanceof CastLibRef
            ? castArg
            : typeof castArg === "number"
              ? this.castLibs.find((entry) => entry.number === castArg)
              : typeof castArg === "string"
                ? this.castLibs.find((entry) => entry.name.toLowerCase() === castArg.toLowerCase())
                : undefined;
        const id = args[0] ?? LINGO_VOID;
        const member = this.members.find(id, cast?.name ?? null);
        if (member) return member;
        // Director always yields a ref: missing names report number -1
        // (preIndexMembers tests `member(x, lib).number > 0`), empty slots
        // report an empty name.
        return new CastMember(
          cast?.name ?? "",
          cast?.number ?? 0,
          typeof id === "number" ? id : -1,
          "",
          "empty",
        );
      }
      case "sprite": {
        if (args[0] instanceof SpriteChannel) return args[0];
        const number = Number(args[0] ?? 0) | 0;
        return this.channels[number] ?? LINGO_VOID;
      }
      case "sound":
        return this.soundChannel(args[0] ?? 1);
      case "puppetsound":
        return this.puppetSound(args);
      case "puppetsprite": {
        const number = args[0] instanceof SpriteChannel ? args[0].number : Number(args[0] ?? 0) | 0;
        const channel = this.channels[number];
        if (channel) {
          if (Number(args[1] ?? 0)) {
            channel.puppet = 1;
          } else {
            channel.resetImmediateProperties();
          }
          this.onStageChange();
        }
        return 1;
      }
      case "setid":
        if (args[0] instanceof SpriteChannel) {
          args[0].id = args[1] ?? 0;
          return 1;
        }
        return undefined;
      case "getid":
        if (args[0] instanceof SpriteChannel) {
          return args[0].id;
        }
        return undefined;
      case "updatestage":
        this.updateStage();
        return 1;
      case "cursor":
        this.globalCursor = normalizeDirectorCursorValue(args[0]);
        return 1;
      case "externalparamvalue": {
        const key = ops.stringOf(args[0] ?? LINGO_VOID).toLowerCase();
        const value = this.externalParams.get(key);
        return value === undefined ? LINGO_VOID : value;
      }
      case "externalparamcount":
        return this.externalParams.size;
      case "timeout": {
        const name = ops.stringOf(args[0] ?? LINGO_VOID).toLowerCase();
        let ref = this.timeouts.get(name);
        if (!ref) {
          ref = new TimeoutRef(name, this);
          this.timeouts.set(name, ref);
        }
        return ref;
      }
      case "xtra":
        return this.network.createXtra(ops.stringOf(args[0] ?? LINGO_VOID));
      case "new": {
        // timeout("x").new(period, #handler, target) routes here.
        if (args[0] instanceof TimeoutRef) {
          const ref = args[0];
          ref.schedule(Number(args[1] ?? 0) || 0, args[2] ?? LINGO_VOID, args[3] ?? LINGO_VOID);
          this.timeouts.set(ref.name, ref);
          return ref;
        }
        return this.network.createXtraInstance(args[0] ?? LINGO_VOID);
      }
      case "forget": {
        if (args[0] instanceof TimeoutRef) {
          args[0].forget();
          return 1;
        }
        return undefined;
      }
      case "erase": {
        if (args[0] instanceof CastMember) {
          this.members.remove(args[0]);
          return 1;
        }
        return undefined;
      }
      case "newmember": {
        // new(#field, castLib n) from Resource Manager createMember.
        const typeName = args[0] instanceof LingoSymbol ? args[0].name.toLowerCase() : "field";
        const castRef = args[1];
        const cast = castRef instanceof CastLibRef ? castRef : this.ensureCastLib("bin");
        return this.members.create(cast.name, "", typeName, cast.number);
      }
      case "script": {
        // script(nameOrNumber): the member must exist in a LOADED cast
        // (Director load-order semantics; Figure System must not construct
        // before hh_human arrives), then its generated module runs.
        const member = this.members.find(args[0] ?? LINGO_VOID, null);
        if (member && member.type === "script") {
          const scriptRef =
            this.runtime.findScriptByMember(member.castName, member.number) ??
            this.runtime.findScript(member.name);
          if (scriptRef) return scriptRef;
          const requested = ops.stringOf(args[0] ?? LINGO_VOID);
          if (this.rememberDiagnosticKey(this.seenScriptMisses, requested, "script misses", "info")) {
            this.log.log(
              "info",
              `script() miss: ${requested} (${member.name} in ${member.castName} has no executable module)`,
            );
          }
          return new MissingScriptRef(requested, member.name, member.slotNumber, member.castName);
        }
        // Source error paths print only the resolved 0; the requested name
        // is the actionable diagnostic.
        const requested = ops.stringOf(args[0] ?? LINGO_VOID);
        if (this.rememberDiagnosticKey(this.seenScriptMisses, requested, "script misses", "info")) {
          this.log.log(
            "info",
            `script() miss: ${requested}${member ? ` (member type ${member.type} in ${member.castName})` : " (no member)"}`,
          );
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  theProp = (name: string): LingoValue | undefined => {
    switch (name) {
      case "frame":
        return this.currentFrame;
      case "frametempo":
        return this.tempo;
      case "stage":
        return this.stage;
      case "runmode":
        return "Plugin";
      case "platform":
        return "Windows,32";
      case "centerstage":
        return this.centerStage;
      case "exitlock":
        return this.exitLock;
      case "lastchannel":
        return LAST_CHANNEL;
      case "stageleft":
        return 0;
      case "stagetop":
        return 0;
      case "stageright":
        return this.stageViewport.width;
      case "stagebottom":
        return this.stageViewport.height;
      case "colordepth":
        return 32;
      case "mouseh":
        return this.mouseH;
      case "mousev":
        return this.mouseV;
      case "mouseloc":
        return new LingoPoint(this.mouseH, this.mouseV);
      case "mousedown":
        return this.mouseDownFlag;
      case "clickon":
        return this.clickOnSprite;
      case "clickloc":
        return new LingoPoint(this.clickLocH, this.clickLocV);
      case "doubleclick":
        return this.doubleClickFlag;
      case "rollover":
        this.rolloverSprite = this.currentRolloverSprite();
        return this.rolloverSprite?.number ?? 0;
      case "keyboardfocussprite":
        return this.keyboardFocusSprite;
      case "selstart":
        return this.selStart;
      case "selend":
        return this.selEnd;
      case "key":
        return this.lastKey;
      case "keycode":
        return this.lastKeyCode;
      case "keypressed":
        return this.keyPressed;
      case "lastkey":
        return Math.max(0, Math.floor(((Date.now() - this.lastKeyTimeMs) / 1000) * 60));
      case "shiftdown":
        return this.shiftDown;
      case "controldown":
        return this.controlDown;
      case "optiondown":
        return this.optionDown;
      case "commanddown":
        return this.commandDown;
      case "moviepath":
        return this.moviePath;
      case "moviename":
        return "habbo.dir";
      case "number_of_castlibs":
        return this.castLibs.length;
      case "alerthook":
        return this.alertHook;
      case "sounddevice":
        return this.soundSystem.soundDevice;
      case "sounddevicelist":
        return this.soundSystem.soundDeviceList;
      case "soundenabled":
        return this.soundSystem.soundEnabled;
      case "soundkeepdevice":
        return this.soundSystem.soundKeepDevice;
      case "soundlevel":
        return this.soundSystem.soundLevel;
      case "soundmixmedia":
        return this.soundSystem.soundMixMedia;
      case "mousedownscript":
      case "mouseupscript":
      case "keydownscript":
      case "keyupscript":
      case "timeoutscript":
        return this.primaryEventScripts.get(name) ?? LINGO_VOID;
      case "time":
      case "short time":
        return formatDirectorTime(new Date(), false);
      case "long time":
        return formatDirectorTime(new Date(), true);
      case "systemdate": {
        const now = new Date();
        return new LingoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
      }
      case "date":
      case "short date": {
        const now = new Date();
        return `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(-2)}`;
      }
      case "long date":
        return new Date().toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      case "abbreviated date":
      case "abbrev date":
      case "abbr date":
        return new Date().toLocaleDateString("en-US", {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      default:
        return undefined;
    }
  };

  setTheProp = (name: string, value: LingoValue): boolean => {
    switch (name) {
      case "centerstage":
        this.centerStage = Number(value) || 0;
        return true;
      case "exitlock":
        this.exitLock = Number(value) || 0;
        return true;
      case "alerthook":
        this.alertHook = value;
        return true;
      case "sounddevice":
        this.soundSystem.setSoundDevice(value);
        return true;
      case "soundenabled":
        this.soundSystem.soundEnabled = this.integerValue(value, this.soundSystem.soundEnabled);
        return true;
      case "soundkeepdevice":
        this.soundSystem.soundKeepDevice = this.integerValue(value, this.soundSystem.soundKeepDevice);
        return true;
      case "soundlevel":
        this.soundSystem.soundLevel = this.integerValue(value, this.soundSystem.soundLevel);
        return true;
      case "soundmixmedia":
        this.soundSystem.soundMixMedia = this.integerValue(value, this.soundSystem.soundMixMedia);
        return true;
      case "mousedownscript":
      case "mouseupscript":
      case "keydownscript":
      case "keyupscript":
      case "timeoutscript":
        this.primaryEventScripts.set(name, value);
        return true;
      case "keyboardfocussprite":
        if (this.keyboardFocusSprite === value) return true;
        this.keyboardFocusSprite = value;
        this.onStageChange();
        return true;
      case "selstart": {
        const next = Math.max(0, Number(value) || 0);
        if (this.selStart === next) return true;
        this.selStart = next;
        this.onStageChange();
        return true;
      }
      case "selend": {
        const next = Math.max(0, Number(value) || 0);
        if (this.selEnd === next) return true;
        this.selEnd = next;
        this.onStageChange();
        return true;
      }
      default:
        return false;
    }
  };

  getProp = (receiver: LingoValue, property: string): LingoValue | undefined => {
    if (receiver instanceof StageRef) {
      switch (property) {
        case "sourcerect":
          return new LingoRect(0, 0, this.manifest.stage.width, this.manifest.stage.height);
        case "rect":
          return new LingoRect(0, 0, this.stageViewport.width, this.stageViewport.height);
        case "image":
          return this.stageImageProvider() ?? new LingoImage(this.stageViewport.width, this.stageViewport.height, 32);
        case "title":
          return "Habbo Origins";
        case "bgcolor":
          return this.stageBgColor;
        case "drawrect":
          return new LingoRect(0, 0, this.stageViewport.width, this.stageViewport.height);
        default:
          return undefined;
      }
    }
    if (receiver instanceof TimeoutRef) {
      switch (property) {
        case "name":
          return receiver.name;
        case "period":
          return receiver.periodMs;
        case "timeouthandler":
          return receiver.handler;
        case "target":
          return receiver.target;
        default:
          return undefined;
      }
    }
    if (receiver instanceof SoundChannelRef) {
      switch (property) {
        case "channelcount":
          return receiver.channelCount;
        case "elapsedtime":
          return receiver.elapsedTime;
        case "endtime":
          return receiver.endTime;
        case "loopcount":
          return receiver.loopCount;
        case "loopendtime":
          return receiver.loopEndTime;
        case "loopsremaining":
          return receiver.loopsRemaining;
        case "loopstarttime":
          return receiver.loopStartTime;
        case "volume":
          return receiver.volume;
        case "member":
          return receiver.member;
        case "pan":
          return receiver.pan;
        case "preloadtime":
          return receiver.preLoadTime;
        case "samplecount":
          return receiver.sampleCount;
        case "samplerate":
          return receiver.sampleRate;
        case "samplesize":
          return receiver.sampleSize;
        case "starttime":
          return receiver.startTime;
        case "status":
          return receiver.status;
        case "number":
        case "channel":
          return receiver.number;
        default:
          return undefined;
      }
    }
    if (receiver instanceof DirectorSoundRef) {
      switch (property) {
        case "sounddevice":
          return receiver.system.soundDevice;
        case "sounddevicelist":
          return receiver.system.soundDeviceList;
        case "soundenabled":
          return receiver.system.soundEnabled;
        case "soundkeepdevice":
          return receiver.system.soundKeepDevice;
        case "soundlevel":
          return receiver.system.soundLevel;
        case "soundmixmedia":
          return receiver.system.soundMixMedia;
        default:
          return undefined;
      }
    }
    if (receiver instanceof ChunkRef && receiver.owner instanceof CastMember) {
      if (TEXT_CHUNK_STYLE_PROPERTIES.has(property)) {
        return this.textStyleAt(receiver.owner, receiver.start ?? 1, property) ?? this.getProp(receiver.owner, property);
      }
      return undefined;
    }
    if (receiver instanceof CastLibRef) {
      switch (property) {
        case "filename":
          return receiver.fileName;
        case "preloadmode":
          return receiver.preloadMode;
        case "name":
          return receiver.name;
        case "number":
          return receiver.number;
        default:
          return undefined;
      }
    }
    if (receiver instanceof LingoImage) {
      const image = receiver.resolveLiveReference();
      switch (property) {
        case "width":
          return image.width;
        case "height":
          return image.height;
        case "depth":
          return image.depth;
        case "rect":
          return image.getRect();
        case "paletteref":
          return image.paletteRef;
        case "usealpha":
          return image.useAlpha;
        default:
          return undefined;
      }
    }
    if (receiver instanceof CastMember) {
      switch (property) {
        case "name":
          return receiver.name;
        case "number":
          // Movie-global slot number unless this is a missing-member ref.
          return receiver.number < 0 ? -1 : receiver.slotNumber;
        case "membernum":
          return receiver.number;
        case "type":
          return LingoSymbol.for(receiver.type);
        case "text":
          return receiver.text;
        case "scripttext":
          return receiver.type === "script" ? receiver.text : "";
        case "castlibnum":
          return receiver.castNumber;
        case "char":
        case "word":
        case "item":
        case "line":
          return new ChunkRef(receiver.text, property, receiver);
        case "width":
          return this.memberWidth(receiver);
        case "height":
          return this.memberHeight(receiver);
        case "image":
          if (receiver.type === "field" || receiver.type === "text") {
            return this.ensureTextMemberImage(receiver);
          }
          {
            const hadRuntimeImage = receiver.image !== null;
            const image = receiver.mutableImage();
            this.traceMemberImage(receiver, "get image", image);
            if (!hadRuntimeImage) this.onStageChange();
            return image;
          }
        case "media":
          if (receiver.type === "field" || receiver.type === "text") {
            return this.ensureTextMemberImage(receiver).toDirectorBitmapMedia(mediaSourceForMember(receiver));
          }
          return receiver.effectiveImage().toDirectorBitmapMedia(mediaSourceForMember(receiver));
        case "rect":
          return this.memberRect(receiver);
        case "regpoint":
          return new LingoPoint(receiver.regX, receiver.regY);
        case "paletteref":
          return receiver.paletteRef;
        case "palette":
          return receiver.palette;
        case "usealpha":
          return receiver.useAlpha;
        case "lineheight":
          return this.memberLineHeight(receiver);
        default: {
          const styled = receiver.style.get(property);
          if (styled !== undefined) return styled;
          // Director default member styling values (read before first set).
          switch (property) {
            case "fontstyle":
              return new LingoList([LingoSymbol.for("plain")]);
            case "font":
              return "Arial";
            case "fontsize":
              return 12;
            case "color":
              return new LingoColor(0, 0, 0);
            case "bgcolor":
              return new LingoColor(255, 255, 255);
            case "alignment":
              return LingoSymbol.for("left");
            case "wordwrap":
              return 1;
            case "boxtype":
              return LingoSymbol.for("adjust");
            case "editable":
              return 0;
            case "margin":
            case "border":
              return 0;
            case "autotab":
            case "boxdropshadow":
            case "dropshadow":
            case "antialias":
              return 0;
            case "linecount":
              return this.layoutTextMember(receiver).length;
            case "duration":
              return receiver.sound?.durationMs ?? (receiver.type === "sound" ? 0 : undefined);
            case "samplerate":
              return receiver.sound?.sampleRate ?? (receiver.type === "sound" ? 0 : undefined);
            case "samplecount":
              return receiver.sound?.sampleCount ?? (receiver.type === "sound" ? 0 : undefined);
            case "samplesize":
            case "bitspersample":
              return receiver.sound?.sampleSize ?? (receiver.type === "sound" ? 0 : undefined);
            case "loop":
              return receiver.type === "sound" ? (receiver.soundLoop ? 1 : 0) : undefined;
            case "channelcount":
              return receiver.sound?.channels ?? (receiver.type === "sound" ? 0 : undefined);
            case "charspacing":
            case "topspacing":
            case "bottomspacing":
            case "leftindent":
            case "rightindent":
            case "firstindent":
              return 0;
            case "fixedlinespace":
              return 0;
            case "lineheight":
              return this.memberLineHeight(receiver);
            default:
              return undefined;
          }
        }
      }
    }
    if (receiver instanceof SpriteChannel) {
      switch (property) {
        case "member":
          return receiver.member ?? 0;
        case "castnum":
          return receiver.member ? receiver.member.slotNumber : 0;
        case "castlibnum":
          return receiver.member?.castNumber ?? receiver.castLibNum;
        case "loc":
          return new LingoPoint(receiver.locH, receiver.locV);
        case "rect": {
          return this.spriteRect(receiver);
        }
        case "left":
          return this.spriteRect(receiver).left;
        case "top":
          return this.spriteRect(receiver).top;
        case "right":
          return this.spriteRect(receiver).right;
        case "bottom":
          return this.spriteRect(receiver).bottom;
        case "loch":
          return receiver.locH;
        case "locv":
          return receiver.locV;
        case "locz":
          return receiver.locZ;
        case "ink":
          return receiver.ink;
        case "blend":
          return receiver.blend;
        case "visible":
          return receiver.visible;
        case "puppet":
          return receiver.puppet;
        case "width":
          return this.spriteWidth(receiver);
        case "height":
          return this.spriteHeight(receiver);
        case "spritenum":
          return receiver.number;
        case "sprite":
          return receiver;
        case "name":
          return receiver.name;
        case "id":
          return receiver.id;
        case "scriptinstancelist":
          return receiver.scriptInstanceList;
        case "stretch":
          return receiver.stretch;
        case "trails":
          return receiver.trails;
        case "fliph":
          return receiver.flipH;
        case "flipv":
          return receiver.flipV;
        case "rotation":
          return receiver.rotation;
        case "skew":
          return receiver.skew;
        case "ilk":
          return LingoSymbol.for("sprite");
        case "forecolor":
          return receiver.foreColor;
        case "backcolor":
          return receiver.backColor;
        case "color":
          return receiver.color;
        case "bgcolor":
          return receiver.bgColor;
        case "editable":
          return receiver.editable;
        default:
          return undefined;
      }
    }
    return undefined;
  };

  setProp = (receiver: LingoValue, property: string, value: LingoValue): boolean => {
    if (receiver instanceof TimeoutRef) {
      switch (property) {
        case "target":
          receiver.target = value;
          return true;
        case "timeouthandler":
          receiver.handler = value;
          return true;
        case "period":
          receiver.periodMs = Number(value) || 0;
          return true;
        default:
          return false;
      }
    }
    if (receiver instanceof SoundChannelRef) {
      switch (property) {
        case "volume":
          receiver.volume = this.integerValue(value, receiver.volume);
          return true;
        case "pan":
          receiver.pan = this.integerValue(value, receiver.pan);
          return true;
        default:
          return false;
      }
    }
    if (receiver instanceof DirectorSoundRef) {
      switch (property) {
        case "sounddevice":
          return receiver.system.setSoundDevice(value);
        case "soundenabled":
          receiver.system.soundEnabled = this.integerValue(value, receiver.system.soundEnabled);
          return true;
        case "soundkeepdevice":
          receiver.system.soundKeepDevice = this.integerValue(value, receiver.system.soundKeepDevice);
          return true;
        case "soundlevel":
          receiver.system.soundLevel = this.integerValue(value, receiver.system.soundLevel);
          return true;
        case "soundmixmedia":
          receiver.system.soundMixMedia = this.integerValue(value, receiver.system.soundMixMedia);
          return true;
        default:
          return false;
      }
    }
    if (receiver instanceof ChunkRef && receiver.owner instanceof CastMember) {
      if (!TEXT_CHUNK_STYLE_PROPERTIES.has(property)) return false;
      const start = receiver.start ?? 1;
      const end = receiver.end ?? receiver.owner.text.length;
      receiver.owner.setTextStyleRange(start, end, property, value);
      this.onStageChange();
      return true;
    }
    if (receiver instanceof StageRef) {
      if (property === "title") {
        if (typeof document !== "undefined") {
          document.title = ops.stringOf(value);
        }
        return true;
      }
      if (property === "bgcolor") {
        this.stageBgColor = value;
        this.onStageChange();
        return true;
      }
      if (property === "drawrect" || property === "rect" || property === "title") {
        return true; // accepted; fixed-size browser stage
      }
      return false;
    }
    if (receiver instanceof CastLibRef) {
      switch (property) {
        case "preloadmode":
          receiver.preloadMode = Number(value) || 0;
          return true;
        case "name":
          receiver.name = ops.stringOf(value);
          return true;
        case "filename": {
          receiver.fileName = ops.stringOf(value);
          // Director loads the cast when fileName is assigned; the castLib
          // takes the loaded cast's name.
          const base = receiver.fileName.split("/").pop()!.replace(/\.(cct|cst)$/i, "");
          if (base.toLowerCase() !== "empty") {
            this.log.log("info", `castLib ${receiver.number} fileName = ${receiver.fileName}`);
          }
          if (base && base.toLowerCase() !== "empty" && this.members.loadCast(base, receiver.number)) {
            receiver.name = base;
            this.log.log("info", `castLib ${receiver.number} loaded cast ${base}`);
            this.onCastLoaded(base, receiver.number);
            void this.decodeCastImages(base);
            this.onStageChange();
          }
          return true;
        }
        default:
          return false;
      }
    }
    if (receiver instanceof CastMember) {
      switch (property) {
        case "text":
          receiver.text = ops.stringOf(value);
          receiver.clearTextStyleRuns();
          receiver.textVersion += 1;
          this.onStageChange();
          return true;
        case "name":
          this.members.rename(receiver, ops.stringOf(value));
          return true;
        case "image":
          // Director copies pixels on member.image assignment; holding the
          // reference would alias the source (Common Button assigns its
          // state image to the buffer, then composites that image into the
          // buffer — aliased, that is a self-copy through a white fill).
          if (value instanceof LingoImage) this.traceMemberImage(receiver, "set image", value);
          receiver.imageSource = value instanceof LingoImage ? value : null;
          this.assignMemberImage(receiver, value instanceof LingoImage ? value : null);
          if (receiver.image) {
            receiver.image.useAlpha = receiver.useAlpha;
            receiver.paletteRef = receiver.image.paletteRef;
            receiver.palette = receiver.image.paletteRef;
          }
          this.onStageChange();
          return true;
        case "media":
          if (isPhotoInvalidMedia(value) && receiver.imageSource) {
            this.log.log("info", `photo media fallback ignored for ${receiver.name || "runtime bitmap"}; keeping retrieved bitmap`);
            return true;
          }
          if (value instanceof LingoImage) {
            receiver.imageSource = value;
          } else if (value instanceof LingoBitmapMedia) {
            receiver.imageSource = LingoImage.fromDirectorBitmapMedia(value);
            if (!receiver.imageSource && !isPhotoInvalidMedia(value)) {
              this.log.log(
                "info",
                `bitmap media decode failed for ${receiver.name || "runtime bitmap"}; ${formatDirectorBitmapMediaInspection(
                  inspectDirectorBitmapMedia(value.bytes),
                )}`,
              );
            }
          } else {
            receiver.imageSource = null;
          }
          this.assignMemberImage(receiver, receiver.imageSource);
          if (receiver.image) {
            receiver.image.useAlpha = receiver.useAlpha;
            receiver.paletteRef = receiver.image.paletteRef;
            receiver.palette = receiver.image.paletteRef;
          }
          this.onStageChange();
          return true;
        case "regpoint":
          if (value instanceof LingoPoint) {
            receiver.regPointOverride = { x: value.x, y: value.y };
          }
          return true;
        case "paletteref":
          receiver.paletteRef = value;
          if (receiver.image) {
            receiver.image.paletteRef = value;
          }
          if (receiver.imageSource) {
            receiver.imageSource.paletteRef = value;
          }
          return true;
        case "palette":
          receiver.palette = value;
          if (value instanceof CastMember || value instanceof LingoSymbol) {
            receiver.paletteRef = value;
            if (receiver.image) {
              receiver.image.paletteRef = value;
            }
            if (receiver.imageSource) {
              receiver.imageSource.paletteRef = value;
            }
          }
          return true;
        case "usealpha":
          receiver.useAlpha = this.numericValue(value) ? 1 : 0;
          if (receiver.image) receiver.image.useAlpha = receiver.useAlpha;
          if (receiver.imageSource) receiver.imageSource.useAlpha = receiver.useAlpha;
          this.onStageChange();
          return true;
        case "loop":
          if (receiver.type !== "sound") return false;
          receiver.soundLoop = this.numericValue(value) !== 0;
          return true;
        case "color":
        case "bgcolor":
        case "forecolor":
        case "backcolor":
        case "font":
        case "fontsize":
        case "fontstyle":
        case "alignment":
        case "wordwrap":
        case "boxtype":
        case "editable":
        case "border":
        case "margin":
        case "linecount":
        case "fixedlinespace":
        case "charspacing":
        case "topspacing":
        case "bottomspacing":
        case "leftindent":
        case "rightindent":
        case "firstindent":
        case "antialias":
        case "rect":
        case "width":
        case "height":
        case "autotab":
        case "boxdropshadow":
        case "dropshadow":
          // Director text/field member styling; stored for the renderer.
          receiver.style.set(property, value);
          receiver.textVersion += 1;
          this.onStageChange();
          return true;
        case "lineheight": {
          const lineHeight = this.numericValue(value, 0);
          receiver.style.set("fixedlinespace", value);
          if (lineHeight > 0) {
            receiver.style.set("topspacing", Math.max(0, Math.round(lineHeight - this.memberFontSize(receiver))));
          }
          receiver.textVersion += 1;
          this.onStageChange();
          return true;
        }
        default:
          return false;
      }
    }
    if (receiver instanceof SpriteChannel) {
      switch (property) {
        case "member":
          this.assignSpriteMember(receiver, value);
          this.onStageChange();
          return true;
        case "castnum": {
          const castName =
            typeof value === "number" && (value >> 16) === 0 && receiver.castLibNum > 0
              ? this.castLibNameForNumber(receiver.castLibNum)
              : null;
          this.assignSpriteMember(receiver, value, castName);
          this.onStageChange();
          return true;
        }
        case "castlibnum": {
          const castNumber = Number(value) | 0;
          if (receiver.castLibNum !== castNumber) {
            receiver.castLibNum = castNumber;
            receiver.markChanged();
          }
          const castName = this.castLibNameForNumber(castNumber);
          if (receiver.member && castName) {
            this.assignSpriteMember(receiver, receiver.member.number, castName);
          }
          this.onStageChange();
          return true;
        }
        case "loc":
          if (value instanceof LingoPoint) {
            const locH = Math.round(value.x);
            const locV = Math.round(value.y);
            const changed = receiver.locH !== locH || receiver.locV !== locV;
            receiver.locH = locH;
            receiver.locV = locV;
            if (changed) {
              receiver.markChanged();
              this.onStageChange();
            }
          }
          return true;
        case "loch":
          if (this.setSpriteNumberProperty(receiver, "locH", this.integerValue(value))) this.onStageChange();
          return true;
        case "locv":
          if (this.setSpriteNumberProperty(receiver, "locV", this.integerValue(value))) this.onStageChange();
          return true;
        case "locz":
          if (this.setSpriteNumberProperty(receiver, "locZ", this.integerValue(value))) this.onStageChange();
          return true;
        case "left": {
          if (this.setSpriteNumberProperty(receiver, "locH", this.integerValue(value) + this.spriteRegX(receiver))) {
            this.onStageChange();
          }
          return true;
        }
        case "top": {
          if (this.setSpriteNumberProperty(receiver, "locV", this.integerValue(value) + this.spriteRegY(receiver))) {
            this.onStageChange();
          }
          return true;
        }
        case "right": {
          const rect = this.spriteRect(receiver);
          if (
            this.setSpriteNumberProperty(receiver, "locH", this.integerValue(value) - rect.width + this.spriteRegX(receiver))
          ) {
            this.onStageChange();
          }
          return true;
        }
        case "bottom": {
          const rect = this.spriteRect(receiver);
          if (
            this.setSpriteNumberProperty(receiver, "locV", this.integerValue(value) - rect.height + this.spriteRegY(receiver))
          ) {
            this.onStageChange();
          }
          return true;
        }
        case "ink":
          if (this.setSpriteNumberProperty(receiver, "ink", this.integerValue(value))) this.onStageChange();
          return true;
        case "blend":
          if (this.setSpriteNumberProperty(receiver, "blend", this.integerValue(value))) this.onStageChange();
          return true;
        case "visible":
          if (this.setSpriteNumberProperty(receiver, "visible", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        case "puppet":
          if (this.numericValue(value)) {
            this.setSpriteNumberProperty(receiver, "puppet", 1);
          } else {
            receiver.resetImmediateProperties();
          }
          this.onStageChange();
          return true;
        case "width":
          if (this.setSpriteNumberProperty(receiver, "width", this.integerValue(value))) this.onStageChange();
          return true;
        case "height":
          if (this.setSpriteNumberProperty(receiver, "height", this.integerValue(value))) this.onStageChange();
          return true;
        case "name":
          receiver.name = ops.stringOf(value);
          return true;
        case "id":
          receiver.id = value;
          return true;
        case "scriptinstancelist":
          if (value instanceof LingoList) {
            receiver.scriptInstanceList = value;
            // Director gives each attached behavior its sprite channel; the
            // Event Broker reads `the spriteNum of me`.
            for (const instance of value.items) {
              if (instance instanceof ScriptInstance) {
                instance.props.set("spritenum", receiver.number);
              }
            }
          }
          return true;
        case "cursor":
          receiver.cursor = value;
          return true;
        case "rect":
          if (value instanceof LingoRect) {
            this.setSpriteRect(receiver, value);
          }
          return true;
        case "stretch":
          if (this.setSpriteNumberProperty(receiver, "stretch", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        case "trails":
          if (this.setSpriteNumberProperty(receiver, "trails", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        case "fliph":
          if (this.setSpriteNumberProperty(receiver, "flipH", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        case "flipv":
          if (this.setSpriteNumberProperty(receiver, "flipV", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        case "rotation":
          if (this.setSpriteNumberProperty(receiver, "rotation", this.numericValue(value))) this.onStageChange();
          return true;
        case "skew":
          if (this.setSpriteNumberProperty(receiver, "skew", this.numericValue(value))) this.onStageChange();
          return true;
        case "forecolor":
          if (this.setSpriteNumberProperty(receiver, "foreColor", this.integerValue(value))) this.onStageChange();
          return true;
        case "backcolor":
          if (this.setSpriteNumberProperty(receiver, "backColor", this.integerValue(value))) this.onStageChange();
          return true;
        case "color":
          if (this.setSpriteValueProperty(receiver, "color", value)) this.onStageChange();
          return true;
        case "bgcolor":
          if (this.setSpriteValueProperty(receiver, "bgColor", value)) this.onStageChange();
          return true;
        case "editable":
          if (this.setSpriteNumberProperty(receiver, "editable", this.numericValue(value) ? 1 : 0)) this.onStageChange();
          return true;
        default:
          return false;
      }
    }
    return false;
  };

  /** Director sprite-behavior dispatch: a method called on a sprite is sent
   * to the behavior instances in its scriptInstanceList (the sprite's
   * attached scripts), matching how the source calls
   * `tsprite.registerProcedure(...)` etc. */
  callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue | undefined => {
    const networkResult = this.network.callMethod(receiver, method, args);
    if (networkResult !== undefined) {
      return networkResult;
    }
    if (receiver instanceof TimeoutRef) {
      switch (method.toLowerCase()) {
        case "new":
          receiver.schedule(Number(args[0] ?? 0) || 0, args[1] ?? LINGO_VOID, args[2] ?? LINGO_VOID);
          this.timeouts.set(receiver.name, receiver);
          return receiver;
        case "forget":
          receiver.forget();
          return 1;
        default:
          return undefined;
      }
    }
    if (receiver instanceof SoundChannelRef) {
      switch (method) {
        case "breakloop":
          return receiver.breakLoop();
        case "fadein":
          return receiver.fadeIn(this.integerValue(args[0] ?? 1000, 1000));
        case "fadeout":
          return receiver.fadeOut(this.integerValue(args[0] ?? 1000, 1000));
        case "fadeto":
          return receiver.fadeTo(
            this.integerValue(args[0] ?? receiver.volume, receiver.volume),
            this.integerValue(args[1] ?? 1000, 1000),
          );
        case "setplaylist":
          return receiver.setPlayList(args[0] ?? LINGO_VOID);
        case "getplaylist":
          return receiver.getPlayList();
        case "pause":
          return receiver.pause();
        case "play":
          return receiver.play(args[0] ?? LINGO_VOID);
        case "playnext":
          return receiver.playNext();
        case "queue":
          return receiver.queue(args[0] ?? LINGO_VOID);
        case "rewind":
          return receiver.rewind();
        case "stop":
          return receiver.stop();
        case "isbusy":
          return receiver.isBusy();
        default:
          return undefined;
      }
    }
    if (receiver instanceof DirectorSoundRef) {
      if (method === "channel") return receiver.system.channel(args[0] ?? 0);
      return undefined;
    }
    if (receiver instanceof ScriptingObjectRef && receiver.lingoType === "_movie") {
      switch (method.toLowerCase()) {
        case "sendsprite":
          return this.sendSprite(args[0] ?? LINGO_VOID, args[1] ?? LINGO_VOID, args.slice(2));
        case "sendallsprites":
          return this.sendAllSprites(args[0] ?? LINGO_VOID, args.slice(1));
        case "stopevent":
        case "dontpassevent":
          return this.runtime.call(method, args);
      }
    }
    if (receiver instanceof CastMember) {
      switch (method) {
        case "duplicate": {
          const target =
            args[0] instanceof CastMember ? args[0] : this.members.find(args[0] ?? LINGO_VOID, null);
          if (!target) return LINGO_VOID;
          const sourceBitmapSize = receiver.bitmap ? `${receiver.bitmap.width}x${receiver.bitmap.height}` : "-";
          const sourceImageSize = receiver.image ? `${receiver.image.width}x${receiver.image.height}` : "-";
          const sourceDetails =
            `from=${receiver.castName}.${receiver.name || `member ${receiver.number}`} ` +
            `fromMember=${receiver.number} fromSlot=${receiver.slotNumber} ` +
            `fromBitmap=${sourceBitmapSize} fromImage=${sourceImageSize}`;
          target.type = receiver.type;
          target.text = receiver.text;
          target.textVersion += 1;
          target.bitmap = receiver.bitmap
            ? {
                ...receiver.bitmap,
                decoded: receiver.bitmap.decoded ? receiver.bitmap.decoded.duplicate() : receiver.bitmap.decoded,
              }
            : null;
          target.image = receiver.image ? receiver.image.duplicate() : null;
          target.imageSource = receiver.imageSource ? receiver.imageSource.duplicate() : null;
          target.paletteRef = receiver.paletteRef;
          target.palette = receiver.palette;
          target.paletteColors = receiver.paletteColors ? [...receiver.paletteColors] : null;
          target.regPointOverride = receiver.regPointOverride ? { ...receiver.regPointOverride } : null;
          target.style.clear();
          for (const [key, value] of receiver.style) {
            target.style.set(key, duplicateValue(value));
          }
          target.clearTextStyleRuns();
          for (const run of receiver.textStyleRuns) {
            target.setTextStyleRange(run.start, run.end, run.property, duplicateValue(run.value));
          }
          this.traceMemberMutation(target, "duplicate target", sourceDetails);
          this.traceMemberMutation(
            receiver,
            "duplicate source",
            `to=${target.castName}.${target.name || `member ${target.number}`} toMember=${target.number} toSlot=${target.slotNumber}`,
          );
          this.onStageChange();
          return target;
        }
        case "charpostoloc":
          return this.memberCharPosToLoc(receiver, Number(args[0] ?? 1) | 0);
        case "loctocharpos": {
          const loc = args[0];
          if (loc instanceof LingoPoint) return this.memberLocToCharPos(receiver, loc);
          return 1;
        }
        default:
          return undefined;
      }
    }
    if (receiver instanceof SpriteChannel) {
      for (const instance of receiver.scriptInstanceList.items) {
        if (instance instanceof ScriptInstance && this.runtime.hasHandler(instance, method)) {
          return this.runtime.callMethod(instance, method, args);
        }
      }
    }
    return undefined;
  };

  private memberRect(member: CastMember): LingoRect {
    const styled = member.style.get("rect");
    if (member.type === "field" || member.type === "text") {
      // Director #adjust boxes re-derive their rect from content: an assigned
      // rect supplies the layout width, but the member's rect/height/image
      // stay mutually consistent with the wrapped text. Text Wrapper copies
      // sourceRect=member.rect out of member.image, so returning a stale
      // assigned rect (e.g. Writer's 1px measurement rect) would scale the
      // raster into the destination — the squashed/clipped text defect.
      if (this.memberBoxType(member) === "adjust") {
        const left = styled instanceof LingoRect ? styled.left : 0;
        const top = styled instanceof LingoRect ? styled.top : 0;
        return new LingoRect(left, top, left + this.memberWidth(member), top + this.memberHeight(member));
      }
      if (styled instanceof LingoRect) return styled;
    }
    if (styled instanceof LingoRect) return styled;
    return new LingoRect(0, 0, this.memberWidth(member), this.memberHeight(member));
  }

  private spriteRegX(sprite: SpriteChannel): number {
    return sprite.member?.regX ?? 0;
  }

  private spriteRegY(sprite: SpriteChannel): number {
    return sprite.member?.regY ?? 0;
  }

  private spriteWidth(sprite: SpriteChannel): number {
    return sprite.width || (sprite.member ? this.memberWidth(sprite.member) : 0);
  }

  private spriteHeight(sprite: SpriteChannel): number {
    return sprite.height || (sprite.member ? this.memberHeight(sprite.member) : 0);
  }

  private spriteRect(sprite: SpriteChannel): LingoRect {
    const width = this.spriteWidth(sprite);
    const height = this.spriteHeight(sprite);
    const memberWidth = sprite.member ? this.memberWidth(sprite.member) : width;
    const memberHeight = sprite.member ? this.memberHeight(sprite.member) : height;
    const sourceWidth = memberWidth > 0 ? memberWidth : width;
    const sourceHeight = memberHeight > 0 ? memberHeight : height;
    const scaleX = sourceWidth > 0 ? width / sourceWidth : 1;
    const scaleY = sourceHeight > 0 ? height / sourceHeight : 1;
    const aliasMirrorH = this.isAliasMirrorTransform(sprite);
    const flipX = (sprite.flipH ? -1 : 1) * (aliasMirrorH ? -1 : 1);
    const flipY = sprite.flipV ? -1 : 1;
    const rotation = aliasMirrorH ? 0 : this.degreesToRadians(sprite.rotation);
    const skewX = aliasMirrorH ? 0 : this.degreesToRadians(sprite.skew);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const skewTan = Math.tan(skewX);
    const regX = this.spriteRegX(sprite);
    const regY = this.spriteRegY(sprite);
    const corners: Array<[number, number]> = [
      [0, 0],
      [sourceWidth, 0],
      [0, sourceHeight],
      [sourceWidth, sourceHeight],
    ];
    const points = corners.map(([x, y]) => {
      const localX = (x - regX) * scaleX * flipX;
      const localY = (y - regY) * scaleY * flipY;
      const skewedX = localX + skewTan * localY;
      return {
        x: sprite.locH + skewedX * cos - localY * sin,
        y: sprite.locV + skewedX * sin + localY * cos,
      };
    });
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    return new LingoRect(Math.round(left), Math.round(top), Math.round(right), Math.round(bottom));
  }

  private setSpriteRect(sprite: SpriteChannel, rect: LingoRect): void {
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height));

    const memberWidth = sprite.member ? this.memberWidth(sprite.member) : width;
    const memberHeight = sprite.member ? this.memberHeight(sprite.member) : height;
    const scaleX = memberWidth > 0 ? width / memberWidth : 1;
    const scaleY = memberHeight > 0 ? height / memberHeight : 1;
    const locH = Math.round(rect.left + this.spriteRegX(sprite) * scaleX);
    const locV = Math.round(rect.top + this.spriteRegY(sprite) * scaleY);
    const changed = sprite.width !== width || sprite.height !== height || sprite.locH !== locH || sprite.locV !== locV;
    if (!changed) return;
    sprite.width = width;
    sprite.height = height;
    sprite.locH = locH;
    sprite.locV = locV;
    sprite.markChanged();
    this.onStageChange();
  }

  private isAliasMirrorTransform(sprite: SpriteChannel): boolean {
    return this.normalizeDegrees(sprite.rotation) === 180 && this.normalizeDegrees(sprite.skew) === 180;
  }

  private normalizeDegrees(value: number): number {
    return ((Math.round(value) % 360) + 360) % 360;
  }

  private degreesToRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private memberWidth(member: CastMember): number {
    const styledWidth = this.memberNumberStyle(member, "width", NaN);
    if (!Number.isNaN(styledWidth)) return styledWidth;
    const styledRect = member.style.get("rect");
    if (styledRect instanceof LingoRect) return styledRect.width;
    if (member.type === "field" || member.type === "text") {
      return this.measureTextMemberWidth(member);
    }
    return member.image?.width ?? member.bitmap?.width ?? 0;
  }

  private assignMemberImage(member: CastMember, source: LingoImage | null): void {
    const previous = member.image;
    const next = source ? source.resolveLiveReference().duplicate() : null;
    member.image = next;
    if (previous && next) previous.redirectLiveReferenceTo(next);
  }

  private memberHeight(member: CastMember): number {
    const styledHeight = this.memberNumberStyle(member, "height", NaN);
    if (!Number.isNaN(styledHeight)) return styledHeight;
    const styledRect = member.style.get("rect");
    if (member.type === "field" || member.type === "text") {
      const boxType = this.memberBoxType(member);
      if (styledRect instanceof LingoRect && boxType !== "adjust") return styledRect.height;
      return Math.max(1, this.layoutTextMember(member).length * this.memberLineHeight(member));
    }
    if (styledRect instanceof LingoRect) return styledRect.height;
    return member.image?.height ?? member.bitmap?.height ?? 0;
  }

  private memberNumberStyle(member: CastMember, key: string, fallback: number): number {
    const value = member.style.get(key);
    return isNumber(value ?? LINGO_VOID) ? numberOf(value!) : fallback;
  }

  private memberBooleanStyle(member: CastMember, key: string, fallback: boolean): boolean {
    const value = member.style.get(key);
    return value === undefined ? fallback : ops.truthy(value);
  }

  private numericValue(value: LingoValue, fallback = 0): number {
    if (isNumber(value)) return numberOf(value);
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }

  private integerValue(value: LingoValue, fallback = 0): number {
    return Math.round(this.numericValue(value, fallback));
  }

  private memberFontSize(member: CastMember): number {
    return Math.max(1, this.memberNumberStyle(member, "fontsize", 12));
  }

  private memberLineHeight(member: CastMember): number {
    const fixed = this.memberNumberStyle(member, "fixedlinespace", 0);
    const spaced = this.memberFontSize(member) + this.memberNumberStyle(member, "topspacing", 0);
    return Math.max(1, fixed, spaced);
  }

  private memberTopSpacing(member: CastMember): number {
    return Math.max(0, this.memberNumberStyle(member, "topspacing", 0));
  }

  private isCompactVolterText(member: CastMember): boolean {
    const fontSize = this.memberFontSize(member);
    if (fontSize > 10) return false;
    const fontValue = this.textStyleAt(member, 1, "font");
    return DirectorMovie.volterFamilyFor(fontValue) !== null;
  }

  private memberTextDrawTopInset(member: CastMember, lineHeight: number, fontSize: number, descent: number): number {
    if (member.style.has("topspacing")) return this.memberTopSpacing(member);
    const fixed = this.memberNumberStyle(member, "fixedlinespace", 0);
    if (fixed <= fontSize) {
      // Habbo's source wrappers add a one-pixel top guard for compact Volter
      // fields whose line cell equals the font size. Writer Class can render
      // the same compact text directly, so keep the guard in the shared text
      // member path instead of special-casing individual windows.
      return this.isCompactVolterText(member) ? 1 : 0;
    }
    // Director's text image keeps fixed-line cells and font ascent separate.
    // Large fixedLineSpace-only controls, such as dropmenus, draw glyphs in
    // the lower text band; Writer-managed text sets topSpacing explicitly.
    return Math.max(0, Math.round(lineHeight - fontSize - descent));
  }

  private memberBoxType(member: CastMember): string {
    const value = member.style.get("boxtype");
    if (value instanceof LingoSymbol) return value.name.toLowerCase();
    if (typeof value === "string") return value.toLowerCase().replace(/^#/, "");
    return "adjust";
  }

  private memberCharWidth(member: CastMember): number {
    return Math.max(1, this.measureTextSpan(member, "W", 1));
  }

  private memberTextLines(member: CastMember): string[] {
    const lines = member.text.split(/\r\n|\r|\n/);
    return lines.length > 0 ? lines : [""];
  }

  private layoutTextMember(member: CastMember): TextLayoutRow[] {
    const cached = this.textLayoutCache.get(member);
    if (cached?.version === member.textVersion) return cached.rows;
    const wrapWidth = this.memberNumberStyle(member, "wordwrap", 1) ? this.memberRectWidth(member) : 0;
    const rows: TextLayoutRow[] = [];
    let globalPos = 1;
    let visualLine = 0;
    for (const sourceLine of this.memberTextLines(member)) {
      if (sourceLine.length === 0) {
        rows.push({ text: "", start: globalPos, end: globalPos, line: visualLine });
        visualLine += 1;
        globalPos += 1;
        continue;
      }
      if (wrapWidth <= 0) {
        rows.push({ text: sourceLine, start: globalPos, end: globalPos + sourceLine.length, line: visualLine });
        visualLine += 1;
      } else {
        let offset = 0;
        while (offset < sourceLine.length) {
          let end = offset;
          let width = 0;
          let lastBreakStart = -1;
          let lastBreakEnd = -1;
          while (end < sourceLine.length) {
            const char = sourceLine[end]!;
            const advance = this.measureTextSpan(member, char, globalPos + end);
            if (end > offset && width + advance > wrapWidth) break;
            width += advance;
            if (/\s/.test(char)) {
              lastBreakStart = end;
              lastBreakEnd = end + 1;
            }
            end += 1;
          }
          const overflowed = end < sourceLine.length;
          let rowEnd = end;
          let nextOffset = end;
          if (overflowed && lastBreakStart > offset) {
            rowEnd = lastBreakStart;
            nextOffset = lastBreakEnd;
          } else if (end === offset) {
            rowEnd = offset + 1;
            nextOffset = rowEnd;
          }
          while (nextOffset < sourceLine.length && /\s/.test(sourceLine[nextOffset]!)) {
            nextOffset += 1;
          }
          const text = sourceLine.slice(offset, rowEnd);
          rows.push({
            text,
            start: globalPos + offset,
            end: globalPos + offset + text.length,
            line: visualLine,
          });
          visualLine += 1;
          offset = nextOffset;
        }
      }
      globalPos += sourceLine.length + 1;
    }
    const result = rows.length > 0 ? rows : [{ text: "", start: 1, end: 1, line: 0 }];
    this.textLayoutCache.set(member, { version: member.textVersion, rows: result });
    return result;
  }

  private memberRectWidth(member: CastMember): number {
    const styled = member.style.get("rect");
    if (styled instanceof LingoRect) return styled.width;
    return this.memberNumberStyle(member, "width", 0);
  }

  private measureTextMemberWidth(member: CastMember): number {
    return Math.max(1, ...this.layoutTextMember(member).map((line) => this.measureTextSpan(member, line.text, line.start)));
  }

  private memberCharPosToLoc(member: CastMember, position: number): LingoPoint {
    const lineHeight = this.memberLineHeight(member);
    const pos = Math.max(1, Math.min(position, member.text.length + 1));
    const rows = this.layoutTextMember(member);
    for (const row of rows) {
      if (pos >= row.start && pos <= row.end) {
        return new LingoPoint(this.measureTextSpan(member, row.text.slice(0, pos - row.start), row.start), row.line * lineHeight);
      }
    }
    const last = rows[rows.length - 1]!;
    return new LingoPoint(this.measureTextSpan(member, last.text, last.start), last.line * lineHeight);
  }

  private memberLocToCharPos(member: CastMember, loc: LingoPoint): number {
    const lineHeight = this.memberLineHeight(member);
    const rowIndex = Math.max(0, Math.floor(loc.y / lineHeight));
    const rows = this.layoutTextMember(member);
    const row = rows[Math.min(rowIndex, rows.length - 1)]!;
    let width = 0;
    for (let i = 0; i < row.text.length; i += 1) {
      const advance = this.measureTextSpan(member, row.text[i]!, row.start + i);
      if (loc.x < width + advance / 2) return row.start + i;
      width += advance;
    }
    return row.end;
  }

  private textStyleAt(member: CastMember, position: number, property: string): LingoValue | undefined {
    const key = property.toLowerCase();
    let value = member.style.get(key);
    for (const run of member.textStyleRuns) {
      if (run.property === key && position >= run.start && position <= run.end) {
        value = run.value;
      }
    }
    return value;
  }

  private textStyleNumberAt(member: CastMember, position: number, property: string, fallback: number): number {
    const value = this.textStyleAt(member, position, property);
    return isNumber(value ?? LINGO_VOID) ? numberOf(value!) : fallback;
  }

  private textStyleNames(value: LingoValue | undefined): Set<string> {
    const names = new Set<string>();
    const add = (entry: LingoValue): void => {
      if (entry instanceof LingoSymbol) names.add(entry.name.toLowerCase().replace(/^#/, ""));
      else if (typeof entry === "string") {
        for (const token of entry.toLowerCase().split(/[,\s]+/)) {
          const normalized = token.trim().replace(/^#/, "");
          if (normalized.length > 0) names.add(normalized);
        }
      }
    };
    if (value instanceof LingoList) {
      for (const entry of value.items) add(entry);
    } else if (value !== undefined) {
      add(value);
    }
    return names;
  }

  private textColorRgb(value: LingoValue | undefined): { r: number; g: number; b: number } {
    if (value instanceof LingoColor) {
      return { r: value.r, g: value.g, b: value.b };
    }
    if (value instanceof LingoList && value.items.length >= 3) {
      const rgb = value.items.slice(0, 3).map((entry) => (isNumber(entry) ? Math.round(numberOf(entry)) : 0));
      return { r: rgb[0] ?? 0, g: rgb[1] ?? 0, b: rgb[2] ?? 0 };
    }
    // Window layouts carry colors as "#RRGGBB" strings (#txtColor).
    if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim())) {
      const hex = value.trim().replace(/^#/, "");
      const numeric = Number.parseInt(hex, 16);
      return { r: (numeric >> 16) & 0xff, g: (numeric >> 8) & 0xff, b: numeric & 0xff };
    }
    return { r: 0, g: 0, b: 0 };
  }

  private textColorCss(value: LingoValue | undefined): string {
    const color = this.textColorRgb(value);
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  private sameRgb(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }): boolean {
    return left.r === right.r && left.g === right.g && left.b === right.b;
  }

  private singleTextColor(member: CastMember): { r: number; g: number; b: number } | null {
    const base = this.textColorRgb(member.style.get("color"));
    for (const run of member.textStyleRuns) {
      if (run.property === "color" && !this.sameRgb(base, this.textColorRgb(run.value))) {
        return null;
      }
    }
    return base;
  }

  private static fontFamilyCandidates(value: string): string[] {
    const candidates: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    for (const char of value) {
      if ((char === '"' || char === "'") && quote === null) {
        quote = char;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "," && quote === null) {
        const candidate = current.trim();
        if (candidate.length > 0) candidates.push(candidate);
        current = "";
        continue;
      }
      current += char;
    }
    const finalCandidate = current.trim();
    if (finalCandidate.length > 0) candidates.push(finalCandidate);
    return candidates;
  }

  private static cssFontFamilyToken(family: string): string {
    const cleaned = family.trim().replace(/"/g, "");
    if (cleaned.length === 0) return "Arial";
    const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
    if (generic.has(cleaned.toLowerCase()) || /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(cleaned)) return cleaned;
    return `"${cleaned}"`;
  }

  /** release306 text uses the embedded Director fonts "V" (Volter) and "VB"
   * (Volter Bold), the Goldfish bitmap fonts served as webfonts. */
  private static volterFamilyFor(value: LingoValue | undefined): { family: string; bold: boolean } | null {
    if (typeof value !== "string") return null;
    const firstFamily = DirectorMovie.fontFamilyCandidates(value)[0] ?? value;
    const normalized = firstFamily.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ").trim();
    const compact = normalized.replace(/[\s_-]+/g, "");
    switch (compact) {
      case "v":
      case "volter":
      case "volter(goldfish)":
      case "voltergoldfish":
        return { family: '"Volter Goldfish"', bold: false };
      case "vb":
      case "volterbold":
      case "volterbold(goldfish)":
      case "volterboldgoldfish":
        return { family: '"Volter Goldfish"', bold: true };
      default:
        return null;
    }
  }

  private canvasFontFamily(value: LingoValue | undefined): string {
    if (typeof value !== "string" || value.trim().length === 0) return "Arial";
    const candidates = DirectorMovie.fontFamilyCandidates(value);
    const volter = DirectorMovie.volterFamilyFor(value);
    if (volter) {
      const fallbacks = candidates.slice(1).map((family) => DirectorMovie.cssFontFamilyToken(family));
      return [volter.family, ...fallbacks].join(", ");
    }
    const families = candidates.length > 0 ? candidates : ["Arial"];
    return families.map((family) => DirectorMovie.cssFontFamilyToken(family)).join(", ");
  }

  private canvasFont(member: CastMember, position: number): string {
    const fontSize = this.textStyleNumberAt(member, position, "fontsize", this.memberFontSize(member));
    const fontValue = this.textStyleAt(member, position, "font");
    const family = this.canvasFontFamily(fontValue);
    const names = this.textStyleNames(this.textStyleAt(member, position, "fontstyle"));
    const cssParts: string[] = [];
    if (names.has("italic")) cssParts.push("italic");
    if (names.has("bold") || DirectorMovie.volterFamilyFor(fontValue)?.bold) cssParts.push("bold");
    cssParts.push(`${fontSize}px`, family);
    return cssParts.join(" ");
  }

  private measureContext(): CanvasRenderingContext2D | null {
    if (this.textMeasureContext !== undefined) return this.textMeasureContext;
    if (typeof document === "undefined") {
      this.textMeasureContext = null;
      return null;
    }
    const canvas = document.createElement("canvas");
    this.textMeasureContext = canvas.getContext("2d");
    return this.textMeasureContext;
  }

  private fallbackTextAdvance(member: CastMember, text: string): number {
    const charSpacing = this.memberNumberStyle(member, "charspacing", 0);
    return Math.max(0, text.length * (Math.ceil(this.memberFontSize(member) * 0.58) + charSpacing));
  }

  /** Per-font, per-character logical advances. Director keeps the text pen at
   * subpixel precision and snaps the glyph draw position, so summing rounded
   * per-character browser widths compresses short bitmap-font labels. Store
   * advances as 26.6 fixed-point values to keep layout/caret math deterministic
   * while still matching Director's fractional logical pen. */
  private readonly glyphAdvanceCache = new Map<string, Map<string, number>>();

  private glyphAdvance(font: string, char: string): number {
    let byChar = this.glyphAdvanceCache.get(font);
    if (!byChar) {
      byChar = new Map();
      this.glyphAdvanceCache.set(font, byChar);
    }
    const cached = byChar.get(char);
    if (cached !== undefined) return cached;
    const ctx = this.measureContext()!;
    ctx.font = font;
    const advance = Math.round(ctx.measureText(char).width * 64) / 64;
    byChar.set(char, advance);
    return advance;
  }

  /** Font metrics (rounded). Browser font-box metrics can be much larger than
   * Director's bitmap strike cell for embedded Volter faces, especially at
   * scaled 18px sizes used by Writer-managed counters. Keep the metrics inside
   * the requested font size so the baseline remains in the authored line cell
   * instead of clipping the glyph above the text image. */
  private readonly fontMetricsCache = new Map<string, { ascent: number; descent: number }>();

  private fontMetrics(font: string): { ascent: number; descent: number } {
    const cached = this.fontMetricsCache.get(font);
    if (cached) return cached;
    const fontSize = Math.max(1, Math.round(Number(/(\d+(?:\.\d+)?)px/i.exec(font)?.[1] ?? 9)));
    let metrics = { ascent: Math.max(1, fontSize - 2), descent: Math.min(2, Math.max(0, fontSize - 1)) };
    const ctx = this.measureContext();
    if (ctx) {
      ctx.font = font;
      const measured = ctx.measureText("Mg");
      const ascent = measured.actualBoundingBoxAscent || measured.fontBoundingBoxAscent || 0;
      const descent = measured.actualBoundingBoxDescent || measured.fontBoundingBoxDescent || 0;
      if (ascent > 0 || descent > 0) {
        metrics = { ascent: Math.round(ascent), descent: Math.round(descent) };
      }
    }
    metrics = {
      ascent: Math.max(1, Math.min(fontSize, metrics.ascent)),
      descent: Math.max(0, Math.min(Math.max(0, fontSize - 1), Math.round(fontSize / 3), metrics.descent)),
    };
    this.fontMetricsCache.set(font, metrics);
    return metrics;
  }

  private textDrawDescent(member: CastMember, position: number, font: string): number {
    return this.fontMetrics(font).descent;
  }

  private measureTextSpan(member: CastMember, text: string, position: number): number {
    if (text.length === 0) return 0;
    if (!this.measureContext()) return this.fallbackTextAdvance(member, text);
    const charSpacing = this.memberNumberStyle(member, "charspacing", 0);
    let width = 0;
    if (member.textStyleRuns.length === 0) {
      const font = this.canvasFont(member, position);
      for (let i = 0; i < text.length; i += 1) {
        width += this.glyphAdvance(font, text[i]!);
      }
    } else {
      for (let i = 0; i < text.length; i += 1) {
        width += this.glyphAdvance(this.canvasFont(member, position + i), text[i]!);
      }
    }
    return width + Math.max(0, text.length - 1) * charSpacing;
  }

  /** Mutation-counter key: text/style writes bump member.textVersion, so the
   * per-frame presentation check is one string compare instead of
   * re-serializing the member's text and style tables. */
  private textMemberPresentationKey(member: CastMember): string {
    return String(member.textVersion);
  }

  private memberTextRowBaseX(member: CastMember, rowText: string, rowStart: number, width: number): number {
    const alignValue = member.style.get("alignment");
    const align =
      alignValue instanceof LingoSymbol
        ? alignValue.name.toLowerCase()
        : typeof alignValue === "string"
          ? alignValue.toLowerCase()
          : "left";
    const rowWidth = this.measureTextSpan(member, rowText, rowStart);
    return align === "center" ? Math.max(0, (width - rowWidth) / 2) : align === "right" ? Math.max(0, width - rowWidth) : 0;
  }

  private memberTextCaretLoc(member: CastMember, position: number): { x: number; y: number; height: number } {
    const width = Math.max(1, this.memberWidth(member));
    const lineHeight = this.memberLineHeight(member);
    const pos = Math.max(1, Math.min(position, member.text.length + 1));
    const rows = this.layoutTextMember(member);
    for (const row of rows) {
      if (pos >= row.start && pos <= row.end) {
        const x =
          this.memberTextRowBaseX(member, row.text, row.start, width) +
          this.measureTextSpan(member, row.text.slice(0, pos - row.start), row.start);
        return { x, y: row.line * lineHeight, height: lineHeight };
      }
    }
    const last = rows[rows.length - 1]!;
    return {
      x: this.memberTextRowBaseX(member, last.text, last.start, width) + this.measureTextSpan(member, last.text, last.start),
      y: last.line * lineHeight,
      height: lineHeight,
    };
  }

  private memberTextSelectionRects(member: CastMember, startPosition: number, endPosition: number): Array<{ x: number; y: number; width: number; height: number }> | null {
    const textLength = member.text.length;
    const start = Math.max(1, Math.min(textLength + 1, Math.min(startPosition, endPosition)));
    const end = Math.max(1, Math.min(textLength + 1, Math.max(startPosition, endPosition)));
    if (start === end) return null;
    const width = Math.max(1, this.memberWidth(member));
    const lineHeight = this.memberLineHeight(member);
    const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const row of this.layoutTextMember(member)) {
      const rowStart = row.start;
      const rowEnd = Math.max(row.start, row.end);
      const overlapStart = Math.max(start, rowStart);
      const overlapEnd = Math.min(end, rowEnd);
      if (overlapStart >= overlapEnd) continue;
      const baseX = this.memberTextRowBaseX(member, row.text, row.start, width);
      const left = baseX + this.measureTextSpan(member, row.text.slice(0, overlapStart - row.start), row.start);
      const right = baseX + this.measureTextSpan(member, row.text.slice(0, overlapEnd - row.start), row.start);
      if (right <= left) continue;
      rects.push({
        x: left,
        y: row.line * lineHeight,
        width: right - left,
        height: lineHeight,
      });
    }
    return rects.length > 0 ? rects : null;
  }

  prepareTextSpriteImages(
    focusedSprite = 0,
    options: { readonly shouldPrepareChannel?: (channelNumber: number, focused: boolean) => boolean } = {},
  ): void {
    for (const channel of this.channels) {
      const member = channel.member;
      if (channel.puppet !== 1 || channel.visible !== 1 || !member || (member.type !== "field" && member.type !== "text")) {
        continue;
      }
      const editable = channel.editable === 1 || Number(member.style.get("editable") ?? 0) === 1;
      const focused = channel.number === focusedSprite && editable;
      if (options.shouldPrepareChannel && !options.shouldPrepareChannel(channel.number, focused)) continue;
      this.ensureTextMemberImage(member);
      member.presentationCaretLoc = focused ? this.memberTextCaretLoc(member, this.selEnd || member.text.length + 1) : null;
      member.presentationSelectionRects =
        focused
          ? this.memberTextSelectionRects(member, this.selStart || this.selEnd || member.text.length + 1, this.selEnd || member.text.length + 1)
          : null;
    }
  }

  /** The member's current text raster, rebuilt only when text/styles changed.
   * The previous canvas is reused when dimensions match so the renderer can
   * update one GPU texture in place; a replaced image is released through
   * onImageReleased so its texture does not leak. */
  ensureTextMemberImage(member: CastMember): LingoImage {
    const key = this.textMemberPresentationKey(member);
    if (member.presentationImageKey !== key || !member.presentationImage) {
      const previous = member.presentationImage;
      member.presentationImage = this.renderTextMemberImage(member, previous, key);
      member.presentationImageKey = key;
      if (previous && previous !== member.presentationImage) {
        this.onImageReleased(previous);
      }
    }
    return member.presentationImage;
  }

  private drawTextMemberChar(
    ctx: CanvasRenderingContext2D,
    member: CastMember,
    char: string,
    position: number,
    x: number,
    baselineY: number,
    advance: number,
  ): void {
    const fontSize = this.textStyleNumberAt(member, position, "fontsize", this.memberFontSize(member));
    const fontStyle = this.textStyleNames(this.textStyleAt(member, position, "fontstyle"));
    ctx.font = this.canvasFont(member, position);
    ctx.fillStyle = this.textColorCss(this.textStyleAt(member, position, "color"));
    ctx.fillText(char, x, baselineY);
    if (fontStyle.has("underline")) {
      const underlineHeight = Math.max(1, Math.round(fontSize / 12));
      ctx.fillRect(x, baselineY + 1, advance, underlineHeight);
    }
  }

  private shouldSnapTextAlpha(member: CastMember): boolean {
    if (!this.memberBooleanStyle(member, "antialias", true)) return true;
    const threshold = this.memberNumberStyle(member, "antialiasthreshold", DIRECTOR_TEXT_ANTIALIAS_THRESHOLD);
    return this.layoutTextMember(member).every((row) => {
      const fontSize = this.textStyleNumberAt(member, row.start, "fontsize", this.memberFontSize(member));
      return fontSize < threshold;
    });
  }

  private textPixelAlphaThreshold(red: number, green: number, blue: number): number {
    const brightness = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return brightness >= 170 ? LIGHT_TEXT_BITMAP_ALPHA_THRESHOLD : DARK_TEXT_BITMAP_ALPHA_THRESHOLD;
  }

  private textPixelMatchesSingleColorStrike(red: number, green: number, blue: number, color: { r: number; g: number; b: number }): boolean {
    return Math.max(Math.abs(red - color.r), Math.abs(green - color.g), Math.abs(blue - color.b)) <= 1;
  }

  /** Rasterizes a text/field member at Director metrics: each visual row is a
   * lineHeight-tall cell, glyphs occupy the band [topSpacing,
   * topSpacing+fontSize] within it (the band Writer Class slices out of
   * member.image), and the logical pen advances at 26.6 precision while glyph
   * draw positions snap to pixels. Director's antiAliasThreshold defaults to
   * 14pt, so Habbo's 9px Volter text is snapped to bitmap alpha instead of left
   * as browser antialiased webfont output. */
  private renderTextMemberImage(member: CastMember, reuse: LingoImage | null = null, presentationKey = this.textMemberPresentationKey(member)): LingoImage {
    const width = Math.max(1, Math.round(this.memberWidth(member)));
    const height = Math.max(1, Math.round(this.memberHeight(member)));
    const image =
      reuse && reuse.width === width && reuse.height === height && reuse.context
        ? reuse
        : new LingoImage(width, height, 32, undefined, { initWhite: false });
    const ctx = image.context;
    if (!ctx) return image;

    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = "alphabetic";
    const lineHeight = this.memberLineHeight(member);
    const charSpacing = this.memberNumberStyle(member, "charspacing", 0);
    for (const row of this.layoutTextMember(member)) {
      const rowFont = this.canvasFont(member, row.start);
      const fontSize = this.textStyleNumberAt(member, row.start, "fontsize", this.memberFontSize(member));
      const descent = this.textDrawDescent(member, row.start, rowFont);
      const topInset = this.memberTextDrawTopInset(member, lineHeight, fontSize, descent);
      const baselineY = row.line * lineHeight + topInset + Math.max(1, fontSize - descent);
      const baseX = Math.round(this.memberTextRowBaseX(member, row.text, row.start, width));
      let x = baseX;
      for (let i = 0; i < row.text.length; i += 1) {
        const position = row.start + i;
        const advance =
          member.textStyleRuns.length === 0
            ? this.glyphAdvance(rowFont, row.text[i]!)
            : this.measureTextSpan(member, row.text[i]!, position);
        this.drawTextMemberChar(ctx, member, row.text[i]!, position, Math.round(x), baselineY, Math.round(advance));
        x += advance + (i < row.text.length - 1 ? charSpacing : 0);
      }
    }
    if (this.shouldSnapTextAlpha(member)) {
      const solidTextColor = this.singleTextColor(member);
      const pixels = ctx.getImageData(0, 0, width, height);
      const data = pixels.data;
      for (let offset = 3; offset < data.length; offset += 4) {
        const red = data[offset - 3] ?? 0;
        const green = data[offset - 2] ?? 0;
        const blue = data[offset - 1] ?? 0;
        const alphaThreshold = this.textPixelAlphaThreshold(red, green, blue);
        const matchesSingleColorStrike =
          !solidTextColor || this.textPixelMatchesSingleColorStrike(red, green, blue, solidTextColor);
        if (data[offset]! >= alphaThreshold && matchesSingleColorStrike) {
          if (solidTextColor) {
            data[offset - 3] = solidTextColor.r;
            data[offset - 2] = solidTextColor.g;
            data[offset - 1] = solidTextColor.b;
          }
          data[offset] = 255;
        } else {
          data[offset] = 0;
        }
      }
      ctx.putImageData(pixels, 0, 0);
    }
    image.markPixelsChanged("text-member", member.slotNumber, member.castNumber, member.name, presentationKey);
    return image;
  }

  theOf = (property: string, object: LingoValue): LingoValue | undefined => {
    if (object instanceof CastMember || object instanceof SpriteChannel || object instanceof CastLibRef) {
      if (property === "number_of_members" && object instanceof CastLibRef) {
        return this.members.memberCount(object.name);
      }
      return this.getProp(object, property);
    }
    return undefined;
  };

  setTheOf = (property: string, object: LingoValue, value: LingoValue): boolean => {
    return this.setProp(object, property, value);
  };

  objectRef = (refType: string, id: LingoValue, castLib: LingoValue | null): LingoValue | undefined => {
    if (refType === "castlib") {
      return this.call("castlib", [id]);
    }
    if (refType === "member" || refType === "field") {
      return this.call("member", castLib === null ? [id] : [id, castLib]);
    }
    if (refType === "sprite") {
      return this.call("sprite", [id]);
    }
    return undefined;
  };
}

function mediaSourceForMember(member: CastMember): { readonly memberName: string; readonly memberNumber: number; readonly castName: string } {
  return {
    memberName: member.name,
    memberNumber: member.number,
    castName: member.castName,
  };
}

function isPhotoInvalidMedia(value: LingoValue): boolean {
  return value instanceof LingoBitmapMedia && value.source.memberName?.toLowerCase() === "photo_invalid";
}

function formatDirectorBitmapMediaInspection(info: DirectorBitmapMediaInspection): string {
  const fields = [
    `accepted=${info.accepted ? 1 : 0}`,
    `reason=${info.reason}`,
    `bytes=${info.bytes}`,
    `prefix=${info.prefix}`,
  ];
  if (info.offset !== undefined) fields.push(`offset=${info.offset}`);
  if (info.fourCC !== undefined) fields.push(`fourCC=${JSON.stringify(info.fourCC)}`);
  if (info.width !== undefined && info.height !== undefined) fields.push(`size=${info.width}x${info.height}`);
  if (info.rowBytes !== undefined) fields.push(`rowBytes=${info.rowBytes}`);
  if (info.minRowBytes !== undefined) fields.push(`minRowBytes=${info.minRowBytes}`);
  if (info.bitDepth !== undefined) fields.push(`bitDepth=${info.bitDepth}`);
  if (info.palette !== undefined) fields.push(`palette=${info.palette}`);
  if (info.paletteName !== undefined) fields.push(`paletteName=${info.paletteName}`);
  if (info.packedLength !== undefined) fields.push(`packedLength=${info.packedLength}`);
  return fields.join(" ");
}
