import type { DirectorMovie } from "@director/Movie";
import { truthy as lingoTruthy } from "@director/ops";
import { ScriptInstance } from "@director/Runtime";
import {
  LINGO_VOID,
  LingoList,
  LingoPropList,
  type LingoValue,
} from "@director/values";

export interface RoomReadySummary {
  readonly ready: boolean;
  readonly route: string;
  readonly hasRoomVisualizer: boolean;
  readonly hasRoomInterface: boolean;
  readonly hasRoomComponent: boolean;
  readonly hasRoomContainer: boolean;
  readonly hasRoomGeometry: boolean;
  readonly hasRoomClasses: boolean;
  readonly roomComponentActive: boolean;
  readonly roomComponentCastLoaded: boolean;
  readonly roomComponentConnectionRequested: boolean;
  readonly roomComponentSavedDataCount: number;
  readonly roomComponentUserCount: number;
  readonly roomComponentActiveObjectCount: number;
  readonly roomComponentPassiveObjectCount: number;
  readonly roomComponentItemObjectCount: number;
  readonly roomComponentDataReady: boolean;
  readonly roomId: unknown;
  readonly roomReportId: unknown;
  readonly roomType: unknown;
  readonly roomLikeSpriteCount: number;
}

interface RoomReadinessControllerOptions {
  readonly movie: DirectorMovie;
  readonly objectExists: (id: string) => boolean;
  readonly objectManagerList: (gcore: LingoValue) => LingoPropList | null;
  readonly propListLookup: (list: LingoPropList, key: string) => LingoValue;
  readonly propListValue: (list: LingoPropList, key: string) => LingoValue;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  readonly debugValue: (value: LingoValue | undefined) => unknown;
  readonly tickSerial: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}

/** Source-state room readiness shared by room entry, presentation, and diagnostics. */
export class RoomReadinessController {
  private cache: { serial: number; value: RoomReadySummary } | null = null;

  constructor(private readonly options: RoomReadinessControllerOptions) {}

  invalidate(): void {
    this.cache = null;
  }

  summary(): RoomReadySummary {
    const serial = this.options.tickSerial();
    if (this.cache?.serial === serial) return this.cache.value;
    const value = this.computeSummary();
    this.cache = { serial, value };
    return value;
  }

  async wait(timeoutMs = 10000): Promise<RoomReadySummary> {
    const deadline = performance.now() + Math.max(1, Number(timeoutMs) || 10000);
    let state = this.summary();
    while (!state.ready && performance.now() < deadline) {
      await this.options.delay(100);
      state = this.summary();
    }
    return state;
  }

  private computeSummary(): RoomReadySummary {
    const { movie } = this.options;
    const objectList = this.options.objectManagerList(movie.runtime.getGlobal("gcore"));
    const hasRoomVisualizer = this.options.objectExists("Room_visualizer");
    const hasRoomInterface = this.options.objectExists("#room_interface");
    const hasRoomComponent = this.options.objectExists("#room_component");
    const hasRoomContainer = this.options.objectExists("Room_container");
    const hasRoomGeometry = this.options.objectExists("Room_geometry");
    const hasRoomClasses = this.options.objectExists("Room Classes");
    const roomComponentObject = objectList ? this.options.propListLookup(objectList, "#room_component") : LINGO_VOID;
    const prop = (name: string): LingoValue | undefined =>
      roomComponentObject instanceof ScriptInstance ? this.options.instancePropValue(roomComponentObject, name) : undefined;
    const roomComponentActive = roomComponentObject instanceof ScriptInstance ? lingoTruthy(prop("pactiveflag") ?? 0) : false;
    const roomComponentCastLoaded = roomComponentObject instanceof ScriptInstance ? lingoTruthy(prop("pcastloaded") ?? 0) : false;
    const roomComponentConnectionRequested =
      roomComponentObject instanceof ScriptInstance ? lingoTruthy(prop("proomconnectionrequested") ?? 0) : false;
    const roomId = roomComponentObject instanceof ScriptInstance ? this.options.debugValue(prop("proomid")) : null;
    const roomReportId = roomComponentObject instanceof ScriptInstance ? this.options.debugValue(prop("preportroomid")) : null;
    const savedData = prop("psavedata") ?? LINGO_VOID;
    const countList = (value: LingoValue | undefined): number =>
      value instanceof LingoList || value instanceof LingoPropList ? value.count() : 0;
    const roomComponentSavedDataCount = savedData instanceof LingoPropList ? savedData.count() : 0;
    const roomComponentUserCount = countList(prop("puserobjlist"));
    const roomComponentActiveObjectCount = countList(prop("pactiveobjlist"));
    const roomComponentPassiveObjectCount = countList(prop("ppassiveobjlist"));
    const roomComponentItemObjectCount = countList(prop("pitemobjlist"));
    const roomComponentDataReady =
      roomComponentSavedDataCount > 0 &&
      (roomComponentUserCount > 0 ||
        roomComponentActiveObjectCount > 0 ||
        roomComponentPassiveObjectCount > 0 ||
        roomComponentItemObjectCount > 0);
    const roomType = savedData instanceof LingoPropList ? this.options.debugValue(this.options.propListValue(savedData, "type")) : null;
    const roomLikeSpriteCount = movie.channels.filter((channel) => {
      if (channel.puppet !== 1 || !channel.member || channel.visible === 0) return false;
      const member = channel.member.name.toLowerCase();
      const id = String(this.options.debugValue(channel.id)).toLowerCase();
      return (
        id.includes("room") ||
        id.includes("obj") ||
        id.includes("user") ||
        member.includes("floor") ||
        member.includes("wall") ||
        member.includes("tile") ||
        member.includes("chair") ||
        member.includes("sofa")
      );
    }).length;
    const classicReady = hasRoomVisualizer || roomComponentActive;
    const componentDataReady = hasRoomComponent && roomComponentDataReady;
    const profileReady =
      hasRoomInterface && hasRoomComponent && hasRoomClasses && (hasRoomContainer || hasRoomGeometry) && roomLikeSpriteCount > 0;
    const ready = classicReady || componentDataReady || profileReady;
    const route = roomComponentActive
      ? "Room Component.pActiveFlag"
      : componentDataReady
        ? "Room Component.data"
        : classicReady
          ? "Room_visualizer"
          : profileReady
            ? "room interface/container"
            : "pending";

    return {
      ready,
      route,
      hasRoomVisualizer,
      hasRoomInterface,
      hasRoomComponent,
      hasRoomContainer,
      hasRoomGeometry,
      hasRoomClasses,
      roomComponentActive,
      roomComponentCastLoaded,
      roomComponentConnectionRequested,
      roomComponentSavedDataCount,
      roomComponentUserCount,
      roomComponentActiveObjectCount,
      roomComponentPassiveObjectCount,
      roomComponentItemObjectCount,
      roomComponentDataReady,
      roomId,
      roomReportId,
      roomType,
      roomLikeSpriteCount,
    };
  }
}
