import type { SpriteChannel } from "@director/sprites";
import type { ResizeEngineAnchor } from "../../ResizeEngineTypes";
import type { RoomResizePresentationContext } from "../RoomResizePresentationContext";

/** Positions logical floor and other source-defined room surface wrappers. */
export class FloorResizePresentation {
  constructor(private readonly context: RoomResizePresentationContext) {}

  anchorWrapper(
    id: string,
    typeDef: string,
    sprite: SpriteChannel,
    offsetX: number,
    offsetY: number,
    appliedX: number,
    appliedY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const targetX = Math.round(offsetX + appliedX);
    const targetY = Math.round(offsetY + appliedY);
    if (!this.context.setSpriteLoc(sprite, targetX, targetY)) return false;
    anchors.push({
      id,
      kind: "sprite",
      action: "wrapper-follow",
      x: targetX,
      y: targetY,
      note: typeDef,
    });
    return true;
  }
}
