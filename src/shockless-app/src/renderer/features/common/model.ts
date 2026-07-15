import { compactRuntimeValue, runtimeRoomId, runtimeRoomName, runtimeRoomType } from "../../../engine-adapter/shocklessSessionAdapter";
import { parseConsoleCommand } from "../../../shared/consoleCommand";
import type { ClientProfileSummary, ClientSessionSummary, MimicCategory } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeChatEntry, RuntimeUserSummary } from "../../engineRuntime";

export function labelCase(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  return text
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function statusLabel(value: unknown): string {
  const label = labelCase(value);
  return label === "Done" ? "Complete" : label;
}

export function permissionLabel(value: unknown): string {
  return String(value ?? "")
    .split(".")
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === "ui" ? "UI" : labelCase(part)))
    .join(" ") || "-";
}

export function originLabel(value: unknown): string {
  return String(value ?? "") === "built-in" ? "Built-In" : labelCase(value);
}

export function profileLine(profile: ClientProfileSummary | null | undefined): string {
  if (!profile) return "No profile selected";
  const build = profile.buildNumber ? `build ${profile.buildNumber}` : profile.versionId;
  return `${profile.label} / ${build}`;
}

export function clientSessionTitle(session: ClientSessionSummary): string {
  const mode = session.headless ? "Headless" : session.visible ? "Visible" : "Hidden";
  const markers = [session.selected ? "Selected" : "", session.main ? "Main" : "", mode, statusLabel(session.status)].filter(Boolean).join(", ");
  return `client${session.id} ${session.label} (${markers})\n${session.profileLabel}`;
}

export interface GameWebviewMount {
  readonly id: number;
  readonly label: string;
  readonly url: string;
  readonly partition: string;
}

export function gameWebviewPartitionForClient(clientId: number): string {
  return clientId === 1 ? "persist:shockless" : `persist:shockless-client-${clientId}`;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function chatEntryKey(entry: RuntimeChatEntry, index: number): string {
  return `${entry.index ?? index}-${entry.timestamp ?? ""}-${entry.userName ?? ""}`;
}

export function chatEntryLabel(entry: RuntimeChatEntry): string {
  const mode = String(entry.chatMode ?? "talk").toUpperCase();
  const user = entry.userName || "system";
  return `[${mode}] ${user}`;
}

export function chatEntryKind(entry: RuntimeChatEntry): "talk" | "whisper" | "shout" | "system" {
  const mode = String(entry.chatMode ?? "talk").toLowerCase();
  if (mode.includes("whisper")) return "whisper";
  if (mode.includes("shout")) return "shout";
  if (mode.includes("system")) return "system";
  return "talk";
}

export function compactValue(value: unknown): string {
  return compactRuntimeValue(value);
}

export function commandArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const mimicCategoryOptions: readonly { readonly id: MimicCategory; readonly label: string; readonly detail: string }[] = [
  { id: "movement", label: "Movement", detail: "walk and look packets" },
  { id: "speech", label: "Speech", detail: "chat, shout, whisper, typing" },
  { id: "actions", label: "Actions", detail: "wave, dance, carry, sign" },
  { id: "rooms", label: "Rooms", detail: "private room joins" },
];

export function withVisibleConsoleContext(input: string, snapshot: EngineRuntimeSnapshot | null, activeNames: readonly string[] = []): string {
  const parsed = parseConsoleCommand(input);
  if (!parsed.ok) return input;
  const needsSummonContext =
    parsed.command.command === "summon" ||
    parsed.command.flags.some((flag) => flag.name === "summon");
  const needsVisibleAccountContext =
    needsSummonContext ||
    parsed.command.command === "login" ||
    parsed.command.command === "load" ||
    parsed.command.command === "load-store" ||
    parsed.command.command === "accounts";
  if (!needsVisibleAccountContext) return input;
  const existingFlags = new Set(parsed.command.flags.map((flag) => flag.name));
  const additions: string[] = [];
  const mainName = firstUsefulName([snapshot?.userState?.sessionUserName, ...activeNames]);
  if (mainName && !existingFlags.has("main-name")) additions.push(`--main-name ${commandArg(mainName)}`);
  if (!existingFlags.has("active-name")) {
    for (const name of uniqueUsefulNames([snapshot?.userState?.sessionUserName, ...activeNames])) {
      additions.push(`--active-name ${commandArg(name)}`);
    }
  }
  if (!needsSummonContext) return additions.length > 0 ? `${input} ${additions.join(" ")}` : input;
  const roomId = runtimeRoomId(snapshot);
  const privateRoom = runtimeRoomType(snapshot) === "private";
  if (privateRoom && roomId && roomId !== "-" && !existingFlags.has("main-room-id")) additions.push(`--main-room-id ${commandArg(roomId)}`);
  const roomName = runtimeRoomName(snapshot);
  if (privateRoom && roomName && roomName !== "-" && !existingFlags.has("main-room-name")) additions.push(`--main-room-name ${commandArg(roomName)}`);
  return additions.length > 0 ? `${input} ${additions.join(" ")}` : input;
}

export function uniqueUsefulNames(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = String(value ?? "").trim();
    const key = name.toLowerCase();
    if (!name || name === "-" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function firstUsefulName(values: readonly unknown[]): string {
  return uniqueUsefulNames(values)[0] ?? "";
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    tagName === "webview" ||
    target.isContentEditable ||
    Boolean(target.closest("[contenteditable='true']"))
  );
}

export function bindingKeyFromKeyboardEvent(event: { readonly key: string; readonly code?: string; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly metaKey: boolean }): string {
  const key = normalizeShortcutKey(event.key, "code" in event ? event.code : "");
  if (!key) return "";
  const parts = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Meta" : "",
    key,
  ].filter(Boolean);
  return parts.join("+");
}

export function normalizeShortcutKey(keyValue: string, codeValue = ""): string {
  if (codeValue === "Backquote" || keyValue === "`") return "Backquote";
  const key = String(keyValue ?? "").trim();
  if (!key) return "";
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  return key;
}

export function userDisplayName(user: RuntimeUserSummary | null, sessionName?: string | null): string {
  if (!user) return "-";
  return compactValue(user.name ?? (user.rowId === "0" ? sessionName : null) ?? user.objectClass ?? user.className ?? user.rowId);
}

export function userPosition(user: RuntimeUserSummary | null): string {
  if (!user) return "-";
  return compactValue(user.position ?? (user.x !== undefined || user.y !== undefined ? `${compactValue(user.x)}, ${compactValue(user.y)}, ${compactValue(user.z)}` : null));
}

export function userRowMeta(user: RuntimeUserSummary, sessionName?: string | null): string {
  const parts = [
    user.rowId === "0" && sessionName ? "you" : "",
    userPosition(user) !== "-" ? `loc ${userPosition(user)}` : "",
    user.direction !== undefined ? `dir ${compactValue(user.direction)}` : "",
    user.spriteCount !== undefined ? `${compactValue(user.spriteCount)} sprites` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "-";
}

export function profileValue(primary: unknown, fallback: unknown): string {
  const value = compactValue(primary);
  if (value !== "-") return value;
  return compactValue(fallback);
}

export function lookupTokenMatches(values: readonly unknown[], normalizedToken: string, rawToken: string): boolean {
  return values.some((value) => {
    const text = compactValue(value).trim();
    if (!text || text === "-") return false;
    return text.toLowerCase() === normalizedToken || text === rawToken;
  });
}

export function runtimeUserMatchesLookup(user: RuntimeUserSummary, normalizedToken: string, rawToken: string, sessionName?: string | null): boolean {
  return lookupTokenMatches(
    [userDisplayName(user, sessionName), user.name, user.accountId, user.roomIndex, user.rowId],
    normalizedToken,
    rawToken,
  );
}
