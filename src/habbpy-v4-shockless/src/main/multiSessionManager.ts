import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  parseConsoleCommand,
  redactConsoleCommandInput,
  type ConsoleCommandFlag,
  type ConsoleCommandResult,
  type ConsoleRendererAction,
  type ParsedConsoleCommand,
} from "../shared/consoleCommand.js";
import { buildMimicRelayPacketFromControl } from "../shared/mimicRelayPackets.js";
import { parseMultiClientAccounts, type MultiClientAccount } from "../shared/multiClientAccounts.js";
import type { SocialRelayAction, UserRelayAction } from "../shared/window-api.js";
import type {
  ClientRelaySummary,
  ClientRuntimeSummary,
  ClientSessionList,
  ClientSessionSummary,
  ClientSnapshot,
  ClientSnapshotList,
  ConsoleCommandStateSnapshot,
  EngineLaunchState,
  GardeningRelayResult,
  MimicCategory,
  MimicStateSnapshot,
  RelayLogEntry,
  RelayLogSnapshot,
} from "../shared/window-api.js";
import { GPU_LAUNCH_SWITCHES, readAppPreferences } from "./appPreferences.js";
import { ClientLibraryStore } from "./clientLibrary.js";
import { accountStoreSummary, clearEncryptedAccountStore, readEncryptedAccountStore, writeEncryptedAccountStore } from "./encryptedAccountStore.js";
import { lookupOriginsUser } from "./originsUserLookup.js";
import { readRelayLogDeltaSnapshot, readRelayLogSnapshot } from "./relayLog.js";
import { readShocklessSettings, ShocklessEmbedController, writeShocklessSettings } from "./shocklessEmbed.js";
import { detectAcceptedVersionCheckBuild } from "./versionCheckBuild.js";
import type { PluginRelayPolicy } from "../shared/pluginRelayHooks.js";

const MAIN_CLIENT_ID = 1;
const RELAY_CONTROL_HOST = "127.0.0.1";
const MIMIC_POLL_INTERVAL_MS = 250;
const MIMIC_DUPLICATE_WINDOW_MS = 2000;
const DEFAULT_LOAD_CONCURRENCY = 3;
const MAX_LOAD_CONCURRENCY = 8;
const COMMAND_STATE_FILE = "console-state.json";
const MAX_COMMAND_HISTORY = 200;
const MAX_ALIAS_DEPTH = 8;
const MAX_EXEC_SCRIPT_LINES = 200;
const mimicCategories = ["movement", "speech", "actions", "rooms"] as const satisfies readonly MimicCategory[];
const reservedCommandNames = new Set([
  "?",
  "accept",
  "acceptfriend",
  "accounts",
  "addclient",
  "adduser",
  "alias",
  "bind",
  "bindings",
  "chat",
  "client",
  "clients",
  "close",
  "carry",
  "carrydrink",
  "dance",
  "decline",
  "declinefriend",
  "exec",
  "follow",
  "followfriend",
  "fps",
  "friend",
  "friendrequests",
  "gpu",
  "headless",
  "help",
  "hcdance",
  "history",
  "input",
  "list",
  "load",
  "load-store",
  "login",
  "lookup",
  "main",
  "message",
  "mimic",
  "msg",
  "newclient",
  "perf",
  "pm",
  "refreshrequests",
  "removefriend",
  "rename",
  "requests",
  "room",
  "say",
  "select",
  "sessions",
  "sleep",
  "launch",
  "stop",
  "stopdance",
  "stopdancing",
  "start",
  "summon",
  "summoner",
  "unbind",
  "unalias",
  "unfriend",
  "wait",
  "wave",
]);

interface ConsoleCommandState {
  readonly version: 1;
  aliases: Record<string, string>;
  bindings: Record<string, string>;
  history: string[];
}

interface ManagedClient {
  readonly id: number;
  label: string;
  username: string | null;
  status: ClientSessionSummary["status"];
  headless: boolean;
  visible: boolean;
  account?: MultiClientAccount;
  readonly embed: ShocklessEmbedController;
  hiddenWindow: BrowserWindow | null;
  lastLaunch: EngineLaunchState | null;
  runtimeSummary: ClientRuntimeSummary | null;
  lastError: string | null;
}

interface ManagerOptions {
  readonly appDataPath: string;
  readonly library: ClientLibraryStore;
  readonly hardwareAccelerationActive?: boolean;
  readonly relayPolicyProvider?: () => PluginRelayPolicy;
}

interface MimicState {
  enabled: boolean;
  sourceClientId: number;
  categories: Record<MimicCategory, boolean>;
  currentLogPath: string | null;
  afterLineNumber: number;
  readonly duplicatePackets: Map<string, { readonly bodyHex: string; readonly at: number }>;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  forwardedCount: number;
  blockedCount: number;
  lastForwardAt: string | null;
  lastError: string | null;
}

interface HiddenClientDiagnosticEvent {
  readonly at: string;
  readonly type: string;
  readonly message: string;
}

interface SummonClientsResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly rendererActions: readonly ConsoleRendererAction[];
}

interface SummonClientResult extends GardeningRelayResult {
  readonly rendererActions?: readonly ConsoleRendererAction[];
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

export class MultiSessionManager {
  private readonly clients = new Map<number, ManagedClient>();
  private readonly commandState: ConsoleCommandState;
  private selectedClientId = MAIN_CLIENT_ID;
  private mainClientId = MAIN_CLIENT_ID;
  private nextClientId = MAIN_CLIENT_ID + 1;
  private readonly mimicState: MimicState = {
    enabled: false,
    sourceClientId: MAIN_CLIENT_ID,
    categories: defaultMimicCategories(),
    currentLogPath: null,
    afterLineNumber: 0,
    duplicatePackets: new Map(),
    timer: null,
    polling: false,
    forwardedCount: 0,
    blockedCount: 0,
    lastForwardAt: null,
    lastError: null,
  };

  constructor(private readonly options: ManagerOptions) {
    this.commandState = readCommandState(options.appDataPath);
    this.clients.set(MAIN_CLIENT_ID, this.createClient(MAIN_CLIENT_ID, { label: "Main", visible: true, headless: false }));
  }

  private gpuPreferenceSnapshot(): {
    readonly hardwareAccelerationActive: boolean;
    readonly hardwareAccelerationPreference: boolean;
    readonly launchSwitches: readonly string[];
  } {
    const active = this.options.hardwareAccelerationActive !== false;
    const preference = readAppPreferences(this.options.appDataPath).hardwareAcceleration;
    return {
      hardwareAccelerationActive: active,
      hardwareAccelerationPreference: preference,
      launchSwitches: active ? GPU_LAUNCH_SWITCHES : [],
    };
  }

  engineStatus(): EngineLaunchState {
    const client = this.selectedClient() ?? this.client(MAIN_CLIENT_ID);
    if (!client) return noClientState();
    const status = client.embed.status();
    client.lastLaunch = status;
    client.status = status.status;
    client.lastError = status.status === "error" ? status.message : null;
    return client.visible ? status : { ...status, embeddedUrl: null, message: `${client.label} is running headless.` };
  }

  async startSelected(): Promise<EngineLaunchState> {
    const client = this.selectedClient() ?? this.client(MAIN_CLIENT_ID);
    if (!client) return noClientState();
    return this.startClientRuntime(client, { loadHiddenWindow: client.headless });
  }

  async repairSelectedVersionCheckBuild(): Promise<{
    readonly build: number | null;
    readonly updated: boolean;
    readonly tried: readonly number[];
    readonly error?: string;
  }> {
    const profile = this.options.library.selectedProfile();
    if (!profile?.ready || !profile.profileRoot) return { build: null, updated: false, tried: [] };
    const settings = readShocklessSettings(this.options.appDataPath);
    const settingBuild = settings.activeProfileId === profile.id ? settings.versionCheckBuild : null;
    const detected = await detectAcceptedVersionCheckBuild({
      profileRoot: profile.profileRoot,
      preferredBuilds: [settingBuild, profile.versionCheckBuild],
    });
    if (!detected.build) {
      return {
        build: settingBuild ?? profile.versionCheckBuild,
        updated: false,
        tried: detected.tried,
        ...(detected.error ? { error: detected.error } : {}),
      };
    }

    let updated = false;
    let error: string | undefined;
    if (settingBuild !== null && settingBuild !== detected.build) {
      try {
        writeShocklessSettings(this.options.appDataPath, {
          activeProfileId: profile.id,
          versionCheckBuild: detected.build,
        });
        updated = true;
      } catch (writeError) {
        error = errorMessage(writeError);
        console.warn(`[habbpy-v4] failed to persist detected VERSIONCHECK setting ${detected.build}: ${error}`);
      }
    }

    if (detected.build === profile.versionCheckBuild) {
      return { build: detected.build, updated, tried: detected.tried, ...(error ? { error } : {}) };
    }

    const profilePath = join(profile.profileRoot, "profile.json");
    try {
      const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
      parsed.versionCheckBuild = detected.build;
      writeFileSync(profilePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      return { build: detected.build, updated: true, tried: detected.tried, ...(error ? { error } : {}) };
    } catch (profileError) {
      const message = errorMessage(profileError);
      console.warn(`[habbpy-v4] failed to persist detected VERSIONCHECK build ${detected.build}: ${message}`);
      return { build: detected.build, updated: false, tried: detected.tried, error: message };
    }
  }

  stopSelected(): EngineLaunchState {
    const client = this.selectedClient() ?? this.client(MAIN_CLIENT_ID);
    if (!client) return noClientState();
    this.stopClient(client);
    return this.engineStatus();
  }

  async submitVisibleClientLogin(clientId: number, contents: WebContents): Promise<GardeningRelayResult> {
    const client = this.client(clientId);
    if (!client) return { ok: false, message: `Client ${clientId} is not running yet.` };
    if (client.headless || !client.visible) return { ok: false, message: `client${clientId} is not a visible session.` };
    if (!client.account) return { ok: false, message: `client${clientId} has no stored login credentials.` };
    if (contents.isDestroyed()) return { ok: false, message: `client${clientId} visible webview is not available.` };
    try {
      await submitEngineLoginInWebContents(contents, client.account.email, client.account.password, 60000);
      client.username = client.account.label;
      return { ok: true, message: `client${clientId} login submitted through source dev.login.` };
    } catch (error) {
      return { ok: false, message: `client${clientId} visible login failed: ${maskDiagnosticText(errorMessage(error))}` };
    }
  }

  dispose(): void {
    this.stopMimicPoller();
    for (const client of this.clients.values()) this.stopClient(client, { destroyWindow: true });
    this.clients.clear();
  }

  relayControlPortForClient(clientId: number): number | null {
    const client = this.client(clientId);
    if (!client || client.embed.status().status !== "running") return null;
    return client.embed.relayControlPort();
  }

  sessions(message = "Multi-session manager ready."): ClientSessionList {
    return {
      selectedClientId: this.selectedClientId,
      mainClientId: this.mainClientId,
      sessions: [...this.clients.values()].sort((a, b) => a.id - b.id).map((client) => this.sessionSummary(client)),
      message,
    };
  }

  async clientSnapshot(clientId = this.selectedClientId): Promise<ClientSnapshot> {
    const client = this.client(clientId);
    if (!client) {
      return {
        selectedClientId: this.selectedClientId,
        mainClientId: this.mainClientId,
        client: null,
        runtime: null,
        relay: null,
        message: `Client ${clientId} is not running yet.`,
      };
    }
    await this.refreshClientRuntimeSummary(client);
    return {
      selectedClientId: this.selectedClientId,
      mainClientId: this.mainClientId,
      client: this.sessionSummary(client),
      runtime: client.runtimeSummary,
      relay: this.clientRelaySummary(client.id),
      message: `client${client.id} snapshot ready.`,
    };
  }

  async clientSnapshots(): Promise<ClientSnapshotList> {
    const clients = [...this.clients.values()].sort((a, b) => a.id - b.id);
    await Promise.all(clients.map((client) => this.refreshClientRuntimeSummary(client)));
    const relaySnapshot = readRelayLogSnapshot(this.options.appDataPath, this.relayLogClients());
    return {
      selectedClientId: this.selectedClientId,
      mainClientId: this.mainClientId,
      clients: clients.map((client) => ({
        selectedClientId: this.selectedClientId,
        mainClientId: this.mainClientId,
        client: this.sessionSummary(client),
        runtime: client.runtimeSummary,
        relay: this.clientRelaySummary(client.id, relaySnapshot),
        message: `client${client.id} snapshot ready.`,
      })),
      message: `Collected ${clients.length} client snapshot(s).`,
    };
  }

  async captureAutomationScreenshots(label = "automation"): Promise<
    readonly {
      readonly clientId: number;
      readonly label: string;
      readonly ok: boolean;
      readonly path: string | null;
      readonly width?: number;
      readonly height?: number;
      readonly message: string;
    }[]
  > {
    const screenshotDir = join(process.cwd(), "screenshots", "automation");
    mkdirSync(screenshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "automation";
    const results = [];
    for (const client of [...this.clients.values()].sort((a, b) => a.id - b.id)) {
      const hiddenWindow = client.hiddenWindow;
      if (!hiddenWindow || hiddenWindow.isDestroyed()) continue;
      try {
        const image = await hiddenWindow.webContents.capturePage();
        const size = image.getSize();
        const screenshotPath = join(screenshotDir, `client-${client.id}-${safeLabel}-${stamp}.png`);
        writeFileSync(screenshotPath, image.toPNG());
        results.push({
          clientId: client.id,
          label: client.label,
          ok: true,
          path: screenshotPath,
          width: size.width,
          height: size.height,
          message: `Captured client${client.id} hidden runtime.`,
        });
      } catch (error) {
        results.push({
          clientId: client.id,
          label: client.label,
          ok: false,
          path: null,
          message: errorMessage(error),
        });
      }
    }
    return results;
  }

  selectClient(clientId: number): ClientSessionList {
    if (!this.clients.has(clientId)) return this.sessions(`Client ${clientId} is not running yet.`);
    this.selectedClientId = clientId;
    return this.sessions(`Selected client${clientId}.`);
  }

  renameClient(clientId: number, label: string): ClientSessionList {
    const cleanLabel = label.trim().slice(0, 32);
    const client = this.client(clientId);
    if (!client) return this.sessions(`Client ${clientId} is not running yet.`);
    if (!cleanLabel) return this.sessions("Session label cannot be empty.");
    client.label = cleanLabel;
    return this.sessions(`Renamed client${clientId} to ${cleanLabel}.`);
  }

  async runConsoleCommand(input: string): Promise<ConsoleCommandResult> {
    return this.runConsoleCommandInternal(input, { depth: 0, recordHistory: true });
  }

  consoleCommandState(): ConsoleCommandStateSnapshot {
    return {
      aliases: Object.entries(this.commandState.aliases)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, expansion]) => ({ name, expansion })),
      bindings: Object.entries(this.commandState.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, command]) => ({ key, command })),
      history: [...this.commandState.history],
    };
  }

  mimicStateSnapshot(): MimicStateSnapshot {
    return {
      enabled: this.mimicState.enabled,
      sourceClientId: this.mimicState.sourceClientId,
      targetClientIds: this.mimicTargetClients().map((client) => client.id),
      categories: { ...this.mimicState.categories },
      polling: this.mimicState.polling,
      forwardedCount: this.mimicState.forwardedCount,
      blockedCount: this.mimicState.blockedCount,
      lastForwardAt: this.mimicState.lastForwardAt,
      lastError: this.mimicState.lastError,
    };
  }

  async runConsoleBinding(key: string): Promise<ConsoleCommandResult> {
    const normalizedKey = normalizeBindingKey(key);
    const command = normalizedKey ? this.commandState.bindings[normalizedKey] : undefined;
    if (!normalizedKey || !command) return handled(false, "warning", [`No console binding for ${key || "-"}.`]);
    return this.runConsoleCommandInternal(command, { depth: 0, recordHistory: true, sourceLabel: `binding ${normalizedKey}` });
  }

  private async runConsoleCommandInternal(
    input: string,
    options: { readonly depth: number; readonly recordHistory: boolean; readonly sourceLabel?: string },
  ): Promise<ConsoleCommandResult> {
    const rawInput = String(input ?? "");
    if (options.recordHistory) this.recordCommandHistory(rawInput);

    const aliasExpansion = this.expandAliasInput(rawInput, options.depth);
    if (!aliasExpansion.ok) return handled(false, "warning", [aliasExpansion.message]);
    if (aliasExpansion.input !== rawInput) {
      const result = await this.runConsoleCommandInternal(aliasExpansion.input, {
        depth: options.depth + 1,
        recordHistory: false,
        sourceLabel: options.sourceLabel,
      });
      return {
        ...result,
        lines: [`alias ${aliasExpansion.name} -> ${aliasExpansion.expansion}`, ...result.lines],
      };
    }

    const parsed = parseConsoleCommand(rawInput);
    if (!parsed.ok) return handled(false, "warning", [parsed.message]);
    const command = parsed.command;
    const target = this.resolveTargets(command);
    if (!target.ok) return handled(false, "warning", [target.message], command);

    switch (command.command) {
      case "help":
      case "?":
        return handled(true, "info", [managerHelpLine()], command, target.clientIds);
      case "list":
      case "clients":
      case "sessions":
        await this.refreshClientRuntimeSummaries();
        return handled(true, "info", this.sessions().sessions.map((session) => sessionLine(session)), command, target.clientIds);
      case "select":
      case "client": {
        const clientId = positiveInteger(command.args[0]) ?? this.findClientIdByLabel(command.args[0]) ?? target.clientIds[0] ?? this.selectedClientId;
        const selected = this.selectClient(clientId);
        return handled(selected.selectedClientId === clientId, selected.selectedClientId === clientId ? "success" : "warning", [selected.message], command, [selected.selectedClientId]);
      }
      case "rename": {
        const clientId = positiveInteger(command.args[0]) ?? target.clientIds[0] ?? this.selectedClientId;
        const label = command.args.slice(positiveInteger(command.args[0]) ? 1 : 0).join(" ").trim();
        if (!label) return handled(false, "warning", ["usage: rename <id> <label>"], command, target.clientIds);
        const renamed = this.renameClient(clientId, label);
        return handled(renamed.sessions.some((session) => session.id === clientId && session.label === label.slice(0, 32)), "success", [renamed.message], command, [clientId]);
      }
      case "main":
      case "summoner": {
        const clientArg = command.args[command.command === "summoner" && command.args[0] === "set" ? 1 : 0];
        const clientId = positiveInteger(clientArg) ?? this.findClientIdByLabel(clientArg) ?? target.clientIds[0] ?? this.selectedClientId;
        if (!this.clients.has(clientId)) return handled(false, "warning", [`Client ${clientId} is not running yet.`], command, target.clientIds);
        this.mainClientId = clientId;
        return handled(true, "success", [`client${clientId} is now the main/summoner client.`], command, [clientId]);
      }
      case "login":
        return this.commandLogin(command);
      case "load":
        return this.commandLoad(command);
      case "accounts":
        return this.commandAccounts(command);
      case "load-store":
        return this.commandLoadEncryptedStore(command);
      case "addclient":
      case "newclient":
        return this.commandNewClient(command);
      case "input":
        return this.commandInput(command, target.clientIds);
      case "say":
      case "chat":
        return this.hiddenRuntimeCommand(command, target.clientIds, (client) =>
          execEngine(client, (text) => `window.__engine?.dev?.sendChat?.(${JSON.stringify(text)}, 0)`, consoleArgsText(command)),
        );
      case "wave":
        return this.commandUserRelay(command, target.clientIds, { action: "wave" }, "Wave");
      case "dance": {
        const number = positiveInteger(command.args[0]) ?? 1;
        return this.commandUserRelay(command, target.clientIds, { action: "dance", number }, `Dance ${number}`);
      }
      case "stopdance":
      case "stopdancing":
        return this.commandUserRelay(command, target.clientIds, { action: "stopDance" }, "Stop dance");
      case "hcdance": {
        const number = positiveInteger(command.args[0]) ?? 2;
        return this.commandUserRelay(command, target.clientIds, { action: "hcdance", number }, `HC dance ${number}`);
      }
      case "carry":
      case "carrydrink":
        return this.commandUserRelay(command, target.clientIds, { action: "carryDrink" }, "Carry drink");
      case "walk": {
        const x = nonNegativeInteger(command.args[0]);
        const y = nonNegativeInteger(command.args[1]);
        if (x === null || y === null) return handled(false, "warning", ["usage: walk <x> <y> [furni-id]"], command, target.clientIds);
        const furniId = nonNegativeInteger(command.args[2]) ?? 0;
        return this.commandRoomRelay(command, target.clientIds, { action: "move", x, y, furniId }, `Walk ${x},${y}`);
      }
      case "room":
        return this.hiddenRuntimeCommand(command, target.clientIds, (client) =>
          execEngine(client, () => "window.__engine?.dev?.roomReady?.() ?? null"),
        );
      case "enterroom":
      case "private":
      case "goto":
      case "flat":
        return this.commandEnterPrivateRoom(command, target.clientIds);
      case "fps":
      case "perf":
        return this.hiddenRuntimeCommand(command, target.clientIds, (client) =>
          execEngine(client, () => "window.__engine?.dev?.performanceStats?.() ?? null"),
        );
      case "gpu":
        return this.hiddenRuntimeCommand(command, target.clientIds, (client) =>
          execEngine(client, () => gpuCapabilityScript(this.gpuPreferenceSnapshot())),
        );
      case "mimic":
        return this.commandMimic(command, target.clientIds);
      case "summon":
        return this.commandSummon(command, target.clientIds);
      case "wait":
      case "sleep":
        return this.commandWait(command, target.clientIds);
      case "lookup":
        return this.commandLookup(command, target.clientIds);
      case "requests":
      case "friendrequests":
      case "refreshrequests":
        return this.commandSocialRelay(command, target.clientIds, { action: "refreshFriendRequests" }, "Refresh friend requests");
      case "start":
      case "launch":
        return this.commandStart(command, target.clientIds);
      case "message":
      case "msg":
      case "pm":
        return this.commandMessage(command, target.clientIds);
      case "adduser":
      case "friend": {
        const name = consoleArgsText(command).trim();
        return name
          ? this.commandSocialRelay(command, target.clientIds, { action: "addUser", name }, `Friend request ${name}`)
          : handled(false, "warning", ["usage: adduser <habbo-name>"], command, target.clientIds);
      }
      case "accept":
      case "acceptfriend":
        return this.commandFriendLifecycle(command, target.clientIds, "acceptRequest", "accept");
      case "decline":
      case "declinefriend":
        return this.commandFriendLifecycle(command, target.clientIds, "declineRequest", "decline");
      case "follow":
      case "followfriend":
        return this.commandFriendLifecycle(command, target.clientIds, "followFriend", "follow");
      case "removefriend":
      case "unfriend":
        return this.commandFriendLifecycle(command, target.clientIds, "removeFriend", "remove");
      case "stop":
      case "close": {
        const closeAll = command.args[0]?.toLowerCase() === "all" || command.target.kind === "all";
        const explicitClientId = positiveInteger(command.args[0]) ?? this.findClientIdByLabel(command.args[0]);
        const ids = closeAll ? [...this.clients.keys()] : explicitClientId ? [explicitClientId] : target.clientIds;
        if (!ids.every((id) => this.clients.has(id))) return handled(false, "warning", ["One or more targeted clients are not running yet."], command, ids);
        for (const clientId of ids) {
          const client = this.client(clientId);
          if (!client) continue;
          if (client.id === this.mainClientId && closeAll && flagEnabled(command, "keep-main")) continue;
          this.stopClient(client);
          if (client.id !== MAIN_CLIENT_ID) this.clients.delete(client.id);
        }
        if (!this.clients.has(this.selectedClientId)) this.selectedClientId = MAIN_CLIENT_ID;
        return handled(true, "success", [closeAll ? "Stopped all targeted clients." : `Stopped ${ids.map((id) => `client${id}`).join(", ")}.`], command, ids);
      }
      case "alias":
        return this.commandAlias(command, target.clientIds);
      case "unalias":
        return this.commandUnalias(command, target.clientIds);
      case "bind":
        return this.commandBind(command, target.clientIds);
      case "unbind":
        return this.commandUnbind(command, target.clientIds);
      case "bindings":
        return this.commandBindings(command, target.clientIds);
      case "history":
        return this.commandHistory(command, target.clientIds);
      case "exec":
        return this.commandExec(command, target.clientIds, options.depth);
      default:
        return {
          ok: true,
          handled: false,
          level: "info",
          lines: [],
          passthroughInput: command.inputWithoutTarget,
          command,
          targetClientIds: target.clientIds,
        };
    }
  }

  private async commandStart(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const ids = [...new Set(targetClientIds)];
    if (!ids.every((id) => this.clients.has(id))) {
      return handled(false, "warning", ["One or more targeted clients are not running yet."], command, ids);
    }

    const lines: string[] = [];
    let allRunning = true;
    for (const clientId of ids) {
      const client = this.client(clientId);
      if (!client) continue;
      const launch = await this.startClientRuntime(client, { loadHiddenWindow: client.headless });
      if (launch.status === "running") {
        const mode = client.headless ? "headless" : "visible";
        const urlText = launch.embeddedUrl && client.visible ? ` / ${launch.embeddedUrl}` : "";
        lines.push(`client${client.id}: running ${mode} ${launch.buildLabel}${urlText}`);
      } else {
        allRunning = false;
        lines.push(`client${client.id}: ${launch.status} - ${launch.message}`);
      }
    }

    return handled(allRunning, allRunning ? "success" : "warning", lines, command, ids);
  }

  private async commandNewClient(command: ParsedConsoleCommand): Promise<ConsoleCommandResult> {
    if (flagEnabled(command, "headless")) {
      return handled(
        false,
        "warning",
        ["Manual blank clients must be visible. Use login/load/accounts load for headless clients so credentials can be submitted."],
        command,
      );
    }
    const selectedProfile = this.options.library.selectedProfile();
    if (!selectedProfile?.ready) {
      return handled(false, "warning", [`No ready profile selected. ${selectedProfile?.reason ?? "Import/build a client first."}`], command);
    }
    const label = flagValue(command, "label") ?? `Manual ${this.nextClientId}`;
    const client = await this.addClient({ label, headless: false, visible: true });
    if (client.status !== "running") {
      this.stopClient(client, { destroyWindow: true });
      this.clients.delete(client.id);
      return handled(
        false,
        "warning",
        [`client${client.id}: ${client.status} - ${client.lastError ?? "Could not start visible runtime."}`],
        command,
        [client.id],
      );
    }
    this.selectedClientId = client.id;
    return handled(
      true,
      "success",
      [`Started client${client.id} ${client.label} [VISIBLE] for manual login. The session is selected and ready to mount.`],
      command,
      [client.id],
    );
  }

  private commandAlias(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const name = normalizeAliasName(command.args[0] ?? "");
    if (!name) {
      const lines = Object.entries(this.commandState.aliases)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([aliasName, expansion]) => `${aliasName} = ${expansion}`);
      return handled(true, "info", lines.length > 0 ? lines : ["No aliases configured."], command, targetClientIds);
    }
    if (!validAliasName(name)) return handled(false, "warning", ["usage: alias <name> <command>; names may use letters, numbers, _ and -"], command, targetClientIds);
    if (reservedCommandNames.has(name)) return handled(false, "warning", [`${name} is a built-in command and cannot be replaced with an alias.`], command, targetClientIds);

    const expansion = command.args.slice(1).join(" ").trim();
    if (!expansion) {
      const existing = this.commandState.aliases[name];
      return existing
        ? handled(true, "info", [`${name} = ${existing}`], command, targetClientIds)
        : handled(false, "warning", [`Alias not found: ${name}`], command, targetClientIds);
    }
    const parsedExpansion = parseConsoleCommand(expansion);
    if (!parsedExpansion.ok) return handled(false, "warning", [`Alias expansion is not a valid command: ${parsedExpansion.message}`], command, targetClientIds);
    if (parsedExpansion.command.command === name) return handled(false, "warning", [`Alias ${name} cannot expand to itself.`], command, targetClientIds);
    this.commandState.aliases[name] = expansion;
    this.saveCommandState();
    return handled(true, "success", [`alias ${name} = ${expansion}`], command, targetClientIds);
  }

  private commandUnalias(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const name = normalizeAliasName(command.args[0] ?? "");
    if (!name) return handled(false, "warning", ["usage: unalias <name>"], command, targetClientIds);
    if (!this.commandState.aliases[name]) return handled(false, "warning", [`Alias not found: ${name}`], command, targetClientIds);
    delete this.commandState.aliases[name];
    this.saveCommandState();
    return handled(true, "success", [`removed alias ${name}`], command, targetClientIds);
  }

  private commandBind(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const key = normalizeBindingKey(command.args[0] ?? "");
    const expansion = command.args.slice(1).join(" ").trim();
    if (!key || !expansion) return handled(false, "warning", ["usage: bind <key> <command>"], command, targetClientIds);
    if (key === "Backquote") return handled(false, "warning", ["Backquote is reserved for toggling the console."], command, targetClientIds);
    const parsedExpansion = parseConsoleCommand(expansion);
    if (!parsedExpansion.ok) return handled(false, "warning", [`Binding command is not valid: ${parsedExpansion.message}`], command, targetClientIds);
    if (isDangerousBindingCommand(parsedExpansion.command) && !flagEnabled(parsedExpansion.command, "force")) {
      return handled(false, "warning", [`Refusing dangerous binding "${expansion}" without --force.`], command, targetClientIds);
    }
    this.commandState.bindings[key] = expansion;
    this.saveCommandState();
    return handled(true, "success", [`bound ${key} -> ${expansion}`], command, targetClientIds);
  }

  private commandUnbind(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const key = normalizeBindingKey(command.args[0] ?? "");
    if (!key) return handled(false, "warning", ["usage: unbind <key>"], command, targetClientIds);
    if (!this.commandState.bindings[key]) return handled(false, "warning", [`No binding for ${key}.`], command, targetClientIds);
    delete this.commandState.bindings[key];
    this.saveCommandState();
    return handled(true, "success", [`removed binding ${key}`], command, targetClientIds);
  }

  private commandBindings(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const lines = Object.entries(this.commandState.bindings)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, boundCommand]) => `${key} -> ${boundCommand}`);
    return handled(true, "info", lines.length > 0 ? lines : ["No bindings configured."], command, targetClientIds);
  }

  private commandHistory(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const count = Math.min(MAX_COMMAND_HISTORY, positiveInteger(command.args[0]) ?? 20);
    const history = this.commandState.history.slice(-count);
    const offset = this.commandState.history.length - history.length;
    const lines = history.map((entry, index) => `${offset + index + 1}: ${entry}`);
    return handled(true, "info", lines.length > 0 ? lines : ["History is empty."], command, targetClientIds);
  }

  private async commandExec(command: ParsedConsoleCommand, targetClientIds: readonly number[], depth: number): Promise<ConsoleCommandResult> {
    const fileArg = command.args[0];
    if (!fileArg) return handled(false, "warning", ["usage: exec <script-file>"], command, targetClientIds);
    if (depth >= MAX_ALIAS_DEPTH) return handled(false, "warning", ["Script/alias recursion limit reached."], command, targetClientIds);
    const filePath = resolve(process.cwd(), fileArg);
    if (!existsSync(filePath)) return handled(false, "warning", [`Script file not found: ${fileArg}`], command, targetClientIds);
    const scriptLines = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(({ line }) => line && !line.startsWith("#"));
    if (scriptLines.length > MAX_EXEC_SCRIPT_LINES) {
      return handled(false, "warning", [`Script has ${scriptLines.length} executable lines; limit is ${MAX_EXEC_SCRIPT_LINES}.`], command, targetClientIds);
    }

    if (flagEnabled(command, "dry-run")) {
      return this.commandExecDryRun(command, targetClientIds, fileArg, scriptLines, depth);
    }

    const lines: string[] = [`exec ${fileArg}: ${scriptLines.length} command(s)`];
    let ok = true;
    for (const entry of scriptLines) {
      const result = await this.runConsoleCommandInternal(entry.line, { depth: depth + 1, recordHistory: false, sourceLabel: `exec ${fileArg}` });
      ok &&= result.ok;
      lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [${result.level}]`);
      lines.push(...result.lines.map((line) => `  ${line}`));
    }
    return handled(ok, ok ? "success" : "warning", lines, command, targetClientIds);
  }

  private commandExecDryRun(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    fileArg: string,
    scriptLines: readonly { readonly index: number; readonly line: string }[],
    depth: number,
  ): ConsoleCommandResult {
    const dryRunAliases = { ...this.commandState.aliases };
    const lines: string[] = [`exec ${fileArg}: ${scriptLines.length} command(s) [dry-run]`];
    let ok = true;
    for (const entry of scriptLines) {
      const expanded = this.expandAliasForDryRun(entry.line, depth + 1, dryRunAliases);
      if (!expanded.ok) {
        ok = false;
        lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [dry-run error] ${expanded.message}`);
        continue;
      }
      const parsed = parseConsoleCommand(expanded.input);
      if (!parsed.ok) {
        ok = false;
        lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [dry-run error] ${parsed.message}`);
        continue;
      }
      const target = this.resolveTargets(parsed.command);
      if (!target.ok) {
        ok = false;
        lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [dry-run warning] ${target.message}`);
        continue;
      }
      const aliasMutation = applyDryRunAliasMutation(parsed.command, dryRunAliases);
      if (!aliasMutation.ok) {
        ok = false;
        lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [dry-run warning] ${aliasMutation.message}`);
        continue;
      }
      const aliasNote = expanded.notes.length > 0 ? ` (${expanded.notes.join(", ")})` : "";
      lines.push(`${entry.index}> ${redactConsoleCommandInput(entry.line)} [dry-run ok] ${parsed.command.command} -> ${target.clientIds.map((id) => `client${id}`).join(", ")}${aliasNote}`);
    }
    return handled(ok, ok ? "info" : "warning", lines, command, targetClientIds);
  }

  private expandAliasForDryRun(
    input: string,
    depth: number,
    aliases: Record<string, string>,
  ): { readonly ok: true; readonly input: string; readonly notes: readonly string[] } | { readonly ok: false; readonly message: string } {
    let current = input;
    const notes: string[] = [];
    for (let currentDepth = depth; currentDepth < MAX_ALIAS_DEPTH; currentDepth += 1) {
      const expanded = this.expandAliasInput(current, currentDepth, aliases);
      if (!expanded.ok) return expanded;
      if (expanded.input === current) return { ok: true, input: current, notes };
      if (expanded.name && expanded.expansion) notes.push(`alias ${expanded.name} -> ${expanded.expansion}`);
      current = expanded.input;
    }
    return { ok: false, message: "Alias recursion limit reached." };
  }

  private expandAliasInput(input: string, depth: number, aliases: Record<string, string> = this.commandState.aliases): { readonly ok: true; readonly input: string; readonly name?: string; readonly expansion?: string } | { readonly ok: false; readonly message: string } {
    if (depth >= MAX_ALIAS_DEPTH) return { ok: false, message: "Alias recursion limit reached." };
    const parsed = parseConsoleCommand(input);
    if (!parsed.ok) return { ok: true, input };
    const command = parsed.command;
    const expansion = aliases[command.command];
    if (!expansion) return { ok: true, input };
    const targetPrefix = command.target.raw && !expansion.trim().startsWith("@") ? `@${command.target.raw} ` : "";
    const tail = commandTailText(command);
    return {
      ok: true,
      input: `${targetPrefix}${expansion}${tail ? ` ${tail}` : ""}`,
      name: command.command,
      expansion,
    };
  }

  private recordCommandHistory(input: string): void {
    const redacted = redactConsoleCommandInput(String(input ?? "").trim());
    if (!redacted) return;
    if (this.commandState.history[this.commandState.history.length - 1] === redacted) return;
    this.commandState.history.push(redacted);
    if (this.commandState.history.length > MAX_COMMAND_HISTORY) {
      this.commandState.history = this.commandState.history.slice(-MAX_COMMAND_HISTORY);
    }
    this.saveCommandState();
  }

  private saveCommandState(): void {
    saveCommandState(this.options.appDataPath, this.commandState);
  }

  private async commandLogin(command: ParsedConsoleCommand): Promise<ConsoleCommandResult> {
    const account = accountFromLoginArg(command.args[0], command.args[1]);
    if (!account) return handled(false, "warning", ["usage: login <email:password> [--headless] [--label <name>]"], command);
    const label = flagValue(command, "label") ?? account.label;
    await this.refreshClientRuntimeSummaries();
    const activeNames = this.activeAccountNames();
    for (const value of [...flagValues(command, "main-name"), ...flagValues(command, "active-name")]) {
      const key = accountNameKey(value);
      if (key) activeNames.add(key);
    }
    const loginKey = accountNameKey(label);
    if (loginKey && activeNames.has(loginKey)) {
      return handled(true, "warning", [`Skipped duplicate active account: ${label}. No new client was started.`], command, []);
    }
    const client = await this.addClient({ account, label, headless: flagEnabled(command, "headless"), visible: !flagEnabled(command, "headless") });
    const ok = client.status !== "error";
    return handled(
      ok,
      ok ? "success" : "warning",
      [
        ok
          ? client.headless
            ? `Started client${client.id} ${client.label} [HEADLESS]; login submitted through source dev.login.`
            : `Started client${client.id} ${client.label} [VISIBLE]; select it to mount the visible runtime and submit login.`
          : `client${client.id} ${client.label} ${client.headless ? "[HEADLESS]" : "[VISIBLE]"} failed: ${client.lastError ?? "unknown error"}`,
      ],
      command,
      [client.id],
    );
  }

  private async commandLoad(command: ParsedConsoleCommand): Promise<ConsoleCommandResult> {
    const fileArg = command.args[0];
    const count = positiveInteger(command.args[1]) ?? 1;
    if (!fileArg) return handled(false, "warning", ["usage: load <file> <count> [--headless] [--summon]"], command);
    const filePath = resolve(process.cwd(), fileArg);
    if (!existsSync(filePath)) return handled(false, "warning", [`Account file not found: ${fileArg}`], command);
    const parsed = parseMultiClientAccounts(readFileSync(filePath, "utf8"));
    const accounts = parsed.accounts.slice(0, count);
    if (accounts.length === 0) return handled(false, "warning", ["No valid account blocks found in account file."], command);
    return this.startClientsFromAccounts(command, accounts, {
      sourceLabel: fileArg,
      warnings: parsed.warnings,
      preface: "Plaintext account file warning: the file is read for local runtime login only; passwords stay in memory and are not persisted by Habbpy v4.",
    });
  }

  private async commandAccounts(command: ParsedConsoleCommand): Promise<ConsoleCommandResult> {
    const action = (command.args[0] ?? "").toLowerCase();
    if (!action) {
      const summary = accountStoreSummary(this.options.appDataPath);
      return handled(
        true,
        "info",
        [
          "usage: accounts import <file> --key-env <ENV_NAME> | accounts list --key-env <ENV_NAME> | accounts load <count> --key-env <ENV_NAME> [--headless] | accounts clear",
          `encrypted store: ${summary.exists ? `${summary.accountCount} account(s), updated ${summary.updatedAt ?? "-"}` : "not imported"}`,
        ],
        command,
      );
    }
    if (action === "clear") {
      const removed = clearEncryptedAccountStore(this.options.appDataPath);
      return handled(true, "success", [removed ? "Encrypted account store removed." : "Encrypted account store was already empty."], command);
    }

    const keyResult = accountStoreKeyFromEnv(command);
    if (!keyResult.ok) return handled(false, "warning", [keyResult.message], command);

    if (action === "import") {
      const fileArg = command.args[1];
      if (!fileArg) return handled(false, "warning", ["usage: accounts import <file> --key-env <ENV_NAME>"], command);
      const filePath = resolve(process.cwd(), fileArg);
      if (!existsSync(filePath)) return handled(false, "warning", [`Account file not found: ${fileArg}`], command);
      const parsed = parseMultiClientAccounts(readFileSync(filePath, "utf8"));
      if (parsed.accounts.length === 0) return handled(false, "warning", ["No valid account blocks found in account file."], command);
      let summary: ReturnType<typeof writeEncryptedAccountStore>;
      try {
        summary = writeEncryptedAccountStore(this.options.appDataPath, keyResult.key, parsed.accounts, { sourcePath: filePath });
      } catch (error) {
        return handled(false, "warning", [errorMessage(error)], command);
      }
      return handled(
        true,
        "success",
        [
          `Imported ${summary.accountCount} account(s) into encrypted account store.`,
          `Store: ${summary.path}`,
          `Labels: ${summary.labels.join(", ") || "-"}`,
          "Credentials are encrypted at rest and are never printed by account commands.",
          ...parsed.warnings,
        ],
        command,
      );
    }

    if (action === "list") {
      const summary = accountStoreSummary(this.options.appDataPath);
      if (!summary.exists) return handled(false, "warning", ["Encrypted account store has not been imported yet."], command);
      let accounts: readonly MultiClientAccount[];
      try {
        accounts = readEncryptedAccountStore(this.options.appDataPath, keyResult.key);
      } catch (error) {
        return handled(false, "warning", [errorMessage(error)], command);
      }
      return handled(
        true,
        "info",
        [
          `Encrypted account store: ${accounts.length} account(s)`,
          `Updated: ${summary.updatedAt ?? "-"}`,
          `Source: ${summary.sourceLabel ?? "-"}`,
          ...accounts.map((account, index) => `${index + 1}: ${account.label}`),
        ],
        command,
      );
    }

    if (action === "load") {
      return this.commandLoadEncryptedStore(command);
    }

    return handled(false, "warning", ["usage: accounts import|list|load|clear"], command);
  }

  private async commandLoadEncryptedStore(command: ParsedConsoleCommand): Promise<ConsoleCommandResult> {
    const countArg = command.command === "load-store" ? command.args[0] : command.args[1];
    const count = positiveInteger(countArg) ?? 1;
    const keyResult = accountStoreKeyFromEnv(command);
    if (!keyResult.ok) return handled(false, "warning", [keyResult.message], command);
    let accounts: readonly MultiClientAccount[];
    try {
      accounts = readEncryptedAccountStore(this.options.appDataPath, keyResult.key).slice(0, count);
    } catch (error) {
      return handled(false, "warning", [errorMessage(error)], command);
    }
    if (accounts.length === 0) return handled(false, "warning", ["Encrypted account store has no accounts to load."], command);
    return this.startClientsFromAccounts(command, accounts, {
      sourceLabel: "encrypted account store",
      warnings: [],
      preface: "Encrypted account store load: credentials were decrypted in memory only and not printed.",
    });
  }

  private async startClientsFromAccounts(
    command: ParsedConsoleCommand,
    accounts: readonly MultiClientAccount[],
    options: { readonly sourceLabel: string; readonly warnings: readonly string[]; readonly preface: string },
  ): Promise<ConsoleCommandResult> {
    const concurrency = Math.min(MAX_LOAD_CONCURRENCY, positiveInteger(flagValue(command, "concurrency")) ?? DEFAULT_LOAD_CONCURRENCY);
    await this.refreshClientRuntimeSummaries();
    const activeNames = this.activeAccountNames();
    for (const value of [...flagValues(command, "main-name"), ...flagValues(command, "active-name")]) {
      const key = accountNameKey(value);
      if (key) activeNames.add(key);
    }
    const skipped: string[] = [];
    const accountsToStart: MultiClientAccount[] = [];
    for (const account of accounts) {
      const key = accountNameKey(account.label);
      if (key && activeNames.has(key)) {
        skipped.push(account.label);
        continue;
      }
      accountsToStart.push(account);
      if (key) activeNames.add(key);
    }
    if (accountsToStart.length === 0) {
      return handled(
        skipped.length > 0,
        "warning",
        [
          options.preface,
          `Skipped ${skipped.length} duplicate account(s) already active: ${skipped.join(", ")}`,
          "No new clients were started.",
          ...options.warnings,
        ],
        command,
        [],
      );
    }
    const started = await mapWithConcurrency(accountsToStart, concurrency, (account) =>
      this.addClient({
        account,
        label: account.label,
        headless: flagEnabled(command, "headless"),
        visible: !flagEnabled(command, "headless"),
      }),
    );
    const ok = started.every((client) => client.status === "running");
    const summonLines: string[] = [];
    const summonRendererActions: ConsoleRendererAction[] = [];
    let summonOk = true;
    if (flagEnabled(command, "summon")) {
      const summon = await this.summonClients(command, started.map((client) => client.id));
      summonOk = summon.ok;
      summonLines.push(...summon.lines);
      summonRendererActions.push(...summon.rendererActions);
    }
    const lines = [
      options.preface,
      `Started ${started.length} client(s) from ${options.sourceLabel} with concurrency ${concurrency}, without printing credentials.`,
      skipped.length > 0 ? `Skipped ${skipped.length} duplicate active account(s): ${skipped.join(", ")}` : "",
      ...started.map((client) =>
        `client${client.id}: ${client.label} ${client.headless ? "[HEADLESS]" : "[VISIBLE]"} ${client.status}${client.lastError ? ` (${client.lastError})` : ""}`,
      ),
      ...options.warnings,
      ...summonLines,
    ].filter(Boolean);
    return handled(ok && summonOk, ok && summonOk ? "success" : "warning", lines, command, started.map((client) => client.id), summonRendererActions);
  }

  private activeAccountNames(): Set<string> {
    const names = new Set<string>();
    for (const client of this.clients.values()) {
      for (const value of [client.username, client.runtimeSummary?.userName, client.account?.label, client.label]) {
        const key = accountNameKey(value);
        if (key) names.add(key);
      }
    }
    return names;
  }

  private async commandInput(command: ParsedConsoleCommand, resolvedClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const explicitClientId = positiveInteger(command.args[0]);
    const targetClientIds = explicitClientId ? [explicitClientId] : resolvedClientIds;
    const text = command.args.slice(explicitClientId ? 1 : 0).join(" ").trim();
    if (!text) return handled(false, "warning", ["usage: input [client-id] <message>"], command, targetClientIds);
    if (!targetClientIds.every((id) => this.clients.has(id))) {
      return handled(false, "warning", ["One or more targeted clients are not running yet."], command, targetClientIds);
    }
    return this.hiddenRuntimeCommand(
      command,
      targetClientIds,
      (client) => execEngine(client, () => `window.__engine?.dev?.sendChat?.(${JSON.stringify(text)}, 0)`),
      `say ${text}`,
    );
  }

  private commandMimic(command: ParsedConsoleCommand, targetClientIds: readonly number[]): ConsoleCommandResult {
    const action = (command.args[0] ?? "status").toLowerCase();
    if (action === "status") return handled(true, "info", this.mimicStatusLines(), command, [this.mimicState.sourceClientId]);

    if (action === "on" || action === "enable") {
      const sourceClientId = this.mimicSourceClientId(command, targetClientIds, 1) ?? this.mainClientId;
      if (!this.clients.has(sourceClientId)) {
        return handled(false, "warning", [`Client ${sourceClientId} is not running yet.`], command, targetClientIds);
      }
      this.mimicState.sourceClientId = sourceClientId;
      this.mimicState.enabled = true;
      this.mimicState.lastError = null;
      this.primeMimicCursor();
      this.startMimicPoller();
      return handled(true, "success", [`Mimic enabled from client${sourceClientId}. ${this.mimicTargetClients().length} target client(s) available.`], command, [sourceClientId]);
    }

    if (action === "off" || action === "disable") {
      this.mimicState.enabled = false;
      this.stopMimicPoller();
      return handled(true, "success", ["Mimic disabled."], command, [this.mimicState.sourceClientId]);
    }

    if (action === "source") {
      const sourceClientId = positiveInteger(command.args[1]) ?? this.mimicSourceClientId(command, targetClientIds, 1);
      if (!sourceClientId || !this.clients.has(sourceClientId)) {
        return handled(false, "warning", ["usage: mimic source <client-id>"], command, targetClientIds);
      }
      this.mimicState.sourceClientId = sourceClientId;
      this.primeMimicCursor();
      return handled(true, "success", [`Mimic source set to client${sourceClientId}.`], command, [sourceClientId]);
    }

    if (action === "set" || action === "toggle") {
      const category = mimicCategoryFromArg(command.args[1]);
      const enabled = enabledFromArg(command.args[2]);
      if (!category || enabled === null) {
        return handled(false, "warning", ["usage: mimic set movement|speech|actions|rooms on|off"], command, targetClientIds);
      }
      this.mimicState.categories[category] = enabled;
      return handled(true, "success", [`Mimic ${category} ${enabled ? "enabled" : "disabled"}.`, ...this.mimicStatusLines()], command, [this.mimicState.sourceClientId]);
    }

    const category = mimicCategoryFromArg(action);
    const enabled = enabledFromArg(command.args[1]);
    if (category && enabled !== null) {
      this.mimicState.categories[category] = enabled;
      return handled(true, "success", [`Mimic ${category} ${enabled ? "enabled" : "disabled"}.`, ...this.mimicStatusLines()], command, [this.mimicState.sourceClientId]);
    }

    return handled(false, "warning", ["usage: mimic status|on|off|source <client-id|label>|set movement|speech|actions|rooms on|off [--source <client-id>]"], command, targetClientIds);
  }

  private async commandLookup(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const name = consoleArgsText(command).trim();
    if (!name) return handled(false, "warning", ["usage: lookup <habbo-name>"], command, targetClientIds);
    const lookup = await lookupOriginsUser(name);
    const lines = [
      `Origins: ${lookup.name || name} id=${lookup.id || "-"} ok=${lookup.ok}`,
      `Figure: ${lookup.figureString || "-"}`,
      `Motto: ${lookup.motto || "-"}`,
      `Member since: ${lookup.memberSince || "-"}`,
      lookup.message,
    ];
    return handled(lookup.ok, lookup.ok ? "info" : "warning", lines, command, targetClientIds);
  }

  private async commandWait(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const milliseconds = positiveInteger(command.args[0]) ?? 1000;
    const clamped = Math.min(120000, milliseconds);
    await new Promise((resolveWait) => setTimeout(resolveWait, clamped));
    return handled(true, "info", [`waited ${clamped}ms`], command, targetClientIds);
  }

  private async commandSummon(command: ParsedConsoleCommand, resolvedClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const targetIds = this.summonTargetClientIds(command, resolvedClientIds);
    if (targetIds.length === 0) {
      return handled(false, "warning", ["usage: summon <client-id|label|all|headless> [--main-name <name>] [--main-room-id <flat-id>]"], command, resolvedClientIds);
    }
    const result = await this.summonClients(command, targetIds);
    return handled(result.ok, result.ok ? "success" : "warning", result.lines, command, targetIds, result.rendererActions);
  }

  private async commandMessage(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const target = command.args[0] ?? "";
    const message = command.args.slice(1).join(" ").trim();
    if (!target || !message) return handled(false, "warning", ["usage: message <user-or-account-id> <message>"], command, targetClientIds);

    const accountId = this.resolveSocialAccountId(target, targetClientIds);
    if (!accountId) {
      const lookup = await lookupOriginsUser(target);
      return handled(false, "warning", [`message target needs a numeric account id or public lookup id; lookup said: ${lookup?.message ?? "not looked up"}`], command, targetClientIds);
    }
    return this.commandSocialRelay(
      command,
      targetClientIds,
      { action: "message", accountId, recipient: target, message },
      `Private message ${target}`,
    );
  }

  private async commandSocialRelay(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    action: SocialRelayAction,
    label: string,
  ): Promise<ConsoleCommandResult> {
    const lines: string[] = [];
    let ok = true;
    for (const clientId of targetClientIds) {
      const client = this.client(clientId);
      if (!client) {
        ok = false;
        lines.push(`client${clientId}: not running`);
        continue;
      }
      const result = await this.sendRelayControlToClient(client, { scope: "social", ...action });
      ok &&= result.ok;
      lines.push(`client${clientId}: ${label}: ${result.message}`);
    }
    return handled(ok, ok ? "success" : "warning", lines, command, targetClientIds);
  }

  private async commandUserRelay(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    action: UserRelayAction,
    label: string,
  ): Promise<ConsoleCommandResult> {
    const lines: string[] = [];
    let ok = true;
    for (const clientId of targetClientIds) {
      const client = this.client(clientId);
      if (!client) {
        ok = false;
        lines.push(`client${clientId}: not running`);
        continue;
      }
      const result = await this.sendRelayControlToClient(client, { scope: "user", ...action });
      ok &&= result.ok;
      lines.push(`client${clientId}: ${label}: ${result.message}`);
    }
    return handled(ok, ok ? "success" : "warning", lines, command, targetClientIds);
  }

  private async commandRoomRelay(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    action: Record<string, unknown>,
    label: string,
  ): Promise<ConsoleCommandResult> {
    const lines: string[] = [];
    let ok = true;
    for (const clientId of targetClientIds) {
      const client = this.client(clientId);
      if (!client) {
        ok = false;
        lines.push(`client${clientId}: not running`);
        continue;
      }
      const result = await this.sendRelayControlToClient(client, { scope: "room", ...action });
      ok &&= result.ok;
      lines.push(`client${clientId}: ${label}: ${result.message}`);
    }
    return handled(ok, ok ? "success" : "warning", lines, command, targetClientIds);
  }

  private async commandEnterPrivateRoom(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<ConsoleCommandResult> {
    const flatId = String(command.args[0] ?? "").trim();
    if (!flatId) return handled(false, "warning", ["usage: enterroom <flat-id>"], command, targetClientIds);

    const hiddenIds = targetClientIds.filter((id) => this.client(id)?.hiddenWindow);
    const visibleIds = targetClientIds.filter((id) => !hiddenIds.includes(id));
    const lines: string[] = [];
    let ok = true;
    for (const clientId of hiddenIds) {
      const client = this.client(clientId);
      if (!client) continue;
      const result = await this.enterPrivateRoomForClient(client, flatId);
      ok &&= result.ok;
      await this.refreshClientRuntimeSummary(client);
      const roomText = client.runtimeSummary?.roomName ? ` room=${client.runtimeSummary.roomName}` : "";
      lines.push(`client${client.id}: enter-room ${flatId}: ${result.message}${roomText}`);
    }

    if (visibleIds.length > 0) {
      for (const clientId of visibleIds) {
        lines.push(`client${clientId}: enter-room ${flatId}: queued visible runtime room entry`);
      }
      return handled(
        ok,
        ok ? "success" : "warning",
        lines,
        command,
        [...hiddenIds, ...visibleIds],
        visibleIds.map((clientId) => ({
          kind: "enterPrivateRoom",
          clientId,
          flatId,
          reason: "manual",
        })),
      );
    }
    return handled(ok, ok ? "success" : "warning", lines.length > 0 ? lines : ["No hidden clients matched this command."], command, hiddenIds);
  }

  private commandFriendLifecycle(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    action: "acceptRequest" | "declineRequest" | "followFriend" | "removeFriend",
    verb: string,
  ): Promise<ConsoleCommandResult> | ConsoleCommandResult {
    const target = consoleArgsText(command).trim();
    if (!target) return handled(false, "warning", [`usage: ${command.command} <name-or-account-id>`], command, targetClientIds);
    const accountId = this.resolveSocialAccountId(target, targetClientIds);
    if (!accountId) return handled(false, "warning", [`${verb} target not found with numeric account id: ${target}`], command, targetClientIds);
    const payload =
      action === "acceptRequest" || action === "declineRequest"
        ? { action, accountId }
        : { action, accountId, name: target };
    return this.commandSocialRelay(command, targetClientIds, payload as SocialRelayAction, `${verb} ${target}`);
  }

  private summonTargetClientIds(command: ParsedConsoleCommand, resolvedClientIds: readonly number[]): readonly number[] {
    const first = command.args[0];
    const normalized = String(first ?? "").trim().toLowerCase();
    let ids: readonly number[];
    if (!first) {
      ids = resolvedClientIds;
    } else if (normalized === "all") {
      ids = [...this.clients.keys()];
    } else if (normalized === "headless") {
      ids = [...this.clients.values()].filter((client) => client.headless).map((client) => client.id);
    } else {
      const explicit = positiveInteger(first) ?? this.findClientIdByLabel(first);
      ids = explicit ? [explicit] : resolvedClientIds;
    }
    return [...new Set(ids)].filter((id) => id !== this.mainClientId && this.clients.has(id));
  }

  private async summonClients(command: ParsedConsoleCommand, targetClientIds: readonly number[]): Promise<SummonClientsResult> {
    const lines: string[] = [];
    const rendererActions: ConsoleRendererAction[] = [];
    let ok = true;
    const main = this.client(this.mainClientId);
    if (!main) return { ok: false, lines: [`Main/summoner client${this.mainClientId} is not running.`], rendererActions };

    await this.refreshClientRuntimeSummary(main);
    const mainName = flagValue(command, "main-name") ?? main.runtimeSummary?.userName ?? main.username ?? null;
    const mainRoomId = flagValue(command, "main-room-id") ?? main.runtimeSummary?.roomId ?? null;
    const mainRoomName = flagValue(command, "main-room-name") ?? main.runtimeSummary?.roomName ?? null;
    if (!mainName && !mainRoomId) {
      return {
        ok: false,
        lines: [
          "Summon needs a summoner name for friend-follow or a private room id for direct room entry.",
          "When summoning from the visible main client, the renderer should add these automatically after the main account is in a private room.",
        ],
        rendererActions,
      };
    }

    for (const clientId of targetClientIds) {
      const client = this.client(clientId);
      if (!client) {
        ok = false;
        lines.push(`client${clientId}: not running`);
        continue;
      }
      if (client.id === this.mainClientId) continue;
      const result = await this.summonClient(command, client, { name: mainName, roomId: mainRoomId, roomName: mainRoomName });
      ok &&= result.ok;
      rendererActions.push(...(result.rendererActions ?? []));
      lines.push(`client${client.id}: ${result.message}`);
    }
    return { ok, lines: lines.length > 0 ? lines : ["No summon targets matched."], rendererActions };
  }

  private async summonClient(
    command: ParsedConsoleCommand,
    client: ManagedClient,
    main: { readonly name: string | null; readonly roomId: string | null; readonly roomName: string | null },
  ): Promise<SummonClientResult> {
    if (client.embed.status().status !== "running") {
      return { ok: false, message: `${client.label} is not running.` };
    }

    const preferRoom = flagEnabled(command, "room") || flagEnabled(command, "enter-room");
    if (main.roomId && client.visible && !client.hiddenWindow) {
      const roomText = main.roomName ? ` targetRoom=${main.roomName}` : "";
      return {
        ok: true,
        message: `summon enter-room ${main.roomId}: queued visible runtime room entry${roomText}`,
        rendererActions: [
          {
            kind: "enterPrivateRoom",
            clientId: client.id,
            flatId: String(main.roomId),
            roomName: main.roomName,
            reason: "summon",
          },
        ],
      };
    }

    if (!preferRoom && main.name) {
      const accountId = this.resolveSocialAccountId(main.name, [client.id]);
      if (accountId) {
        const result = await this.sendRelayControlToClient(client, { scope: "social", action: "followFriend", accountId, name: main.name });
        if (result.ok) {
          const readyResult = client.hiddenWindow
            ? await this.waitForHiddenClientRoomReady(client, 25000, main.roomId ?? undefined)
            : { ok: true, message: "visible room entry queued" };
          await this.refreshClientRuntimeSummary(client);
          const roomText = client.runtimeSummary?.roomName ? ` room=${client.runtimeSummary.roomName}` : "";
          if (readyResult.ok || !main.roomId) {
            return {
              ok: readyResult.ok,
              message: `summon follow ${main.name}: ${result.message}; ${readyResult.message}${roomText}`,
              roomReady: client.runtimeSummary?.roomReady ?? null,
            };
          }
          const fallback = await this.visitPrivateRoomViaRelayForClient(client, main.roomId);
          await this.refreshClientRuntimeSummary(client);
          const fallbackRoomText = client.runtimeSummary?.roomName ? ` room=${client.runtimeSummary.roomName}` : main.roomName ? ` targetRoom=${main.roomName}` : "";
          return {
            ok: fallback.ok,
            message: `summon follow ${main.name}: ${result.message}; ${readyResult.message}; v3 visit ${main.roomId}: ${fallback.message}${fallbackRoomText}`,
            roomReady: client.runtimeSummary?.roomReady ?? fallback.roomReady ?? null,
          };
        }
      }
    }

    if (main.roomId) {
      const result = await this.enterPrivateRoomForClient(client, main.roomId);
      await this.refreshClientRuntimeSummary(client);
      const roomText = client.runtimeSummary?.roomName ? ` room=${client.runtimeSummary.roomName}` : main.roomName ? ` targetRoom=${main.roomName}` : "";
      return {
        ok: result.ok,
        message: `summon enter-room ${main.roomId}: ${result.message}${roomText}`,
        sessionId: result.sessionId,
      };
    }

    return {
      ok: false,
      message: `summon could not resolve ${main.name ? `${main.name} as a friend in ${client.label}'s parsed friend list` : "a friend-follow route"} and no main private room id was available.`,
    };
  }

  private async addClient(options: {
    readonly account?: MultiClientAccount;
    readonly label: string;
    readonly headless: boolean;
    readonly visible: boolean;
  }): Promise<ManagedClient> {
    const id = this.nextClientId++;
    const [relayWsPort, relayControlPort] = await reservePortPair();
    const client = this.createClient(id, {
      label: options.label,
      headless: options.headless,
      visible: options.visible,
      account: options.account,
      relayWsPort,
      relayControlPort,
    });
    this.clients.set(id, client);
    await this.startClientRuntime(client, { loadHiddenWindow: options.headless });
    return client;
  }

  private async startClientRuntime(client: ManagedClient, options: { readonly loadHiddenWindow: boolean }): Promise<EngineLaunchState> {
    await this.repairSelectedVersionCheckBuild();
    const launch = await client.embed.start();
    client.lastLaunch = launch;
    client.status = launch.status;
    client.lastError = launch.status === "error" ? launch.message : null;
    if (launch.status !== "running" || !launch.embeddedUrl || !options.loadHiddenWindow) return launch;
    await this.startHiddenWindow(client, launch.embeddedUrl);
    return launch;
  }

  private async startHiddenWindow(client: ManagedClient, embeddedUrl: string): Promise<void> {
    if (client.hiddenWindow && !client.hiddenWindow.isDestroyed()) return;
    const diagnosticEvents: HiddenClientDiagnosticEvent[] = [];
    try {
      const windowOptions: BrowserWindowConstructorOptions = {
        x: hiddenWindowX(client.id),
        y: hiddenWindowY(client.id),
        width: 960,
        height: 540,
        useContentSize: true,
        show: false,
        paintWhenInitiallyHidden: true,
        skipTaskbar: true,
        focusable: false,
        backgroundColor: "#000000",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
        },
      };
      const BrowserWindowCtor = await loadBrowserWindowConstructor();
      const hiddenWindow = new BrowserWindowCtor(windowOptions);
      attachHiddenClientDiagnostics(hiddenWindow, diagnosticEvents);
      client.hiddenWindow = hiddenWindow;
      hiddenWindow.on("closed", () => {
        if (client.hiddenWindow === hiddenWindow) client.hiddenWindow = null;
      });
      showHiddenRuntimeWindow(hiddenWindow, client.id);
      await hiddenWindow.loadURL(hiddenClientUrl(embeddedUrl));
      if (!client.account) return;
      await submitEngineLoginWhenReady(hiddenWindow, client.account.email, client.account.password, 45000);
      client.username = client.account.label;
    } catch (error) {
      const diagnosticPath = await writeHiddenClientDiagnostic(client, error, diagnosticEvents).catch(() => null);
      if (client.hiddenWindow && !client.hiddenWindow.isDestroyed()) client.hiddenWindow.close();
      client.hiddenWindow = null;
      client.status = "error";
      client.lastError = diagnosticPath ? `${errorMessage(error)}; diagnostic ${diagnosticPath}` : errorMessage(error);
    }
  }

  private stopClient(client: ManagedClient, options: { readonly destroyWindow?: boolean } = {}): void {
    if (client.hiddenWindow && !client.hiddenWindow.isDestroyed()) {
      if (options.destroyWindow) client.hiddenWindow.destroy();
      else client.hiddenWindow.close();
    }
    client.hiddenWindow = null;
    client.embed.stop();
    client.status = client.embed.status().status;
    client.lastLaunch = null;
    client.runtimeSummary = null;
  }

  private hiddenRuntimeCommand(
    command: ParsedConsoleCommand,
    targetClientIds: readonly number[],
    run: (client: ManagedClient) => Promise<unknown>,
    passthroughInput = command.inputWithoutTarget,
  ): Promise<ConsoleCommandResult> {
    return (async () => {
      const hiddenIds = targetClientIds.filter((id) => this.client(id)?.hiddenWindow);
      const visibleIds = targetClientIds.filter((id) => !hiddenIds.includes(id));
      const lines: string[] = [];
      for (const clientId of hiddenIds) {
        const client = this.client(clientId);
        if (!client) continue;
        try {
          const result = await run(client);
          lines.push(`client${client.id}: ${compactResult(result)}`);
        } catch (error) {
          lines.push(`client${client.id}: ${errorMessage(error)}`);
        }
      }
      if (visibleIds.length > 0) {
        return {
          ok: true,
          handled: false,
          level: lines.length > 0 ? "info" : "success",
          lines,
          passthroughInput,
          command,
          targetClientIds: visibleIds,
        };
      }
      return handled(true, "info", lines.length > 0 ? lines : ["No hidden clients matched this command."], command, hiddenIds);
    })();
  }

  private createClient(
    id: number,
    options: {
      readonly label: string;
      readonly headless: boolean;
      readonly visible: boolean;
      readonly account?: MultiClientAccount;
      readonly relayWsPort?: number;
      readonly relayControlPort?: number;
    },
  ): ManagedClient {
    return {
      id,
      label: options.label,
      username: options.account?.label ?? null,
      status: "not-configured",
      headless: options.headless,
      visible: options.visible,
      account: options.account,
      embed: new ShocklessEmbedController({
        appDataPath: this.options.appDataPath,
        library: this.options.library,
        cacheNamespace: id === MAIN_CLIENT_ID ? undefined : `client-${id}`,
        relayWsPort: options.relayWsPort,
        relayControlPort: options.relayControlPort,
        relayPolicyProvider: this.options.relayPolicyProvider,
      }),
      hiddenWindow: null,
      lastLaunch: null,
      runtimeSummary: null,
      lastError: null,
    };
  }

  private sessionSummary(client: ManagedClient): ClientSessionSummary {
    const launch = client.embed.status();
    client.lastLaunch = launch;
    if (client.status !== "error") client.status = launch.status;
    const profileLabel = launch.profile ? `${launch.profile.label} / ${launch.profile.buildNumber ?? launch.profile.versionId}` : "No profile selected";
    return {
      id: client.id,
      label: client.label,
      username: client.username,
      status: client.status,
      headless: client.headless,
      visible: client.visible,
      selected: this.selectedClientId === client.id,
      main: this.mainClientId === client.id,
      profileId: launch.profile?.id ?? null,
      profileLabel,
      buildLabel: launch.buildLabel,
      embeddedUrl: client.visible ? launch.embeddedUrl : null,
      relayWsPort: launch.status === "running" ? client.embed.relayWsPort() : null,
      relayControlPort: launch.status === "running" ? client.embed.relayControlPort() : null,
      roomName: client.runtimeSummary?.roomName ?? null,
      lastError: client.lastError ?? (launch.status === "error" ? launch.message : null),
    };
  }

  private async refreshClientRuntimeSummaries(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => this.refreshClientRuntimeSummary(client)));
  }

  private async refreshClientRuntimeSummary(client: ManagedClient): Promise<void> {
    if (!client.hiddenWindow || client.hiddenWindow.isDestroyed()) {
      client.runtimeSummary = client.visible
        ? {
            clientId: client.id,
            source: "none",
            updatedAt: null,
            roomReady: null,
            roomId: null,
            roomName: null,
            roomType: null,
            roomOwner: null,
            userName: client.username,
            userCount: null,
            fps: null,
            frame: null,
            error: client.visible ? "Visible client runtime is owned by the renderer webview." : "Hidden runtime is not running.",
          }
        : null;
      return;
    }
    const raw = await client.hiddenWindow.webContents.executeJavaScript(hiddenRuntimeSummaryScript(client.id), true).catch((error: unknown) => ({
      clientId: client.id,
      source: "hidden-runtime",
      updatedAt: new Date().toISOString(),
      error: errorMessage(error),
    }));
    client.runtimeSummary = normalizeClientRuntimeSummary(client.id, raw, client.username);
    if (client.runtimeSummary.userName) client.username = client.runtimeSummary.userName;
  }

  private clientRelaySummary(clientId: number, snapshot: RelayLogSnapshot = readRelayLogSnapshot(this.options.appDataPath, this.relayLogClients())): ClientRelaySummary {
    const entries = snapshot.entries.filter((entry) => entry.clientId === clientId);
    const packetEntries = entries.filter((entry) => entry.header !== null);
    const latestClientPacket = [...packetEntries].reverse().find((entry) => entry.direction === "CLIENT") ?? null;
    const latestServerPacket = [...packetEntries].reverse().find((entry) => entry.direction === "SERVER") ?? null;
    return {
      clientId,
      logPath: snapshot.logPath,
      exists: snapshot.exists,
      updatedAt: snapshot.updatedAt,
      totalLines: entries.length,
      packetCount: packetEntries.length,
      clientCount: entries.filter((entry) => entry.direction === "CLIENT").length,
      serverCount: entries.filter((entry) => entry.direction === "SERVER").length,
      latestClientPacket: latestPacketLabel(latestClientPacket),
      latestServerPacket: latestPacketLabel(latestServerPacket),
    };
  }

  private resolveTargets(command: ParsedConsoleCommand): { readonly ok: true; readonly clientIds: readonly number[] } | { readonly ok: false; readonly message: string } {
    switch (command.target.kind) {
      case "selected":
        return { ok: true, clientIds: [this.selectedClientId] };
      case "main":
        return { ok: true, clientIds: [this.mainClientId] };
      case "all":
        return { ok: true, clientIds: [...this.clients.keys()].sort((a, b) => a - b) };
      case "visible":
        return { ok: true, clientIds: [...this.clients.values()].filter((client) => client.visible).map((client) => client.id) };
      case "headless":
        return { ok: true, clientIds: [...this.clients.values()].filter((client) => client.headless).map((client) => client.id) };
      case "clientId":
        return command.target.clientId && this.clients.has(command.target.clientId)
          ? { ok: true, clientIds: [command.target.clientId] }
          : { ok: false, message: `Client ${command.target.clientId ?? command.target.raw} is not running yet.` };
      case "label": {
        const label = command.target.label?.trim().toLowerCase();
        const match = [...this.clients.values()].find((client) => client.label.trim().toLowerCase() === label);
        return match ? { ok: true, clientIds: [match.id] } : { ok: false, message: `Client label not found: ${command.target.raw}` };
      }
    }
  }

  private selectedClient(): ManagedClient | null {
    return this.client(this.selectedClientId);
  }

  private client(clientId: number): ManagedClient | null {
    return this.clients.get(clientId) ?? null;
  }

  private findClientIdByLabel(value: unknown): number | null {
    const label = String(value ?? "").trim().toLowerCase();
    if (!label) return null;
    const match = [...this.clients.values()].find((client) => client.label.trim().toLowerCase() === label);
    return match?.id ?? null;
  }

  private mimicSourceClientId(command: ParsedConsoleCommand, targetClientIds: readonly number[], argIndex: number): number | null {
    const sourceFlagValue = flagValue(command, "source");
    const sourceFlag = positiveInteger(sourceFlagValue) ?? this.findClientIdByLabel(sourceFlagValue);
    if (sourceFlag) return sourceFlag;
    const argSource = positiveInteger(command.args[argIndex]) ?? this.findClientIdByLabel(command.args[argIndex]);
    if (argSource) return argSource;
    if (command.target.kind !== "selected" && targetClientIds.length === 1) return targetClientIds[0] ?? null;
    return null;
  }

  private mimicStatusLines(): readonly string[] {
    return [
      `Mimic: ${this.mimicState.enabled ? "on" : "off"}`,
      `Source: client${this.mimicState.sourceClientId}`,
      `Targets: ${this.mimicTargetClients().map((client) => `client${client.id}`).join(", ") || "-"}`,
      `Categories: ${mimicCategories.map((category) => `${category}=${this.mimicState.categories[category] ? "on" : "off"}`).join(", ")}`,
      `Forwarded: ${this.mimicState.forwardedCount}`,
      `Blocked: ${this.mimicState.blockedCount}`,
      `Last forward: ${this.mimicState.lastForwardAt ?? "-"}`,
      `Last error: ${this.mimicState.lastError ?? "-"}`,
    ];
  }

  private startMimicPoller(): void {
    if (this.mimicState.timer) return;
    this.mimicState.timer = setInterval(() => {
      void this.pollMimicRelayLog();
    }, MIMIC_POLL_INTERVAL_MS);
    this.mimicState.timer.unref?.();
  }

  private stopMimicPoller(): void {
    if (!this.mimicState.timer) return;
    clearInterval(this.mimicState.timer);
    this.mimicState.timer = null;
    this.mimicState.polling = false;
  }

  private primeMimicCursor(): void {
    const snapshot = readRelayLogDeltaSnapshot(this.options.appDataPath, null, 0, this.relayLogClients());
    this.mimicState.currentLogPath = snapshot.logPath;
    this.mimicState.afterLineNumber = snapshot.totalLines;
    this.mimicState.duplicatePackets.clear();
  }

  private async pollMimicRelayLog(): Promise<void> {
    if (!this.mimicState.enabled || this.mimicState.polling) return;
    this.mimicState.polling = true;
    try {
      const snapshot = readRelayLogDeltaSnapshot(
        this.options.appDataPath,
        this.mimicState.currentLogPath,
        this.mimicState.afterLineNumber,
        this.relayLogClients(),
      );
      if (snapshot.reset && this.mimicState.currentLogPath) {
        this.mimicState.currentLogPath = snapshot.logPath;
        this.mimicState.afterLineNumber = snapshot.totalLines;
        return;
      }

      this.mimicState.currentLogPath = snapshot.logPath;
      this.mimicState.afterLineNumber = snapshot.totalLines;
      for (const entry of snapshot.entries) {
        await this.forwardMimicEntry(entry);
      }
    } catch (error) {
      this.mimicState.lastError = errorMessage(error);
    } finally {
      this.mimicState.polling = false;
    }
  }

  private async forwardMimicEntry(entry: RelayLogEntry): Promise<void> {
    if (entry.direction !== "CLIENT" || entry.header === null) return;
    if (entry.clientId !== this.mimicState.sourceClientId) return;
    const category = mimicCategoryForRelayEntry(entry);
    if (category && !this.mimicState.categories[category]) return;
    if (category === "rooms") {
      await this.forwardMimicRoomEntry(entry);
      return;
    }
    if (entry.bodyStatus !== "sampled" || entry.bodyHex === null || entry.bodyHex === undefined) {
      this.mimicState.blockedCount += 1;
      return;
    }

    const packet = buildMimicRelayPacketFromControl({
      header: entry.header,
      bodyHex: entry.bodyHex,
      packetName: entry.packetName,
    });
    if (!packet.ok) {
      this.mimicState.blockedCount += 1;
      return;
    }
    if (this.isDuplicateMimicRecord(packet.packet.packetName ?? String(packet.packet.header), packet.packet.bodyHex)) return;

    for (const target of this.mimicTargetClients()) {
      const result = await this.sendRelayControlToClient(target, {
        scope: "mimic",
        header: packet.packet.header,
        bodyHex: packet.packet.bodyHex,
        packetName: entry.packetName ?? undefined,
      });
      if (result.ok) {
        this.mimicState.forwardedCount += 1;
        this.mimicState.lastForwardAt = new Date().toISOString();
      } else {
        this.mimicState.lastError = `client${target.id}: ${result.message}`;
      }
    }
  }

  private async forwardMimicRoomEntry(entry: RelayLogEntry): Promise<void> {
    const roomId = mimicPrivateRoomIdFromEntry(entry);
    if (!roomId) {
      this.mimicState.blockedCount += 1;
      return;
    }
    if (this.isDuplicateMimicRecord("rooms", roomId)) return;
    for (const target of this.mimicTargetClients()) {
      const result = await this.enterPrivateRoomForClient(target, roomId);
      if (result.ok) {
        this.mimicState.forwardedCount += 1;
        this.mimicState.lastForwardAt = new Date().toISOString();
      } else {
        this.mimicState.lastError = `client${target.id}: ${result.message}`;
      }
    }
  }

  private isDuplicateMimicRecord(key: string, bodyHex: string): boolean {
    const now = Date.now();
    for (const [storedKey, previous] of this.mimicState.duplicatePackets) {
      if (now - previous.at > MIMIC_DUPLICATE_WINDOW_MS) this.mimicState.duplicatePackets.delete(storedKey);
    }

    const previous = this.mimicState.duplicatePackets.get(key);
    if (previous && previous.bodyHex === bodyHex && now - previous.at < MIMIC_DUPLICATE_WINDOW_MS) return true;
    this.mimicState.duplicatePackets.set(key, { bodyHex, at: now });
    return false;
  }

  private mimicTargetClients(): ManagedClient[] {
    return [...this.clients.values()]
      .filter((client) => client.id !== this.mimicState.sourceClientId)
      .filter((client) => client.embed.status().status === "running" && client.embed.relayControlPort() > 0);
  }

  private relayLogClients(): readonly { readonly id: number; readonly label: string }[] {
    return [...this.clients.values()].map((client) => ({ id: client.id, label: client.label }));
  }

  private sendRelayControlToClient(client: ManagedClient, action: Record<string, unknown>): Promise<GardeningRelayResult> {
    const controlPort = client.embed.status().status === "running" ? client.embed.relayControlPort() : null;
    if (!controlPort) return Promise.resolve({ ok: false, message: `Client ${client.id} relay control is not running.` });
    return new Promise((resolveAction) => {
      const socket = connect({ host: RELAY_CONTROL_HOST, port: controlPort });
      let buffer = "";
      const finish = (result: GardeningRelayResult): void => {
        socket.destroy();
        resolveAction(result);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(3000);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(action)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as GardeningRelayResult;
          finish({
            ok: Boolean(parsed.ok),
            message: String(parsed.message ?? ""),
            sessionId: parsed.sessionId,
            roomReady: typeof parsed.roomReady === "boolean" ? parsed.roomReady : parsed.roomReady === null ? null : undefined,
          });
        } catch {
          finish({ ok: false, message: "Relay control returned invalid JSON." });
        }
      });
      socket.on("timeout", () => finish({ ok: false, message: "Relay control timed out." }));
      socket.on("error", (error: Error) => finish({ ok: false, message: `Client ${client.id} relay control unavailable: ${error.message}` }));
      });
  }

  private async enterPrivateRoomForClient(client: ManagedClient, roomId: string): Promise<GardeningRelayResult> {
    const flatId = roomId.trim();
    if (!flatId) return { ok: false, message: "No private room id was available." };
    if (!client.hiddenWindow || client.hiddenWindow.isDestroyed()) {
      return { ok: false, message: `Client ${client.id} has no hidden runtime for direct room entry.` };
    }
    const raw = await client.hiddenWindow.webContents
      .executeJavaScript(hiddenEnterPrivateRoomScript(flatId, 25000), true)
      .catch((error: unknown) => ({ ok: false, message: errorMessage(error) }));
    const value = isRecord(raw) ? raw : {};
    const roomReadyValue = isRecord(value.roomReady) ? value.roomReady : {};
    const roomReady = roomReadyValue.ready === true;
    const helperOk = value.ok === true;
    const baseMessage =
      typeof value.message === "string"
        ? value.message
        : helperOk
          ? "entered private room"
          : "private room entry failed";
    const sourceResult = {
      ok: helperOk && roomReady,
      message: roomReady ? baseMessage : `${baseMessage}; roomReady=false`,
      roomReady,
    };
    if (sourceResult.ok) return sourceResult;

    const fallback = await this.visitPrivateRoomViaRelayForClient(client, flatId);
    return {
      ok: fallback.ok,
      message: `${sourceResult.message}; v3 visit fallback: ${fallback.message}`,
      roomReady: fallback.roomReady,
      sessionId: fallback.sessionId,
    };
  }

  private async visitPrivateRoomViaRelayForClient(client: ManagedClient, roomId: string): Promise<GardeningRelayResult> {
    const flatId = roomId.trim();
    if (!flatId) return { ok: false, message: "No private room id was available." };
    const sent = await this.sendRelayControlToClient(client, { scope: "room", action: "visitPrivateRoom", roomId: flatId });
    if (!sent.ok) return sent;
    if (!client.hiddenWindow || client.hiddenWindow.isDestroyed()) return sent;
    const ready = await this.waitForHiddenClientRoomReady(client, 60000, flatId);
    return {
      ok: ready.ok,
      message: `${sent.message}; ${ready.message}`,
      roomReady: ready.roomReady,
      sessionId: sent.sessionId,
    };
  }

  private async waitForHiddenClientRoomReady(client: ManagedClient, timeoutMs: number, expectedRoomId?: string): Promise<GardeningRelayResult> {
    if (!client.hiddenWindow || client.hiddenWindow.isDestroyed()) {
      return { ok: false, message: `Client ${client.id} has no hidden runtime.`, roomReady: null };
    }
    const raw = await client.hiddenWindow.webContents
      .executeJavaScript(hiddenWaitForRoomReadyScript(timeoutMs, expectedRoomId), true)
      .catch((error: unknown) => ({ ok: false, message: errorMessage(error), roomReady: null }));
    const value = isRecord(raw) ? raw : {};
    const roomReadyValue = isRecord(value.roomReady) ? value.roomReady : {};
    const roomReady = roomReadyValue.ready === true;
    return {
      ok: value.ok === true && roomReady,
      message: typeof value.message === "string" ? value.message : roomReady ? "roomReady=true" : "roomReady=false",
      roomReady,
    };
  }

  private resolveSocialAccountId(target: string, targetClientIds: readonly number[]): number | null {
    const numeric = positiveInteger(target);
    if (numeric) return numeric;

    const normalizedTarget = normalizeSocialName(target);
    if (!normalizedTarget) return null;
    const snapshot = readRelayLogSnapshot(this.options.appDataPath, this.relayLogClients());
    const targetSet = new Set(targetClientIds);
    for (const entry of [...snapshot.entries].reverse()) {
      if (entry.clientId !== null && targetSet.size > 0 && !targetSet.has(entry.clientId)) continue;
      const candidates = socialCandidatesFromFields(entry.decodedFields);
      for (const candidate of candidates) {
        if (normalizeSocialName(candidate.name) === normalizedTarget) return candidate.accountId;
      }
    }
    return null;
  }
}

function socialCandidatesFromFields(fields: readonly { readonly label: string; readonly value: string }[]): readonly { readonly name: string; readonly accountId: number }[] {
  const candidates = new Map<string, { name: string; accountId: number | null }>();
  for (const field of fields) {
    const match = field.label.match(/^(user \d+|friend \d+|friendUpdate \d+|friendAdded|friendRequest \d+|highlightFriend \d+) (name|accountId)$/);
    if (!match) continue;
    const key = match[1]!;
    const kind = match[2]!;
    const existing = candidates.get(key) ?? { name: "", accountId: null };
    if (kind === "name") {
      candidates.set(key, { ...existing, name: field.value });
    } else {
      candidates.set(key, { ...existing, accountId: positiveInteger(field.value) });
    }
  }
  return [...candidates.values()]
    .filter((candidate): candidate is { name: string; accountId: number } => Boolean(candidate.name) && candidate.accountId !== null);
}

function normalizeSocialName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function accountNameKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function defaultMimicCategories(): Record<MimicCategory, boolean> {
  return {
    movement: true,
    speech: true,
    actions: true,
    rooms: true,
  };
}

function mimicCategoryFromArg(value: unknown): MimicCategory | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "move" || normalized === "movement" || normalized === "walk" || normalized === "walking") return "movement";
  if (normalized === "speech" || normalized === "chat" || normalized === "talk" || normalized === "typing") return "speech";
  if (normalized === "action" || normalized === "actions" || normalized === "emote" || normalized === "emotes") return "actions";
  if (normalized === "room" || normalized === "rooms" || normalized === "join" || normalized === "joins") return "rooms";
  return null;
}

function enabledFromArg(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(normalized)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(normalized)) return false;
  return null;
}

function mimicCategoryForRelayEntry(entry: RelayLogEntry): MimicCategory | null {
  if (entry.header === 21) return "rooms";
  const name = normalizedMimicPacketName(entry.packetName);
  if (!name) return null;
  if (["move", "lookto"].includes(name)) return "movement";
  if (["chat", "shout", "whisper", "userstarttyping", "usercanceltyping", "starttyping", "canceltyping"].includes(name)) return "speech";
  if (["dance", "wave", "carrydrink", "carryitem", "sign", "update", "swimsuit", "look", "figure", "motto", "expression", "action"].includes(name)) return "actions";
  return null;
}

function mimicPrivateRoomIdFromEntry(entry: RelayLogEntry): string | null {
  if (entry.header !== 21) return null;
  const candidates = [
    entry.bodyAscii,
    entry.bodyText,
    relayDecodedField(entry, "ascii"),
    relayDecodedField(entry, "field 1"),
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (/^\d{1,10}$/.test(text)) return text;
  }
  return null;
}

function relayDecodedField(entry: RelayLogEntry, label: string): string | null {
  const match = entry.decodedFields.find((field) => field.label.toLowerCase() === label.toLowerCase());
  return match?.value ?? null;
}

function normalizedMimicPacketName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function handled(
  ok: boolean,
  level: ConsoleCommandResult["level"],
  lines: readonly string[],
  command?: ParsedConsoleCommand,
  targetClientIds?: readonly number[],
  rendererActions?: readonly ConsoleRendererAction[],
): ConsoleCommandResult {
  return {
    ok,
    handled: true,
    level,
    lines,
    command,
    targetClientIds,
    rendererActions,
  };
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function flagEnabled(command: ParsedConsoleCommand, name: string): boolean {
  const normalized = name.toLowerCase();
  return command.flags.some((flag) => flag.name === normalized);
}

function flagValue(command: ParsedConsoleCommand, name: string): string | null {
  const normalized = name.toLowerCase();
  const flag = command.flags.find((entry) => entry.name === normalized);
  return flag && flag.value !== true ? flag.value : null;
}

function flagValues(command: ParsedConsoleCommand, name: string): readonly string[] {
  const normalized = name.toLowerCase();
  return command.flags
    .filter((entry) => entry.name === normalized && entry.value !== true)
    .map((entry) => String(entry.value).trim())
    .filter(Boolean);
}

function accountStoreKeyFromEnv(command: ParsedConsoleCommand): { readonly ok: true; readonly key: string; readonly envName: string } | { readonly ok: false; readonly message: string } {
  const envName = flagValue(command, "key-env")?.trim() ?? "";
  if (!envName) return { ok: false, message: "usage: include --key-env <ENV_NAME> for encrypted account store commands" };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return { ok: false, message: `Invalid key environment variable name: ${envName}` };
  const key = process.env[envName] ?? "";
  if (!key) return { ok: false, message: `Environment variable ${envName} is not set.` };
  return { ok: true, key, envName };
}

function consoleArgsText(command: ParsedConsoleCommand): string {
  return command.args.join(" ");
}

function accountFromLoginArg(value: unknown, labelValue: unknown): MultiClientAccount | null {
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

async function reservePortPair(): Promise<readonly [number, number]> {
  const wsPort = await reservePort();
  const controlPort = await reservePort();
  return [wsPort, controlPort] as const;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return results;
}

async function loadBrowserWindowConstructor(): Promise<new (options: BrowserWindowConstructorOptions) => BrowserWindow> {
  const electronModule = await import("electron");
  const defaultExport = (electronModule as unknown as { default?: typeof electronModule }).default;
  const BrowserWindowCtor = electronModule.BrowserWindow ?? defaultExport?.BrowserWindow;
  if (!BrowserWindowCtor) throw new Error("Electron BrowserWindow is unavailable outside the Electron main process.");
  return BrowserWindowCtor;
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function attachHiddenClientDiagnostics(window: BrowserWindow, events: HiddenClientDiagnosticEvent[]): void {
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

async function submitEngineLoginWhenReady(window: BrowserWindow, email: string, password: string, timeoutMs: number): Promise<void> {
  return submitEngineLoginInWebContents(window.webContents, email, password, timeoutMs, () => window.isDestroyed());
}

async function submitEngineLoginInWebContents(
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
  if (value.roomReady === true) return true;
  return false;
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

function hiddenClientUrl(embeddedUrl: string): string {
  const url = new URL(embeddedUrl);
  url.searchParams.set("fastEntry", "1");
  url.searchParams.set("customHotelView", "0");
  url.searchParams.set("headlessRuntime", "1");
  return url.toString();
}

function showHiddenRuntimeWindow(window: BrowserWindow, clientId: number): void {
  if (process.env.HABBPY_V4_HEADLESS_WINDOW_MODE === "hidden") return;
  window.setPosition(hiddenWindowX(clientId), hiddenWindowY(clientId), false);
  window.setSkipTaskbar(true);
  window.showInactive();
}

function hiddenWindowX(clientId: number): number {
  return -32000 - (clientId % 12) * 32;
}

function hiddenWindowY(clientId: number): number {
  return -32000 - Math.floor(clientId / 12) * 32;
}

async function engineLoginReadiness(window: BrowserWindow): Promise<EngineLoginReadinessSnapshot> {
  if (window.isDestroyed()) {
    return normalizeEngineReadinessSnapshot({ error: "window destroyed" });
  }
  return engineLoginReadinessInWebContents(window.webContents);
}

async function engineLoginReadinessInWebContents(contents: WebContents): Promise<EngineLoginReadinessSnapshot> {
  if (contents.isDestroyed()) {
    return normalizeEngineReadinessSnapshot({ error: "webContents destroyed" });
  }
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

async function writeHiddenClientDiagnostic(
  client: ManagedClient,
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

async function execEngine(client: ManagedClient, code: (text: string) => string, text = ""): Promise<unknown> {
  const hiddenWindow = client.hiddenWindow;
  if (!hiddenWindow || hiddenWindow.isDestroyed()) throw new Error("hidden webContents is not running");
  return hiddenWindow.webContents.executeJavaScript(code(text), true);
}

function gpuCapabilityScript(settings: {
  readonly hardwareAccelerationActive: boolean;
  readonly hardwareAccelerationPreference: boolean;
  readonly launchSwitches: readonly string[];
}): string {
  const settingsJson = JSON.stringify({
    hardwareAccelerationActive: settings.hardwareAccelerationActive,
    hardwareAccelerationPreference: settings.hardwareAccelerationPreference,
    launchSwitches: settings.launchSwitches,
  });
  return `
    (() => {
      const settings = ${settingsJson};
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      const debug = gl && typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_debug_renderer_info") : null;
      const vendor = gl && debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null;
      const renderer = gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
      return {
        hardwareAccelerationActive: settings.hardwareAccelerationActive,
        hardwareAccelerationPreference: settings.hardwareAccelerationPreference,
        restartRequired: settings.hardwareAccelerationActive !== settings.hardwareAccelerationPreference,
        launchSwitches: settings.launchSwitches,
        webgl: Boolean(gl),
        vendor,
        renderer,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent
      };
    })()
  `;
}

function hiddenEnterPrivateRoomScript(flatId: string, timeoutMs = 90000): string {
  return `
    (async () => {
      try {
        const dev = window.__engine?.dev;
        if (typeof dev?.enterPrivateRoom !== "function") {
          return { ok: false, message: "Private room entry helper is not available." };
        }
        const targetFlatId = ${JSON.stringify(flatId)};
        const valueFor = (source, keys) => {
          if (!source || typeof source !== "object") return null;
          for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
            const clean = String(key).replace(/^#/, "");
            if (source[clean] !== undefined && source[clean] !== null && source[clean] !== "") return source[clean];
          }
          const entries = Array.isArray(source.entries) ? source.entries : [];
          for (const key of keys) {
            const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match && match.value !== undefined && match.value !== null && match.value !== "") return match.value;
          }
          return null;
        };
        const activeFlatId = () => {
          const state = typeof dev.roomEntryState === "function" ? dev.roomEntryState() : null;
          const lastRoom = state?.lastroom && typeof state.lastroom === "object" ? state.lastroom : null;
          const roomComponent = state?.roomComponent && typeof state.roomComponent === "object" ? state.roomComponent : null;
          const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
          const candidate =
            valueFor(lastRoom, ["#flatId", "flatId", "#id", "id"]) ??
            valueFor(saveData, ["#flatId", "flatId", "#id", "id"]) ??
            roomComponent?.pReportRoomId ??
            roomComponent?.pRoomId ??
            null;
          return candidate == null ? "" : String(candidate);
        };
        const roomMatches = (state) => {
          if (!(state && state.ready === true)) return false;
          const roomId = activeFlatId() || (state.roomId == null ? "" : String(state.roomId));
          return roomId === targetFlatId || roomId === "f_" + targetFlatId;
        };
        const waitForTargetRoomReady = async (timeoutMs) => {
          const deadline = performance.now() + Math.max(1, Number(timeoutMs) || 90000);
          let state = typeof dev.roomReady === "function" ? dev.roomReady() : null;
          while (!roomMatches(state) && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            state = typeof dev.roomReady === "function" ? dev.roomReady() : null;
          }
          return state;
        };
        const closeWindowsByPattern = async (pattern) => {
          if (typeof dev.windowIds !== "function" || typeof dev.clickWindowElement !== "function") return [];
          const ids = await Promise.resolve(dev.windowIds()).catch(() => []);
          const windows = Array.isArray(ids) ? ids.map((id) => String(id)).filter((id) => pattern.test(id)) : [];
          const closed = [];
          const fallbackElementIds = [
            "Bulletin Board_close",
            "close",
            "button_close",
            "btn_close",
            "header_button_close",
            "close_button",
            "ok",
            "cancel",
          ];
          const flattenElements = (elements) => {
            const rows = [];
            const visit = (entry) => {
              if (!entry || typeof entry !== "object") return;
              rows.push(entry);
              const children = Array.isArray(entry.children) ? entry.children : [];
              for (const child of children) visit(child);
            };
            for (const entry of Array.isArray(elements) ? elements : []) visit(entry);
            return rows;
          };
          const scoreElement = (entry) => {
            const text = [entry.id, entry.class, entry.type, entry.text, entry.name, entry.member].join(" ").toLowerCase();
            if (!text.trim()) return 0;
            if (/\\b(close|closed|exit|cancel|ok|done)\\b/.test(text)) return 10;
            if (/x|cross/.test(text)) return 4;
            return 0;
          };
          for (const windowId of windows) {
            const elements = typeof dev.windowElements === "function" ? await Promise.resolve(dev.windowElements(windowId)).catch(() => []) : [];
            const ranked = flattenElements(elements)
              .filter((entry) => entry?.id != null)
              .map((entry) => ({ id: String(entry.id), score: scoreElement(entry) }))
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score);
            const candidates = [...new Set([...ranked.map((entry) => entry.id), ...fallbackElementIds])];
            for (const elementId of candidates) {
              const clicked = await Promise.resolve(dev.clickWindowElement(windowId, elementId)).catch(() => null);
              if (clicked && clicked.clicked !== false && !clicked.error) {
                closed.push({ windowId, elementId });
                break;
              }
            }
          }
          return closed;
        };
        const preClosedWindows = await closeWindowsByPattern(/bulletin|welcome|news/i);
        const result = await dev.enterPrivateRoom(targetFlatId, true, ${JSON.stringify(timeoutMs)});
        let roomReady = result && typeof result === "object" ? result.roomReady : null;
        if (!roomMatches(roomReady)) roomReady = await waitForTargetRoomReady(${JSON.stringify(timeoutMs)});
        const closedWindows = [...preClosedWindows, ...(await closeWindowsByPattern(/bulletin|welcome|news/i))];
        const ok = !(result && typeof result === "object" && result.ok === false) && roomMatches(roomReady);
        let message = "entered private room ${flatId}";
        if (typeof result === "string" && result.trim()) message = result;
        else if (result && typeof result === "object") {
          message = String(result.message ?? result.route ?? result.status ?? message);
        }
        if (!ok) message = message + "; targetRoomReady=false";
        return { ok, message, roomReady, closedWindows };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    })()
  `;
}

function hiddenWaitForRoomReadyScript(timeoutMs: number, expectedRoomId?: string): string {
  return `
    (async () => {
      try {
        const dev = window.__engine?.dev;
        if (!dev) return { ok: false, message: "Shockless dev API is not ready.", roomReady: null };
        const expectedRoomId = ${JSON.stringify(expectedRoomId ?? null)};
        const valueFor = (source, keys) => {
          if (!source || typeof source !== "object") return null;
          for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
            const clean = String(key).replace(/^#/, "");
            if (source[clean] !== undefined && source[clean] !== null && source[clean] !== "") return source[clean];
          }
          const entries = Array.isArray(source.entries) ? source.entries : [];
          for (const key of keys) {
            const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match && match.value !== undefined && match.value !== null && match.value !== "") return match.value;
          }
          return null;
        };
        const activeFlatId = () => {
          const state = typeof dev.roomEntryState === "function" ? dev.roomEntryState() : null;
          const lastRoom = state?.lastroom && typeof state.lastroom === "object" ? state.lastroom : null;
          const roomComponent = state?.roomComponent && typeof state.roomComponent === "object" ? state.roomComponent : null;
          const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
          const candidate =
            valueFor(lastRoom, ["#flatId", "flatId", "#id", "id"]) ??
            valueFor(saveData, ["#flatId", "flatId", "#id", "id"]) ??
            roomComponent?.pReportRoomId ??
            roomComponent?.pRoomId ??
            null;
          return candidate == null ? "" : String(candidate);
        };
        const roomMatches = (state) => {
          if (!(state && state.ready === true)) return false;
          if (!expectedRoomId) return true;
          const roomId = activeFlatId() || (state.roomId == null ? "" : String(state.roomId));
          return roomId === expectedRoomId || roomId === "f_" + expectedRoomId;
        };
        const closeTransientWindows = async () => {
          if (typeof dev.windowIds !== "function" || typeof dev.clickWindowElement !== "function") return [];
          const ids = await Promise.resolve(dev.windowIds()).catch(() => []);
          const windows = Array.isArray(ids) ? ids.map((id) => String(id)).filter((id) => /bulletin|welcome|news/i.test(id)) : [];
          const closed = [];
          for (const windowId of windows) {
            const elementRows = typeof dev.windowElements === "function" ? await Promise.resolve(dev.windowElements(windowId)).catch(() => []) : [];
            const elementIds = [];
            const visit = (entry) => {
              if (!entry || typeof entry !== "object") return;
              const id = entry.id == null ? "" : String(entry.id);
              const text = [entry.id, entry.class, entry.type, entry.text, entry.name, entry.member].join(" ").toLowerCase();
              if (id && /close|cancel|ok|done|exit/.test(text)) elementIds.push(id);
              for (const child of Array.isArray(entry.children) ? entry.children : []) visit(child);
            };
            for (const row of Array.isArray(elementRows) ? elementRows : []) visit(row);
            const candidates = [
              ...new Set([
                ...elementIds,
                windowId + "_close",
                "Bulletin Board_close",
                "close",
                "button_close",
                "btn_close",
                "header_button_close",
                "close_button",
                "ok",
                "cancel",
              ]),
            ];
            for (const elementId of candidates) {
              const clicked = await Promise.resolve(dev.clickWindowElement(windowId, elementId)).catch(() => null);
              if (clicked && clicked.clicked !== false && !clicked.error) {
                closed.push({ windowId, elementId });
                break;
              }
            }
          }
          return closed;
        };
        let roomReady = null;
        const closedWindows = await closeTransientWindows();
        if (expectedRoomId && typeof dev.roomReady === "function") {
          const deadline = performance.now() + Math.max(1, ${JSON.stringify(timeoutMs)});
          roomReady = dev.roomReady();
          let lastCloseAt = performance.now();
          while (!roomMatches(roomReady) && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (performance.now() - lastCloseAt > 2000) {
              closedWindows.push(...(await closeTransientWindows()));
              lastCloseAt = performance.now();
            }
            roomReady = dev.roomReady();
          }
        } else if (typeof dev.waitForRoomReady === "function") {
          roomReady = await dev.waitForRoomReady(${JSON.stringify(timeoutMs)});
        } else if (typeof dev.roomReady === "function") {
          roomReady = dev.roomReady();
        }
        const ok = roomMatches(roomReady);
        const targetText = expectedRoomId ? " targetRoom=" + expectedRoomId : "";
        return { ok, message: ok ? "roomReady=true" + targetText : "roomReady=false" + targetText, roomReady, closedWindows };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error), roomReady: null };
      }
    })()
  `;
}

function hiddenRuntimeSummaryScript(clientId: number): string {
  return `
    (() => {
      const compact = (value) => value === undefined || value === null || value === "" ? null : String(value);
      const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
      const valueFor = (source, keys) => {
        if (!source || typeof source !== "object") return null;
        for (const key of keys) {
          if (source[key] !== undefined) return source[key];
          const clean = String(key).replace(/^#/, "");
          if (source[clean] !== undefined) return source[clean];
        }
        const entries = Array.isArray(source.entries) ? source.entries : [];
        for (const key of keys) {
          const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
          if (match) return match.value;
        }
        return null;
      };
      try {
        const engine = window.__engine;
        const dev = engine?.dev;
        const roomReady = typeof dev?.roomReady === "function" ? dev.roomReady() : null;
        const roomEntryState = typeof dev?.roomEntryState === "function" ? dev.roomEntryState() : null;
        const performanceStats = typeof dev?.performanceStats === "function" ? dev.performanceStats() : null;
        const roomObjects = typeof engine?.roomObjects === "function" ? engine.roomObjects() : null;
        const sessionProps = typeof engine?.objectProps === "function" ? engine.objectProps("Session") : null;
        const props = sessionProps?.props ?? sessionProps?.properties ?? sessionProps;
        const itemList = props?.pitemlist ?? props?.pItemList ?? props?.PItemList;
        const roomEntries = Array.isArray(itemList?.entries) ? itemList.entries : [];
        const roomByKey = (keys) => {
          for (const key of keys) {
            const match = roomEntries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match) return match.value;
          }
          return null;
        };
        const users = Array.isArray(roomObjects?.users) ? roomObjects.users : [];
        const sessionUserName =
          compact(props?.userName ?? props?.pUserName ?? props?.username) ??
          compact(users.find((user) => String(user?.rowId ?? user?.id ?? "") === "0")?.name) ??
          null;
        const lastRoom = roomEntryState?.lastroom && typeof roomEntryState.lastroom === "object" ? roomEntryState.lastroom : null;
        const roomComponent = roomEntryState?.roomComponent && typeof roomEntryState.roomComponent === "object" ? roomEntryState.roomComponent : null;
        const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
        const roomName =
          compact(valueFor(lastRoom, ["#name", "name"])) ??
          compact(valueFor(saveData, ["#name", "name"])) ??
          compact(roomByKey(["#name", "name"])) ??
          compact(roomReady?.roomName) ??
          null;
        const roomId =
          compact(valueFor(lastRoom, ["#flatId", "#id", "flatId", "id"])) ??
          compact(valueFor(saveData, ["#flatId", "#id", "flatId", "id"])) ??
          compact(roomByKey(["#flatId", "#id", "flatId", "id"])) ??
          compact(roomReady?.roomId) ??
          compact(roomComponent?.pReportRoomId ?? roomComponent?.pRoomId) ??
          null;
        const roomOwner =
          compact(valueFor(lastRoom, ["#owner", "owner"])) ??
          compact(valueFor(saveData, ["#owner", "owner"])) ??
          compact(roomByKey(["#owner", "owner"])) ??
          null;
        const roomType =
          compact(valueFor(lastRoom, ["#type", "type"])) ??
          compact(valueFor(saveData, ["#type", "type"])) ??
          compact(roomByKey(["#type", "type"])) ??
          compact(roomReady?.roomType) ??
          null;
        return {
          clientId: ${JSON.stringify(clientId)},
          source: "hidden-runtime",
          updatedAt: new Date().toISOString(),
          roomReady: typeof roomReady?.ready === "boolean" ? roomReady.ready : null,
          roomId,
          roomName: roomName ?? (roomReady?.ready && roomId ? "Room " + roomId : null),
          roomType,
          roomOwner,
          userName: sessionUserName,
          userCount: users.length || numeric(roomReady?.roomLikeSpriteCount),
          fps: numeric(performanceStats?.rafPerSecond ?? performanceStats?.rafRate),
          frame: typeof engine?.frame === "function" ? numeric(engine.frame()) : null,
          error: null
        };
      } catch (error) {
        return {
          clientId: ${JSON.stringify(clientId)},
          source: "hidden-runtime",
          updatedAt: new Date().toISOString(),
          roomReady: null,
          roomId: null,
          roomName: null,
          roomType: null,
          roomOwner: null,
          userName: null,
          userCount: null,
          fps: null,
          frame: null,
          error: String(error?.message ?? error)
        };
      }
    })()
  `;
}

function normalizeClientRuntimeSummary(clientId: number, raw: unknown, fallbackUserName: string | null): ClientRuntimeSummary {
  const value = isRecord(raw) ? raw : {};
  return {
    clientId,
    source: value.source === "hidden-runtime" || value.source === "visible-renderer" ? value.source : "hidden-runtime",
    updatedAt: stringOrNull(value.updatedAt),
    roomReady: typeof value.roomReady === "boolean" ? value.roomReady : null,
    roomId: stringOrNull(value.roomId),
    roomName: stringOrNull(value.roomName),
    roomType: stringOrNull(value.roomType),
    roomOwner: stringOrNull(value.roomOwner),
    userName: stringOrNull(value.userName) ?? fallbackUserName,
    userCount: finiteNumberOrNull(value.userCount),
    fps: finiteNumberOrNull(value.fps),
    frame: finiteNumberOrNull(value.frame),
    error: stringOrNull(value.error),
  };
}

function latestPacketLabel(entry: RelayLogEntry | null): string | null {
  if (!entry || entry.header === null) return null;
  return `${entry.packetName ?? "UNKNOWN_HEADER"} [${entry.header}] line ${entry.lineNumber}`;
}

function managerHelpLine(): string {
  return "session commands: newclient [--label <name>], load <file> <count> --headless [--summon], accounts import|list|load --key-env <ENV>, login <email:password> --headless, summon <id|label|all|headless>, enterroom <flat-id>, list, select <id>, rename <id> <label>, main <id>, mimic status|on|off|source <id>, wave, dance <1-4>, carrydrink, @1/@all/@headless targets. game commands keep the same names and use target routing where supported.";
}

function sessionLine(session: ClientSessionSummary): string {
  const flags = [
    session.selected ? "selected" : "",
    session.main ? "main" : "",
    session.headless ? "headless" : "visible",
    session.status,
  ].filter(Boolean).join(",");
  const user = session.username ? ` user=${session.username}` : "";
  const room = session.roomName ? ` room=${session.roomName}` : "";
  return `${session.id} ${session.label} [${flags}]${user}${room} ${session.profileLabel}`;
}

function compactResult(value: unknown): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return String(value).slice(0, 160);
  }
}

function noClientState(): EngineLaunchState {
  return {
    status: "not-configured",
    embeddedUrl: null,
    profile: null,
    buildLabel: "No client",
    message: "No client session is available.",
    settings: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandStatePath(appDataPath: string): string {
  return join(appDataPath, "HabbpyV4", COMMAND_STATE_FILE);
}

function readCommandState(appDataPath: string): ConsoleCommandState {
  const fallback: ConsoleCommandState = { version: 1, aliases: {}, bindings: {}, history: [] };
  const filePath = commandStatePath(appDataPath);
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ConsoleCommandState>;
    return {
      version: 1,
      aliases: cleanStringRecord(raw.aliases),
      bindings: cleanBindingRecord(raw.bindings),
      history: Array.isArray(raw.history)
        ? raw.history.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).slice(-MAX_COMMAND_HISTORY)
        : [],
    };
  } catch {
    return fallback;
  }
}

function saveCommandState(appDataPath: string, state: ConsoleCommandState): void {
  const filePath = commandStatePath(appDataPath);
  mkdirSync(join(appDataPath, "HabbpyV4"), { recursive: true });
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

function cleanStringRecord(value: unknown): Record<string, string> {
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

function normalizeAliasName(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function validAliasName(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

function normalizeBindingKey(value: string): string {
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

function commandTailText(command: ParsedConsoleCommand): string {
  return [
    ...command.args.map(quoteConsoleArg),
    ...command.flags.map(formatConsoleFlag),
  ].join(" ").trim();
}

function formatConsoleFlag(flag: ConsoleCommandFlag): string {
  if (flag.value === true) return `--${flag.name}`;
  return `--${flag.name}=${quoteConsoleArg(flag.value)}`;
}

function quoteConsoleArg(value: string): string {
  if (!value) return '""';
  return /[\s"'#]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function isDangerousBindingCommand(command: ParsedConsoleCommand): boolean {
  if (command.command !== "close" && command.command !== "stop") return false;
  return command.target.kind === "all" || command.args[0]?.toLowerCase() === "all";
}

function applyDryRunAliasMutation(command: ParsedConsoleCommand, aliases: Record<string, string>): { readonly ok: true } | { readonly ok: false; readonly message: string } {
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
