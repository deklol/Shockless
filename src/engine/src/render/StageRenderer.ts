import { Assets, Container, Graphics, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import { LingoColor, LingoRect } from "../director/geometry";
import { SpriteChannel } from "../director/sprites";
import { LingoImage } from "../director/imaging";
import { paletteColor } from "../director/palettes";
import { LingoSymbol, type LingoValue } from "../director/values";
import {
  bitmapUrlForInk,
  boundaryConnectedDominantBorderMask,
  boundaryConnectedWhiteMask,
  applyDirectorMaskCoveragePixels,
  bufferSpriteInkUsesColorKey,
  bufferSpriteInkUsesBoundaryWhiteCoverage,
  bufferSpriteInkUsesDirectorMask,
  bufferSpriteInkUsesMatteCoverage,
  bufferSpriteInkUsesMultiplyTint,
  directBitmapInkNeedsRuntimePixels,
  directBitmapInkIsInvisibleHitProxy,
  directBitmapInkRequiresPixelProcessing,
  directBitmapInkUsesSpriteProcessing,
  directorSpriteAlphaForInk,
  directorSpriteBlendModeForInk,
  directorSpriteTintForDirectBitmap,
  imagePixelsHaveNonOpaqueAlpha,
  processedDirectBitmapInkUsesGpuTint,
  subtractInkSourceIsNoop,
} from "./ink";
import { AvatarInterpolationPresenter, type AvatarInterpolationDiagnostics } from "../habbo/user/AvatarInterpolationPresenter";
import { SourceWindowPresentationBudget, type SourceWindowPresentationBudgetDiagnostics } from "./SourceWindowPresentationBudget";

type StageNode = Sprite | Graphics | TilingSprite | TextFieldNode;

interface StageView {
  readonly node: StageNode;
  key: string;
  signature: string;
  channelVersion?: number;
  motionPresentationSignature?: string;
  memberPresentationSignature?: string;
  roomStagePresentationSignature?: string;
  focusPresentationSignature?: string;
}

interface AppliedChannelSample {
  readonly channel: number;
  readonly branch: string;
  readonly key: string;
  readonly member: string;
  readonly memberType: string;
  readonly firstChangedField: string;
  readonly previous: string;
  readonly next: string;
}

export interface UserNameLabel {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RoomStagePresentation {
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
  readonly channels: ReadonlySet<number>;
}

export interface PresentationUnderlay {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: number;
  readonly textureUrl?: string;
}

export interface CustomHotelViewPresentation {
  readonly active: boolean;
  readonly backgroundUrl: string;
  readonly stageUrl: string;
  readonly bannerUrl: string;
  readonly backgroundX: number;
  readonly backgroundY: number;
  readonly stageX: number;
  readonly stageY: number;
  readonly bannerX: number;
  readonly bannerY: number;
}

interface TextFieldNode extends Container {
  __selectionNode: Graphics;
  __textNode: Sprite;
  __caretNode: Graphics;
}

interface UserNameLabelNode extends Container {
  __outlineNodes: Text[];
  __fillNode: Text;
  __labelText: string;
  __fillColor: string;
}

type TextureLoadState =
  | { readonly state: "loading"; readonly failures: number }
  | { readonly state: "failed"; readonly failures: number; readonly nextRetryAt: number };

type TextureCacheEntry = Texture | TextureLoadState;

export const TEXTURE_LOAD_RETRY_DELAY_MS = 5_000;
export const TEXTURE_LOAD_MAX_RETRIES = 3;

const SIGNATURE_BASE_FIELDS = [
  "key",
  "roomStagePresentation",
  "channel.number",
  "channel.puppet",
  "channel.visible",
  "channel.locH",
  "channel.locV",
  "channel.locZ",
  "channel.width",
  "channel.height",
  "channel.stretch",
  "channel.ink",
  "channel.blend",
  "channel.flipH",
  "channel.flipV",
  "channel.rotation",
  "channel.skew",
  "channel.foreColor",
  "channel.backColor",
  "channel.color",
  "channel.bgColor",
  "channel.editable",
  "member.slotNumber",
  "member.castNumber",
  "member.number",
  "member.type",
  "member.name",
  "member.regX",
  "member.regY",
  "member.useAlpha",
  "member.textVersion",
  "member.paletteRef",
  "member.bitmap.pngUrl",
  "member.bitmap.width",
  "member.bitmap.height",
  "member.bitmap.regX",
  "member.bitmap.regY",
  "member.bitmap.decoded",
  "member.image",
] as const;

export function textureLoadRetryDelayMs(failures: number): number {
  return TEXTURE_LOAD_RETRY_DELAY_MS * Math.max(1, Math.min(TEXTURE_LOAD_MAX_RETRIES, Math.trunc(failures) || 1));
}

/**
 * Pixi presenter for Director sprite channels. Pure consumer: reads channel
 * state each sync and mirrors it into Pixi display objects. Director
 * semantics (loc = where the member's regPoint lands; channel z-order with
 * locZ override) are applied here. Generated ink-specific asset variants are
 * selected for direct bitmap sprites; image/copyPixels semantics stay in the
 * Director image layer.
 */
export class StageRenderer {
  private readonly root = new Container();
  private readonly views = new Map<number, StageView>();
  private readonly underlays = new Map<string, Graphics | TilingSprite>();
  private readonly customHotelViewNodes = new Map<string, Sprite>();
  private readonly userNameLabelNodes = new Map<string, UserNameLabelNode>();
  private readonly textures = new Map<string, TextureCacheEntry>();
  private readonly textureRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly imageTextures = new Map<LingoImage, { texture: Texture; contentSignature: string; el: unknown }>();
  private readonly directorMaskCoverage = new WeakMap<
    LingoImage,
    { contentSignature: string; width: number; height: number; image: ImageData }
  >();
  /** Ink-processed buffer textures: image -> "ink:backColor" -> a persistent
   * scratch canvas + texture pair that is reprocessed in place (no per-frame
   * canvas/texture allocation). */
  private readonly inkTextures = new WeakMap<
    LingoImage,
    Map<
      string,
      {
        canvas: HTMLCanvasElement;
        ctx: CanvasRenderingContext2D;
        texture: Texture | null;
        contentSignature: string;
        maskSignature: string;
      }
    >
  >();
  private readonly imageIds = new WeakMap<LingoImage, number>();
  private nextImageId = 1;
  private dirty = true;
  private lastSyncStats = { considered: 0, skipped: 0, applied: 0, destroyed: 0 };
  private lastAppliedSamples: AppliedChannelSample[] = [];
  private readonly avatarInterpolation = new AvatarInterpolationPresenter();
  private readonly sourceWindowPresentationBudget = new SourceWindowPresentationBudget();
  private customHotelView: CustomHotelViewPresentation | null = null;
  private suppressedChannels = new Set<number>();
  private manualHiddenChannels = new Set<number>();
  private roomStagePresentation: RoomStagePresentation | null = null;
  private roomStagePresentationSignature = "";

  constructor(stage: Container) {
    this.root.sortableChildren = true;
    stage.addChild(this.root);
  }

  beginFrame(nowMs: number): void {
    this.avatarInterpolation.beginFrame(nowMs);
    this.sourceWindowPresentationBudget.beginFrame();
  }

  setPresentationUnderlays(underlays: readonly PresentationUnderlay[]): void {
    const seen = new Set<string>();
    for (const underlay of underlays) {
      seen.add(underlay.id);
      const texture = underlay.textureUrl ? this.textureFor(underlay.textureUrl) : null;
      let node = this.underlays.get(underlay.id);
      if (texture && !(node instanceof TilingSprite)) {
        node?.destroy();
        node = new TilingSprite({
          texture,
          width: Math.max(1, Math.round(underlay.width)),
          height: Math.max(1, Math.round(underlay.height)),
          roundPixels: true,
        });
        node.zIndex = -19_999_999;
        this.root.addChild(node);
        this.underlays.set(underlay.id, node);
      } else if (!texture && !(node instanceof Graphics)) {
        node?.destroy();
        node = new Graphics();
        this.configurePixelNode(node);
        // Above the stage cover, below all normal source-owned UI sprites.
        node.zIndex = -19_999_999;
        this.root.addChild(node);
        this.underlays.set(underlay.id, node);
      }
      if (!node) continue;
      node.x = Math.round(underlay.x);
      node.y = Math.round(underlay.y);
      if (node instanceof TilingSprite) {
        if (texture) node.texture = texture;
        node.width = Math.max(1, Math.round(underlay.width));
        node.height = Math.max(1, Math.round(underlay.height));
      } else {
        node.clear();
        node.rect(0, 0, Math.max(1, Math.round(underlay.width)), Math.max(1, Math.round(underlay.height)));
        node.fill(underlay.color);
      }
    }
    for (const [id, node] of this.underlays) {
      if (seen.has(id)) continue;
      node.destroy();
      this.underlays.delete(id);
    }
  }

  setCustomHotelView(presentation: CustomHotelViewPresentation | null): void {
    if (this.sameCustomHotelViewPresentation(this.customHotelView, presentation)) return;
    this.customHotelView = presentation?.active ? presentation : null;
    if (!this.customHotelView) {
      for (const node of this.customHotelViewNodes.values()) {
        node.destroy();
      }
      this.customHotelViewNodes.clear();
    }
    this.markDirty();
  }

  setSuppressedChannels(channels: ReadonlySet<number>): void {
    if (this.sameNumberSet(this.suppressedChannels, channels)) return;
    this.suppressedChannels = new Set(channels);
    this.markDirty();
  }

  /** Channels hidden by dev/easter-egg toggles (hidefurni/hideusers/hideui).
   * Independent of suppressedChannels (custom hotel view); render skips either. */
  setManualHiddenChannels(channels: ReadonlySet<number>): void {
    if (this.sameNumberSet(this.manualHiddenChannels, channels)) return;
    this.manualHiddenChannels = new Set(channels);
    this.markDirty();
  }

  setRoomStagePresentation(presentation: RoomStagePresentation | null): void {
    const normalized =
      presentation && presentation.scale > 1 && presentation.channels.size > 0
        ? {
            scale: presentation.scale,
            originX: presentation.originX,
            originY: presentation.originY,
            channels: new Set(presentation.channels),
          }
        : null;
    const signature = this.roomStagePresentationKey(normalized);
    if (signature === this.roomStagePresentationSignature) return;
    this.roomStagePresentation = normalized;
    this.roomStagePresentationSignature = signature;
    this.avatarInterpolation.reset();
    this.markDirty();
  }

  setAvatarInterpolation(settings: { readonly enabled: boolean; readonly channels: ReadonlySet<number>; readonly frameTempo: number }): void {
    if (this.avatarInterpolation.configure(settings)) this.markDirty();
  }

  setSourceWindowPresentationBudget(settings: {
    readonly enabled: boolean;
    readonly channels: ReadonlySet<number>;
    readonly maxTextPreparationsPerFrame?: number;
    readonly maxSpriteUpdatesPerFrame?: number;
  }): void {
    if (this.sourceWindowPresentationBudget.configure(settings)) this.markDirty();
  }

  setUserNameLabels(labels: readonly UserNameLabel[]): void {
    const seen = new Set<string>();
    for (const label of labels) {
      const id = String(label.id || label.name);
      const text = String(label.name || "").trim();
      if (!id || !text) continue;
      seen.add(id);
      let node = this.userNameLabelNodes.get(id);
      const fill = normalizedUserNameLabelColor(label.color);
      if (!node) {
        node = this.createUserNameLabelNode(text, fill);
        this.root.addChild(node);
        this.userNameLabelNodes.set(id, node);
      }
      if (node.__labelText !== text) this.updateUserNameLabelText(node, text);
      if (node.__fillColor !== fill) this.updateUserNameLabelColor(node, fill);
      const point = this.transformRoomPoint(label.x, label.y + 15);
      node.x = Math.round(point.x);
      node.y = Math.round(point.y);
      node.zIndex = userNameLabelZIndex(label.z);
      node.visible = true;
    }

    for (const [id, node] of this.userNameLabelNodes) {
      if (seen.has(id)) continue;
      node.destroy();
      this.userNameLabelNodes.delete(id);
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  needsSync(): boolean {
    return this.dirty || this.sourceWindowPresentationBudget.hasDeferredWork();
  }

  shouldPrepareTextChannel(channelNumber: number, focused: boolean): boolean {
    return this.sourceWindowPresentationBudget.shouldPrepareTextChannel(channelNumber, focused);
  }

  presentationDiagnostics(): {
    readonly avatarInterpolation: AvatarInterpolationDiagnostics;
    readonly sourceWindowBudget: SourceWindowPresentationBudgetDiagnostics;
  } {
    return {
      avatarInterpolation: this.avatarInterpolation.diagnostics(),
      sourceWindowBudget: this.sourceWindowPresentationBudget.diagnostics(),
    };
  }

  sync(channels: SpriteChannel[], focusedSprite = 0): void {
    // Callers gate sync with renderer dirtiness plus image/focus mutation
    // epochs. Once called, sync reconciles every live channel.
    this.dirty = false;
    const seen = new Set<number>();
    let considered = 0;
    let skipped = 0;
    let applied = 0;
    let destroyed = 0;
    const appliedSamples: AppliedChannelSample[] = [];
    this.syncCustomHotelViewNodes();

    for (const channel of channels) {
      if (this.suppressedChannels.has(channel.number) || this.manualHiddenChannels.has(channel.number)) continue;
      const member = channel.member;
      const shouldShow = channel.puppet === 1 && channel.visible === 1 && member !== null;
      if (!shouldShow) continue;
      considered += 1;
      if (
        directBitmapInkIsInvisibleHitProxy(
          channel.ink,
          member!.bitmap?.width,
          member!.bitmap?.height,
        )
      ) {
        continue;
      }
      if (this.shouldSkipNoopSubtractSprite(channel)) continue;
      if (this.channelPresentationCacheHit(channel, member!, focusedSprite)) {
        seen.add(channel.number);
        skipped += 1;
        continue;
      }

      // 1. Member backed by a runtime image buffer (composited windows).
      // Decoded direct bitmaps can also use this path when the sprite ink
      // needs Director matte/color-key/tint semantics that depend on channel
      // state rather than only on a pre-generated asset URL. While the decode
      // is still in flight the PNG ink-variant path below renders instead of
      // a blank placeholder.
      const canProcessDirectBitmapInk =
        !member!.image &&
        !!member!.bitmap?.pngUrl &&
        this.shouldProcessDirectBitmapInk(channel.ink);
      const directBitmap = canProcessDirectBitmapInk ? member!.bitmap! : null;
      const hasPreprocessedDirectInk =
        !!directBitmap &&
        this.hasPreprocessedInkBitmap(directBitmap, channel.ink);
      const needsDirectPixelInk =
        canProcessDirectBitmapInk &&
        this.preferDecodedDirectBitmapInk(channel.ink, member!.name, channel.blend);
      const needsRuntimeDirectInk =
        canProcessDirectBitmapInk &&
        directBitmapInkNeedsRuntimePixels(channel.ink, member!.name, channel.blend, hasPreprocessedDirectInk);
      const directBitmapBuffer =
        needsRuntimeDirectInk
          ? needsDirectPixelInk
            ? member!.effectiveImage()
            : (directBitmap?.decoded && !directBitmap.decoded.incomplete ? directBitmap.decoded : null)
          : null;
      const buffer = member!.image ?? directBitmapBuffer ?? (!member!.bitmap?.pngUrl ? (member!.bitmap?.decoded ?? null) : null);
      const maskImage = channel.ink === 9 ? this.directorMaskImageFor(member!) : null;
      if (needsDirectPixelInk && directBitmapBuffer?.incomplete) continue;
      if (maskImage?.incomplete) continue;
      if (buffer) {
        const key = `img:${channel.number}`;
        const signature = this.channelPresentationSignature(
          channel,
          member!,
          key,
          this.imageSignature(buffer),
          this.imageSignature(maskImage),
          directBitmapBuffer !== null && processedDirectBitmapInkUsesGpuTint(channel.ink),
        );
        if (this.channelViewUnchanged(channel.number, key, signature)) {
          seen.add(channel.number);
          skipped += 1;
          continue;
        }
        this.sourceWindowPresentationBudget.recordSpriteChannelPresentation(channel.number);
        const texture = this.inkProcessedTexture(
          buffer,
          channel.ink,
          channel.foreColor,
          channel.backColor,
          channel.bgColor,
          member!.image === buffer,
          maskImage,
        );
        if (!texture) continue;
        seen.add(channel.number);
        let view = this.views.get(channel.number);
        const previousSignature = view?.signature ?? "";
        if (!view || !(view.node instanceof Sprite)) {
          view?.node.destroy();
          const node = new Sprite(texture);
          this.configurePixelNode(node);
          this.root.addChild(node);
          view = { node, key, signature: "" };
          this.views.set(channel.number, view);
        }
        const node = view.node as Sprite;
        node.scale.set(1, 1);
        node.texture = texture;
        if (channel.width > 0) node.width = channel.width;
        if (channel.height > 0) node.height = channel.height;
        this.applyChannelInkState(
          node,
          channel,
          directBitmapBuffer !== null && processedDirectBitmapInkUsesGpuTint(channel.ink),
        );
        this.applySpriteNodeState(node, channel, channel.locH, channel.locV, member!.regX, member!.regY);
        view.key = key;
        view.signature = signature;
        this.rememberViewPresentation(view, channel, member!, focusedSprite);
        applied += 1;
        this.recordAppliedSample(appliedSamples, channel, member!, "image", key, previousSignature, signature);
        continue;
      }

      if (member!.bitmap && member!.bitmap.pngUrl) {
        const bitmap = member!.bitmap;
        const needsDecodedInk = this.preferDecodedDirectBitmapInk(channel.ink, member!.name, channel.blend);
        if (
          this.shouldProcessDirectBitmapInk(channel.ink) &&
          !bitmap.decoded &&
          (needsDecodedInk || !this.hasPreprocessedInkBitmap(bitmap, channel.ink))
        ) {
          // Ask the Director member layer to decode pixels so sprite-level ink
          // can be applied from the actual source bitmap. This is mandatory
          // for Matte: generated variants can only guess at coverage, while
          // native Director keeps member pixels and channel ink as separate
          // compositor inputs until presentation time.
          member!.effectiveImage();
        }
        if (needsDecodedInk && bitmap.decoded?.incomplete) continue;
        const url = bitmapUrlForInk(bitmap, channel.ink);
        if (!url) continue;
        const key = `bmp:${url}`;
        const signature = this.channelPresentationSignature(
          channel,
          member!,
          key,
          bitmap.decoded ? this.imageSignature(bitmap.decoded) : "",
          url,
        );
        if (this.channelViewUnchanged(channel.number, key, signature)) {
          seen.add(channel.number);
          skipped += 1;
          continue;
        }
        this.sourceWindowPresentationBudget.recordSpriteChannelPresentation(channel.number);
        const texture = this.textureFor(url);
        if (!texture) continue; // still loading; next sync shows it
        seen.add(channel.number);
        let view = this.views.get(channel.number);
        const previousSignature = view?.signature ?? "";
        if (!view || view.key !== key || !(view.node instanceof Sprite)) {
          view?.node.destroy();
          const node = new Sprite(texture);
          this.configurePixelNode(node);
          this.root.addChild(node);
          view = { node, key, signature: "" };
          this.views.set(channel.number, view);
        }
        const node = view.node as Sprite;
        node.scale.set(1, 1);
        node.texture = texture;
        if (channel.width > 0) node.width = channel.width;
        if (channel.height > 0) node.height = channel.height;
        this.applyChannelInkState(node, channel, true);
        this.applySpriteNodeState(node, channel, channel.locH, channel.locV, member!.regX, member!.regY);
        view.key = key;
        view.signature = signature;
        this.rememberViewPresentation(view, channel, member!, focusedSprite);
        applied += 1;
        this.recordAppliedSample(appliedSamples, channel, member!, "bitmap", key, previousSignature, signature);
      } else if (member!.type === "shape") {
        const width = Math.max(1, channel.width);
        const height = Math.max(1, channel.height);
        const fill = this.colorValue(channel.color, 0xffffff);
        const key = `shape:${width}x${height}:${fill.toString(16)}`;
        const signature = this.channelPresentationSignature(channel, member!, key, width, height, fill);
        if (this.channelViewUnchanged(channel.number, key, signature)) {
          seen.add(channel.number);
          skipped += 1;
          continue;
        }
        this.sourceWindowPresentationBudget.recordSpriteChannelPresentation(channel.number);
        seen.add(channel.number);
        let view = this.views.get(channel.number);
        const previousSignature = view?.signature ?? "";
        if (!view || view.key !== key || !(view.node instanceof Graphics)) {
          view?.node.destroy();
          const node = new Graphics();
          this.configurePixelNode(node);
          node.rect(0, 0, width, height);
          node.fill(fill);
          this.root.addChild(node);
          view = { node, key, signature: "" };
          this.views.set(channel.number, view);
        }
        view.node.scale.set(1, 1);
        this.applyShapeChannelInkState(view.node as Graphics, channel);
        this.applyNodeState(view.node, channel, channel.locH, channel.locV);
        view.key = key;
        view.signature = signature;
        this.rememberViewPresentation(view, channel, member!, focusedSprite);
        applied += 1;
        this.recordAppliedSample(appliedSamples, channel, member!, "shape", key, previousSignature, signature);
      } else if (member!.type === "field" || member!.type === "text") {
        const image = member!.presentationImage;
        if (!image) continue;
        const editable =
          channel.editable === 1 || Number(member!.style.get("editable") ?? 0) === 1;
        const focused = channel.number === focusedSprite && editable;
        const fill = this.textFill(member!.style.get("color"));
        const key = `txtimg:${image.width}x${image.height}:${image.contentSignature}`;
        const signature = this.channelPresentationSignature(
          channel,
          member!,
          key,
          this.imageSignature(image),
          fill,
          focused,
          focused ? Math.floor(Date.now() / 500) : 0,
          member!.presentationImageKey,
          this.textRectsSignature(member!.presentationSelectionRects),
          member!.presentationCaretLoc
            ? `${member!.presentationCaretLoc.x},${member!.presentationCaretLoc.y},${member!.presentationCaretLoc.height}`
            : "",
        );
        if (this.channelViewUnchanged(channel.number, key, signature)) {
          seen.add(channel.number);
          skipped += 1;
          continue;
        }
        this.sourceWindowPresentationBudget.recordSpriteChannelPresentation(channel.number);
        const texture = this.imageTextureFor(image);
        if (!texture) continue;
        seen.add(channel.number);
        let view = this.views.get(channel.number);
        const previousSignature = view?.signature ?? "";
        if (!view || !this.isTextFieldNode(view.node)) {
          view?.node.destroy();
          const node = new Container() as TextFieldNode;
          const selectionNode = new Graphics();
          const textNode = new Sprite(texture);
          const caretNode = new Graphics();
          node.__selectionNode = selectionNode;
          node.__textNode = textNode;
          node.__caretNode = caretNode;
          this.configurePixelNode(node);
          this.configurePixelNode(selectionNode);
          this.configurePixelNode(textNode);
          this.configurePixelNode(caretNode);
          node.addChild(selectionNode, textNode, caretNode);
          this.root.addChild(node);
          view = { node, key, signature: "" };
          this.views.set(channel.number, view);
        }
        const node = view.node as TextFieldNode;
        const textNode = node.__textNode;
        if (view.key !== key) {
          textNode.texture = texture;
          view.key = key;
        }
        node.scale.set(1, 1);
        this.drawSelection(node.__selectionNode, member!.presentationSelectionRects, focused);
        this.drawCaret(node.__caretNode, member!.presentationCaretLoc, fill, focused);
        this.applyNodeState(node, channel, channel.locH, channel.locV);
        view.signature = signature;
        this.rememberViewPresentation(view, channel, member!, focusedSprite);
        applied += 1;
        this.recordAppliedSample(appliedSamples, channel, member!, "text", key, previousSignature, signature);
      }
    }

    for (const [number, view] of this.views) {
      if (!seen.has(number)) {
        this.avatarInterpolation.forget(number);
        view.node.destroy();
        this.views.delete(number);
        destroyed += 1;
      }
    }
    this.lastSyncStats = { considered, skipped, applied, destroyed };
    this.lastAppliedSamples = appliedSamples;
    if (this.sourceWindowPresentationBudget.hasDeferredWork()) this.markDirty();
  }

  private syncCustomHotelViewNodes(): void {
    const presentation = this.customHotelView;
    if (!presentation) return;
    this.syncCustomHotelViewSprite("background", presentation.backgroundUrl, presentation.backgroundX, presentation.backgroundY, -30_000_000);
    this.syncCustomHotelViewSprite("stage", presentation.stageUrl, presentation.stageX, presentation.stageY, -29_999_999);
    this.syncCustomHotelViewSprite("banner", presentation.bannerUrl, presentation.bannerX, presentation.bannerY, -29_999_998);
  }

  private syncCustomHotelViewSprite(id: string, url: string, x: number, y: number, zIndex: number): void {
    const texture = this.textureFor(url);
    if (!texture) return;
    let node = this.customHotelViewNodes.get(id);
    if (!node) {
      node = new Sprite(texture);
      this.configurePixelNode(node);
      node.zIndex = zIndex;
      this.root.addChild(node);
      this.customHotelViewNodes.set(id, node);
    }
    node.texture = texture;
    node.x = Math.round(x);
    node.y = Math.round(y);
    node.scale.set(1, 1);
    node.alpha = 1;
    node.visible = true;
    node.zIndex = zIndex;
  }

  private roomStagePresentationKey(presentation: RoomStagePresentation | null): string {
    if (!presentation) return "";
    return [
      presentation.scale,
      Math.round(presentation.originX),
      Math.round(presentation.originY),
      [...presentation.channels].sort((left, right) => left - right).join(","),
    ].join("|");
  }

  private roomPresentationScaleFor(channelNumber: number): number {
    const presentation = this.roomStagePresentation;
    return presentation && presentation.channels.has(channelNumber) ? presentation.scale : 1;
  }

  private transformRoomPoint(x: number, y: number): { x: number; y: number } {
    const presentation = this.roomStagePresentation;
    if (!presentation) return { x, y };
    return {
      x: presentation.originX + (x - presentation.originX) * presentation.scale,
      y: presentation.originY + (y - presentation.originY) * presentation.scale,
    };
  }

  private transformChannelPoint(channel: SpriteChannel, x: number, y: number): { x: number; y: number } {
    const presentation = this.roomStagePresentation;
    if (!presentation || !presentation.channels.has(channel.number)) return { x, y };
    return {
      x: presentation.originX + (x - presentation.originX) * presentation.scale,
      y: presentation.originY + (y - presentation.originY) * presentation.scale,
    };
  }

  private createUserNameLabelNode(text: string, fill: string): UserNameLabelNode {
    const node = new Container() as UserNameLabelNode;
    node.sortableChildren = true;
    node.__labelText = text;
    node.__fillColor = fill;
    node.__outlineNodes = [];
    const offsets = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ] as const;
    for (const [x, y] of offsets) {
      const outline = this.createUserNameLabelText(text, "#000000");
      outline.x = x;
      outline.y = y;
      outline.zIndex = 0;
      node.addChild(outline);
      node.__outlineNodes.push(outline);
    }
    node.__fillNode = this.createUserNameLabelText(text, fill);
    node.__fillNode.zIndex = 1;
    node.addChild(node.__fillNode);
    return node;
  }

  private createUserNameLabelText(text: string, fill: string): Text {
    const node = new Text({
      text,
      style: {
        fontFamily: '"Volter Goldfish", Goldfish, Volter, Arial, sans-serif',
        fontSize: 9,
        fill,
        align: "center",
        padding: 2,
      },
    });
    node.anchor.set(0.5, 1);
    node.resolution = 1;
    node.roundPixels = true;
    return node;
  }

  private updateUserNameLabelText(node: UserNameLabelNode, text: string): void {
    node.__labelText = text;
    node.__fillNode.text = text;
    for (const outline of node.__outlineNodes) {
      outline.text = text;
    }
  }

  private updateUserNameLabelColor(node: UserNameLabelNode, fill: string): void {
    node.__fillColor = fill;
    node.__fillNode.style.fill = fill;
  }

  private sameCustomHotelViewPresentation(
    left: CustomHotelViewPresentation | null,
    right: CustomHotelViewPresentation | null,
  ): boolean {
    const normalizedRight = right?.active ? right : null;
    if (!left || !normalizedRight) return left === normalizedRight;
    return (
      left.backgroundUrl === normalizedRight.backgroundUrl &&
      left.stageUrl === normalizedRight.stageUrl &&
      left.bannerUrl === normalizedRight.bannerUrl &&
      left.backgroundX === normalizedRight.backgroundX &&
      left.backgroundY === normalizedRight.backgroundY &&
      left.stageX === normalizedRight.stageX &&
      left.stageY === normalizedRight.stageY &&
      left.bannerX === normalizedRight.bannerX &&
      left.bannerY === normalizedRight.bannerY
    );
  }

  private sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  /** Director sprite-level ink for a buffer-backed sprite. Buffers are
   * white-initialized like Director images; Matte (8) removes coverage,
   * Background Transparent (36) keys the sprite's backColor (palette index,
   * default 0 = white), Darken (41) applies Director's fixed-point
   * background-colour filter plus foreground offset, and Add Pin (33) keys
   * then adds (the additive half is the node blend mode). Runtime image
   * buffers and direct bitmap sprites use boundary-connected backing recovery
   * for Matte so closed white artwork survives. Alpha-backed sources already
   * carry their coverage and must not be keyed a second time.
   * Processed pixels are cached per image+ink+effective colour state and
   * refreshed when the buffer mutates. */
  private inkProcessedTexture(
    image: LingoImage,
    ink: number,
    foreColor: number,
    backColor: number,
    spriteBgColor: LingoValue,
    runtimeImageBuffer = false,
    maskImage: LingoImage | null = null,
  ): Texture | null {
    if (ink !== 8 && ink !== 9 && ink !== 36 && ink !== 41 && ink !== 33) {
      return this.imageTextureFor(image);
    }
    const el = image.el;
    if (!el) return null;
    if (bufferSpriteInkUsesDirectorMask(ink) && !maskImage) {
      return this.imageTextureFor(image);
    }
    if (maskImage?.incomplete) return null;
    const maskEl = maskImage?.el ?? null;
    if (bufferSpriteInkUsesDirectorMask(ink) && !maskEl) return null;
    let byInk = this.inkTextures.get(image);
    if (!byInk) {
      byInk = new Map();
      this.inkTextures.set(image, byInk);
    }
    const bg = spriteBgColor instanceof LingoColor
      ? spriteBgColor
      : paletteColor("systemMac", backColor);
    const fg = paletteColor("systemMac", foreColor);
    const maskId = maskImage ? this.imageId(maskImage) : 0;
    const maskSignature = maskImage?.contentSignature ?? "";
    const key = `${ink}:${runtimeImageBuffer ? "runtime" : "decoded"}:${bg.r},${bg.g},${bg.b}:${fg.r},${fg.g},${fg.b}:mask:${maskId}`;
    let entry = byInk.get(key);
    if (entry) {
      if (entry.contentSignature === image.contentSignature && entry.maskSignature === maskSignature) return entry.texture;
      // Mid-load buffers mutate on every journal replay; reprocessing the
      // full-image matte/key per mutation is the room-entry CPU killer.
      // Show the last processed state and reprocess once the image settles.
      if (image.incomplete || maskImage?.incomplete) return entry.texture;
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      entry = { canvas, ctx, texture: null, contentSignature: "", maskSignature: "" };
      byInk.set(key, entry);
    }

    const { canvas, ctx } = entry;
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = Math.max(1, image.width);
      canvas.height = Math.max(1, image.height);
      ctx.imageSmoothingEnabled = false;
      entry.texture?.source.resize(image.width, image.height);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(el as CanvasImageSource & { width: number }, 0, 0);
    if (bufferSpriteInkUsesDirectorMask(ink) && maskImage) {
      this.applyDirectorMaskCoverage(ctx, canvas.width, canvas.height, maskImage);
    }
    if (bufferSpriteInkUsesMatteCoverage(ink) && !this.imageHasNonOpaqueAlpha(ctx, canvas.width, canvas.height)) {
      const mattePolicy = image.matteCoveragePolicyForDebug();
      if (mattePolicy === "edge-connected-dominant-palette-index-transparent") {
        this.applyBoundaryDominantCoverage(ctx, canvas.width, canvas.height);
      } else if (
        bufferSpriteInkUsesBoundaryWhiteCoverage(ink, runtimeImageBuffer) ||
        mattePolicy === "edge-connected-white-transparent"
      ) {
        this.applyBoundaryWhiteCoverage(ctx, canvas.width, canvas.height);
      } else {
        this.applyMatteCoverage(ctx, canvas.width, canvas.height);
      }
    }
    if (bufferSpriteInkUsesColorKey(ink)) {
      this.colorKey(ctx, canvas.width, canvas.height, bg.r, bg.g, bg.b);
    }
    if (bufferSpriteInkUsesMultiplyTint(ink)) {
      this.applyDarkenColorFilter(ctx, canvas.width, canvas.height, bg, fg);
    }
    if (entry.texture) {
      entry.texture.source.update();
    } else {
      entry.texture = Texture.from(canvas);
      entry.texture.source.scaleMode = "nearest";
    }
    entry.contentSignature = image.contentSignature;
    entry.maskSignature = maskSignature;
    return entry.texture;
  }

  private shouldProcessDirectBitmapInk(ink: number): boolean {
    return directBitmapInkUsesSpriteProcessing(ink);
  }

  private shouldSkipNoopSubtractSprite(channel: SpriteChannel): boolean {
    if (channel.ink !== 35 && channel.ink !== 38) return false;
    const image = channel.member?.image ?? channel.member?.bitmap?.decoded ?? null;
    if (!image || image.incomplete || image.width !== 1 || image.height !== 1) return false;
    return subtractInkSourceIsNoop(channel.ink, image.getPixel(0, 0));
  }

  private preferDecodedDirectBitmapInk(ink: number, memberName: string, blend: number): boolean {
    return directBitmapInkRequiresPixelProcessing(ink, memberName, blend);
  }

  private hasPreprocessedInkBitmap(bitmap: { pngUrl: string | null; inkUrls?: Record<string, string> }, ink: number): boolean {
    const url = bitmapUrlForInk(bitmap, ink);
    return !!url && url !== bitmap.pngUrl;
  }

  private directorMaskImageFor(member: NonNullable<SpriteChannel["member"]>): LingoImage | null {
    const maskMember = member.nextCastMember;
    if (!maskMember || (!maskMember.image && !maskMember.bitmap)) return null;
    return maskMember.effectiveImage();
  }

  private imageId(image: LingoImage): number {
    let id = this.imageIds.get(image);
    if (!id) {
      id = this.nextImageId++;
      this.imageIds.set(image, id);
    }
    return id;
  }

  private colorKey(ctx: CanvasRenderingContext2D, width: number, height: number, r: number, g: number, b: number): void {
    const data = ctx.getImageData(0, 0, width, height);
    const pixels = data.data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) continue;
      if (pixels[offset] === r && pixels[offset + 1] === g && pixels[offset + 2] === b) {
        pixels[offset + 3] = 0;
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  private applyDarkenColorFilter(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    scale: LingoColor,
    add: LingoColor,
  ): void {
    const data = ctx.getImageData(0, 0, width, height);
    const pixels = data.data;
    const scaleChannel = (value: number): number => (value >= 255 ? 256 : Math.max(0, Math.min(255, Math.trunc(value))));
    const sr = scaleChannel(scale.r);
    const sg = scaleChannel(scale.g);
    const sb = scaleChannel(scale.b);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) continue;
      pixels[offset] = Math.min(255, ((pixels[offset]! * sr) >> 8) + add.r);
      pixels[offset + 1] = Math.min(255, ((pixels[offset + 1]! * sg) >> 8) + add.g);
      pixels[offset + 2] = Math.min(255, ((pixels[offset + 2]! * sb) >> 8) + add.b);
    }
    ctx.putImageData(data, 0, 0);
  }

  private applyMatteCoverage(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const data = ctx.getImageData(0, 0, width, height);
    const pixels = data.data;
    // Director stage MATTE is native coverage, not an edge flood-fill of
    // visible RGB. For ordinary bitmap sprites the recovered MX 2004 path
    // treats exact white as zero coverage and leaves non-white artwork
    // opaque; mask/matte objects carry their own coverage provenance through
    // LingoImage.copyPixels.
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255) {
        pixels[offset + 3] = 0;
      } else if (pixels[offset + 3]! > 0) {
        pixels[offset + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  private imageHasNonOpaqueAlpha(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
    return imagePixelsHaveNonOpaqueAlpha(ctx.getImageData(0, 0, width, height).data);
  }

  private applyBoundaryWhiteCoverage(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const data = ctx.getImageData(0, 0, width, height);
    const pixels = data.data;
    const mask = boundaryConnectedWhiteMask(pixels, width, height);
    for (let index = 0; index < mask.length; index += 1) {
      const offset = index * 4;
      if (mask[index]) {
        pixels[offset + 3] = 0;
      } else if (pixels[offset + 3]! > 0) {
        pixels[offset + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  private applyBoundaryDominantCoverage(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const data = ctx.getImageData(0, 0, width, height);
    const pixels = data.data;
    const mask = boundaryConnectedDominantBorderMask(pixels, width, height);
    for (let index = 0; index < mask.length; index += 1) {
      const offset = index * 4;
      if (mask[index]) {
        pixels[offset + 3] = 0;
      } else if (pixels[offset + 3]! > 0) {
        pixels[offset + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  private applyDirectorMaskCoverage(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    maskImage: LingoImage,
  ): void {
    const mask = this.directorMaskCoverageImage(maskImage, width, height);
    if (!mask) return;
    const source = ctx.getImageData(0, 0, width, height);
    applyDirectorMaskCoveragePixels(source.data, mask.data, width, height);
    ctx.putImageData(source, 0, 0);
  }

  private directorMaskCoverageImage(maskImage: LingoImage, width: number, height: number): ImageData | null {
    const cached = this.directorMaskCoverage.get(maskImage);
    if (cached?.contentSignature === maskImage.contentSignature && cached.width === width && cached.height === height) {
      return cached.image;
    }
    const maskSource = maskImage.el;
    if (!maskSource) return null;
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    maskCtx.clearRect(0, 0, width, height);
    maskCtx.drawImage(maskSource as CanvasImageSource, 0, 0);
    const image = maskCtx.getImageData(0, 0, width, height);
    this.directorMaskCoverage.set(maskImage, { contentSignature: maskImage.contentSignature, width, height, image });
    return image;
  }

  /** Channel ink state that maps onto GPU compositing: additive inks blend
   * with 'add'; Subtract/Subtract Pin subtract the foreground RGB from the
   * stage; Darken over a direct PNG tints by the backColor filter (how entry
   * cars and room parts get colors). */
  private applyChannelInkState(node: Sprite, channel: SpriteChannel, directPngTexture: boolean): void {
    node.blendMode = directorSpriteBlendModeForInk(channel.ink);
    node.tint = directorSpriteTintForDirectBitmap(
      channel.ink,
      directPngTexture,
      channel.backColor,
      channel.bgColor,
    );
  }

  private applyShapeChannelInkState(node: Graphics, channel: SpriteChannel): void {
    node.blendMode = directorSpriteBlendModeForInk(channel.ink);
    node.alpha = 1;
  }

  /** Texture for a runtime image buffer, refreshed when the image mutates.
   * One texture per buffer; mutations re-upload the same source (Pixi
   * caches Texture.from by source, so creating new textures would return
   * the stale cached one). Incomplete images (journal replays pending) keep
   * their last upload to avoid per-mutation re-uploads during loading; the
   * completing mutation bumps the version again and refreshes. A changed
   * backing store (decoded drawable collapsed into a canvas) rebuilds the
   * texture outright. */
  private imageTextureFor(image: LingoImage): Texture | null {
    const el = image.el;
    if (!el) return null;
    const cached = this.imageTextures.get(image);
    if (cached && cached.el === el) {
      if (cached.contentSignature !== image.contentSignature && !image.incomplete) {
        if (cached.texture.source.width !== image.width || cached.texture.source.height !== image.height) {
          cached.texture.source.resize(image.width, image.height);
        }
        cached.texture.source.update();
        cached.contentSignature = image.contentSignature;
      }
      return cached.texture;
    }
    if (cached) {
      cached.texture.destroy(true);
      this.imageTextures.delete(image);
    }
    const texture = Texture.from(el as HTMLCanvasElement);
    texture.source.scaleMode = "nearest";
    this.imageTextures.set(image, { texture, contentSignature: image.contentSignature, el });
    return texture;
  }

  /** Drops cached GPU textures for an image buffer the movie no longer uses
   * (e.g. a text raster replaced by a different-sized one). */
  releaseImage(image: LingoImage): void {
    const cached = this.imageTextures.get(image);
    if (cached) {
      cached.texture.destroy(true);
      this.imageTextures.delete(image);
    }
    const byInk = this.inkTextures.get(image);
    if (byInk) {
      for (const entry of byInk.values()) {
        entry.texture?.destroy(true);
      }
      this.inkTextures.delete(image);
    }
  }

  textureCacheDiagnostics(): {
    readonly views: number;
    readonly underlays: number;
    readonly customHotelViewNodes: number;
    readonly userNameLabelNodes: number;
    readonly urlTextures: number;
    readonly loadingUrlTextures: number;
    readonly failedUrlTextures: number;
    readonly imageTextures: number;
    readonly textureRetryTimers: number;
    readonly lastSyncStats: { readonly considered: number; readonly skipped: number; readonly applied: number; readonly destroyed: number };
    readonly lastAppliedSamples: readonly AppliedChannelSample[];
  } {
    let urlTextures = 0;
    let loadingUrlTextures = 0;
    let failedUrlTextures = 0;
    for (const entry of this.textures.values()) {
      if (entry instanceof Texture) {
        urlTextures += 1;
      } else if (entry.state === "loading") {
        loadingUrlTextures += 1;
      } else if (entry.state === "failed") {
        failedUrlTextures += 1;
      }
    }
    return {
      views: this.views.size,
      underlays: this.underlays.size,
      customHotelViewNodes: this.customHotelViewNodes.size,
      userNameLabelNodes: this.userNameLabelNodes.size,
      urlTextures,
      loadingUrlTextures,
      failedUrlTextures,
      imageTextures: this.imageTextures.size,
      textureRetryTimers: this.textureRetryTimers.size,
      lastSyncStats: this.lastSyncStats,
      lastAppliedSamples: this.lastAppliedSamples,
    };
  }

  private recordAppliedSample(
    samples: AppliedChannelSample[],
    channel: SpriteChannel,
    member: NonNullable<SpriteChannel["member"]>,
    branch: string,
    key: string,
    previousSignature: string,
    nextSignature: string,
  ): void {
    if (samples.length >= 24) return;
    const diff = this.firstSignatureDiff(previousSignature, nextSignature);
    samples.push({
      channel: channel.number,
      branch,
      key: this.truncateDiagnosticValue(key),
      member: String(member.name ?? ""),
      memberType: String(member.type ?? ""),
      firstChangedField: diff.field,
      previous: this.truncateDiagnosticValue(diff.previous),
      next: this.truncateDiagnosticValue(diff.next),
    });
  }

  private firstSignatureDiff(previousSignature: string, nextSignature: string): {
    readonly field: string;
    readonly previous: string;
    readonly next: string;
  } {
    if (!previousSignature) return { field: "new", previous: "", next: nextSignature ? "present" : "" };
    const previous = previousSignature.split("|");
    const next = nextSignature.split("|");
    const length = Math.max(previous.length, next.length);
    for (let index = 0; index < length; index += 1) {
      if ((previous[index] ?? "") === (next[index] ?? "")) continue;
      return {
        field: SIGNATURE_BASE_FIELDS[index] ?? `extra${index - SIGNATURE_BASE_FIELDS.length}`,
        previous: previous[index] ?? "",
        next: next[index] ?? "",
      };
    }
    return { field: "unknown", previous: "", next: "" };
  }

  private truncateDiagnosticValue(value: string): string {
    return value.length <= 96 ? value : `${value.slice(0, 93)}...`;
  }

  private channelViewUnchanged(channelNumber: number, key: string, signature: string): boolean {
    const view = this.views.get(channelNumber);
    return !!view && view.key === key && view.signature === signature;
  }

  private channelPresentationCacheHit(
    channel: SpriteChannel,
    member: NonNullable<SpriteChannel["member"]>,
    focusedSprite: number,
  ): boolean {
    const view = this.views.get(channel.number);
    if (!view) return false;
    const focusSignature = this.focusPresentationSignature(channel, member, focusedSprite);
    return (
      view.channelVersion === channel.version &&
      view.motionPresentationSignature === this.motionPresentationSignature(channel) &&
      view.roomStagePresentationSignature === this.roomStagePresentationSignature &&
      view.focusPresentationSignature === focusSignature &&
      view.memberPresentationSignature === this.memberPresentationSignature(member)
    );
  }

  private rememberViewPresentation(
    view: StageView,
    channel: SpriteChannel,
    member: NonNullable<SpriteChannel["member"]>,
    focusedSprite: number,
  ): void {
    view.channelVersion = channel.version;
    view.motionPresentationSignature = this.motionPresentationSignature(channel);
    view.roomStagePresentationSignature = this.roomStagePresentationSignature;
    view.focusPresentationSignature = this.focusPresentationSignature(channel, member, focusedSprite);
    view.memberPresentationSignature = this.memberPresentationSignature(member);
  }

  private motionPresentationSignature(channel: SpriteChannel): string {
    if (!this.avatarInterpolation.tracks(channel.number)) return "";
    const transformed = this.transformChannelPoint(channel, channel.locH, channel.locV);
    return `${roundChannelPosition(transformed.x)},${roundChannelPosition(transformed.y)}:${channel.locZ}`;
  }

  private focusPresentationSignature(
    channel: SpriteChannel,
    member: NonNullable<SpriteChannel["member"]>,
    focusedSprite: number,
  ): string {
    if (member.type !== "field" && member.type !== "text") return "";
    const editable = channel.editable === 1 || Number(member.style.get("editable") ?? 0) === 1;
    if (!editable || channel.number !== focusedSprite) return "blurred";
    return `focused:${Math.floor(Date.now() / 500)}`;
  }

  private memberPresentationSignature(member: NonNullable<SpriteChannel["member"]>): string {
    const bitmap = member.bitmap;
    const inkUrls = bitmap?.inkUrls
      ? Object.entries(bitmap.inkUrls)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}:${value}`)
          .join(",")
      : "";
    return [
      member.slotNumber,
      member.castNumber,
      member.number,
      member.type,
      member.name,
      member.regX,
      member.regY,
      member.useAlpha,
      member.textVersion,
      this.renderValueSignature(member.paletteRef),
      bitmap?.pngUrl ?? "",
      bitmap?.width ?? "",
      bitmap?.height ?? "",
      bitmap?.regX ?? "",
      bitmap?.regY ?? "",
      bitmap?.decoded ? this.imageSignature(bitmap.decoded) : "",
      inkUrls,
      member.image ? this.imageSignature(member.image) : "",
      member.presentationImage ? this.imageSignature(member.presentationImage) : "",
      member.presentationImageKey,
      this.textRectsSignature(member.presentationSelectionRects),
      member.presentationCaretLoc
        ? `${member.presentationCaretLoc.x},${member.presentationCaretLoc.y},${member.presentationCaretLoc.height}`
        : "",
    ].join("|");
  }

  private channelPresentationSignature(
    channel: SpriteChannel,
    member: NonNullable<SpriteChannel["member"]>,
    key: string,
    ...extra: readonly unknown[]
  ): string {
    return [
      key,
      this.roomStagePresentationSignature,
      channel.number,
      channel.puppet,
      channel.visible,
      channel.locH,
      channel.locV,
      channel.locZ,
      channel.width,
      channel.height,
      channel.stretch,
      channel.ink,
      channel.blend,
      channel.flipH,
      channel.flipV,
      channel.rotation,
      channel.skew,
      channel.foreColor,
      channel.backColor,
      this.renderValueSignature(channel.color),
      this.renderValueSignature(channel.bgColor),
      channel.editable,
      member.slotNumber,
      member.castNumber,
      member.number,
      member.type,
      member.name,
      member.regX,
      member.regY,
      member.useAlpha,
      member.textVersion,
      this.renderValueSignature(member.paletteRef),
      member.bitmap?.pngUrl ?? "",
      member.bitmap?.width ?? "",
      member.bitmap?.height ?? "",
      member.bitmap?.regX ?? "",
      member.bitmap?.regY ?? "",
      member.bitmap?.decoded ? this.imageSignature(member.bitmap.decoded) : "",
      member.image ? this.imageSignature(member.image) : "",
      ...extra.map((value) => this.renderValueSignature(value)),
    ].join("|");
  }

  private imageSignature(image: LingoImage | null | undefined): string {
    if (!image) return "";
    return [
      this.imageId(image),
      image.width,
      image.height,
      image.depth,
      image.contentSignature,
      image.incomplete ? 1 : 0,
      image.useAlpha,
      this.renderValueSignature(image.paletteRef),
    ].join(":");
  }

  private textRectsSignature(
    rects: readonly { x: number; y: number; width: number; height: number }[] | null,
  ): string {
    if (!rects || rects.length === 0) return "";
    return rects
      .map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`)
      .join(";");
  }

  private renderValueSignature(value: unknown): string {
    if (value instanceof LingoColor) return `rgb(${value.r},${value.g},${value.b})`;
    if (value instanceof LingoSymbol) return `symbol(${value.name})`;
    if (value instanceof LingoImage) return `image(${this.imageSignature(value)})`;
    if (Array.isArray(value)) return `[${value.map((entry) => this.renderValueSignature(entry)).join(",")}]`;
    if (value && typeof value === "object") {
      const objectLike = value as { lingoToString?: () => string; name?: unknown; slotNumber?: unknown };
      if (typeof objectLike.lingoToString === "function") return objectLike.lingoToString();
      if (typeof objectLike.name === "string") return objectLike.name;
      if (typeof objectLike.slotNumber === "number") return `member(${objectLike.slotNumber})`;
    }
    return String(value ?? "");
  }

  private applySpriteNodeState(
    node: Sprite,
    channel: SpriteChannel,
    locH: number,
    locV: number,
    pivotX: number,
    pivotY: number,
  ): void {
    // Director loc is the cast member registration point. Pixi's pivot gives
    // the same result for untransformed sprites and keeps rotation/skew around
    // that registration point for mirrored member aliases.
    node.pivot.set(pivotX, pivotY);
    this.applyNodeState(node, channel, locH, locV);
  }

  private applyNodeState(node: StageNode, channel: SpriteChannel, x: number, y: number): void {
    const point = this.transformChannelPoint(channel, x, y);
    this.avatarInterpolation.applyPosition(channel.number, node, point.x, point.y);
    node.zIndex = channel.locZ;
    node.alpha = directorSpriteAlphaForInk(channel.ink, channel.blend);
    const aliasMirrorH = this.isAliasMirrorTransform(channel);
    node.rotation = ((aliasMirrorH ? 0 : channel.rotation) * Math.PI) / 180;
    node.skew.set(((aliasMirrorH ? 0 : channel.skew) * Math.PI) / 180, 0);
    const flipH = (channel.flipH ? -1 : 1) * (aliasMirrorH ? -1 : 1);
    const presentationScale = this.roomPresentationScaleFor(channel.number);
    node.scale.x = Math.abs(node.scale.x) * presentationScale * flipH;
    node.scale.y = Math.abs(node.scale.y) * presentationScale * (channel.flipV ? -1 : 1);
  }

  private isAliasMirrorTransform(channel: SpriteChannel): boolean {
    const normalize = (value: number): number => ((Math.round(value) % 360) + 360) % 360;
    return normalize(channel.rotation) === 180 && normalize(channel.skew) === 180;
  }

  private configurePixelNode(node: StageNode): void {
    if ("roundPixels" in node) {
      node.roundPixels = true;
    }
  }

  private isTextFieldNode(node: StageNode): node is TextFieldNode {
    return node instanceof Container && "__selectionNode" in node && "__textNode" in node && "__caretNode" in node;
  }

  private drawSelection(
    selection: Graphics,
    rects: readonly { x: number; y: number; width: number; height: number }[] | null,
    visible: boolean,
  ): void {
    selection.clear();
    if (!visible || !rects || rects.length === 0) return;
    selection.alpha = 0.55;
    for (const rect of rects) {
      selection.rect(Math.floor(rect.x), Math.floor(rect.y), Math.max(1, Math.ceil(rect.width)), Math.max(1, Math.round(rect.height)));
    }
    selection.fill(0x2f73d8);
  }

  private drawCaret(
    caret: Graphics,
    loc: { x: number; y: number; height: number } | null,
    fill: number,
    visible: boolean,
  ): void {
    caret.clear();
    if (!visible || !loc || Math.floor(Date.now() / 500) % 2 === 1) return;
    const height = Math.max(9, Math.round(loc.height));
    caret.rect(Math.ceil(loc.x) + 1, Math.floor(loc.y), 1, height);
    caret.fill(fill);
  }

  private colorValue(value: unknown, fallback: number): number {
    if (value instanceof LingoColor) return (value.r << 16) | (value.g << 8) | value.b;
    if (typeof value === "number") return value & 0xffffff;
    return fallback;
  }

  private textFill(value: LingoValue | undefined): number {
    if (value instanceof LingoColor) return (value.r << 16) | (value.g << 8) | value.b;
    if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim())) {
      return Number.parseInt(value.trim().replace(/^#/, ""), 16);
    }
    return 0x000000;
  }

  private textureFor(url: string): Texture | null {
    const cached = this.textures.get(url);
    if (cached instanceof Texture) return cached;
    const now = Date.now();
    if (cached?.state === "loading") return null;
    if (cached?.state === "failed" && (cached.failures > TEXTURE_LOAD_MAX_RETRIES || now < cached.nextRetryAt)) return null;
    const failures = cached?.state === "failed" ? cached.failures : 0;
    this.textures.set(url, { state: "loading", failures });
    this.clearTextureRetryTimer(url);
    Assets.load<Texture>(url)
      .then((texture) => {
        texture.source.scaleMode = "nearest";
        this.clearTextureRetryTimer(url);
        this.textures.set(url, texture);
        this.markDirty();
      })
      .catch(() => {
        const nextFailures = failures + 1;
        const retryable = nextFailures <= TEXTURE_LOAD_MAX_RETRIES;
        const retryDelay = retryable ? textureLoadRetryDelayMs(nextFailures) : Number.POSITIVE_INFINITY;
        this.textures.set(url, {
          state: "failed",
          failures: nextFailures,
          nextRetryAt: retryable ? Date.now() + retryDelay : Number.POSITIVE_INFINITY,
        });
        if (retryable) this.scheduleTextureRetry(url, retryDelay);
      });
    return null;
  }

  private scheduleTextureRetry(url: string, delayMs: number): void {
    this.clearTextureRetryTimer(url);
    this.textureRetryTimers.set(
      url,
      setTimeout(() => {
        this.textureRetryTimers.delete(url);
        this.markDirty();
      }, delayMs),
    );
  }

  private clearTextureRetryTimer(url: string): void {
    const timer = this.textureRetryTimers.get(url);
    if (!timer) return;
    clearTimeout(timer);
    this.textureRetryTimers.delete(url);
  }
}

export function userNameLabelZIndex(labelZ: number): number {
  return Math.max(0, Math.round(labelZ)) + 1;
}

export function normalizedUserNameLabelColor(value: unknown): string {
  if (typeof value !== "string") return "#ffffff";
  const text = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : "#ffffff";
}

function roundChannelPosition(value: number): number {
  return Math.round(value * 100) / 100;
}
