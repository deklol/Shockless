import type { DirectorMovie } from "@director/Movie";
import { stringOf } from "@director/ops";
import { ScriptInstance } from "@director/Runtime";
import { LingoPropList, type LingoValue } from "@director/values";
import { FloorRoomPresentation } from "./floor/FloorRoomPresentation";
import { LandscapeRoomPresentation } from "./landscape/LandscapeRoomPresentation";
import type { RoomSpriteChannelCollector } from "./RoomSpriteChannelCollector";
import { WallRoomPresentation } from "./wall/WallRoomPresentation";

interface RoomLayerPresentationDependencies {
  readonly movie: DirectorMovie;
  readonly collector: RoomSpriteChannelCollector;
  readonly objectById: (id: string) => LingoValue;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Resolves room visualizer, wrapped room-part, landscape, and animated backdrop channels. */
export class RoomLayerPresentation {
  private readonly floor: FloorRoomPresentation;
  private readonly walls: WallRoomPresentation;
  private readonly landscape: LandscapeRoomPresentation;

  constructor(private readonly dependencies: RoomLayerPresentationDependencies) {
    this.floor = new FloorRoomPresentation(dependencies);
    this.walls = new WallRoomPresentation(dependencies);
    this.landscape = new LandscapeRoomPresentation(dependencies);
  }

  collect(channels: Set<number>): void {
    const { collector, objectById, instancePropValue } = this.dependencies;
    const visualizer = objectById("Room_visualizer");
    if (visualizer instanceof ScriptInstance) {
      collector.addValue(instancePropValue(visualizer, "pspritelist"), channels);
      collector.addValue(instancePropValue(visualizer, "pactsprlist"), channels);
      const wrappedParts = instancePropValue(visualizer, "pwrappedparts");
      if (wrappedParts instanceof LingoPropList) {
        for (const wrapper of wrappedParts.values) {
          if (!(wrapper instanceof ScriptInstance)) continue;
          const typeDef = stringOf(instancePropValue(wrapper, "ptypedef") ?? "").replace(/^#/, "").toLowerCase();
          if (this.floor.collectWrapper(wrapper, typeDef, channels)) continue;
          if (this.walls.collectWrapper(wrapper, typeDef, channels)) continue;
          collector.addValue(instancePropValue(wrapper, "psprite"), channels);
        }
      }
    }
    this.landscape.collect(visualizer instanceof ScriptInstance ? visualizer : null, channels);
  }
}
