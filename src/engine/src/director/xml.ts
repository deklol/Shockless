import { LINGO_VOID, LingoList, LingoObjectLike, LingoValue } from "./values";

/**
 * Director XML Parser Xtra. The figure system parses partsets/draworder/
 * animation/figuredata XML with: new(xtra "xmlparser"), parseString(text),
 * getError() (VOID when ok), then walks node.child[i] (a list of element
 * nodes), node.name, node.attributeName[i] / node.attributeValue[i].
 * Backed by DOMParser in the browser, with a small XML fallback for the
 * Node boot simulator so headless verification exercises the same source
 * parser paths. Director's XML Xtra exposes non-whitespace leaf text as a
 * child node with `.text`; the figure parser reads color values that way.
 */

export class XmlNode implements LingoObjectLike {
  readonly lingoType = "xmlnode";
  readonly child = new LingoList();
  readonly attributeName = new LingoList();
  readonly attributeValue = new LingoList();

  constructor(
    public readonly name: string,
    public text: string,
  ) {}
}

export class XmlParserXtraRef implements LingoObjectLike {
  readonly lingoType = "xtra";
}

export class XmlParserInstance implements LingoObjectLike {
  readonly lingoType = "xmlparser";
  root: XmlNode | null = null;
  error: string | null = null;

  parseString(text: string): number {
    try {
      this.root = typeof DOMParser === "undefined" ? parseXmlFallback(text) : parseWithDomParser(text);
      this.error = null;
      return 0;
    } catch (error) {
      this.root = null;
      this.error = error instanceof Error ? error.message : "XML parse error";
      return 1;
    }
  }

  getError(): LingoValue {
    return this.error === null ? LINGO_VOID : this.error;
  }
}

function parseWithDomParser(text: string): XmlNode {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("XML parse error");
  }
  const root = new XmlNode("", "");
  if (doc.documentElement) {
    root.child.add(convert(doc.documentElement));
  }
  return root;
}

function convert(element: Element): XmlNode {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? "";
  }
  const result = new XmlNode(element.tagName, text);
  for (const attribute of element.attributes) {
    result.attributeName.add(attribute.name);
    result.attributeValue.add(attribute.value);
  }
  for (const child of element.childNodes) {
    if (child.nodeType === 1) {
      result.child.add(convert(child as Element));
    } else if (child.nodeType === 3) {
      const value = child.nodeValue ?? "";
      if (value.trim() !== "") {
        result.child.add(new XmlNode("#text", value));
      }
    }
  }
  return result;
}

export function parseXmlFallback(text: string): XmlNode {
  const root = new XmlNode("", "");
  const stack: XmlNode[] = [root];
  let offset = 0;

  while (offset < text.length) {
    if (text.startsWith("<!--", offset)) {
      const end = text.indexOf("-->", offset + 4);
      if (end < 0) throw new Error("XML parse error: unterminated comment");
      offset = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", offset)) {
      const end = text.indexOf("]]>", offset + 9);
      if (end < 0) throw new Error("XML parse error: unterminated CDATA");
      stack[stack.length - 1]!.text += text.slice(offset + 9, end);
      offset = end + 3;
      continue;
    }
    if (text.startsWith("<?", offset)) {
      const end = text.indexOf("?>", offset + 2);
      if (end < 0) throw new Error("XML parse error: unterminated processing instruction");
      offset = end + 2;
      continue;
    }
    if (text.startsWith("<!", offset)) {
      const end = text.indexOf(">", offset + 2);
      if (end < 0) throw new Error("XML parse error: unterminated declaration");
      offset = end + 1;
      continue;
    }
    if (text[offset] === "<") {
      if (text[offset + 1] === "/") {
        const end = text.indexOf(">", offset + 2);
        if (end < 0) throw new Error("XML parse error: unterminated closing tag");
        const name = text.slice(offset + 2, end).trim();
        const node = stack.pop();
        if (!node || node === root || node.name !== name) {
          throw new Error(`XML parse error: mismatched closing tag ${name}`);
        }
        offset = end + 1;
        continue;
      }

      const end = findTagEnd(text, offset + 1);
      if (end < 0) throw new Error("XML parse error: unterminated opening tag");
      const { node, selfClosing } = parseOpenTag(text.slice(offset + 1, end));
      stack[stack.length - 1]!.child.add(node);
      if (!selfClosing) {
        stack.push(node);
      }
      offset = end + 1;
      continue;
    }

    const next = text.indexOf("<", offset);
    const end = next < 0 ? text.length : next;
    const decoded = decodeXmlEntities(text.slice(offset, end));
    stack[stack.length - 1]!.text += decoded;
    if (decoded.trim() !== "") {
      stack[stack.length - 1]!.child.add(new XmlNode("#text", decoded));
    }
    offset = end;
  }

  if (stack.length !== 1) {
    throw new Error(`XML parse error: unclosed tag ${stack[stack.length - 1]!.name}`);
  }
  return root;
}

function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function parseOpenTag(raw: string): { node: XmlNode; selfClosing: boolean } {
  let content = raw.trim();
  const selfClosing = content.endsWith("/");
  if (selfClosing) {
    content = content.slice(0, -1).trimEnd();
  }
  const nameMatch = /^([^\s/>]+)/.exec(content);
  if (!nameMatch) throw new Error("XML parse error: missing element name");
  const node = new XmlNode(nameMatch[1]!, "");
  const rest = content.slice(nameMatch[0].length);
  const attrPattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rest)) !== null) {
    node.attributeName.add(match[1]!);
    node.attributeValue.add(decodeXmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return { node, selfClosing };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_all, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (entity.startsWith("#x")) {
          return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith("#")) {
          return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return `&${entity};`;
    }
  });
}
