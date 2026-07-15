import type { DirectorMovie } from "@director/Movie";
import { CastMember } from "@director/members";
import { LingoImage } from "@director/imaging";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoList, type LingoValue } from "@director/values";
import { bitmapUrlForInk } from "../../../render/ink";
import {
  coerceDebugValue,
  debugValue,
  instancePropValue,
  summarizeObject,
  summarizeSprite,
  summarizeValue,
} from "../../room/RoomRuntimeDiagnostics";
import type { SourceWindowInteractionController } from "./SourceWindowInteractionController";

interface SourceWindowDiagnosticsOptions {
  readonly movie: DirectorMovie;
  readonly interaction: SourceWindowInteractionController;
  readonly valueToId: (value: LingoValue) => string;
  readonly stagePointToSource: (point: { x: number; y: number }) => { x: number; y: number };
  readonly stageClick: (x: number, y: number) => void;
}

/** Read-only diagnostics for Habbo's Source-window system and rendered sprites. */
export class SourceWindowDiagnostics {
  constructor(private readonly options: SourceWindowDiagnosticsOptions) {}

  imageDataSummary(image: LingoValue): unknown {
    if (!(image instanceof LingoImage)) return summarizeValue(image, 3);
    const el = image.el as HTMLCanvasElement | undefined;
    return {
      type: "image",
      size: [image.width, image.height],
      incomplete: image.incomplete,
      version: image.version,
      dataUrl: el && "toDataURL" in el ? el.toDataURL() : null,
    };
  }

  paletteSample(colors: readonly number[] | null | undefined): unknown {
    if (!colors || colors.length === 0) return null;
    const wanted = [0, 1, 2, 80, 81, 82, 83, 86, 128, 129, 130, 131, 132, 255];
    const entries: Record<string, string> = {};
    for (const index of wanted) {
      const rgb = colors[index];
      if (rgb === undefined) continue;
      entries[String(index)] = `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;
    }
    return { count: colors.length, entries };
  }

  summarizeSourceWindow(id: string, includeImages = false): unknown {
    const windowManager = this.options.interaction.manager();
    if (!windowManager) return { error: "window manager unavailable" };
    const windowObject = this.options.interaction.windowById(windowManager, coerceDebugValue(id));
    if (!windowObject) return { error: `window not found: ${id}` };
    return {
      id,
      class: windowObject.module.scriptName,
      visible: debugValue(instancePropValue(windowObject, "pvisible")),
      loc: [debugValue(instancePropValue(windowObject, "plocx")), debugValue(instancePropValue(windowObject, "plocy"))],
      size: [debugValue(instancePropValue(windowObject, "pwidth")), debugValue(instancePropValue(windowObject, "pheight"))],
      locZ: debugValue(instancePropValue(windowObject, "plocz")),
      clientRect: debugValue(instancePropValue(windowObject, "pclientrect")),
      spriteList: summarizeValue(instancePropValue(windowObject, "pspritelist"), 2),
      memberList: summarizeValue(instancePropValue(windowObject, "pmemberlist"), 1),
      elements: this.options.interaction
        .elements(windowObject)
        .map((element) => this.summarizeWindowElement(element, includeImages, 1)),
    };
  }

  elementsAtPoint(x: number, y: number, includeImages = false): unknown[] {
    const windowManager = this.options.interaction.manager();
    if (!windowManager) return [];
    const result: Array<{ windowIndex: number; elementZ: number; summary: Record<string, unknown> }> = [];
    const ids = this.options.interaction.ids(windowManager);
    for (let idIndex = 0; idIndex < ids.length; idIndex += 1) {
      const id = ids[idIndex]!;
      const windowObject = this.options.interaction.windowById(windowManager, id);
      if (!windowObject || !this.options.interaction.windowVisible(windowObject)) continue;
      for (const element of this.options.interaction.allElements(windowObject)) {
        if (!this.options.interaction.elementVisible(element)) continue;
        const rect = this.options.interaction.elementRect(element);
        if (!rect || !this.options.interaction.rectContains(rect, x, y)) continue;
        const sprite = instancePropValue(element, "psprite");
        result.push({
          windowIndex: idIndex,
          elementZ: sprite instanceof SpriteChannel ? sprite.locZ : 0,
          summary: {
            windowId: this.options.valueToId(id),
            windowLocZ: debugValue(instancePropValue(windowObject, "plocz")),
            element: this.summarizeWindowElement(element, includeImages, 0),
          },
        });
      }
    }
    result.sort((left, right) => right.windowIndex - left.windowIndex || right.elementZ - left.elementZ);
    return result.map((entry) => entry.summary);
  }

  resolvedSpriteSummary(sprite: SpriteChannel, includeImages = false): Record<string, unknown> {
    const rect = this.options.movie.spriteBounds(sprite.number);
    const member = sprite.member;
    return {
      ...(summarizeSprite(sprite, 4) as Record<string, unknown>),
      rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
      visible: sprite.visible,
      puppet: sprite.puppet,
      stretch: sprite.stretch,
      trails: sprite.trails,
      foreColor: sprite.foreColor,
      backColor: sprite.backColor,
      color: debugValue(sprite.color),
      bgColor: debugValue(sprite.bgColor),
      cursor: summarizeValue(sprite.cursor as LingoValue, 1),
      render: this.resolvedRenderPath(sprite),
      member: member ? this.memberSummary(member, includeImages) : null,
      sourceWindowOwners: this.sourceWindowElementsForSprite(sprite, includeImages),
    };
  }

  hitProbe(x: number, y: number): unknown[] {
    return this.options.movie.spritesAt(Number(x), Number(y)).map((channel) => ({
      ...(summarizeSprite(channel, 3) as Record<string, unknown>),
      rect: (() => {
        const rect = this.options.movie.spriteBounds(channel.number);
        return rect ? [rect.left, rect.top, rect.right, rect.bottom] : null;
      })(),
      pixel: this.spritePixelAt(channel, Number(x), Number(y)),
    }));
  }

  sourceInputProbe(x: number, y: number, includeImages = false): Record<string, unknown> {
    const stageX = Number(x);
    const stageY = Number(y);
    const sourcePoint = this.options.stagePointToSource({ x: stageX, y: stageY });
    const summarizeTarget = (channel: SpriteChannel | null): unknown =>
      channel
        ? {
            ...this.resolvedSpriteSummary(channel, includeImages),
            pixel: this.spritePixelAt(channel, sourcePoint.x, sourcePoint.y),
          }
        : null;
    return {
      stagePoint: [stageX, stageY],
      sourcePoint: [sourcePoint.x, sourcePoint.y],
      sourceWindowAtStagePoint: this.options.interaction.containsPoint(stageX, stageY),
      sourceWindowAtSourcePoint: this.options.interaction.containsPoint(sourcePoint.x, sourcePoint.y),
      inputDownTarget: summarizeTarget(
        this.options.movie.inputSpriteAt(sourcePoint.x, sourcePoint.y, ["mousedown", "mouseup", "mouseupoutside"]),
      ),
      inputUpTarget: summarizeTarget(
        this.options.movie.inputSpriteAt(sourcePoint.x, sourcePoint.y, ["mouseup", "mouseupoutside", "mousedown"]),
      ),
      sourceElementsAtStagePoint: this.elementsAtPoint(stageX, stageY, includeImages),
      sourceElementsAtSourcePoint: this.elementsAtPoint(sourcePoint.x, sourcePoint.y, includeImages),
      hitSprites: this.options.movie
        .spritesAt(sourcePoint.x, sourcePoint.y)
        .slice(0, 12)
        .map((channel) => ({
          ...this.resolvedSpriteSummary(channel, includeImages),
          pixel: this.spritePixelAt(channel, sourcePoint.x, sourcePoint.y),
        })),
    };
  }

  clickWindowElement(windowId: string, elementId: string): unknown {
    const windowManager = this.options.interaction.manager();
    if (!windowManager) return { clicked: false, error: "window manager unavailable" };
    const windowObject = this.options.interaction.windowById(windowManager, coerceDebugValue(windowId));
    if (!windowObject) return { clicked: false, error: `window not found: ${windowId}` };
    let element: LingoValue;
    try {
      element = this.options.movie.runtime.callMethod(windowObject, "getelement", [coerceDebugValue(elementId)]);
    } catch (error) {
      return { clicked: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!(element instanceof ScriptInstance)) {
      return { clicked: false, error: `element not found: ${elementId}`, value: summarizeValue(element, 2) };
    }
    const sprite = instancePropValue(element, "psprite");
    if (!(sprite instanceof SpriteChannel)) {
      return { clicked: false, error: `element has no sprite: ${elementId}`, value: summarizeObject(element, 1) };
    }
    const rect = this.options.interaction.elementRect(element) ?? this.options.movie.spriteBounds(sprite.number);
    if (!rect) return { clicked: false, error: `element has no hit rectangle: ${elementId}`, sprite: sprite.number };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    this.options.stageClick(x, y);
    return {
      clicked: true,
      windowId,
      elementId,
      sprite: sprite.number,
      point: [x, y],
      rect: [rect.left, rect.top, rect.right, rect.bottom],
      inputAfterClick: this.sourceInputProbe(x, y, false),
    };
  }

  private imageSummary(image: LingoValue | undefined, includeData = false): unknown {
    if (!(image instanceof LingoImage)) return summarizeValue(image, 2);
    const el = image.el as HTMLCanvasElement | undefined;
    const summary: Record<string, unknown> = {
      type: "image",
      size: [image.width, image.height],
      depth: image.depth,
      paletteRef: debugValue(image.paletteRef),
      matteCoveragePolicy: image.matteCoveragePolicyForDebug(),
      incomplete: image.incomplete,
      version: image.version,
    };
    if (includeData) summary.dataUrl = el && "toDataURL" in el ? el.toDataURL() : null;
    return summary;
  }

  private memberSummary(value: LingoValue | undefined, includeImages = false): unknown {
    if (!(value instanceof CastMember)) return summarizeValue(value, 2);
    const image = value.image ?? null;
    const decoded = value.bitmap?.decoded ?? null;
    return {
      name: value.name,
      type: value.type,
      number: value.number,
      slotNumber: value.slotNumber,
      castNumber: value.castNumber,
      text: value.type === "field" || value.type === "text" ? value.text : undefined,
      style: Object.fromEntries(value.style),
      textRuns: value.textStyleRuns,
      regPoint: [value.regX, value.regY],
      bitmapSize: value.bitmap ? [value.bitmap.width, value.bitmap.height] : null,
      image: image ? this.imageSummary(image, includeImages) : null,
      decoded: decoded ? this.imageSummary(decoded, includeImages) : null,
      presentationImage: value.presentationImage ? this.imageSummary(value.presentationImage, includeImages) : null,
      paletteColors: this.paletteSample(value.paletteColors),
      bitmapPaletteColors: this.paletteSample(value.bitmap?.paletteColors),
      bitmapInk8AlphaPolicy: value.bitmap?.ink8AlphaPolicy ?? null,
    };
  }

  private summarizeWindowElement(element: ScriptInstance, includeImages = false, depth = 1): Record<string, unknown> {
    const sprite = instancePropValue(element, "psprite");
    const buffer = instancePropValue(element, "pbuffer");
    const member = instancePropValue(element, "pmember");
    const textMember = instancePropValue(element, "ptextmem");
    const image = instancePropValue(element, "pimage");
    const children = instancePropValue(element, "pelemlist");
    const childItems =
      children instanceof LingoList
        ? children.items.filter((entry): entry is ScriptInstance => entry instanceof ScriptInstance)
        : [];
    const rect = this.options.interaction.elementRect(element);
    const presentedImage =
      buffer instanceof CastMember && buffer.image
        ? buffer.image
        : member instanceof CastMember && member.image
          ? member.image
          : image instanceof LingoImage
            ? image
            : null;
    return {
      id: debugValue(instancePropValue(element, "pid")),
      class: element.module.scriptName,
      type: this.options.interaction.elementType(element),
      visible: debugValue(instancePropValue(element, "pvisible")),
      loc: [debugValue(instancePropValue(element, "plocx")), debugValue(instancePropValue(element, "plocy"))],
      own: [
        debugValue(instancePropValue(element, "pownx")),
        debugValue(instancePropValue(element, "powny")),
        debugValue(instancePropValue(element, "pownw")),
        debugValue(instancePropValue(element, "pownh")),
      ],
      size: [debugValue(instancePropValue(element, "pwidth")), debugValue(instancePropValue(element, "pheight"))],
      scale: [debugValue(instancePropValue(element, "pscaleh")), debugValue(instancePropValue(element, "pscalev"))],
      rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
      sprite: summarizeSprite(sprite, 2),
      buffer: this.memberSummary(buffer, includeImages),
      member: this.memberSummary(member, includeImages),
      image: this.imageSummary(image, includeImages),
      presentedImage: this.imageSummary(presentedImage ?? undefined, includeImages),
      textMember: this.memberSummary(textMember, includeImages),
      fontData: summarizeValue(instancePropValue(element, "pfontdata"), 2),
      params: summarizeValue(instancePropValue(element, "pparams"), 1),
      props: summarizeValue(instancePropValue(element, "pprops"), 1),
      scrolls: summarizeValue(instancePropValue(element, "pscrolls"), 1),
      childCount: childItems.length,
      children: depth > 0 ? childItems.map((child) => this.summarizeWindowElement(child, includeImages, depth - 1)) : [],
    };
  }

  private sourceWindowElementsForSprite(sprite: SpriteChannel, includeImages = false): unknown[] {
    const windowManager = this.options.interaction.manager();
    if (!windowManager) return [];
    const result: unknown[] = [];
    for (const id of this.options.interaction.ids(windowManager)) {
      const windowObject = this.options.interaction.windowById(windowManager, id);
      if (!windowObject) continue;
      for (const element of this.options.interaction.elements(windowObject).flatMap((entry) => this.options.interaction.elementTree(entry))) {
        if (instancePropValue(element, "psprite") !== sprite) continue;
        result.push({
          windowId: this.options.valueToId(id),
          windowClass: windowObject.module.scriptName,
          element: this.summarizeWindowElement(element, includeImages, 0),
        });
      }
    }
    return result;
  }

  private imageDimensions(image: LingoImage | null | undefined): unknown {
    return image
      ? {
          size: [image.width, image.height],
          depth: image.depth,
          incomplete: image.incomplete,
          version: image.version,
          paletteRef: debugValue(image.paletteRef),
        }
      : null;
  }

  private resolvedRenderPath(sprite: SpriteChannel): Record<string, unknown> {
    const member = sprite.member;
    if (!member) return { path: "empty" };
    if (member.image) {
      return {
        path: "member.image-buffer",
        image: this.imageDimensions(member.image),
        reason: "Runtime composited image buffer; this is the path used by source windows and many wrapper elements.",
      };
    }
    if (member.type === "field" || member.type === "text") {
      return {
        path: "text.presentationImage",
        image: this.imageDimensions(member.presentationImage),
        reason: "Director text/field member raster prepared by Movie.prepareTextSpriteImages.",
      };
    }
    if (member.bitmap?.pngUrl) {
      const selectedUrl = bitmapUrlForInk(member.bitmap, sprite.ink);
      return {
        path: selectedUrl === member.bitmap.pngUrl ? "bitmap.png" : "bitmap.ink-png",
        url: selectedUrl,
        bitmap: {
          size: [member.bitmap.width, member.bitmap.height],
          regPoint: [member.bitmap.regX, member.bitmap.regY],
          rawUrl: member.bitmap.pngUrl,
          decoded: this.imageDimensions(member.bitmap.decoded ?? null),
          inkVariants: Object.keys(member.bitmap.inkUrls ?? {}),
          selectedInk: sprite.ink,
          hasPaletteIndices: !!member.bitmap.paletteIndexData,
        },
        reason: "Decoded/generated bitmap asset selected by member bitmap metadata.",
      };
    }
    if (member.bitmap?.decoded) {
      return {
        path: "bitmap.decoded-buffer",
        image: this.imageDimensions(member.bitmap.decoded),
        reason: "Decoded bitmap buffer without a source png URL.",
      };
    }
    if (member.type === "shape") {
      return { path: "shape", reason: "Director shape sprite drawn by renderer from channel dimensions and color." };
    }
    return { path: "unsupported", memberType: member.type };
  }

  spritePixelAt(channel: SpriteChannel, x: number, y: number): unknown {
    const rect = this.options.movie.spriteBounds(channel.number);
    const image = channel.member?.image ?? channel.member?.bitmap?.decoded ?? null;
    if (!rect || !image || rect.width <= 0 || rect.height <= 0) return null;
    const sourceX = Math.max(0, Math.min(image.width - 1, Math.floor(((x - rect.left) / rect.width) * image.width)));
    const sourceY = Math.max(0, Math.min(image.height - 1, Math.floor(((y - rect.top) / rect.height) * image.height)));
    const pixel = image.getPixel(sourceX, sourceY);
    const hex = `#${[pixel.r, pixel.g, pixel.b].map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    return { source: [sourceX, sourceY], rgb: [pixel.r, pixel.g, pixel.b], hex };
  }
}
