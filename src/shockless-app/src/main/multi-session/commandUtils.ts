import type {
  ConsoleCommandResult,
  ConsoleRendererAction,
  ParsedConsoleCommand,
} from "../../shared/consoleCommand.js";
import type { MultiClientAccount } from "../../shared/multiClientAccounts.js";
import type { MimicCategory, RelayLogEntry } from "../../shared/window-api.js";

export function socialCandidatesFromFields(fields: readonly { readonly label: string; readonly value: string }[]): readonly { readonly name: string; readonly accountId: number }[] {
  const candidates = new Map<string, { name: string; accountId: number | null }>();
  for (const field of fields) {
    const match = field.label.match(/^(user \d+|friend \d+|friendUpdate \d+|friendAdded|friendRequest \d+|highlightFriend \d+) (name|accountId)$/);
    if (!match) continue;
    const key = match[1]!;
    const kind = match[2]!;
    const existing = candidates.get(key) ?? { name: "", accountId: null };
    candidates.set(key, kind === "name" ? { ...existing, name: field.value } : { ...existing, accountId: positiveInteger(field.value) });
  }
  return [...candidates.values()].filter(
    (candidate): candidate is { name: string; accountId: number } => Boolean(candidate.name) && candidate.accountId !== null,
  );
}

export function normalizeSocialName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function accountNameKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function defaultMimicCategories(): Record<MimicCategory, boolean> {
  return { movement: true, speech: true, actions: true, rooms: true };
}

export function mimicCategoryFromArg(value: unknown): MimicCategory | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["move", "movement", "walk", "walking"].includes(normalized)) return "movement";
  if (["speech", "chat", "talk", "typing"].includes(normalized)) return "speech";
  if (["action", "actions", "emote", "emotes"].includes(normalized)) return "actions";
  if (["room", "rooms", "join", "joins"].includes(normalized)) return "rooms";
  return null;
}

export function enabledFromArg(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(normalized)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(normalized)) return false;
  return null;
}

export function mimicCategoryForRelayEntry(entry: RelayLogEntry): MimicCategory | null {
  if (entry.header === 21) return "rooms";
  const name = normalizedMimicPacketName(entry.packetName);
  if (!name) return null;
  if (["move", "lookto"].includes(name)) return "movement";
  if (["chat", "shout", "whisper", "userstarttyping", "usercanceltyping", "starttyping", "canceltyping"].includes(name)) return "speech";
  if (["dance", "wave", "carrydrink", "carryitem", "sign", "update", "swimsuit", "look", "figure", "motto", "expression", "action"].includes(name)) return "actions";
  return null;
}

export function mimicPrivateRoomIdFromEntry(entry: RelayLogEntry): string | null {
  if (entry.header !== 21) return null;
  const candidates = [entry.bodyAscii, entry.bodyText, relayDecodedField(entry, "ascii"), relayDecodedField(entry, "field 1")];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (/^\d{1,10}$/.test(text)) return text;
  }
  return null;
}

export function relayDecodedField(entry: RelayLogEntry, label: string): string | null {
  return entry.decodedFields.find((field) => field.label.toLowerCase() === label.toLowerCase())?.value ?? null;
}

export function normalizedMimicPacketName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function handled(
  ok: boolean,
  level: ConsoleCommandResult["level"],
  lines: readonly string[],
  command?: ParsedConsoleCommand,
  targetClientIds?: readonly number[],
  rendererActions?: readonly ConsoleRendererAction[],
): ConsoleCommandResult {
  return { ok, handled: true, level, lines, command, targetClientIds, rendererActions };
}

export function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function flagEnabled(command: ParsedConsoleCommand, name: string): boolean {
  const normalized = name.toLowerCase();
  return command.flags.some((flag) => flag.name === normalized);
}

export function flagValue(command: ParsedConsoleCommand, name: string): string | null {
  const normalized = name.toLowerCase();
  const flag = command.flags.find((entry) => entry.name === normalized);
  return flag && flag.value !== true ? flag.value : null;
}

export function flagValues(command: ParsedConsoleCommand, name: string): readonly string[] {
  const normalized = name.toLowerCase();
  return command.flags
    .filter((entry) => entry.name === normalized && entry.value !== true)
    .map((entry) => String(entry.value).trim())
    .filter(Boolean);
}

export function accountStoreKeyFromEnv(command: ParsedConsoleCommand):
  | { readonly ok: true; readonly key: string; readonly envName: string }
  | { readonly ok: false; readonly message: string } {
  const envName = flagValue(command, "key-env")?.trim() ?? "";
  if (!envName) return { ok: false, message: "usage: include --key-env <ENV_NAME> for encrypted account store commands" };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return { ok: false, message: `Invalid key environment variable name: ${envName}` };
  const key = process.env[envName] ?? "";
  if (!key) return { ok: false, message: `Environment variable ${envName} is not set.` };
  return { ok: true, key, envName };
}

export function consoleArgsText(command: ParsedConsoleCommand): string {
  return command.args.join(" ");
}

export function accountFromLoginArg(value: unknown, labelValue: unknown): MultiClientAccount | null {
  const text = String(value ?? "");
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) return null;
  const email = text.slice(0, separator).trim();
  const password = text.slice(separator + 1);
  if (!email || !password) return null;
  return {
    label: String(labelValue ?? email.split("@")[0] ?? "Client").slice(0, 32),
    email,
    password,
  };
}
