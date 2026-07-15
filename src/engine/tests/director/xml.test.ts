import { describe, expect, it } from "vitest";
import { LINGO_VOID } from "../../src/director/values";
import { parseXmlFallback, XmlNode, XmlParserInstance } from "../../src/director/xml";

describe("Director XML Parser Xtra", () => {
  it("parses release306-style element trees in Node", () => {
    const parser = new XmlParserInstance();
    const result = parser.parseString(`
      <figuredata>
        <!-- ignored -->
        <colors>
          <palette id="1">
            <color id="30" selectable="1">4C&amp;31</color>
            <color id="31" />
          </palette>
        </colors>
      </figuredata>
    `);

    expect(result).toBe(0);
    expect(parser.getError()).toBe(LINGO_VOID);
    const figureData = parser.root?.child.getAt(1) as XmlNode;
    const colors = figureData.child.getAt(1) as XmlNode;
    const palette = colors.child.getAt(1) as XmlNode;
    const color = palette.child.getAt(1) as XmlNode;
    const emptyColor = palette.child.getAt(2) as XmlNode;

    expect(figureData.name).toBe("figuredata");
    expect(palette.attributeName.items).toEqual(["id"]);
    expect(palette.attributeValue.items).toEqual(["1"]);
    expect(color.attributeName.items).toEqual(["id", "selectable"]);
    expect(color.attributeValue.items).toEqual(["30", "1"]);
    expect(color.text).toBe("4C&31");
    expect((color.child.getAt(1) as XmlNode).text).toBe("4C&31");
    expect(emptyColor.name).toBe("color");
    expect(emptyColor.child.count()).toBe(0);
  });

  it("reports malformed XML through the Node fallback without partial roots", () => {
    for (const source of [
      "<root>",
      "<root><a></root>",
      "<root a='unterminated>",
      "<![CDATA[oops]",
      "<!-- nope",
      "<?xml nope",
    ]) {
      expect(() => parseXmlFallback(source)).toThrow(/XML parse error/);
    }
  });

  it("fuzzes fallback XML parsing into either a root or a structured parse error", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const source = seededXml(seed);
      try {
        const parsed = parseXmlFallback(source);
        expect(parsed).toBeInstanceOf(XmlNode);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/XML parse error/);
      }
    }
  });
});

function seededXml(seed: number): string {
  let state = seed >>> 0;
  const chars: string[] = [];
  const alphabet = "<>/=!?'\" abcdef012345&;";
  for (let index = 0; index < 32; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    chars.push(alphabet[state % alphabet.length]!);
  }
  return chars.join("");
}
