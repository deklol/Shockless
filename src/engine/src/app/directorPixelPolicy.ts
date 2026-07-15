export const DIRECTOR_PIXEL_RENDER_RESOLUTION = 1;

/**
 * Director movies are authored in logical stage pixels. Rendering the Pixi
 * backbuffer at a fractional display scale makes one Director pixel occupy a
 * non-integer number of physical pixels on 125%/150% Windows displays, which
 * visibly warps pixel art. Keep the renderer in Director pixel units and let
 * the host canvas scale with nearest-neighbor sampling.
 */
export function directorRenderResolution(_devicePixelRatio = 1): number {
  return DIRECTOR_PIXEL_RENDER_RESOLUTION;
}

export function directorCanvasImageRendering(): "pixelated" {
  return "pixelated";
}
