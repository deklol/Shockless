import { readShocklessStorage } from "../../storage/shocklessStorage";

export interface InjectionCommandDraft {
  readonly rawDirection: "SERVER" | "CLIENT";
  readonly rawText: string;
}

export interface InjectionSnippet {
  readonly id: string;
  readonly label: string;
  readonly command: InjectionCommandDraft;
  readonly createdAt: string;
}

export interface InjectionHistoryEntry {
  readonly id: string;
  readonly direction: "SERVER" | "CLIENT";
  readonly packetText: string;
  readonly status: "success" | "blocked" | "warning" | "error";
  readonly message: string;
  readonly time: string;
}

export const defaultInjectionDraft: InjectionCommandDraft = {
  rawDirection: "SERVER",
  rawText: "",
};

export const injectionSnippetStorageKey = "shockless:injection-snippets";

export const injectionHistoryStorageKey = "shockless:injection-history";

export const userStoredLookStorageKey = "shockless:user-stored-looks";

export const automationPrefsStorageKey = "shockless:automation-prefs";

export function injectionCommandLabel(command: InjectionCommandDraft): string {
  const packet = command.rawText.trim();
  const summary = packet.length > 80 ? `${packet.slice(0, 80)}...` : packet || "(empty)";
  return `[${command.rawDirection}] ${summary}`;
}

export function cloneInjectionDraft(command: InjectionCommandDraft): InjectionCommandDraft {
  return {
    ...defaultInjectionDraft,
    ...command,
    rawDirection: command.rawDirection === "CLIENT" ? "CLIENT" : "SERVER",
  };
}

export function normalizeInjectionSnippet(value: unknown, index: number): InjectionSnippet | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const commandRecord = record.command && typeof record.command === "object" ? (record.command as Record<string, unknown>) : record;
  const rawText = String(commandRecord.rawText ?? record.text ?? "");
  if (!rawText.trim()) return null;
  const command = cloneInjectionDraft({
    rawDirection: String(commandRecord.rawDirection ?? record.direction ?? "SERVER").toUpperCase() === "CLIENT" ? "CLIENT" : "SERVER",
    rawText,
  });
  return {
    id: String(record.id ?? `loaded-${Date.now()}-${index}`),
    label: String(record.label ?? injectionCommandLabel(command)),
    command,
    createdAt: String(record.createdAt ?? new Date().toISOString()),
  };
}

export function normalizeInjectionSnippets(value: unknown): InjectionSnippet[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.map(normalizeInjectionSnippet).filter((entry): entry is InjectionSnippet => Boolean(entry)).slice(0, 50);
}

export function normalizeInjectionHistory(value: unknown): InjectionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const legacyLabel = String(record.label ?? "");
    const legacyDirection = /^\[(CLIENT|SERVER)\]/i.exec(legacyLabel)?.[1];
    const direction: InjectionHistoryEntry["direction"] = String(record.direction ?? legacyDirection ?? "SERVER").toUpperCase() === "CLIENT" ? "CLIENT" : "SERVER";
    const packetText = String(record.packetText ?? legacyLabel).replace(/^\[(?:SERVER|CLIENT)\]\s*/i, "");
    const rawStatus = String(record.status ?? "warning");
    const status: InjectionHistoryEntry["status"] = ["success", "blocked", "warning", "error"].includes(rawStatus)
      ? (rawStatus as InjectionHistoryEntry["status"])
      : "warning";
    return [{
      id: String(record.id ?? `history-${index}`),
      direction,
      packetText,
      status,
      message: String(record.message ?? ""),
      time: String(record.time ?? ""),
    }];
  }).slice(0, 50);
}

export function normalizeStoredUserLooks(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : [];
  return [...new Set(rows.map((entry) => String(entry ?? "").trim()).filter(Boolean))].slice(0, 20);
}

export function loadStoredUserLooks(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeStoredUserLooks(JSON.parse(readShocklessStorage(window.localStorage, userStoredLookStorageKey) || "[]"));
  } catch {
    return [];
  }
}

export function loadAutomationPrefs(): { readonly autoHideBulletin: boolean } {
  if (typeof window === "undefined") return { autoHideBulletin: true };
  try {
    const parsed = JSON.parse(readShocklessStorage(window.localStorage, automationPrefsStorageKey) || "{}") as { readonly autoHideBulletin?: unknown };
    return { autoHideBulletin: parsed.autoHideBulletin !== false };
  } catch {
    return { autoHideBulletin: true };
  }
}

export async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a temporary textarea below.
    }
  }
  if (typeof document === "undefined" || !document.body) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  textarea.style.top = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function clampRepeatCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(25, parsed));
}

export function clampRepeatInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.max(50, Math.min(60000, parsed));
}

export function clampMultiAccountCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(50, parsed));
}

export function clampMultiAccountConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(8, parsed));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
