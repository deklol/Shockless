import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoList, LingoPropList } from "@director/values";
import { FloorResizePresentation } from "./floor/FloorResizePresentation";
import { ShadowResizePresentation } from "./shadow/ShadowResizePresentation";
import type { ResizeEngineAnchor } from "../ResizeEngineTypes";
import type { RoomResizePresentationContext } from "./RoomResizePresentationContext";

/** Dispatches wrapped room surfaces to their domain-specific positioning policy. */
export class RoomWrapperResizePresentation {
  private readonly floor: FloorResizePresentation;
  private readonly shadows: ShadowResizePresentation;

  constructor(private readonly context: RoomResizePresentationContext) {
    this.floor = new FloorResizePresentation(context);
    this.shadows = new ShadowResizePresentation(context);
  }

  captureShadowBaselines(visualizer: ScriptInstance, appliedX: number, appliedY: number): void {
    const wrappedParts = this.context.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return;
    for (const wrapper of wrappedParts.values) {
      if (!(wrapper instanceof ScriptInstance)) continue;
      const typeDef = this.context.normalizedSymbol(this.context.instanceProp(wrapper, "ptypedef"));
      const sprite = this.context.instanceProp(wrapper, "psprite");
      if (!(sprite instanceof SpriteChannel)) continue;
      const image = this.context.spriteMemberImage(sprite);
      if (!this.shadows.isShadowWrapper(typeDef, image)) continue;
      this.shadows.captureBaseline(wrapper, image, appliedX, appliedY);
    }
  }

  renderShadowsAtLogicalCoordinates(visualizer: ScriptInstance, appliedX: number, appliedY: number): void {
    const wrappedParts = this.context.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return;
    for (const wrapper of wrappedParts.values) {
      if (!(wrapper instanceof ScriptInstance)) continue;
      const typeDef = this.context.normalizedSymbol(this.context.instanceProp(wrapper, "ptypedef"));
      const sprite = this.context.instanceProp(wrapper, "psprite");
      if (!(sprite instanceof SpriteChannel)) continue;
      const image = this.context.spriteMemberImage(sprite);
      if (!this.shadows.isShadowWrapper(typeDef, image)) continue;
      this.shadows.renderAtLogicalCoordinates(wrapper, sprite, appliedX, appliedY);
    }
  }

  correctLocations(
    visualizer: ScriptInstance,
    baseX: number,
    baseY: number,
    currentX: number,
    currentY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const wrappedParts = this.context.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return false;
    const appliedX = Math.round(currentX - baseX);
    const appliedY = Math.round(currentY - baseY);
    let changed = false;
    for (let index = 0; index < wrappedParts.values.length; index += 1) {
      const wrapper = wrappedParts.values[index];
      if (!(wrapper instanceof ScriptInstance)) continue;
      const typeDef = this.context.normalizedSymbol(this.context.instanceProp(wrapper, "ptypedef"));
      const sprite = this.context.instanceProp(wrapper, "psprite");
      const offsets = this.context.instanceProp(wrapper, "poffsets");
      if (!(sprite instanceof SpriteChannel) || !(offsets instanceof LingoList)) continue;
      const offsetX = this.context.numberValue(offsets.getAt(1), sprite.locH);
      const offsetY = this.context.numberValue(offsets.getAt(2), sprite.locV);
      const image = this.context.spriteMemberImage(sprite);
      const id = `wrapper:${String(wrappedParts.keys[index] ?? index + 1)}`;
      if (this.shadows.isShadowWrapper(typeDef, image)) {
        if (this.shadows.anchorWrapper(id, typeDef, wrapper, sprite, image, offsetX, offsetY, appliedX, appliedY, anchors)) {
          changed = true;
        }
        continue;
      }
      this.shadows.forget(wrapper);
      if (this.floor.anchorWrapper(id, typeDef, sprite, offsetX, offsetY, appliedX, appliedY, anchors)) changed = true;
    }
    return changed;
  }
}
