import { describe, expect, it } from "vitest";
import {
  add,
  and,
  concatSpace,
  contains,
  div,
  eq,
  lingoKeyEquals,
  lingoEquals,
  lt,
  mod,
  mul,
  ne,
  neg,
  not,
  stringOf,
  sub,
} from "../../src/director/ops";
import { LingoColor, LingoPoint, LingoRect } from "../../src/director/geometry";
import {
  LINGO_VOID,
  LingoFloat,
  LingoList,
  LingoPropList,
  float,
  symbol,
} from "../../src/director/values";

describe("arithmetic", () => {
  it("keeps integer division truncated toward zero", () => {
    expect(div(5, 2)).toBe(2);
    expect(div(-5, 2)).toBe(-2);
  });

  it("promotes to float when either operand is float", () => {
    const result = div(float(5), 2) as LingoFloat;
    expect(result).toBeInstanceOf(LingoFloat);
    expect(result.value).toBe(2.5);
  });

  it("coerces numeric strings in arithmetic", () => {
    expect(add("3", 2)).toBe(5);
  });

  it("mod follows the dividend's sign", () => {
    expect(mod(-7, 3)).toBe(-1);
    expect(mod(7, 3)).toBe(1);
  });

  it("applies component-wise division and mod to Director lists", () => {
    expect(div(new LingoList([1, 2, 4]), float(2))).toEqual(
      new LingoList([float(0.5), float(1), float(2)]),
    );
    expect(mod(new LingoList([1, 2, 4]), 2)).toEqual(new LingoList([1, 0, 0]));
    expect(mod(new LingoList([10, 20, 40]), new LingoList([4, 5, 6]))).toEqual(new LingoList([2, 0, 4]));
  });

  it("keeps Habbo rotate direction math as a list after mod", () => {
    expect(mod(add(add(new LingoList([0, 0, 0]), 2), 0), 8)).toEqual(new LingoList([2, 2, 2]));
  });

  it("treats VOID as 0 in arithmetic and equality", () => {
    expect(add(LINGO_VOID, 5)).toBe(5);
    expect(eq(LINGO_VOID, 0)).toBe(1);
  });

  it("does not erase numeric text by equating it with VOID", () => {
    expect(eq("0", LINGO_VOID)).toBe(0);
    expect(eq(LINGO_VOID, "0")).toBe(0);
    expect(eq("0", 0)).toBe(1);
  });

  it("applies component-wise arithmetic to Director colors", () => {
    expect(sub(new LingoColor(119, 167, 46), new LingoColor(16, 16, 16))).toEqual(
      new LingoColor(103, 151, 30),
    );
    expect(add(new LingoColor(250, 10, 20), 10)).toEqual(new LingoColor(255, 20, 30));
  });

  it("applies unary minus to Director geometry values", () => {
    expect(neg(new LingoPoint(12, -5))).toEqual(new LingoPoint(-12, 5));
    expect(neg(new LingoRect(1, -2, 30, 40))).toEqual(new LingoRect(-1, 2, -30, -40));
    expect(neg(new LingoList([new LingoPoint(3, 4), 2]))).toEqual(new LingoList([new LingoPoint(-3, -4), -2]));
  });

  it("scales Director points and rects with numeric multiplication", () => {
    expect(mul(new LingoPoint(3, 4), 2)).toEqual(new LingoPoint(6, 8));
    expect(mul(3, new LingoPoint(3, 4))).toEqual(new LingoPoint(9, 12));
    expect(mul(new LingoRect(1, 2, 10, 20), 2)).toEqual(new LingoRect(2, 4, 20, 40));
    expect(mul(3, new LingoRect(1, 2, 10, 20))).toEqual(new LingoRect(3, 6, 30, 60));
  });
});

describe("strings and comparison", () => {
  it("compares strings case-insensitively", () => {
    expect(eq("Hello", "hello")).toBe(1);
    expect(lt("apple", "BANANA")).toBe(1);
  });

  it("contains is case-insensitive", () => {
    expect(contains("Authoring Mode", "author")).toBe(1);
  });

  it("renders floats with floatPrecision 4", () => {
    expect(stringOf(float(1.5))).toBe("1.5000");
    expect(stringOf(3)).toBe("3");
  });

  it("concatSpace inserts exactly one space", () => {
    expect(concatSpace("id:", 5)).toBe("id: 5");
  });

  it("symbols are case-insensitive and compare to strings by name", () => {
    expect(symbol("Foo")).toBe(symbol("foo"));
    expect(eq(symbol("wave"), "WAVE")).toBe(1);
    expect(eq(symbol("info"), "#info")).toBe(1);
    expect(ne(symbol("wave"), symbol("walk"))).toBe(1);
    expect(ne(symbol("info"), "#room")).toBe(1);
  });
});

describe("logic", () => {
  it("and/or/not return 1/0", () => {
    expect(and(1, 2)).toBe(1);
    expect(and(1, 0)).toBe(0);
    expect(not(0)).toBe(1);
  });

  it("treats non-empty non-numeric strings as true in conditionals", () => {
    expect(not("")).toBe(1);
    expect(not("0")).toBe(1);
    expect(not("1")).toBe(0);
    expect(not("h")).toBe(0);
    expect(and("std", 1)).toBe(1);
  });
});

describe("lists", () => {
  it("is 1-based and setAt grows with zeros", () => {
    const list = new LingoList([10, 20]);
    expect(list.getAt(1)).toBe(10);
    list.setAt(5, 99);
    expect(list.items).toEqual([10, 20, 0, 0, 99]);
  });

  it("compares by content", () => {
    expect(lingoEquals(new LingoList([1, 2]), new LingoList([1, 2]))).toBe(true);
    expect(lingoEquals(new LingoList([1, 2]), new LingoList([2, 1]))).toBe(false);
  });

  it("deleteOne removes only the first match", () => {
    const list = new LingoList([1, 2, 1]);
    list.deleteOne(1, lingoEquals);
    expect(list.items).toEqual([2, 1]);
  });

  it("returns VOID for getLast on an empty list", () => {
    expect(new LingoList().getLast()).toBe(LINGO_VOID);
  });
});

describe("property lists", () => {
  it("getaProp returns VOID for missing keys, getProp throws", () => {
    const props = LingoPropList.fromPairs([[symbol("a"), 1]]);
    expect(props.getaProp(symbol("missing"), lingoEquals)).toBe(LINGO_VOID);
    expect(() => props.getProp(symbol("missing"), lingoEquals)).toThrow();
  });

  it("setaProp replaces, addProp appends duplicates", () => {
    const props = LingoPropList.fromPairs([[symbol("a"), 1]]);
    props.setaProp(symbol("A"), 2, lingoKeyEquals);
    expect(props.count()).toBe(1);
    expect(props.getaProp(symbol("a"), lingoKeyEquals)).toBe(2);
    props.addProp(symbol("a"), 3);
    expect(props.count()).toBe(2);
  });

  it("keeps string and symbol property keys distinct", () => {
    const props = LingoPropList.fromPairs([[symbol("room_interface"), "thread"]]);
    props.setaProp("Room_interface", "window", lingoKeyEquals);

    expect(props.count()).toBe(2);
    expect(props.getaProp(symbol("room_interface"), lingoKeyEquals)).toBe("thread");
    expect(props.getaProp("room_interface", lingoKeyEquals)).toBe("window");
    expect(props.deleteProp("Room_interface", lingoKeyEquals)).toBe(1);
    expect(props.getaProp(symbol("room_interface"), lingoKeyEquals)).toBe("thread");
  });

  it("keeps first-key lookup semantics after duplicate keys mutate", () => {
    const props = LingoPropList.fromPairs([
      ["name", 1],
      ["NAME", 2],
    ]);
    expect(props.getaProp("name", lingoKeyEquals)).toBe(1);
    expect(props.deleteProp("name", lingoKeyEquals)).toBe(1);
    expect(props.getaProp("name", lingoKeyEquals)).toBe(2);
  });

  it("keeps indexed lookup semantics across repeated property deletes", () => {
    const props = new LingoPropList();
    for (let index = 0; index < 1000; index += 1) {
      props.addProp(`member_${index}`, index);
    }

    expect(props.getaProp("member_999", lingoKeyEquals)).toBe(999);
    for (let index = 0; index < 900; index += 3) {
      expect(props.deleteProp(`member_${index}`, lingoKeyEquals)).toBe(1);
    }

    expect(props.getaProp("member_0", lingoKeyEquals)).toBe(LINGO_VOID);
    expect(props.getaProp("member_3", lingoKeyEquals)).toBe(LINGO_VOID);
    expect(props.getaProp("member_4", lingoKeyEquals)).toBe(4);
    expect(props.getaProp("member_999", lingoKeyEquals)).toBe(999);
  });

  it("appends indexed string-key misses without losing lookup semantics", () => {
    const props = new LingoPropList();
    props.sort((a, b) => (lingoEquals(a, b) ? 0 : lt(a as never, b as never) ? -1 : 1));

    for (let index = 0; index < 500; index += 1) {
      props.setaProp(`member_${index}`, index, lingoKeyEquals);
    }
    props.setaProp("MEMBER_10", 1000, lingoKeyEquals);
    props.setaProp(symbol("member_10"), 2000, lingoKeyEquals);

    expect(props.count()).toBe(501);
    expect(props.getaProp("member_10", lingoKeyEquals)).toBe(1000);
    expect(props.getaProp(symbol("member_10"), lingoKeyEquals)).toBe(2000);
    expect(props.getaProp("missing_member", lingoKeyEquals)).toBe(LINGO_VOID);
  });

  it("still scans indexed misses for loose property-list equality", () => {
    const props = LingoPropList.fromPairs([[symbol("top_left"), "corner"]]);
    props.setaProp("unrelated", 1, lingoKeyEquals);

    expect(props.getaProp("top_left", lingoEquals)).toBe("corner");
    expect(props.getaProp("missing", lingoEquals)).toBe(LINGO_VOID);
  });

  it("getOne searches values and returns the key", () => {
    const props = LingoPropList.fromPairs([
      [symbol("a"), "x"],
      [symbol("b"), "y"],
    ]);
    expect(props.getOne("y", lingoEquals)).toBe(symbol("b"));
    expect(props.getOne("z", lingoEquals)).toBe(0);
  });

  it("findPos returns VOID for missing property keys", () => {
    const props = LingoPropList.fromPairs([[symbol("a"), "x"]]);
    expect(props.findPos(symbol("a"), lingoEquals)).toBe(1);
    expect(props.findPos(symbol("missing"), lingoEquals)).toBe(LINGO_VOID);
    expect(props.getPos("missing", lingoEquals)).toBe(0);
  });

  it("returns VOID for getLast on an empty property list", () => {
    expect(new LingoPropList().getLast()).toBe(LINGO_VOID);
  });

  it("sort orders by key", () => {
    const props = LingoPropList.fromPairs([
      [symbol("b"), 2],
      [symbol("a"), 1],
    ]);
    props.sort((a, b) => (lingoEquals(a, b) ? 0 : lt(a as never, b as never) ? -1 : 1));
    expect(props.getPropAt(1)).toBe(symbol("a"));
  });

  it("duplicate deep-copies nested lists", () => {
    const inner = new LingoList([1]);
    const props = LingoPropList.fromPairs([[symbol("k"), inner]]);
    const copy = props.duplicate();
    (copy.getaProp(symbol("k"), lingoEquals) as LingoList).add(2);
    expect(inner.items).toEqual([1]);
  });
});
