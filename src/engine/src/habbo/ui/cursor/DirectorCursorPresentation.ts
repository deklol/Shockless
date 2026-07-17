import { DirectorMovie } from "@director/Movie";
import { normalizeDirectorCursorValue } from "@director/cursor";
import { LingoImage } from "@director/imaging";
import { CastMember, CastRegistry } from "@director/members";
import { SpriteChannel } from "@director/sprites";
import { LingoList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";

/** Bridges Director cursor members to the browser canvas cursor. */
export interface DirectorCursorPresentationOptions {
  readonly movie: DirectorMovie;
  readonly members: CastRegistry;
  readonly canvas: HTMLCanvasElement;
}

export interface DirectorCursorPresentationState {
  readonly enabled: boolean;
  readonly cssCursor: string;
  readonly source: "sprite" | "global" | "default";
  readonly value: unknown;
  readonly member: null | {
    readonly name: string;
    readonly castName: string;
    readonly number: number;
    readonly hotspot: readonly [number, number];
  };
}

export class DirectorCursorPresentation {
  private enabled = true;
  private lastCssCursor = "";
  private readonly cursorImageCache = new Map<string, string>();
  private lastState: DirectorCursorPresentationState = {
    enabled: true,
    cssCursor: "default",
    source: "default",
    value: 0,
    member: null,
  };

  constructor(private readonly options: DirectorCursorPresentationOptions) {}

  setEnabled(enabled: boolean): DirectorCursorPresentationState {
    this.enabled = Boolean(enabled);
    return this.sync();
  }

  sync(): DirectorCursorPresentationState {
    const resolved = this.enabled ? this.resolveCurrentCursor() : this.defaultCursor();
    if (resolved.cssCursor !== this.lastCssCursor) {
      this.options.canvas.style.cursor = resolved.cssCursor;
      this.lastCssCursor = resolved.cssCursor;
    }
    this.lastState = resolved;
    return resolved;
  }

  state(): DirectorCursorPresentationState {
    return this.lastState;
  }

  private resolveCurrentCursor(): DirectorCursorPresentationState {
    const sprite = this.options.movie.inputSpriteAt(this.options.movie.mouseH, this.options.movie.mouseV);
    const spriteCursor = sprite ? normalizeDirectorCursorValue(sprite.cursor as LingoValue) : 0;
    const spriteResolved = this.resolveCursorValue(spriteCursor);
    if (spriteResolved) {
      return {
        ...spriteResolved,
        source: "sprite",
      };
    }
    if (sprite && this.options.movie.channelEditable(sprite) && isDefaultCursorValue(spriteCursor)) {
      return {
        enabled: this.enabled,
        cssCursor: "text",
        source: "sprite",
        value: 1,
        member: null,
      };
    }

    const globalCursor = normalizeDirectorCursorValue(this.options.movie.globalCursor);
    const globalResolved = this.resolveCursorValue(globalCursor);
    if (globalResolved) {
      return {
        ...globalResolved,
        source: "global",
      };
    }

    return this.defaultCursor();
  }

  private defaultCursor(): DirectorCursorPresentationState {
    return {
      enabled: this.enabled,
      cssCursor: "default",
      source: "default",
      value: 0,
      member: null,
    };
  }

  private resolveCursorValue(value: LingoValue): Omit<DirectorCursorPresentationState, "source"> | null {
    const normalized = normalizeDirectorCursorValue(value);
    if (isDefaultCursorValue(normalized)) return null;
    const systemCursor = directorSystemCursorCss(normalized);
    if (systemCursor) {
      return {
        enabled: this.enabled,
        cssCursor: systemCursor,
        value: debugCursorValue(normalized),
        member: null,
      };
    }
    const cursor = this.cursorMembers(normalized);
    const member = cursor?.member ?? null;
    if (member?.bitmap?.pngUrl) {
      const hotspot = cursorHotspot(member);
      const cursorUrl = this.cursorUrl(member, cursor?.maskMember ?? null);
      return {
        enabled: this.enabled,
        cssCursor: `url("${escapeCssUrl(cursorUrl)}") ${hotspot[0]} ${hotspot[1]}, ${fallbackCursorForMember(member)}`,
        value: debugCursorValue(normalized),
        member: {
          name: member.name,
          castName: member.castName,
          number: member.number,
          hotspot,
        },
      };
    }
    if (cursorName(normalized).includes("finger")) {
      return {
        enabled: this.enabled,
        cssCursor: "pointer",
        value: debugCursorValue(normalized),
        member: null,
      };
    }
    return null;
  }

  private cursorMembers(value: LingoValue): { member: CastMember; maskMember: CastMember | null } | null {
    const member = this.memberFromCursorValue(value);
    if (!member) return null;
    const explicitMask = value instanceof LingoList ? this.memberFromCursorValue(value.items[1] as LingoValue) : null;
    return {
      member,
      maskMember: explicitMask ?? this.maskMemberFor(member),
    };
  }

  private memberFromCursorValue(value: LingoValue): CastMember | null {
    if (value instanceof CastMember) return value;
    if (value instanceof LingoList) {
      const first = value.items[0];
      return this.memberFromCursorValue(first as LingoValue);
    }
    if (typeof value === "number" && value > 32) return this.options.members.find(value, null);
    const name = cursorName(value);
    if (!name) return null;
    return this.options.members.find(name, null);
  }

  private maskMemberFor(member: CastMember): CastMember | null {
    const name = member.name.trim();
    if (!name || name.toLowerCase().endsWith(".mask")) return null;
    return this.options.members.find(`${name}.mask`, member.castName) ?? null;
  }

  private cursorUrl(member: CastMember, maskMember: CastMember | null): string {
    const source = member.effectiveImage();
    const mask = maskMember?.effectiveImage() ?? null;
    const cacheKey = [
      member.castName,
      member.number,
      source.contentSignature,
      maskMember?.castName ?? "",
      maskMember?.number ?? 0,
      mask?.contentSignature ?? "",
    ].join("\n");
    const cached = this.cursorImageCache.get(cacheKey);
    if (cached) return cached;
    const cursorUrl = composeDirectorCursorUrl(source, mask, member.bitmap?.pngUrl ?? "");
    this.cursorImageCache.set(cacheKey, cursorUrl);
    return cursorUrl;
  }
}

function isDefaultCursorValue(value: LingoValue): boolean {
  if (value instanceof LingoVoid) return true;
  if (typeof value === "number") return value === 0 || value === -1;
  if (value instanceof LingoSymbol) return value.name.toLowerCase() === "arrow";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "" || normalized === "arrow" || normalized === "#arrow" || normalized === "cursor.arrow";
  }
  return false;
}

function directorSystemCursorCss(value: LingoValue): string | null {
  if (typeof value === "number") {
    if (value === 1) return "text";
    if (value === 2 || value === 3) return "crosshair";
    if (value === 4) return "wait";
    if (value === 200) return "none";
    return null;
  }
  const name = cursorName(value);
  if (name === "cursor.ibeam" || name === "ibeam") return "text";
  if (name === "cursor.crosshair" || name === "crosshair" || name === "cursor.crossbar" || name === "crossbar") return "crosshair";
  if (name === "cursor.timer" || name === "timer") return "wait";
  return null;
}

function cursorName(value: LingoValue): string {
  if (value instanceof LingoSymbol) return value.name.toLowerCase();
  if (typeof value === "string") return value.trim().replace(/^#/, "").toLowerCase();
  return "";
}

function cursorHotspot(member: CastMember): readonly [number, number] {
  const width = Math.max(1, member.bitmap?.width ?? 1);
  const height = Math.max(1, member.bitmap?.height ?? 1);
  const x = Math.max(0, Math.min(width - 1, Math.round(member.regX || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.round(member.regY || 0)));
  return [x, y];
}

function fallbackCursorForMember(member: CastMember): string {
  return member.name.toLowerCase().includes("finger") ? "pointer" : "default";
}

function escapeCssUrl(value: string): string {
  return value.replace(/["\\\n\r\f]/g, (char) => `\\${char}`);
}

function composeDirectorCursorUrl(source: LingoImage, mask: LingoImage | null, fallbackUrl: string): string {
  const sourceElement = source.el as CanvasImageSource | null;
  if (!sourceElement) return fallbackUrl;
  const width = Math.max(1, Math.min(16, source.width));
  const height = Math.max(1, Math.min(16, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallbackUrl;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sourceElement, 0, 0, width, height, 0, 0, width, height);
  if (!mask) return canvas.toDataURL("image/png");

  const maskElement = mask.el as CanvasImageSource | null;
  if (!maskElement) return fallbackUrl;
  const sourcePixels = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  const maskWidth = Math.min(width, mask.width);
  const maskHeight = Math.min(height, mask.height);
  ctx.drawImage(maskElement, 0, 0, maskWidth, maskHeight, 0, 0, maskWidth, maskHeight);
  const maskPixels = ctx.getImageData(0, 0, width, height);
  applyDirectorCursorMask(sourcePixels.data, maskPixels.data);
  ctx.putImageData(sourcePixels, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Director's 1-bit cursor mask is black where the cursor is visible and
 * white where it is transparent. The mask defines opacity; source alpha does
 * not participate, otherwise opaque white cursor interiors become faint. */
export function applyDirectorCursorMask(sourceData: Uint8ClampedArray, maskData: Uint8ClampedArray): void {
  const limit = Math.min(sourceData.length, maskData.length);
  for (let offset = 0; offset + 3 < limit; offset += 4) {
    const maskAlpha = maskData[offset + 3] ?? 0;
    const luminance = Math.round(
      0.299 * (maskData[offset] ?? 0) +
      0.587 * (maskData[offset + 1] ?? 0) +
      0.114 * (maskData[offset + 2] ?? 0),
    );
    sourceData[offset + 3] = Math.round(((255 - luminance) * maskAlpha) / 255);
  }
  for (let offset = limit; offset + 3 < sourceData.length; offset += 4) {
    sourceData[offset + 3] = 0;
  }
}

function debugCursorValue(value: LingoValue): unknown {
  if (value instanceof LingoSymbol) return `#${value.name}`;
  if (value instanceof CastMember) return `(member ${value.name})`;
  if (value instanceof LingoList) {
    return value.items.map((item) => debugCursorValue(item as LingoValue));
  }
  return value;
}
