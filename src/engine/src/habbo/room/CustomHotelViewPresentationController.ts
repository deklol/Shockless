import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LINGO_VOID, LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";
import { truthy as lingoTruthy } from "@director/ops";
import {
  CUSTOM_HOTEL_VIEW_ASSETS,
  customHotelViewBannerUrl,
  customHotelViewLayout,
  customHotelViewUsesLargeStage,
} from "../customHotelView";
import type { CustomHotelViewPresentation, StageRenderer } from "../../render/StageRenderer";

interface HotelViewRoomState {
  readonly ready?: boolean;
  readonly hasRoomVisualizer?: boolean;
  readonly roomComponentActive?: boolean;
  readonly roomId?: unknown;
}

interface HotelViewEntryState {
  readonly state: unknown;
  readonly entryBarObject: boolean;
  readonly entryVisualizerObject: boolean;
  readonly [key: string]: unknown;
}

export interface CustomHotelViewPresentationDependencies {
  enabled: boolean;
  resizablePresentation: boolean;
  movie: DirectorMovie;
  renderer: StageRenderer;
  objectById: (id: string) => LingoValue;
  instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  roomState: () => HotelViewRoomState;
  entryState: () => HotelViewEntryState;
  entryStateActive: (entry: HotelViewEntryState) => boolean;
  sourceWindowManager: () => ScriptInstance | null;
  sourceWindowById: (manager: ScriptInstance, id: LingoValue) => ScriptInstance | null;
  sourceWindowContainsPoint: (x: number, y: number) => boolean;
  stageViewportSize: () => { width: number; height: number };
  syncPresentationUnderlays: () => void;
}

/** Owns the optional custom hotel-view presentation and its drag state. */
export class CustomHotelViewPresentationController {
  private drag: { pointerId: number; lastX: number; lastY: number } | null = null;
  private manualOffsetX = 0;
  private manualOffsetY = 0;
  private wasActive = false;
  private activatedAt = performance.now();

  constructor(private readonly dependencies: CustomHotelViewPresentationDependencies) {}

  isActive(): boolean {
    const { enabled, roomState, sourceWindowManager, entryState, entryStateActive } = this.dependencies;
    if (!enabled) return false;
    const room = roomState();
    if (room.ready || room.hasRoomVisualizer || room.roomComponentActive) return false;
    if (room.roomId !== null && room.roomId !== undefined && room.roomId !== "" && room.roomId !== 0) return false;
    const manager = sourceWindowManager();
    const entry = entryState();
    if (!entryStateActive(entry) || !entry.entryVisualizerObject || !manager) return false;
    return (
      this.visibleWindow(manager, LingoSymbol.for("login_a")) ||
      this.visibleWindow(manager, LingoSymbol.for("login_b")) ||
      this.visibleWindow(manager, "entry_bar")
    );
  }

  presentation(): CustomHotelViewPresentation | null {
    if (!this.isActive()) return null;
    const size = this.dependencies.stageViewportSize();
    const useLargeStage = this.usesLargeStage(size);
    const layout = customHotelViewLayout({
      viewportWidth: size.width,
      viewportHeight: size.height,
      manualOffsetX: this.manualOffsetX,
      manualOffsetY: this.manualOffsetY,
      useLargeStage,
      elapsedMs: performance.now() - this.activatedAt,
    });
    return {
      active: true,
      backgroundUrl: CUSTOM_HOTEL_VIEW_ASSETS.backgroundUrl,
      stageUrl: useLargeStage ? CUSTOM_HOTEL_VIEW_ASSETS.stageLargeUrl : CUSTOM_HOTEL_VIEW_ASSETS.stageSmallUrl,
      bannerUrl: customHotelViewBannerUrl(useLargeStage),
      ...layout,
    };
  }

  sync(): CustomHotelViewPresentation | null {
    const active = this.isActive();
    if (active && !this.wasActive) {
      this.manualOffsetX = 0;
      this.manualOffsetY = 0;
      this.activatedAt = performance.now();
    }
    if (active !== this.wasActive) this.dependencies.syncPresentationUnderlays();
    this.wasActive = active;
    if (!active) {
      this.dependencies.renderer.setCustomHotelView(null);
      this.dependencies.renderer.setSuppressedChannels(new Set());
      return null;
    }
    const presentation = this.presentation();
    this.dependencies.renderer.setCustomHotelView(presentation);
    this.dependencies.renderer.setSuppressedChannels(this.suppressedChannels());
    return presentation;
  }

  canDragAt(x: number, y: number): boolean {
    if (!this.isActive() || this.dependencies.sourceWindowContainsPoint(x, y)) return false;
    const size = this.dependencies.stageViewportSize();
    return y >= 0 && y < Math.max(0, size.height - 54);
  }

  beginDrag(pointerId: number, x: number, y: number): void {
    this.drag = { pointerId, lastX: x, lastY: y };
  }

  updateDrag(pointerId: number, x: number, y: number): boolean {
    if (!this.drag || this.drag.pointerId !== pointerId) return false;
    this.manualOffsetX += x - this.drag.lastX;
    this.manualOffsetY += y - this.drag.lastY;
    this.drag = { pointerId, lastX: x, lastY: y };
    this.sync();
    return true;
  }

  endDrag(pointerId: number): boolean {
    if (!this.drag || this.drag.pointerId !== pointerId) return false;
    this.drag = null;
    return true;
  }

  diagnostics(): Record<string, unknown> {
    const presentation = this.presentation();
    const suppressed = this.isActive() ? [...this.suppressedChannels()].sort((left, right) => left - right) : [];
    const size = this.dependencies.stageViewportSize();
    return {
      enabled: this.dependencies.enabled,
      active: this.isActive(),
      manualOffset: [this.manualOffsetX, this.manualOffsetY],
      presentation,
      useLargeStage: this.usesLargeStage(size),
      suppressedChannels: suppressed,
      assetRoutes: CUSTOM_HOTEL_VIEW_ASSETS,
    };
  }

  private usesLargeStage(size: { width: number; height: number }): boolean {
    return customHotelViewUsesLargeStage({
      viewportWidth: size.width,
      viewportHeight: size.height,
      screenWidth: window.screen?.availWidth || window.screen?.width,
      screenHeight: window.screen?.availHeight || window.screen?.height,
      resizable: this.dependencies.resizablePresentation,
    });
  }

  private visibleWindow(manager: ScriptInstance, id: LingoValue): boolean {
    const windowObject = this.dependencies.sourceWindowById(manager, id);
    if (!windowObject) return false;
    try {
      const visible = this.dependencies.movie.runtime.callMethod(windowObject, "getproperty", [LingoSymbol.for("visible")]);
      if (!(visible instanceof LingoVoid)) return lingoTruthy(visible);
    } catch {
      // A wrapper can expose pVisible before its getProperty handler is ready.
    }
    const propVisible = this.dependencies.instancePropValue(windowObject, "pvisible");
    return propVisible === undefined || propVisible instanceof LingoVoid ? true : lingoTruthy(propVisible);
  }

  private suppressedChannels(): Set<number> {
    const channels = new Set<number>();
    const entryView = this.dependencies.objectById("entry_view");
    if (!(entryView instanceof ScriptInstance)) return channels;
    const addEntrySprite = (value: LingoValue): void => {
      if (value instanceof SpriteChannel) {
        channels.add(value.number);
      } else if (value instanceof LingoList) {
        for (const item of value.items) addEntrySprite(item);
      } else if (value instanceof LingoPropList) {
        for (const item of value.values) addEntrySprite(item);
      }
    };
    addEntrySprite(this.dependencies.instancePropValue(entryView, "pspritelist") ?? LINGO_VOID);
    return channels;
  }
}
