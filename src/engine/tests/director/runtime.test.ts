import { describe, expect, it } from "vitest";
import {
  type GeneratedScriptModule,
  MissingScriptInstance,
  MissingScriptRef,
  Runtime,
  ScriptInstance,
  classifyCopyPixelsQuadTransform,
} from "../../src/director/Runtime";
import { LingoColor, LingoDate, LingoPoint, LingoRect } from "../../src/director/geometry";
import { affineTransformForQuad, LingoImage } from "../../src/director/imaging";
import { CastMember } from "../../src/director/members";
import { paletteTableForBitmapDepth } from "../../src/director/palettes";
import { LINGO_VOID, LingoFloat, LingoList, LingoPropList, float, symbol } from "../../src/director/values";

function moduleFor(
  scriptName: string,
  scriptType: string,
  handlers: GeneratedScriptModule["handlers"] = {},
  scriptProperties: string[] = [],
): GeneratedScriptModule {
  return {
    scriptName,
    scriptType,
    scriptProperties,
    scriptGlobals: [],
    handlers,
  };
}

function withPixelCanvas(test: () => void): void {
  const previousDocument = globalThis.document;
  class FakeCanvas {
    width = 1;
    height = 1;
    context: FakeContext | null = null;

    getContext(): FakeContext {
      this.context ??= new FakeContext(this);
      return this.context;
    }
  }

  class FakeContext {
    fillStyle = "rgb(0, 0, 0)";
    globalAlpha = 1;
    globalCompositeOperation = "source-over";
    imageSmoothingEnabled = true;
    private data = new Uint8ClampedArray(4);
    private transformState = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    private transformStack: Array<{
      transform: { a: number; b: number; c: number; d: number; e: number; f: number };
      globalAlpha: number;
      globalCompositeOperation: string;
    }> = [];

    constructor(public readonly canvas: FakeCanvas) {}

    private ensureSize(): void {
      const size = Math.max(1, this.canvas.width) * Math.max(1, this.canvas.height) * 4;
      if (this.data.length !== size) this.data = new Uint8ClampedArray(size);
    }

    createImageData(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    }

    putImageData(image: { data: Uint8ClampedArray; width?: number; height?: number }, x: number, y: number): void {
      this.ensureSize();
      const width = image.width ?? this.canvas.width;
      const height = image.height ?? this.canvas.height;
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const dst = ((y + row) * this.canvas.width + x + col) * 4;
          const src = (row * width + col) * 4;
          this.data.set(image.data.slice(src, src + 4), dst);
        }
      }
    }

    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
      this.ensureSize();
      const out = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const src = ((y + row) * this.canvas.width + x + col) * 4;
          const dst = (row * width + col) * 4;
          out.set(this.data.slice(src, src + 4), dst);
        }
      }
      return { data: out, width, height };
    }

    fillRect(x: number, y: number, width: number, height: number): void {
      this.ensureSize();
      const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(this.fillStyle);
      const r = Number(match?.[1] ?? 0);
      const g = Number(match?.[2] ?? 0);
      const b = Number(match?.[3] ?? 0);
      for (let row = y; row < y + height; row += 1) {
        for (let col = x; col < x + width; col += 1) {
          const offset = (row * this.canvas.width + col) * 4;
          this.data[offset] = r;
          this.data[offset + 1] = g;
          this.data[offset + 2] = b;
          this.data[offset + 3] = 255;
        }
      }
    }

    clearRect(x: number, y: number, width: number, height: number): void {
      this.ensureSize();
      for (let row = y; row < y + height; row += 1) {
        for (let col = x; col < x + width; col += 1) {
          this.data.fill(0, (row * this.canvas.width + col) * 4, (row * this.canvas.width + col) * 4 + 4);
        }
      }
    }

    drawImage(source: FakeCanvas, ...args: number[]): void {
      this.ensureSize();
      const sourceCtx = source.getContext();
      sourceCtx.ensureSize();
      const [sx, sy, sw, sh, dx, dy, dw, dh] =
        args.length >= 8
          ? (args as [number, number, number, number, number, number, number, number])
          : args.length >= 4
            ? [0, 0, source.width, source.height, args[0] ?? 0, args[1] ?? 0, args[2] ?? source.width, args[3] ?? source.height]
            : [0, 0, source.width, source.height, args[0] ?? 0, args[1] ?? 0, source.width, source.height];
      for (let row = 0; row < dh; row += 1) {
        for (let col = 0; col < dw; col += 1) {
          const srcX = sx + Math.floor((col * sw) / dw);
          const srcY = sy + Math.floor((row * sh) / dh);
          const point = this.transformPoint(dx + col + 0.5, dy + row + 0.5);
          const dstX = Math.floor(point.x);
          const dstY = Math.floor(point.y);
          if (dstX < 0 || dstY < 0 || dstX >= this.canvas.width || dstY >= this.canvas.height) continue;
          if (srcX < 0 || srcY < 0 || srcX >= source.width || srcY >= source.height) continue;
          const src = (srcY * source.width + srcX) * 4;
          const dst = (dstY * this.canvas.width + dstX) * 4;
          this.writeCompositedPixel(
            dst,
            sourceCtx.data[src] ?? 0,
            sourceCtx.data[src + 1] ?? 0,
            sourceCtx.data[src + 2] ?? 0,
            sourceCtx.data[src + 3] ?? 0,
          );
        }
      }
    }

    save(): void {
      this.transformStack.push({
        transform: { ...this.transformState },
        globalAlpha: this.globalAlpha,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    }

    restore(): void {
      const state = this.transformStack.pop();
      this.transformState = state?.transform ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      this.globalAlpha = state?.globalAlpha ?? 1;
      this.globalCompositeOperation = state?.globalCompositeOperation ?? "source-over";
    }

    translate(x = 0, y = 0): void {
      this.transform(1, 0, 0, 1, x, y);
    }

    scale(x = 1, y = 1): void {
      this.transform(x, 0, 0, y, 0, 0);
    }

    rotate(angle = 0): void {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.transform(cos, sin, -sin, cos, 0, 0);
    }

    transform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
      const current = this.transformState;
      this.transformState = {
        a: current.a * a + current.c * b,
        b: current.b * a + current.d * b,
        c: current.a * c + current.c * d,
        d: current.b * c + current.d * d,
        e: current.a * e + current.c * f + current.e,
        f: current.b * e + current.d * f + current.f,
      };
    }

    private transformPoint(x: number, y: number): { x: number; y: number } {
      const m = this.transformState;
      return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
    }

    private writeCompositedPixel(dst: number, sr: number, sg: number, sb: number, sa: number): void {
      const sourceAlpha = Math.max(0, Math.min(255, Math.round(sa * this.globalAlpha)));
      const dr = this.data[dst] ?? 0;
      const dg = this.data[dst + 1] ?? 0;
      const db = this.data[dst + 2] ?? 0;
      const da = this.data[dst + 3] ?? 0;

      if (this.globalCompositeOperation === "destination-in") {
        const coverage = sourceAlpha / 255;
        this.data[dst + 3] = Math.round(da * coverage);
        return;
      }

      if (sourceAlpha <= 0) return;

      if (this.globalCompositeOperation === "lighter") {
        this.data[dst] = Math.min(255, dr + sr);
        this.data[dst + 1] = Math.min(255, dg + sg);
        this.data[dst + 2] = Math.min(255, db + sb);
        this.data[dst + 3] = Math.max(da, sourceAlpha);
        return;
      }

      if (this.globalCompositeOperation === "lighten") {
        this.data[dst] = Math.max(dr, sr);
        this.data[dst + 1] = Math.max(dg, sg);
        this.data[dst + 2] = Math.max(db, sb);
        this.data[dst + 3] = Math.max(da, sourceAlpha);
        return;
      }

      if (this.globalCompositeOperation === "darken") {
        this.data[dst] = Math.min(dr, sr);
        this.data[dst + 1] = Math.min(dg, sg);
        this.data[dst + 2] = Math.min(db, sb);
        this.data[dst + 3] = Math.max(da, sourceAlpha);
        return;
      }

      if (sourceAlpha >= 255) {
        this.data[dst] = sr;
        this.data[dst + 1] = sg;
        this.data[dst + 2] = sb;
        this.data[dst + 3] = 255;
        return;
      }

      const srcA = sourceAlpha / 255;
      const dstA = da / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) {
        this.data.fill(0, dst, dst + 4);
        return;
      }
      this.data[dst] = Math.round((sr * srcA + dr * dstA * (1 - srcA)) / outA);
      this.data[dst + 1] = Math.round((sg * srcA + dg * dstA * (1 - srcA)) / outA);
      this.data[dst + 2] = Math.round((sb * srcA + db * dstA * (1 - srcA)) / outA);
      this.data[dst + 3] = Math.round(outA * 255);
    }
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new FakeCanvas() },
  });
  try {
    test();
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
}

function expectFloatValue(value: unknown): number {
  expect(value).toBeInstanceOf(LingoFloat);
  return (value as LingoFloat).value;
}

function expectImagePixel(image: LingoImage, x: number, y: number, hex: number): void {
  expect(image.getPixel(x, y).hex).toBe(hex);
}

function expectImageAlpha(image: LingoImage, x: number, y: number, alpha: number): void {
  const data = image.context?.getImageData(x, y, 1, 1).data;
  expect(data?.[3]).toBe(alpha);
}

describe("Director copyPixels quad destinations", () => {
  const rect = new LingoRect(0, 0, 10, 20);
  const tl = new LingoPoint(0, 0);
  const tr = new LingoPoint(10, 0);
  const br = new LingoPoint(10, 20);
  const bl = new LingoPoint(0, 20);

  it("classifies source corner mappings for flips and right-angle rotations", () => {
    expect(classifyCopyPixelsQuadTransform([tl, tr, br, bl], rect)).toBe("identity");
    expect(classifyCopyPixelsQuadTransform([tr, tl, bl, br], rect)).toBe("flipH");
    expect(classifyCopyPixelsQuadTransform([bl, br, tr, tl], rect)).toBe("flipV");
    expect(classifyCopyPixelsQuadTransform([br, bl, tl, tr], rect)).toBe("rotate180");
    expect(classifyCopyPixelsQuadTransform([tr, br, bl, tl], rect)).toBe("rotateCW");
    expect(classifyCopyPixelsQuadTransform([bl, tl, tr, br], rect)).toBe("rotateCCW");
  });

  it("builds affine transforms for Director parallelogram quad copies", () => {
    const rightStallSign = [
      new LingoPoint(0, 0),
      new LingoPoint(64, 32),
      new LingoPoint(64, 50),
      new LingoPoint(0, 18),
    ] as [LingoPoint, LingoPoint, LingoPoint, LingoPoint];
    const transform = affineTransformForQuad(rightStallSign, 64, 18);

    expect(transform.a).toBeCloseTo(1);
    expect(transform.b).toBeCloseTo(0.5);
    expect(transform.c).toBeCloseTo(0);
    expect(transform.d).toBeCloseTo(1);
    expect(transform.e).toBe(0);
    expect(transform.f).toBe(0);
  });

  it("keeps offscreen Director image canvases unsmoothed for pixel copies", () => {
    withPixelCanvas(() => {
      const image = new LingoImage(2, 2, 32);
      expect(image.context?.imageSmoothingEnabled).toBe(false);
    });
  });

  it("classifies copyPixels calls for future direct-draw parity work without changing output", () => {
    withPixelCanvas(() => {
      const previousTrace = LingoImage.copyTrace;
      const traces: Array<{ directCopyCandidate: boolean; staged: boolean }> = [];
      LingoImage.copyTrace = (info) => traces.push(info);
      try {
        const source = new LingoImage(2, 1, 32);
        const dest = new LingoImage(2, 1, 32);
        source.setPixel(0, 0, new LingoColor(10, 20, 30));
        source.setPixel(1, 0, new LingoColor(200, 210, 220));

        dest.copyPixels(source, dest.getRect(), source.getRect(), null);
        dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 8 });
        dest.copyPixels(dest, dest.getRect(), dest.getRect(), null);

        expect(dest.getPixel(0, 0).hex).toBe(0x0a141e);
        expect(traces.map((entry) => entry.directCopyCandidate)).toEqual([true, false, false]);
        expect(traces.map((entry) => entry.staged)).toEqual([false, true, true]);
      } finally {
        LingoImage.copyTrace = previousTrace;
      }
    });
  });

  it("direct-copies exact copy-ink copyPixels output without staging", () => {
    withPixelCanvas(() => {
      const previousTrace = LingoImage.copyTrace;
      const traces: Array<{ directCopyCandidate: boolean; staged: boolean }> = [];
      LingoImage.copyTrace = (info) => traces.push(info);
      try {
        const source = new LingoImage(3, 1, 32);
        const dest = new LingoImage(3, 1, 32);
        source.setPixel(0, 0, new LingoColor(10, 20, 30));
        source.setPixel(1, 0, new LingoColor(40, 50, 60));
        source.setPixel(2, 0, new LingoColor(70, 80, 90));

        dest.copyPixels(source, dest.getRect(), source.getRect(), null);
        dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 0 });

        expect(dest.getPixel(0, 0).hex).toBe(0x0a141e);
        expect(dest.getPixel(1, 0).hex).toBe(0x28323c);
        expect(dest.getPixel(2, 0).hex).toBe(0x46505a);
        expect(traces.map((entry) => entry.directCopyCandidate)).toEqual([true, true]);
        expect(traces.map((entry) => entry.staged)).toEqual([false, false]);
      } finally {
        LingoImage.copyTrace = previousTrace;
      }
    });
  });

  it("keeps scaled, fractional, masked, and self copyPixels on the staged path", () => {
    withPixelCanvas(() => {
      const previousTrace = LingoImage.copyTrace;
      const traces: Array<{ directCopyCandidate: boolean; staged: boolean }> = [];
      LingoImage.copyTrace = (info) => traces.push(info);
      try {
        const source = new LingoImage(2, 1, 32);
        const dest = new LingoImage(4, 1, 32);
        const mask = new LingoImage(2, 1, 32);
        source.setPixel(0, 0, new LingoColor(10, 20, 30));
        source.setPixel(1, 0, new LingoColor(40, 50, 60));

        dest.copyPixels(source, new LingoRect(0, 0, 4, 1), source.getRect(), null);
        dest.copyPixels(source, new LingoRect(0, 0, 2, 1), new LingoRect(0.5, 0, 2.5, 1), null);
        dest.copyPixels(source, new LingoRect(0, 0, 2, 1), source.getRect(), { maskImage: mask });
        dest.copyPixels(dest, new LingoRect(1, 0, 3, 1), new LingoRect(0, 0, 2, 1), null);

        expect(traces.map((entry) => entry.directCopyCandidate)).toEqual([false, false, false, false]);
        expect(traces.map((entry) => entry.staged)).toEqual([true, true, true, true]);
      } finally {
        LingoImage.copyTrace = previousTrace;
      }
    });
  });

  it("clears the reused staged copyPixels surface before drawing transparent sources", () => {
    withPixelCanvas(() => {
      const seedSource = new LingoImage(2, 2, 32);
      const transparentSource = new LingoImage(2, 2, 32, undefined, { initWhite: false });
      const fullMask = new LingoImage(2, 2, 32);
      const seedDest = new LingoImage(2, 2, 32, undefined, { initWhite: false });
      const dest = new LingoImage(2, 2, 32, undefined, { initWhite: false });

      seedSource.fill(seedSource.getRect(), new LingoColor(255, 255, 255));
      fullMask.fill(fullMask.getRect(), new LingoColor(0, 0, 0));

      seedDest.copyPixels(seedSource, seedDest.getRect(), seedSource.getRect(), { maskImage: fullMask });
      dest.copyPixels(transparentSource, dest.getRect(), transparentSource.getRect(), { maskImage: fullMask });

      expectImageAlpha(dest, 0, 0, 0);
      expectImageAlpha(dest, 1, 1, 0);
    });
  });

  it("clips out-of-bounds copyPixels source rects to transparent on the staged path", () => {
    withPixelCanvas(() => {
      const previousTrace = LingoImage.copyTrace;
      const traces: Array<{ directCopyCandidate: boolean; staged: boolean }> = [];
      LingoImage.copyTrace = (info) => traces.push(info);
      try {
        const source = new LingoImage(2, 1, 32, undefined, { initWhite: false });
        const dest = new LingoImage(5, 1, 32, undefined, { initWhite: false });
        source.setPixel(0, 0, new LingoColor(10, 20, 30));
        source.setPixel(1, 0, new LingoColor(40, 50, 60));
        for (let x = 0; x < 5; x += 1) {
          dest.setPixel(x, 0, new LingoColor(1, 2, 3));
        }

        dest.copyPixels(source, dest.getRect(), new LingoRect(-3, 0, 2, 1), null);

        expect(traces.map((entry) => entry.directCopyCandidate)).toEqual([false]);
        expect(traces.map((entry) => entry.staged)).toEqual([true]);
        expectImagePixel(dest, 0, 0, 0x010203);
        expectImagePixel(dest, 1, 0, 0x010203);
        expectImagePixel(dest, 2, 0, 0x010203);
        expectImagePixel(dest, 3, 0, 0x0a141e);
        expectImagePixel(dest, 4, 0, 0x28323c);
      } finally {
        LingoImage.copyTrace = previousTrace;
      }
    });
  });

  it("preserves self-copy snapshot semantics while staging", () => {
    withPixelCanvas(() => {
      const image = new LingoImage(3, 1, 32);
      image.setPixel(0, 0, new LingoColor(10, 20, 30));
      image.setPixel(1, 0, new LingoColor(40, 50, 60));
      image.setPixel(2, 0, new LingoColor(70, 80, 90));

      image.copyPixels(image, new LingoRect(1, 0, 3, 1), new LingoRect(0, 0, 2, 1), null);

      expect(image.getPixel(0, 0).hex).toBe(0x0a141e);
      expect(image.getPixel(1, 0).hex).toBe(0x0a141e);
      expect(image.getPixel(2, 0).hex).toBe(0x28323c);
    });
  });

  it("applies matte ink 8 by treating white pixels in a non-alpha source as transparent", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.useAlpha = 0;
      source.setPixel(0, 0, new LingoColor(255, 255, 255));
      source.setPixel(1, 0, new LingoColor(20, 40, 60));
      dest.setPixel(0, 0, new LingoColor(1, 2, 3));
      dest.setPixel(1, 0, new LingoColor(4, 5, 6));

      dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 8 });

      expectImagePixel(dest, 0, 0, 0x010203);
      expectImagePixel(dest, 1, 0, 0x14283c);
    });
  });

  it("preserves opaque white artwork when matte-copying an active 32-bit alpha image", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(5, 5, 32);
      const dest = new LingoImage(5, 5, 32);
      source.fill(source.getRect(), new LingoColor(0, 0, 0));
      source.fill(new LingoRect(1, 1, 4, 4), new LingoColor(255, 255, 255));
      dest.fill(dest.getRect(), new LingoColor(10, 20, 30));

      dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 8 });

      expectImagePixel(dest, 0, 0, 0x000000);
      expectImagePixel(dest, 2, 2, 0xffffff);
      expect(dest.getPixelAlpha(2, 2)).toBe(255);

      source.useAlpha = 0;
      const nonAlphaDest = new LingoImage(5, 5, 32);
      nonAlphaDest.fill(nonAlphaDest.getRect(), new LingoColor(10, 20, 30));
      nonAlphaDest.copyPixels(source, nonAlphaDest.getRect(), source.getRect(), { ink: 8 });

      expectImagePixel(nonAlphaDest, 0, 0, 0x000000);
      expectImagePixel(nonAlphaDest, 2, 2, 0x0a141e);
    });
  });

  it("preserves useAlpha when duplicating Director images", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(2, 2, 32);
      source.useAlpha = 0;

      const duplicate = source.duplicate();

      expect(duplicate.useAlpha).toBe(0);
    });
  });

  it("applies Director mask coverage where black mask pixels are opaque", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(2, 1, 32);
      const mask = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.setPixel(0, 0, new LingoColor(20, 40, 60));
      source.setPixel(1, 0, new LingoColor(80, 100, 120));
      mask.setPixel(0, 0, new LingoColor(0, 0, 0));
      mask.setPixel(1, 0, new LingoColor(255, 255, 255));
      dest.setPixel(0, 0, new LingoColor(1, 2, 3));
      dest.setPixel(1, 0, new LingoColor(4, 5, 6));

      dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 9, maskImage: mask });

      expectImagePixel(dest, 0, 0, 0x14283c);
      expectImagePixel(dest, 1, 0, 0x040506);
    });
  });

  it("reuses prepared masked copyPixels sources until source pixels change", () => {
    withPixelCanvas(() => {
      LingoImage.resetCopyPixelsDiagnostics();
      const source = new LingoImage(2, 1, 32);
      const mask = new LingoImage(2, 1, 32);
      const first = new LingoImage(2, 1, 32);
      const second = new LingoImage(2, 1, 32);
      const afterMutation = new LingoImage(2, 1, 32);
      source.setPixel(0, 0, new LingoColor(20, 40, 60));
      source.setPixel(1, 0, new LingoColor(80, 100, 120));
      mask.setPixel(0, 0, new LingoColor(0, 0, 0));
      mask.setPixel(1, 0, new LingoColor(255, 255, 255));
      first.fill(first.getRect(), new LingoColor(1, 2, 3));
      second.fill(second.getRect(), new LingoColor(1, 2, 3));
      afterMutation.fill(afterMutation.getRect(), new LingoColor(1, 2, 3));

      first.copyPixels(source, first.getRect(), source.getRect(), { maskImage: mask });
      second.copyPixels(source, second.getRect(), source.getRect(), { maskImage: mask });
      source.setPixel(0, 0, new LingoColor(30, 50, 70));
      afterMutation.copyPixels(source, afterMutation.getRect(), source.getRect(), { maskImage: mask });

      expectImagePixel(first, 0, 0, 0x14283c);
      expectImagePixel(second, 0, 0, 0x14283c);
      expectImagePixel(afterMutation, 0, 0, 0x1e3246);
      expect(LingoImage.copyPixelsDiagnostics()).toMatchObject({
        hits: 1,
        misses: 2,
        preparedEntries: 2,
      });
    });
  });

  it("keys only boundary-connected white backing before ink 33 addition", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(5, 5, 8);
      const ink33 = new LingoImage(5, 5, 32);
      const ink34 = new LingoImage(1, 1, 32);
      const ink34Source = new LingoImage(1, 1, 32);
      source.fill(new LingoRect(1, 1, 4, 4), new LingoColor(0, 0, 0));
      source.setPixel(2, 2, new LingoColor(255, 255, 255));
      ink33.fill(ink33.getRect(), new LingoColor(4, 5, 6));
      ink34.setPixel(0, 0, new LingoColor(250, 240, 230));
      ink34Source.setPixel(0, 0, new LingoColor(10, 30, 50));

      ink33.copyPixels(source, ink33.getRect(), source.getRect(), { ink: 33 });
      ink34.copyPixels(ink34Source, ink34.getRect(), ink34Source.getRect(), { ink: 34 });

      expectImagePixel(ink33, 0, 0, 0x040506);
      expectImagePixel(ink33, 1, 1, 0x040506);
      expectImagePixel(ink33, 2, 2, 0xffffff);
      expectImagePixel(ink34, 0, 0, 0xffffff);
    });
  });

  it("applies bgColor transparency for ink 36", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.setPixel(0, 0, new LingoColor(1, 2, 3));
      source.setPixel(1, 0, new LingoColor(20, 40, 60));
      dest.setPixel(0, 0, new LingoColor(9, 8, 7));
      dest.setPixel(1, 0, new LingoColor(6, 5, 4));

      dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 36, bgColor: new LingoColor(1, 2, 3) });

      expectImagePixel(dest, 0, 0, 0x090807);
      expectImagePixel(dest, 1, 0, 0x14283c);
    });
  });

  it("copies transparent text-like images into 8-bit destinations with ink 36", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(3, 1, 32, undefined, { initWhite: false });
      const dest = new LingoImage(3, 1, 8);
      source.setPixel(1, 0, new LingoColor(0, 0, 0));

      dest.copyPixels(source, dest.getRect(), source.getRect(), { ink: 36 });

      expectImagePixel(dest, 0, 0, 0xffffff);
      expectImagePixel(dest, 1, 0, 0x000000);
      expectImagePixel(dest, 2, 0, 0xffffff);
    });
  });

  it("applies lighten and darken copyPixels compositing for inks 37 and 39", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(1, 1, 32);
      const lighten = new LingoImage(1, 1, 32);
      const darken = new LingoImage(1, 1, 32);
      source.setPixel(0, 0, new LingoColor(40, 200, 120));
      lighten.setPixel(0, 0, new LingoColor(100, 50, 160));
      darken.setPixel(0, 0, new LingoColor(100, 50, 160));

      lighten.copyPixels(source, lighten.getRect(), source.getRect(), { ink: 37 });
      darken.copyPixels(source, darken.getRect(), source.getRect(), { ink: 39 });

      expectImagePixel(lighten, 0, 0, 0x64c8a0);
      expectImagePixel(darken, 0, 0, 0x283278);
    });
  });

  it("applies ink 41's fixed-point darken color filter before copying", () => {
    withPixelCanvas(() => {
      const source = new LingoImage(1, 1, 32);
      const dest = new LingoImage(1, 1, 32);
      source.setPixel(0, 0, new LingoColor(128, 64, 32));

      dest.copyPixels(source, dest.getRect(), source.getRect(), {
        ink: 41,
        bgColor: new LingoColor(128, 255, 64),
        color: new LingoColor(10, 20, 30),
      });

      expectImagePixel(dest, 0, 0, 0x4a5426);
    });
  });

  it("copies Director horizontal flip quad destinations pixel-for-pixel", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.setPixel(0, 0, new LingoColor(10, 20, 30));
      source.setPixel(1, 0, new LingoColor(200, 210, 220));

      runtime.callMethod(dest, "copyPixels", [
        source,
        new LingoList([
          new LingoPoint(2, 0),
          new LingoPoint(0, 0),
          new LingoPoint(0, 1),
          new LingoPoint(2, 1),
        ]),
        source.getRect(),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0xc8d2dc);
      expect(dest.getPixel(1, 0).hex).toBe(0x0a141e);
    });
  });
});

describe("runtime property access", () => {
  it("reads property-list entries before built-in list properties", () => {
    const runtime = new Runtime();
    const props = LingoPropList.fromPairs([
      [symbol("ilk"), symbol("struct")],
      [symbol("count"), 42],
    ]);

    expect(runtime.getProp(props, "ilk")).toBe(symbol("struct"));
    expect(runtime.getProp(props, "count")).toBe(42);
  });

  it("falls back to built-in property-list properties when entries are absent", () => {
    const runtime = new Runtime();
    const props = LingoPropList.fromPairs([[symbol("name"), "example"]]);

    expect(runtime.getProp(props, "ilk")).toBe(symbol("propList"));
    expect(runtime.getProp(props, "count")).toBe(1);
  });

  it("implements property-list setProp without appending missing keys", () => {
    const runtime = new Runtime();
    const props = LingoPropList.fromPairs([[symbol("value"), 1]]);

    runtime.callMethod(props, "setprop", [symbol("value"), 2]);
    expect(props.getaProp(symbol("value"), (a, b) => a === b)).toBe(2);
    expect(() => runtime.callMethod(props, "setprop", [symbol("missing"), 3])).toThrow(
      /property not found/,
    );
    expect(props.count()).toBe(1);
  });

  it("still exposes built-in ilk for script instances", () => {
    const runtime = new Runtime();
    const instance = new ScriptInstance({
      scriptName: "Example Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });

    expect(runtime.getProp(instance, "ilk")).toBe(symbol("instance"));
  });

  it("stores Director preferences case-insensitively", () => {
    const runtime = new Runtime();

    expect(runtime.call("getPref", ["Blocktime"])).toBe(LINGO_VOID);
    expect(runtime.call("setPref", ["blocktime", "42"])).toBe(1);

    expect(runtime.call("getPref", ["Blocktime"])).toBe("42");
  });

  it("converts extended Windows projector characters through numToChar and charToNum", () => {
    const runtime = new Runtime();

    expect(runtime.call("numtochar", [131])).toBe("\u0192");
    expect(runtime.call("numtochar", [145])).toBe("\u2018");
    expect(runtime.call("numtochar", [149])).toBe("\u2022");
    expect(runtime.call("numtochar", [151])).toBe("\u2014");
    expect(runtime.call("numtochar", [153])).toBe("\u2122");
    expect(runtime.call("chartonum", ["\u2122"])).toBe(153);
    expect(runtime.call("chartonum", ["A"])).toBe(65);
  });

  it("implements Director power(base, exponent) as floating-point exponentiation", () => {
    const runtime = new Runtime();

    expect(expectFloatValue(runtime.call("power", [4, 3]))).toBe(64);
    expect(expectFloatValue(runtime.call("power", [2, -2]))).toBe(0.25);
    expect(expectFloatValue(runtime.call("power", [9, new LingoFloat(0.5)]))).toBe(3);
  });

  it("stores the Director result register from call(#handler, list)", () => {
    const runtime = new Runtime();
    const missingHandler = new ScriptInstance({
      scriptName: "No Handler Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const target = new ScriptInstance({
      scriptName: "Target Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        choose(ctx, me, args) {
          return ctx.getInstanceProp(me, "value");
        },
      },
    });
    runtime.setProp(target, "value", 7);

    expect(runtime.call("call", [symbol("choose"), new LingoList([missingHandler, target])])).toBe(7);
    expect(runtime.theProp("result")).toBe(7);
  });

  it("defers visualizer wrapper removepart repaint until the outer handler returns", () => {
    const runtime = new Runtime();
    let updateCount = 0;
    const wrapper = new ScriptInstance(
      moduleFor(
        "Visualizer Part Wrapper Class",
        "parent",
        {
          updatewrap: () => {
            updateCount += 1;
            return 1;
          },
        },
        ["pPartList", "pWrapperStatus"],
      ),
    );
    wrapper.props.set("ppartlist", new LingoList([LingoPropList.fromPairs([[symbol("id"), "shadow-1"]])]));
    wrapper.props.set("pwrapperstatus", LingoPropList.fromPairs([[symbol("rendered"), 1], [symbol("rectOk"), 1]]));

    runtime.register(
      moduleFor("Wrapper Test Movie", "movie", {
        test: (ctx) => {
          ctx.callMethod(wrapper, "removepart", ["shadow-1"]);
          expect(updateCount).toBe(0);
          return 1;
        },
      }),
      "test",
    );

    expect(runtime.call("test", [])).toBe(1);
    expect(updateCount).toBe(1);
  });

  it("does not duplicate a deferred visualizer repaint when source explicitly updates the wrapper", () => {
    const runtime = new Runtime();
    let updateCount = 0;
    const wrapper = new ScriptInstance(
      moduleFor(
        "Visualizer Part Wrapper Class",
        "parent",
        {
          updatewrap: () => {
            updateCount += 1;
            return 1;
          },
        },
        ["pPartList", "pWrapperStatus"],
      ),
    );
    wrapper.props.set("ppartlist", new LingoList([LingoPropList.fromPairs([[symbol("id"), "shadow-1"]])]));
    wrapper.props.set("pwrapperstatus", LingoPropList.fromPairs([[symbol("rendered"), 1], [symbol("rectOk"), 1]]));

    runtime.register(
      moduleFor("Wrapper Test Movie", "movie", {
        test: (ctx) => {
          ctx.callMethod(wrapper, "removepart", ["shadow-1"]);
          ctx.callMethod(wrapper, "updatewrap", []);
          expect(updateCount).toBe(1);
          return 1;
        },
      }),
      "test",
    );

    expect(runtime.call("test", [])).toBe(1);
    expect(updateCount).toBe(1);
  });

  it("defers repeated shadow manager renders until the outer handler returns", () => {
    const runtime = new Runtime();
    let updateCount = 0;
    const wrapper = new ScriptInstance(
      moduleFor(
        "Visualizer Part Wrapper Class",
        "parent",
        {
          updatewrap: () => {
            updateCount += 1;
            return 1;
          },
        },
        ["pPartList", "pWrapperStatus"],
      ),
    );
    wrapper.props.set("ppartlist", new LingoList([LingoPropList.fromPairs([[symbol("id"), "shadow-1"]])]));
    wrapper.props.set("pwrapperstatus", LingoPropList.fromPairs([[symbol("rendered"), 1], [symbol("rectOk"), 1]]));
    const shadowManager = new ScriptInstance(
      moduleFor(
        "Shadow Manager",
        "parent",
        {
          render: () => {
            throw new Error("Shadow Manager.render should be handled by the presentation scheduler");
          },
        },
        ["pShadowWrapper", "pRenderDisabled"],
      ),
    );
    shadowManager.props.set("pshadowwrapper", wrapper);
    shadowManager.props.set("prenderdisabled", 0);

    runtime.register(
      moduleFor("Shadow Test Movie", "movie", {
        test: (ctx) => {
          ctx.callMethod(shadowManager, "render", []);
          ctx.callMethod(shadowManager, "render", []);
          expect(updateCount).toBe(0);
          return 1;
        },
      }),
      "test",
    );

    expect(runtime.call("test", [])).toBe(1);
    expect(updateCount).toBe(1);
  });

  it("does not duplicate deferred shadow manager renders after an explicit wrapper update", () => {
    const runtime = new Runtime();
    let updateCount = 0;
    const wrapper = new ScriptInstance(
      moduleFor(
        "Visualizer Part Wrapper Class",
        "parent",
        {
          updatewrap: () => {
            updateCount += 1;
            return 1;
          },
        },
        ["pPartList", "pWrapperStatus"],
      ),
    );
    wrapper.props.set("ppartlist", new LingoList([LingoPropList.fromPairs([[symbol("id"), "shadow-1"]])]));
    wrapper.props.set("pwrapperstatus", LingoPropList.fromPairs([[symbol("rendered"), 1], [symbol("rectOk"), 1]]));
    const shadowManager = new ScriptInstance(
      moduleFor("Shadow Manager", "parent", {}, ["pShadowWrapper", "pRenderDisabled"]),
    );
    shadowManager.props.set("pshadowwrapper", wrapper);
    shadowManager.props.set("prenderdisabled", 0);

    runtime.register(
      moduleFor("Shadow Test Movie", "movie", {
        test: (ctx) => {
          ctx.callMethod(shadowManager, "render", []);
          ctx.callMethod(wrapper, "updatewrap", []);
          expect(updateCount).toBe(1);
          return 1;
        },
      }),
      "test",
    );

    expect(runtime.call("test", [])).toBe(1);
    expect(updateCount).toBe(1);
  });

  it("resets the classic Director timer with startTimer", () => {
    const runtime = new Runtime();

    runtime.call("startTimer", []);

    const timer = runtime.theProp("timer");
    expect(typeof timer).toBe("number");
    expect(timer as number).toBeGreaterThanOrEqual(0);
    expect(timer as number).toBeLessThan(3);
  });

  it("keeps random(n) from collapsing under JavaScript number precision", () => {
    const runtime = new Runtime();
    runtime.setTheProp("randomSeed", 0x12345678);

    const values = Array.from({ length: 8 }, () => runtime.call("random", [4]));

    expect(values).toEqual([2, 3, 4, 1, 2, 3, 4, 1]);
  });

  it("supports outputList as a diagnostic Message-window builtin", () => {
    const lines: string[] = [];
    const runtime = new Runtime({ put: (text) => lines.push(text) });

    expect(runtime.call("outputList", [new LingoList(["bad", "data"])])).toBe(LINGO_VOID);
    expect(lines).toEqual(["[\"bad\", \"data\"]"]);
  });

  it("represents real script members without generated modules as non-objects", () => {
    const runtime = new Runtime();
    const missing = new MissingScriptRef("42009274", "Balloon Furni Class", 42009274, "hh_room");
    const instance = runtime.callMethod(missing, "new", []);

    expect(instance).toBeInstanceOf(MissingScriptInstance);
    expect(runtime.call("objectp", [instance])).toBe(0);
    expect(runtime.call("ilk", [instance, symbol("instance")])).toBe(0);
    expect(runtime.callMethod(instance, "handler", [symbol("construct")])).toBe(0);
  });

  it("broadcasts call() to host-backed objects in lists", () => {
    const handled = { lingoType: "hostTarget" } as never;
    const skipped = { lingoType: "hostTarget" } as never;
    const calls: unknown[][] = [];
    const runtime = new Runtime({
      callMethod(receiver, method, args) {
        if (receiver !== handled || method !== "registerprocedure") return undefined;
        calls.push(args);
        return 1;
      },
    });

    const result = runtime.call("call", [
      symbol("registerProcedure"),
      new LingoList([skipped, handled]),
      symbol("eventProcRoom"),
      "Room_interface",
      symbol("mouseDown"),
    ]);

    expect(result).toBe(1);
    expect(calls).toEqual([[symbol("eventProcRoom"), "Room_interface", symbol("mouseDown")]]);
  });

  it("silently skips invalid and non-handling call() broadcast targets", () => {
    const skippedHostObject = { lingoType: "sprite" } as never;
    const skippedInstance = new ScriptInstance({
      scriptName: "Plain Sprite Behavior",
      scriptType: "behavior",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const runtime = new Runtime();

    const result = runtime.call("call", [
      symbol("registerProcedure"),
      new LingoList(["room_visualizer", 0, skippedHostObject, skippedInstance]),
      symbol("eventProcRoom"),
      "Room_interface",
      symbol("mouseDown"),
    ]);

    expect(result).toBe(LINGO_VOID);
    expect(runtime.unsupportedDiagnostics().entries).toEqual([]);
  });

  it("resolves Manager Template item ids before call() broadcasts to managed objects", () => {
    const runtime = new Runtime();
    const calls: unknown[][] = [];
    const visualizer = new ScriptInstance({
      scriptName: "Visualizer Instance Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        moveby(_ctx, _me, args) {
          calls.push(args);
          return 1;
        },
      },
    });
    const objectManager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: ["pObjectList"],
      scriptGlobals: [],
      handlers: {
        get(ctx, me, args) {
          const objectList = ctx.getInstanceProp(args[0] ?? me, "pobjectlist");
          const value = ctx.getIndex(objectList, [args[1] ?? LINGO_VOID], null);
          return value === LINGO_VOID ? 0 : value;
        },
      },
    });
    const managerTemplate = new ScriptInstance({
      scriptName: "Manager Template Class",
      scriptType: "parent",
      scriptProperties: ["pItemList"],
      scriptGlobals: [],
      handlers: {
        get(ctx, _me, args) {
          return ctx.callMethod(objectManager, "get", [args[1] ?? LINGO_VOID]);
        },
      },
    });
    const visualizerManager = new ScriptInstance({
      scriptName: "Visualizer Manager Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        setboundary(ctx, me, args) {
          const self = args[0] ?? me;
          return ctx.callLocal(self, "call", [symbol("moveBy"), ctx.getProp(self, "pitemlist"), 3, 4]);
        },
      },
    });

    runtime.setProp(objectManager, "pobjectlist", LingoPropList.fromPairs([["room_visualizer", visualizer]]));
    runtime.setIndex(visualizerManager, [symbol("ancestor")], null, managerTemplate);
    runtime.setProp(visualizerManager, "pitemlist", new LingoList(["room_visualizer"]));

    expect(runtime.callMethod(visualizerManager, "setboundary", [])).toBe(1);
    expect(calls).toEqual([[visualizer, 3, 4]]);
    expect(runtime.unsupportedDiagnostics().entries).toEqual([]);
  });

  it("reports unsupported errors thrown inside call() target handlers", () => {
    const lines: string[] = [];
    const runtime = new Runtime({ put: (text) => lines.push(text) });
    const instance = new ScriptInstance({
      scriptName: "Room Interface Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        eventprocactiveobj(ctx) {
          return ctx.theProp("rollover");
        },
      },
    });

    expect(runtime.call("call", [symbol("eventProcActiveObj"), instance, symbol("mouseDown"), "971822"])).toBe(
      LINGO_VOID,
    );
    expect(lines.some((line) => line.includes("script error in #eventProcActiveObj: unsupported: the rollover"))).toBe(
      true,
    );
  });

  it("does not record ordinary call() target script errors as unsupported diagnostics", () => {
    const lines: string[] = [];
    const runtime = new Runtime({ put: (text) => lines.push(text) });
    const instance = new ScriptInstance({
      scriptName: "Pool Cloud Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        update() {
          throw new Error("mod by zero");
        },
      },
    });

    expect(runtime.call("call", [symbol("update"), instance])).toBe(LINGO_VOID);
    expect(runtime.unsupportedDiagnostics().entries).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("script error in #update: mod by zero");
  });

  it("does not classify primitive receiver method calls as unsupported Director APIs", () => {
    const runtime = new Runtime();

    expect(() => runtime.callMethod(0, "try", [])).toThrow("method try on <number>");
    expect(runtime.unsupportedDiagnostics().entries).toEqual([]);
  });

  it("parses room packet control-prefixed integer strings", () => {
    const runtime = new Runtime();

    expect(runtime.call("integer", [String.fromCharCode(2) + "184123"])).toBe(184123);
    expect(runtime.call("integer", ["poster184123"])).toBe(LINGO_VOID);
  });

  it("parses protocol-delimited float fields used by purse packets", () => {
    const runtime = new Runtime();
    const packetSeparator = String.fromCharCode(2);
    const parsed = runtime.call("float", [`98.0${packetSeparator}`]);

    expect(parsed).toBeInstanceOf(LingoFloat);
    expect((parsed as LingoFloat).value).toBe(98);
    expect(runtime.call("integer", [parsed])).toBe(98);
    expect(runtime.call("float", ["98.0credits"])).toBe(LINGO_VOID);
  });

  it("creates Director palette-index colors with RGB properties", () => {
    const runtime = new Runtime();
    const color = runtime.call("paletteIndex", [82]);

    expect(color).toBeInstanceOf(LingoColor);
    expect(runtime.getProp(color, "paletteIndex")).toBe(82);
    expect(runtime.getProp(color, "colorType")).toBe(symbol("paletteIndex"));
    expect(runtime.getProp(color, "red")).toBeTypeOf("number");
    expect(runtime.callMethod(color, "hexstring", [])).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("supports Director color constructors", () => {
    const runtime = new Runtime();
    const rgb = runtime.call("color", [symbol("rgb"), 1, 2, 3]);
    const pal = runtime.call("color", [symbol("paletteIndex"), 82]);

    expect(rgb).toEqual(new LingoColor(1, 2, 3));
    expect(runtime.getProp(rgb, "colorType")).toBe(symbol("rgb"));
    expect(runtime.getProp(pal, "paletteIndex")).toBe(82);
  });

  it("allows Director color channel mutation", () => {
    const runtime = new Runtime();
    const color = runtime.call("paletteIndex", [82]) as LingoColor;

    runtime.setProp(color, "red", 12.5);
    runtime.setProp(color, "green", 34);
    runtime.setProp(color, "blue", 56);

    expect(runtime.getProp(color, "red")).toBe(12.5);
    expect(runtime.getProp(color, "green")).toBe(34);
    expect(runtime.getProp(color, "blue")).toBe(56);
    expect(runtime.getProp(color, "colorType")).toBe(symbol("rgb"));
  });

  it("allows Director paletteIndex reassignment on colors", () => {
    const runtime = new Runtime();
    const color = new LingoColor(1, 2, 3);

    runtime.setProp(color, "paletteIndex", 82);

    expect(runtime.getProp(color, "paletteIndex")).toBe(82);
    expect(runtime.getProp(color, "colorType")).toBe(symbol("paletteIndex"));
    expect(runtime.getProp(color, "red")).toBeTypeOf("number");
  });

  it("evaluates Director constants inside value() field literals", () => {
    const runtime = new Runtime();
    const parsed = runtime.call("value", [
      "[\"b\": [#style: #fontStyle, #default:[#bold]], \"br\":[#replace:RETURN], \"empty\":[#value:EMPTY], \"void\":[#value:VOID]]",
    ]);

    expect(parsed).toBeInstanceOf(LingoPropList);
    const bold = runtime.getIndex(parsed, ["b"], null);
    const br = runtime.getIndex(parsed, ["br"], null);
    const empty = runtime.getIndex(parsed, ["empty"], null);
    const voidValue = runtime.getIndex(parsed, ["void"], null);

    expect(runtime.getIndex(bold, [symbol("style")], null)).toBe(symbol("fontStyle"));
    expect(runtime.getIndex(br, [symbol("replace")], null)).toBe("\r");
    expect(runtime.getIndex(empty, [symbol("value")], null)).toBe("");
    expect(runtime.getIndex(voidValue, [symbol("value")], null)).toBe(LINGO_VOID);
  });

  it("evaluates bare property-list keys used by room animation data", () => {
    const runtime = new Runtime();
    const parsed = runtime.call("value", [
      "[states:[1,2,3], layers:[ a:[ [ frames:[ 0 ] ], [ frames:[ 1 ] ] ] ]]",
    ]);

    expect(parsed).toBeInstanceOf(LingoPropList);
    expect(runtime.getIndex(parsed, [symbol("states")], null)).toBeInstanceOf(LingoList);
    const layers = runtime.getIndex(parsed, [symbol("layers")], null);
    expect(layers).toBeInstanceOf(LingoPropList);
    expect(runtime.getIndex(layers, [symbol("a")], null)).toBeInstanceOf(LingoList);
  });

  it("evaluates unary plus in authored furniture props field literals", () => {
    const runtime = new Runtime();
    const parsed = runtime.call("value", [
      '["a": [#zshift: [0, 0, 0, 0, +10], #locshift:[0,0,0,0,point(26,13)]]]',
    ]);

    expect(parsed).toBeInstanceOf(LingoPropList);
    const part = runtime.getIndex(parsed, ["a"], null);
    const zshift = runtime.getIndex(part, [symbol("zshift")], null) as LingoList;
    const locshift = runtime.getIndex(part, [symbol("locshift")], null) as LingoList;
    expect(zshift.getAt(5)).toBe(10);
    expect(locshift.getAt(5)).toEqual(new LingoPoint(26, 13));
  });

  it("tolerates surplus trailing brackets in authored props field literals", () => {
    const runtime = new Runtime();
    const parsed = runtime.call("value", [
      '["a": [#ink: 36, #zshift: [-1000]], "b": [#ink: 36, #zshift: [-1005], #blend: 20]]]',
    ]);

    expect(parsed).toBeInstanceOf(LingoPropList);
    const b = runtime.getIndex(parsed, ["b"], null);
    expect(runtime.getIndex(b, [symbol("blend")], null)).toBe(20);
  });

  it("reads property-list symbol keys through string ids without overwriting exact string keys", () => {
    const runtime = new Runtime();
    const props = LingoPropList.fromPairs([[symbol("session"), "symbol-session"]]);

    expect(runtime.callMethod(props, "getaprop", ["session"])).toBe("symbol-session");
    runtime.callMethod(props, "setaprop", ["session", "string-session"]);

    expect(props.count()).toBe(2);
    expect(runtime.callMethod(props, "getaprop", ["session"])).toBe("string-session");
    expect(runtime.callMethod(props, "getaprop", [symbol("session")])).toBe("symbol-session");
  });

  it("indexes property lists exact-first before string/symbol fallback", () => {
    const runtime = new Runtime();
    const objectList = LingoPropList.fromPairs([
      [symbol("session"), "session-object"],
      [symbol("room_interface"), "thread-object"],
      ["Room_interface", "window-object"],
    ]);

    expect(runtime.getIndex(objectList, ["session"], null)).toBe("session-object");
    expect(runtime.getIndex(objectList, [symbol("session")], null)).toBe("session-object");
    expect(runtime.getIndex(objectList, ["Room_interface"], null)).toBe("window-object");
    expect(runtime.getIndex(objectList, [symbol("room_interface")], null)).toBe("thread-object");

    const images = LingoPropList.fromPairs([[symbol("top_up"), "image"]]);
    expect(runtime.getIndex(images, ["top_up"], null)).toBe("image");
  });

  it("sorts nested linear-list rows lexicographically like Director", () => {
    const runtime = new Runtime();
    const rows = new LingoList([
      new LingoList(["Sun Chaser", "a9902379", "third"]),
      new LingoList(["Balloon Scraps", "a9851606", "first"]),
      new LingoList(["Balloon Scraps", "a9851610", "second"]),
    ]);

    runtime.callMethod(rows, "sort", []);

    expect((rows.items[0] as LingoList).items).toEqual(["Balloon Scraps", "a9851606", "first"]);
    expect((rows.items[1] as LingoList).items).toEqual(["Balloon Scraps", "a9851610", "second"]);
    expect((rows.items[2] as LingoList).items).toEqual(["Sun Chaser", "a9902379", "third"]);
  });

  it("exposes Director date properties and ilk", () => {
    const runtime = new Runtime();
    const date = new LingoDate(2026, 6, 11);

    expect(runtime.getProp(date, "year")).toBe(2026);
    expect(runtime.getProp(date, "month")).toBe(6);
    expect(runtime.getProp(date, "day")).toBe(11);
    expect(runtime.getProp(date, "ilk")).toBe(symbol("date"));
    expect(runtime.call("ilk", [date, symbol("date")])).toBe(1);
  });

  it("mutates Director point and rect properties", () => {
    const runtime = new Runtime();
    const point = new LingoPoint(10, 20);
    const rect = new LingoRect(1, 2, 11, 22);

    runtime.setProp(point, "locH", 15);
    runtime.setProp(point, "locV", 25);
    expect(point).toEqual(new LingoPoint(15, 25));

    runtime.setProp(rect, "top", 5);
    runtime.setProp(rect, "width", 30);
    runtime.setProp(rect, "height", 40);
    expect(rect).toEqual(new LingoRect(1, 5, 31, 45));
  });

  it("computes min and max from a single Director list argument", () => {
    const runtime = new Runtime();
    const values = new LingoList([42, -3, 18]);

    expect(runtime.call("min", [values])).toBe(-3);
    expect(runtime.call("max", [values])).toBe(42);
  });

  it("resolves Director trigonometry builtins and numeric method aliases", () => {
    const runtime = new Runtime();

    expect(expectFloatValue(runtime.call("sin", [float(Math.PI / 2)])).toFixed(10)).toBe("1.0000000000");
    expect(expectFloatValue(runtime.call("cos", [float(0)])).toFixed(10)).toBe("1.0000000000");
    expect(expectFloatValue(runtime.call("tan", [float(Math.PI / 4)])).toFixed(10)).toBe("1.0000000000");
    expect(expectFloatValue(runtime.call("atan", [1])).toFixed(10)).toBe((Math.PI / 4).toFixed(10));

    expect(expectFloatValue(runtime.callMethod(float(Math.PI / 2), "sin", [])).toFixed(10)).toBe("1.0000000000");
    expect(expectFloatValue(runtime.callMethod(0, "cos", [])).toFixed(10)).toBe("1.0000000000");
  });

  it("exposes Director's maxInteger runtime property", () => {
    const runtime = new Runtime();

    expect(runtime.theProp("maxInteger")).toBe(2147483647);
  });

  it("keeps the classic Director timer as a resettable 60 Hz clock", () => {
    const runtime = new Runtime();

    runtime.call("startTimer", []);
    const timer = runtime.theProp("timer");

    expect(typeof timer).toBe("number");
    expect(timer as number).toBeGreaterThanOrEqual(0);
    expect(timer as number).toBeLessThan(3);
  });

  it("exposes scalar string and integer value-level properties", () => {
    const runtime = new Runtime();

    expect(runtime.getProp("1024173", "string")).toBe("1024173");
    expect(runtime.getProp("42", "integer")).toBe(42);
    expect(runtime.getProp(42, "string")).toBe("42");
  });

  it("treats the empty sprite member sentinel as an empty member name", () => {
    const runtime = new Runtime();

    expect(runtime.getProp(0, "name")).toBe("");
  });

  it("duplicates Director geometry and color values without aliasing", () => {
    const runtime = new Runtime();
    const point = new LingoPoint(10, 20);
    const rect = new LingoRect(1, 2, 11, 22);
    const color = new LingoColor(4, 5, 6, 82);

    const pointCopy = runtime.callMethod(point, "duplicate", []) as LingoPoint;
    expect(pointCopy).toEqual(point);
    expect(pointCopy).not.toBe(point);
    runtime.setIndex(pointCopy, [1], null, 30);
    expect(point).toEqual(new LingoPoint(10, 20));
    expect(pointCopy).toEqual(new LingoPoint(30, 20));

    const rectCopy = runtime.callMethod(rect, "duplicate", []) as LingoRect;
    expect(rectCopy).toEqual(rect);
    expect(rectCopy).not.toBe(rect);
    runtime.setIndex(rectCopy, [2], null, 9);
    expect(rect).toEqual(new LingoRect(1, 2, 11, 22));
    expect(rectCopy).toEqual(new LingoRect(1, 9, 11, 22));

    const colorCopy = runtime.callMethod(color, "duplicate", []) as LingoColor;
    expect(colorCopy).toEqual(color);
    expect(colorCopy).not.toBe(color);
  });

  it("computes Director rect union and intersection", () => {
    const runtime = new Runtime();
    const left = new LingoRect(0, 0, 10, 10);
    const right = new LingoRect(15, 5, 20, 12);

    expect(runtime.call("union", [left, right])).toEqual(new LingoRect(0, 0, 20, 12));
    expect(runtime.callMethod(left, "union", [right])).toEqual(new LingoRect(0, 0, 20, 12));
    expect(runtime.call("intersect", [left, new LingoRect(5, -2, 12, 4)])).toEqual(
      new LingoRect(5, 0, 10, 4),
    );
    expect(runtime.callMethod(left, "intersect", [right])).toEqual(new LingoRect(0, 0, 0, 0));
  });

  it("accepts coordinate-form image fill calls", () => {
    const calls: Array<[number, number, number, number]> = [];
    const ctx = {
      canvas: { width: 20, height: 20 },
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      putImageData: () => {},
      drawImage: () => {},
      fillStyle: "",
      fillRect: (x: number, y: number, w: number, h: number) => calls.push([x, y, w, h]),
      clearRect: () => {},
      globalAlpha: 1,
    };
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) },
    });
    try {
      const runtime = new Runtime();
      const image = new LingoImage(20, 20, 8);
      // Director images initialize white (first recorded fill), then the
      // coordinate-form fill(left, top, right, bottom, color) applies.
      runtime.callMethod(image, "fill", [2, 3, 12, 9, new LingoColor(4, 5, 6)]);
      expect(calls).toEqual([
        [0, 0, 20, 20],
        [2, 3, 10, 6],
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });

  it("resolves palette-index image fills through the image palette", () => {
    const fills: Array<{ style: string; rect: [number, number, number, number] }> = [];
    let fillStyle = "";
    const ctx = {
      canvas: { width: 4, height: 4 },
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      putImageData: () => {},
      drawImage: () => {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      fillRect: (x: number, y: number, w: number, h: number) =>
        fills.push({ style: fillStyle, rect: [x, y, w, h] }),
      clearRect: () => {},
      globalAlpha: 1,
    };
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) },
    });
    try {
      const runtime = new Runtime();
      const paletteRef = { lingoType: "member", paletteColors: [0x000000, 0x112233, 0xabcdef] } as any;
      const image = new LingoImage(4, 4, 8, paletteRef);

      runtime.callMethod(image, "fill", [1, 1, 3, 3, new LingoColor(255, 255, 255, 2)]);

      expect(fills).toEqual([
        { style: "rgb(255, 255, 255)", rect: [0, 0, 4, 4] },
        { style: "rgb(171, 205, 239)", rect: [1, 1, 2, 2] },
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });

  it("applies copyPixels #color foreground materialization to known 1-bit sources", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = LingoImage.fromPaletteIndices(
        2,
        1,
        new Uint8Array([1, 0]),
        paletteTableForBitmapDepth("systemMac", 1),
        symbol("systemMac"),
        1,
      );
      const dest = new LingoImage(2, 1, 32);

      runtime.callMethod(dest, "copyPixels", [
        source,
        source.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([[symbol("color"), new LingoColor(255, 0, 0)]]),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0xff0000);
      expect(dest.getPixel(1, 0).hex).toBe(0xffffff);
    });
  });

  it("does not recolor 32-bit source pixels during background-transparent keying", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.setPixel(1, 0, new LingoColor(0, 0, 0));

      runtime.callMethod(dest, "copyPixels", [
        source,
        source.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([
          [symbol("ink"), 36],
          [symbol("color"), new LingoColor(255, 255, 255)],
        ]),
      ]);

      expect(dest.getPixel(1, 0).hex).toBe(0x000000);
    });
  });

  it("preserves colors already materialized into a 32-bit runtime image", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = new LingoImage(2, 1, 32, undefined, { initWhite: false });
      const dest = new LingoImage(2, 1, 32, undefined, { initWhite: false });
      source.setPixel(0, 0, new LingoColor(0x67, 0x94, 0xa7));
      source.setPixel(1, 0, new LingoColor(0xee, 0xee, 0xee));

      runtime.callMethod(dest, "copyPixels", [
        source,
        source.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([
          [symbol("color"), new LingoColor(0xee, 0xee, 0xee)],
          [symbol("bgColor"), new LingoColor(0x67, 0x94, 0xa7)],
        ]),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0x6794a7);
      expect(dest.getPixel(1, 0).hex).toBe(0xeeeeee);
    });
  });

  it("accepts symbolic copyPixels ink names from Lingo property lists", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = new LingoImage(2, 1, 32);
      const dest = new LingoImage(2, 1, 32);
      source.setPixel(0, 0, new LingoColor(255, 255, 255));
      source.setPixel(1, 0, new LingoColor(20, 40, 60));
      dest.setPixel(0, 0, new LingoColor(9, 8, 7));
      dest.setPixel(1, 0, new LingoColor(6, 5, 4));

      runtime.callMethod(dest, "copyPixels", [
        source,
        source.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([[symbol("ink"), symbol("backgroundTransparent")]]),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0x090807);
      expect(dest.getPixel(1, 0).hex).toBe(0x14283c);
    });
  });

  it("preserves source alpha when copyPixels matte copies runtime text-like images", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const source = new LingoImage(2, 1, 32, undefined, { initWhite: false });
      const dest = new LingoImage(2, 1, 32, undefined, { initWhite: false });
      source.setPixel(0, 0, new LingoColor(255, 255, 255));

      runtime.callMethod(dest, "copyPixels", [
        source,
        source.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([[symbol("ink"), 8]]),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0xffffff);
      expect(dest.getPixelAlpha(0, 0)).toBe(255);
      expect(dest.getPixelAlpha(1, 0)).toBe(0);
    });
  });

  it("uses normal luma polarity for opaque setAlpha images", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const dest = new LingoImage(2, 1, 32);
      const alpha = new LingoImage(2, 1, 8);
      dest.fill(dest.getRect(), new LingoColor(255, 0, 0));
      alpha.setPixel(0, 0, new LingoColor(0, 0, 0));
      alpha.setPixel(1, 0, new LingoColor(255, 255, 255));

      runtime.callMethod(dest, "setAlpha", [alpha]);

      expect(dest.getPixelAlpha(0, 0)).toBe(0);
      expect(dest.getPixelAlpha(1, 0)).toBe(255);
    });
  });

  it("uses Director 8-bit alpha index values instead of rendered grayscale RGB", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const dest = new LingoImage(2, 1, 32);
      const alpha = LingoImage.fromPaletteIndices(
        2,
        1,
        new Uint8Array([0, 255]),
        paletteTableForBitmapDepth("grayscale", 8),
        symbol("grayscale"),
        8,
      );
      dest.fill(dest.getRect(), new LingoColor(255, 0, 0));

      runtime.callMethod(dest, "setAlpha", [alpha]);

      expect(alpha.getPixel(0, 0).hex).toBe(0xffffff);
      expect(alpha.getPixel(1, 0).hex).toBe(0x000000);
      expect(dest.getPixelAlpha(0, 0)).toBe(0);
      expect(dest.getPixelAlpha(1, 0)).toBe(255);
    });
  });

  it("keeps matte polarity for setAlpha images that already carry transparent backing", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const dest = new LingoImage(2, 1, 32);
      const source = new LingoImage(2, 1, 32, undefined, { initWhite: false });
      dest.fill(dest.getRect(), new LingoColor(255, 0, 0));
      source.setPixel(0, 0, new LingoColor(0, 0, 0));

      runtime.callMethod(dest, "setAlpha", [source.createMatte()]);

      expect(dest.getPixelAlpha(0, 0)).toBe(255);
      expect(dest.getPixelAlpha(1, 0)).toBe(0);
    });
  });

  it("clears the reused copyPixels staging canvas between differently sized copies", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const large = new LingoImage(4, 4, 32, undefined, { initWhite: false });
      const small = new LingoImage(1, 1, 32, undefined, { initWhite: false });
      const dest = new LingoImage(4, 4, 32, undefined, { initWhite: false });
      large.fill(large.getRect(), new LingoColor(255, 0, 0));
      small.setPixel(0, 0, new LingoColor(0, 255, 0));

      runtime.callMethod(dest, "copyPixels", [large, large.getRect(), large.getRect()]);
      dest.fill(dest.getRect(), new LingoColor(0, 0, 0));
      runtime.callMethod(dest, "copyPixels", [small, small.getRect(), small.getRect()]);

      expect(dest.getPixel(0, 0).hex).toBe(0x00ff00);
      expect(dest.getPixel(1, 0).hex).toBe(0x000000);
      expect(dest.getPixel(0, 1).hex).toBe(0x000000);
    });
  });

  it("crops the reused copyPixels staging canvas for skewed quad destinations", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const large = new LingoImage(4, 4, 32, undefined, { initWhite: false });
      const source = new LingoImage(2, 2, 32, undefined, { initWhite: false });
      const dest = new LingoImage(4, 4, 32, undefined, { initWhite: false });
      large.fill(large.getRect(), new LingoColor(255, 0, 0));
      source.fill(source.getRect(), new LingoColor(0, 255, 0));
      dest.fill(dest.getRect(), new LingoColor(0, 0, 0));

      runtime.callMethod(dest, "copyPixels", [large, large.getRect(), large.getRect()]);
      dest.fill(dest.getRect(), new LingoColor(0, 0, 0));
      runtime.callMethod(dest, "copyPixels", [
        source,
        new LingoList([
          new LingoPoint(0, 0),
          new LingoPoint(2, 0),
          new LingoPoint(3, 2),
          new LingoPoint(1, 2),
        ]),
        source.getRect(),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0x00ff00);
      expect(dest.getPixel(1, 0).hex).toBe(0x00ff00);
      expect(dest.getPixel(2, 1).hex).toBe(0x00ff00);
      expect(dest.getPixel(3, 2).hex).toBe(0x000000);
    });
  });

  it("materializes bitmap member.image as a live mutable member surface", () => {
    withPixelCanvas(() => {
      const decoded = new LingoImage(2, 2, 32, undefined, { initWhite: false });
      decoded.fill(decoded.getRect(), new LingoColor(255, 0, 0));
      const member = new CastMember("External", 1, 1, "fuse_screen", "bitmap", {
        bitmap: {
          width: 2,
          height: 2,
          regX: 0,
          regY: 0,
          pngUrl: "fuse_screen.png",
          decoded,
        },
      });

      const live = member.mutableImage();
      live.setPixel(0, 0, new LingoColor(0, 255, 0));

      expect(member.image).toBe(live);
      expect(member.effectiveImage()).toBe(live);
      expect(live.getPixel(0, 0).hex).toBe(0x00ff00);
      expect(decoded.getPixel(0, 0).hex).toBe(0xff0000);
    });
  });

  it("re-renders palette-indexed image duplicates when paletteRef changes", () => {
    withPixelCanvas(() => {
      const paletteA = { lingoType: "member", paletteColors: [0x000000, 0x112233] } as any;
      const paletteB = { lingoType: "member", paletteColors: [0xffffff, 0xaabbcc] } as any;
      const image = LingoImage.fromPaletteIndices(1, 1, new Uint8Array([1]), paletteA.paletteColors, paletteA);

      expect(image.getPixel(0, 0).hex).toBe(0x112233);

      const copy = image.duplicate();
      copy.paletteRef = paletteB;

      expect(copy.getPixel(0, 0).hex).toBe(0xaabbcc);
      expect(image.getPixel(0, 0).hex).toBe(0x112233);

      copy.fill(copy.getRect(), new LingoColor(1, 2, 3));
      copy.paletteRef = paletteA;

      expect(copy.getPixel(0, 0).hex).toBe(0x010203);
    });
  });

  it("applies copyPixels #palette to indexed source pixels without mutating the source", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const paletteA = { lingoType: "member", paletteColors: [0x000000, 0x112233] } as any;
      const paletteB = { lingoType: "member", paletteColors: [0xffffff, 0xaabbcc] } as any;
      const source = LingoImage.fromPaletteIndices(1, 1, new Uint8Array([1]), paletteA.paletteColors, paletteA);
      const dest = new LingoImage(1, 1, 32, symbol("systemMac"), { initWhite: false });

      runtime.callMethod(dest, "copyPixels", [
        source,
        dest.getRect(),
        source.getRect(),
        LingoPropList.fromPairs([[symbol("palette"), paletteB]]),
      ]);

      expect(dest.getPixel(0, 0).hex).toBe(0xaabbcc);
      expect(source.getPixel(0, 0).hex).toBe(0x112233);
    });
  });

  it("does not reinterpret 2-bit indexed images as 256-color system palettes", () => {
    withPixelCanvas(() => {
      const image = LingoImage.fromPaletteIndices(
        4,
        1,
        new Uint8Array([0, 1, 2, 3]),
        [0xffffff, 0xa3a3a3, 0x656565, 0x000000],
        symbol("systemMac"),
        2,
      );

      expect(image.getPixel(0, 0).hex).toBe(0xffffff);
      expect(image.getPixel(1, 0).hex).toBe(0xa3a3a3);
      expect(image.getPixel(2, 0).hex).toBe(0x656565);
      expect(image.getPixel(3, 0).hex).toBe(0x000000);

      const copy = image.duplicate();
      copy.paletteRef = symbol("systemWin");

      expect(copy.getPixel(3, 0).hex).toBe(0x000000);
      expect(image.getPixel(3, 0).hex).toBe(0x000000);
    });
  });

  it("exposes image createMask for copyPixels mask parameters", () => {
    const runtime = new Runtime();
    const image = new LingoImage(7, 5, 8);

    const mask = runtime.callMethod(image, "createMask", []);

    expect(mask).toBeInstanceOf(LingoImage);
    expect((mask as LingoImage).width).toBe(7);
    expect((mask as LingoImage).height).toBe(5);
  });

  it("exposes global createMask for copyPixels mask parameters", () => {
    withPixelCanvas(() => {
      const runtime = new Runtime();
      const dest = new LingoImage(3, 1, 32);
      const source = new LingoImage(3, 1, 32);
      const maskSource = new LingoImage(3, 1, 32);

      dest.fill(dest.getRect(), new LingoColor(0x10, 0x20, 0x30));
      source.fill(source.getRect(), new LingoColor(0xaa, 0xbb, 0xcc));
      maskSource.fill(maskSource.getRect(), new LingoColor(0xff, 0xff, 0xff));
      maskSource.setPixel(1, 0, new LingoColor(0, 0, 0));

      const mask = runtime.call("createMask", [maskSource]);

      expect(mask).toBeInstanceOf(LingoImage);

      dest.copyPixels(
        source,
        dest.getRect(),
        source.getRect(),
        { maskImage: mask as LingoImage },
      );

      expect(dest.getPixel(0, 0).hex).toBe(0x102030);
      expect(dest.getPixel(1, 0).hex).toBe(0xaabbcc);
      expect(dest.getPixel(2, 0).hex).toBe(0x102030);
    });
  });

  it("creates Matte masks that preserve enclosed white artwork", () => {
    withPixelCanvas(() => {
      const image = new LingoImage(5, 5, 8);
      const black = new LingoColor(0, 0, 0);
      for (let x = 1; x <= 3; x += 1) {
        image.setPixel(x, 1, black);
        image.setPixel(x, 3, black);
      }
      image.setPixel(1, 2, black);
      image.setPixel(3, 2, black);

      const matte = image.createMatte();

      expect(matte.getPixelAlpha(0, 0)).toBe(0);
      expect(matte.getPixel(2, 2).hex).toBe(0x000000);
      expect(matte.getPixelAlpha(2, 2)).toBe(255);
    });
  });

  it("keeps distinct white palette indices opaque in indexed createMatte masks", () => {
    withPixelCanvas(() => {
      const source = LingoImage.fromPaletteIndices(
        5,
        5,
        new Uint8Array([
          0, 0, 0, 0, 0,
          0, 2, 2, 2, 0,
          0, 2, 1, 2, 0,
          0, 2, 2, 2, 0,
          0, 0, 0, 0, 0,
        ]),
        [0xffffff, 0x000000, 0xffffff],
      );

      const matte = source.createMatte();

      expect(matte.getPixelAlpha(0, 0)).toBe(0);
      expect(matte.getPixelAlpha(1, 1)).toBe(255);
      expect(matte.getPixelAlpha(2, 2)).toBe(255);
      expect(source.getPixelAlpha(0, 0)).toBe(255);
      expect(source.getPixelAlpha(1, 1)).toBe(255);
    });
  });

  it("reuses complete createMatte masks until the source or matte changes", () => {
    withPixelCanvas(() => {
      LingoImage.resetMatteDiagnostics();
      const image = new LingoImage(3, 3, 8);
      image.setPixel(1, 1, new LingoColor(0, 0, 0));

      const first = image.createMatte();
      expect(image.createMatte()).toBe(first);

      image.setPixel(2, 2, new LingoColor(0, 0, 0));
      const afterSourceChange = image.createMatte();
      expect(afterSourceChange).not.toBe(first);
      expect(image.createMatte()).toBe(afterSourceChange);

      afterSourceChange.fill(new LingoRect(0, 0, 1, 1), new LingoColor(255, 255, 255));
      expect(image.createMatte()).not.toBe(afterSourceChange);

      expect(LingoImage.matteDiagnostics()).toMatchObject({
        hits: 2,
        misses: 3,
        sourceInvalidations: 1,
        matteMutationInvalidations: 1,
      });
    });
  });

  it("replaces and inserts around string chunks", () => {
    const runtime = new Runtime();

    expect(runtime.replaceChunk("model_1.room", "char", 7, null, "x", "into")).toBe("model_x.room");
    expect(runtime.replaceChunk("ab", "char", 2, null, "X", "before")).toBe("aXb");
    expect(runtime.replaceChunk("ab", "char", 2, null, "X", "after")).toBe("abX");
    expect(runtime.replaceChunk("one two", "word", 2, null, "three", "into")).toBe("one three");
  });

  it("treats Director word chunks as whitespace-delimited original spans", () => {
    const runtime = new Runtime();
    const quoted = '"Swap Animation Class"';

    expect(runtime.chunkCount(quoted, "word")).toBe(3);
    expect(runtime.chunk("word", 1, runtime.chunkCount(quoted, "word"), quoted)).toBe(quoted);
  });

  it("preserves quoted text field lists for source value() parsing", () => {
    const runtime = new Runtime();
    const pair = 'bulletin_months="January", "February", "March"';

    runtime.setTheProp("itemDelimiter", "=");
    const itemPart = runtime.getProp(pair, "item");
    const rawValue = runtime.getIndex(
      itemPart,
      [2],
      runtime.getProp(itemPart, "count"),
    ) as string;
    const wordPart = runtime.getProp(rawValue, "word");
    const normalized = runtime.getIndex(
      wordPart,
      [1],
      runtime.getProp(wordPart, "count"),
    ) as string;

    expect(normalized).toBe('"January", "February", "March"');
    const parsed = runtime.call("value", [`[${normalized}]`]);
    expect(parsed).toBeInstanceOf(LingoList);
    expect((parsed as LingoList).items).toEqual(["January", "February", "March"]);
  });

  it("treats CR plus packet char(2) as one line separator", () => {
    const runtime = new Runtime();
    const content = `1024173\twindow\r${String.fromCharCode(2)}184123\tposter\r${String.fromCharCode(2)}`;

    expect(runtime.chunkCount(content, "line")).toBe(3);
    expect(runtime.chunk("line", 1, null, content)).toBe("1024173\twindow");
    expect(runtime.chunk("line", 2, null, content)).toBe("184123\tposter");
    expect(runtime.chunk("line", 3, null, content)).toBe("");
  });

  it("treats bare packet char(2) as a line separator except before a tab field continuation", () => {
    const runtime = new Runtime();
    const separator = String.fromCharCode(2);

    expect(runtime.chunkCount(`first${separator}second`, "line")).toBe(2);
    expect(runtime.chunk("line", 1, null, `first${separator}second`)).toBe("first");
    expect(runtime.chunk("line", 2, null, `first${separator}second`)).toBe("second");
    expect(runtime.chunkCount(`-1${separator}\t3`, "line")).toBe(1);
  });

  it("does not split Director line chunks on bare packet char(2) inside catalogue rows", () => {
    const runtime = new Runtime();
    const separator = String.fromCharCode(2);
    const productRow = `p:Armchair\tLarge, but worth it\t-1${separator}\t3\ttrue\ts\tsofachair_silo\t0\t1,1\tA1 STS\t#ffffff,#ABD0D2\t25`;

    expect(runtime.chunkCount(productRow, "line")).toBe(1);

    runtime.setTheProp("itemDelimiter", ":");
    const lineItems = runtime.getProp(productRow, "item");
    const data = runtime.getIndex(lineItems, [2], runtime.getProp(lineItems, "count")) as string;

    runtime.setTheProp("itemDelimiter", "\t");
    const items = runtime.getProp(data, "item");
    expect(runtime.getIndex(items, [1], null)).toBe("Armchair");
    expect(runtime.call("integer", [runtime.getIndex(items, [3], null)])).toBe(-1);
    expect(runtime.getIndex(items, [4], null)).toBe("3");
    expect(runtime.getIndex(items, [7], null)).toBe("sofachair_silo");
    expect(runtime.getIndex(items, [10], null)).toBe("A1 STS");
  });

  it("returns EMPTY for descending explicit chunk ranges", () => {
    const runtime = new Runtime();
    const emptyBodyPacket = `@-${String.fromCharCode(1)}`;

    expect(runtime.chunk("char", 3, 2, emptyBodyPacket)).toBe("");
  });

  it("matches Director char chunk edge cases without materializing ranges", () => {
    const runtime = new Runtime();

    expect(runtime.chunkCount("abcd", "char")).toBe(4);
    expect(runtime.chunk("char", 2, null, "abcd")).toBe("b");
    expect(runtime.chunk("char", 2, 4, "abcd")).toBe("bcd");
    expect(runtime.chunk("char", 2, 99, "abcd")).toBe("bcd");
    expect(runtime.chunk("char", 0, null, "abcd")).toBe("");
    expect(runtime.chunk("char", 9, null, "abcd")).toBe("");
    expect(runtime.chunk("char", 3, 2, "abcd")).toBe("");
    expect(runtime.chunk("char", 9, 2, "abcd")).toBe("");
    expect(runtime.chunkCount("", "char")).toBe(0);
    expect(runtime.chunk("char", 1, null, "")).toBe("");
  });

  it("deduplicates and caps unsupported diagnostic history", () => {
    const runtime = new Runtime();

    for (let index = 0; index < 600; index += 1) {
      try {
        runtime.unsupported(`diagnostic ${index}`);
      } catch {
        // unsupported() throws by design; this test only inspects diagnostics.
      }
    }
    try {
      runtime.unsupported("diagnostic 0");
    } catch {
      // Duplicate entries should not extend the diagnostic history.
    }

    expect(runtime.unsupportedSeen).toHaveLength(512);
    expect(runtime.unsupportedSeen[0]).toBe("diagnostic 0");
    expect(runtime.unsupportedSeen.at(-1)).toBe("[unsupportedSeen truncated at 512 unique entries]");
  });

  it("exposes and clears unsupported diagnostics for live fidelity tracking", () => {
    const runtime = new Runtime();

    try {
      runtime.unsupported("manual fidelity probe");
    } catch {
      // unsupported() throws by design; the tracker reads the diagnostic surface.
    }

    const before = runtime.unsupportedDiagnostics();
    expect(before.count).toBe(1);
    expect(before.entries).toEqual(["manual fidelity probe"]);
    expect(before.truncated).toBe(false);
    expect(before.cap).toBe(512);

    runtime.clearUnsupportedDiagnostics();

    const after = runtime.unsupportedDiagnostics();
    expect(after.count).toBe(0);
    expect(after.entries).toEqual([]);
    expect(after.truncated).toBe(false);
  });

  it("preserves Thread Manager's pre-linked ancestor bridge during chain construction", () => {
    const runtime = new Runtime();
    const thread = new ScriptInstance({
      scriptName: "Thread Instance Class",
      scriptType: "parent",
      scriptProperties: ["interface", "component", "handler"],
      scriptGlobals: [],
      handlers: {
        getinterface(ctx, me, args) {
          return ctx.getInstanceProp(args[0] ?? me, "interface");
        },
      },
    });
    const iface = new ScriptInstance({
      scriptName: "Messenger Interface Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const base = new ScriptInstance({
      scriptName: "Object Base Class",
      scriptType: "parent",
      scriptProperties: ["id", "valid", "delays"],
      scriptGlobals: [],
      handlers: {},
    });
    const component = new ScriptInstance({
      scriptName: "Messenger Component Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });

    runtime.setProp(thread, "interface", iface);
    runtime.setIndex(base, [symbol("ancestor")], null, thread);
    runtime.setIndex(base, [symbol("ancestor")], null, LINGO_VOID);
    runtime.setIndex(component, [symbol("ancestor")], null, base);

    expect(runtime.callMethod(component, "getinterface", [])).toBe(iface);
  });

  it("binds unqualified handler properties to the declaring ancestor scope", () => {
    const runtime = new Runtime();
    const parent = new ScriptInstance({
      scriptName: "Active Object Class",
      scriptType: "parent",
      scriptProperties: ["pAnimFrame", "pSprList"],
      scriptGlobals: [],
      handlers: {
        construct(ctx, me, args) {
          ctx.setInstanceProp(args[0] ?? me, "pAnimFrame", 0);
          ctx.setInstanceProp(args[0] ?? me, "pSprList", new LingoList(["sprite"]));
          return 1;
        },
        readframe(ctx, me, args) {
          return ctx.getInstanceProp(args[0] ?? me, "pAnimFrame");
        },
      },
    });
    const child = new ScriptInstance({
      scriptName: "Queue Class",
      scriptType: "parent",
      scriptProperties: ["pAnimFrame"],
      scriptGlobals: [],
      handlers: {
        readchildframe(ctx, me, args) {
          return ctx.getInstanceProp(args[0] ?? me, "pAnimFrame");
        },
        readparentsprites(ctx, me, args) {
          return ctx.getProp(args[0] ?? me, "pSprList");
        },
      },
    });

    runtime.setIndex(child, [symbol("ancestor")], null, parent);
    runtime.callMethod(child, "construct", []);
    runtime.callMethod(child, "readchildframe", []);
    runtime.setProp(child, "pAnimFrame", 7);

    expect(runtime.callMethod(child, "readframe", [])).toBe(0);
    expect(runtime.callMethod(child, "readchildframe", [])).toBe(7);
    expect(runtime.callMethod(child, "readparentsprites", [])).toEqual(new LingoList(["sprite"]));
  });

  it("passes Director target-list arguments through callAncestor", () => {
    const runtime = new Runtime();
    const parent = new ScriptInstance({
      scriptName: "Item Object Class",
      scriptType: "parent",
      scriptProperties: ["pSprList"],
      scriptGlobals: [],
      handlers: {
        define(ctx, me, args) {
          ctx.setInstanceProp(me, "pSprList", new LingoList(["wall-sprite"]));
          return args[1] ?? LINGO_VOID;
        },
      },
    });
    const child = new ScriptInstance({
      scriptName: "Window Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        define(ctx, me, args) {
          const sourceMe = args[0] ?? me;
          return ctx.callLocal(me, "callancestor", [
            symbol("define"),
            new LingoList([sourceMe]),
            args[1] ?? LINGO_VOID,
          ]);
        },
      },
    });
    const payload = LingoPropList.fromPairs([[symbol("class"), "window_double_default"]]);

    runtime.setIndex(child, [symbol("ancestor")], null, parent);

    expect(runtime.callMethod(child, "define", [payload])).toBe(payload);
    expect(runtime.getProp(child, "pSprList")).toEqual(new LingoList(["wall-sprite"]));
    expect(child.props.has("psprlist")).toBe(false);
    expect(parent.props.has("psprlist")).toBe(true);
  });

  it("resolves callAncestor relative to the currently executing ancestor handler", () => {
    const runtime = new Runtime();
    const calls: string[] = [];
    const grandparent = new ScriptInstance({
      scriptName: "Item Object Class",
      scriptType: "parent",
      scriptProperties: ["pSprList"],
      scriptGlobals: [],
      handlers: {
        define(ctx, me, args) {
          calls.push("item");
          ctx.setInstanceProp(me, "pSprList", new LingoList(["base-sprite"]));
          return args[1] ?? LINGO_VOID;
        },
      },
    });
    const parent = new ScriptInstance({
      scriptName: "Item Object Extension Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        define(ctx, me, args) {
          calls.push("extension");
          return ctx.callLocal(me, "callancestor", [
            symbol("define"),
            new LingoList([args[0] ?? me]),
            args[1] ?? LINGO_VOID,
          ]);
        },
      },
    });
    const child = new ScriptInstance({
      scriptName: "Window Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        define(ctx, me, args) {
          calls.push("window");
          return ctx.callLocal(me, "callancestor", [
            symbol("define"),
            new LingoList([args[0] ?? me]),
            args[1] ?? LINGO_VOID,
          ]);
        },
      },
    });
    const payload = LingoPropList.fromPairs([[symbol("class"), "window_double_default"]]);

    runtime.setIndex(parent, [symbol("ancestor")], null, grandparent);
    runtime.setIndex(child, [symbol("ancestor")], null, parent);

    expect(runtime.callMethod(child, "define", [payload])).toBe(payload);
    expect(calls).toEqual(["window", "extension", "item"]);
    expect(runtime.getProp(child, "pSprList")).toEqual(new LingoList(["base-sprite"]));
  });
});

describe("runtime Object Manager compatibility", () => {
  it("notifies the host after Object Manager create returns an instance", () => {
    const events: unknown[][] = [];
    const runtime = new Runtime({
      objectRegistered: (id, object, classList) => events.push([id, object, classList]),
    });
    const target = new ScriptInstance({
      scriptName: "Buffer Component Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const manager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        create() {
          return target;
        },
      },
    });
    const classList = new LingoList(["Buffer Component Class"]);

    expect(runtime.callMethod(manager, "create", ["Room Asset Buffer", classList])).toBe(target);
    expect(events).toEqual([["Room Asset Buffer", target, classList]]);
  });

  it("notifies the host after Object Manager registerObject succeeds", () => {
    const events: unknown[][] = [];
    const runtime = new Runtime({
      objectRegistered: (id, object, classList) => events.push([id, object, classList]),
    });
    const target = new ScriptInstance({
      scriptName: "Buffer Component Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const manager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        registerobject() {
          return 1;
        },
      },
    });

    expect(runtime.callMethod(manager, "registerobject", [symbol("buffer_component"), target])).toBe(1);
    expect(events).toEqual([[symbol("buffer_component"), target, LINGO_VOID]]);
  });

  it("hides an object from objectExists while its deconstruct handler is active", () => {
    const runtime = new Runtime();
    const manager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: [
        "pObjectList",
        "pUpdateList",
        "pPrepareList",
        "pManagerList",
        "pInstanceList",
        "pEraseLock",
      ],
      scriptGlobals: [],
      handlers: {},
    });
    let deconstructCalls = 0;
    const target = new ScriptInstance({
      scriptName: "Blueprint Manager Class",
      scriptType: "parent",
      scriptProperties: ["valid", "delays"],
      scriptGlobals: [],
      handlers: {
        deconstruct(ctx, me, args) {
          const self = args[0] ?? me;
          deconstructCalls += 1;
          expect(ctx.callLocal(self, "objectp", [self])).toBe(0);
          expect(ctx.callMethod(manager, "remove", ["Blueprint_Manager"])).toBe(0);
          return 1;
        },
      },
    });
    const objectList = LingoPropList.fromPairs([["Blueprint_Manager", target]]);
    const updateList = new LingoList([target]);
    const prepareList = new LingoList([target]);
    const instanceList = new LingoList(["Blueprint_Manager"]);
    const managerList = new LingoList(["Blueprint_Manager"]);

    runtime.setProp(target, "valid", 1);
    runtime.setProp(target, "delays", new LingoPropList());
    runtime.setProp(manager, "pobjectlist", objectList);
    runtime.setProp(manager, "pupdatelist", updateList);
    runtime.setProp(manager, "ppreparelist", prepareList);
    runtime.setProp(manager, "pinstancelist", instanceList);
    runtime.setProp(manager, "pmanagerlist", managerList);
    runtime.setProp(manager, "peraselock", 0);

    expect(runtime.callMethod(manager, "remove", ["Blueprint_Manager"])).toBe(1);
    expect(deconstructCalls).toBe(1);
    expect(runtime.call("objectp", [target])).toBe(0);
    expect(runtime.callMethod(objectList, "getaprop", ["Blueprint_Manager"])).toBe(LINGO_VOID);
    expect(runtime.getProp(updateList, "count")).toBe(0);
    expect(runtime.getProp(prepareList, "count")).toBe(0);
    expect(runtime.getProp(instanceList, "count")).toBe(0);
    expect(runtime.getProp(managerList, "count")).toBe(0);
  });

  it("does not collapse symbol thread ids with string window ids during remove", () => {
    const runtime = new Runtime();
    const manager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: [
        "pObjectList",
        "pUpdateList",
        "pPrepareList",
        "pManagerList",
        "pInstanceList",
        "pEraseLock",
      ],
      scriptGlobals: [],
      handlers: {},
    });
    let roomDeconstructs = 0;
    let windowDeconstructs = 0;
    const roomInterface = new ScriptInstance({
      scriptName: "Room Interface Class",
      scriptType: "parent",
      scriptProperties: ["valid", "delays"],
      scriptGlobals: [],
      handlers: {
        deconstruct() {
          roomDeconstructs += 1;
          return 1;
        },
      },
    });
    const roomWindow = new ScriptInstance({
      scriptName: "Window Instance Class",
      scriptType: "parent",
      scriptProperties: ["valid", "delays"],
      scriptGlobals: [],
      handlers: {
        deconstruct() {
          windowDeconstructs += 1;
          return 1;
        },
      },
    });
    const objectList = LingoPropList.fromPairs([
      [symbol("room_interface"), roomInterface],
      ["Room_interface", roomWindow],
    ]);
    const instanceList = new LingoList([symbol("room_interface"), "Room_interface"]);

    for (const object of [roomInterface, roomWindow]) {
      runtime.setProp(object, "valid", 1);
      runtime.setProp(object, "delays", new LingoPropList());
    }
    runtime.setProp(manager, "pobjectlist", objectList);
    runtime.setProp(manager, "pupdatelist", new LingoList());
    runtime.setProp(manager, "ppreparelist", new LingoList());
    runtime.setProp(manager, "pinstancelist", instanceList);
    runtime.setProp(manager, "pmanagerlist", new LingoList());
    runtime.setProp(manager, "peraselock", 0);

    expect(runtime.callMethod(manager, "remove", ["Room_interface"])).toBe(1);
    expect(roomDeconstructs).toBe(0);
    expect(windowDeconstructs).toBe(1);
    expect(runtime.callMethod(objectList, "getaprop", [symbol("room_interface")])).toBe(roomInterface);
    expect(objectList.keys).toEqual([symbol("room_interface")]);
    expect(objectList.values).toEqual([roomInterface]);
    expect(instanceList.items).toEqual([symbol("room_interface")]);
  });

  it("unregisters visualizer wrapper children when removing a visualizer", () => {
    const runtime = new Runtime();
    const manager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: [
        "pObjectList",
        "pUpdateList",
        "pPrepareList",
        "pManagerList",
        "pInstanceList",
        "pEraseLock",
      ],
      scriptGlobals: [],
      handlers: {},
    });
    const wrapperModule = {
      scriptName: "Visualizer Part Wrapper Class",
      scriptType: "parent" as const,
      scriptProperties: ["valid", "delays"],
      scriptGlobals: [],
      handlers: {
        deconstruct() {
          return 1;
        },
      },
    };
    let wrapperDeconstructs = 0;
    const wallWrapper = new ScriptInstance({
      ...wrapperModule,
      handlers: {
        deconstruct() {
          wrapperDeconstructs += 1;
          return 1;
        },
      },
    });
    const floorWrapper = new ScriptInstance({
      ...wrapperModule,
      handlers: {
        deconstruct() {
          wrapperDeconstructs += 1;
          return 1;
        },
      },
    });
    const unrelatedWrapper = new ScriptInstance(wrapperModule);
    const visualizer = new ScriptInstance({
      scriptName: "Visualizer Instance Class",
      scriptType: "parent",
      scriptProperties: ["valid", "delays", "pWrappedParts"],
      scriptGlobals: [],
      handlers: {
        deconstruct(ctx, me, args) {
          const self = args[0] ?? me;
          const wrappedParts = ctx.getProp(self, "pwrappedparts") as LingoPropList;
          for (const wrapper of wrappedParts.values) {
            ctx.callMethod(wrapper, "deconstruct", []);
          }
          ctx.setProp(self, "pwrappedparts", new LingoPropList());
          return 1;
        },
      },
    });
    const objectList = LingoPropList.fromPairs([
      ["Room_visualizer", visualizer],
      ["uid:wall", wallWrapper],
      ["uid:floor", floorWrapper],
      ["uid:unrelated", unrelatedWrapper],
    ]);
    const instanceList = new LingoList(["Room_visualizer", "uid:wall", "uid:floor", "uid:unrelated"]);
    const updateList = new LingoList([wallWrapper, floorWrapper, unrelatedWrapper]);
    const prepareList = new LingoList([floorWrapper, unrelatedWrapper]);

    for (const object of [visualizer, wallWrapper, floorWrapper, unrelatedWrapper]) {
      runtime.setProp(object, "valid", 1);
      runtime.setProp(object, "delays", new LingoPropList());
    }
    runtime.setProp(visualizer, "pwrappedparts", LingoPropList.fromPairs([
      ["wall01", wallWrapper],
      ["floor01", floorWrapper],
    ]));
    runtime.setProp(manager, "pobjectlist", objectList);
    runtime.setProp(manager, "pupdatelist", updateList);
    runtime.setProp(manager, "ppreparelist", prepareList);
    runtime.setProp(manager, "pinstancelist", instanceList);
    runtime.setProp(manager, "pmanagerlist", new LingoList());
    runtime.setProp(manager, "peraselock", 0);

    expect(runtime.callMethod(manager, "remove", ["Room_visualizer"])).toBe(1);

    expect(wrapperDeconstructs).toBe(2);
    expect(objectList.keys).toEqual(["uid:unrelated"]);
    expect(objectList.values).toEqual([unrelatedWrapper]);
    expect(instanceList.items).toEqual(["uid:unrelated"]);
    expect(updateList.items).toEqual([unrelatedWrapper]);
    expect(prepareList.items).toEqual([unrelatedWrapper]);
    expect(runtime.getProp(wallWrapper, "valid")).toBe(0);
    expect(runtime.getProp(floorWrapper, "valid")).toBe(0);
    expect(runtime.getProp(unrelatedWrapper, "valid")).toBe(1);
  });

  it("resolves manager item ids through pItemList when callers use string ids", () => {
    const runtime = new Runtime();
    const connection = new ScriptInstance({
      scriptName: "Connection Instance Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const objectManager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: ["pObjectList"],
      scriptGlobals: [],
      handlers: {
        get(ctx, me, args) {
          const objectList = ctx.getInstanceProp(args[0] ?? me, "pobjectlist");
          const value = ctx.getIndex(objectList, [args[1] ?? LINGO_VOID], null);
          return value === LINGO_VOID ? 0 : value;
        },
      },
    });
    const managerTemplate = new ScriptInstance({
      scriptName: "Manager Template Class",
      scriptType: "parent",
      scriptProperties: ["pItemList"],
      scriptGlobals: [],
      handlers: {
        get(ctx, _me, args) {
          return ctx.callMethod(objectManager, "get", [args[1] ?? LINGO_VOID]);
        },
      },
    });
    const connectionManager = new ScriptInstance({
      scriptName: "Connection Manager Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        create(_ctx, _me, args) {
          return args[1] ?? LINGO_VOID;
        },
        registerlistener(_ctx, _me, args) {
          return args[1] ?? LINGO_VOID;
        },
      },
    });

    runtime.setProp(objectManager, "pobjectlist", LingoPropList.fromPairs([[symbol("info"), connection]]));
    runtime.setIndex(connectionManager, [symbol("ancestor")], null, managerTemplate);
    runtime.setProp(connectionManager, "pitemlist", new LingoList([symbol("info")]));

    expect(runtime.callMethod(objectManager, "get", ["info"])).toBe(0);
    expect(runtime.callMethod(connectionManager, "get", ["info"])).toBe(connection);
    expect(runtime.callMethod(connectionManager, "create", ["info", "127.0.0.1", 12326])).toBe(symbol("info"));
    expect(runtime.callMethod(connectionManager, "registerlistener", ["info", "client", new LingoPropList()])).toBe(
      symbol("info"),
    );
  });

  it("resolves global Object API string singleton ids exact-first", () => {
    const runtime = new Runtime();
    const session = new ScriptInstance({
      scriptName: "Variable Container Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const thread = new ScriptInstance({
      scriptName: "Room Interface Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const window = new ScriptInstance({
      scriptName: "Window Instance Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const wrapper = new ScriptInstance({
      scriptName: "Multicomponent Window Wrapper Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const objectList = LingoPropList.fromPairs([
      [symbol("session"), session],
      [symbol("room_interface"), thread],
      ["Room_interface", window],
      ["ig_window_wrapper", wrapper],
    ]);
    const objectManager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: ["pObjectList"],
      scriptGlobals: [],
      handlers: {
        get(ctx, _me, args) {
          const value = ctx.getIndex(objectList, [args[1] ?? LINGO_VOID], null);
          return value === LINGO_VOID ? 0 : value;
        },
        exists(ctx, _me, args) {
          const value = ctx.getIndex(objectList, [args[1] ?? LINGO_VOID], null);
          return value instanceof ScriptInstance ? 1 : 0;
        },
      },
    });
    runtime.setProp(objectManager, "pobjectlist", objectList);
    runtime.setGlobal("gcore", objectManager);
    runtime.register(
      {
        scriptName: "Object API",
        scriptType: "movie",
        scriptProperties: [],
        scriptGlobals: ["gCore"],
        handlers: {
          getobject(ctx, me, args) {
            return ctx.callMethod(ctx.getGlobal("gcore"), "get", [args[0] ?? LINGO_VOID]);
          },
          objectexists(ctx, me, args) {
            return ctx.callMethod(ctx.getGlobal("gcore"), "exists", [args[0] ?? LINGO_VOID]);
          },
        },
      },
      "test",
    );

    expect(runtime.callMethod(objectManager, "get", ["session"])).toBe(0);
    expect(runtime.call("getObject", ["session"])).toBe(session);
    expect(runtime.call("objectExists", ["session"])).toBe(1);
    expect(runtime.call("getObject", ["Room_interface"])).toBe(window);
    expect(runtime.callMethod(objectManager, "get", ["Room_interface"])).toBe(window);
    expect(runtime.callMethod(objectManager, "get", [symbol("ig_window_wrapper")])).toBe(0);
    expect(runtime.call("getObject", [symbol("ig_window_wrapper")])).toBe(wrapper);
    expect(runtime.call("objectExists", [symbol("ig_window_wrapper")])).toBe(1);
    expect(runtime.call("getObject", ["missing"])).toBe(0);
  });

  it("keeps Object Manager string window ids distinct from symbol thread ids during creation", () => {
    const runtime = new Runtime();
    const thread = new ScriptInstance({
      scriptName: "Room Interface Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const window = new ScriptInstance({
      scriptName: "Window Instance Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    const objectList = LingoPropList.fromPairs([[symbol("room_interface"), thread]]);
    const objectManager = new ScriptInstance({
      scriptName: "Object Manager Class",
      scriptType: "parent",
      scriptProperties: ["pObjectList"],
      scriptGlobals: [],
      handlers: {
        create(ctx, me, args) {
          const id = args[1] ?? LINGO_VOID;
          const existing = ctx.getIndex(ctx.getInstanceProp(me, "pobjectlist"), [id], null);
          if (ctx.callLocal(me, "objectp", [existing])) {
            return "already-exists";
          }
          const object = args[2] ?? LINGO_VOID;
          ctx.setIndex(ctx.getInstanceProp(me, "pobjectlist"), [id], null, object);
          return object;
        },
        get(ctx, me, args) {
          const value = ctx.getIndex(ctx.getInstanceProp(me, "pobjectlist"), [args[1] ?? LINGO_VOID], null);
          return value === LINGO_VOID ? 0 : value;
        },
      },
    });
    runtime.setProp(objectManager, "pobjectlist", objectList);

    expect(runtime.callMethod(objectManager, "get", ["Room_interface"])).toBe(0);
    expect(runtime.callMethod(objectManager, "create", ["Room_interface", window])).toBe(window);
    expect(runtime.callMethod(objectManager, "get", ["Room_interface"])).toBe(window);
    expect(runtime.callMethod(objectManager, "get", [symbol("room_interface")])).toBe(thread);
    expect(objectList.keys).toEqual([symbol("room_interface"), "Room_interface"]);
  });
});
