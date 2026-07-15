import { describe, expect, it } from "vitest";
import {
  DIRECTOR_PIXEL_RENDER_RESOLUTION,
  directorCanvasImageRendering,
  directorRenderResolution,
} from "../../src/app/directorPixelPolicy";

describe("Director pixel presentation policy", () => {
  it("keeps the Pixi backbuffer in Director pixel units", () => {
    expect(DIRECTOR_PIXEL_RENDER_RESOLUTION).toBe(1);
    expect(directorRenderResolution(1)).toBe(1);
    expect(directorRenderResolution(1.25)).toBe(1);
    expect(directorRenderResolution(1.5)).toBe(1);
    expect(directorRenderResolution(2)).toBe(1);
  });

  it("uses nearest-neighbor canvas scaling for host presentation", () => {
    expect(directorCanvasImageRendering()).toBe("pixelated");
  });
});
