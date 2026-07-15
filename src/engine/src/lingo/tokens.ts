/**
 * Token model for the Lingo lexer.
 *
 * The dialect is the Lingo that ProjectorRays emits when decompiling the
 * Habbo Origins (release306) client. Keywords are case-insensitive; the lexer
 * stores the original text and a lowercased form for matching.
 */

export enum TokenKind {
  Identifier = "identifier",
  Integer = "integer",
  Float = "float",
  String = "string",
  Symbol = "symbol",
  Newline = "newline",
  EndOfFile = "eof",

  // Punctuation and operators
  LeftParen = "(",
  RightParen = ")",
  LeftBracket = "[",
  RightBracket = "]",
  Comma = ",",
  Dot = ".",
  DotDot = "..",
  Colon = ":",
  Ampersand = "&",
  DoubleAmpersand = "&&",
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Equals = "=",
  NotEquals = "<>",
  LessThan = "<",
  GreaterThan = ">",
  LessOrEqual = "<=",
  GreaterOrEqual = ">=",
}

export interface Token {
  kind: TokenKind;
  /** Original source text of the token. */
  text: string;
  /** Lowercased text, used for case-insensitive keyword matching. */
  lower: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character. */
  column: number;
  /** Parsed value for Integer/Float/String/Symbol tokens. */
  value?: number | string;
}

/** Word operators and statement keywords are plain identifiers in the lexer;
 * the parser decides their role from context. This set exists so the parser
 * can refuse to treat reserved statement keywords as expression identifiers
 * where that would mask a parse bug. */
export const RESERVED_STATEMENT_WORDS = new Set([
  "if",
  "then",
  "else",
  "end",
  "repeat",
  "while",
  "with",
  "case",
  "otherwise",
  "on",
  "exit",
  "next",
  "return",
  "global",
  "property",
  "put",
  "set",
]);
