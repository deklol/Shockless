import { describe, expect, it } from "vitest";
import { parseLingoScript } from "../../src/lingo/parser";
import {
  AssignmentStatement,
  BinaryExpression,
  CallStatement,
  CaseStatement,
  ChunkExpression,
  Handler,
  IfStatement,
  IndexExpression,
  PutStatement,
  RepeatWithStatement,
  ReturnStatement,
  TheOfExpression,
} from "../../src/lingo/ast";

function handlerOf(source: string): Handler {
  const script = parseLingoScript(source);
  expect(script.handlers).toHaveLength(1);
  return script.handlers[0]!;
}

describe("script structure", () => {
  it("parses properties, globals, and handler parameters", () => {
    const script = parseLingoScript(
      [
        "property pClass, pName",
        "global gCore",
        "",
        "on define me, tdata",
        "  pClass = tdata[#class]",
        "end",
        "",
      ].join("\n"),
    );
    expect(script.properties).toEqual(["pClass", "pName"]);
    expect(script.globals).toEqual(["gCore"]);
    expect(script.handlers[0]!.name).toBe("define");
    expect(script.handlers[0]!.parameters).toEqual(["me", "tdata"]);
  });
});

describe("expressions", () => {
  it("keeps Lingo's flat level-1 precedence left to right", () => {
    // `a = 1 and b` must parse as ((a = 1) and b), not (a = (1 and b)).
    const handler = handlerOf("on t\n  x = (a = 1 and b)\nend\n");
    const assignment = handler.body[0] as AssignmentStatement;
    const paren = assignment.value as { kind: string; expression: BinaryExpression };
    expect(paren.kind).toBe("paren");
    const outer = paren.expression;
    expect(outer.operator).toBe("and");
    expect((outer.left as BinaryExpression).operator).toBe("=");
  });

  it("binds arithmetic tighter than concatenation and comparison", () => {
    const handler = handlerOf('on t\n  x = "a" & 1 + 2\nend\n');
    const assignment = handler.body[0] as AssignmentStatement;
    const concat = assignment.value as BinaryExpression;
    expect(concat.operator).toBe("&");
    expect((concat.right as BinaryExpression).operator).toBe("+");
  });

  it("parses property lists, empty property lists, and lists", () => {
    const handler = handlerOf("on t\n  x = [#a: 1, #b: [:]]\n  y = [1, -2]\nend\n");
    const x = (handler.body[0] as AssignmentStatement).value;
    expect(x.kind).toBe("propertyList");
    const y = (handler.body[1] as AssignmentStatement).value;
    expect(y.kind).toBe("list");
  });

  it("parses dot chunk ranges like s.char[1..7]", () => {
    const handler = handlerOf('on t\n  if tURL.char[1..7] = "http://" then\n    return 1\n  end if\nend\n');
    const statement = handler.body[0] as IfStatement;
    const compare = statement.condition as BinaryExpression;
    const index = compare.left as IndexExpression;
    expect(index.kind).toBe("index");
    expect(index.rangeEnd).not.toBeNull();
  });

  it("parses keyword object refs with cast qualifier", () => {
    const handler = handlerOf('on t\n  x = the number of castMembers of castLib tCast\nend\n');
    const value = (handler.body[0] as AssignmentStatement).value;
    expect(value.kind).toBe("countOf");
  });

  it("parses the-of expressions and multiword the-properties", () => {
    const handler = handlerOf("on t\n  x = the locH of sprite 3\n  y = the long time\nend\n");
    const x = (handler.body[0] as AssignmentStatement).value as TheOfExpression;
    expect(x.kind).toBe("theOf");
    expect(x.property).toBe("locH");
    expect(x.object.kind).toBe("objectRef");
    const y = (handler.body[1] as AssignmentStatement).value;
    expect(y).toMatchObject({ kind: "the", property: "long time" });
  });

  it("parses chunk expressions with negative bounds in verbal delete", () => {
    const handler = handlerOf("on t\n  delete char -30000 of tHex\nend\n");
    const call = handler.body[0] as CallStatement;
    expect(call.expression.kind).toBe("callExpression");
    const chunk = (call.expression as { arguments: ChunkExpression[] }).arguments[0]!;
    expect(chunk.kind).toBe("chunk");
    expect(chunk.start.kind).toBe("unary");
  });

  it("parses unary plus in authored literal data", () => {
    const handler = handlerOf("on t\n  x = +10\nend\n");
    const value = (handler.body[0] as AssignmentStatement).value;
    expect(value).toMatchObject({ kind: "unary", operator: "+" });
  });

  it("parses `the last char in` expressions", () => {
    const handler = handlerOf('on t\n  if the last char in tName = "*" then\n    return 1\n  end if\nend\n');
    const condition = (handler.body[0] as IfStatement).condition as BinaryExpression;
    expect(condition.left.kind).toBe("lastChunk");
  });
});

describe("statements", () => {
  it("parses repeat with down to", () => {
    const handler = handlerOf("on t\n  repeat with c = the lastChannel down to 1\n    next repeat\n  end repeat\nend\n");
    const loop = handler.body[0] as RepeatWithStatement;
    expect(loop.kind).toBe("repeatWith");
    expect(loop.descending).toBe(true);
    expect(loop.body[0]!.kind).toBe("nextRepeat");
  });

  it("parses case statements with symbol labels, shared bodies, and otherwise", () => {
    const handler = handlerOf(
      [
        "on t",
        "  case ttype of",
        "    #arrow:",
        "      x = -1",
        '    "a", "b":',
        "      x = 2",
        "    otherwise:",
        "      x = 0",
        "  end case",
        "end",
        "",
      ].join("\n"),
    );
    const statement = handler.body[0] as CaseStatement;
    expect(statement.branches).toHaveLength(2);
    expect(statement.branches[1]!.labels).toHaveLength(2);
    expect(statement.otherwise).not.toBeNull();
  });

  it("parses case over `the keyCode` without eating the closing of", () => {
    const handler = handlerOf(
      ["on t", "  case the keyCode of", "    36:", "      x = 1", "  end case", "end", ""].join("\n"),
    );
    const statement = handler.body[0] as CaseStatement;
    expect(statement.subject).toMatchObject({ kind: "the", property: "keyCode" });
  });

  it("parses else-if chains", () => {
    const handler = handlerOf(
      ["on t", "  if a then", "    x = 1", "  else", "    if b then", "      x = 2", "    end if", "  end if", "end", ""].join("\n"),
    );
    const statement = handler.body[0] as IfStatement;
    expect(statement.elseBranch).toHaveLength(1);
  });

  it("parses multi-value put and bare put", () => {
    const handler = handlerOf('on t\n  put "a" & b, ", c"\n  put \nend\n');
    const first = handler.body[0] as PutStatement;
    expect(first.values).toHaveLength(2);
    const second = handler.body[1] as PutStatement;
    expect(second.values).toHaveLength(0);
  });

  it("parses put into chunk targets", () => {
    const handler = handlerOf('on t\n  put "x" into field "Status"\nend\n');
    const statement = handler.body[0] as PutStatement;
    expect(statement.mode).toBe("into");
    expect(statement.target!.kind).toBe("objectRef");
  });

  it("parses return with extra expressions", () => {
    const handler = handlerOf('on t\n  return RETURN, error(me, "x", #t, #major)\nend\n');
    const statement = handler.body[0] as ReturnStatement;
    expect(statement.value).toMatchObject({ kind: "identifier", name: "RETURN" });
    expect(statement.extra).toHaveLength(1);
  });

  it("parses verbal new and set-to", () => {
    const handler = handlerOf('on t\n  clientG = new script("HugeInt15")\n  set the text of member "m" to "hi"\nend\n');
    const assignment = handler.body[0] as AssignmentStatement;
    expect(assignment.value.kind).toBe("callExpression");
    const legacySet = handler.body[1] as AssignmentStatement;
    expect(legacySet.target.kind).toBe("theOf");
  });

  it("distinguishes assignment from method-call statements", () => {
    const handler = handlerOf("on t\n  me.pDimensions[1] = 5\n  me.updateLocation()\nend\n");
    expect(handler.body[0]!.kind).toBe("assignment");
    expect(handler.body[1]!.kind).toBe("call");
  });
});
