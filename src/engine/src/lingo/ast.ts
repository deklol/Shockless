/**
 * AST for ProjectorRays-decompiled Lingo.
 *
 * Nodes carry the 1-based source line so later passes (semantic analysis,
 * code generation, diagnostics) can point back at the original file.
 */

export interface SourceSpan {
  line: number;
}

// ---------------------------------------------------------------------------
// Script structure
// ---------------------------------------------------------------------------

export interface LingoScript {
  /** Source path, as given to the parser. */
  path: string;
  /** Property declarations at script level (parent scripts, behaviors). */
  properties: string[];
  /** Global declarations at script level. */
  globals: string[];
  handlers: Handler[];
}

export interface Handler extends SourceSpan {
  kind: "handler";
  name: string;
  /** Parameter names as written; the first one is commonly `me`. */
  parameters: string[];
  body: Statement[];
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Statement =
  | AssignmentStatement
  | CallStatement
  | IfStatement
  | RepeatWhileStatement
  | RepeatWithStatement
  | RepeatWithInStatement
  | RepeatForeverStatement
  | CaseStatement
  | PutStatement
  | ReturnStatement
  | ExitStatement
  | ExitRepeatStatement
  | NextRepeatStatement
  | GlobalStatement
  | PropertyStatement;

export interface AssignmentStatement extends SourceSpan {
  kind: "assignment";
  target: Expression;
  value: Expression;
}

/** A bare expression in statement position (a command/handler call). */
export interface CallStatement extends SourceSpan {
  kind: "call";
  expression: Expression;
}

export interface IfStatement extends SourceSpan {
  kind: "if";
  condition: Expression;
  thenBranch: Statement[];
  /** else-if chains are represented as a single-element elseBranch holding
   * another IfStatement. */
  elseBranch: Statement[] | null;
}

export interface RepeatWhileStatement extends SourceSpan {
  kind: "repeatWhile";
  condition: Expression;
  body: Statement[];
}

export interface RepeatWithStatement extends SourceSpan {
  kind: "repeatWith";
  variable: string;
  start: Expression;
  end: Expression;
  /** true for `repeat with i = a down to b`. */
  descending: boolean;
  body: Statement[];
}

export interface RepeatWithInStatement extends SourceSpan {
  kind: "repeatWithIn";
  variable: string;
  list: Expression;
  body: Statement[];
}

/** `repeat` with no condition (loops until exit repeat). Rare. */
export interface RepeatForeverStatement extends SourceSpan {
  kind: "repeatForever";
  body: Statement[];
}

export interface CaseStatement extends SourceSpan {
  kind: "case";
  subject: Expression;
  branches: CaseBranch[];
  otherwise: Statement[] | null;
}

export interface CaseBranch extends SourceSpan {
  /** One or more comma-separated label expressions sharing a body. */
  labels: Expression[];
  body: Statement[];
}

export interface PutStatement extends SourceSpan {
  kind: "put";
  /** `put` accepts a comma-separated value list for message-window output. */
  values: Expression[];
  /** null means plain `put expr` (message window output). */
  mode: "into" | "after" | "before" | null;
  target: Expression | null;
}

export interface ReturnStatement extends SourceSpan {
  kind: "return";
  value: Expression | null;
  /** Source occasionally writes `return a, b`; extra expressions are kept so
   * codegen can preserve their evaluation. */
  extra: Expression[];
}

export interface ExitStatement extends SourceSpan {
  kind: "exit";
}

export interface ExitRepeatStatement extends SourceSpan {
  kind: "exitRepeat";
}

export interface NextRepeatStatement extends SourceSpan {
  kind: "nextRepeat";
}

export interface GlobalStatement extends SourceSpan {
  kind: "global";
  names: string[];
}

export interface PropertyStatement extends SourceSpan {
  kind: "property";
  names: string[];
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expression =
  | IntegerLiteral
  | FloatLiteral
  | StringLiteral
  | SymbolLiteral
  | ListLiteral
  | PropertyListLiteral
  | Identifier
  | BinaryExpression
  | UnaryExpression
  | ParenExpression
  | CallExpression
  | MethodCallExpression
  | PropertyAccessExpression
  | IndexExpression
  | TheExpression
  | TheOfExpression
  | ObjectRefExpression
  | ChunkExpression
  | CountOfExpression
  | LastChunkExpression;

export interface IntegerLiteral extends SourceSpan {
  kind: "integer";
  value: number;
}

export interface FloatLiteral extends SourceSpan {
  kind: "float";
  value: number;
}

export interface StringLiteral extends SourceSpan {
  kind: "string";
  value: string;
}

export interface SymbolLiteral extends SourceSpan {
  kind: "symbol";
  name: string;
}

export interface ListLiteral extends SourceSpan {
  kind: "list";
  elements: Expression[];
}

export interface PropertyListLiteral extends SourceSpan {
  kind: "propertyList";
  entries: { key: Expression; value: Expression }[];
}

export interface Identifier extends SourceSpan {
  kind: "identifier";
  name: string;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "mod"
  | "&"
  | "&&"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "and"
  | "or"
  | "contains"
  | "starts";

export interface BinaryExpression extends SourceSpan {
  kind: "binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends SourceSpan {
  kind: "unary";
  operator: "not" | "-" | "+";
  operand: Expression;
}

/** Parens preserved so codegen can reproduce evaluation order verbatim. */
export interface ParenExpression extends SourceSpan {
  kind: "paren";
  expression: Expression;
}

export interface CallExpression extends SourceSpan {
  kind: "callExpression";
  callee: string;
  arguments: Expression[];
}

export interface MethodCallExpression extends SourceSpan {
  kind: "methodCall";
  receiver: Expression;
  method: string;
  arguments: Expression[];
}

export interface PropertyAccessExpression extends SourceSpan {
  kind: "propertyAccess";
  receiver: Expression;
  property: string;
}

export interface IndexExpression extends SourceSpan {
  kind: "index";
  receiver: Expression;
  /** `list[a]` has one index; `list[a, b]` keeps both in order. */
  indices: Expression[];
  /** For chunk ranges like `s.char[1..7]`: indices[0] is the range start and
   * rangeEnd the inclusive end. Null for plain indexing. */
  rangeEnd: Expression | null;
}

/** `the frame`, `the milliseconds`, `the lastChannel`, ... */
export interface TheExpression extends SourceSpan {
  kind: "the";
  property: string;
}

/** `the locH of sprite 3`, `the text of member "x"`, `the name of me` ... */
export interface TheOfExpression extends SourceSpan {
  kind: "theOf";
  property: string;
  object: Expression;
}

/** Keyword object references: member/sprite/castLib/script/xtra/field/sound/
 * window <expr> [of castLib <expr>] */
export interface ObjectRefExpression extends SourceSpan {
  kind: "objectRef";
  refType: "member" | "sprite" | "castlib" | "script" | "xtra" | "field" | "sound" | "window" | "menu";
  id: Expression;
  castLib: Expression | null;
}

/** `char 2 of s`, `word 1 to 3 of s`, `item i of s`, `line 1 of s` */
export interface ChunkExpression extends SourceSpan {
  kind: "chunk";
  chunkType: "char" | "word" | "item" | "line";
  start: Expression;
  end: Expression | null;
  source: Expression;
}

/** `the number of chars in s`, `the number of items in s` */
export interface CountOfExpression extends SourceSpan {
  kind: "countOf";
  chunkType: "char" | "word" | "item" | "line" | "member" | "castlib" | "sprite";
  source: Expression | null;
}

/** `the last char in s`, `the last word in s` */
export interface LastChunkExpression extends SourceSpan {
  kind: "lastChunk";
  chunkType: "char" | "word" | "item" | "line";
  source: Expression;
}
