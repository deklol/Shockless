import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../../room/RoomSpriteChannelCollector";

interface ShadowPresentationDependencies {
  readonly collector: RoomSpriteChannelCollector;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Collects Director matte and shadow channels owned by room users or furni. */
export class ShadowPresentation {
  constructor(private readonly dependencies: ShadowPresentationDependencies) {}

  addObject(object: LingoValue | undefined, channels: Set<number>): void {
    if (!(object instanceof ScriptInstance)) return;
    this.dependencies.collector.addValue(this.dependencies.instancePropValue(object, "pmattespr"), channels);
    this.dependencies.collector.addValue(this.dependencies.instancePropValue(object, "pshadowspr"), channels);
  }

  addObjectList(value: LingoValue | undefined, channels: Set<number>): void {
    for (const object of this.dependencies.collector.objectEntries(value)) this.addObject(object, channels);
  }
}
