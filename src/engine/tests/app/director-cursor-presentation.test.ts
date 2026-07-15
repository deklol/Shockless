import { describe, expect, it } from "vitest";
import { applyDirectorCursorMask } from "../../src/habbo/ui/cursor/DirectorCursorPresentation";

describe("Director cursor presentation", () => {
  it("uses the 1-bit mask as direct opacity without erasing a white cursor interior", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 12,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    const mask = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);

    applyDirectorCursorMask(source, mask);

    expect([...source]).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
      255, 255, 255, 0,
    ]);
  });

  it("keeps pixels outside a shorter mask transparent", () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);
    const mask = new Uint8ClampedArray([0, 0, 0, 255]);

    applyDirectorCursorMask(source, mask);

    expect(source[3]).toBe(255);
    expect(source[7]).toBe(0);
  });
});
