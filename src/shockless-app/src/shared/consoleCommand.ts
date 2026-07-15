export type ConsoleTargetKind = "selected" | "clientId" | "main" | "all" | "visible" | "headless" | "label";

export interface ConsoleCommandTarget {
  readonly kind: ConsoleTargetKind;
  readonly raw: string | null;
  readonly clientId?: number;
  readonly label?: string;
}

export interface ConsoleCommandFlag {
  readonly name: string;
  readonly value: string | true;
}

export interface ParsedConsoleCommand {
  readonly rawInput: string;
  readonly inputWithoutTarget: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly flags: readonly ConsoleCommandFlag[];
  readonly target: ConsoleCommandTarget;
}

export type ConsoleRendererAction =
  | {
      readonly kind: "enterPrivateRoom";
      readonly clientId: number;
      readonly flatId: string;
      readonly roomName?: string | null;
      readonly reason: "summon" | "manual";
    };

export interface ConsoleCommandParseSuccess {
  readonly ok: true;
  readonly command: ParsedConsoleCommand;
}

export interface ConsoleCommandParseFailure {
  readonly ok: false;
  readonly message: string;
}

export type ConsoleCommandParseResult = ConsoleCommandParseSuccess | ConsoleCommandParseFailure;

interface ConsoleTokenizeSuccess {
  readonly ok: true;
  readonly tokens: readonly string[];
}

type ConsoleTokenizeResult = ConsoleTokenizeSuccess | ConsoleCommandParseFailure;

export interface ConsoleCommandResult {
  readonly ok: boolean;
  readonly handled: boolean;
  readonly level: "success" | "warning" | "error" | "info";
  readonly lines: readonly string[];
  readonly passthroughInput?: string;
  readonly command?: ParsedConsoleCommand;
  readonly targetClientIds?: readonly number[];
  readonly rendererActions?: readonly ConsoleRendererAction[];
}

const targetAliases = new Set(["all", "main", "visible", "headless"]);
const valueFlags = new Set(["label", "source", "concurrency", "key-env", "main-name", "main-room-id", "main-room-name", "active-name"]);

export function parseConsoleCommand(input: string): ConsoleCommandParseResult {
  const rawInput = String(input ?? "");
  const trimmed = rawInput.trim();
  if (!trimmed) return { ok: false, message: "Enter a command." };
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1).trimStart() : trimmed;
  const tokenized = tokenizeConsoleInput(withoutSlash);
  if (!tokenized.ok) return tokenized;
  if (tokenized.tokens.length === 0) return { ok: false, message: "Enter a command." };

  const first = tokenized.tokens[0] ?? "";
  const target = parseTargetToken(first);
  const commandTokens = target ? tokenized.tokens.slice(1) : tokenized.tokens;
  if (commandTokens.length === 0) return { ok: false, message: "Missing command after target prefix." };

  const inputWithoutTarget = target ? withoutSlash.replace(/^\s*@\S+\s*/, "").trimStart() : withoutSlash;
  const [commandRaw = "", ...tail] = commandTokens;
  const flags: ConsoleCommandFlag[] = [];
  const args: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index] ?? "";
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const separator = body.indexOf("=");
      const name = normalizeFlagName(separator >= 0 ? body.slice(0, separator) : body);
      if (separator < 0 && valueFlags.has(name)) {
        const next = tail[index + 1] ?? "";
        if (next && !next.startsWith("--")) {
          flags.push({ name, value: next });
          index += 1;
          continue;
        }
      }
      flags.push(
        separator >= 0
          ? { name, value: body.slice(separator + 1) }
          : { name, value: true },
      );
    } else {
      args.push(token);
    }
  }

  return {
    ok: true,
    command: {
      rawInput,
      inputWithoutTarget,
      command: commandRaw.toLowerCase(),
      args,
      flags,
      target: target ?? { kind: "selected", raw: null },
    },
  };
}

export function consoleFlag(command: ParsedConsoleCommand, name: string): ConsoleCommandFlag | null {
  const normalized = normalizeFlagName(name);
  return command.flags.find((flag) => flag.name === normalized) ?? null;
}

export function consoleFlagEnabled(command: ParsedConsoleCommand, name: string): boolean {
  return Boolean(consoleFlag(command, name));
}

export function consoleArgsText(command: ParsedConsoleCommand): string {
  return command.args.join(" ");
}

export function redactConsoleCommandInput(input: string): string {
  const parsed = parseConsoleCommand(input);
  if (!parsed.ok) return input;
  const command = parsed.command;
  if (command.command !== "login") return input;
  const credential = command.args[0];
  if (!credential || !credential.includes(":")) return input;
  return input.replace(credential, "[credentials]");
}

function parseTargetToken(token: string): ConsoleCommandTarget | null {
  if (!token.startsWith("@") || token.length < 2) return null;
  const raw = token.slice(1).trim();
  const normalized = raw.toLowerCase();
  if (/^\d+$/.test(raw)) {
    const clientId = Number(raw);
    return Number.isSafeInteger(clientId) && clientId > 0 ? { kind: "clientId", raw, clientId } : null;
  }
  if (targetAliases.has(normalized)) return { kind: normalized as ConsoleTargetKind, raw };
  return { kind: "label", raw, label: raw };
}

function normalizeFlagName(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function tokenizeConsoleInput(input: string): ConsoleTokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote && char === "\\") {
      const next = input[index + 1] ?? "";
      if (next === quote || next === "\\") {
        escaping = true;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) return { ok: false, message: "Unclosed quote in command." };
  if (current) tokens.push(current);
  return { ok: true, tokens };
}
