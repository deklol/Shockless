import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../RoomSpriteChannelCollector";

interface WallRoomPresentationDependencies {
  readonly collector: RoomSpriteChannelCollector;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Collects Director's left and right private-room wall wrapper channels. */
export class WallRoomPresentation {
  constructor(private readonly dependencies: WallRoomPresentationDependencies) {}

  collectWrapper(wrapper: ScriptInstance, typeDef: string, channels: Set<number>): boolean {
    if (typeDef !== "wallleft" && typeDef !== "wallright") return false;
    this.dependencies.collector.addValue(this.dependencies.instancePropValue(wrapper, "psprite"), channels);
    return true;
  }
}
