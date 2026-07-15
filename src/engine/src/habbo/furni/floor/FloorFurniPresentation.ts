import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../../room/RoomSpriteChannelCollector";
import type { ShadowPresentation } from "../shadow/ShadowPresentation";

interface FloorFurniPresentationDependencies {
  readonly collector: RoomSpriteChannelCollector;
  readonly shadows: ShadowPresentation;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Resolves floor-furni channels from Director's active and passive object lists. */
export class FloorFurniPresentation {
  constructor(private readonly dependencies: FloorFurniPresentationDependencies) {}

  collect(roomComponent: ScriptInstance, channels: Set<number>): void {
    for (const propertyName of ["pactiveobjlist", "ppassiveobjlist"]) {
      const objects = this.dependencies.instancePropValue(roomComponent, propertyName);
      this.dependencies.collector.addObjectListBase(objects, channels);
      this.dependencies.shadows.addObjectList(objects, channels);
    }
  }
}
