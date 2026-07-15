import type { ScriptInstance } from "@director/Runtime";
import type { SpriteChannel } from "@director/sprites";
import { lingoKeyEquals } from "@director/ops";
import { LingoList, LingoPropList, LingoSymbol, type LingoValue } from "@director/values";
import type { ResizeEngineAnchor } from "../../ResizeEngineTypes";
import type { RoomResizePresentationContext } from "../RoomResizePresentationContext";

/** Anchors Source's authored-stage shadow composite to the presented room. */
export class ShadowResizePresentation {
  private readonly placements = new WeakMap<ScriptInstance, { image: object; appliedX: number; appliedY: number }>();
  private readonly logicalImages = new WeakMap<ScriptInstance, object>();
  private readonly logicalParts = new WeakSet<LingoPropList>();

  constructor(private readonly context: RoomResizePresentationContext) {}

  isShadowWrapper(typeDef: string, image: object | undefined): image is object {
    return typeDef === "other" && image !== undefined;
  }

  captureBaseline(wrapper: ScriptInstance, image: object, appliedX: number, appliedY: number): void {
    if (this.placements.has(wrapper)) return;
    this.placements.set(wrapper, { image, appliedX, appliedY });
    if (appliedX === 0 && appliedY === 0) {
      this.logicalImages.set(wrapper, image);
      this.markCurrentPartsLogical(wrapper);
    }
  }

  forget(wrapper: ScriptInstance): void {
    this.placements.delete(wrapper);
    this.logicalImages.delete(wrapper);
  }

  /**
   * Source bakes every shadow part into a fixed logical-stage image. Parts
   * created after responsive room movement carry presented screen coordinates,
   * which Director clips at the authored 960x540 image boundary. Re-run the
   * original wrapper renderer with those coordinates temporarily returned to
   * logical space, then present the completed image with the room offset.
   */
  renderAtLogicalCoordinates(wrapper: ScriptInstance, sprite: SpriteChannel, appliedX: number, appliedY: number): void {
    const currentImage = this.context.spriteMemberImage(sprite);
    if (!currentImage || this.logicalImages.get(wrapper) === currentImage) return;
    if (appliedX === 0 && appliedY === 0) {
      this.logicalImages.set(wrapper, currentImage);
      this.placements.set(wrapper, { image: currentImage, appliedX: 0, appliedY: 0 });
      this.markCurrentPartsLogical(wrapper);
      return;
    }
    if (!this.context.movie.runtime.hasHandler(wrapper, "renderimage")) return;

    const partList = this.context.instanceProp(wrapper, "ppartlist");
    if (!(partList instanceof LingoList)) return;
    const saved: Array<{ part: LingoPropList; locH: LingoValue; locV: LingoValue }> = [];
    for (const part of partList.items) {
      if (!(part instanceof LingoPropList)) continue;
      if (this.logicalParts.has(part)) continue;
      const locH = part.getaProp(LingoSymbol.for("locH"), lingoKeyEquals);
      const locV = part.getaProp(LingoSymbol.for("locV"), lingoKeyEquals);
      saved.push({ part, locH, locV });
      part.setaProp(
        LingoSymbol.for("locH"),
        Math.round(this.context.numberValue(locH, 0) - appliedX),
        lingoKeyEquals,
      );
      part.setaProp(
        LingoSymbol.for("locV"),
        Math.round(this.context.numberValue(locV, 0) - appliedY),
        lingoKeyEquals,
      );
    }
    if (saved.length === 0) {
      this.logicalImages.set(wrapper, currentImage);
      this.placements.set(wrapper, { image: currentImage, appliedX: 0, appliedY: 0 });
      return;
    }

    try {
      this.context.movie.runtime.callMethod(wrapper, "renderimage", []);
    } finally {
      for (const entry of saved) {
        entry.part.setaProp(LingoSymbol.for("locH"), entry.locH, lingoKeyEquals);
        entry.part.setaProp(LingoSymbol.for("locV"), entry.locV, lingoKeyEquals);
      }
    }

    const renderedImage = this.context.spriteMemberImage(sprite);
    if (!renderedImage) return;
    for (const entry of saved) this.logicalParts.add(entry.part);
    this.logicalImages.set(wrapper, renderedImage);
    this.placements.set(wrapper, { image: renderedImage, appliedX: 0, appliedY: 0 });
  }

  private markCurrentPartsLogical(wrapper: ScriptInstance): void {
    const partList = this.context.instanceProp(wrapper, "ppartlist");
    if (!(partList instanceof LingoList)) return;
    for (const part of partList.items) {
      if (part instanceof LingoPropList) this.logicalParts.add(part);
    }
  }

  anchorWrapper(
    id: string,
    typeDef: string,
    wrapper: ScriptInstance,
    sprite: SpriteChannel,
    image: object,
    offsetX: number,
    offsetY: number,
    appliedX: number,
    appliedY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    // Images normalized above are logical-stage composites and therefore take
    // the complete room presentation offset. The placement fallback preserves
    // Source ownership when a nonstandard wrapper has no renderimage handler.
    let placement = this.placements.get(wrapper);
    if (!placement || placement.image !== image) {
      placement = { image, appliedX, appliedY };
      this.placements.set(wrapper, placement);
    }
    const targetX = Math.round(offsetX + (appliedX - placement.appliedX));
    const targetY = Math.round(offsetY + (appliedY - placement.appliedY));
    if (!this.context.setSpriteLoc(sprite, targetX, targetY)) return false;
    anchors.push({
      id,
      kind: "sprite",
      action: "shadow-follow",
      x: targetX,
      y: targetY,
      note: typeDef,
    });
    return true;
  }
}
