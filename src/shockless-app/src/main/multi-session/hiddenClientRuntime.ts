import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../shared/errors.js";

export interface HiddenClientDiagnosticEvent {
  readonly at: string;
  readonly type: string;
  readonly message: string;
}

interface HiddenClientHandle {
  readonly id: number;
  readonly label: string;
  readonly hiddenWindow: BrowserWindow | null;
}

interface EngineLoginReadinessSnapshot {
  readonly url: string;
  readonly title: string;
  readonly readyState: string;
  readonly hasEngine: boolean;
  readonly hasDev: boolean;
  readonly hasLogin: boolean;
  readonly editableFieldCount: number;
  readonly canvasCount: number;
  readonly engineKeys: readonly string[];
  readonly devKeys: readonly string[];
  readonly bodyText: string;
  readonly diagnostics: Record<string, unknown>;
  readonly error?: string;
}

export async function loadBrowserWindowConstructor(): Promise<new (options: BrowserWindowConstructorOptions) => BrowserWindow> {
  const electronModule = await import("electron");
  const defaultExport = (electronModule as unknown as { default?: typeof electronModule }).default;
  const BrowserWindowCtor = electronModule.BrowserWindow ?? defaultExport?.BrowserWindow;
  if (!BrowserWindowCtor) throw new Error("Electron BrowserWindow is unavailable outside the Electron main process.");
  return BrowserWindowCtor;
}

export function attachHiddenClientDiagnostics(window: BrowserWindow, events: HiddenClientDiagnosticEvent[]): void {
  const push = (type: string, message: string): void => {
    events.push({ at: new Date().toISOString(), type, message: maskDiagnosticText(message) });
    if (events.length > 80) events.shift();
  };

  window.webContents.on("dom-ready", () => push("dom-ready", window.webContents.getURL()));
  window.webContents.on("did-finish-load", () => push("did-finish-load", window.webContents.getURL()));
  window.webContents.on("did-stop-loading", () => push("did-stop-loading", window.webContents.getURL()));
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    push("did-fail-load", `${isMainFrame ? "main" : "sub"} ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    push("console-message", `${level} ${message} (${sourceId}:${line})`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    push("render-process-gone", JSON.stringify(details));
  });
  window.webContents.on("unresponsive", () => push("unresponsive", "webContents became unresponsive"));
}

export async function submitEngineLoginWhenReady(
  window: BrowserWindow,
  email: string,
  password: string,
  timeoutMs: number,
): Promise<void> {
  return submitEngineLoginInWebContents(window.webContents, email, password, timeoutMs, () => window.isDestroyed());
}

export function hiddenClientUrl(embeddedUrl: string): string {
  const url = new URL(embeddedUrl);
  url.searchParams.set("fastEntry", "1");
  url.searchParams.set("customHotelView", "0");
  url.searchParams.set("headlessRuntime", "1");
  return url.toString();
}

export function showHiddenRuntimeWindow(window: BrowserWindow, clientId: number): void {
  if (process.env.SHOCKLESS_HEADLESS_WINDOW_MODE === "hidden") return;
  window.setPosition(hiddenWindowX(clientId), hiddenWindowY(clientId), false);
  window.setSkipTaskbar(true);
  window.showInactive();
}

export async function writeHiddenClientDiagnostic(
  client: HiddenClientHandle,
  error: unknown,
  events: readonly HiddenClientDiagnosticEvent[],
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(process.cwd(), "logs", "automation");
  const screenshotDir = join(process.cwd(), "screenshots", "automation");
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });

  const hiddenWindow = client.hiddenWindow;
  let screenshotPath: string | null = null;
  let state: EngineLoginReadinessSnapshot | null = null;
  if (hiddenWindow && !hiddenWindow.isDestroyed()) {
    state = await engineLoginReadiness(hiddenWindow);
    const image = await hiddenWindow.webContents.capturePage().catch(() => null);
    if (image) {
      screenshotPath = join(screenshotDir, `hidden-client-${client.id}-${stamp}.png`);
      writeFileSync(screenshotPath, image.toPNG());
    }
  }

  const reportPath = join(reportDir, `hidden-client-${client.id}-${stamp}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        clientId: client.id,
        clientLabel: client.label,
        error: maskDiagnosticText(errorMessage(error)),
        state,
        events,
        screenshotPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return reportPath;
}

export async function execHiddenEngine(
  client: { readonly hiddenWindow: BrowserWindow | null },
  code: (text: string) => string,
  text = "",
): Promise<unknown> {
  const hiddenWindow = client.hiddenWindow;
  if (!hiddenWindow || hiddenWindow.isDestroyed()) throw new Error("hidden webContents is not running");
  return hiddenWindow.webContents.executeJavaScript(code(text), true);
}

export async function submitEngineLoginInWebContents(
  contents: WebContents,
  email: string,
  password: string,
  timeoutMs: number,
  isDestroyed: () => boolean = () => contents.isDestroyed(),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await engineLoginReadinessInWebContents(contents);
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    if (isDestroyed() || contents.isDestroyed()) throw new Error("webContents was destroyed before login");
    const attempt = await contents
      .executeJavaScript(loginAttemptScript(email, password), true)
      .catch((error: unknown) => ({ sent: false, error: errorMessage(error), snapshot: null }));
    if (isRecord(attempt) && attempt.snapshot) lastSnapshot = normalizeEngineReadinessSnapshot(attempt.snapshot);
    if (isRecord(attempt) && attempt.sent === true) {
      const loginState = await waitForEngineLoginStateInWebContents(contents, Math.max(1000, deadline - Date.now()), isDestroyed);
      if (loginState.ok) return;
      lastError = loginState.message;
    }
    lastError = isRecord(attempt) && typeof attempt.error === "string" ? attempt.error : lastError;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  const detail = summarizeEngineReadiness(lastSnapshot);
  throw new Error(`login fields were not ready before timeout (${detail}${lastError ? `; last login error: ${lastError}` : ""})`);
}

function loginAttemptScript(email: string, password: string): string {
  return `
    (async () => {
      const snapshot = ${engineReadinessScript()};
      const dev = window.__engine?.dev;
      const login = dev?.login;
      if (typeof login !== "function") return { sent: false, snapshot };
      if (typeof dev.editableFields === "function" && dev.editableFields().length < 2) return { sent: false, snapshot };
      try {
        await login(${JSON.stringify(email)}, ${JSON.stringify(password)}, 10);
        return { sent: true, snapshot: ${engineReadinessScript()} };
      } catch (error) {
        return { sent: false, error: String(error?.message ?? error), snapshot: ${engineReadinessScript()} };
      }
    })()
  `;
}

async function waitForEngineLoginStateInWebContents(
  contents: WebContents,
  timeoutMs: number,
  isDestroyed: () => boolean = () => contents.isDestroyed(),
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    if (isDestroyed() || contents.isDestroyed()) throw new Error("webContents was destroyed before login completed");
    const state = await contents.executeJavaScript(engineLoginStateScript(), true).catch((error: unknown) => ({ error: errorMessage(error) }));
    lastState = state;
    if (engineLoginStateComplete(state)) return { ok: true };
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  return { ok: false, message: `login did not expose a session before timeout (${summarizeEngineLoginState(lastState)})` };
}

function engineLoginStateComplete(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.userName === "string" && value.userName.trim()) return true;
  return value.roomReady === true;
}

function summarizeEngineLoginState(value: unknown): string {
  if (!isRecord(value)) return "no login state";
  const parts = [
    `title=${stringOrNull(value.title) ?? "-"}`,
    `user=${stringOrNull(value.userName) ?? "-"}`,
    `roomReady=${typeof value.roomReady === "boolean" ? String(value.roomReady) : "-"}`,
    `fields=${finiteNumberOrNull(value.fieldCount) ?? "-"}`,
    value.error ? `error=${stringOrNull(value.error) ?? "-"}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function engineLoginStateScript(): string {
  return `
    (() => {
      const compact = (value) => value === undefined || value === null || value === "" ? null : String(value);
      try {
        const engine = window.__engine;
        const dev = engine?.dev;
        const roomReady = typeof dev?.roomReady === "function" ? dev.roomReady() : null;
        const roomObjects = typeof engine?.roomObjects === "function" ? engine.roomObjects() : null;
        const users = Array.isArray(roomObjects?.users) ? roomObjects.users : [];
        const sessionProps = typeof engine?.objectProps === "function" ? engine.objectProps("Session") : null;
        const props = sessionProps?.props ?? sessionProps?.properties ?? sessionProps;
        const userName =
          compact(props?.userName ?? props?.pUserName ?? props?.username) ??
          compact(users.find((user) => String(user?.rowId ?? user?.id ?? "") === "0")?.name) ??
          null;
        return {
          title: document.title,
          href: location.href,
          userName,
          roomReady: typeof roomReady?.ready === "boolean" ? roomReady.ready : null,
          fieldCount: typeof dev?.editableFields === "function" ? dev.editableFields().length : null,
          error: null
        };
      } catch (error) {
        return {
          title: document.title,
          href: location.href,
          userName: null,
          roomReady: null,
          fieldCount: null,
          error: String(error?.message ?? error)
        };
      }
    })()
  `;
}

export function hiddenWindowX(clientId: number): number {
  return -32000 - (clientId % 12) * 32;
}

export function hiddenWindowY(clientId: number): number {
  return -32000 - Math.floor(clientId / 12) * 32;
}

async function engineLoginReadiness(window: BrowserWindow): Promise<EngineLoginReadinessSnapshot> {
  if (window.isDestroyed()) return normalizeEngineReadinessSnapshot({ error: "window destroyed" });
  return engineLoginReadinessInWebContents(window.webContents);
}

async function engineLoginReadinessInWebContents(contents: WebContents): Promise<EngineLoginReadinessSnapshot> {
  if (contents.isDestroyed()) return normalizeEngineReadinessSnapshot({ error: "webContents destroyed" });
  const raw = await contents.executeJavaScript(engineReadinessScript(), true).catch((error: unknown) => ({ error: errorMessage(error) }));
  return normalizeEngineReadinessSnapshot(raw);
}

function engineReadinessScript(): string {
  return `
    (() => {
      try {
        const engine = window.__engine;
        const dev = engine?.dev;
        let fieldCount = -1;
        try {
          fieldCount = typeof dev?.editableFields === "function" ? dev.editableFields().length : -1;
        } catch {
          fieldCount = -2;
        }
        const errors = typeof engine?.errors === "function" ? engine.errors() : [];
        const loadedCasts = typeof engine?.loadedCasts === "function" ? engine.loadedCasts() : [];
        const objectIds = typeof engine?.objectIds === "function" ? engine.objectIds() : [];
        const activeSprites = typeof engine?.activeSprites === "function" ? engine.activeSprites() : [];
        return {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          hasEngine: Boolean(engine),
          hasDev: Boolean(dev),
          hasLogin: typeof dev?.login === "function",
          editableFieldCount: fieldCount,
          canvasCount: document.querySelectorAll("canvas").length,
          engineKeys: Object.keys(engine || {}).slice(0, 30),
          devKeys: Object.keys(dev || {}).slice(0, 60),
          bodyText: String(document.body?.innerText || "").slice(0, 400),
          diagnostics: {
            frame: typeof engine?.frame === "function" ? engine.frame() : null,
            errors: Array.isArray(errors) ? errors.slice(-12) : errors,
            loadedCasts: Array.isArray(loadedCasts) ? loadedCasts.slice(0, 80) : loadedCasts,
            objectIds: Array.isArray(objectIds) ? objectIds.slice(0, 80) : objectIds,
            activeSprites: Array.isArray(activeSprites) ? activeSprites.slice(0, 12).map((sprite) => ({
              n: sprite.n,
              member: sprite.member,
              loc: sprite.loc,
              visible: sprite.visible,
              text: sprite.text,
            })) : [],
            performance: typeof dev?.performanceStats === "function" ? dev.performanceStats() : null,
            roomEntryState: typeof dev?.roomEntryState === "function" ? dev.roomEntryState() : null,
            customHotelView: typeof dev?.customHotelView === "function" ? dev.customHotelView() : null
          }
        };
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    })()
  `;
}

function normalizeEngineReadinessSnapshot(raw: unknown): EngineLoginReadinessSnapshot {
  const value = isRecord(raw) ? raw : {};
  return {
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    readyState: typeof value.readyState === "string" ? value.readyState : "",
    hasEngine: value.hasEngine === true,
    hasDev: value.hasDev === true,
    hasLogin: value.hasLogin === true,
    editableFieldCount: typeof value.editableFieldCount === "number" ? value.editableFieldCount : -1,
    canvasCount: typeof value.canvasCount === "number" ? value.canvasCount : -1,
    engineKeys: stringArray(value.engineKeys),
    devKeys: stringArray(value.devKeys),
    bodyText: typeof value.bodyText === "string" ? maskDiagnosticText(value.bodyText) : "",
    diagnostics: isRecord(value.diagnostics) ? value.diagnostics : {},
    error: typeof value.error === "string" ? maskDiagnosticText(value.error) : undefined,
  };
}

function summarizeEngineReadiness(snapshot: EngineLoginReadinessSnapshot): string {
  const title = snapshot.title ? ` title=${snapshot.title}` : "";
  const body = snapshot.bodyText ? ` body=${JSON.stringify(snapshot.bodyText.slice(0, 120))}` : "";
  const error = snapshot.error ? ` readinessError=${snapshot.error}` : "";
  return `readyState=${snapshot.readyState || "-"} engine=${snapshot.hasEngine} dev=${snapshot.hasDev} login=${snapshot.hasLogin} fields=${snapshot.editableFieldCount} canvas=${snapshot.canvasCount}${title}${body}${error}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 80) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function maskDiagnosticText(text: string): string {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(password|token|webhook|secret)=\S+/gi, "$1=[redacted]");
}
