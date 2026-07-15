import type { BrowserWindow,BrowserWindowConstructorOptions,WebContents } from "electron";
import { existsSync,mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { connect,createServer } from "node:net";
import { join,resolve } from "node:path";
import {
parseConsoleCommand,
redactConsoleCommandInput,
type ConsoleCommandResult,
type ConsoleRendererAction,
type ParsedConsoleCommand
} from "../shared/consoleCommand.js";
import { errorMessage } from "../shared/errors.js";
import { buildMimicRelayPacketFromControl } from "../shared/mimicRelayPackets.js";
import { parseMultiClientAccounts,type MultiClientAccount } from "../shared/multiClientAccounts.js";
import type { PluginRelayPolicy } from "../shared/pluginRelayHooks.js";
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
RelayLogSnapshot,SocialRelayAction,UserRelayAction
} from "../shared/window-api.js";
import { GPU_LAUNCH_SWITCHES,readAppPreferences } from "./appPreferences.js";
import { ClientLibraryStore } from "./clientLibrary.js";
import { ensureProfileAudioCurrent } from "./profileAudioMaintenance.js";
import { accountStoreSummary,clearEncryptedAccountStore,readEncryptedAccountStore,writeEncryptedAccountStore } from "./encryptedAccountStore.js";
import {
accountFromLoginArg,
accountNameKey,
accountStoreKeyFromEnv,
consoleArgsText,
defaultMimicCategories,
enabledFromArg,
flagEnabled,
flagValue,
flagValues,
handled,
mimicCategoryForRelayEntry,
mimicCategoryFromArg,
mimicPrivateRoomIdFromEntry,
nonNegativeInteger,
normalizeSocialName,
positiveInteger,
socialCandidatesFromFields
} from "./multi-session/commandUtils.js";
import {
MAX_COMMAND_HISTORY,
applyDryRunAliasMutation,
commandTailText,
isDangerousBindingCommand,
normalizeAliasName,
normalizeBindingKey,
readCommandState,
saveCommandState,
validAliasName,
type ConsoleCommandState,
} from "./multi-session/consoleState.js";
import {
  attachHiddenClientDiagnostics,
  execHiddenEngine as execEngine,
  hiddenClientUrl,
  hiddenWindowX,
  hiddenWindowY,
  loadBrowserWindowConstructor,
  showHiddenRuntimeWindow,
  submitEngineLoginInWebContents,
  submitEngineLoginWhenReady,
  writeHiddenClientDiagnostic,
  type HiddenClientDiagnosticEvent,
} from "./multi-session/hiddenClientRuntime.js";
import {
  gpuCapabilityScript,
  hiddenEnterPrivateRoomScript,
  hiddenRuntimeSummaryScript,
  hiddenWaitForRoomReadyScript,
  normalizeClientRuntimeSummary,
} from "./multi-session/hiddenClientScripts.js";
import { lookupOriginsUser } from "./originsUserLookup.js";
import { findRelayLogEntryReverse,readRelayLogDeltaSnapshot,readRelayLogSnapshot } from "./relayLog.js";
import { ShocklessEmbedController,readShocklessSettings,writeShocklessSettings } from "./shocklessEmbed.js";
import { detectAcceptedVersionCheckBuild } from "./versionCheckBuild.js";

const MAIN_CLIENT_ID = 1;
const RELAY_CONTROL_HOST = "127.0.0.1";
const MIMIC_POLL_INTERVAL_MS = 250;
const MIMIC_DUPLICATE_WINDOW_MS = 2000;
const DEFAULT_LOAD_CONCURRENCY = 3;
const MAX_LOAD_CONCURRENCY = 8;
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
  "autohidebulletin",
  "bind",
  "bindings",
  "chat",
  "client",
  "clients",
  "close",
  "carry",
  "carrydrink",
  "clear",
  "clickwindow",
  "clickwindowelement",
  "dance",
  "decline",
  "declinefriend",
  "enterpublic",
  "enterpublicroom",
  "enterroom",
  "exec",
  "filter",
  "flat",
  "follow",
  "followfriend",
  "fps",
  "friend",
  "friendrequests",
  "fx",
  "goto",
  "gpu",
  "hand",
  "headless",
  "help",
  "hcdance",
  "hidebulletin",
  "hidebulletinboard",
  "hidefurni",
  "hidefurniture",
  "hideinterface",
  "hideui",
  "hideusers",
  "hotelview",
  "history",
  "input",
  "inject",
  "inventory",
  "list",
  "load",
  "load-store",
  "login",
  "lookup",
  "lobby",
  "main",
  "message",
  "mimic",
  "msg",
  "names",
  "nav",
  "navigator",
  "newclient",
  "opennavigator",
  "packets",
  "perf",
  "perftrace",
  "pm",
  "private",
  "public",
  "publicroom",
  "rawpacket",
  "refreshrequests",
  "removefriend",
  "requestinventory",
  "rename",
  "requests",
  "room",
  "rooms",
  "roomzoom",
  "say",
  "scene-filter",
  "scenefilter",
  "select",
  "sendpacket",
  "sessions",
  "showfurni",
  "showfurniture",
  "showhotelview",
  "showinterface",
  "shownames",
  "showui",
  "showusers",
  "sleep",
  "smoothavatars",
  "smoothui",
  "stageclick",
  "stagezoom",
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
  "user",
  "wait",
  "walk",
  "wave",
  "windowclick",
  "zoom",
]);


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

interface SummonClientsResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly rendererActions: readonly ConsoleRendererAction[];
}

interface SummonClientResult extends GardeningRelayResult {
  readonly rendererActions?: readonly ConsoleRendererAction[];
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
    this.commandState = readCommandState(options.appDataPath, reservedCommandNames);
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
    if (settings.activeProfileId !== profile.id || settingBuild !== detected.build) {
      try {
        writeShocklessSettings(this.options.appDataPath, {
          activeProfileId: profile.id,
          versionCheckBuild: detected.build,
        });
        updated = true;
      } catch (writeError) {
        error = errorMessage(writeError);
        console.warn(`[shockless] failed to persist detected VERSIONCHECK setting ${detected.build}: ${error}`);
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
      console.warn(`[shockless] failed to persist detected VERSIONCHECK build ${detected.build}: ${message}`);
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
      const aliasMutation = applyDryRunAliasMutation(parsed.command, dryRunAliases, reservedCommandNames);
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
      preface: "Plaintext account file warning: the file is read for local runtime login only; passwords stay in memory and are not persisted by Shockless.",
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
    const lookup = await lookupOriginsUser(name, readShocklessSettings(this.options.appDataPath).realm);
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
      const lookup = await lookupOriginsUser(target, readShocklessSettings(this.options.appDataPath).realm);
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
    const selectedProfile = this.options.library.selectedProfile();
    if (selectedProfile?.profileRoot) await ensureProfileAudioCurrent(selectedProfile.profileRoot);
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
          // sandbox:false is required to call executeJavaScript() on the
          // hidden webContents for runtime snapshots and GPU diagnostics.
          // Mitigated by contextIsolation:true and nodeIntegration:false.
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
    const summary = snapshot.clients.find((entry) => entry.clientId === clientId);
    const latestClientPacket = [...packetEntries].reverse().find((entry) => entry.direction === "CLIENT") ?? null;
    const latestServerPacket = [...packetEntries].reverse().find((entry) => entry.direction === "SERVER") ?? null;
    return {
      clientId,
      logPath: summary?.logPath ?? snapshot.logPath,
      exists: summary?.exists ?? snapshot.exists,
      updatedAt: summary?.updatedAt ?? snapshot.updatedAt,
      totalLines: summary?.totalLines ?? entries.length,
      packetCount: summary?.packetCount ?? packetEntries.length,
      clientCount: summary?.clientCount ?? entries.filter((entry) => entry.direction === "CLIENT").length,
      serverCount: summary?.serverCount ?? entries.filter((entry) => entry.direction === "SERVER").length,
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
    this.mimicState.afterLineNumber = snapshot.nextLineNumber;
    this.mimicState.duplicatePackets.clear();
  }

  private async pollMimicRelayLog(): Promise<void> {
    if (!this.mimicState.enabled || this.mimicState.polling) return;
    this.mimicState.polling = true;
    try {
      for (let chunk = 0; chunk < 100; chunk += 1) {
        const snapshot = readRelayLogDeltaSnapshot(
          this.options.appDataPath,
          this.mimicState.currentLogPath,
          this.mimicState.afterLineNumber,
          this.relayLogClients(),
        );
        if (snapshot.reset && this.mimicState.currentLogPath) {
          this.mimicState.currentLogPath = snapshot.logPath;
          this.mimicState.afterLineNumber = snapshot.nextLineNumber;
          return;
        }

        this.mimicState.currentLogPath = snapshot.logPath;
        this.mimicState.afterLineNumber = snapshot.nextLineNumber;
        for (const entry of snapshot.entries) {
          await this.forwardMimicEntry(entry);
        }
        if (!snapshot.hasMore) break;
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
    const targetSet = new Set(targetClientIds);
    const match = findRelayLogEntryReverse(
      this.options.appDataPath,
      this.relayLogClients(),
      targetSet,
      (entry) => {
      const candidates = socialCandidatesFromFields(entry.decodedFields);
      for (const candidate of candidates) {
          if (normalizeSocialName(candidate.name) === normalizedTarget) return true;
        }
        return false;
      },
    );
    if (match) {
      for (const candidate of socialCandidatesFromFields(match.decodedFields)) {
        if (normalizeSocialName(candidate.name) === normalizedTarget) return candidate.accountId;
      }
    }
    return null;
  }
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
