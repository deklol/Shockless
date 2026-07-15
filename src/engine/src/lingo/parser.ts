import {
  BinaryOperator,
  CaseBranch,
  ChunkExpression,
  Expression,
  Handler,
  LingoScript,
  Statement,
} from "./ast";
import { tokenizeLingo } from "./lexer";
import { Token, TokenKind } from "./tokens";

/**
 * Recursive-descent parser for ProjectorRays-decompiled Lingo (the dialect in
 * the Habbo Origins release306 source).
 *
 * Operator precedence follows Lingo exactly (Lingo in a Nutshell, table 5-2):
 *   level 4: unary minus, not
 *   level 3: * / mod
 *   level 2: + -
 *   level 1: & && = <> < > <= >= contains starts and or   (flat, left to right)
 * ProjectorRays inserts parentheses wherever the bytecode's evaluation order
 * differs, so reproducing this flat level-1 keeps the parse 1:1 with source.
 */

export class LingoParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly tokenText: string,
  ) {
    super(`line ${line}: ${message} (at ${JSON.stringify(tokenText)})`);
  }
}

const LEVEL1_WORD_OPERATORS = new Set(["and", "or", "contains", "starts"]);
const CHUNK_TYPES = new Set(["char", "word", "item", "line"]);
const OBJECT_REF_TYPES = new Set([
  "member",
  "sprite",
  "castlib",
  "script",
  "xtra",
  "field",
  "sound",
  "window",
  "menu",
]);

/** Plural chunk/object words accepted after `the number of`. */
const COUNT_TYPES: Record<string, string> = {
  chars: "char",
  words: "word",
  items: "item",
  lines: "line",
  members: "member",
  castmembers: "member",
  castlibs: "castlib",
  sprites: "sprite",
  xtras: "xtra",
};

/** Multiword `the` properties: `the long time`, `the short date`, ... */
const THE_PREFIX_WORDS = new Set(["long", "short", "abbreviated", "abbrev", "abbr"]);
const THE_SUFFIX_WORDS = new Set(["time", "date"]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  /** While > 0, `the X of ...` does not consume `of` (case-subject context,
   * where `of` terminates the subject: `case the keyCode of`). Reset inside
   * parentheses. */
  private suppressTheOf = 0;

  constructor(
    source: string,
    private readonly path: string,
  ) {
    this.tokens = tokenizeLingo(source);
  }

  // -- token helpers --------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.EndOfFile) {
      this.pos += 1;
    }
    return token;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private atWord(word: string): boolean {
    const token = this.peek();
    return token.kind === TokenKind.Identifier && token.lower === word;
  }

  private expect(kind: TokenKind, context: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw this.error(`expected ${kind} ${context}`);
    }
    return this.next();
  }

  private expectWord(word: string, context: string): Token {
    if (!this.atWord(word)) {
      throw this.error(`expected '${word}' ${context}`);
    }
    return this.next();
  }

  private error(message: string): LingoParseError {
    const token = this.peek();
    return new LingoParseError(message, token.line, token.text);
  }

  private skipNewlines(): void {
    while (this.at(TokenKind.Newline)) {
      this.next();
    }
  }

  private expectNewline(context: string): void {
    if (this.at(TokenKind.EndOfFile)) {
      return;
    }
    this.expect(TokenKind.Newline, context);
  }

  /** True if the current token can begin an expression. */
  private atExpressionStart(): boolean {
    const token = this.peek();
    switch (token.kind) {
      case TokenKind.Integer:
      case TokenKind.Float:
      case TokenKind.String:
      case TokenKind.Symbol:
      case TokenKind.Identifier:
      case TokenKind.LeftParen:
      case TokenKind.LeftBracket:
      case TokenKind.Minus:
        return true;
      default:
        return false;
    }
  }

  /** For single-expression parsing: only newlines/EOF may remain. */
  expectEndOfInput(): void {
    this.skipNewlines();
    if (!this.at(TokenKind.EndOfFile)) {
      throw this.error("unexpected input after expression");
    }
  }

  // -- script structure -----------------------------------------------------

  parseScript(): LingoScript {
    const script: LingoScript = {
      path: this.path,
      properties: [],
      globals: [],
      handlers: [],
    };
    this.skipNewlines();
    while (!this.at(TokenKind.EndOfFile)) {
      if (this.atWord("property")) {
        this.next();
        script.properties.push(...this.parseNameList("after 'property'"));
      } else if (this.atWord("global")) {
        this.next();
        script.globals.push(...this.parseNameList("after 'global'"));
      } else if (this.atWord("on")) {
        script.handlers.push(this.parseHandler());
      } else {
        throw this.error("expected 'property', 'global', or 'on' at script level");
      }
      this.skipNewlines();
    }
    return script;
  }

  private parseNameList(context: string): string[] {
    const names: string[] = [];
    names.push(this.expect(TokenKind.Identifier, context).text);
    while (this.at(TokenKind.Comma)) {
      this.next();
      names.push(this.expect(TokenKind.Identifier, context).text);
    }
    this.expectNewline(context);
    return names;
  }

  private parseHandler(): Handler {
    const onToken = this.expectWord("on", "at handler start");
    const name = this.expect(TokenKind.Identifier, "as handler name").text;
    const parameters: string[] = [];
    // Parameters may be bare (`on define me, tdata`) or parenthesized.
    const parenthesized = this.at(TokenKind.LeftParen);
    if (parenthesized) {
      this.next();
    }
    if (this.at(TokenKind.Identifier)) {
      parameters.push(this.next().text);
      while (this.at(TokenKind.Comma)) {
        this.next();
        parameters.push(this.expect(TokenKind.Identifier, "as parameter name").text);
      }
    }
    if (parenthesized) {
      this.expect(TokenKind.RightParen, "after parameter list");
    }
    this.expectNewline("after handler header");
    const body = this.parseStatementsUntil(() => this.atWord("end"));
    this.expectWord("end", "to close handler");
    // Optional `end handlerName`
    if (this.at(TokenKind.Identifier) && this.peek().lower === name.toLowerCase()) {
      this.next();
    }
    this.expectNewline("after 'end'");
    return { kind: "handler", name, parameters, body, line: onToken.line };
  }

  // -- statements -----------------------------------------------------------

  private parseStatementsUntil(stop: () => boolean): Statement[] {
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.EndOfFile) && !stop()) {
      statements.push(this.parseStatement());
      this.skipNewlines();
    }
    return statements;
  }

  private parseStatement(): Statement {
    const token = this.peek();
    if (token.kind === TokenKind.Identifier) {
      switch (token.lower) {
        case "if":
          return this.parseIf();
        case "repeat":
          return this.parseRepeat();
        case "case":
          return this.parseCase();
        case "put":
          return this.parsePut();
        case "return": {
          this.next();
          const value = this.at(TokenKind.Newline) ? null : this.parseExpression();
          const extra: Expression[] = [];
          while (this.at(TokenKind.Comma)) {
            this.next();
            extra.push(this.parseExpression());
          }
          this.expectNewline("after return value");
          return { kind: "return", value, extra, line: token.line };
        }
        case "exit": {
          this.next();
          if (this.atWord("repeat")) {
            this.next();
            this.expectNewline("after 'exit repeat'");
            return { kind: "exitRepeat", line: token.line };
          }
          this.expectNewline("after 'exit'");
          return { kind: "exit", line: token.line };
        }
        case "next": {
          this.next();
          this.expectWord("repeat", "after 'next'");
          this.expectNewline("after 'next repeat'");
          return { kind: "nextRepeat", line: token.line };
        }
        case "global": {
          this.next();
          const names = this.parseNameList("after 'global'");
          return { kind: "global", names, line: token.line };
        }
        case "property": {
          this.next();
          const names = this.parseNameList("after 'property'");
          return { kind: "property", names, line: token.line };
        }
        case "set":
          return this.parseSet();
      }
    }
    return this.parseAssignmentOrCall();
  }

  /** Inline statement variant used after `then`, `else`, and case labels.
   * Does not consume the trailing newline. */
  private parseInlineStatement(): Statement {
    // Inline positions only carry simple statements in this source; reuse the
    // main dispatcher by temporarily tolerating a missing newline.
    const statement = this.parseStatementNoNewline();
    return statement;
  }

  private parseStatementNoNewline(): Statement {
    // Parse a statement, but stop before requiring the trailing newline.
    // Implemented by parsing normally; parseStatement variants always consume
    // the newline, so for inline use we parse the small subset directly.
    const token = this.peek();
    if (token.kind === TokenKind.Identifier) {
      switch (token.lower) {
        case "return": {
          this.next();
          const value =
            this.at(TokenKind.Newline) || this.at(TokenKind.EndOfFile)
              ? null
              : this.parseExpression();
          const extra: Expression[] = [];
          while (this.at(TokenKind.Comma)) {
            this.next();
            extra.push(this.parseExpression());
          }
          return { kind: "return", value, extra, line: token.line };
        }
        case "exit": {
          this.next();
          if (this.atWord("repeat")) {
            this.next();
            return { kind: "exitRepeat", line: token.line };
          }
          return { kind: "exit", line: token.line };
        }
        case "next": {
          this.next();
          this.expectWord("repeat", "after 'next'");
          return { kind: "nextRepeat", line: token.line };
        }
        case "put":
          return this.parsePutBody();
        case "set":
          return this.parseSetBody();
      }
    }
    return this.parseAssignmentOrCallBody();
  }

  private parseIf(): Statement {
    const ifToken = this.expectWord("if", "at if statement");
    const condition = this.parseExpression();
    this.expectWord("then", "after if condition");

    if (!this.at(TokenKind.Newline)) {
      // Single-line form: `if cond then stmt [else stmt]`
      const thenBranch = [this.parseInlineStatement()];
      let elseBranch: Statement[] | null = null;
      if (this.atWord("else")) {
        this.next();
        elseBranch = [this.parseInlineStatement()];
      }
      this.expectNewline("after single-line if");
      return { kind: "if", condition, thenBranch, elseBranch, line: ifToken.line };
    }

    this.next(); // newline
    const thenBranch = this.parseStatementsUntil(() => this.atWord("else") || this.atWord("end"));
    let elseBranch: Statement[] | null = null;
    if (this.atWord("else")) {
      this.next();
      if (this.atWord("if")) {
        // `else if` chain: nested if statement consumes through its own end.
        elseBranch = [this.parseIf()];
        return { kind: "if", condition, thenBranch, elseBranch, line: ifToken.line };
      }
      if (!this.at(TokenKind.Newline)) {
        elseBranch = [this.parseInlineStatement()];
        this.expectNewline("after inline else");
      } else {
        this.next();
        elseBranch = this.parseStatementsUntil(() => this.atWord("end"));
      }
    }
    this.expectWord("end", "to close if");
    this.expectWord("if", "after 'end'");
    this.expectNewline("after 'end if'");
    return { kind: "if", condition, thenBranch, elseBranch, line: ifToken.line };
  }

  private parseRepeat(): Statement {
    const repeatToken = this.expectWord("repeat", "at repeat statement");
    if (this.atWord("while")) {
      this.next();
      const condition = this.parseExpression();
      this.expectNewline("after repeat while condition");
      const body = this.parseRepeatBody();
      return { kind: "repeatWhile", condition, body, line: repeatToken.line };
    }
    if (this.atWord("with")) {
      this.next();
      const variable = this.expect(TokenKind.Identifier, "as loop variable").text;
      if (this.atWord("in")) {
        this.next();
        const list = this.parseExpression();
        this.expectNewline("after repeat with..in list");
        const body = this.parseRepeatBody();
        return { kind: "repeatWithIn", variable, list, body, line: repeatToken.line };
      }
      this.expect(TokenKind.Equals, "after loop variable");
      const start = this.parseExpression();
      let descending = false;
      if (this.atWord("down")) {
        this.next();
        descending = true;
      }
      this.expectWord("to", "in repeat with range");
      const end = this.parseExpression();
      this.expectNewline("after repeat with range");
      const body = this.parseRepeatBody();
      return { kind: "repeatWith", variable, start, end, descending, body, line: repeatToken.line };
    }
    this.expectNewline("after bare 'repeat'");
    const body = this.parseRepeatBody();
    return { kind: "repeatForever", body, line: repeatToken.line };
  }

  private parseRepeatBody(): Statement[] {
    const body = this.parseStatementsUntil(() => this.atWord("end"));
    this.expectWord("end", "to close repeat");
    this.expectWord("repeat", "after 'end'");
    this.expectNewline("after 'end repeat'");
    return body;
  }

  private parseCase(): Statement {
    const caseToken = this.expectWord("case", "at case statement");
    this.suppressTheOf += 1;
    const subject = this.parseExpression();
    this.suppressTheOf -= 1;
    this.expectWord("of", "after case subject");
    this.expectNewline("after 'case ... of'");
    this.skipNewlines();

    const branches: CaseBranch[] = [];
    let otherwise: Statement[] | null = null;

    while (!this.atWord("end") && !this.at(TokenKind.EndOfFile)) {
      if (this.atWord("otherwise")) {
        const otherwiseToken = this.next();
        if (this.at(TokenKind.Colon)) {
          this.next();
        }
        const statements: Statement[] = [];
        if (!this.at(TokenKind.Newline)) {
          statements.push(this.parseInlineStatement());
          this.expectNewline("after inline otherwise statement");
        }
        this.skipNewlines();
        statements.push(
          ...this.parseStatementsUntil(() => this.atWord("end")),
        );
        otherwise = statements;
        void otherwiseToken;
        continue;
      }

      const labelStart = this.pos;
      const labels = this.tryParseCaseLabels();
      if (labels === null) {
        throw this.error("expected case label");
      }
      const branch: CaseBranch = { labels, body: [], line: this.tokens[labelStart]!.line };
      if (!this.at(TokenKind.Newline)) {
        branch.body.push(this.parseInlineStatement());
        this.expectNewline("after inline case branch statement");
      }
      this.skipNewlines();
      // Body statements continue until the next label, otherwise, or end.
      while (
        !this.at(TokenKind.EndOfFile) &&
        !this.atWord("end") &&
        !this.atWord("otherwise") &&
        !this.peekIsCaseLabel()
      ) {
        branch.body.push(this.parseStatement());
        this.skipNewlines();
      }
      branches.push(branch);
    }

    this.expectWord("end", "to close case");
    this.expectWord("case", "after 'end'");
    this.expectNewline("after 'end case'");
    return { kind: "case", subject, branches, otherwise, line: caseToken.line };
  }

  /** Lookahead: does the current line parse as `expr[, expr...]:`? */
  private peekIsCaseLabel(): boolean {
    const saved = this.pos;
    try {
      const labels = this.tryParseCaseLabels();
      return labels !== null;
    } finally {
      this.pos = saved;
    }
  }

  /** Parse case labels and the trailing colon; returns null (with position
   * restored) when the line is not a label. */
  private tryParseCaseLabels(): Expression[] | null {
    const saved = this.pos;
    try {
      const labels: Expression[] = [this.parseExpression()];
      while (this.at(TokenKind.Comma)) {
        this.next();
        labels.push(this.parseExpression());
      }
      if (!this.at(TokenKind.Colon)) {
        this.pos = saved;
        return null;
      }
      this.next();
      return labels;
    } catch {
      this.pos = saved;
      return null;
    }
  }

  private parsePut(): Statement {
    const statement = this.parsePutBody();
    this.expectNewline("after put statement");
    return statement;
  }

  private parsePutBody(): Statement {
    const putToken = this.expectWord("put", "at put statement");
    // Bare `put` (empty debug output) appears in Room Geometry Class.
    if (this.at(TokenKind.Newline) || this.at(TokenKind.EndOfFile)) {
      return { kind: "put", values: [], mode: null, target: null, line: putToken.line };
    }
    const values = [this.parseExpression()];
    let mode: "into" | "after" | "before" | null = null;
    let target: Expression | null = null;
    if (this.atWord("into") || this.atWord("after") || this.atWord("before")) {
      mode = this.next().lower as "into" | "after" | "before";
      target = this.parseExpression();
    } else {
      while (this.at(TokenKind.Comma)) {
        this.next();
        values.push(this.parseExpression());
      }
    }
    return { kind: "put", values, mode, target, line: putToken.line };
  }

  private parseSet(): Statement {
    const statement = this.parseSetBody();
    this.expectNewline("after set statement");
    return statement;
  }

  /** Legacy `set lvalue = expr` / `set lvalue to expr`. */
  private parseSetBody(): Statement {
    const setToken = this.expectWord("set", "at set statement");
    const target = this.parsePostfixExpression();
    if (this.at(TokenKind.Equals)) {
      this.next();
    } else {
      this.expectWord("to", "in set statement");
    }
    const value = this.parseExpression();
    return { kind: "assignment", target, value, line: setToken.line };
  }

  private parseAssignmentOrCall(): Statement {
    const statement = this.parseAssignmentOrCallBody();
    this.expectNewline("after statement");
    return statement;
  }

  private parseAssignmentOrCallBody(): Statement {
    const startToken = this.peek();
    const saved = this.pos;
    // Try the lvalue interpretation first: a postfix expression followed by
    // `=` is an assignment. Otherwise re-parse the line as one expression.
    let target: Expression | null = null;
    try {
      target = this.parsePostfixExpression();
    } catch {
      this.pos = saved;
    }
    if (target !== null && this.at(TokenKind.Equals)) {
      this.next();
      const value = this.parseExpression();
      return { kind: "assignment", target, value, line: startToken.line };
    }
    if (
      target !== null &&
      (this.at(TokenKind.Newline) || this.at(TokenKind.EndOfFile))
    ) {
      return { kind: "call", expression: target, line: startToken.line };
    }
    // Verbal command form: `cmd arg1, arg2` (no parentheses), e.g.
    // `cursor -1`, `puppetSound "click"`, `delete char 1 of s`.
    if (
      target !== null &&
      target.kind === "identifier" &&
      this.atExpressionStart()
    ) {
      const args: Expression[] = [this.parseExpression()];
      while (this.at(TokenKind.Comma)) {
        this.next();
        args.push(this.parseExpression());
      }
      return {
        kind: "call",
        expression: {
          kind: "callExpression",
          callee: target.name,
          arguments: args,
          line: startToken.line,
        },
        line: startToken.line,
      };
    }
    this.pos = saved;
    const expression = this.parseExpression();
    return { kind: "call", expression, line: startToken.line };
  }

  // -- expressions ----------------------------------------------------------

  parseExpression(): Expression {
    return this.parseLevel1();
  }

  /** Flat level 1: & && comparisons contains starts and or, left to right. */
  private parseLevel1(): Expression {
    let left = this.parseLevel2();
    for (;;) {
      const token = this.peek();
      let operator: BinaryOperator | null = null;
      switch (token.kind) {
        case TokenKind.Ampersand:
          operator = "&";
          break;
        case TokenKind.DoubleAmpersand:
          operator = "&&";
          break;
        case TokenKind.Equals:
          operator = "=";
          break;
        case TokenKind.NotEquals:
          operator = "<>";
          break;
        case TokenKind.LessThan:
          operator = "<";
          break;
        case TokenKind.GreaterThan:
          operator = ">";
          break;
        case TokenKind.LessOrEqual:
          operator = "<=";
          break;
        case TokenKind.GreaterOrEqual:
          operator = ">=";
          break;
        case TokenKind.Identifier:
          if (LEVEL1_WORD_OPERATORS.has(token.lower)) {
            operator = token.lower as BinaryOperator;
          }
          break;
        default:
          break;
      }
      if (operator === null) {
        return left;
      }
      this.next();
      const right = this.parseLevel2();
      left = { kind: "binary", operator, left, right, line: token.line };
    }
  }

  private parseLevel2(): Expression {
    let left = this.parseLevel3();
    for (;;) {
      const token = this.peek();
      if (token.kind === TokenKind.Plus || token.kind === TokenKind.Minus) {
        this.next();
        const right = this.parseLevel3();
        left = {
          kind: "binary",
          operator: token.kind === TokenKind.Plus ? "+" : "-",
          left,
          right,
          line: token.line,
        };
      } else {
        return left;
      }
    }
  }

  private parseLevel3(): Expression {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      let operator: BinaryOperator | null = null;
      if (token.kind === TokenKind.Star) operator = "*";
      else if (token.kind === TokenKind.Slash) operator = "/";
      else if (token.kind === TokenKind.Identifier && token.lower === "mod") operator = "mod";
      if (operator === null) {
        return left;
      }
      this.next();
      const right = this.parseUnary();
      left = { kind: "binary", operator, left, right, line: token.line };
    }
  }

  private parseUnary(): Expression {
    const token = this.peek();
    if (token.kind === TokenKind.Plus) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "unary", operator: "+", operand, line: token.line };
    }
    if (token.kind === TokenKind.Minus) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "unary", operator: "-", operand, line: token.line };
    }
    if (token.kind === TokenKind.Identifier && token.lower === "not") {
      this.next();
      const operand = this.parseUnary();
      return { kind: "unary", operator: "not", operand, line: token.line };
    }
    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): Expression {
    let expression = this.parsePrimary();
    for (;;) {
      if (this.at(TokenKind.Dot)) {
        this.next();
        const nameToken = this.expect(TokenKind.Identifier, "after '.'");
        if (this.at(TokenKind.LeftParen)) {
          this.next();
          const args = this.parseArguments();
          expression = {
            kind: "methodCall",
            receiver: expression,
            method: nameToken.text,
            arguments: args,
            line: nameToken.line,
          };
        } else {
          expression = {
            kind: "propertyAccess",
            receiver: expression,
            property: nameToken.text,
            line: nameToken.line,
          };
        }
        continue;
      }
      if (this.at(TokenKind.LeftBracket)) {
        const bracket = this.next();
        const indices: Expression[] = [this.parseExpression()];
        let rangeEnd: Expression | null = null;
        if (this.at(TokenKind.DotDot)) {
          this.next();
          rangeEnd = this.parseExpression();
        } else {
          while (this.at(TokenKind.Comma)) {
            this.next();
            indices.push(this.parseExpression());
          }
        }
        this.expect(TokenKind.RightBracket, "to close index");
        expression = { kind: "index", receiver: expression, indices, rangeEnd, line: bracket.line };
        continue;
      }
      return expression;
    }
  }

  private parseArguments(): Expression[] {
    const args: Expression[] = [];
    if (!this.at(TokenKind.RightParen)) {
      args.push(this.parseExpression());
      while (this.at(TokenKind.Comma)) {
        this.next();
        args.push(this.parseExpression());
      }
    }
    this.expect(TokenKind.RightParen, "to close argument list");
    return args;
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    switch (token.kind) {
      case TokenKind.Integer:
        this.next();
        return { kind: "integer", value: token.value as number, line: token.line };
      case TokenKind.Float:
        this.next();
        return { kind: "float", value: token.value as number, line: token.line };
      case TokenKind.String:
        this.next();
        return { kind: "string", value: token.value as string, line: token.line };
      case TokenKind.Symbol:
        this.next();
        return { kind: "symbol", name: token.value as string, line: token.line };
      case TokenKind.LeftParen: {
        this.next();
        const savedSuppress = this.suppressTheOf;
        this.suppressTheOf = 0;
        const inner = this.parseExpression();
        this.suppressTheOf = savedSuppress;
        this.expect(TokenKind.RightParen, "to close parenthesized expression");
        return { kind: "paren", expression: inner, line: token.line };
      }
      case TokenKind.LeftBracket:
        return this.parseListLiteral();
      case TokenKind.Identifier:
        return this.parseWordPrimary();
      default:
        throw this.error("expected an expression");
    }
  }

  private parseListLiteral(): Expression {
    const open = this.expect(TokenKind.LeftBracket, "at list literal");
    // Empty property list: [:]
    if (this.at(TokenKind.Colon)) {
      this.next();
      this.expect(TokenKind.RightBracket, "to close empty property list");
      return { kind: "propertyList", entries: [], line: open.line };
    }
    // Empty linear list: []
    if (this.at(TokenKind.RightBracket)) {
      this.next();
      return { kind: "list", elements: [], line: open.line };
    }
    const first = this.parseExpression();
    if (this.at(TokenKind.Colon)) {
      this.next();
      const entries: { key: Expression; value: Expression }[] = [
        { key: first, value: this.parseExpression() },
      ];
      while (this.at(TokenKind.Comma)) {
        this.next();
        const key = this.parseExpression();
        this.expect(TokenKind.Colon, "in property list entry");
        entries.push({ key, value: this.parseExpression() });
      }
      this.expect(TokenKind.RightBracket, "to close property list");
      return { kind: "propertyList", entries, line: open.line };
    }
    const elements = [first];
    while (this.at(TokenKind.Comma)) {
      this.next();
      elements.push(this.parseExpression());
    }
    this.expect(TokenKind.RightBracket, "to close list");
    return { kind: "list", elements, line: open.line };
  }

  private parseWordPrimary(): Expression {
    const token = this.peek();
    const word = token.lower;

    if (word === "the") {
      return this.parseTheExpression();
    }

    // Verbal `new` form: `new script("X")`, `new xtra "fileio"`. The common
    // `new(script "X", args)` form is handled by the plain call path below.
    if (word === "new" && this.peek(1).kind === TokenKind.Identifier) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "callExpression", callee: "new", arguments: [operand], line: token.line };
    }

    if (CHUNK_TYPES.has(word) && this.startsChunkExpression()) {
      return this.parseChunkExpression();
    }

    if (OBJECT_REF_TYPES.has(word)) {
      const refType = word as "member";
      const after = this.peek(1);
      // `member("x")` call form is handled below as a normal call; the
      // keyword form is `member <expr> [of castLib <expr>]`.
      if (after.kind !== TokenKind.LeftParen && this.startsObjectRefOperand(after)) {
        this.next();
        const id = this.parseUnary();
        let castLib: Expression | null = null;
        if (this.atWord("of")) {
          const saved = this.pos;
          this.next();
          if (this.atWord("castlib")) {
            this.next();
            castLib = this.parseUnary();
          } else {
            this.pos = saved;
          }
        }
        return { kind: "objectRef", refType, id, castLib, line: token.line };
      }
    }

    this.next();
    if (this.at(TokenKind.LeftParen)) {
      this.next();
      const args = this.parseArguments();
      return { kind: "callExpression", callee: token.text, arguments: args, line: token.line };
    }
    return { kind: "identifier", name: token.text, line: token.line };
  }

  /** After a chunk keyword, an expression operand must follow for it to be a
   * chunk expression rather than a plain identifier (e.g. a variable named
   * `line`). */
  private startsChunkExpression(): boolean {
    const after = this.peek(1);
    switch (after.kind) {
      case TokenKind.Integer:
      case TokenKind.Float:
      case TokenKind.String:
      case TokenKind.LeftParen:
      case TokenKind.Minus:
      case TokenKind.Identifier:
        // `line = 5` style means identifier; chunk keyword is followed by an
        // operand and then `of`/`to`. Identifier-followed-by-of is the
        // ambiguous case worth accepting (e.g. `char tIndex of tText`).
        return !(after.kind === TokenKind.Identifier && LEVEL1_WORD_OPERATORS.has(after.lower));
      default:
        return false;
    }
  }

  private startsObjectRefOperand(after: Token): boolean {
    switch (after.kind) {
      case TokenKind.Integer:
      case TokenKind.String:
      case TokenKind.Identifier:
        return !LEVEL1_WORD_OPERATORS.has(after.lower) && after.lower !== "of" && after.lower !== "mod";
      default:
        return false;
    }
  }

  private parseChunkExpression(): ChunkExpression {
    const typeToken = this.next();
    const chunkType = typeToken.lower as "char" | "word" | "item" | "line";
    const start = this.parseLevel2();
    let end: Expression | null = null;
    if (this.atWord("to")) {
      this.next();
      end = this.parseLevel2();
    }
    this.expectWord("of", "in chunk expression");
    const source = this.parseUnary();
    return { kind: "chunk", chunkType, start, end, source, line: typeToken.line };
  }

  private parseTheExpression(): Expression {
    const theToken = this.expectWord("the", "at the-expression");

    // `the last <chunk> in <expr>`
    if (this.atWord("last") && CHUNK_TYPES.has(this.peek(1).lower)) {
      this.next();
      const chunkType = this.next().lower as "char" | "word" | "item" | "line";
      this.expectWord("in", "in 'the last ... in' expression");
      const source = this.parseUnary();
      return { kind: "lastChunk", chunkType, source, line: theToken.line };
    }

    // `the number of <plural> [in/of <expr>]`
    if (this.atWord("number") && this.peek(1).lower === "of" && COUNT_TYPES[this.peek(2).lower] !== undefined) {
      this.next(); // number
      this.next(); // of
      const pluralToken = this.next();
      const chunkType = COUNT_TYPES[pluralToken.lower] as
        | "char"
        | "word"
        | "item"
        | "line"
        | "member"
        | "castlib"
        | "sprite";
      let source: Expression | null = null;
      if (this.atWord("in") || this.atWord("of")) {
        this.next();
        source = this.parseUnary();
      }
      return { kind: "countOf", chunkType, source, line: theToken.line };
    }

    // Multiword properties: `the long time`, `the short date`, ...
    if (THE_PREFIX_WORDS.has(this.peek().lower) && THE_SUFFIX_WORDS.has(this.peek(1).lower)) {
      const prefix = this.next();
      const suffix = this.next();
      return { kind: "the", property: `${prefix.text} ${suffix.text}`, line: theToken.line };
    }

    const property = this.expect(TokenKind.Identifier, "after 'the'").text;
    if (this.atWord("of") && this.suppressTheOf === 0) {
      this.next();
      const object = this.parsePostfixExpression();
      return { kind: "theOf", property, object, line: theToken.line };
    }
    return { kind: "the", property, line: theToken.line };
  }
}

export function parseLingoScript(source: string, path = "<memory>"): LingoScript {
  return new Parser(source, path).parseScript();
}

/** Parses a single complete expression (used by the runtime's value()
 * builtin, which evaluates Lingo literals like `["a","b"]` arriving as
 * field/server text). Throws if input remains after the expression. */
export function parseLingoExpression(source: string): Expression {
  const parser = new Parser(source, "<value>");
  const expression = parser.parseExpression();
  parser.expectEndOfInput();
  return expression;
}
