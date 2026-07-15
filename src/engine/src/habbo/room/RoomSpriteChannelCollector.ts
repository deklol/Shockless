import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoList, LingoPropList, type LingoValue } from "@director/values";

export interface RoomSpriteChannelCollectorDependencies {
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Recursively resolves Director sprite values without assigning Habbo domain meaning. */
export class RoomSpriteChannelCollector {
  constructor(private readonly dependencies: RoomSpriteChannelCollectorDependencies) {}

  addValue(value: LingoValue | undefined, channels: Set<number>): void {
    if (value instanceof SpriteChannel) {
      if (value.visible !== 0) channels.add(value.number);
      return;
    }
    if (value instanceof LingoList) {
      for (const entry of value.items) this.addValue(entry, channels);
      return;
    }
    if (value instanceof LingoPropList) {
      for (const entry of value.values) this.addValue(entry, channels);
    }
  }

  addObjectBase(object: LingoValue | undefined, channels: Set<number>): void {
    if (!(object instanceof ScriptInstance)) return;
    this.addValue(this.dependencies.instancePropValue(object, "psprlist"), channels);
    this.addValue(this.dependencies.instancePropValue(object, "psprite"), channels);
  }

  addObjectListBase(value: LingoValue | undefined, channels: Set<number>): void {
    for (const object of this.objectEntries(value)) this.addObjectBase(object, channels);
  }

  objectEntries(value: LingoValue | undefined): readonly LingoValue[] {
    if (value instanceof LingoPropList) return value.values;
    if (value instanceof LingoList) return value.items;
    return [];
  }
}
