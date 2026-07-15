import { LingoRect } from "@director/geometry";
import { add as lingoAdd, lingoKeyEquals } from "@director/ops";
import { ScriptInstance } from "@director/Runtime";
import { LingoList, LingoPropList, LingoSymbol, LingoVoid } from "@director/values";
import type { RoomResizePresentationContext } from "../RoomResizePresentationContext";

/** Owns wall part coordinates and logical-buffer rendering during room presentation moves. */
export class WallResizePresentation {
  private readonly logicalImages = new WeakMap<ScriptInstance, object>();

  constructor(private readonly context: RoomResizePresentationContext) {}

  shiftPartData(visualizer: ScriptInstance, dx: number, dy: number): void {
    const wrappedParts = this.context.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return;
    for (const wrapper of wrappedParts.values) {
      if (!(wrapper instanceof ScriptInstance)) continue;
      const typeDef = this.context.normalizedSymbol(this.context.instanceProp(wrapper, "ptypedef"));
      if (typeDef !== "wallleft" && typeDef !== "wallright") continue;
      const partList = this.context.instanceProp(wrapper, "ppartlist");
      if (!(partList instanceof LingoList)) continue;
      for (const part of partList.items) {
        if (!(part instanceof LingoPropList)) continue;
        this.shiftPartProp(part, "locH", dx);
        this.shiftPartProp(part, "locV", dy);
        const screenRect = part.getaProp(LingoSymbol.for("screenrect"), lingoKeyEquals);
        if (!(screenRect instanceof LingoVoid)) {
          part.setaProp(LingoSymbol.for("screenrect"), lingoAdd(screenRect, new LingoRect(dx, dy, dx, dy)), lingoKeyEquals);
        }
      }
      if (!this.context.movie.runtime.hasHandler(wrapper, "updatebounds")) continue;
      try {
        this.context.movie.runtime.callMethod(wrapper, "updatebounds", []);
      } catch {
        // Bounds are a source cache and will be rebuilt by the next wrapper update.
      }
    }
  }

  renderAtLogicalCoordinates(visualizer: ScriptInstance, appliedX: number, appliedY: number): void {
    if (appliedX === 0 && appliedY === 0) return;
    const wrappedParts = this.context.instanceProp(visualizer, "pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) return;
    for (const wrapper of wrappedParts.values) {
      if (!(wrapper instanceof ScriptInstance)) continue;
      const typeDef = this.context.normalizedSymbol(this.context.instanceProp(wrapper, "ptypedef"));
      if (typeDef !== "wallleft" && typeDef !== "wallright") continue;
      const sprite = this.context.instanceProp(wrapper, "psprite");
      const currentImage = this.context.spriteMemberImage(sprite);
      if (currentImage && this.logicalImages.get(wrapper) === currentImage) continue;
      const partList = this.context.instanceProp(wrapper, "ppartlist");
      if (!(partList instanceof LingoList)) continue;
      const saved: Array<{ part: LingoPropList; locH: number; locV: number }> = [];
      for (const part of partList.items) {
        if (!(part instanceof LingoPropList)) continue;
        const locH = this.context.numberValue(this.context.propListLookup(part, "#locH"), 0);
        const locV = this.context.numberValue(this.context.propListLookup(part, "#locV"), 0);
        saved.push({ part, locH, locV });
        part.setaProp(LingoSymbol.for("locH"), Math.round(locH - appliedX), lingoKeyEquals);
        part.setaProp(LingoSymbol.for("locV"), Math.round(locV - appliedY), lingoKeyEquals);
      }
      if (saved.length === 0) continue;
      const status = this.context.instanceProp(wrapper, "pwrapperstatus");
      if (status instanceof LingoPropList) status.setaProp(LingoSymbol.for("rendered"), 0, lingoKeyEquals);
      if (this.context.movie.runtime.hasHandler(wrapper, "renderimage")) {
        this.context.movie.runtime.callMethod(wrapper, "renderimage", []);
      }
      for (const entry of saved) {
        entry.part.setaProp(LingoSymbol.for("locH"), Math.round(entry.locH), lingoKeyEquals);
        entry.part.setaProp(LingoSymbol.for("locV"), Math.round(entry.locV), lingoKeyEquals);
      }
      const renderedImage = this.context.spriteMemberImage(sprite);
      if (renderedImage) this.logicalImages.set(wrapper, renderedImage);
    }
  }

  private shiftPartProp(part: LingoPropList, key: string, delta: number): void {
    const symbol = LingoSymbol.for(key);
    const current = part.getaProp(symbol, lingoKeyEquals);
    part.setaProp(symbol, this.context.numberValue(current, 0) + delta, lingoKeyEquals);
  }
}
