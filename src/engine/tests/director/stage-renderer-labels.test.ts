import { describe, expect, it } from "vitest";
import { normalizedUserNameLabelColor, userNameLabelZIndex } from "../../src/render/StageRenderer";

describe("Director stage username labels", () => {
  it("keeps labels in room-world z order instead of above source UI windows", () => {
    expect(userNameLabelZIndex(42)).toBe(43);
    expect(userNameLabelZIndex(-5)).toBe(1);
    expect(userNameLabelZIndex(150.4)).toBe(151);
  });

  it("normalizes username label fill colors before applying Pixi text style", () => {
    expect(normalizedUserNameLabelColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizedUserNameLabelColor("not-a-color")).toBe("#ffffff");
  });
});
