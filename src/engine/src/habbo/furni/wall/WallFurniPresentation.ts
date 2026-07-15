import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../../room/RoomSpriteChannelCollector";
import type { ShadowPresentation } from "../shadow/ShadowPresentation";

interface WallFurniPresentationDependencies {
  readonly collector: RoomSpriteChannelCollector;
  readonly shadows: ShadowPresentation;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Resolves wall-furni channels from Director's room item object list. */
export class WallFurniPresentation {
  constructor(private readonly dependencies: WallFurniPresentationDependencies) {}

  collect(roomComponent: ScriptInstance, channels: Set<number>): void {
    const objects = this.dependencies.instancePropValue(roomComponent, "pitemobjlist");
    this.dependencies.collector.addObjectListBase(objects, channels);
    this.dependencies.shadows.addObjectList(objects, channels);
  }
}
