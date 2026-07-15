import { describe, expect, it } from "vitest";
import { LINGO_VOID, LingoPropList } from "../../src/director/values";
import { convertRelease306SpecialChars } from "../../src/habbo/stringServicesCompatibility";

describe("release306 string services compatibility", () => {
  it("keeps Unicode Director's empty conversion table as an identity transform", () => {
    expect(convertRelease306SpecialChars("hello\\rworld", LINGO_VOID, new LingoPropList())).toBe("hello\\rworld");
  });

  it("matches the source forward and reverse conversion table loops", () => {
    const convList = LingoPropList.fromPairs([
      ["a", "x"],
      ["b", "yz"],
    ]);

    expect(convertRelease306SpecialChars("abc", 0, convList)).toBe("xyzc");
    expect(convertRelease306SpecialChars("xzc", 1, convList)).toBe("azc");
  });
});
