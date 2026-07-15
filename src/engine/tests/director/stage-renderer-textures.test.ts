import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Container, Texture } from "pixi.js";
import {
  StageRenderer,
  TEXTURE_LOAD_RETRY_DELAY_MS,
  TEXTURE_LOAD_MAX_RETRIES,
  textureLoadRetryDelayMs,
} from "../../src/render/StageRenderer";
import { LingoImage } from "../../src/director/imaging";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Director stage texture loading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries transient texture load failures after the retry delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const load = vi.spyOn(Assets, "load").mockRejectedValueOnce(new Error("temporary miss")).mockResolvedValueOnce(Texture.EMPTY as never);
    const renderer = new StageRenderer(new Container());
    const texturedUnderlay = {
      id: "hotel-background",
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      color: 0,
      textureUrl: "/origins-data/assets/hotel-background.png",
    };

    renderer.setPresentationUnderlays([texturedUnderlay]);
    expect(load).toHaveBeenCalledTimes(1);
    await flushPromises();

    renderer.setPresentationUnderlays([texturedUnderlay]);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TEXTURE_LOAD_RETRY_DELAY_MS - 1);
    renderer.setPresentationUnderlays([texturedUnderlay]);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    renderer.setPresentationUnderlays([texturedUnderlay]);
    expect(load).toHaveBeenCalledTimes(2);
    await flushPromises();

    renderer.setPresentationUnderlays([texturedUnderlay]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses bounded linear backoff for texture retries", () => {
    expect(textureLoadRetryDelayMs(1)).toBe(TEXTURE_LOAD_RETRY_DELAY_MS);
    expect(textureLoadRetryDelayMs(2)).toBe(TEXTURE_LOAD_RETRY_DELAY_MS * 2);
    expect(textureLoadRetryDelayMs(99)).toBe(TEXTURE_LOAD_RETRY_DELAY_MS * TEXTURE_LOAD_MAX_RETRIES);
  });

  it("keeps runtime image texture cache flat when released images churn", () => {
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    const fakeTextures: Array<{ source: { scaleMode: string; update: () => void }; destroy: (destroySource?: boolean) => void }> = [];
    vi.spyOn(Texture, "from").mockImplementation(() => {
      const texture = {
        source: { scaleMode: "", update: vi.fn() },
        destroy: vi.fn(),
      };
      fakeTextures.push(texture);
      return texture as unknown as Texture;
    });
    try {
      const renderer = new StageRenderer(new Container());
      const bridge = renderer as unknown as { imageTextureFor(image: LingoImage): Texture | null };
      let previous: LingoImage | null = null;

      for (let index = 0; index < 10; index += 1) {
        if (previous) renderer.releaseImage(previous);
        const image = LingoImage.fromDrawable({ width: 1, height: 1 } as unknown as CanvasImageSource, 1, 1);
        expect(bridge.imageTextureFor(image)).not.toBeNull();
        expect(renderer.textureCacheDiagnostics().imageTextures).toBe(1);
        previous = image;
      }

      renderer.releaseImage(previous!);
      expect(renderer.textureCacheDiagnostics().imageTextures).toBe(0);
      expect(fakeTextures).toHaveLength(10);
      expect(fakeTextures.every((texture) => texture.source.scaleMode === "nearest")).toBe(true);
      expect(fakeTextures.every((texture) => vi.mocked(texture.destroy).mock.calls.length === 1)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });
});
