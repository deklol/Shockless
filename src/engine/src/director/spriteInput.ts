import { LingoColor, LingoRect } from "./geometry";
import type { LingoImage } from "./imaging";
import type { CastMember } from "./members";
import type { SpriteChannel } from "./sprites";

const WHITE = new LingoColor(255, 255, 255);

export interface DirectorSpriteInputDependencies {
  channels: readonly SpriteChannel[];
  spriteRect: (sprite: SpriteChannel) => LingoRect;
  channelEditable: (channel: SpriteChannel | null) => boolean;
  channelHasAnyHandler: (channel: SpriteChannel, events: readonly string[]) => boolean;
  inputHitTestOverride: (channel: SpriteChannel, x: number, y: number) => boolean | null;
  spriteWidth: (sprite: SpriteChannel) => number;
  spriteHeight: (sprite: SpriteChannel) => number;
  memberWidth: (member: CastMember) => number;
  memberHeight: (member: CastMember) => number;
  aliasMirrorTransform: (sprite: SpriteChannel) => boolean;
  degreesToRadians: (value: number) => number;
  spriteRegX: (sprite: SpriteChannel) => number;
  spriteRegY: (sprite: SpriteChannel) => number;
}

/** Resolves Director sprite bounds, stacking, transformed pixels, and input targets. */
export class DirectorSpriteInput {
  constructor(private readonly dependencies: DirectorSpriteInputDependencies) {}

  spriteAt(x: number, y: number): SpriteChannel | null {
    return this.spritesAt(x, y)[0] ?? null;
  }

  spritesAt(x: number, y: number): SpriteChannel[] {
    const hits: SpriteChannel[] = [];
    for (const channel of this.dependencies.channels) {
      if (channel.puppet !== 1 || channel.visible !== 1 || !channel.member) continue;
      const rect = this.dependencies.spriteRect(channel);
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) hits.push(channel);
    }
    return hits.sort((left, right) => right.locZ - left.locZ || right.number - left.number);
  }

  spriteBounds(channelNumber: number): LingoRect | null {
    const channel = this.dependencies.channels[channelNumber];
    return channel ? this.dependencies.spriteRect(channel) : null;
  }

  eventSpriteAt(x: number, y: number, events: readonly string[]): SpriteChannel | null {
    for (const channel of this.spritesAt(x, y)) {
      if (!this.channelAcceptsInputAt(channel, x, y)) continue;
      if (this.dependencies.channelEditable(channel) || this.dependencies.channelHasAnyHandler(channel, events)) return channel;
    }
    return null;
  }

  private channelAcceptsInputAt(channel: SpriteChannel, x: number, y: number): boolean {
    if (!channel.member) return false;
    const local = this.sourcePointAt(channel, x, y);
    if (!local) return false;
    if (this.dependencies.channelEditable(channel)) return true;
    const override = this.dependencies.inputHitTestOverride(channel, x, y);
    if (override !== null) return override;
    if (channel.ink !== 8) return true;
    const image = this.memberHitImage(channel.member);
    if (!image || image.incomplete) return true;
    const sourceX = Math.max(0, Math.min(image.width - 1, Math.floor((local.x / local.width) * image.width)));
    const sourceY = Math.max(0, Math.min(image.height - 1, Math.floor((local.y / local.height) * image.height)));
    const alpha = image.getPixelAlpha ? image.getPixelAlpha(sourceX, sourceY) : 255;
    if (alpha <= 0) return false;
    const pixel = image.getPixel(sourceX, sourceY);
    if (this.sameRgb(pixel, WHITE)) {
      if (this.channelUsesBoundaryMatteInput(channel, image)) {
        return !(image.isBoundaryConnectedColorPixel?.(sourceX, sourceY, WHITE) ?? true);
      }
      return false;
    }
    return true;
  }

  private memberHitImage(member: CastMember): (Pick<LingoImage, "width" | "height" | "incomplete" | "getPixel"> & {
    getPixelAlpha?: (x: number, y: number) => number;
    isBoundaryConnectedColorPixel?: (x: number, y: number, color: LingoColor) => boolean;
    matteCoveragePolicyForDebug?: () => string;
  }) | null {
    return member.presentationImage ?? member.image ?? member.bitmap?.decoded ?? null;
  }

  private channelUsesBoundaryMatteInput(
    channel: SpriteChannel,
    image: Pick<LingoImage, "width" | "height" | "incomplete" | "getPixel"> & {
      matteCoveragePolicyForDebug?: () => string;
    },
  ): boolean {
    if (channel.member?.image === image) return true;
    const policy = image.matteCoveragePolicyForDebug?.();
    return policy === "edge-connected-white-transparent" || policy === "edge-connected-dominant-palette-index-transparent";
  }

  private sameRgb(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }): boolean {
    return left.r === right.r && left.g === right.g && left.b === right.b;
  }

  sourcePointAt(
    sprite: SpriteChannel,
    stageX: number,
    stageY: number,
    clampToBounds = false,
  ): { x: number; y: number; width: number; height: number } | null {
    const dependencies = this.dependencies;
    const width = dependencies.spriteWidth(sprite);
    const height = dependencies.spriteHeight(sprite);
    const memberWidth = sprite.member ? dependencies.memberWidth(sprite.member) : width;
    const memberHeight = sprite.member ? dependencies.memberHeight(sprite.member) : height;
    const sourceWidth = memberWidth > 0 ? memberWidth : width;
    const sourceHeight = memberHeight > 0 ? memberHeight : height;
    if (sourceWidth <= 0 || sourceHeight <= 0 || width <= 0 || height <= 0) return null;
    const scaleX = width / sourceWidth;
    const scaleY = height / sourceHeight;
    const aliasMirrorH = dependencies.aliasMirrorTransform(sprite);
    const flipX = (sprite.flipH ? -1 : 1) * (aliasMirrorH ? -1 : 1);
    const flipY = sprite.flipV ? -1 : 1;
    const rotation = aliasMirrorH ? 0 : dependencies.degreesToRadians(sprite.rotation);
    const skewX = aliasMirrorH ? 0 : dependencies.degreesToRadians(sprite.skew);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const dx = stageX - sprite.locH;
    const dy = stageY - sprite.locV;
    const skewedX = dx * cos + dy * sin;
    const localY = -dx * sin + dy * cos;
    const localX = skewedX - Math.tan(skewX) * localY;
    const sourceX = localX / (scaleX * flipX) + dependencies.spriteRegX(sprite);
    const sourceY = localY / (scaleY * flipY) + dependencies.spriteRegY(sprite);
    if (!clampToBounds && (sourceX < 0 || sourceY < 0 || sourceX >= sourceWidth || sourceY >= sourceHeight)) {
      return null;
    }
    return {
      x: clampToBounds ? Math.max(0, Math.min(sourceWidth, sourceX)) : sourceX,
      y: clampToBounds ? Math.max(0, Math.min(Math.max(0, sourceHeight - Number.EPSILON), sourceY)) : sourceY,
      width: sourceWidth,
      height: sourceHeight,
    };
  }
}
