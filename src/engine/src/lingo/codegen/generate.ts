import {
  Expression,
  Handler,
  LingoScript,
  Statement,
} from "../ast";
import { walkHandler } from "../analysis/walk";

/**
 * Lingo -> TypeScript code generator.
 *
 * Every generated handler has the uniform shape
 *   (ctx: LingoContext, me: LingoValue, args: LingoValue[]) => LingoValue
 * and all Lingo semantics flow through the runtime: operators via the `L`
 * helper module (ops + values), everything else via `ctx`. Generated code
 * never uses raw JS operators on Lingo values, so integer division,
 * case-insensitive comparison, and non-short-circuit and/or stay exact.
 *
 * Name resolution per handler, in order: parameters, locals (any assigned
 * identifier or loop variable), script/instance properties, declared globals,
 * Lingo constants, otherwise a bare global handler call `ctx.call(name, [])`
 * (Lingo invokes handlers by bare name).
 */

const CONSTANTS: Record<string, string> = {
  void: "L.VOID",
  true: "1",
  false: "0",
  empty: '""',
  return: '"\\r"',
  quote: '"\\""',
  space: '" "',
  backspace: '"\\b"',
  enter: '"\\u0003"',
  tab: '"\\t"',
  pi: "L.float(Math.PI)",
};

/** Words that are JS reserved or collide with our locals. */
function safeLocal(name: string): string {
  return `v_${name.toLowerCase()}`;
}

interface HandlerScope {
  parameters: Set<string>;
  locals: Set<string>;
  properties: Set<string>;
  globals: Set<string>;
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export interface GeneratedScript {
  /** TypeScript module source. */
  code: string;
  handlerNames: string[];
}

export function generateScript(
  script: LingoScript,
  options: { scriptName: string | null; scriptType: string; runtimeImport: string; runtimeImportExtension?: string },
): GeneratedScript {
  const lines: string[] = [];
  const runtimeImportExtension = options.runtimeImportExtension ?? "";
  lines.push(`// Generated from ${script.path.replace(/\\/g, "/")}`);
  lines.push(`// Do not edit by hand; regenerate with npm run lingo:generate.`);
  lines.push(`import * as L from ${jsString(options.runtimeImport + "/lingo" + runtimeImportExtension)};`);
  lines.push(
    `import type { LingoContext, LingoValue } from ${jsString(options.runtimeImport + "/context" + runtimeImportExtension)};`,
  );
  lines.push("");
  lines.push(`export const scriptName = ${jsString(options.scriptName ?? "")};`);
  lines.push(`export const scriptType = ${jsString(options.scriptType)};`);
  lines.push(`export const scriptProperties = ${JSON.stringify(script.properties)};`);
  lines.push(`export const scriptGlobals = ${JSON.stringify(script.globals)};`);
  lines.push("");
  lines.push(
    "export const handlers: Record<string, (ctx: LingoContext, me: LingoValue, args: LingoValue[]) => LingoValue> = {",
  );

  const handlerNames: string[] = [];
  for (const handler of script.handlers) {
    handlerNames.push(handler.name);
    lines.push(generateHandler(script, handler));
  }
  lines.push("};");
  lines.push("");
  return { code: lines.join("\n"), handlerNames };
}

function collectScope(script: LingoScript, handler: Handler): HandlerScope {
  const parameters = new Set(handler.parameters.map((p) => p.toLowerCase()));
  const locals = new Set<string>();
  const globals = new Set(script.globals.map((g) => g.toLowerCase()));
  const properties = new Set(script.properties.map((p) => p.toLowerCase()));

  walkHandler(handler, {
    statement: (statement) => {
      switch (statement.kind) {
        case "global":
          for (const name of statement.names) globals.add(name.toLowerCase());
          break;
        case "property":
          for (const name of statement.names) properties.add(name.toLowerCase());
          break;
        case "assignment":
          if (statement.target.kind === "identifier") {
            locals.add(statement.target.name.toLowerCase());
          }
          break;
        case "repeatWith":
        case "repeatWithIn":
          locals.add(statement.variable.toLowerCase());
          break;
        case "put":
          // `put x into q` declares q just like an assignment.
          if (statement.target && statement.target.kind === "identifier") {
            locals.add(statement.target.name.toLowerCase());
          }
          break;
        default:
          break;
      }
    },
  });

  // A name declared global or property is not a local even if assigned.
  for (const name of globals) locals.delete(name);
  for (const name of properties) locals.delete(name);
  for (const name of parameters) locals.delete(name);
  return { parameters, locals, properties, globals };
}

function generateHandler(script: LingoScript, handler: Handler): string {
  const scope = collectScope(script, handler);
  const gen = new HandlerEmitter(scope);
  const body: string[] = [];

  // Parameters bind positionally from args - including a declared `me`
  // (Lingo treats it as an ordinary first parameter; Download Manager calls
  // `searchTask(me, ...)` bare). Method dispatch prepends the receiver to
  // args. The separate `me` function argument is the dispatch instance used
  // for property resolution.
  handler.parameters.forEach((parameter, index) => {
    body.push(`    let ${safeLocal(parameter)}: LingoValue = args[${index}] ?? L.VOID;`);
  });
  for (const local of scope.locals) {
    body.push(`    let ${safeLocal(local)}: LingoValue = L.VOID;`);
  }
  for (const statement of handler.body) {
    body.push(gen.statement(statement, "    "));
  }
  // Only add the implicit VOID return when control can fall off the end;
  // otherwise JS engines warn about unreachable code.
  if (!alwaysReturns(handler.body)) {
    body.push("    return L.VOID;");
  }

  return [
    `  ${jsString(handler.name.toLowerCase())}(ctx, me, args) {`,
    ...body,
    "  },",
  ].join("\n");
}


/** True when every control-flow path through these statements ends in a
 * return/exit, so an implicit trailing return would be unreachable. */
function alwaysReturns(statements: Statement[]): boolean {
  const last = statements[statements.length - 1];
  if (!last) return false;
  switch (last.kind) {
    case "return":
    case "exit":
      return true;
    case "if":
      return (
        last.elseBranch !== null &&
        last.elseBranch.length > 0 &&
        alwaysReturns(last.thenBranch) &&
        alwaysReturns(last.elseBranch)
      );
    case "case":
      return (
        last.otherwise !== null &&
        last.otherwise.length > 0 &&
        last.branches.every((branch) => alwaysReturns(branch.body)) &&
        alwaysReturns(last.otherwise)
      );
    default:
      return false;
  }
}

class HandlerEmitter {
  constructor(private readonly scope: HandlerScope) {}

  statement(statement: Statement, indent: string): string {
    switch (statement.kind) {
      case "assignment":
        return `${indent}${this.assign(statement.target, this.expression(statement.value))};`;
      case "call": {
        // `delete char X [to Y] of <var>` mutates the variable in place.
        const expr = statement.expression;
        if (
          expr.kind === "callExpression" &&
          expr.callee.toLowerCase() === "delete" &&
          expr.arguments.length === 1
        ) {
          const target = expr.arguments[0]!;
          // `delete char X [to Y] of s`
          if (target.kind === "chunk") {
            const source = this.expression(target.source);
            const start = `L.toInt(${this.expression(target.start)})`;
            const end = target.end ? `L.toInt(${this.expression(target.end)})` : "null";
            const deleted = `ctx.deleteChunk(L.stringOf(${source}), ${jsString(target.chunkType)}, ${start}, ${end})`;
            return `${indent}${this.assign(target.source, deleted)};`;
          }
          // `delete s.char[a..b]` (dot-chunk range form, replaceChunks)
          if (
            target.kind === "index" &&
            target.receiver.kind === "propertyAccess" &&
            ["char", "word", "item", "line"].includes(target.receiver.property.toLowerCase())
          ) {
            const source = this.expression(target.receiver.receiver);
            const chunkType = target.receiver.property.toLowerCase();
            const start = `L.toInt(${this.expression(target.indices[0]!)})`;
            const end = target.rangeEnd ? `L.toInt(${this.expression(target.rangeEnd)})` : "null";
            const deleted = `ctx.deleteChunk(L.stringOf(${source}), ${jsString(chunkType)}, ${start}, ${end})`;
            return `${indent}${this.assign(target.receiver.receiver, deleted)};`;
          }
        }
        return `${indent}${this.expression(statement.expression)};`;
      }
      case "if": {
        const parts: string[] = [];
        parts.push(`${indent}if (L.truthy(${this.expression(statement.condition)})) {`);
        for (const inner of statement.thenBranch) parts.push(this.statement(inner, indent + "  "));
        if (statement.elseBranch && statement.elseBranch.length > 0) {
          parts.push(`${indent}} else {`);
          for (const inner of statement.elseBranch) parts.push(this.statement(inner, indent + "  "));
        }
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "repeatWhile": {
        const parts: string[] = [];
        parts.push(`${indent}while (L.truthy(${this.expression(statement.condition)})) {`);
        for (const inner of statement.body) parts.push(this.statement(inner, indent + "  "));
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "repeatWith": {
        // The loop variable may resolve to a local, script property, or
        // global; Lingo drives the resolved variable itself and the body may
        // mutate it (compressString does `i = i + j - 1`). The JS for-loop
        // update clause runs on `continue` (next repeat), preserving Lingo's
        // increment-then-test order.
        const varExpr = { kind: "identifier", name: statement.variable, line: statement.line } as const;
        const readVar = `L.toInt(${this.read(statement.variable, statement.line)})`;
        const assignVar = (value: string) => this.assign(varExpr, value);
        const endVar = `__end${statement.line}`;
        const parts: string[] = [];
        parts.push(`${indent}{`);
        parts.push(`${indent}  const ${endVar} = L.toInt(${this.expression(statement.end)});`);
        const init = assignVar(`L.toInt(${this.expression(statement.start)})`);
        const condition = statement.descending ? `${readVar} >= ${endVar}` : `${readVar} <= ${endVar}`;
        const update = assignVar(`${readVar} ${statement.descending ? "-" : "+"} 1`);
        parts.push(`${indent}  for (${init}; ${condition}; ${update}) {`);
        for (const inner of statement.body) parts.push(this.statement(inner, indent + "    "));
        parts.push(`${indent}  }`);
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "repeatWithIn": {
        const varExpr = { kind: "identifier", name: statement.variable, line: statement.line } as const;
        const listVar = `__list${statement.line}`;
        const idxVar = `__i${statement.line}`;
        const parts: string[] = [];
        parts.push(`${indent}{`);
        parts.push(`${indent}  const ${listVar} = ${this.expression(statement.list)};`);
        parts.push(
          `${indent}  for (let ${idxVar} = 1; ${idxVar} <= ctx.listCount(${listVar}); ${idxVar} += 1) {`,
        );
        parts.push(`${indent}    ${this.assign(varExpr, `ctx.getIndex(${listVar}, [${idxVar}], null)`)};`);
        for (const inner of statement.body) parts.push(this.statement(inner, indent + "    "));
        parts.push(`${indent}  }`);
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "repeatForever": {
        const parts: string[] = [];
        parts.push(`${indent}for (;;) {`);
        for (const inner of statement.body) parts.push(this.statement(inner, indent + "  "));
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "case": {
        const parts: string[] = [];
        const subject = `__case${statement.line}`;
        parts.push(`${indent}{`);
        parts.push(`${indent}  const ${subject} = ${this.expression(statement.subject)};`);
        if (statement.branches.length === 0) {
          // Source contains `case x of / otherwise: ...` with no labels
          // (e.g. Resource Manager setProperty); subject still evaluates.
          parts.push(`${indent}  void ${subject};`);
          for (const inner of statement.otherwise ?? []) {
            parts.push(this.statement(inner, indent + "  "));
          }
          parts.push(`${indent}}`);
          return parts.join("\n");
        }
        statement.branches.forEach((branch, index) => {
          const condition = branch.labels
            .map((label) => `L.lingoEquals(${subject}, ${this.expression(label)})`)
            .join(" || ");
          parts.push(`${indent}  ${index === 0 ? "if" : "} else if"} (${condition}) {`);
          for (const inner of branch.body) parts.push(this.statement(inner, indent + "    "));
        });
        if (statement.otherwise) {
          parts.push(`${indent}  } else {`);
          for (const inner of statement.otherwise) parts.push(this.statement(inner, indent + "    "));
        }
        parts.push(`${indent}  }`);
        parts.push(`${indent}}`);
        return parts.join("\n");
      }
      case "put": {
        if (statement.mode === null) {
          const values = statement.values.map((value) => this.expression(value)).join(", ");
          return `${indent}ctx.put([${values}]);`;
        }
        const value = this.expression(statement.values[0]!);
        return `${indent}${this.putInto(statement.mode, value, statement.target!)};`;
      }
      case "return": {
        const parts: string[] = [];
        // Rare `return a, b` form: evaluate extras for side effects first.
        for (const extra of statement.extra) {
          parts.push(`${indent}${this.expression(extra)};`);
        }
        parts.push(
          statement.value
            ? `${indent}return ${this.expression(statement.value)};`
            : `${indent}return L.VOID;`,
        );
        return parts.join("\n");
      }
      case "exit":
        return `${indent}return L.VOID;`;
      case "exitRepeat":
        return `${indent}break;`;
      case "nextRepeat":
        return `${indent}continue;`;
      case "global":
      case "property":
        return `${indent}// ${statement.kind} ${statement.names.join(", ")}`;
    }
  }

  private putInto(mode: "into" | "after" | "before", value: string, target: Expression): string {
    // Local/global/property targets behave like assignment (with concat for
    // after/before); everything else goes through the runtime.
    if (target.kind === "identifier" && mode === "into") {
      return this.assign(target, value);
    }
    if (target.kind === "identifier") {
      const current = this.read(target.name, target.line);
      const combined =
        mode === "after" ? `L.concat(${current}, ${value})` : `L.concat(${value}, ${current})`;
      return this.assign(target, combined);
    }
    const chunkTarget = this.chunkWriteTarget(target);
    if (chunkTarget) {
      const replaced = `ctx.replaceChunk(L.stringOf(${chunkTarget.source}), ${jsString(chunkTarget.chunkType)}, L.toInt(${chunkTarget.start}), ${chunkTarget.end}, ${value}, ${jsString(mode)})`;
      return this.assign(chunkTarget.assignTarget, replaced);
    }
    return `ctx.putInto(${jsString(mode)}, ${value}, ${this.lvalueRef(target)})`;
  }

  private chunkWriteTarget(target: Expression): {
    assignTarget: Expression;
    source: string;
    chunkType: string;
    start: string;
    end: string;
  } | null {
    if (target.kind === "chunk") {
      return {
        assignTarget: target.source,
        source: this.expression(target.source),
        chunkType: target.chunkType,
        start: this.expression(target.start),
        end: target.end ? `L.toInt(${this.expression(target.end)})` : "null",
      };
    }
    if (
      target.kind === "index" &&
      target.receiver.kind === "propertyAccess" &&
      ["char", "word", "item", "line"].includes(target.receiver.property.toLowerCase())
    ) {
      return {
        assignTarget: target.receiver.receiver,
        source: this.expression(target.receiver.receiver),
        chunkType: target.receiver.property.toLowerCase(),
        start: this.expression(target.indices[0]!),
        end: target.rangeEnd ? `L.toInt(${this.expression(target.rangeEnd)})` : "null",
      };
    }
    return null;
  }

  /** Runtime lvalue descriptor for put-into targets the generator does not
   * special-case (fields, members, chunks). */
  private lvalueRef(target: Expression): string {
    switch (target.kind) {
      case "objectRef":
        return `{ kind: "objectRef", refType: ${jsString(target.refType)}, id: ${this.expression(target.id)}, castLib: ${target.castLib ? this.expression(target.castLib) : "null"} }`;
      case "theOf":
        return `{ kind: "theOf", property: ${jsString(target.property.toLowerCase())}, object: ${this.expression(target.object)} }`;
      case "chunk":
        return `{ kind: "chunk", chunkType: ${jsString(target.chunkType)}, start: ${this.expression(target.start)}, end: ${target.end ? this.expression(target.end) : "null"}, source: ${this.expression(target.source)} }`;
      default:
        return `{ kind: "unsupported", detail: ${jsString(target.kind)} }`;
    }
  }

  private assign(target: Expression, value: string): string {
    switch (target.kind) {
      case "identifier": {
        const name = target.name.toLowerCase();
        if (this.scope.parameters.has(name) || this.scope.locals.has(name)) {
          return `${safeLocal(name)} = ${value}`;
        }
        if (this.scope.properties.has(name)) {
          return `ctx.setInstanceProp(me, ${jsString(name)}, ${value})`;
        }
        if (this.scope.globals.has(name)) {
          return `ctx.setGlobal(${jsString(name)}, ${value})`;
        }
        // Undeclared assignment target: Lingo treats it as a new local.
        return `${safeLocal(name)} = ${value}`;
      }
      case "propertyAccess":
        return `ctx.setProp(${this.expression(target.receiver)}, ${jsString(target.property.toLowerCase())}, ${value})`;
      case "index": {
        const indices = target.indices.map((index) => this.expression(index)).join(", ");
        const range = target.rangeEnd ? this.expression(target.rangeEnd) : "null";
        return `ctx.setIndex(${this.expression(target.receiver)}, [${indices}], ${range}, ${value})`;
      }
      case "theOf":
        return `ctx.setTheOf(${jsString(target.property.toLowerCase())}, ${this.expression(target.object)}, ${value})`;
      case "the":
        return `ctx.setTheProp(${jsString(target.property.toLowerCase())}, ${value})`;
      case "objectRef":
        return `ctx.setProp(${this.expression(target)}, "value", ${value})`;
      default:
        return `ctx.unsupported("assignment to ${target.kind}")`;
    }
  }

  /** Reads an identifier according to scope resolution. */
  private read(name: string, line: number): string {
    const key = name.toLowerCase();
    if (this.scope.parameters.has(key) || this.scope.locals.has(key)) {
      return safeLocal(key);
    }
    if (key === "me") return "me";
    if (this.scope.properties.has(key)) {
      return `ctx.getInstanceProp(me, ${jsString(key)})`;
    }
    if (this.scope.globals.has(key)) {
      return `ctx.getGlobal(${jsString(key)})`;
    }
    const constant = CONSTANTS[key];
    if (constant) return constant;
    // Bare identifier: Lingo invokes the handler/builtin of that name.
    void line;
    return `ctx.callLocal(me, ${jsString(key)}, [])`;
  }

  expression(expression: Expression): string {
    switch (expression.kind) {
      case "integer":
        return String(expression.value);
      case "float":
        return `L.float(${expression.value})`;
      case "string":
        return jsString(expression.value);
      case "symbol":
        return `L.sym(${jsString(expression.name)})`;
      case "identifier":
        return this.read(expression.name, expression.line);
      case "list": {
        const elements = expression.elements.map((element) => this.expression(element)).join(", ");
        return `L.list(${elements})`;
      }
      case "propertyList": {
        const pairs = expression.entries
          .map((entry) => `[${this.expression(entry.key)}, ${this.expression(entry.value)}]`)
          .join(", ");
        return `L.propList(${pairs})`;
      }
      case "binary": {
        const left = this.expression(expression.left);
        const right = this.expression(expression.right);
        const fn: Record<string, string> = {
          "+": "L.add",
          "-": "L.sub",
          "*": "L.mul",
          "/": "L.div",
          mod: "L.mod",
          "&": "L.concat",
          "&&": "L.concatSpace",
          "=": "L.eq",
          "<>": "L.ne",
          "<": "L.lt",
          ">": "L.gt",
          "<=": "L.le",
          ">=": "L.ge",
          and: "L.and",
          or: "L.or",
          contains: "L.contains",
          starts: "L.startsWith",
        };
        return `${fn[expression.operator]}(${left}, ${right})`;
      }
      case "unary":
        if (expression.operator === "not") return `L.not(${this.expression(expression.operand)})`;
        if (expression.operator === "+") return this.expression(expression.operand);
        return `L.neg(${this.expression(expression.operand)})`;
      case "paren":
        return `(${this.expression(expression.expression)})`;
      case "callExpression": {
        const callee = expression.callee.toLowerCase();
        const args = expression.arguments.map((argument) => this.expression(argument)).join(", ");
        // Lingo dispatch order for bare calls: own script/ancestors first
        // (via me), then movie handlers and builtins.
        return `ctx.callLocal(me, ${jsString(callee)}, [${args}])`;
      }
      case "methodCall": {
        const args = expression.arguments.map((argument) => this.expression(argument)).join(", ");
        return `ctx.callMethod(${this.expression(expression.receiver)}, ${jsString(expression.method.toLowerCase())}, [${args}])`;
      }
      case "propertyAccess":
        return `ctx.getProp(${this.expression(expression.receiver)}, ${jsString(expression.property.toLowerCase())})`;
      case "index": {
        const indices = expression.indices.map((index) => this.expression(index)).join(", ");
        const range = expression.rangeEnd ? this.expression(expression.rangeEnd) : "null";
        return `ctx.getIndex(${this.expression(expression.receiver)}, [${indices}], ${range})`;
      }
      case "the":
        return `ctx.theProp(${jsString(expression.property.toLowerCase())})`;
      case "theOf":
        return `ctx.theOf(${jsString(expression.property.toLowerCase())}, ${this.expression(expression.object)})`;
      case "objectRef": {
        const cast = expression.castLib ? this.expression(expression.castLib) : "null";
        return `ctx.objectRef(${jsString(expression.refType)}, ${this.expression(expression.id)}, ${cast})`;
      }
      case "chunk": {
        const end = expression.end ? this.expression(expression.end) : "null";
        return `ctx.chunk(${jsString(expression.chunkType)}, ${this.expression(expression.start)}, ${end}, ${this.expression(expression.source)})`;
      }
      case "countOf":
        return `ctx.countOf(${jsString(expression.chunkType)}, ${expression.source ? this.expression(expression.source) : "null"})`;
      case "lastChunk":
        return `ctx.lastChunk(${jsString(expression.chunkType)}, ${this.expression(expression.source)})`;
    }
  }
}
