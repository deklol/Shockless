import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoPropList, LingoVoid, type LingoValue } from "@director/values";
import type { RoomStagePresentation, StageRenderer } from "../../render/StageRenderer";
import { FloorFurniPresentation } from "../furni/floor/FloorFurniPresentation";
import { ShadowPresentation } from "../furni/shadow/ShadowPresentation";
import { WallFurniPresentation } from "../furni/wall/WallFurniPresentation";
import { AvatarPresentation } from "../user/AvatarPresentation";
import { RoomLayerPresentation } from "./RoomLayerPresentation";
import { RoomSpriteChannelCollector } from "./RoomSpriteChannelCollector";

const ROOM_PRESENTATION_TOOLBAR_HEIGHT = 54;

export interface RoomStagePresentationControllerDependencies {
  movie: DirectorMovie;
  renderer: StageRenderer;
  objectById: (id: string) => LingoValue;
  objectManagerList: (gCore: LingoValue) => LingoPropList | null;
  propListLookup: (list: LingoPropList, key: string) => LingoValue;
  instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  debugValue: (value: LingoValue | undefined) => unknown;
  valueToNumber: (value: LingoValue | undefined, fallback?: number) => number;
  roomReady: () => boolean;
  stageViewportSize: () => { width: number; height: number };
  sourceWindowContainsPoint: (x: number, y: number) => boolean;
  markPresentationsDirty: () => void;
}

/**
 * Owns the presentation-only transform applied to a ready private room.
 * Director remains authoritative for room geometry and sprite placement.
 */
export class RoomStagePresentationController {
  private zoom: 1 | 2 = 1;
  private cachedPresentation: RoomStagePresentation | null = null;
  private readonly collector: RoomSpriteChannelCollector;
  private readonly shadows: ShadowPresentation;
  private readonly floorFurni: FloorFurniPresentation;
  private readonly wallFurni: WallFurniPresentation;
  private readonly avatars: AvatarPresentation;
  private readonly roomLayers: RoomLayerPresentation;

  constructor(private readonly dependencies: RoomStagePresentationControllerDependencies) {
    this.collector = new RoomSpriteChannelCollector(dependencies);
    this.shadows = new ShadowPresentation({ collector: this.collector, instancePropValue: dependencies.instancePropValue });
    this.floorFurni = new FloorFurniPresentation({
      collector: this.collector,
      shadows: this.shadows,
      instancePropValue: dependencies.instancePropValue,
    });
    this.wallFurni = new WallFurniPresentation({
      collector: this.collector,
      shadows: this.shadows,
      instancePropValue: dependencies.instancePropValue,
    });
    this.avatars = new AvatarPresentation({
      movie: dependencies.movie,
      collector: this.collector,
      shadows: this.shadows,
      instancePropValue: dependencies.instancePropValue,
      toolbarTop: () => this.toolbarTop(),
    });
    this.roomLayers = new RoomLayerPresentation({
      movie: dependencies.movie,
      collector: this.collector,
      objectById: dependencies.objectById,
      instancePropValue: dependencies.instancePropValue,
    });
  }

  currentPrivateRoomFlatId(): string | null {
    const { movie, objectManagerList, propListLookup, debugValue } = this.dependencies;
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    const roomComponent = propListLookup(objectList, "#room_component");
    if (roomComponent instanceof ScriptInstance && movie.runtime.hasHandler(roomComponent, "getprivateroomflatid")) {
      const flatId = movie.runtime.callMethod(roomComponent, "getprivateroomflatid", []);
      if (flatId instanceof LingoVoid) return null;
      const text = typeof flatId === "string" ? flatId : String(debugValue(flatId));
      return text.length > 0 ? text : null;
    }
    return null;
  }

  activePrivateRoomEntryFlatId(): string | null {
    const { movie, objectManagerList, propListLookup, instancePropValue, debugValue } = this.dependencies;
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    if (!objectList) return null;
    const roomComponent = propListLookup(objectList, "#room_component");
    if (!(roomComponent instanceof ScriptInstance)) return null;
    const roomId = String(debugValue(instancePropValue(roomComponent, "proomid")) ?? "");
    if (roomId !== "private") return null;
    const reportRoomId = this.normalizeFlatIdText(debugValue(instancePropValue(roomComponent, "preportroomid")));
    return reportRoomId ?? this.currentPrivateRoomFlatId();
  }

  currentPresentation(): RoomStagePresentation | null {
    if (this.zoom !== 2 || !this.canZoom()) return null;
    const channels = this.presentationChannels();
    if (channels.size === 0) return null;
    const origin = this.presentationOrigin(channels);
    return { scale: 2, originX: origin.x, originY: origin.y, channels };
  }

  refreshCachedPresentation(): RoomStagePresentation | null {
    this.cachedPresentation = this.currentPresentation();
    return this.cachedPresentation;
  }

  presentation(): RoomStagePresentation | null {
    return this.cachedPresentation;
  }

  sourcePoint(point: { x: number; y: number }): { x: number; y: number } {
    const presentation = this.cachedPresentation ?? this.currentPresentation();
    if (!presentation || point.y >= this.toolbarTop()) return point;
    if (this.dependencies.sourceWindowContainsPoint(point.x, point.y)) return point;
    return {
      x: presentation.originX + (point.x - presentation.originX) / presentation.scale,
      y: presentation.originY + (point.y - presentation.originY) / presentation.scale,
    };
  }

  dragDeltaScale(): number {
    return this.cachedPresentation?.scale ?? this.currentPresentation()?.scale ?? 1;
  }

  setZoom(scale: number): Record<string, unknown> {
    this.zoom = Number(scale) >= 2 ? 2 : 1;
    this.dependencies.markPresentationsDirty();
    this.refreshCachedPresentation();
    this.dependencies.renderer.setRoomStagePresentation(this.cachedPresentation);
    this.dependencies.renderer.markDirty();
    return this.diagnostics();
  }

  diagnostics(): Record<string, unknown> {
    const presentation = this.cachedPresentation ?? this.currentPresentation();
    return {
      ok: true,
      scale: this.zoom,
      active: Boolean(presentation),
      canZoom: this.canZoom(),
      privateRoomFlatId: this.currentPrivateRoomFlatId(),
      toolbarTop: this.toolbarTop(),
      channelCount: presentation?.channels.size ?? 0,
      origin: presentation ? [presentation.originX, presentation.originY] : null,
    };
  }

  private normalizeFlatIdText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    if (text.length === 0 || text === "0" || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") return null;
    return text.startsWith("f_") ? text.slice(2) : text;
  }

  toolbarTop(): number {
    return Math.max(0, this.dependencies.stageViewportSize().height - ROOM_PRESENTATION_TOOLBAR_HEIGHT - 1);
  }

  private spriteChannelByNumber(number: number): SpriteChannel | null {
    const { movie } = this.dependencies;
    const direct = movie.channels[number];
    if (direct instanceof SpriteChannel && direct.number === number) return direct;
    return movie.channels.find((channel) => channel.number === number) ?? null;
  }

  private presentationChannels(): Set<number> {
    const { objectById } = this.dependencies;
    const channels = new Set<number>();
    this.roomLayers.collect(channels);
    const roomComponent = objectById("#room_component");
    if (roomComponent instanceof ScriptInstance) {
      this.floorFurni.collect(roomComponent, channels);
      this.wallFurni.collect(roomComponent, channels);
      this.avatars.collect(roomComponent, channels);
    } else {
      this.avatars.addFallbackChannels(channels);
    }
    return channels;
  }

  private presentationOrigin(channels: ReadonlySet<number>): { x: number; y: number } {
    const { movie, objectById, instancePropValue, valueToNumber } = this.dependencies;
    const visualizer = objectById("Room_visualizer");
    if (visualizer instanceof ScriptInstance) {
      const x = valueToNumber(instancePropValue(visualizer, "plocx"), Number.NaN);
      const y = valueToNumber(instancePropValue(visualizer, "plocy"), Number.NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    for (const channelNumber of channels) {
      const rect = movie.spriteBounds(channelNumber);
      const channel = this.spriteChannelByNumber(channelNumber);
      if (rect) {
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
      } else if (channel) {
        left = Math.min(left, channel.locH);
        top = Math.min(top, channel.locV);
      }
    }
    return {
      x: Number.isFinite(left) ? left : 0,
      y: Number.isFinite(top) ? top : 0,
    };
  }

  private canZoom(): boolean {
    return Boolean(this.currentPrivateRoomFlatId()) && this.dependencies.roomReady();
  }
}
