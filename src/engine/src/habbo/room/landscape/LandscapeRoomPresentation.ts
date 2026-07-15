import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../RoomSpriteChannelCollector";

interface LandscapeRoomPresentationDependencies {
  readonly movie: DirectorMovie;
  readonly collector: RoomSpriteChannelCollector;
  readonly objectById: (id: string) => LingoValue;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
}

/** Collects source-owned window landscape, sky, and animated cloud channels. */
export class LandscapeRoomPresentation {
  constructor(private readonly dependencies: LandscapeRoomPresentationDependencies) {}

  collect(visualizer: ScriptInstance | null, channels: Set<number>): void {
    const { movie, collector, objectById, instancePropValue } = this.dependencies;
    if (visualizer && movie.runtime.hasHandler(visualizer, "getsprbyid")) {
      collector.addValue(movie.runtime.callMethod(visualizer, "getsprbyid", ["landscape"]), channels);
    }
    const animation = objectById("landscape_animation_manager");
    if (animation instanceof ScriptInstance) collector.addValue(instancePropValue(animation, "psprite"), channels);
  }
}
