import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientLibraryStore, type ClientLibraryProfile } from "./clientLibrary.js";
import type { PluginRelayPolicy } from "../shared/pluginRelayHooks.js";
import type { EngineLaunchState } from "../shared/window-api.js";

const HABBPY_CACHE_DIR = "HabbpyV4";
const RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_WS_PORT = 12326;
const DEFAULT_RELAY_CONTROL_PORT = 12327;
const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const ORIGINS_FURNIDATA_FILE = "furnidata.txt";
const ORIGINS_PRODUCTDATA_FILE = "productdata.txt";
const activeRelayChildren = new Set<ChildProcess>();
let relayCleanupHooksRegistered = false;
const ORIGINS_GAMEDATA_URLS: Readonly<Record<string, string>> = {
  [ORIGINS_FURNIDATA_FILE]: "https://origins.habbo.com/gamedata/furnidata/1",
  [ORIGINS_PRODUCTDATA_FILE]: "https://origins.habbo.com/gamedata/productdata/1",
};
const STALE_VERSION_CHECK_BUILDS = new Set([401, 1124, 1125, 1126, 1127, 1128]);

interface RuntimeProfilePaths {
  readonly client: string;
  readonly runtimeData: string;
  readonly assets: string;
  readonly scripts: string;
}

interface RuntimeProfileDetails extends ClientLibraryProfile {
  readonly fixedStage: boolean;
  readonly resizablePresentation: boolean;
  readonly customHotelView?: boolean;
  readonly paths: RuntimeProfilePaths;
}

export interface ShocklessSettings {
  readonly activeProfileId: string | null;
  readonly resizablePresentation: boolean | null;
  readonly customHotelView: boolean | null;
  readonly versionCheckBuild: number | null;
}

export interface ShocklessSettingsPatch {
  readonly activeProfileId?: string | null;
  readonly resizablePresentation?: boolean | null;
  readonly customHotelView?: boolean | null;
  readonly versionCheckBuild?: number | null;
}

interface LaunchContext {
  readonly profile: RuntimeProfileDetails;
  readonly engineRoot: string;
  readonly relay: RelayLaunch;
  readonly relayWsPort: number;
  readonly relayControlPort: number;
  readonly settings: {
    readonly resizablePresentation: boolean;
    readonly customHotelView: boolean;
    readonly versionCheckBuild: number | null;
  };
}

interface RelayLaunch {
  readonly script: string;
  readonly resourceDir: string | null;
  readonly safeBodyLogging: boolean;
}

export class ShocklessEmbedController {
  private readonly staticServer: EmbeddedStaticServer;
  private readonly relay: EmbeddedRelayController;
  private currentUrl: string | null = null;
  private currentContext: LaunchContext | null = null;
  private lastError = "";

  constructor(
    private readonly options: {
      readonly appDataPath: string;
      readonly library: ClientLibraryStore;
      readonly cacheNamespace?: string;
      readonly relayWsPort?: number;
      readonly relayControlPort?: number;
      readonly relayPolicyProvider?: () => PluginRelayPolicy;
    },
  ) {
    const cacheRoot = options.cacheNamespace
      ? join(options.appDataPath, HABBPY_CACHE_DIR, options.cacheNamespace)
      : join(options.appDataPath, HABBPY_CACHE_DIR);
    this.staticServer = new EmbeddedStaticServer(cacheRoot);
    this.relay = new EmbeddedRelayController(cacheRoot, this.relayWsPort(), this.relayControlPort(), options.relayPolicyProvider);
  }

  relayWsPort(): number {
    return this.options.relayWsPort ?? DEFAULT_RELAY_WS_PORT;
  }

  relayControlPort(): number {
    return this.options.relayControlPort ?? DEFAULT_RELAY_CONTROL_PORT;
  }

  status(): EngineLaunchState {
    if (this.currentContext) return this.toState("running", this.currentContext, this.currentUrl, "Shockless WebContents is embedded.");
    const context = this.resolveContext();
    if (context) return this.toState("ready", context, null, "Shockless profile is ready to embed.");
    const launchDefaults = pendingLaunchSettings(this.options.appDataPath);
    return {
      status: this.lastError ? "error" : "not-configured",
      embeddedUrl: null,
      profile: null,
      buildLabel: "No dynamic client profile",
      message: this.lastError || "Register an existing Shockless profile or clients folder before embedding.",
      settings: launchDefaults,
    };
  }

  async start(): Promise<EngineLaunchState> {
    const context = this.resolveContext();
    if (!context) return this.status();
    try {
      await this.relay.start(context.relay);
      const baseUrl = await this.staticServer.start(context);
      const embeddedUrl = buildShocklessEmbedUrl(baseUrl, context);
      this.currentContext = context;
      this.currentUrl = embeddedUrl;
      this.lastError = "";
      return this.toState("running", context, embeddedUrl, "Shockless WebContents is embedded.");
    } catch (error) {
      this.lastError = errorMessage(error);
      return this.toState("error", context, null, this.lastError);
    }
  }

  stop(): EngineLaunchState {
    this.currentUrl = null;
    this.currentContext = null;
    this.staticServer.stop();
    this.relay.stop();
    return this.status();
  }

  dispose(): void {
    this.currentUrl = null;
    this.currentContext = null;
    this.staticServer.stop();
    this.relay.stop();
  }

  private resolveContext(): LaunchContext | null {
    try {
      const profileSummary = this.options.library.selectedProfile();
      if (!profileSummary) {
        this.lastError = "";
        return null;
      }
      if (!profileSummary.ready) throw new Error(profileSummary.reason || "No ready profile selected.");
      const profile = readRuntimeProfileDetails(profileSummary.profileRoot, profileSummary);
      const engineRoot = resolveEngineRoot(profile.profileRoot);
      const relay = resolveRelayLaunch(profile.profileRoot);
      const shocklessSettings = readShocklessSettings(this.options.appDataPath);
      const settingApplies = shocklessSettings.activeProfileId === null || shocklessSettings.activeProfileId === profile.id;
      const versionSettingApplies = shocklessSettings.activeProfileId === profile.id;
      const resizablePresentation = embeddedResizablePresentation(
        settingApplies ? shocklessSettings.resizablePresentation : null,
        profile.resizablePresentation,
      );
      this.lastError = "";
      return {
        profile,
        engineRoot,
        relay,
        relayWsPort: this.relayWsPort(),
        relayControlPort: this.relayControlPort(),
        settings: {
          resizablePresentation,
          customHotelView: (settingApplies ? shocklessSettings.customHotelView : null) ?? profile.customHotelView === true,
          versionCheckBuild:
            positiveInteger(process.env.HABBPY_V4_VERSION_CHECK_BUILD) ??
            (versionSettingApplies ? shocklessSettings.versionCheckBuild : profile.versionCheckBuild),
        },
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return null;
    }
  }

  private toState(
    status: EngineLaunchState["status"],
    context: LaunchContext,
    embeddedUrl: string | null,
    message: string,
  ): EngineLaunchState {
    return {
      status,
      embeddedUrl,
      profile: context.profile,
      buildLabel: buildLabel(context.profile, context.settings.versionCheckBuild),
      message,
      settings: context.settings,
    };
  }
}

export function buildShocklessEmbedUrl(baseUrl: string, context: LaunchContext): string {
  const url = new URL(baseUrl);
  url.searchParams.set("profile", context.profile.id);
  url.searchParams.set("profileVersion", context.profile.versionId);
  url.searchParams.set("standalone", "1");
  url.searchParams.set("machineId", "director-habbo-runtime");
  if (context.settings.versionCheckBuild !== null) {
    url.searchParams.set("versionCheckBuild", String(context.settings.versionCheckBuild));
  }
  if (context.settings.resizablePresentation) url.searchParams.set("resizablePresentation", "1");
  if (context.settings.customHotelView) url.searchParams.set("customHotelView", "1");
  url.searchParams.set("bridgeHost", RELAY_HOST);
  url.searchParams.set("bridgePort", String(context.relayWsPort));
  return url.toString();
}

export function normalizeOriginsExternalVariables(text: string, versionCheckBuild?: number | null): string {
  const lines = text.split(/\r\n|\r|\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  const keys = new Set(lines.map(variableKey).filter((key): key is string => Boolean(key)));
  const normalizedVersionCheckBuild = positiveInteger(versionCheckBuild);
  if (normalizedVersionCheckBuild !== null) {
    setExternalVariable(lines, keys, "client.version.id", String(normalizedVersionCheckBuild));
  }
  const flashDynamicDownload = valueForExternalVariable(lines, "flash.dynamic.download.url");
  if (!keys.has("dynamic.download.url") && flashDynamicDownload) lines.push(`dynamic.download.url=${flashDynamicDownload}`);
  if (!keys.has("furnidata.load.url")) lines.push(`furnidata.load.url=${ORIGINS_FURNIDATA_FILE}`);
  if (!keys.has("productdata.load.url")) lines.push(`productdata.load.url=${ORIGINS_PRODUCTDATA_FILE}`);
  return lines.join("\r");
}

class EmbeddedStaticServer {
  private server: Server | null = null;
  private port = 0;
  private context: LaunchContext | null = null;

  constructor(private readonly cacheRoot: string) {}

  async start(context: LaunchContext): Promise<string> {
    this.context = context;
    if (this.server) return `http://127.0.0.1:${this.port}/`;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.log(errorMessage(error));
        if (!response.headersSent) sendText(response, 500, "embedded Shockless static server error");
        else response.end();
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolveStart());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${this.port}/`;
  }

  stop(): void {
    const server = this.server;
    server?.close();
    server?.closeAllConnections?.();
    this.server = null;
    this.port = 0;
    this.context = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const context = this.context;
    if (!context) {
      sendText(response, 503, "No Shockless profile is active.");
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (pathname.startsWith("/origins-data/")) {
      await this.handleOriginsData(context, pathname, response);
      return;
    }

    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const match = [safeJoin(join(context.engineRoot, "dist"), requested), safeJoin(context.engineRoot, requested)].find(
      (candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (match) {
      sendFile(response, match);
      return;
    }
    sendText(response, 503, "Shockless engine build not found.");
  }

  private async handleOriginsData(context: LaunchContext, pathname: string, response: ServerResponse): Promise<void> {
    const relativePath = pathname.slice("/origins-data/".length);
    const [rootKey, ...rest] = relativePath.split("/");
    const requestPath = rest.join("/");
    const roots =
      rootKey === "client"
        ? [join(context.profile.profileRoot, context.profile.paths.client)]
        : rootKey === "runtime-data"
          ? [join(context.profile.profileRoot, context.profile.paths.runtimeData)]
          : rootKey === "assets"
            ? [join(context.profile.profileRoot, context.profile.paths.assets)]
            : rootKey === "scripts"
              ? [join(context.profile.profileRoot, context.profile.paths.scripts)]
              : [];
    const match = roots
      .map((root) => safeJoin(root, requestPath))
      .find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile());
    if (match) {
      if (rootKey === "client" && requestPath.toLowerCase() === "external_variables.txt") {
        sendText(response, 200, normalizeOriginsExternalVariables(readFileSync(match, "utf8"), context.settings.versionCheckBuild));
        return;
      }
      sendFile(response, match);
      return;
    }

    if (rootKey === "client") {
      const cached = await this.cachedOriginsGamedata(requestPath);
      if (cached) {
        sendFile(response, cached);
        return;
      }
    }

    this.log(`404 ${pathname}`);
    sendText(response, 404, "not found");
  }

  private async cachedOriginsGamedata(requestPath: string): Promise<string | null> {
    const normalizedPath = requestPath.replace(/\\/g, "/").toLowerCase();
    const sourceUrl = ORIGINS_GAMEDATA_URLS[normalizedPath];
    if (!sourceUrl) return null;
    const cacheDir = join(this.cacheRoot, "gamedata");
    mkdirSync(cacheDir, { recursive: true });
    const target = safeJoin(cacheDir, normalizedPath);
    if (!target) return null;
    if (existsSync(target)) return target;
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Failed to fetch ${sourceUrl}: HTTP ${response.status}`);
    writeFileSync(target, await response.text(), "utf8");
    return target;
  }

  private log(message: string): void {
    const logRoot = join(this.cacheRoot, "logs");
    mkdirSync(logRoot, { recursive: true });
    appendFileSync(join(logRoot, "shockless-static-server.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  }
}

class EmbeddedRelayController {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;

  constructor(
    private readonly cacheRoot: string,
    private readonly wsPort: number,
    private readonly controlPort: number,
    private readonly relayPolicyProvider?: () => PluginRelayPolicy,
  ) {}

  async start(launch: RelayLaunch): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (await isTcpOpen(RELAY_HOST, this.wsPort, 150)) {
      throw new Error(`Shockless relay port ws://${RELAY_HOST}:${this.wsPort} is already in use by another process. Close the stale relay/client before starting Habbpy v4.`);
    }
    if (await isTcpOpen(RELAY_HOST, this.controlPort, 150)) {
      throw new Error(`Shockless relay control port tcp://${RELAY_HOST}:${this.controlPort} is already in use by another process. Close the stale relay/client before starting Habbpy v4.`);
    }
    const logRoot = join(this.cacheRoot, "logs");
    mkdirSync(logRoot, { recursive: true });
    const logPath = join(logRoot, "shockless-relay.log");
    const pluginPolicyPath = join(logRoot, "plugin-relay-policy.json");
    if (this.relayPolicyProvider) {
      writeFileSync(pluginPolicyPath, `${JSON.stringify(this.relayPolicyProvider(), null, 2)}\n`, "utf8");
    }
    this.logStream?.end();
    this.logStream = createWriteStream(logPath, { flags: "a" });
    this.child = spawn(process.execPath, [launch.script], {
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ORIGINS_WS_HOST: RELAY_HOST,
        ORIGINS_WS_PORT: String(this.wsPort),
        ORIGINS_CONTROL_HOST: RELAY_HOST,
        ORIGINS_CONTROL_PORT: String(this.controlPort),
        ORIGINS_LOG_PACKETS: "1",
        ORIGINS_SESSION_LOG_DIR: logRoot,
        ...(this.relayPolicyProvider ? { ORIGINS_PLUGIN_RELAY_POLICY_FILE: pluginPolicyPath } : {}),
        ...(launch.resourceDir ? { ORIGINS_RELAY_RESOURCE_DIR: launch.resourceDir } : {}),
        ...(launch.safeBodyLogging ? { ORIGINS_LOG_PACKET_BODIES: "safe" } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = this.child;
    trackRelayChild(child);
    child.stdout?.pipe(this.logStream, { end: false });
    child.stderr?.pipe(this.logStream, { end: false });
    const ready = await waitForTcp(RELAY_HOST, this.wsPort, 5000);
    if (!ready) {
      this.stop();
      throw new Error(`Shockless relay did not open ws://${RELAY_HOST}:${this.wsPort}. See ${logPath}`);
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child) killRelayChildTree(child, "SIGTERM");
    this.logStream?.end();
    this.logStream = null;
  }
}

export function stopActiveEmbeddedRelays(): void {
  for (const child of [...activeRelayChildren]) killRelayChildTree(child, "SIGTERM");
}

function trackRelayChild(child: ChildProcess): void {
  activeRelayChildren.add(child);
  child.once("close", () => activeRelayChildren.delete(child));
  child.once("error", () => activeRelayChildren.delete(child));
  registerRelayCleanupHooks();
}

function registerRelayCleanupHooks(): void {
  if (relayCleanupHooksRegistered) return;
  relayCleanupHooksRegistered = true;
  process.once("exit", () => {
    stopActiveEmbeddedRelays();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stopActiveEmbeddedRelays();
      scheduleSignalExit(signalExitCode(signal));
    });
  }
}

function killRelayChildTree(child: ChildProcess, fallbackSignal: NodeJS.Signals): void {
  activeRelayChildren.delete(child);
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (!result.error) return;
  }
  child.kill(fallbackSignal);
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function scheduleSignalExit(code: number): void {
  setImmediate(() => process.exit(code));
}

function readRuntimeProfileDetails(profileRoot: string, summary: ClientLibraryProfile): RuntimeProfileDetails {
  const parsed = JSON.parse(readFileSync(join(profileRoot, "profile.json"), "utf8")) as {
    readonly fixedStage?: boolean;
    readonly resizablePresentation?: boolean;
    readonly customHotelView?: boolean;
    readonly paths?: RuntimeProfilePaths;
  };
  if (!parsed.paths) throw new Error(`Profile is missing runtime paths: ${profileRoot}`);
  return {
    ...summary,
    fixedStage: parsed.fixedStage !== false,
    resizablePresentation: parsed.resizablePresentation === true,
    customHotelView: parsed.customHotelView,
    paths: parsed.paths,
  };
}

function resolveEngineRoot(profileRoot: string): string {
  const override = process.env.HABBPY_V4_SHOCKLESS_ENGINE_ROOT;
  if (override) {
    const resolved = resolve(override);
    if (existsSync(join(resolved, "dist", "index.html"))) return resolved;
  }

  if (runningFromPackagedResources()) {
    const bundled = packagedResourcePath("engine");
    if (bundled) {
      const resolved = resolve(bundled);
      if (existsSync(join(resolved, "dist", "index.html"))) return resolved;
    }
    throw new Error("Bundled Shockless engine dist was not found in the portable resources.");
  }

  const candidates = [
    packagedResourcePath("engine"),
    ...ancestorSiblingCandidates("habbo-origins-engine"),
    ...ancestorCandidates(profileRoot, "resources", "engine"),
    resolve(process.cwd(), "..", "habbo-origins-engine"),
  ];
  const match = candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => resolve(candidate))
    .find((candidate) => existsSync(join(candidate, "dist", "index.html")));
  if (!match) throw new Error("Shockless engine dist was not found for the selected profile.");
  return match;
}

function ancestorSiblingCandidates(...parts: readonly string[]): string[] {
  const candidates = new Set<string>();
  const starts = new Set([process.cwd(), process.execPath ? dirname(process.execPath) : process.cwd()]);
  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      candidates.add(join(current, ...parts));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...candidates];
}

function resolveRelayLaunch(profileRoot: string): RelayLaunch {
  const resourceDir = resolveRelayResourceDir(profileRoot);
  const override = resolveFile(process.env.HABBPY_V4_SHOCKLESS_RELAY);
  if (override) {
    return {
      script: override,
      resourceDir,
      safeBodyLogging: Boolean(resourceDir),
    };
  }

  const wrapper = resolveFile(join(MAIN_DIR, "relay", "originsRelayV4.js"));
  if (wrapper && resourceDir) {
    return {
      script: wrapper,
      resourceDir,
      safeBodyLogging: true,
    };
  }

  const legacyScript = resourceDir ? resolveFile(join(resourceDir, "origins-relay.mjs")) : null;
  if (!legacyScript) throw new Error("Shockless relay script was not found for the selected profile.");
  return {
    script: legacyScript,
    resourceDir,
    safeBodyLogging: false,
  };
}

export function resolveRelayResourceDir(profileRoot: string): string | null {
  const overrideScript = process.env.HABBPY_V4_SHOCKLESS_RELAY;
  const explicitCandidates = [
    process.env.HABBPY_V4_SHOCKLESS_RELAY_RESOURCES,
    overrideScript ? dirname(resolve(overrideScript)) : undefined,
  ];
  const explicitMatch =
    explicitCandidates
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find((candidate) => relayResourceDirValid(candidate)) ?? null;
  if (explicitMatch) return explicitMatch;

  const bundledCandidates = [packagedResourcePath("relay"), packagedResourcePath("engine", "standalone", "resources", "relay")];
  const bundledMatch =
    bundledCandidates
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find((candidate) => relayResourceDirValid(candidate)) ?? null;
  if (runningFromPackagedResources()) return bundledMatch;

  const candidates = [
    ...bundledCandidates,
    ...ancestorCandidates(profileRoot, "resources", "relay"),
    resolve(process.cwd(), "..", "habbo-origins-engine", "standalone", "resources", "relay"),
  ];
  return (
    candidates
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find((candidate) => relayResourceDirValid(candidate)) ?? null
  );
}

function resolveFile(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const resolved = resolve(candidate);
  return existsSync(resolved) && statSync(resolved).isFile() ? resolved : null;
}

function relayResourceDirValid(candidate: string): boolean {
  return ["origins-relay.mjs", "shockwave-codec.mjs", "bobba-crypto.mjs"].every((fileName) => {
    const filePath = join(candidate, fileName);
    return existsSync(filePath) && statSync(filePath).isFile();
  });
}

function packagedResourcePath(...parts: readonly string[]): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ? join(resourcesPath, ...parts) : undefined;
}

function runningFromPackagedResources(): boolean {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return false;
  const resolved = resolve(resourcesPath);
  return (
    existsSync(join(resolved, "app", "package.json")) ||
    existsSync(join(resolved, "engine", "dist", "index.html")) ||
    existsSync(join(resolved, "engine", "standalone", "package.json"))
  );
}

function ancestorCandidates(startPath: string, ...parts: readonly string[]): string[] {
  const candidates: string[] = [];
  let current = resolve(startPath);
  while (dirname(current) !== current) {
    candidates.push(join(current, ...parts));
    current = dirname(current);
  }
  return candidates;
}

export function readShocklessSettings(appDataPath: string): ShocklessSettings {
  const settingsPath = join(appDataPath, "ShocklessEngine", "settings.json");
  if (!existsSync(settingsPath)) {
    return { activeProfileId: null, resizablePresentation: null, customHotelView: null, versionCheckBuild: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<ShocklessSettings>;
    return {
      activeProfileId: typeof parsed.activeProfileId === "string" ? parsed.activeProfileId : null,
      resizablePresentation: typeof parsed.resizablePresentation === "boolean" ? parsed.resizablePresentation : null,
      customHotelView: typeof parsed.customHotelView === "boolean" ? parsed.customHotelView : null,
      versionCheckBuild: normalizeSettingsVersionCheckBuild(parsed.versionCheckBuild),
    };
  } catch {
    return { activeProfileId: null, resizablePresentation: null, customHotelView: null, versionCheckBuild: null };
  }
}

function pendingLaunchSettings(appDataPath: string): EngineLaunchState["settings"] {
  const settings = readShocklessSettings(appDataPath);
  return {
    resizablePresentation: embeddedResizablePresentation(settings.resizablePresentation, true),
    customHotelView: settings.customHotelView === true,
    versionCheckBuild: null,
  };
}

export function writeShocklessSettings(appDataPath: string, patch: ShocklessSettingsPatch): ShocklessSettings {
  const current = readShocklessSettings(appDataPath);
  const next: ShocklessSettings = {
    activeProfileId:
      patch.activeProfileId === undefined
        ? current.activeProfileId
        : typeof patch.activeProfileId === "string" && patch.activeProfileId.trim()
          ? patch.activeProfileId.trim()
          : null,
    resizablePresentation:
      patch.resizablePresentation === undefined
        ? current.resizablePresentation
        : typeof patch.resizablePresentation === "boolean"
          ? patch.resizablePresentation
          : null,
    customHotelView:
      patch.customHotelView === undefined
        ? current.customHotelView
        : typeof patch.customHotelView === "boolean"
          ? patch.customHotelView
          : null,
    versionCheckBuild:
      patch.versionCheckBuild === undefined
        ? current.versionCheckBuild
        : patch.versionCheckBuild === null
          ? null
          : normalizeSettingsVersionCheckBuild(patch.versionCheckBuild),
  };
  const settingsPath = join(appDataPath, "ShocklessEngine", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function embeddedResizablePresentation(settingValue: boolean | null, _profileValue: boolean): boolean {
  const override = process.env.HABBPY_V4_RESIZABLE_PRESENTATION;
  if (override === "0" || override?.toLowerCase() === "false") return false;
  if (override === "1" || override?.toLowerCase() === "true") return true;
  if (process.env.HABBPY_V4_FIXED_STAGE === "1") return false;
  if (typeof settingValue === "boolean") return settingValue;
  return true;
}

function buildLabel(profile: ClientLibraryProfile, versionCheckBuild: number | null): string {
  const profileLabel = profile.buildNumber ? `Origins build ${profile.buildNumber}` : profile.versionId;
  return versionCheckBuild ? `${profileLabel} / VERSIONCHECK ${versionCheckBuild}` : `${profileLabel} / VERSIONCHECK auto`;
}

function variableKey(line: string): string | null {
  const separator = line.indexOf("=");
  return separator > 0 ? line.slice(0, separator).trim().toLowerCase() : null;
}

function valueForExternalVariable(lines: readonly string[], key: string): string | null {
  const prefix = `${key.toLowerCase()}=`;
  const line = lines.find((entry) => entry.toLowerCase().startsWith(prefix));
  return line ? line.slice(line.indexOf("=") + 1).trim() : null;
}

function setExternalVariable(lines: string[], keys: Set<string>, key: string, value: string): void {
  const normalizedKey = key.toLowerCase();
  const index = lines.findIndex((line) => variableKey(line) === normalizedKey);
  const nextLine = `${key}=${value}`;
  if (index >= 0) lines[index] = nextLine;
  else lines.push(nextLine);
  keys.add(normalizedKey);
}

function safeJoin(root: string, requestPath: string): string | null {
  const target = normalize(join(root, requestPath));
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}\\`) || resolvedTarget.startsWith(`${resolvedRoot}/`)
    ? resolvedTarget
    : null;
}

function sendFile(response: ServerResponse, filePath: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", mimeType(filePath));
  createReadStream(filePath).pipe(response);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function mimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpOpen(host, port, 250)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function isTcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSettingsVersionCheckBuild(value: unknown): number | null {
  const parsed = positiveInteger(value);
  return parsed !== null && !STALE_VERSION_CHECK_BUILDS.has(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
