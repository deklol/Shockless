import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ConsoleCommandFlag, ParsedConsoleCommand } from "../../shared/consoleCommand.js";
import { parseConsoleCommand } from "../../shared/consoleCommand.js";
import { appDataStorePath, appDataStoreRoot, firstExistingAppDataStorePath } from "../appDataPaths.js";

const COMMAND_STATE_FILE = "console-state.json";
export const MAX_COMMAND_HISTORY = 200;

export interface ConsoleCommandState {
  readonly version: 1;
  aliases: Record<string, string>;
  bindings: Record<string, string>;
  history: string[];
}

export function readCommandState(appDataPath: string, reservedCommandNames: ReadonlySet<string>): ConsoleCommandState {
  const fallback: ConsoleCommandState = { version: 1, aliases: {}, bindings: {}, history: [] };
  const filePath = firstExistingAppDataStorePath(appDataPath, COMMAND_STATE_FILE);
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ConsoleCommandState>;
    return {
      version: 1,
      aliases: cleanStringRecord(raw.aliases, reservedCommandNames),
      bindings: cleanBindingRecord(raw.bindings),
      history: Array.isArray(raw.history)
        ? raw.history.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).slice(-MAX_COMMAND_HISTORY)
        : [],
    };
  } catch {
    return fallback;
  }
}

export function saveCommandState(appDataPath: string, state: ConsoleCommandState): void {
  const filePath = appDataStorePath(appDataPath, COMMAND_STATE_FILE);
  mkdirSync(appDataStoreRoot(appDataPath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        aliases: state.aliases,
        bindings: state.bindings,
        history: state.history.slice(-MAX_COMMAND_HISTORY),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function cleanStringRecord(value: unknown, reservedCommandNames: ReadonlySet<string>): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = normalizeAliasName(key);
    const text = typeof entry === "string" ? entry.trim() : "";
    if (name && validAliasName(name) && !reservedCommandNames.has(name) && text) record[name] = text;
  }
  return record;
}

function cleanBindingRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = normalizeBindingKey(key);
    const text = typeof entry === "string" ? entry.trim() : "";
    if (normalizedKey && text) record[normalizedKey] = text;
  }
  return record;
}

export function normalizeAliasName(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

export function validAliasName(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function normalizeBindingKey(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  const keyRaw = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => normalizeModifierKey(part)).filter(Boolean));
  const key = normalizeKeyboardKey(keyRaw);
  if (!key) return "";
  const ordered = ["Ctrl", "Alt", "Shift", "Meta"].filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

function normalizeModifierKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "control" || normalized === "ctrl") return "Ctrl";
  if (normalized === "alt" || normalized === "option") return "Alt";
  if (normalized === "shift") return "Shift";
  if (normalized === "meta" || normalized === "cmd" || normalized === "command") return "Meta";
  return "";
}

function normalizeKeyboardKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(normalized)) return normalized.toUpperCase();
  if (normalized === "`" || normalized === "backquote") return "Backquote";
  if (normalized === "escape" || normalized === "esc") return "Escape";
  if (normalized === "space" || normalized === " ") return "Space";
  if (normalized === "enter" || normalized === "return") return "Enter";
  if (normalized === "tab") return "Tab";
  if (normalized === "delete" || normalized === "del") return "Delete";
  if (normalized === "insert" || normalized === "ins") return "Insert";
  if (normalized === "home" || normalized === "end" || normalized === "pageup" || normalized === "pagedown") {
    return normalized === "pageup" ? "PageUp" : normalized === "pagedown" ? "PageDown" : normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  if (normalized === "arrowup" || normalized === "up") return "ArrowUp";
  if (normalized === "arrowdown" || normalized === "down") return "ArrowDown";
  if (normalized === "arrowleft" || normalized === "left") return "ArrowLeft";
  if (normalized === "arrowright" || normalized === "right") return "ArrowRight";
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
}

export function commandTailText(command: ParsedConsoleCommand): string {
  return [...command.args.map(quoteConsoleArg), ...command.flags.map(formatConsoleFlag)].join(" ").trim();
}

function formatConsoleFlag(flag: ConsoleCommandFlag): string {
  if (flag.value === true) return `--${flag.name}`;
  return `--${flag.name}=${quoteConsoleArg(flag.value)}`;
}

function quoteConsoleArg(value: string): string {
  if (!value) return '""';
  return /[\s"'#]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export function isDangerousBindingCommand(command: ParsedConsoleCommand): boolean {
  if (command.command !== "close" && command.command !== "stop") return false;
  return command.target.kind === "all" || command.args[0]?.toLowerCase() === "all";
}

export function applyDryRunAliasMutation(
  command: ParsedConsoleCommand,
  aliases: Record<string, string>,
  reservedCommandNames: ReadonlySet<string>,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (command.command === "unalias") {
    const name = normalizeAliasName(command.args[0] ?? "");
    if (!name) return { ok: false, message: "usage: unalias <name>" };
    delete aliases[name];
    return { ok: true };
  }
  if (command.command !== "alias") return { ok: true };

  const name = normalizeAliasName(command.args[0] ?? "");
  if (!name) return { ok: true };
  if (!validAliasName(name)) return { ok: false, message: "usage: alias <name> <command>; names may use letters, numbers, _ and -" };
  if (reservedCommandNames.has(name)) return { ok: false, message: `${name} is a built-in command and cannot be replaced with an alias.` };
  const expansion = command.args.slice(1).join(" ").trim();
  if (!expansion) return { ok: true };
  const parsedExpansion = parseConsoleCommand(expansion);
  if (!parsedExpansion.ok) return { ok: false, message: `Alias expansion is not a valid command: ${parsedExpansion.message}` };
  if (parsedExpansion.command.command === name) return { ok: false, message: `Alias ${name} cannot expand to itself.` };
  aliases[name] = expansion;
  return { ok: true };
}
