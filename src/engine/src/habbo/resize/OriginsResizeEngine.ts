import type { DirectorMovie } from "../../director/Movie";
import { LingoPoint, LingoRect } from "../../director/geometry";
import { add as lingoAdd, lingoKeyEquals, stringOf } from "../../director/ops";
import { ScriptInstance } from "../../director/Runtime";
import { SpriteChannel } from "../../director/sprites";
import {
  LINGO_VOID,
  LingoFloat,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoVoid,
  type LingoValue,
} from "../../director/values";
import { LandscapeResizePresentation } from "./room/landscape/LandscapeResizePresentation";
import { RoomWrapperResizePresentation } from "./room/RoomWrapperResizePresentation";
import type { RoomResizePresentationContext } from "./room/RoomResizePresentationContext";
import type { ResizeEngineAnchor, ResizeEngineSnapshot } from "./ResizeEngineTypes";
import { WallResizePresentation } from "./room/wall/WallResizePresentation";

export type { ResizeEngineAnchor, ResizeEngineSnapshot } from "./ResizeEngineTypes";

interface SeenPosition {
  readonly instance: ScriptInstance;
  readonly locX: number;
  readonly locY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

interface RoomStageState {
  readonly instance: ScriptInstance;
  readonly baseX: number;
  readonly baseY: number;
  readonly sourceWideOffset: number;
  readonly epochKey: string;
  readonly wrappers: Map<string, WrapperStageBaseline>;
}

interface MoveResult {
  readonly moved: boolean;
  readonly dx: number;
  readonly dy: number;
  readonly x: number;
  readonly y: number;
}

interface FreeStageSpriteOffset {
  readonly owner: ScriptInstance | null;
  readonly x: number;
  readonly y: number;
  readonly lastX: number;
  readonly lastY: number;
}

interface FreeStageSpriteReference {
  readonly sprite: SpriteChannel;
  readonly path: string;
  readonly sourcePoint: LingoPoint | null;
}

interface StagePresentationOffset {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly layout: string;
}

interface StagePresentationResult {
  readonly changed: boolean;
  readonly offsets: StagePresentationOffset[];
}

interface WrapperPartBaseline {
  readonly locH: number;
  readonly locV: number;
}

interface WrapperStageBaseline {
  readonly instance: ScriptInstance;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly appliedX: number;
  readonly appliedY: number;
  readonly parts: WrapperPartBaseline[];
}

const PRESENTATION_TOOLBAR_HEIGHT = 54;

export class OriginsResizeEngine {
  private viewportWidth: number;
  private viewportHeight: number;
  private snapshot: ResizeEngineSnapshot;
  private readonly seen = new Map<string, SeenPosition>();
  private readonly applied = new Map<string, string>();
  private readonly entryAnimationOffsets = new Map<number, { x: number; y: number; lastX: number; lastY: number }>();
  private roomStage: RoomStageState | null = null;
  private manualRoomOffsetX = 0;
  private manualRoomOffsetY = 0;
  // Per wall wrapper, the rendered-image object we last produced at logical part
  // positions. Lets us cheaply detect when source re-rendered the wall image (room
  // build / setPartPattern) so we only re-run the expensive renderImage then.
  // Per shadow (`other`) wrapper, the room offset that was applied when its image was
  // last (re)rendered — i.e. the offset its baked-in parts already account for. The
  // shadow sprite is then offset by how far the room has moved since. Late wrappers
  // without a rendered image are normal source sprites that missed the earlier move.
  private readonly freeStageSpriteOffsets = new Map<number, FreeStageSpriteOffset>();
  // The room offset baked into the current room's landscape image, captured once per
  // room (by epoch) when the landscape first goes active. The landscape + cloud sprites
  // are then offset only by how far the room has moved since. Re-captured on every room
  // (re)entry so a stale baseline can't carry over and push the sky off-screen.
  private readonly wallPresentation: WallResizePresentation;
  private readonly wrapperPresentation: RoomWrapperResizePresentation;
  private readonly landscapePresentation: LandscapeResizePresentation;

  constructor(private readonly movie: DirectorMovie) {
    this.viewportWidth = movie.manifestStageWidth;
    this.viewportHeight = movie.manifestStageHeight;
    this.snapshot = this.emptySnapshot();
    const presentationContext: RoomResizePresentationContext = {
      movie,
      objectById: (id) => this.object(id),
      instanceProp: (instance, prop) => this.instanceProp(instance, prop),
      propListLookup: (list, key) => this.propListLookup(list, key),
      numberValue: (value, fallback) => this.numberValue(value, fallback),
      normalizedSymbol: (value) => this.normalizedSymbol(value),
      setSpriteLoc: (sprite, locH, locV) => this.setSpriteLoc(sprite, locH, locV),
      spriteMemberImage: (value) => this.spriteMemberImage(value),
    };
    this.wallPresentation = new WallResizePresentation(presentationContext);
    this.wrapperPresentation = new RoomWrapperResizePresentation(presentationContext);
    this.landscapePresentation = new LandscapeResizePresentation(presentationContext);
  }

  setViewport(width: number, height: number): ResizeEngineSnapshot {
    this.viewportWidth = Math.max(1, Math.round(width));
    this.viewportHeight = Math.max(1, Math.round(height));
    return this.apply("viewport");
  }

  apply(reason = "sync"): ResizeEngineSnapshot {
    const anchors: ResizeEngineAnchor[] = [];
    const errors: string[] = [];
    let changed = false;
    const markChanged = (): void => {
      changed = true;
    };
    const guard = (id: string, kind: ResizeEngineAnchor["kind"], action: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        errors.push(`${id}.${action}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    anchors.push({
      id: "stage",
      kind: "stage",
      action: "viewport",
      width: this.viewportWidth,
      height: this.viewportHeight,
    });

    guard("window_manager", "manager", "boundary", () => {
      const manager = this.object("#window_manager");
      if (!manager) return;
      if (!this.shouldApply("window_manager")) return;
      const boundary = new LingoRect(-20, -20, this.viewportWidth + 20, this.viewportHeight + 20);
      this.movie.runtime.callMethod(manager, "setproperty", [LingoSymbol.for("boundary"), boundary]);
      this.markApplied("window_manager");
      markChanged();
      anchors.push({ id: "window_manager", kind: "manager", action: "boundary", width: this.viewportWidth, height: this.viewportHeight });
    });

    guard("visualizer_manager", "manager", "boundary", () => {
      const manager = this.object("#visualizer_manager");
      if (!manager) return;
      if (!this.shouldApply("visualizer_manager")) return;
      const boundary = new LingoRect(-1000, -1000, this.viewportWidth + 1000, this.viewportHeight + 1000);
      this.movie.runtime.callMethod(manager, "setproperty", [LingoSymbol.for("boundary"), boundary]);
      this.markApplied("visualizer_manager");
      markChanged();
      anchors.push({
        id: "visualizer_manager",
        kind: "manager",
        action: "boundary",
        width: this.viewportWidth,
        height: this.viewportHeight,
      });
    });

    const roomInterface = this.object("#room_interface") ?? this.object("room_interface");
    if (roomInterface) {
      guard("room_interface", "room", "stage-props", () => {
        const lastWidth = this.numberProp(roomInterface, "plaststagew", 0);
        const lastHeight = this.numberProp(roomInterface, "plaststageh", 0);
        if (lastWidth !== this.viewportWidth) {
          this.movie.runtime.setProp(roomInterface, "pLastStageW", this.viewportWidth);
          markChanged();
        }
        if (lastHeight !== this.viewportHeight) {
          this.movie.runtime.setProp(roomInterface, "pLastStageH", this.viewportHeight);
          markChanged();
        }
        if (!this.object("Room_visualizer") && this.movie.runtime.hasHandler(roomInterface, "updatescreenoffset")) {
          this.movie.runtime.callMethod(roomInterface, "updatescreenoffset", []);
        }
        if (this.resizeCoverSprite(roomInterface, anchors)) markChanged();
        this.markApplied("room_interface");
        anchors.push({
          id: "room_interface",
          kind: "room",
          action: "stage-props",
          width: this.viewportWidth,
          height: this.viewportHeight,
        });
      });
    }

    const roomOffsetX = Math.round((this.viewportWidth - this.movie.manifestStageWidth) / 2);
    const roomOffsetY = Math.round((this.viewportHeight - this.movie.manifestStageHeight) / 2);
    const entryOffsetX = roomOffsetX;
    const entryOffsetY = 0;

    guard("Room_visualizer", "room", "stage-follow", () => {
      const visualizer = this.object("Room_visualizer");
      if (!visualizer) return;
      const interfaceObject = roomInterface ?? this.object("#room_interface") ?? this.object("room_interface");
      if (!interfaceObject) return;
      let currentX = this.numberProp(visualizer, "plocx", 0);
      let currentY = this.numberProp(visualizer, "plocy", 0);
      const sourceWideOffset = this.numberProp(interfaceObject, "pwidescreenoffset", 0);
      const epochKey = this.roomStageEpochKey(visualizer, sourceWideOffset);
      const seenRoomStage = this.seen.get("Room_stage");
      const sourceSnap =
        this.roomStage?.instance === visualizer &&
        seenRoomStage?.instance === visualizer &&
        (Math.round(currentX) !== Math.round(seenRoomStage.locX) || Math.round(currentY) !== Math.round(seenRoomStage.locY));
      const roomChanged =
        !this.roomStage || this.roomStage.instance !== visualizer || this.roomStage.epochKey !== epochKey;
      if (!this.roomStage || this.roomStage.instance !== visualizer || this.roomStage.epochKey !== epochKey || sourceSnap) {
        this.roomStage = {
          instance: visualizer,
          baseX: currentX,
          baseY: currentY,
          sourceWideOffset,
          epochKey,
          wrappers: this.captureWrapperBaselines(visualizer, 0, 0),
        };
        this.manualRoomOffsetX = 0;
        this.manualRoomOffsetY = 0;
        // A genuine room change (new visualizer instance / layout) gets a freshly-built
        // landscape image with a new baked-in offset, so the sky baseline must be
        // recaptured. The epoch key is only `layout|wideOffset`, which two different rooms
        // can share — keying the landscape placement by epoch alone left a STALE baseline
        // from the previous room, anchoring the new room's sky off-screen ("sky derender"
        // when leaving and rejoining a same-layout room). Clear it on the real room change
        // (but not on in-room source re-baselines) so anchorLandscapeSprite recaptures.
        if (roomChanged) {
          this.landscapePresentation.resetRoom();
        }
      }
      const targetX = Math.round(this.roomStage.baseX + roomOffsetX + this.manualRoomOffsetX);
      const targetY = Math.round(this.roomStage.baseY + roomOffsetY + this.manualRoomOffsetY);
      this.wrapperPresentation.captureShadowBaselines(
        visualizer,
        Math.round(currentX - this.roomStage.baseX),
        Math.round(currentY - this.roomStage.baseY),
      );
      const deltaX = Math.round(targetX - currentX);
      const deltaY = Math.round(targetY - currentY);
      if (deltaX !== 0 || deltaY !== 0) {
        this.movie.runtime.callMethod(interfaceObject, "moveroomby", [deltaX, deltaY]);
        markChanged();
        currentX = this.numberProp(visualizer, "plocx", targetX);
        currentY = this.numberProp(visualizer, "plocy", targetY);
        const residualX = Math.round(targetX - currentX);
        const residualY = Math.round(targetY - currentY);
        if (
          (residualX !== 0 || residualY !== 0) &&
          this.applyResizeOnlyRoomMoveResidual(interfaceObject, visualizer, residualX, residualY, anchors)
        ) {
          markChanged();
          currentX = this.numberProp(visualizer, "plocx", targetX);
          currentY = this.numberProp(visualizer, "plocy", targetY);
        }
        this.manualRoomOffsetX = Math.round(currentX - this.roomStage.baseX - roomOffsetX);
        this.manualRoomOffsetY = Math.round(currentY - this.roomStage.baseY - roomOffsetY);
      }
      // Run every frame (not only when the room moved): source re-renders the wall
      // image during room build AFTER our centering pass, so a one-shot render would
      // be overwritten and the wall would sit mis-rendered until the next manual move.
      // The image-identity skip inside keeps this cheap when nothing changed.
      const stageAppliedX = Math.round(currentX - this.roomStage.baseX);
      const stageAppliedY = Math.round(currentY - this.roomStage.baseY);
      this.wallPresentation.renderAtLogicalCoordinates(visualizer, stageAppliedX, stageAppliedY);
      this.wrapperPresentation.renderShadowsAtLogicalCoordinates(visualizer, stageAppliedX, stageAppliedY);
      // Landscape (window sky/clouds): rebuild its Source-owned mask in logical movie
      // coordinates, then apply the room's presentation offset to the finished sprites.
      if (this.landscapePresentation.anchor(visualizer, this.roomStage.epochKey, stageAppliedX, stageAppliedY, anchors)) markChanged();
      this.updateSeen("Room_stage", visualizer, currentX, currentY);
      if (
        this.wrapperPresentation.correctLocations(
          visualizer,
          this.roomStage.baseX,
          this.roomStage.baseY,
          currentX,
          currentY,
          anchors,
        )
      ) markChanged();
      if (this.resizeDimmerSprite(visualizer, anchors)) markChanged();
      this.markApplied("Room_stage");
      anchors.push({
        id: "Room_stage",
        kind: "room",
        action: "source-moveRoomBy",
        x: deltaX,
        y: deltaY,
        note: `target=${targetX},${targetY}; sourceWideOffset=${this.roomStage.sourceWideOffset}`,
      });
    });

    guard("entry_view", "visualizer", "stage-center", () => {
      const visualizer = this.object("entry_view");
      if (!visualizer) return;
      const x = Math.round(entryOffsetX);
      const y = Math.round(entryOffsetY);
      const move = this.moveInstanceTo(visualizer, x, y);
      if (!move.moved) return;
      this.updateSeen("entry_view", visualizer, move.x, move.y);
      this.markApplied("entry_view");
      this.rememberEntryAnimationOffsets(move.x, move.y);
      markChanged();
      anchors.push({ id: "entry_view", kind: "visualizer", action: "stage-center", x: move.x, y: move.y });
    });

    guard("entry_interface", "visualizer", "animation-stage-center", () => {
      const entryInterface = this.object("#entry_interface") ?? this.object("entry_interface");
      if (!entryInterface) return;
      if (this.anchorEntryAnimationSprites(entryInterface, entryOffsetX, entryOffsetY, anchors)) markChanged();
    });

    for (const id of ["#login_a", "#login_b"]) {
      guard(id, "window", "entry-stage-follow", () => {
        const window = this.object(id);
        if (!window) return;
        this.setWideBoundary(window);
        const seen = this.rememberFromViewport(id, window, this.movie.manifestStageWidth);
        const x = Math.round(seen.locX + entryOffsetX);
        const y = Math.round(seen.locY + entryOffsetY);
        const move = this.moveInstanceTo(window, x, y);
        if (!move.moved) return;
        markChanged();
        anchors.push({ id, kind: "window", action: "entry-stage-follow", x: move.x, y: move.y });
      });
    }

    for (const id of this.loadingWindowIds()) {
      guard(id, "window", "viewport-center", () => {
        const window = this.object(id);
        if (!window) return;
        this.setWideBoundary(window);
        const width = Math.max(1, this.numberProperty(window, "width", this.movie.manifestStageWidth));
        const height = Math.max(1, this.numberProperty(window, "height", this.movie.manifestStageHeight));
        const x = Math.max(0, Math.round((this.viewportWidth - width) / 2));
        const y = Math.max(0, Math.round((this.viewportHeight - height) / 2));
        const move = this.moveInstanceTo(window, x, y);
        if (!move.moved) return;
        this.updateSeen(id, window, move.x, move.y);
        markChanged();
        anchors.push({ id, kind: "window", action: "viewport-center", x: move.x, y: move.y });
      });
    }

    const bottomBars = ["RoomBarID", "Room_bar", "entry_bar"];
    let bottomBarTargetY: number | null = null;
    let toolbarUnderlayAdded = false;
    for (const id of bottomBars) {
      guard(id, "window", "bottom-center", () => {
        const window = this.object(id);
        if (!window) return;
        const height = Math.max(1, this.numberProperty(window, "height", PRESENTATION_TOOLBAR_HEIGHT));
        const x = Math.max(0, Math.round((this.viewportWidth - this.movie.manifestStageWidth) / 2));
        const y = Math.max(0, this.viewportHeight - height);
        const underlayY = this.toolbarTop();
        this.setWideBoundary(window);
        const move = this.moveInstanceTo(window, x, y);
        if (move.moved) {
          this.updateSeen(id, window, x, y);
          markChanged();
        }
        this.markApplied(id);
        bottomBarTargetY = y;
        if (!toolbarUnderlayAdded) {
          toolbarUnderlayAdded = true;
          anchors.push({
            id: "toolbar_underlay",
            kind: "sprite",
            action: "toolbar-underlay",
            x: 0,
            y: underlayY,
            width: this.viewportWidth,
            height: PRESENTATION_TOOLBAR_HEIGHT,
          });
        }
        if (move.moved) {
          anchors.push({ id, kind: "window", action: "bottom-center", x, y });
        }
      });
    }

    guard("Room_info", "window", "room-follow", () => {
      const window = this.object("Room_info");
      if (!window) return;
      this.setWideBoundary(window);
      const x = Math.max(0, Math.round(10 + roomOffsetX));
      const y = bottomBarTargetY === null ? Math.round(420 + Math.max(0, roomOffsetY)) : Math.max(0, bottomBarTargetY - 66);
      const move = this.moveInstanceTo(window, x, y);
      if (!move.moved) return;
      this.updateSeen("Room_info", window, move.x, move.y);
      this.markApplied("Room_info");
      markChanged();
      anchors.push({ id: "Room_info", kind: "window", action: "room-follow", x: move.x, y: move.y });
    });

    guard("Room_info_stand", "window", "right-anchor", () => {
      const window = this.object("Room_info_stand");
      if (!window) return;
      this.setWideBoundary(window);
      const x = Math.max(0, this.viewportWidth - 168);
      const y = Math.max(0, this.viewportHeight - 208);
      const move = this.moveInstanceTo(window, x, y);
      if (move.moved) {
        this.updateSeen("Room_info_stand", window, move.x, move.y);
        this.moveInfoStandLooseSprites(roomInterface, move.dx, move.dy, anchors);
        markChanged();
      }
      if (this.positionInfoStandTitle(roomInterface, anchors)) markChanged();
      this.markApplied("Room_info_stand");
      if (move.moved) anchors.push({ id: "Room_info_stand", kind: "window", action: "right-anchor", x: move.x, y: move.y });
    });

    guard("Room_interface", "window", "right-anchor", () => {
      const window = this.object("Room_interface");
      if (!window) return;
      this.setWideBoundary(window);
      const x = Math.max(0, Math.round(545 + (this.viewportWidth - this.movie.manifestStageWidth)));
      const y = Math.max(0, this.viewportHeight - 70);
      const move = this.moveInstanceTo(window, x, y);
      if (!move.moved) return;
      this.updateSeen("Room_interface", window, move.x, move.y);
      this.markApplied("Room_interface");
      markChanged();
      anchors.push({ id: "Room_interface", kind: "window", action: "right-anchor", x: move.x, y: move.y });
    });

    guard("Hand_visualizer", "visualizer", "right-preserve", () => {
      const visualizer = this.object("Hand_visualizer");
      if (!visualizer) return;
      const seen = this.rememberFromViewport("Hand_visualizer", visualizer, this.movie.manifestStageWidth);
      const currentX = this.numberProp(visualizer, "plocx", seen.locX);
      const currentY = this.numberProp(visualizer, "plocy", seen.locY);
      const x = Math.round(currentX + (this.viewportWidth - seen.viewportWidth));
      const y = currentY;
      const move = this.moveInstanceTo(visualizer, x, y);
      if (!move.moved) return;
      this.updateSeen("Hand_visualizer", visualizer, move.x, move.y);
      this.markApplied("Hand_visualizer");
      markChanged();
      anchors.push({ id: "Hand_visualizer", kind: "visualizer", action: "right-preserve", x: move.x, y: move.y });
    });

    guard("habbo_hand_buttons", "window", "top-right", () => {
      const window = this.object("habbo_hand_buttons");
      if (!window) return;
      this.setWideBoundary(window);
      const width = Math.max(1, this.numberProperty(window, "width", 447));
      const x = Math.max(0, this.viewportWidth - width - 5);
      const y = 5;
      const move = this.moveInstanceTo(window, x, y);
      if (!move.moved) return;
      this.updateSeen("habbo_hand_buttons", window, move.x, move.y);
      this.markApplied("habbo_hand_buttons");
      markChanged();
      anchors.push({ id: "habbo_hand_buttons", kind: "window", action: "top-right", x: move.x, y: move.y });
    });

    guard("bulletin_notification_manager", "manager", "top-right-notifications", () => {
      const manager = this.object("bulletin_notification_manager");
      if (!manager) return;
      if (this.anchorBulletinNotifications(manager, anchors)) markChanged();
      this.markApplied("bulletin_notification_manager");
    });

    guard("stage_presentations", "visualizer", "stage-follow", () => {
      const managedSprites = this.managedPresentationSprites();
      this.landscapePresentation.collectManagedSprites(managedSprites);
      const loadingWindows = new Set(this.loadingWindowIds().map((id) => this.normalizedSymbol(id)));
      const stagePresentations = this.anchorStagePresentationVisualizers(roomOffsetX, roomOffsetY, anchors);
      if (stagePresentations.changed) markChanged();
      if (this.anchorStagePresentationWindows(roomOffsetX, roomOffsetY, loadingWindows, anchors)) markChanged();
      if (this.anchorFreeStageSprites(roomOffsetX, roomOffsetY, stagePresentations.offsets, managedSprites, anchors)) markChanged();
    });

    this.snapshot = {
      enabled: true,
      changed,
      baseWidth: this.movie.manifestStageWidth,
      baseHeight: this.movie.manifestStageHeight,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      anchors,
      errors,
    };
    return this.snapshot;
  }

  currentSnapshot(): ResizeEngineSnapshot {
    return this.snapshot;
  }

  needsFrameSync(): boolean {
    return (
      this.viewportWidth !== this.movie.manifestStageWidth ||
      this.viewportHeight !== this.movie.manifestStageHeight ||
      this.manualRoomOffsetX !== 0 ||
      this.manualRoomOffsetY !== 0
    );
  }

  canDragRoomAt(x: number, y: number): boolean {
    return (
      !!this.object("Room_visualizer") &&
      x >= 0 &&
      y >= 0 &&
      x < this.viewportWidth &&
      y < this.toolbarTop()
    );
  }

  dragRoomBy(dx: number, dy: number): ResizeEngineSnapshot {
    const roundedDx = Math.round(dx);
    const roundedDy = Math.round(dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (roundedDx === 0 && roundedDy === 0)) {
      return this.snapshot;
    }
    this.manualRoomOffsetX += roundedDx;
    this.manualRoomOffsetY += roundedDy;
    return this.apply("room-drag");
  }

  private emptySnapshot(): ResizeEngineSnapshot {
    return {
      enabled: true,
      changed: false,
      baseWidth: this.movie.manifestStageWidth,
      baseHeight: this.movie.manifestStageHeight,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      anchors: [],
      errors: [],
    };
  }

  private viewportKey(): string {
    return `${this.viewportWidth}x${this.viewportHeight}`;
  }

  private toolbarTop(): number {
    return Math.max(0, this.viewportHeight - PRESENTATION_TOOLBAR_HEIGHT - 1);
  }

  private shouldApply(id: string): boolean {
    return this.applied.get(id) !== this.viewportKey();
  }

  private markApplied(id: string): void {
    this.applied.set(id, this.viewportKey());
  }

  private object(id: string): ScriptInstance | null {
    const list = this.objectList();
    if (!list) return null;
    const value = this.propListLookup(list, id);
    return value instanceof ScriptInstance ? value : null;
  }

  private loadingWindowIds(): string[] {
    const ids = new Set<string>();
    if (this.object("Loading room")) ids.add("Loading room");
    const list = this.objectList();
    if (!list) return [...ids];
    for (const value of list.values) {
      if (!(value instanceof ScriptInstance)) continue;
      if (value.module.scriptName.toLowerCase() !== "loading bar class") continue;
      const windowId = this.instanceProp(value, "pwindowid");
      const id = stringOf(windowId).trim();
      if (id !== "" && this.object(id)) ids.add(id);
    }
    return [...ids];
  }

  private objectList(): LingoPropList | null {
    const gCore = this.movie.runtime.getGlobal("gcore");
    if (!(gCore instanceof ScriptInstance)) return null;
    const objectList = gCore.props.get("pobjectlist");
    return objectList instanceof LingoPropList ? objectList : null;
  }

  private propListLookup(list: LingoPropList, key: string): LingoValue {
    if (key.startsWith("#")) {
      return list.getaProp(LingoSymbol.for(key.slice(1)), lingoKeyEquals);
    }
    return list.getaProp(key, lingoKeyEquals);
  }

  private remember(id: string, instance: ScriptInstance): SeenPosition {
    return this.rememberFromViewport(id, instance, this.viewportWidth);
  }

  private rememberFromViewport(id: string, instance: ScriptInstance, newInstanceViewportWidth: number): SeenPosition {
    const existing = this.seen.get(id);
    if (existing?.instance === instance) return existing;
    if (existing && existing.instance !== instance) {
      this.applied.delete(id);
    }
    const locX = this.numberProp(instance, "plocx", 0);
    const locY = this.numberProp(instance, "plocy", 0);
    const seen = {
      instance,
      locX,
      locY,
      viewportWidth: Math.max(1, Math.round(newInstanceViewportWidth)),
      viewportHeight: this.viewportHeight,
    };
    this.seen.set(id, seen);
    return seen;
  }

  private updateSeen(id: string, instance: ScriptInstance, locX: number, locY: number): void {
    this.seen.set(id, {
      instance,
      locX,
      locY,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
    });
  }

  private moveInstance(instance: ScriptInstance, x: number, y: number): void {
    this.movie.runtime.callMethod(instance, "moveto", [Math.round(x), Math.round(y)]);
  }

  private moveInstanceTo(instance: ScriptInstance, x: number, y: number): MoveResult {
    const targetX = Math.round(x);
    const targetY = Math.round(y);
    const currentX = this.numberProp(instance, "plocx", targetX);
    const currentY = this.numberProp(instance, "plocy", targetY);
    if (currentX === targetX && currentY === targetY) {
      return { moved: false, dx: 0, dy: 0, x: currentX, y: currentY };
    }
    this.moveInstance(instance, targetX, targetY);
    const nextX = this.numberProp(instance, "plocx", targetX);
    const nextY = this.numberProp(instance, "plocy", targetY);
    return { moved: nextX !== currentX || nextY !== currentY, dx: nextX - currentX, dy: nextY - currentY, x: nextX, y: nextY };
  }

  private setWideBoundary(instance: ScriptInstance): void {
    if (!this.movie.runtime.hasHandler(instance, "setproperty")) return;
    const boundary = new LingoRect(-1000, -1000, this.viewportWidth + 1000, this.viewportHeight + 1000);
    this.movie.runtime.callMethod(instance, "setproperty", [LingoSymbol.for("boundary"), boundary]);
  }

  private applyResizeOnlyRoomMoveResidual(
    roomInterface: ScriptInstance,
    visualizer: ScriptInstance,
    dx: number,
    dy: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const deltaX = Math.round(dx);
    const deltaY = Math.round(dy);
    if (deltaX === 0 && deltaY === 0) return false;
    if (
      !this.movie.runtime.hasHandler(roomInterface, "getroomvisualizer") ||
      !this.movie.runtime.hasHandler(roomInterface, "getgeometry")
    ) {
      return false;
    }
    try {
      if (this.movie.runtime.callMethod(roomInterface, "getroomvisualizer", []) !== visualizer) return false;
    } catch {
      return false;
    }

    const beforeX = this.numberProp(visualizer, "plocx", 0);
    const beforeY = this.numberProp(visualizer, "plocy", 0);
    this.movie.runtime.callMethod(visualizer, "moveby", [deltaX, deltaY]);
    const afterX = this.numberProp(visualizer, "plocx", beforeX + deltaX);
    const afterY = this.numberProp(visualizer, "plocy", beforeY + deltaY);
    const appliedX = Math.round(afterX - beforeX);
    const appliedY = Math.round(afterY - beforeY);
    if (appliedX === 0 && appliedY === 0) return false;

    this.shiftRoomGeometry(roomInterface, appliedX, appliedY);
    this.shiftRoomComponentObjects(roomInterface, appliedX, appliedY);
    this.wallPresentation.shiftPartData(visualizer, appliedX, appliedY);

    anchors.push({
      id: "Room_stage",
      kind: "room",
      action: "resize-residual-move",
      x: appliedX,
      y: appliedY,
      note: "Source moveroomby drag clamp rejected part of the presentation move delta",
    });
    return true;
  }

  private shiftRoomGeometry(roomInterface: ScriptInstance, dx: number, dy: number): void {
    if (!this.movie.runtime.hasHandler(roomInterface, "getgeometry")) return;
    const geometry = this.movie.runtime.callMethod(roomInterface, "getgeometry", []);
    if (!(geometry instanceof ScriptInstance)) return;
    this.shiftInstanceProp(geometry, "pxoffset", dx, 0);
    this.shiftInstanceProp(geometry, "pyoffset", dy, 0);
  }

  private shiftRoomComponentObjects(roomInterface: ScriptInstance, dx: number, dy: number): void {
    const component = this.roomComponent(roomInterface);
    if (!component) return;
    this.shiftRoomComponentObjectList(component, "getuserobject", dx, dy, true);
    this.shiftRoomComponentObjectList(component, "getactiveobject", dx, dy, false);
    this.shiftRoomComponentObjectList(component, "getitemobject", dx, dy, false);
    this.shiftRoomComponentObjectList(component, "getpassiveobject", dx, dy, false);
  }

  private roomComponent(roomInterface: ScriptInstance): ScriptInstance | null {
    try {
      if (this.movie.runtime.hasHandler(roomInterface, "getcomponent")) {
        const component = this.movie.runtime.callMethod(roomInterface, "getcomponent", []);
        if (component instanceof ScriptInstance) return component;
      }
    } catch {
      // Fall through to the source-style thread lookup.
    }

    try {
      const roomThread = this.movie.runtime.call("getthread", [LingoSymbol.for("room")]);
      if (!(roomThread instanceof ScriptInstance)) return null;
      const component = this.movie.runtime.callMethod(roomThread, "getcomponent", []);
      return component instanceof ScriptInstance ? component : null;
    } catch {
      return null;
    }
  }

  private shiftRoomComponentObjectList(component: ScriptInstance, method: string, dx: number, dy: number, includeUserState: boolean): void {
    if (!this.movie.runtime.hasHandler(component, method)) return;
    let listValue: LingoValue;
    try {
      listValue = this.movie.runtime.callMethod(component, method, [LingoSymbol.for("list")]);
    } catch {
      return;
    }
    if (!(listValue instanceof LingoList)) return;

    for (const object of listValue.items) {
      if (!(object instanceof ScriptInstance)) continue;
      if (includeUserState) {
        this.shiftInstanceProp(object, "pscreenloc", dx, dy, 0);
        this.shiftInstanceProp(object, "pstartlscreen", dx, dy, 0);
        this.shiftInstanceProp(object, "pdestlscreen", dx, dy, 0);
        if (!this.isPetRoomObject(object)) {
          this.shiftInstanceProp(object, "ppreviousloc", dx, dy, 0);
        }
      }
      this.shiftSpritesFromGetter(object, dx, dy);
    }
  }

  private shiftSpritesFromGetter(object: ScriptInstance, dx: number, dy: number): void {
    if (!this.movie.runtime.hasHandler(object, "getsprites")) return;
    let sprites: LingoValue;
    try {
      sprites = this.movie.runtime.callMethod(object, "getsprites", []);
    } catch {
      return;
    }
    if (!(sprites instanceof LingoList)) return;
    for (const value of sprites.items) {
      if (value instanceof SpriteChannel) this.setSpriteLoc(value, value.locH + dx, value.locV + dy);
    }
  }

  private isPetRoomObject(object: ScriptInstance): boolean {
    if (!this.movie.runtime.hasHandler(object, "getclass")) return false;
    try {
      return stringOf(this.movie.runtime.callMethod(object, "getclass", [])).toLowerCase() === "pet";
    } catch {
      return false;
    }
  }

  private shiftInstanceProp(instance: ScriptInstance, prop: string, dx: number, dy: number, dz?: number): void {
    const current = this.instanceProp(instance, prop);
    if (current instanceof LingoVoid) return;
    const delta = dz === undefined ? dx : current instanceof LingoPoint ? new LingoPoint(dx, dy) : new LingoList([dx, dy, dz]);
    try {
      this.movie.runtime.setProp(instance, prop, lingoAdd(current, delta));
    } catch {
      // Some transient Source objects expose optional presentation props. If the
      // property cannot be shifted, leave it exactly as Source produced it.
    }
  }

  private numberProperty(instance: ScriptInstance, property: string, fallback: number): number {
    try {
      const value = this.movie.runtime.callMethod(instance, "getproperty", [LingoSymbol.for(property)]);
      const result = this.numberValue(value, Number.NaN);
      return Number.isFinite(result) ? result : fallback;
    } catch {
      return this.numberProp(instance, `p${property}`, fallback);
    }
  }

  private numberProp(instance: ScriptInstance, prop: string, fallback: number): number {
    const value = instance.props.get(prop.toLowerCase()) ?? LINGO_VOID;
    return this.numberValue(value, fallback);
  }

  private numberValue(value: LingoValue, fallback: number): number {
    if (typeof value === "number") return value;
    if (value instanceof LingoFloat) return value.value;
    const numeric = Number(stringOf(value));
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private setSpriteLoc(sprite: SpriteChannel, locH: number, locV: number): boolean {
    const x = Math.round(locH);
    const y = Math.round(locV);
    if (sprite.locH === x && sprite.locV === y) return false;
    sprite.locH = x;
    sprite.locV = y;
    sprite.markChanged();
    return true;
  }

  private spriteMemberImage(value: LingoValue): object | undefined {
    if (!(value instanceof SpriteChannel)) return undefined;
    const image = (value as unknown as { member?: { image?: unknown } }).member?.image;
    return image && typeof image === "object" ? image : undefined;
  }

  private setSpriteSize(sprite: SpriteChannel, width: number, height: number): boolean {
    const nextWidth = Math.max(0, Math.round(width));
    const nextHeight = Math.max(0, Math.round(height));
    if (sprite.width === nextWidth && sprite.height === nextHeight) return false;
    sprite.width = nextWidth;
    sprite.height = nextHeight;
    sprite.markChanged();
    return true;
  }

  private resizeCoverSprite(roomInterface: ScriptInstance, anchors: ResizeEngineAnchor[]): boolean {
    const cover = this.instanceProp(roomInterface, "pcoverspr");
    if (!(cover instanceof SpriteChannel)) return false;
    const height = Math.max(1, this.toolbarTop());
    if (!this.setSpriteSize(cover, this.viewportWidth, height)) return false;
    anchors.push({ id: "pCoverSpr", kind: "sprite", action: "resize", width: cover.width, height: cover.height });
    return true;
  }

  private resizeDimmerSprite(visualizer: ScriptInstance, anchors: ResizeEngineAnchor[]): boolean {
    const dimmer = this.instanceProp(visualizer, "proomdimmersprite");
    if (!(dimmer instanceof SpriteChannel)) return false;
    const height = Math.max(1, this.toolbarTop());
    if (!this.setSpriteSize(dimmer, this.viewportWidth + 20, height)) return false;
    anchors.push({ id: "pRoomDimmerSprite", kind: "sprite", action: "resize", width: dimmer.width, height: dimmer.height });
    return true;
  }

  private captureWrapperBaselines(visualizer: ScriptInstance, appliedX: number, appliedY: number): Map<string, WrapperStageBaseline> {
    const result = new Map<string, WrapperStageBaseline>();
    const wrappedParts = this.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return result;
    for (let index = 0; index < wrappedParts.values.length; index += 1) {
      const wrapper = wrappedParts.values[index];
      if (!(wrapper instanceof ScriptInstance)) continue;
      const offsets = this.instanceProp(wrapper, "poffsets");
      const sprite = this.instanceProp(wrapper, "psprite");
      const fallbackX = sprite instanceof SpriteChannel ? sprite.locH : 0;
      const fallbackY = sprite instanceof SpriteChannel ? sprite.locV : 0;
      const offsetX = offsets instanceof LingoList ? this.numberValue(offsets.getAt(1), fallbackX) : fallbackX;
      const offsetY = offsets instanceof LingoList ? this.numberValue(offsets.getAt(2), fallbackY) : fallbackY;
      result.set(this.wrapperBaselineKey(wrappedParts, index, wrapper), this.captureWrapperBaseline(wrapper, offsetX, offsetY, appliedX, appliedY));
    }
    return result;
  }

  private captureWrapperBaseline(
    wrapper: ScriptInstance,
    offsetX: number,
    offsetY: number,
    appliedX: number,
    appliedY: number,
  ): WrapperStageBaseline {
    return {
      instance: wrapper,
      offsetX,
      offsetY,
      appliedX: Math.round(appliedX),
      appliedY: Math.round(appliedY),
      parts: this.wrapperPartBaselines(wrapper),
    };
  }

  private wrapperUniformPartShift(
    roomStage: RoomStageState,
    baselineKey: string,
    wrapper: ScriptInstance,
  ): { x: number; y: number } | null {
    const baseline = roomStage.wrappers.get(baselineKey);
    if (!baseline || baseline.instance !== wrapper) return null;
    const parts = this.wrapperPartBaselines(wrapper);
    if (parts.length === 0 || parts.length !== baseline.parts.length) return null;
    let absorbedX: number | null = null;
    let absorbedY: number | null = null;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const base = baseline.parts[partIndex];
      if (!part || !base) return null;
      const dx = Math.round(part.locH - base.locH);
      const dy = Math.round(part.locV - base.locV);
      if (absorbedX === null) absorbedX = dx;
      if (absorbedY === null) absorbedY = dy;
      if (absorbedX !== dx || absorbedY !== dy) return null;
    }
    return { x: Math.round(absorbedX ?? 0), y: Math.round(absorbedY ?? 0) };
  }

  private matchesRoomStageMove(shift: { x: number; y: number }, appliedX: number, appliedY: number): boolean {
    return Math.abs(shift.x - appliedX) <= 1 && Math.abs(shift.y - appliedY) <= 1;
  }

  private spriteAt(sprite: SpriteChannel, x: number, y: number): boolean {
    return Math.round(sprite.locH) === Math.round(x) && Math.round(sprite.locV) === Math.round(y);
  }

  private wrapperPartBaselines(wrapper: ScriptInstance): WrapperPartBaseline[] {
    const partList = this.instanceProp(wrapper, "ppartlist");
    if (!(partList instanceof LingoList)) return [];
    const parts: WrapperPartBaseline[] = [];
    for (const value of partList.items) {
      if (!(value instanceof LingoPropList)) continue;
      parts.push({
        locH: this.numberValue(this.propListLookup(value, "#locH"), 0),
        locV: this.numberValue(this.propListLookup(value, "#locV"), 0),
      });
    }
    return parts;
  }

  private wrapperBaselineKey(wrappedParts: LingoPropList, index: number, wrapper: ScriptInstance): string {
    const key = stringOf(wrappedParts.keys[index] ?? index + 1).trim().toLowerCase();
    const type = this.normalizedSymbol(this.instanceProp(wrapper, "pTypeDef"));
    return `${index}:${key}:${type}`;
  }

  private roomStageEpochKey(visualizer: ScriptInstance, sourceWideOffset: number): string {
    const layout = stringOf(this.instanceProp(visualizer, "pLayout")).trim().toLowerCase();
    return `${layout}|${sourceWideOffset}`;
  }

  private moveInfoStandLooseSprites(
    roomInterface: ScriptInstance | null,
    dx: number,
    dy: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    if (!roomInterface || (dx === 0 && dy === 0)) return false;
    let changed = false;
    for (const prop of ["pinfostandtitlespr", "pinfostandtitlebgspr", "pinfostandtitlepanelspr"]) {
      const sprite = this.instanceProp(roomInterface, prop);
      if (!(sprite instanceof SpriteChannel)) continue;
      this.setSpriteLoc(sprite, sprite.locH + dx, sprite.locV + dy);
      changed = true;
      anchors.push({
        id: prop,
        kind: "sprite",
        action: "infostand-title-follow",
        x: sprite.locH,
        y: sprite.locV,
      });
    }
    return changed;
  }

  private positionInfoStandTitle(roomInterface: ScriptInstance | null, anchors: ResizeEngineAnchor[]): boolean {
    if (!roomInterface || !this.movie.runtime.hasHandler(roomInterface, "positioninfostandtitlesprite")) return false;
    const before = this.infoStandTitleSpritePositions(roomInterface);
    this.movie.runtime.callMethod(roomInterface, "positioninfostandtitlesprite", []);
    const after = this.infoStandTitleSpritePositions(roomInterface);
    let changed = false;
    for (const [prop, position] of after) {
      const previous = before.get(prop);
      if (previous && previous.x === position.x && previous.y === position.y) continue;
      changed = true;
      anchors.push({
        id: prop,
        kind: "sprite",
        action: "infostand-title-source-position",
        x: position.x,
        y: position.y,
      });
    }
    return changed;
  }

  private infoStandTitleSpritePositions(roomInterface: ScriptInstance): Map<string, { x: number; y: number }> {
    const result = new Map<string, { x: number; y: number }>();
    for (const prop of ["pinfostandtitlespr", "pinfostandtitlebgspr", "pinfostandtitlepanelspr"]) {
      const sprite = this.instanceProp(roomInterface, prop);
      if (sprite instanceof SpriteChannel) result.set(prop, { x: sprite.locH, y: sprite.locV });
    }
    return result;
  }

  private anchorBulletinNotifications(manager: ScriptInstance, anchors: ResizeEngineAnchor[]): boolean {
    const notifications = this.instanceProp(manager, "pnotifications");
    if (!(notifications instanceof LingoPropList)) return false;
    const rightMargin = Math.max(0, this.numberProp(manager, "prightmargin", 4));
    let changed = false;
    for (let index = 0; index < notifications.values.length; index += 1) {
      const notification = notifications.values[index];
      if (!(notification instanceof LingoPropList)) continue;
      const sprite = this.propListLookup(notification, "#sprite");
      if (!(sprite instanceof SpriteChannel)) continue;
      const width =
        sprite.width ||
        sprite.member?.image?.width ||
        sprite.member?.bitmap?.width;
      const effectiveWidth = Math.max(1, Math.round(width || 254));
      const targetX = Math.round(this.viewportWidth - effectiveWidth - rightMargin);
      if (!this.setSpriteLoc(sprite, targetX, sprite.locV)) continue;
      changed = true;
      anchors.push({
        id: `bulletin_notification:${String(notifications.keys[index] ?? index + 1)}`,
        kind: "sprite",
        action: "top-right-notification",
        x: sprite.locH,
        y: sprite.locV,
        width: effectiveWidth,
      });
    }
    return changed;
  }

  private anchorStagePresentationVisualizers(
    offsetX: number,
    offsetY: number,
    anchors: ResizeEngineAnchor[],
  ): StagePresentationResult {
    const list = this.objectList();
    if (!list) return { changed: false, offsets: [] };
    let changed = false;
    const offsets: StagePresentationOffset[] = [];
    for (let index = 0; index < list.values.length; index += 1) {
      const visualizer = list.values[index];
      if (!(visualizer instanceof ScriptInstance)) continue;
      if (visualizer.module.scriptName !== "Visualizer Instance Class") continue;
      const id = this.normalizedSymbol(list.keys[index] ?? "");
      if (this.isExplicitlyAnchoredVisualizer(id)) continue;
      if (!this.isPresentationDepth(this.instanceProp(visualizer, "plocz"))) continue;
      const seen = this.rememberFromViewport(`stage_visualizer:${id}`, visualizer, this.movie.manifestStageWidth);
      const targetX = Math.round(seen.locX + offsetX);
      const targetY = Math.round(seen.locY + offsetY);
      const move = this.moveInstanceTo(visualizer, targetX, targetY);
      const currentX = this.numberProp(visualizer, "plocx", move.x);
      const currentY = this.numberProp(visualizer, "plocy", move.y);
      const layout = stringOf(this.instanceProp(visualizer, "playout"));
      offsets.push({
        id,
        x: Math.round(currentX - seen.locX),
        y: Math.round(currentY - seen.locY),
        z: this.numberValue(this.instanceProp(visualizer, "plocz"), 0),
        layout,
      });
      if (!move.moved) continue;
      changed = true;
      anchors.push({
        id,
        kind: "visualizer",
        action: "stage-presentation-follow",
        x: move.x,
        y: move.y,
        note: layout,
      });
    }
    return { changed, offsets };
  }

  private anchorStagePresentationWindows(
    offsetX: number,
    offsetY: number,
    loadingWindows: Set<string>,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const list = this.objectList();
    if (!list) return false;
    let changed = false;
    for (let index = 0; index < list.values.length; index += 1) {
      const window = list.values[index];
      if (!(window instanceof ScriptInstance)) continue;
      if (window.module.scriptName !== "Window Instance Class") continue;
      const id = this.normalizedSymbol(list.keys[index] ?? "");
      if (this.isExplicitlyAnchoredWindow(id)) continue;
      if (loadingWindows.has(id)) continue;
      if (!this.isPresentationDepth(this.instanceProp(window, "plocz"))) continue;
      this.setWideBoundary(window);
      const seen = this.rememberFromViewport(`stage_window:${id}`, window, this.movie.manifestStageWidth);
      const targetX = Math.round(seen.locX + offsetX);
      const targetY = Math.round(seen.locY + offsetY);
      const move = this.moveInstanceTo(window, targetX, targetY);
      if (!move.moved) continue;
      changed = true;
      anchors.push({
        id,
        kind: "window",
        action: "stage-presentation-follow",
        x: move.x,
        y: move.y,
      });
    }
    return changed;
  }

  private anchorFreeStageSprites(
    offsetX: number,
    offsetY: number,
    presentationOffsets: readonly StagePresentationOffset[],
    managedSprites: Set<SpriteChannel>,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const list = this.objectList();
    let changed = false;
    const liveSprites = new Set<number>();
    const stagePresentationActive = presentationOffsets.length > 0;
    const objectOwnedSprites = list ? this.objectReferencedSprites(list) : new Set<SpriteChannel>();
    if (list) {
      for (let index = 0; index < list.values.length; index += 1) {
        const root = list.values[index];
        if (!(root instanceof ScriptInstance)) continue;
        if (root.module.scriptName === "Visualizer Instance Class" || root.module.scriptName === "Window Instance Class") continue;
        const rootId = this.normalizedSymbol(list.keys[index] ?? root.module.scriptName);
        for (const owner of this.instanceChain(root)) {
          if (owner.module.scriptName === "Visualizer Instance Class" || owner.module.scriptName === "Window Instance Class") continue;
          const ownerId = owner === root ? rootId : `${rootId}:${owner.module.scriptName}`;
          for (const ref of this.freeStageSpriteReferences(owner)) {
            const value = ref.sprite;
            const sourceSpritePropsRef = ref.path === "pspriteprops" || ref.path.startsWith("pspriteprops[");
            // Source room-programs fetch these channels from Room_visualizer, then
            // drive them through pSpriteProps. That explicit Source ownership must
            // win over the generic visualizer-managed exclusion.
            if (managedSprites.has(value) && !sourceSpritePropsRef) continue;
            const remembered = this.freeStageSpriteOffsets.get(value.number);
            const previous = remembered?.owner === owner ? remembered : undefined;
            const presentationOffset = this.presentationOffsetForFreeSprite(value, presentationOffsets, previous, offsetX, offsetY);
            const pointerAuthored = !sourceSpritePropsRef && this.isPointerAuthoredFreeSprite(value);
            const appliedX = pointerAuthored ? 0 : sourceSpritePropsRef ? offsetX : (presentationOffset?.x ?? offsetX);
            const appliedY = pointerAuthored ? 0 : sourceSpritePropsRef ? offsetY : (presentationOffset?.y ?? offsetY);
            const source = this.freeStageSpriteSourcePoint(owner, value, previous, appliedX, appliedY, ref.sourcePoint);
            const followsPresentation =
              pointerAuthored ||
              sourceSpritePropsRef ||
              stagePresentationActive ||
              (previous !== undefined && source.hasOwnerPoint);
            if (!sourceSpritePropsRef && !this.isPresentationDepth(value.locZ) && (!followsPresentation || !source.hasOwnerPoint)) continue;
            const sourceX = source.x;
            const sourceY = source.y;
            if (!(sourceSpritePropsRef ? this.isSourceStagePresentationPoint(sourceX, sourceY) : this.isNativeStagePoint(sourceX, sourceY))) {
              continue;
            }
            const targetX = Math.round(sourceX + appliedX);
            const targetY = Math.round(sourceY + appliedY);
            liveSprites.add(value.number);
            this.freeStageSpriteOffsets.set(value.number, {
              owner,
              x: Math.round(appliedX),
              y: Math.round(appliedY),
              lastX: targetX,
              lastY: targetY,
            });
            if (!this.setSpriteLoc(value, targetX, targetY)) continue;
            changed = true;
            anchors.push({
              id: `${ownerId}.${ref.path}`,
              kind: "sprite",
              action: "free-stage-sprite-follow",
              x: targetX,
              y: targetY,
              note: pointerAuthored
                ? `${owner.module.scriptName}; pointer-authored`
                : presentationOffset
                  ? `${owner.module.scriptName}; presentation=${presentationOffset.id}`
                  : owner.module.scriptName,
            });
          }
        }
      }
    }
    if (this.anchorUnownedStageChannels(offsetX, offsetY, presentationOffsets, managedSprites, objectOwnedSprites, liveSprites, anchors)) {
      changed = true;
    }
    for (const spriteNumber of [...this.freeStageSpriteOffsets.keys()]) {
      if (!liveSprites.has(spriteNumber)) this.freeStageSpriteOffsets.delete(spriteNumber);
    }
    return changed;
  }

  private anchorUnownedStageChannels(
    offsetX: number,
    offsetY: number,
    presentationOffsets: readonly StagePresentationOffset[],
    managedSprites: Set<SpriteChannel>,
    objectOwnedSprites: Set<SpriteChannel>,
    liveSprites: Set<number>,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    let changed = false;
    for (const sprite of this.movie.channels) {
      if (sprite.number <= 0) continue;
      if (managedSprites.has(sprite) || objectOwnedSprites.has(sprite) || liveSprites.has(sprite.number)) continue;
      if (!this.isPresentationDepth(sprite.locZ)) continue;
      const remembered = this.freeStageSpriteOffsets.get(sprite.number);
      const previous = remembered?.owner === null ? remembered : undefined;
      const presentationOffset = this.presentationOffsetForFreeSprite(sprite, presentationOffsets, previous, offsetX, offsetY);
      const appliedX = presentationOffset?.x ?? offsetX;
      const appliedY = presentationOffset?.y ?? offsetY;
      const source = this.freeStageChannelSourcePoint(sprite, previous);
      if (!this.isNativeStagePoint(source.x, source.y)) continue;
      const targetX = Math.round(source.x + appliedX);
      const targetY = Math.round(source.y + appliedY);
      liveSprites.add(sprite.number);
      this.freeStageSpriteOffsets.set(sprite.number, {
        owner: null,
        x: Math.round(appliedX),
        y: Math.round(appliedY),
        lastX: targetX,
        lastY: targetY,
      });
      if (!this.setSpriteLoc(sprite, targetX, targetY)) continue;
      changed = true;
      anchors.push({
        id: `channel:${sprite.number}`,
        kind: "sprite",
        action: "free-stage-channel-follow",
        x: targetX,
        y: targetY,
        note: presentationOffset ? `presentation=${presentationOffset.id}` : "unowned stage channel",
      });
    }
    return changed;
  }

  private objectReferencedSprites(list: LingoPropList): Set<SpriteChannel> {
    const result = new Set<SpriteChannel>();
    this.collectObjectGraphSprites(list, result, new Set<object>());
    return result;
  }

  private collectObjectGraphSprites(value: unknown, result: Set<SpriteChannel>, seen: Set<object>): void {
    if (value instanceof SpriteChannel) {
      result.add(value);
      return;
    }
    if (value instanceof ScriptInstance) {
      if (seen.has(value)) return;
      seen.add(value);
      for (const propValue of value.props.values()) this.collectObjectGraphSprites(propValue, result, seen);
      return;
    }
    if (value instanceof LingoList) {
      if (seen.has(value)) return;
      seen.add(value);
      for (const item of value.items) this.collectObjectGraphSprites(item, result, seen);
      return;
    }
    if (value instanceof LingoPropList) {
      if (seen.has(value)) return;
      seen.add(value);
      for (const propValue of value.values) this.collectObjectGraphSprites(propValue, result, seen);
    }
  }

  private freeStageSpriteReferences(owner: ScriptInstance): FreeStageSpriteReference[] {
    const refs: FreeStageSpriteReference[] = [];
    const seenSprites = new Set<number>();
    for (const [prop, value] of owner.props) {
      if (prop === "ancestor") continue;
      if (value instanceof SpriteChannel) {
        if (!seenSprites.has(value.number)) {
          seenSprites.add(value.number);
          refs.push({ sprite: value, path: prop, sourcePoint: null });
        }
        continue;
      }
      // Origins public-room engines keep Source-owned animated/background sprites
      // inside pSpriteProps lists. They are not Visualizer/Window sprites, but
      // Source rewrites their authored stage loc every update tick, so the resize
      // presentation layer must discover them through the same data container.
      if (prop !== "pspriteprops") continue;
      this.collectSpritePropReferences(value, prop, refs, seenSprites, new Set<object>());
    }
    return refs;
  }

  private collectSpritePropReferences(
    value: LingoValue,
    path: string,
    refs: FreeStageSpriteReference[],
    seenSprites: Set<number>,
    seenContainers: Set<object>,
  ): void {
    if (value instanceof LingoList) {
      if (seenContainers.has(value)) return;
      seenContainers.add(value);
      for (let index = 0; index < value.items.length; index += 1) {
        this.collectSpritePropReferences(value.items[index] ?? LINGO_VOID, `${path}[${index + 1}]`, refs, seenSprites, seenContainers);
      }
      return;
    }
    if (!(value instanceof LingoPropList)) return;
    if (seenContainers.has(value)) return;
    seenContainers.add(value);
    const sprite = this.propListLookup(value, "#sprite");
    if (sprite instanceof SpriteChannel) {
      if (!seenSprites.has(sprite.number)) {
        seenSprites.add(sprite.number);
        refs.push({
          sprite,
          path,
          sourcePoint: this.spritePropSourcePoint(value),
        });
      }
      return;
    }
    for (let index = 0; index < value.values.length; index += 1) {
      this.collectSpritePropReferences(
        value.values[index] ?? LINGO_VOID,
        `${path}.${this.normalizedSymbol(value.keys[index] ?? index + 1)}`,
        refs,
        seenSprites,
        seenContainers,
      );
    }
  }

  private spritePropSourcePoint(props: LingoPropList): LingoPoint | null {
    const direct = this.pointFromPropList(props, "#locH", "#locV");
    if (direct) return direct;
    return this.pointFromPropList(props, "#baseLocH", "#baseLocV");
  }

  private pointFromPropList(props: LingoPropList, xKey: string, yKey: string): LingoPoint | null {
    const rawX = this.propListLookup(props, xKey);
    const rawY = this.propListLookup(props, yKey);
    if (rawX instanceof LingoVoid || rawY instanceof LingoVoid) return null;
    const x = this.numberValue(rawX, Number.NaN);
    const y = this.numberValue(rawY, Number.NaN);
    return Number.isFinite(x) && Number.isFinite(y) ? new LingoPoint(x, y) : null;
  }

  private presentationOffsetForFreeSprite(
    sprite: SpriteChannel,
    offsets: readonly StagePresentationOffset[],
    previous: FreeStageSpriteOffset | undefined,
    fallbackOffsetX: number,
    fallbackOffsetY: number,
  ): StagePresentationOffset | null {
    if (offsets.length === 0) {
      return previous && previous.x === Math.round(fallbackOffsetX) && previous.y === Math.round(fallbackOffsetY)
        ? { id: "previous", x: previous.x, y: previous.y, z: 0, layout: "previous-stage-presentation" }
        : null;
    }
    if (offsets.length === 1) return offsets[0] ?? null;
    const spriteZ = Number.isFinite(sprite.locZ) ? Number(sprite.locZ) : 0;
    let best = offsets[0] ?? null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const offset of offsets) {
      const distance = Math.abs(offset.z - spriteZ);
      if (distance < bestDistance) {
        best = offset;
        bestDistance = distance;
      }
    }
    return best;
  }

  private freeStageSpriteSourcePoint(
    owner: ScriptInstance,
    sprite: SpriteChannel,
    previous: FreeStageSpriteOffset | undefined,
    offsetX: number,
    offsetY: number,
    sourcePoint: LingoPoint | null,
  ): { x: number; y: number; hasOwnerPoint: boolean } {
    const ownerPoint = sourcePoint ?? this.stagePointForOwner(owner);
    if (previous && this.isSamePoint(sprite.locH, sprite.locV, previous.lastX, previous.lastY)) {
      const x = sprite.locH - previous.x;
      const y = sprite.locV - previous.y;
      return { x, y, hasOwnerPoint: ownerPoint !== null };
    }

    if (
      ownerPoint &&
      this.isSamePoint(sprite.locH, sprite.locV, ownerPoint.x + offsetX, ownerPoint.y + offsetY)
    ) {
      return { x: ownerPoint.x, y: ownerPoint.y, hasOwnerPoint: true };
    }

    if (this.isNativeStagePoint(sprite.locH, sprite.locV)) {
      return { x: sprite.locH, y: sprite.locV, hasOwnerPoint: ownerPoint !== null };
    }

    if (ownerPoint) return { x: ownerPoint.x, y: ownerPoint.y, hasOwnerPoint: true };
    return { x: sprite.locH, y: sprite.locV, hasOwnerPoint: false };
  }

  private freeStageChannelSourcePoint(sprite: SpriteChannel, previous: FreeStageSpriteOffset | undefined): LingoPoint {
    if (previous) {
      const sourceX = sprite.locH - previous.x;
      const sourceY = sprite.locV - previous.y;
      const nearPreviousTarget = Math.abs(sprite.locH - previous.lastX) <= 96 && Math.abs(sprite.locV - previous.lastY) <= 96;
      if (nearPreviousTarget && this.isNativeStagePoint(sourceX, sourceY)) {
        return new LingoPoint(sourceX, sourceY);
      }
    }
    return new LingoPoint(sprite.locH, sprite.locV);
  }

  private isSamePoint(ax: number, ay: number, bx: number, by: number): boolean {
    return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
  }

  private isPointerAuthoredFreeSprite(sprite: SpriteChannel): boolean {
    return (
      this.isPresentationDepth(sprite.locZ) &&
      this.isSamePoint(sprite.locH, sprite.locV, this.movie.mouseH, this.movie.mouseV)
    );
  }

  private managedPresentationSprites(): Set<SpriteChannel> {
    const result = new Set<SpriteChannel>();
    const list = this.objectList();
    if (!list) return result;
    for (const value of list.values) {
      if (!(value instanceof ScriptInstance)) continue;
      if (value.module.scriptName !== "Visualizer Instance Class" && value.module.scriptName !== "Window Instance Class") continue;
      this.collectSpritesFromValue(this.instanceProp(value, "pspritelist"), result);
      this.collectWrappedPartSprites(this.instanceProp(value, "pwrappedparts"), result);
    }
    this.collectSourceRoomObjectSprites(result);
    return result;
  }

  /**
   * Room Interface.moveroomby defines the authoritative ownership boundary for
   * users and room objects: it moves exactly the channels returned by these
   * four component getters and each object's getSprites handler. Other Source
   * systems may retain borrowed references to those channels (for example the
   * FUSE camera's pTargetSpr); those references must not reclassify a room
   * sprite as a free-stage sprite and apply the presentation offset twice.
   */
  private collectSourceRoomObjectSprites(result: Set<SpriteChannel>): void {
    const direct = this.object("#room_component");
    const interfaceObject = this.object("#room_interface") ?? this.object("room_interface");
    const component = direct instanceof ScriptInstance
      ? direct
      : interfaceObject instanceof ScriptInstance
        ? this.roomComponent(interfaceObject)
        : null;
    if (!component) return;

    for (const getter of ["getuserobject", "getactiveobject", "getitemobject", "getpassiveobject"]) {
      if (!this.movie.runtime.hasHandler(component, getter)) continue;
      let objects: LingoValue;
      try {
        objects = this.movie.runtime.callMethod(component, getter, [LingoSymbol.for("list")]);
      } catch {
        continue;
      }
      const entries = objects instanceof LingoList
        ? objects.items
        : objects instanceof LingoPropList
          ? objects.values
          : [];
      for (const object of entries) {
        if (!(object instanceof ScriptInstance) || !this.movie.runtime.hasHandler(object, "getsprites")) continue;
        try {
          this.collectSpritesFromValue(this.movie.runtime.callMethod(object, "getsprites", []), result);
        } catch {
          // Objects can leave while the presentation pass is collecting the
          // same Source-owned channel set used by moveroomby.
        }
      }
    }
  }

  private collectWrappedPartSprites(value: LingoValue, result: Set<SpriteChannel>): void {
    if (!(value instanceof LingoPropList)) return;
    for (const wrapper of value.values) {
      if (!(wrapper instanceof ScriptInstance)) continue;
      const sprite = this.instanceProp(wrapper, "psprite");
      if (sprite instanceof SpriteChannel) result.add(sprite);
    }
  }

  private collectSpritesFromValue(value: LingoValue, result: Set<SpriteChannel>): void {
    if (value instanceof SpriteChannel) {
      result.add(value);
      return;
    }
    if (value instanceof LingoList) {
      for (const item of value.items) this.collectSpritesFromValue(item, result);
      return;
    }
    if (value instanceof LingoPropList) {
      for (const item of value.values) this.collectSpritesFromValue(item, result);
    }
  }

  private isExplicitlyAnchoredVisualizer(id: string): boolean {
    return id === "room_visualizer" || id === "entry_view" || id === "hand_visualizer";
  }

  private isExplicitlyAnchoredWindow(id: string): boolean {
    return (
      id === "roombarid" ||
      id === "room_bar" ||
      id === "entry_bar" ||
      id === "room_info" ||
      id === "room_info_stand" ||
      id === "room_interface" ||
      id === "habbo_hand_buttons" ||
      id === "login_a" ||
      id === "login_b" ||
      id === "loading room"
    );
  }

  private isPresentationDepth(value: LingoValue): boolean {
    const depth = this.numberValue(value, 0);
    return Math.abs(depth) >= 1_000_000;
  }

  private hasStagePresentationVisualizer(): boolean {
    const list = this.objectList();
    if (!list) return false;
    for (let index = 0; index < list.values.length; index += 1) {
      const value = list.values[index];
      if (!(value instanceof ScriptInstance)) continue;
      if (value.module.scriptName !== "Visualizer Instance Class") continue;
      const id = this.normalizedSymbol(list.keys[index] ?? "");
      if (this.isExplicitlyAnchoredVisualizer(id)) continue;
      if (this.isPresentationDepth(this.instanceProp(value, "plocz"))) return true;
    }
    return false;
  }

  private hasStagePoint(instance: ScriptInstance): boolean {
    return this.stagePointForOwner(instance) !== null;
  }

  private stagePointForOwner(instance: ScriptInstance): LingoPoint | null {
    for (const key of ["pmyloc", "ploc", "pstartloc", "pscreenloc"]) {
      const value = this.instanceProp(instance, key);
      if (value instanceof LingoPoint) return value;
    }
    return null;
  }

  private isNativeStagePoint(x: number, y: number): boolean {
    const margin = 160;
    return (
      x >= -margin &&
      y >= -margin &&
      x <= this.movie.manifestStageWidth + margin &&
      y <= this.movie.manifestStageHeight + margin
    );
  }

  private isSourceStagePresentationPoint(x: number, y: number): boolean {
    const marginX = this.movie.manifestStageWidth;
    const marginY = this.movie.manifestStageHeight;
    return (
      x >= -marginX &&
      y >= -marginY &&
      x <= this.movie.manifestStageWidth * 2 &&
      y <= this.movie.manifestStageHeight * 2
    );
  }

  private rememberEntryAnimationOffsets(offsetX: number, offsetY: number): void {
    const entryInterface = this.object("#entry_interface") ?? this.object("entry_interface");
    if (!entryInterface) return;
    const itemObjects = this.instanceProp(entryInterface, "pitemobjlist");
    if (!(itemObjects instanceof LingoList)) return;
    for (const item of itemObjects.items) {
      if (!(item instanceof ScriptInstance)) continue;
      const sprite = this.instanceProp(item, "psprite");
      if (sprite instanceof SpriteChannel) {
        this.entryAnimationOffsets.set(sprite.number, {
          x: Math.round(offsetX),
          y: Math.round(offsetY),
          lastX: sprite.locH,
          lastY: sprite.locV,
        });
      }
    }
  }

  private anchorEntryAnimationSprites(
    entryInterface: ScriptInstance,
    offsetX: number,
    offsetY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const itemObjects = this.instanceProp(entryInterface, "pitemobjlist");
    if (!(itemObjects instanceof LingoList)) return false;
    let changed = false;
    const liveSprites = new Set<number>();
    for (const item of itemObjects.items) {
      if (!(item instanceof ScriptInstance)) continue;
      const sprite = this.instanceProp(item, "psprite");
      if (!(sprite instanceof SpriteChannel)) continue;
      liveSprites.add(sprite.number);
      const remembered = this.entryAnimationOffsets.get(sprite.number) ?? {
        x: 0,
        y: 0,
        lastX: sprite.locH,
        lastY: sprite.locV,
      };
      const sourceLoc = this.instanceProp(item, "ploc");
      const looksLikeContinuousSourceUpdate =
        remembered.x !== 0 || remembered.y !== 0
          ? Math.abs(sprite.locH - remembered.lastX) <= 96 && Math.abs(sprite.locV - remembered.lastY) <= 96
          : false;
      const baseX =
        sourceLoc instanceof LingoPoint
          ? sourceLoc.x
          : looksLikeContinuousSourceUpdate
            ? sprite.locH - remembered.x
            : sprite.locH;
      const baseY =
        sourceLoc instanceof LingoPoint
          ? sourceLoc.y
          : looksLikeContinuousSourceUpdate
            ? sprite.locV - remembered.y
            : sprite.locV;
      const targetX = Math.round(baseX + offsetX);
      const targetY = Math.round(baseY + offsetY);
      this.entryAnimationOffsets.set(sprite.number, {
        x: Math.round(offsetX),
        y: Math.round(offsetY),
        lastX: targetX,
        lastY: targetY,
      });
      if (!this.setSpriteLoc(sprite, targetX, targetY)) continue;
      changed = true;
      anchors.push({
        id: `entry_animation:${sprite.number}`,
        kind: "sprite",
        action: "animation-stage-center",
        x: targetX,
        y: targetY,
        note: item.module.scriptName,
      });
    }
    for (const spriteNumber of [...this.entryAnimationOffsets.keys()]) {
      if (!liveSprites.has(spriteNumber)) this.entryAnimationOffsets.delete(spriteNumber);
    }
    return changed;
  }

  private instanceProp(instance: ScriptInstance, prop: string): LingoValue {
    let target: ScriptInstance | LingoVoid = instance;
    const key = prop.toLowerCase();
    while (target instanceof ScriptInstance) {
      if (target.props.has(key)) return target.props.get(key) ?? LINGO_VOID;
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : LINGO_VOID;
    }
    return LINGO_VOID;
  }

  private instanceChain(instance: ScriptInstance): ScriptInstance[] {
    const chain: ScriptInstance[] = [];
    const seen = new Set<ScriptInstance>();
    let target: ScriptInstance | null = instance;
    while (target && !seen.has(target)) {
      chain.push(target);
      seen.add(target);
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : null;
    }
    return chain;
  }

  private normalizedSymbol(value: LingoValue): string {
    if (value instanceof LingoSymbol) return value.name.toLowerCase();
    return stringOf(value).replace(/^#/, "").toLowerCase();
  }
}
