import { LingoPoint } from "@director/geometry";
import { lingoKeyEquals, stringOf } from "@director/ops";
import { SpriteChannel } from "@director/sprites";
import { LingoPropList, LingoSymbol } from "@director/values";
import type { ResizeEngineAnchor } from "../../ResizeEngineTypes";
import type { RoomResizePresentationContext } from "../RoomResizePresentationContext";

interface MaskLocation {
  logicalX: number;
  logicalY: number;
  observedX: number;
  observedY: number;
  appliedX: number;
  appliedY: number;
}

interface CompositionState {
  readonly epochKey: string;
  readonly background: object;
  readonly backgroundVersion: number;
  readonly maskSignature: string;
}

/** Owns private-room landscape, window mask, sky, and cloud resize presentation. */
export class LandscapeResizePresentation {
  private composition: CompositionState | null = null;
  private readonly maskLocations = new Map<string, MaskLocation>();

  constructor(private readonly context: RoomResizePresentationContext) {}

  resetRoom(): void {
    this.composition = null;
    this.maskLocations.clear();
  }

  /**
   * Adds Source-owned landscape presentation channels to the shared managed set.
   * These sprites are positioned by this adapter and must not receive the generic
   * free-stage offset a second time later in the same resize pass.
   */
  collectManagedSprites(target: Set<SpriteChannel>): void {
    const animationManager = this.context.objectById("landscape_animation_manager");
    if (!animationManager) return;
    const cloud = this.context.instanceProp(animationManager, "psprite");
    if (cloud instanceof SpriteChannel) target.add(cloud);
  }

  anchor(
    visualizer: import("@director/Runtime").ScriptInstance,
    epochKey: string,
    appliedX: number,
    appliedY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const { movie } = this.context;
    if (!movie.runtime.hasHandler(visualizer, "getsprbyid")) return false;
    const sprite = movie.runtime.callMethod(visualizer, "getsprbyid", ["landscape"]);
    if (!(sprite instanceof SpriteChannel)) return false;
    const member = (sprite as unknown as { member?: unknown }).member;
    if (!member || typeof member !== "object") return false;
    let changed = this.synchronizeComposition(epochKey, appliedX, appliedY, anchors);
    const targetX = Math.round(appliedX);
    const targetY = Math.round(appliedY);
    if (this.context.setSpriteLoc(sprite, targetX, targetY)) {
      changed = true;
      anchors.push({ id: "landscape", kind: "sprite", action: "landscape-follow", x: targetX, y: targetY });
    }
    const animationManager = this.context.objectById("landscape_animation_manager");
    if (animationManager) {
      const cloud = this.context.instanceProp(animationManager, "psprite");
      if (cloud instanceof SpriteChannel && this.context.setSpriteLoc(cloud, targetX, targetY)) {
        changed = true;
        anchors.push({ id: "landscape_clouds", kind: "sprite", action: "landscape-clouds-follow", x: targetX, y: targetY });
      }
    }
    return changed;
  }

  private synchronizeComposition(
    epochKey: string,
    appliedX: number,
    appliedY: number,
    anchors: ResizeEngineAnchor[],
  ): boolean {
    const landscapeManager = this.context.objectById("landscape_manager");
    const backgroundManager = this.context.objectById("landscape_background_manager");
    const wallMaskManager = this.context.objectById("wall_mask_manager");
    if (!landscapeManager || !backgroundManager || !wallMaskManager) return false;
    if (!this.context.movie.runtime.hasHandler(landscapeManager, "updatelandscape")) return false;

    const background = this.context.instanceProp(backgroundManager, "pimage");
    const maskList = this.context.instanceProp(wallMaskManager, "pmasklist");
    if (!background || typeof background !== "object" || !(maskList instanceof LingoPropList)) return false;

    const versionValue = (background as { version?: unknown }).version;
    const backgroundVersion = typeof versionValue === "number" ? versionValue : 0;
    const liveKeys = new Set<string>();
    const entries: Array<{
      key: string;
      item: LingoPropList;
      loc: LingoPoint;
      logicalX: number;
      logicalY: number;
      signature: string;
    }> = [];

    for (let index = 0; index < maskList.values.length; index += 1) {
      const item = maskList.values[index];
      if (!(item instanceof LingoPropList)) continue;
      const loc = this.context.propListLookup(item, "#loc");
      if (!(loc instanceof LingoPoint)) continue;
      const key = stringOf(maskList.keys[index] ?? index + 1);
      liveKeys.add(key);
      const previous = this.maskLocations.get(key);
      let logicalX = Math.round(loc.x - appliedX);
      let logicalY = Math.round(loc.y - appliedY);
      if (previous) {
        const unchanged = loc.x === previous.observedX && loc.y === previous.observedY;
        const followedPresentation =
          loc.x - previous.observedX === appliedX - previous.appliedX &&
          loc.y - previous.observedY === appliedY - previous.appliedY;
        if (unchanged || followedPresentation) {
          logicalX = previous.logicalX;
          logicalY = previous.logicalY;
        }
      }
      this.maskLocations.set(key, { logicalX, logicalY, observedX: loc.x, observedY: loc.y, appliedX, appliedY });
      const classId = stringOf(this.context.propListLookup(item, "#class"));
      const direction = stringOf(this.context.propListLookup(item, "#dir"));
      const size = this.context.numberValue(this.context.propListLookup(item, "#size"), 0);
      entries.push({
        key,
        item,
        loc,
        logicalX,
        logicalY,
        signature: `${key}:${classId}:${direction}:${size}:${logicalX},${logicalY}`,
      });
    }
    for (const key of [...this.maskLocations.keys()]) {
      if (!liveKeys.has(key)) this.maskLocations.delete(key);
    }

    const maskSignature = entries.map((entry) => entry.signature).join("|");
    const previous = this.composition;
    if (
      previous?.epochKey === epochKey &&
      previous.background === background &&
      previous.backgroundVersion === backgroundVersion &&
      previous.maskSignature === maskSignature
    ) {
      return false;
    }

    try {
      for (const entry of entries) {
        entry.item.setaProp(LingoSymbol.for("loc"), new LingoPoint(entry.logicalX, entry.logicalY), lingoKeyEquals);
      }
      wallMaskManager.props.set("prequiresupdate", 1);
      this.context.movie.runtime.callMethod(landscapeManager, "updatelandscape", []);
    } finally {
      for (const entry of entries) entry.item.setaProp(LingoSymbol.for("loc"), entry.loc, lingoKeyEquals);
    }

    this.composition = { epochKey, background, backgroundVersion, maskSignature };
    anchors.push({
      id: "landscape",
      kind: "sprite",
      action: "logical-mask-rebuild",
      x: Math.round(appliedX),
      y: Math.round(appliedY),
      note: `${entries.length} wall mask item(s)`,
    });
    return true;
  }
}
