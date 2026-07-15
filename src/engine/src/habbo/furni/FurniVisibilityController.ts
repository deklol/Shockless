import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import { FloorFurniPresentation } from "./floor/FloorFurniPresentation";
import { ShadowPresentation } from "./shadow/ShadowPresentation";
import { WallFurniPresentation } from "./wall/WallFurniPresentation";
import { RoomSpriteChannelCollector } from "../room/RoomSpriteChannelCollector";

interface FurniVisibilityControllerDependencies {
  readonly objectById: (id: string) => LingoValue;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Owns the user-selected visibility state for floor and wall furni. */
export class FurniVisibilityController {
  private hidden = false;
  private readonly floorFurni: FloorFurniPresentation;
  private readonly wallFurni: WallFurniPresentation;

  constructor(dependencies: FurniVisibilityControllerDependencies) {
    const collector = new RoomSpriteChannelCollector(dependencies);
    const shadows = new ShadowPresentation({ collector, instancePropValue: dependencies.instancePropValue });
    this.floorFurni = new FloorFurniPresentation({ collector, shadows, instancePropValue: dependencies.instancePropValue });
    this.wallFurni = new WallFurniPresentation({ collector, shadows, instancePropValue: dependencies.instancePropValue });
    this.objectById = dependencies.objectById;
  }

  private readonly objectById: (id: string) => LingoValue;

  setHidden(value: boolean): boolean {
    this.hidden = Boolean(value);
    return this.hidden;
  }

  collectHiddenChannels(channels: Set<number>): void {
    if (!this.hidden) return;
    const roomComponent = this.objectById("#room_component");
    if (!(roomComponent instanceof ScriptInstance)) return;
    this.floorFurni.collect(roomComponent, channels);
    this.wallFurni.collect(roomComponent, channels);
  }
}
