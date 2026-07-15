import {
  ColorMatrixFilter,
  Container,
  Graphics,
  NoiseFilter,
  type Application,
  type Filter,
} from "pixi.js";

type SceneEffectOverlayKind = "scanlines" | "crt" | "matrix";

interface SceneEffect {
  readonly filters: readonly Filter[];
  readonly overlay?: SceneEffectOverlayKind;
}

interface SceneEffectControllerOptions {
  readonly app: Application;
  readonly stageWidth: () => number;
  readonly stageHeight: () => number;
}

/** Owns optional scene-wide Pixi filters and their presentation overlays. */
export class SceneEffectController {
  private static readonly MATRIX_DEEP_GREEN = 0x031006;

  private overlay: Container | null = null;
  private overlayKind: SceneEffectOverlayKind | null = null;
  private overlayFrame = -1;
  private overlayTime = 0;

  constructor(private readonly options: SceneEffectControllerOptions) {}

  set(name: unknown): Record<string, unknown> {
    const key = this.normalizeName(name);
    if (key === "" || key === "none" || key === "off") {
      this.options.app.stage.filters = [];
      this.clearOverlay();
      return { ok: true, filter: "none", available: Object.keys(this.effects) };
    }
    const factory = this.effects[key];
    if (!factory) {
      return { ok: false, error: `unknown filter: ${key}`, available: ["none", ...Object.keys(this.effects)] };
    }

    const effect = factory();
    this.options.app.stage.filters = [...effect.filters];
    this.clearOverlay();
    if (effect.overlay) {
      this.overlayKind = effect.overlay;
      this.overlay = new Container();
      this.overlay.eventMode = "none";
      this.overlayFrame = -1;
      this.overlayTime = performance.now();
      this.syncOverlay();
    }
    return { ok: true, filter: key };
  }

  animate(now: number): void {
    if (!this.overlay || this.overlayKind !== "matrix") return;
    const frame = Math.floor(now / 60);
    if (frame === this.overlayFrame) return;
    this.overlayFrame = frame;
    this.overlayTime = now;
    this.syncOverlay();
  }

  syncOverlay(): void {
    if (!this.overlay || !this.overlayKind) return;
    for (const child of this.overlay.removeChildren()) child.destroy();
    const width = this.options.stageWidth();
    const height = this.options.stageHeight();
    if (this.overlayKind === "matrix") {
      this.overlay.addChild(
        new Graphics().rect(0, 0, width, height).fill({ color: SceneEffectController.MATRIX_DEEP_GREEN, alpha: 0.16 }),
      );
      const scan = new Graphics();
      const scanOffset = Math.floor(this.overlayTime / 70) % 4;
      for (let y = -scanOffset; y < height; y += 4) scan.rect(0, y, width, 1);
      scan.fill({ color: 0x000000, alpha: 0.14 });
      this.overlay.addChild(scan);
      this.options.app.stage.addChild(this.overlay);
      return;
    }
    if (this.overlayKind === "crt") {
      this.overlay.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x003a15, alpha: 0.08 }));
    }
    const lines = new Graphics();
    const step = this.overlayKind === "crt" ? 3 : 4;
    const alpha = this.overlayKind === "crt" ? 0.22 : 0.18;
    for (let y = 0; y < height; y += step) lines.rect(0, y, width, 1);
    lines.fill({ color: 0x000000, alpha });
    this.overlay.addChild(lines);
    this.options.app.stage.addChild(this.overlay);
  }

  keepOverlayOnTop(): void {
    if (!this.overlay || this.overlay.parent !== this.options.app.stage) return;
    const children = this.options.app.stage.children;
    if (children[children.length - 1] !== this.overlay) this.options.app.stage.addChild(this.overlay);
  }

  private readonly effects: Record<string, () => SceneEffect> = {
    greyscale: () => this.effect([this.colorMatrix((filter) => filter.desaturate())]),
    blackwhite: () => this.effect([this.colorMatrix((filter) => filter.blackAndWhite(false))]),
    sepia: () => this.effect([this.colorMatrix((filter) => filter.sepia(false))]),
    negative: () => this.effect([this.colorMatrix((filter) => filter.negative(false))]),
    technicolor: () => this.effect([this.colorMatrix((filter) => filter.technicolor(false))]),
    polaroid: () => this.effect([this.colorMatrix((filter) => filter.polaroid(false))]),
    kodachrome: () => this.effect([this.colorMatrix((filter) => filter.kodachrome(false))]),
    browni: () => this.effect([this.colorMatrix((filter) => filter.browni(false))]),
    nightvision: () => this.effect([this.colorMatrix((filter) => filter.night(0.5, false))]),
    vintage: () => this.effect([this.colorMatrix((filter) => filter.vintage(false))]),
    predator: () => this.effect([this.colorMatrix((filter) => filter.predator(0.6, false))]),
    lsd: () => this.effect([this.colorMatrix((filter) => filter.lsd(false))]),
    matrix: () => this.effect([this.matrixGreenFilter(), new NoiseFilter({ noise: 0.035, seed: 0.44 })], "matrix"),
    noise: () => this.effect([new NoiseFilter({ noise: 0.14, seed: 0.42 })]),
    scanlines: () => this.effect([], "scanlines"),
    crt: () => this.effect([this.matrixGreenFilter(), new NoiseFilter({ noise: 0.08, seed: 0.84 })], "crt"),
  };

  private effect(filters: readonly Filter[], overlay?: SceneEffectOverlayKind): SceneEffect {
    return { filters, overlay };
  }

  private colorMatrix(configure: (filter: ColorMatrixFilter) => void): ColorMatrixFilter {
    const filter = new ColorMatrixFilter();
    configure(filter);
    return filter;
  }

  private matrixGreenFilter(): ColorMatrixFilter {
    return this.colorMatrix((filter) => {
      filter.matrix = [
        0.075, 0.15, 0.025, 0, -0.03,
        0.24, 0.72, 0.1, 0, -0.08,
        0.045, 0.1, 0.025, 0, -0.04,
        0, 0, 0, 1, 0,
      ];
    });
  }

  private normalizeName(name: unknown): string {
    const key = String(name ?? "").trim().toLowerCase();
    if (key === "gray" || key === "grey" || key === "grayscale") return "greyscale";
    if (key === "bw" || key === "black-white" || key === "blackandwhite" || key === "black-and-white") return "blackwhite";
    if (key === "scanline") return "scanlines";
    return key;
  }

  private clearOverlay(): void {
    this.overlay?.destroy({ children: true });
    this.overlay = null;
    this.overlayKind = null;
    this.overlayFrame = -1;
    this.overlayTime = 0;
  }
}
