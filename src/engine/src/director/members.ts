import { LingoColor } from "./geometry";
import { LingoList, LingoObjectLike, LingoSymbol, LingoValue, LINGO_VOID } from "./values";
import { LingoImage } from "./imaging";
import { paletteTableForBitmapDepth } from "./palettes";
import type { DirectorSoundManifestMedia, DirectorSoundMedia } from "./audio/media";

/**
 * Cast member model. Member metadata comes from the release306 manifests:
 * names/types from the ProjectorRays manifest, field text from the
 * text-fields manifest, bitmap geometry + decoded PNG paths from the
 * bitmap-assets manifest. Members created at runtime by generated code
 * (Resource Manager createMember) live alongside extracted ones.
 */

export interface BitmapInfo {
  /** Source member name from the bitmap manifest. This may differ from the
   * primary cast member name when imported external casts overlay text room
   * definitions and bitmap visual assets onto the same numeric slot. */
  memberName?: string;
  width: number;
  height: number;
  regX: number;
  regY: number;
  /** URL the renderer can fetch (served from the donor tree, read-only). */
  pngUrl: string | null;
  /** Ink-specific transparent/composited variants from generated asset data. */
  inkUrls?: Record<string, string>;
  /** Palette-indexed source pixels, when the original member is indexed. */
  paletteIndexData?: string;
  /** Palette used by the generated PNG; fallback when no runtime palette is assigned. */
  paletteColors?: number[];
  /** Extracted source palette identity for indexed bitmaps. */
  bitDepth?: number;
  paletteName?: string;
  paletteCastName?: string;
  paletteMember?: number;
  sourcePaletteCastLib?: number;
  sourcePaletteMember?: number;
  resolvedPaletteCastLib?: number;
  resolvedPaletteMember?: number;
  sourcePaletteKind?: string;
  paletteResolution?: string;
  sourcePaletteReferenceValid?: boolean;
  /** Compiler-provenance for image.createMatte() coverage. */
  ink8AlphaPolicy?: string;
  /** Decoded pixel buffer (browser); filled by the cast preload pipeline. */
  decoded?: LingoImage | null;
  /** Decoded palette-indexed bytes, cached from paletteIndexData. */
  paletteIndices?: Uint8Array;
  /** Palette-rendered images keyed by the current palette identity. */
  paletteImages?: Map<string, LingoImage>;
}

export interface TextStyleRun {
  start: number;
  end: number;
  property: string;
  value: LingoValue;
}

interface BitmapCandidate extends BitmapInfo {
  memberName: string;
}

interface ManifestTextSpan {
  start: number;
  end: number;
  underline?: boolean;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
}

interface ManifestMemberEntry {
  number: number;
  name: string;
  type: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  wordWrap?: boolean | number;
  fontWeight?: string;
  textAlign?: string;
  color?: string;
  underline?: boolean;
  textSpans?: ManifestTextSpan[];
  assetPath?: string;
  sound?: DirectorSoundManifestMedia;
}

/** Browser boot harness hook: asked to fetch+decode a member's bitmap when
 * generated code touches its image before the eager decode pipeline got to
 * it. Unset in Node, where images are inert. */
let requestImageDecode: ((member: CastMember) => void) | null = null;

export function setImageDecodeRequester(requester: ((member: CastMember) => void) | null): void {
  requestImageDecode = requester;
}

class InlinePaletteRef implements LingoObjectLike {
  readonly lingoType = "palette";

  constructor(
    public readonly name: string,
    public readonly paletteColors: readonly number[],
  ) {}

  lingoToString(): string {
    return `(palette ${this.name})`;
  }
}

export class CastMember implements LingoObjectLike {
  readonly lingoType = "member";
  text: string;
  bitmap: BitmapInfo | null;
  sound: DirectorSoundMedia | null;
  /** Editable Director Sound-member Loop property. It is runtime state, not
   * inferred from media loop markers or unrelated CASt flags. */
  soundLoop = false;
  /** Director Mask ink (9) uses the cast member immediately following the
   * visible member as the mask source. CastRegistry maintains this adjacency
   * per loaded cast so renderers do not guess from member names. */
  nextCastMember: CastMember | null = null;
  /** Lookup-only alias for imported bitmap identities whose authored numeric
   * slot is occupied by another member. These must not affect Director member
   * adjacency or eager cast image preload. */
  syntheticAlias = false;
  /** Runtime image buffer (set by image()/copyPixels compositing, or lazily
   * decoded from the member's PNG). The renderer prefers this over the PNG
   * URL when present. */
  image: LingoImage | null = null;
  /** Rasterized Director text/field sprite image prepared by the movie host.
   * This is presentation-only; source `member.image` still derives from text
   * state through the Director host. */
  presentationImage: LingoImage | null = null;
  presentationImageKey = "";
  /** Bumped on every text/style mutation; lets per-frame presentation checks
   * compare one integer instead of serializing text + styles. */
  textVersion = 0;
  presentationCaretLoc: { x: number; y: number; height: number } | null = null;
  presentationSelectionRects: Array<{ x: number; y: number; width: number; height: number }> | null = null;
  /** Original image object assigned to member.image. Pixels are duplicated
   * into image, but palette writes need to stay visible on the source object
   * some generated window code still holds. */
  imageSource: LingoImage | null = null;
  /** Bitmap alpha participation flag. Director exposes `useAlpha` on bitmap
   * members as well as image objects; member writes must affect any current
   * runtime image surface and future materialized images. */
  useAlpha = 1;
  /** Registration point override (window compositing sets member.regPoint). */
  regPointOverride: { x: number; y: number } | null = null;
  /** Bitmap palette reference. Director exposes both `paletteRef` and
   * `palette`; the release306 window/visualizer code reads and writes both.
   * Internally both properties represent the active bitmap palette
   * association, so a write to either one must affect later `member.image`
   * materialization. */
  private _paletteRef: LingoValue = LingoSymbol.for("systemMac");
  private _palette: LingoValue = LingoSymbol.for("systemMac");
  /** Director text/field styling properties (color, font, alignment, ...);
   * stored faithfully, consumed by the text renderer. */
  readonly style = new Map<string, LingoValue>();
  /** Palette member color table, when this member's type is #palette. */
  paletteColors: number[] | null = null;
  /** Range-level text styles written through member.char/start..end chunks.
   * Later writes win, matching the source's reset-then-BBCode sequence. */
  readonly textStyleRuns: TextStyleRun[] = [];

  get regX(): number {
    return this.regPointOverride?.x ?? this.bitmap?.regX ?? 0;
  }

  get regY(): number {
    return this.regPointOverride?.y ?? this.bitmap?.regY ?? 0;
  }

  get paletteRef(): LingoValue {
    return this._paletteRef;
  }

  set paletteRef(value: LingoValue) {
    this.assignPaletteAssociation(value);
  }

  get palette(): LingoValue {
    return this._palette;
  }

  set palette(value: LingoValue) {
    this.assignPaletteAssociation(value);
  }

  /** Image buffer for compositing: runtime image, else decoded PNG, else a
   * persistent pending placeholder that fills itself (and replays journaled
   * copies) when the bitmap decode arrives. */
  effectiveImage(): LingoImage {
    if (this.image) return this.applyImageState(this.image);
    if (this.bitmap) {
      const indexed = this.paletteIndexedImage();
      if (indexed) return this.applyImageState(indexed);
      if (this.bitmap.decoded) return this.applyImageState(this.bitmap.decoded);
      if (this.bitmap.pngUrl) {
        const placeholder = LingoImage.pendingPlaceholder(this.bitmap.width, this.bitmap.height)
          .setMatteCoveragePolicy(this.bitmap.ink8AlphaPolicy);
        this.bitmap.decoded = placeholder;
        requestImageDecode?.(this);
        return this.applyImageState(placeholder);
      }
    }
    return this.applyImageState(new LingoImage(this.bitmap?.width ?? 1, this.bitmap?.height ?? 1, 32));
  }

  /** Director exposes member.image as a live, writable bitmap surface. A
   * script that reads member("x").image and then copyPixels into that image is
   * mutating the member itself, so renderers must prefer the same surface from
   * then on. Decode/cache images remain source material and are duplicated
   * here to avoid aliasing immutable cast assets. */
  mutableImage(): LingoImage {
    if (this.image) return this.image;
    const source = this.effectiveImage();
    this.image = source.duplicate();
    this.image.paletteRef = this.currentPaletteRef();
    this.image.useAlpha = this.useAlpha;
    return this.image;
  }

  private applyImageState(image: LingoImage): LingoImage {
    image.useAlpha = this.useAlpha;
    image.paletteRef = this.currentPaletteRef();
    return image;
  }

  private paletteIndexedImage(): LingoImage | null {
    const bitmap = this.bitmap;
    if (!bitmap?.paletteIndexData) return null;
    const colors = this.currentPaletteColors() ?? bitmap.paletteColors;
    if (!colors || colors.length === 0) return null;
    const paletteKey = this.currentPaletteKey(colors);
    const paletteRef = this.currentPaletteRef();
    const bitDepth = bitmap.bitDepth ?? 8;
    bitmap.paletteImages ??= new Map();
    const cached = bitmap.paletteImages.get(paletteKey);
    if (cached) return cached;
    bitmap.paletteIndices ??= decodeBase64Bytes(bitmap.paletteIndexData);
    const image = LingoImage.fromPaletteIndices(
      bitmap.width,
      bitmap.height,
      bitmap.paletteIndices,
      colors,
      paletteRef,
      bitDepth,
    ).setMatteCoveragePolicy(bitmap.ink8AlphaPolicy);
    bitmap.paletteImages.set(paletteKey, image);
    return image;
  }

  private currentPaletteRef(): LingoValue {
    return this._paletteRef;
  }

  private currentPaletteColors(): readonly number[] | null {
    const palette = this.currentPaletteRef();
    if (palette instanceof CastMember && palette.paletteColors) return palette.paletteColors;
    if (palette instanceof LingoSymbol) {
      return paletteTableForBitmapDepth(palette.name.replace(/^#/, ""), this.bitmap?.bitDepth);
    }
    const paletteLike = palette as { paletteColors?: unknown } | null | undefined;
    if (Array.isArray(paletteLike?.paletteColors)) {
      return paletteLike.paletteColors as readonly number[];
    }
    return null;
  }

  private currentPaletteKey(colors: readonly number[]): string {
    const palette = this.currentPaletteRef();
    if (palette instanceof CastMember) return `member:${palette.slotNumber}`;
    if (palette instanceof LingoSymbol) return `symbol:${palette.name.toLowerCase()}`;
    const paletteLike = palette as { name?: unknown } | null | undefined;
    if (typeof paletteLike?.name === "string") {
      return `inline:${paletteLike.name}:${colors.length}:${colors[0] ?? 0}:${colors[colors.length - 1] ?? 0}`;
    }
    return `inline:${colors.length}:${colors[0] ?? 0}:${colors[colors.length - 1] ?? 0}`;
  }

  private assignPaletteAssociation(value: LingoValue): void {
    this._paletteRef = value;
    this._palette = value;
    if (this.image) this.image.paletteRef = value;
    if (this.imageSource) this.imageSource.paletteRef = value;
  }

  constructor(
    public readonly castName: string,
    public castNumber: number,
    public number: number,
    public name: string,
    public type: string,
    options: { text?: string; bitmap?: BitmapInfo | null; sound?: DirectorSoundMedia | null } = {},
  ) {
    this.text = options.text ?? "";
    this.bitmap = options.bitmap ?? null;
    this.sound = options.sound ?? null;
  }

  /** Lingo-facing member number: movie-global slot encoding
   * (castLib << 16 | memberNum), as in Director/LibreShockwave. */
  get slotNumber(): number {
    return (this.castNumber << 16) | (this.number & 0xffff);
  }

  lingoToString(): string {
    return `(member ${this.number} of castLib ${this.castNumber})`;
  }

  clearTextStyleRuns(): void {
    this.textStyleRuns.length = 0;
    this.textVersion += 1;
  }

  setTextStyleRange(start: number, end: number, property: string, value: LingoValue): void {
    const rawStart = Math.trunc(start);
    const rawEnd = Math.trunc(end);
    if (rawEnd < rawStart) return;
    const normalizedStart = Math.max(1, rawStart);
    const normalizedEnd = Math.min(Math.max(normalizedStart, rawEnd), Math.max(this.text.length, 1));
    if (normalizedEnd < normalizedStart) return;
    this.textStyleRuns.push({
      start: normalizedStart,
      end: normalizedEnd,
      property: property.toLowerCase(),
      value,
    });
    this.textVersion += 1;
  }
}

export interface CastManifests {
  movie: {
    casts: {
      number: number;
      name: string;
      members: ManifestMemberEntry[];
    }[];
  };
  textFields: {
    castOrder?: number;
    castName: string;
    member: number;
    memberName: string;
    memberType?: string;
    text: string;
  }[];
  bitmaps: {
    castOrder?: number;
    castName: string;
    member: number;
    sourceBitmapMember?: number;
    memberName: string;
    mediaType?: string;
    width: number;
    height: number;
    regPoint: { x: number; y: number };
    pngPath: string;
    inkAssetPaths?: Record<string, string>;
    bitDepth?: number;
    paletteIndexData?: string;
    paletteColors?: number[];
    paletteName?: string;
    paletteCastName?: string;
    paletteMember?: number;
    sourcePaletteCastLib?: number;
    sourcePaletteMember?: number;
    resolvedPaletteCastLib?: number;
    resolvedPaletteMember?: number;
    sourcePaletteKind?: string;
    paletteResolution?: string;
    sourcePaletteReferenceValid?: boolean;
    ink8AlphaPolicy?: string;
  }[];
  palettes?: {
    castOrder?: number;
    castName: string;
    member: number;
    memberName: string;
    memberChunkId?: number;
    colors: number[];
  }[];
  externalMembers?: {
    castOrder?: number;
    castName: string;
    member: number;
    memberName?: string;
    memberType?: string;
    mediaType?: string;
    identitySource?: string;
    supplementalRegistry?: boolean;
    sound?: DirectorSoundManifestMedia;
  }[];
}

interface ExternalManifestEntry {
  castOrder?: number;
  castName: string;
  member: number;
  memberName?: string;
  memberType?: string;
  mediaType?: string;
  sound?: DirectorSoundManifestMedia;
}

type TextFieldManifestEntry = CastManifests["textFields"][number];
type BitmapManifestEntry = CastManifests["bitmaps"][number];
type PaletteManifestEntry = NonNullable<CastManifests["palettes"]>[number];

export class CastRegistry {
  /** castName(lower) -> member number -> member */
  private byCast = new Map<string, Map<number, CastMember>>();
  /** member name(lower) -> members in cast load order */
  private byName = new Map<string, CastMember[]>();
  /** Cast load order: only loaded casts participate in name lookup. */
  private loadedCasts: string[] = [];
  private castNumbers = new Map<string, number>();
  /** Runtime castLib slot -> currently assigned loaded cast. Dynamic casts
   * replace the castLib occupant when `castLib(n).fileName` changes; stale
   * casts may still have member objects, but slot-encoded lookups must follow
   * the current slot owner. */
  private castNumberOwners = new Map<number, string>();
  private readonly textFieldsByCast: Map<string, TextFieldManifestEntry[]>;
  private readonly bitmapsByCast: Map<string, BitmapManifestEntry[]>;
  private readonly palettesByCast: Map<string, PaletteManifestEntry[]>;
  private readonly externalEntriesByCast: Map<string, ExternalManifestEntry[]>;
  private readonly allExternalEntries: ExternalManifestEntry[];

  constructor(private readonly manifests: CastManifests, private readonly assetBaseUrl: string) {
    this.allExternalEntries = [
      ...this.manifests.textFields,
      ...this.manifests.bitmaps,
      ...(this.manifests.externalMembers ?? []),
      ...(this.manifests.palettes ?? []),
    ];
    this.textFieldsByCast = this.bucketByCast(this.manifests.textFields);
    this.bitmapsByCast = this.bucketByCast(this.manifests.bitmaps);
    this.palettesByCast = this.bucketByCast(this.manifests.palettes ?? []);
    this.externalEntriesByCast = this.bucketByCast(this.allExternalEntries);

    for (const cast of manifests.movie.casts) {
      this.castNumbers.set(CastRegistry.normalizeCastName(cast.name), cast.number);
    }
    for (const entry of this.allExternalEntries) {
      const key = CastRegistry.normalizeCastName(entry.castName);
      if (!this.castNumbers.has(key) && entry.castOrder !== undefined) {
        this.castNumbers.set(key, entry.castOrder);
      }
    }
  }

  private static normalizeCastName(castName: string): string {
    return castName.toLowerCase().replace(/\.(cct|cst)$/i, "");
  }

  private bucketByCast<T extends { castName: string }>(entries: readonly T[]): Map<string, T[]> {
    const buckets = new Map<string, T[]>();
    for (const entry of entries) {
      const key = CastRegistry.normalizeCastName(entry.castName);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry);
      else buckets.set(key, [entry]);
    }
    return buckets;
  }

  private externalManifestEntries(castName: string): ExternalManifestEntry[] {
    return this.externalEntriesByCast.get(CastRegistry.normalizeCastName(castName)) ?? [];
  }

  private assetUrl(path: string | null | undefined): string | null {
    const normalized = this.normalizeAssetPath(path);
    if (!normalized) return null;
    if (/^(?:https?:|data:|blob:|\/)/i.test(normalized)) return normalized;
    return this.assetBaseUrl + normalized;
  }

  private normalizeAssetPath(path: string | null | undefined): string | null {
    if (!path) return null;
    let normalized = path.replace(/\\/g, "/").replace(/^file:\/+/i, "");
    if (/^(?:https?:|data:|blob:|\/)/i.test(normalized)) return normalized;

    const lower = normalized.toLowerCase();
    const generatedAssets = "/generated/assets/";
    const generatedIndex = lower.lastIndexOf(generatedAssets);
    if (generatedIndex >= 0) {
      return normalized.slice(generatedIndex + generatedAssets.length);
    }

    normalized = normalized.replace(/^generated\/assets\//i, "");
    const lowerAfterGenerated = normalized.toLowerCase();
    const assetsIndex = lowerAfterGenerated.lastIndexOf("/assets/");
    if (assetsIndex >= 0) {
      return normalized.slice(assetsIndex + "/assets/".length);
    }
    return normalized;
  }

  private inkAssetUrls(paths: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!paths) return undefined;
    const urls: Record<string, string> = {};
    for (const [ink, path] of Object.entries(paths)) {
      const url = this.assetUrl(path);
      if (url) urls[ink] = url;
    }
    return Object.keys(urls).length > 0 ? urls : undefined;
  }

  private castDefinition(castName: string): {
    number: number;
    name: string;
    members: ManifestMemberEntry[];
  } | null {
    const key = CastRegistry.normalizeCastName(castName);
    const syntheticMembers = new Map<number, ManifestMemberEntry>();
    let castNumber = this.castNumbers.get(key);
    const manifestCast = this.manifests.movie.casts.find((entry) => CastRegistry.normalizeCastName(entry.name) === key);
    if (manifestCast) {
      castNumber = manifestCast.number;
      for (const entry of manifestCast.members) {
        syntheticMembers.set(entry.number, {
          ...entry,
          number: entry.number,
          name: entry.name ?? "",
          type: entry.type ?? "unknown",
        });
      }
    }
    const add = (entry: {
      castOrder?: number;
      castName: string;
      member: number;
      memberName?: string;
      memberType?: string;
      mediaType?: string;
      sound?: DirectorSoundManifestMedia;
    }): void => {
      if (CastRegistry.normalizeCastName(entry.castName) !== key) return;
      if (castNumber === undefined && entry.castOrder !== undefined) {
        castNumber = entry.castOrder;
      }
      const existing = syntheticMembers.get(entry.member);
      const incomingType = (entry.memberType ?? entry.mediaType ?? "").toLowerCase();
      const existingType = (existing?.type ?? "").toLowerCase();
      const incomingName = entry.memberName ?? "";
      const existingName = existing?.name ?? "";
      const namesConflict =
        existingName.length > 0 && incomingName.length > 0 && existingName.toLowerCase() !== incomingName.toLowerCase();
      const existingPriority = this.memberIdentityPriority(existingType);
      const incomingPriority = this.memberIdentityPriority(incomingType);
      const preserveIncomingIdentity =
        incomingPriority > existingPriority && (incomingName.length > 0 || incomingType.length > 0);
      const preserveExistingIdentity =
        !preserveIncomingIdentity &&
        (namesConflict || (Boolean(existingName) && (existingType === "text" || existingType === "field") && incomingType === "bitmap"));
      const type = preserveExistingIdentity
        ? (existingType || "unknown")
        : (incomingType || existingType || "unknown");
      const name = preserveExistingIdentity ? existingName : (incomingName || existingName);
      syntheticMembers.set(entry.member, {
        ...existing,
        number: entry.member,
        name,
        type,
        sound: entry.sound ?? existing?.sound,
      });
    };

    for (const entry of this.externalManifestEntries(key)) add(entry);
    if (syntheticMembers.size === 0) return null;

    if (castNumber === undefined) {
      const maxKnown = Math.max(0, ...this.manifests.movie.casts.map((entry) => entry.number), ...this.castNumbers.values());
      castNumber = maxKnown + 1;
    }
    this.castNumbers.set(key, castNumber);
    return {
      number: castNumber,
      name: castName,
      members: [...syntheticMembers.values()].sort((a, b) => a.number - b.number),
    };
  }

  private memberIdentityPriority(type: string): number {
    switch (type.toLowerCase()) {
      case "script":
        return 4;
      case "text":
      case "field":
        return 3;
      case "palette":
      case "sound":
        return 2;
      case "bitmap":
        return 1;
      default:
        return 0;
    }
  }

  /** Marks a cast loaded and indexes its members from the manifests. When a
   * cast is assigned through castLib(n).fileName, Director exposes its members
   * under that runtime castLib slot, regardless of the extracted source order. */
  loadCast(castName: string, castNumberOverride?: number): boolean {
    const key = CastRegistry.normalizeCastName(castName);
    if (this.loadedCasts.includes(key)) {
      if (castNumberOverride !== undefined) {
        this.reassignCastNumber(key, castNumberOverride);
      }
      return true;
    }
    const cast = this.castDefinition(key);
    if (!cast) return false;
    const castNumber = castNumberOverride ?? cast.number;
    this.assignCastNumber(key, castNumber);

    const members = new Map<number, CastMember>();
    const texts = new Map<number, string>();
    for (const field of this.textFieldsByCast.get(key) ?? []) {
      texts.set(field.member, field.text ?? "");
    }
    const bitmaps = new Map<number, BitmapCandidate[]>();
    const addBitmapCandidate = (memberNumber: number, info: BitmapCandidate): void => {
      const existing = bitmaps.get(memberNumber);
      if (existing) {
        existing.push(info);
      } else {
        bitmaps.set(memberNumber, [info]);
      }
    };
    for (const bitmap of this.bitmapsByCast.get(key) ?? []) {
      const info = {
        memberName: bitmap.memberName ?? "",
        width: bitmap.width,
        height: bitmap.height,
        regX: bitmap.regPoint.x,
        regY: bitmap.regPoint.y,
        pngUrl: this.assetUrl(bitmap.pngPath),
        inkUrls: this.inkAssetUrls(bitmap.inkAssetPaths),
        bitDepth: bitmap.bitDepth,
        paletteIndexData: bitmap.paletteIndexData,
        paletteColors: bitmap.paletteColors,
        paletteName: bitmap.paletteName,
        paletteCastName: bitmap.paletteCastName,
        paletteMember: bitmap.paletteMember,
        sourcePaletteCastLib: bitmap.sourcePaletteCastLib,
        sourcePaletteMember: bitmap.sourcePaletteMember,
        resolvedPaletteCastLib: bitmap.resolvedPaletteCastLib,
        resolvedPaletteMember: bitmap.resolvedPaletteMember,
        sourcePaletteKind: bitmap.sourcePaletteKind,
        paletteResolution: bitmap.paletteResolution,
        sourcePaletteReferenceValid: bitmap.sourcePaletteReferenceValid,
        ink8AlphaPolicy: bitmap.ink8AlphaPolicy,
      };
      addBitmapCandidate(bitmap.member, info);
      if (typeof bitmap.sourceBitmapMember === "number") {
        addBitmapCandidate(bitmap.sourceBitmapMember, info);
      }
    }
    const palettes = new Map<number, number[]>();
    for (const palette of this.palettesByCast.get(key) ?? []) {
      palettes.set(palette.member, palette.colors);
    }

    for (const entry of cast.members) {
      const member = new CastMember(
        cast.name,
        castNumber,
        entry.number,
        entry.name ?? "",
        entry.type ?? "unknown",
        {
          text: texts.get(entry.number) ?? entry.text,
          bitmap:
            (entry.type ?? "").toLowerCase() === "script"
              ? null
              : this.bitmapForMemberEntry(entry, bitmaps.get(entry.number)),
          sound: entry.sound
            ? {
                ...entry.sound,
                assetUrl: entry.sound.assetUrl ?? this.assetUrl(entry.sound.assetPath) ?? "",
              }
            : null,
        },
      );
      this.applyTextStyleMetadata(member, entry);
      member.paletteColors = palettes.get(entry.number) ?? null;
      members.set(entry.number, member);
      this.indexName(member);
      this.indexBitmapAlias(member);
    }
    this.addBitmapAliasMembers(cast.name, castNumber, members, bitmaps);
    this.linkAdjacentMembers(members);
    this.applyBitmapSourcePalettes(key, members);
    this.byCast.set(key, members);
    this.loadedCasts.push(key);
    return true;
  }

  private bitmapForMemberEntry(entry: ManifestMemberEntry, candidates: BitmapCandidate[] | undefined): BitmapInfo | null {
    if (!candidates || candidates.length === 0) return null;
    const expectedName = this.normalizedMemberIdentity(entry.name);
    const matching = candidates.filter((candidate) => this.normalizedMemberIdentity(candidate.memberName) === expectedName);
    if (matching.length === 0 && (entry.type ?? "").toLowerCase() !== "bitmap") {
      return null;
    }
    // Later records intentionally override earlier ones for the same source
    // identity, e.g. visual bitmap supplements replacing a raw external
    // bitmap. Different recovered aliases sharing the same numeric member
    // must not overwrite the source member's own bitmap.
    return (matching.length > 0 ? matching : candidates).at(-1) ?? null;
  }

  private addBitmapAliasMembers(
    castName: string,
    castNumber: number,
    members: Map<number, CastMember>,
    bitmaps: Map<number, BitmapCandidate[]>,
  ): void {
    const usedNumbers = new Set(members.keys());
    const membersByName = new Map<string, CastMember[]>();
    for (const member of members.values()) {
      const name = this.normalizedMemberIdentity(member.name);
      if (name.length === 0) continue;
      const existing = membersByName.get(name);
      if (existing) existing.push(member);
      else membersByName.set(name, [member]);
    }

    const candidatesByName = new Map<string, BitmapCandidate[]>();
    for (const candidates of bitmaps.values()) {
      for (const candidate of candidates) {
        const name = this.normalizedMemberIdentity(candidate.memberName);
        if (!name || !this.bitmapCandidateHasPixels(candidate)) continue;
        const existing = candidatesByName.get(name);
        if (existing) existing.push(candidate);
        else candidatesByName.set(name, [candidate]);
      }
    }

    for (const [name, candidates] of candidatesByName) {
      const candidate = candidates.at(-1);
      if (!candidate) continue;
      for (const member of membersByName.get(name) ?? []) {
        if (!this.canHydrateBitmapShell(member)) continue;
        member.type = "bitmap";
        member.bitmap = candidate;
        this.indexBitmapAlias(member);
      }
    }

    let nextNumber = 1;

    for (const candidates of bitmaps.values()) {
      for (const candidate of candidates) {
        const aliasName = this.normalizedMemberIdentity(candidate.memberName);
        if (!aliasName || !this.bitmapCandidateHasPixels(candidate) || membersByName.has(aliasName)) continue;
        while (usedNumbers.has(nextNumber) && nextNumber <= 0xffff) nextNumber += 1;
        if (nextNumber > 0xffff) return;

        const alias = new CastMember(castName, castNumber, nextNumber, candidate.memberName, "bitmap", {
          bitmap: candidate,
        });
        alias.syntheticAlias = true;
        members.set(nextNumber, alias);
        usedNumbers.add(nextNumber);
        membersByName.set(aliasName, [alias]);
        this.indexName(alias);
        this.indexBitmapAlias(alias);
      }
    }
  }

  private bitmapCandidateHasPixels(candidate: BitmapCandidate): boolean {
    return Boolean(candidate.pngUrl || candidate.paletteIndexData || candidate.decoded);
  }

  private canHydrateBitmapShell(member: CastMember): boolean {
    const type = member.type.toLowerCase();
    if (type !== "bitmap" && type !== "unknown") return false;
    return !member.bitmap?.pngUrl && !member.bitmap?.paletteIndexData && !member.bitmap?.decoded;
  }

  private normalizedMemberIdentity(value: string | null | undefined): string {
    return String(value ?? "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase();
  }

  private applyBitmapSourcePalettes(castKey: string, members: Map<number, CastMember>): void {
    for (const member of members.values()) {
      const paletteRef = this.sourcePaletteRefForBitmap(member.bitmap, castKey, members);
      if (!paletteRef) continue;
      member.paletteRef = paletteRef;
      member.palette = paletteRef;
    }
  }

  private sourcePaletteRefForBitmap(
    bitmap: BitmapInfo | null,
    castKey: string,
    members: Map<number, CastMember>,
  ): LingoValue | null {
    if (!bitmap?.paletteIndexData || !bitmap.paletteColors || bitmap.paletteColors.length === 0) {
      return null;
    }

    const paletteMember = Number(bitmap.paletteMember ?? 0);
    if (paletteMember > 0) {
      const paletteCastKey = CastRegistry.normalizeCastName(bitmap.paletteCastName || castKey);
      const palette =
        paletteCastKey === castKey
          ? members.get(paletteMember)
          : this.byCast.get(paletteCastKey)?.get(paletteMember);
      if (palette?.paletteColors) return palette;
    }

    const paletteName = (bitmap.paletteName ?? "").trim().toLowerCase();
    if (paletteName === "grayscale") return LingoSymbol.for("grayscale");
    if (paletteName === "systemmac") return LingoSymbol.for("systemMac");
    if (paletteName === "system win" || paletteName === "systemwin") return LingoSymbol.for("systemWin");
    if (paletteName === "system win (dir 4)" || paletteName === "systemwindir4") {
      return LingoSymbol.for("systemWinDir4");
    }

    return new InlinePaletteRef(bitmap.paletteName || "bitmap palette", bitmap.paletteColors);
  }

  private reassignCastNumber(key: string, castNumber: number): void {
    this.assignCastNumber(key, castNumber);
    const members = this.byCast.get(key);
    if (!members) return;
    for (const member of members.values()) {
      member.castNumber = castNumber;
    }
  }

  private assignCastNumber(key: string, castNumber: number): void {
    const previous = this.castNumbers.get(key);
    if (previous !== undefined && this.castNumberOwners.get(previous) === key) {
      this.castNumberOwners.delete(previous);
    }
    this.castNumbers.set(key, castNumber);
    this.castNumberOwners.set(castNumber, key);
  }

  private indexName(member: CastMember): void {
    this.indexNameAlias(member, member.name, false);
  }

  private indexBitmapAlias(member: CastMember): void {
    const alias = member.bitmap?.memberName ?? "";
    if (!alias || alias.toLowerCase() === member.name.toLowerCase()) return;
    this.indexNameAlias(member, alias, true);
  }

  private indexNameAlias(member: CastMember, name: string, prefer: boolean): void {
    const nameKey = name.toLowerCase();
    if (nameKey === "") return;
    let list = this.byName.get(nameKey);
    if (!list) {
      list = [];
      this.byName.set(nameKey, list);
    }
    if (list.includes(member)) return;
    if (prefer) list.unshift(member);
    else list.push(member);
  }

  private findNameMatches(nameKey: string): CastMember[] | undefined {
    const exact = this.byName.get(nameKey);
    if (exact && exact.length > 0) {
      const catalogPalette = this.usableCatalogPaletteMatches(nameKey);
      if (catalogPalette && this.matchesOnlyColorlessPalettes(exact)) return catalogPalette;
      return exact;
    }

    return this.usableCatalogPaletteMatches(nameKey);
  }

  private usableCatalogPaletteMatches(nameKey: string): CastMember[] | undefined {
    const catalogAlias = this.byName.get(`catalog_${nameKey}`);
    const paletteMatches = catalogAlias?.filter((member) => this.isUsablePalette(member));
    return paletteMatches && paletteMatches.length > 0 ? paletteMatches : undefined;
  }

  private matchesOnlyColorlessPalettes(matches: CastMember[]): boolean {
    return matches.length > 0 && matches.every((member) => this.isColorlessPalette(member));
  }

  private isUsablePalette(member: CastMember): boolean {
    return member.type.toLowerCase() === "palette" && Array.isArray(member.paletteColors) && member.paletteColors.length > 0;
  }

  private isColorlessPalette(member: CastMember): boolean {
    return member.type.toLowerCase() === "palette" && (!Array.isArray(member.paletteColors) || member.paletteColors.length === 0);
  }

  private bestNamedMemberMatch(matches: CastMember[], nameKey: string, castName: string | null): CastMember | null {
    const normalizedName = this.normalizedMemberIdentity(nameKey);
    const castMatches = (castKey: string): CastMember[] =>
      matches.filter((candidate) => CastRegistry.normalizeCastName(candidate.castName) === castKey);
    const bestIn = (candidates: CastMember[]): CastMember | null => {
      if (candidates.length === 0) return null;
      return (
        candidates.find(
          (candidate) =>
            this.normalizedMemberIdentity(candidate.bitmap?.memberName) === normalizedName &&
            Boolean(candidate.bitmap?.pngUrl || candidate.bitmap?.paletteIndexData || candidate.bitmap?.decoded),
        ) ??
        candidates.find((candidate) => this.normalizedMemberIdentity(candidate.bitmap?.memberName) === normalizedName) ??
        candidates[0] ??
        null
      );
    };

    if (castName) {
      return bestIn(castMatches(CastRegistry.normalizeCastName(castName)));
    }

    for (const cast of this.loadedCasts) {
      const member = bestIn(castMatches(cast));
      if (member) return member;
    }
    return null;
  }

  /** Director member lookup: by number within a cast, or by name across
   * loaded casts in load order. */
  find(id: LingoValue, castName: string | null): CastMember | null {
    if (typeof id === "number") {
      // Slot-encoded global number: castLib << 16 | memberNum.
      const castNumber = id >> 16;
      if (castNumber >= 1 && !castName) {
        const memberNumber = id & 0xffff;
        const currentOwner = this.castNumberOwners.get(castNumber);
        if (currentOwner) {
          const member = this.byCast.get(currentOwner)?.get(memberNumber);
          if (member) return member;
        }
        const castNameForNumber = [...this.castNumbers.entries()].find(
          ([key, number]) => number === castNumber && this.loadedCasts.includes(key),
        )?.[0];
        if (castNameForNumber) return this.byCast.get(castNameForNumber)?.get(memberNumber) ?? null;
        return null;
      }
      if (castName) {
        const cast = this.byCast.get(CastRegistry.normalizeCastName(castName));
        return cast?.get(id & 0xffff) ?? cast?.get(id) ?? null;
      }
      for (const cast of this.loadedCasts) {
        const member = this.byCast.get(cast)?.get(id);
        if (member) return member;
      }
      return null;
    }
    if (typeof id === "string") {
      const nameKey = id.toLowerCase();
      const matches = this.findNameMatches(nameKey);
      if (!matches || matches.length === 0) return null;
      return this.bestNamedMemberMatch(matches, nameKey, castName);
    }
    return null;
  }

  /** Renames a member and keeps the name index in sync (Download Instance
   * renames imported members after the fact). */
  rename(member: CastMember, newName: string): void {
    const oldKey = member.name.toLowerCase();
    const list = this.byName.get(oldKey);
    if (list) {
      const index = list.indexOf(member);
      if (index >= 0) list.splice(index, 1);
    }
    member.name = newName;
    this.indexName(member);
  }

  /** Creates a runtime member (Resource Manager createMember path). */
  create(castName: string, name: string, type: string, castNumberOverride?: number): CastMember {
    const key = CastRegistry.normalizeCastName(castName);
    let members = this.byCast.get(key);
    if (!members) {
      members = new Map();
      this.byCast.set(key, members);
      this.loadedCasts.push(key);
    }
    let castNumber = castNumberOverride ?? this.castNumbers.get(key);
    if (castNumber === undefined || castNumber <= 0) {
      castNumber = Math.max(0, ...this.castNumbers.values()) + 1;
    }
    this.assignCastNumber(key, castNumber);
    const number = Math.max(0, ...members.keys()) + 1;
    const member = new CastMember(castName, castNumber, number, name, type, {});
    members.set(number, member);
    this.linkAdjacentMembers(members);
    this.indexName(member);
    return member;
  }

  /** Erases a member (member().erase from Resource Manager removeMember). */
  remove(member: CastMember): void {
    const list = this.byName.get(member.name.toLowerCase());
    if (list) {
      const index = list.indexOf(member);
      if (index >= 0) list.splice(index, 1);
    }
    const members = this.byCast.get(CastRegistry.normalizeCastName(member.castName));
    members?.delete(member.number);
    if (members) this.linkAdjacentMembers(members);
  }

  private linkAdjacentMembers(members: Map<number, CastMember>): void {
    for (const member of members.values()) {
      member.nextCastMember = member.syntheticAlias ? null : this.nextAuthoredMember(members, member.number);
    }
  }

  private nextAuthoredMember(members: Map<number, CastMember>, memberNumber: number): CastMember | null {
    const next = members.get(memberNumber + 1) ?? null;
    return next?.syntheticAlias ? null : next;
  }

  /** All members of a cast (for the preload image-decode pipeline). */
  membersOf(castName: string): CastMember[] {
    const cast = this.byCast.get(CastRegistry.normalizeCastName(castName));
    return cast ? [...cast.values()].filter((member) => !member.syntheticAlias) : [];
  }

  memberCount(castName: string): number {
    const cast = this.byCast.get(CastRegistry.normalizeCastName(castName));
    if (!cast || cast.size === 0) return 0;
    return Math.max(...cast.keys());
  }

  /** Manifest member definitions without marking the cast loaded. Dynamic
   * room-asset guards use this to determine which pending cast owns a class
   * while preserving the source cast-load lifecycle. */
  definedMembersOf(castName: string): ManifestMemberEntry[] {
    return this.castDefinition(castName)?.members ?? [];
  }

  private applyTextStyleMetadata(member: CastMember, entry: ManifestMemberEntry): void {
    if (member.type !== "field" && member.type !== "text") return;
    let changed = false;
    const setStyle = (key: string, value: LingoValue | undefined): void => {
      if (value === undefined) return;
      member.style.set(key, value);
      changed = true;
    };

    setStyle("font", entry.fontFamily);
    if (Number.isFinite(entry.fontSize)) setStyle("fontsize", Number(entry.fontSize));
    if (Number.isFinite(entry.lineHeight)) {
      const lineHeight = Number(entry.lineHeight);
      setStyle("fixedlinespace", lineHeight);
      if (Number.isFinite(entry.fontSize)) {
        setStyle("topspacing", Math.max(0, Math.round(lineHeight - Number(entry.fontSize))));
      }
    }
    if (entry.wordWrap !== undefined) setStyle("wordwrap", Number(entry.wordWrap) ? 1 : 0);
    if (entry.textAlign) setStyle("alignment", LingoSymbol.for(entry.textAlign.toLowerCase().replace(/^#/, "")));
    const color = this.parseTextColor(entry.color);
    if (color) setStyle("color", color);
    const fontStyle = this.fontStyleList(entry.fontWeight, entry.underline);
    if (fontStyle) setStyle("fontstyle", fontStyle);

    for (const span of entry.textSpans ?? []) {
      const start = Math.max(1, Math.trunc(Number(span.start) || 0) + 1);
      const end = Math.max(start, Math.trunc(Number(span.end) || 0));
      const spanColor = this.parseTextColor(span.color);
      if (span.fontFamily) member.setTextStyleRange(start, end, "font", span.fontFamily);
      if (Number.isFinite(span.fontSize)) member.setTextStyleRange(start, end, "fontsize", Number(span.fontSize));
      const spanStyle = this.fontStyleList(span.fontWeight ?? span.fontStyle, span.underline);
      if (spanStyle) member.setTextStyleRange(start, end, "fontstyle", spanStyle);
      if (spanColor) member.setTextStyleRange(start, end, "color", spanColor);
    }

    if (changed) member.textVersion += 1;
  }

  private fontStyleList(fontWeight: string | undefined, underline: boolean | undefined): LingoList | null {
    const styles: LingoSymbol[] = [];
    const weight = String(fontWeight ?? "").toLowerCase();
    if (weight === "bold" || weight === "700" || weight.includes("#bold")) styles.push(LingoSymbol.for("bold"));
    if (underline) styles.push(LingoSymbol.for("underline"));
    return styles.length > 0 ? new LingoList(styles) : null;
  }

  private parseTextColor(value: string | undefined): LingoColor | null {
    if (!value) return null;
    const hex = value.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    const numeric = Number.parseInt(hex, 16);
    return new LingoColor((numeric >> 16) & 0xff, (numeric >> 8) & 0xff, numeric & 0xff);
  }

  get loaded(): string[] {
    return [...this.loadedCasts];
  }

  /** VOID-safe name lookup used by `field()` and getmemnum-style calls. */
  fieldText(id: LingoValue): LingoValue {
    const member = this.find(id, null);
    return member ? member.text : LINGO_VOID;
  }
}

function decodeBase64Bytes(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(data, "base64"));
}
