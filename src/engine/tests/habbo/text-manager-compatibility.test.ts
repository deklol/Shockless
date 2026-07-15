import { describe, expect, it } from "vitest";
import { Runtime, ScriptInstance } from "../../src/director/Runtime";
import { LingoPropList } from "../../src/director/values";
import { installRelease306TextManagerCompatibility, parseRelease306TextDump } from "../../src/habbo/textManagerCompatibility";

function entriesOf(list: LingoPropList): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < list.keys.length; index += 1) {
    result[String(list.keys[index])] = String(list.values[index]);
  }
  return result;
}

describe("release306 text manager compatibility", () => {
  it("matches Text Manager dump trimming, comments, and escaped chunks", () => {
    const parsed = parseRelease306TextDump(
      [
        "# comment line",
        "  first.key  =  hello\\sworld  ",
        "line.key = one\\rtwo<BR>three",
        "tab.key = a\\tb",
        "",
      ].join("\r"),
      "\r",
      new LingoPropList(),
    );

    expect(entriesOf(parsed)).toEqual({
      "first.key": "hello world",
      "line.key": "one\rtwo\rthree",
      "tab.key": "a\tb",
    });
  });

  it("preserves values after the first equals item like Director item ranges", () => {
    const parsed = parseRelease306TextDump("key = a=b=c", "\r", new LingoPropList());

    expect(entriesOf(parsed)).toEqual({ key: "a=b=c" });
  });

  it("uses the supplied delimiter and String Services conversion table", () => {
    const convList = LingoPropList.fromPairs([["a", "x"]]);
    const parsed = parseRelease306TextDump("one=a|two=b", "|", convList);

    expect(entriesOf(parsed)).toEqual({ one: "x", two: "b" });
  });

  it("returns caller defaults for missing text without repeating source error logging", () => {
    const put: string[] = [];
    const runtime = new Runtime({ put: (text) => put.push(text) });
    installRelease306TextManagerCompatibility(runtime);
    const manager = new ScriptInstance({
      scriptName: "Text Manager Class",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {},
    });
    manager.props.set("pitemlist", LingoPropList.fromPairs([["known", "Known text"]]));

    expect(runtime.callMethod(manager, "get", ["known", "Fallback"])).toBe("Known text");
    expect(runtime.callMethod(manager, "get", ["server_clock_name", "Habbo Time:"])).toBe("Habbo Time:");
    expect(runtime.callMethod(manager, "get", ["server_clock_name", "Habbo Time:"])).toBe("Habbo Time:");
    expect(put).toEqual([]);
  });
});
