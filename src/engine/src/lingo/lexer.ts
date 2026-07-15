import { Token, TokenKind } from "./tokens";

/**
 * Lexer for ProjectorRays-decompiled Lingo.
 *
 * Lingo is line-oriented: newlines terminate statements, so the lexer emits
 * Newline tokens (collapsing blank lines). Comments run from `--` to end of
 * line. The continuation character (U+00AC, shown as `¬` in Director) joins
 * the next line; ProjectorRays normally does not emit it, but it is handled
 * for safety. Lingo strings have no escape sequences; a double quote always
 * ends the string (the QUOTE constant is used for embedded quotes).
 */
export class LingoLexError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(`${line}:${column} ${message}`);
  }
}

const SINGLE_CHAR_TOKENS: Record<string, TokenKind> = {
  "(": TokenKind.LeftParen,
  ")": TokenKind.RightParen,
  "[": TokenKind.LeftBracket,
  "]": TokenKind.RightBracket,
  ",": TokenKind.Comma,
  ":": TokenKind.Colon,
  "+": TokenKind.Plus,
  "-": TokenKind.Minus,
  "*": TokenKind.Star,
  "/": TokenKind.Slash,
  "=": TokenKind.Equals,
};

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function tokenizeLingo(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  const length = source.length;

  const push = (kind: TokenKind, text: string, value?: number | string) => {
    tokens.push({ kind, text, lower: text.toLowerCase(), line, column, value });
  };

  const lastMeaningful = (): Token | undefined => {
    const token = tokens[tokens.length - 1];
    return token && token.kind !== TokenKind.Newline ? token : token;
  };

  while (pos < length) {
    const ch = source[pos]!;

    // Line endings (collapse \r\n; emit a single Newline per physical line)
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && source[pos + 1] === "\n") {
        pos += 1;
      }
      const prev = lastMeaningful();
      if (prev && prev.kind !== TokenKind.Newline) {
        push(TokenKind.Newline, "\n");
      }
      pos += 1;
      line += 1;
      column = 1;
      continue;
    }

    if (ch === " " || ch === "\t") {
      pos += 1;
      column += 1;
      continue;
    }

    // Comment to end of line
    if (ch === "-" && source[pos + 1] === "-") {
      while (pos < length && source[pos] !== "\n" && source[pos] !== "\r") {
        pos += 1;
      }
      continue;
    }

    // Line continuation: ¬ (U+00AC) joins the next physical line
    if (ch === "¬" || ch === "Â") {
      // Skip the marker and the following line ending without emitting Newline
      pos += 1;
      column += 1;
      if (source[pos] === "¬") {
        pos += 1; // UTF-8 mojibake form C2 AC read as two chars
      }
      while (pos < length && (source[pos] === " " || source[pos] === "\t")) {
        pos += 1;
      }
      if (source[pos] === "\r") pos += 1;
      if (source[pos] === "\n") pos += 1;
      line += 1;
      column = 1;
      continue;
    }

    // String literal: no escapes in Lingo
    if (ch === '"') {
      const startLine = line;
      const startColumn = column;
      let end = pos + 1;
      while (end < length && source[end] !== '"') {
        if (source[end] === "\n" || source[end] === "\r") {
          throw new LingoLexError("unterminated string literal", startLine, startColumn);
        }
        end += 1;
      }
      if (end >= length) {
        throw new LingoLexError("unterminated string literal", startLine, startColumn);
      }
      const text = source.slice(pos, end + 1);
      const value = source.slice(pos + 1, end);
      push(TokenKind.String, text, value);
      column += end + 1 - pos;
      pos = end + 1;
      continue;
    }

    // Symbol literal: #name or #"quoted name"
    if (ch === "#") {
      if (source[pos + 1] === '"') {
        let end = pos + 2;
        while (end < length && source[end] !== '"') {
          end += 1;
        }
        if (end >= length) {
          throw new LingoLexError("unterminated symbol literal", line, column);
        }
        const text = source.slice(pos, end + 1);
        push(TokenKind.Symbol, text, source.slice(pos + 2, end));
        column += end + 1 - pos;
        pos = end + 1;
        continue;
      }
      let end = pos + 1;
      while (end < length && isIdentifierPart(source[end]!)) {
        end += 1;
      }
      if (end === pos + 1) {
        throw new LingoLexError("expected symbol name after '#'", line, column);
      }
      const text = source.slice(pos, end);
      push(TokenKind.Symbol, text, source.slice(pos + 1, end));
      column += end - pos;
      pos = end;
      continue;
    }

    // Numbers: 123, 1.5, .5, 1.0e6
    if (isDigit(ch) || (ch === "." && isDigit(source[pos + 1] ?? ""))) {
      let end = pos;
      let isFloat = false;
      while (end < length && isDigit(source[end]!)) {
        end += 1;
      }
      if (source[end] === "." && isDigit(source[end + 1] ?? "")) {
        isFloat = true;
        end += 1;
        while (end < length && isDigit(source[end]!)) {
          end += 1;
        }
      } else if (
        source[end] === "." &&
        source[end + 1] !== "." && // `1..7` is a chunk range, not a float
        !isIdentifierStart(source[end + 1] ?? "")
      ) {
        // Trailing-dot float like "1." (rare but legal)
        isFloat = true;
        end += 1;
      }
      if (source[end] === "e" || source[end] === "E") {
        let expEnd = end + 1;
        if (source[expEnd] === "+" || source[expEnd] === "-") expEnd += 1;
        if (isDigit(source[expEnd] ?? "")) {
          isFloat = true;
          end = expEnd;
          while (end < length && isDigit(source[end]!)) {
            end += 1;
          }
        }
      }
      const text = source.slice(pos, end);
      push(isFloat ? TokenKind.Float : TokenKind.Integer, text, Number(text));
      column += end - pos;
      pos = end;
      continue;
    }

    // Identifiers and word keywords
    if (isIdentifierStart(ch)) {
      let end = pos + 1;
      while (end < length && isIdentifierPart(source[end]!)) {
        end += 1;
      }
      const text = source.slice(pos, end);
      push(TokenKind.Identifier, text);
      column += end - pos;
      pos = end;
      continue;
    }

    // Multi-char operators
    if (ch === "&") {
      if (source[pos + 1] === "&") {
        push(TokenKind.DoubleAmpersand, "&&");
        pos += 2;
        column += 2;
      } else {
        push(TokenKind.Ampersand, "&");
        pos += 1;
        column += 1;
      }
      continue;
    }
    if (ch === "<") {
      if (source[pos + 1] === ">") {
        push(TokenKind.NotEquals, "<>");
        pos += 2;
        column += 2;
      } else if (source[pos + 1] === "=") {
        push(TokenKind.LessOrEqual, "<=");
        pos += 2;
        column += 2;
      } else {
        push(TokenKind.LessThan, "<");
        pos += 1;
        column += 1;
      }
      continue;
    }
    if (ch === ">") {
      if (source[pos + 1] === "=") {
        push(TokenKind.GreaterOrEqual, ">=");
        pos += 2;
        column += 2;
      } else {
        push(TokenKind.GreaterThan, ">");
        pos += 1;
        column += 1;
      }
      continue;
    }
    if (ch === ".") {
      if (source[pos + 1] === ".") {
        push(TokenKind.DotDot, "..");
        pos += 2;
        column += 2;
        continue;
      }
      push(TokenKind.Dot, ".");
      pos += 1;
      column += 1;
      continue;
    }

    const single = SINGLE_CHAR_TOKENS[ch];
    if (single) {
      push(single, ch);
      pos += 1;
      column += 1;
      continue;
    }

    throw new LingoLexError(`unexpected character ${JSON.stringify(ch)}`, line, column);
  }

  if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== TokenKind.Newline) {
    push(TokenKind.Newline, "\n");
  }
  push(TokenKind.EndOfFile, "");
  return tokens;
}
