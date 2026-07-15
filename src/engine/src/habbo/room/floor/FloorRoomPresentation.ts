import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../RoomSpriteChannelCollector";

interface FloorRoomPresentationDependencies {
  readonly collector: RoomSpriteChannelCollector;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Collects the Director wrapper that renders private-room floor parts and paint. */
export class FloorRoomPresentation {
  constructor(private readonly dependencies: FloorRoomPresentationDependencies) {}

  collectWrapper(wrapper: ScriptInstance, typeDef: string, channels: Set<number>): boolean {
    if (typeDef !== "floor") return false;
    this.dependencies.collector.addValue(this.dependencies.instancePropValue(wrapper, "psprite"), channels);
    return true;
  }
}
