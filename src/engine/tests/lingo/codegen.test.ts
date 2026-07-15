import { describe, expect, it } from "vitest";
import { generateScript } from "../../src/lingo/codegen/generate";
import { parseLingoScript } from "../../src/lingo/parser";

function generate(source: string): string {
  return generateScript(parseLingoScript(source), {
    scriptName: "Codegen Test",
    scriptType: "movie",
    runtimeImport: "../../src/director",
  }).code;
}

describe("Lingo codegen", () => {
  it("lowers put-into dot chunk writes to string replacement", () => {
    const code = generate('on test tLayout\n  tLayoutName = tLayout\n  put "x" into tLayoutName.char[7]\nend\n');

    expect(code).toContain("ctx.replaceChunk");
    expect(code).toContain('v_tlayoutname = ctx.replaceChunk(L.stringOf(v_tlayoutname), "char", L.toInt(7), null, "x", "into")');
    expect(code).not.toContain('kind: "unsupported"');
  });

  it("lowers verbal chunk writes to string replacement", () => {
    const code = generate('on test tString\n  put "," into char 2 of tString\nend\n');

    expect(code).toContain('v_tstring = ctx.replaceChunk(L.stringOf(v_tstring), "char", L.toInt(2), null, ",", "into")');
  });
});
