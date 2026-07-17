import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ORIGINS_STEAM_APP_ID, type SteamGuestMethod, type SteamGuestResult } from "../../shared/steam.js";
import { locateSteamOriginsInstallation } from "./SteamInstallationLocator.js";
import {
  expectedSteamBridgeFrameLength,
  parseSteamBridgeFrame,
  STEAM_BRIDGE_HEADER_LENGTH,
  STEAM_BRIDGE_NONCE_LENGTH,
  type SteamBridgeCredentials,
} from "./SteamBridgeProtocol.js";

const START_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 2_000;
const INITIAL_TICKET_COUNT = 1;
const TARGET_TICKET_COUNT = 1;
const MAX_BUFFERED_TICKETS = 2;
const BRIDGE_COMMAND_SHUTDOWN = 1;
const BRIDGE_COMMAND_ISSUE_TICKET = 2;
const BRIDGE_COMMAND_RETIRE_SUPERSEDED_TICKET = 3;

export class SteamBridgeManager {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private child: ChildProcess | null = null;
  private identity: Omit<SteamBridgeCredentials, "ticket"> | null = null;
  private readonly tickets: Buffer[] = [];
  private sessionNonce: Buffer | null = null;
  private pendingTicketRequests = 0;
  private deliveredTicketCount = 0;
  private startPromise: Promise<void> | null = null;
  private startCancel: (() => void) | null = null;
  private lifecycleGeneration = 0;

  get ready(): boolean {
    return this.identity !== null
      && this.child?.exitCode === null
      && this.socket !== null
      && !this.socket.destroyed
      && this.socket.writable
      && !this.socket.writableEnded;
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.stopActiveResources();
    const generation = ++this.lifecycleGeneration;
    const promise = this.startIsolatedBridge(generation).finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  call(method: SteamGuestMethod): SteamGuestResult {
    switch (method) {
      case "steamapi_init":
      case "steamapi_issteamrunning":
      case "steamapi_runcallbacks":
        return this.ready ? 1 : 0;
      case "steamapi_shutdown":
        // The bridge lifetime belongs to the embedding controller, not a page reload.
        return 1;
      case "isteamutils_isoverlayenabled":
        return this.identity?.overlayEnabled ? 1 : 0;
      case "isteamuser_getsteamid":
        return this.identity?.steamId.toString(10) ?? "";
      case "isteamuser_getauthsessionticket": {
        const ticket = this.tickets.shift();
        if (!ticket) {
          this.replenishTickets();
          return "";
        }
        const ticketHex = ticket.toString("hex");
        ticket.fill(0);
        this.retireSupersededTicketAfterConsumption();
        this.replenishTickets();
        return ticketHex;
      }
    }
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.startPromise = null;
    const cancelStart = this.startCancel;
    this.startCancel = null;
    cancelStart?.();
    this.stopActiveResources();
  }

  private stopActiveResources(): void {
    this.clearCredentials();
    this.sessionNonce?.fill(0);
    this.sessionNonce = null;
    this.pendingTicketRequests = 0;
    this.deliveredTicketCount = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      try {
        if (socket.writable && !socket.writableEnded) socket.end(Buffer.from([BRIDGE_COMMAND_SHUTDOWN]));
        else socket.destroy();
      } catch {
        socket.destroy();
      }
    }
    const server = this.server;
    this.server = null;
    server?.close();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, STOP_TIMEOUT_MS);
      timer.unref();
    }
  }

  private async startIsolatedBridge(generation: number): Promise<void> {
    const installation = await locateSteamOriginsInstallation();
    this.assertCurrentGeneration(generation);
    const helperPath = resolveSteamBridgeHelper();
    const nonce = randomBytes(STEAM_BRIDGE_NONCE_LENGTH);
    this.sessionNonce = nonce;
    const pipeName = `shockless-steam-${randomUUID().replaceAll("-", "")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    let buffered = Buffer.alloc(0);

    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        let startupSettled = false;
        let timeout: NodeJS.Timeout;
        const rejectOnce = (error: Error): void => {
          if (startupSettled) return;
          startupSettled = true;
          clearTimeout(timeout);
          if (this.startCancel === cancelStart) this.startCancel = null;
          rejectStart(error);
        };
        const cancelStart = (): void => rejectOnce(new Error("Steam Login start was cancelled."));
        this.startCancel = cancelStart;
        timeout = setTimeout(() => rejectOnce(new Error("Steam Login timed out while starting Steam.")), START_TIMEOUT_MS);
        const server = createServer((socket) => {
          if (!this.isCurrentGeneration(generation)) {
            socket.destroy();
            return;
          }
          if (this.socket) {
            socket.destroy();
            return;
          }
          this.socket = socket;
          socket.on("data", (chunk: Buffer) => {
            if (!this.isCurrentGeneration(generation)) return;
            const previous = buffered;
            buffered = Buffer.concat([buffered, chunk]);
            previous.fill(0);
            try {
              while (buffered.length >= STEAM_BRIDGE_HEADER_LENGTH) {
                const frameLength = expectedSteamBridgeFrameLength(buffered);
                if (frameLength === null || buffered.length < frameLength) return;
                const frame = Buffer.from(buffered.subarray(0, frameLength));
                const remainder = Buffer.from(buffered.subarray(frameLength));
                buffered.fill(0);
                buffered = remainder;
                try {
                  const credentials = parseSteamBridgeFrame(frame, nonce, ORIGINS_STEAM_APP_ID);
                  this.acceptCredentials(credentials);
                  if (this.pendingTicketRequests > 0) this.pendingTicketRequests -= 1;
                } finally {
                  frame.fill(0);
                }
              }
              if (!startupSettled && this.tickets.length >= INITIAL_TICKET_COUNT) {
                startupSettled = true;
                clearTimeout(timeout);
                if (this.startCancel === cancelStart) this.startCancel = null;
                server.close();
                if (this.server === server) this.server = null;
                resolveStart();
              }
            } catch (error) {
              const failure = error instanceof Error ? error : new Error("Steam bridge response is invalid.");
              if (!startupSettled) rejectOnce(failure);
              else this.stop();
            }
          });
          socket.once("error", () => {
            const failure = new Error("Steam Login lost its local bridge connection.");
            if (!startupSettled) rejectOnce(failure);
            else if (this.isCurrentGeneration(generation) && this.socket === socket) this.stop();
          });
          socket.once("close", () => {
            buffered.fill(0);
            if (!startupSettled) rejectOnce(new Error("Steam Login bridge closed before initialization."));
            else if (this.isCurrentGeneration(generation) && this.socket === socket) this.stop();
          });
        });
        this.server = server;
        server.once("error", (error) => rejectOnce(error));
        server.listen(pipePath, () => {
          if (!this.isCurrentGeneration(generation)) {
            server.close();
            rejectOnce(new Error("Steam Login start was cancelled."));
            return;
          }
          const child = spawn(
            helperPath,
            [
              "--steam-api", installation.steamApiPath,
              "--app-id", String(ORIGINS_STEAM_APP_ID),
              "--pipe-name", pipeName,
              "--nonce", nonce.toString("hex"),
            ],
            { cwd: installation.gameRoot, windowsHide: true, stdio: "ignore" },
          );
          this.child = child;
          child.once("error", () => rejectOnce(new Error("Steam Login bridge could not be launched.")));
          child.once("exit", (code) => {
            if (!startupSettled) rejectOnce(new Error(`Steam Login bridge exited during startup (${code ?? "unknown"}).`));
            else if (this.isCurrentGeneration(generation) && this.child === child) this.stop();
          });
        });
      });
    } catch (error) {
      buffered.fill(0);
      nonce.fill(0);
      if (this.isCurrentGeneration(generation)) this.stopActiveResources();
      throw error;
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.lifecycleGeneration === generation;
  }

  private assertCurrentGeneration(generation: number): void {
    if (!this.isCurrentGeneration(generation)) throw new Error("Steam Login start was cancelled.");
  }

  private clearCredentials(): void {
    for (const ticket of this.tickets.splice(0)) ticket.fill(0);
    this.identity = null;
  }

  private acceptCredentials(credentials: SteamBridgeCredentials): void {
    if (this.identity && (this.identity.appId !== credentials.appId || this.identity.steamId !== credentials.steamId)) {
      credentials.ticket.fill(0);
      throw new Error("Steam bridge identity changed during the active session.");
    }
    this.identity ??= {
      appId: credentials.appId,
      steamId: credentials.steamId,
      overlayEnabled: credentials.overlayEnabled,
    };
    if (this.tickets.length >= MAX_BUFFERED_TICKETS) {
      credentials.ticket.fill(0);
      throw new Error("Steam bridge supplied too many authentication tickets.");
    }
    this.tickets.push(credentials.ticket);
  }

  private replenishTickets(): void {
    if (!this.ready) return;
    const needed = Math.max(0, TARGET_TICKET_COUNT - this.tickets.length - this.pendingTicketRequests);
    for (let index = 0; index < needed; index += 1) {
      this.pendingTicketRequests += 1;
      if (!this.writeBridgeCommand(BRIDGE_COMMAND_ISSUE_TICKET)) {
        this.pendingTicketRequests -= 1;
        return;
      }
    }
  }

  private retireSupersededTicketAfterConsumption(): void {
    this.deliveredTicketCount += 1;
    if (this.deliveredTicketCount < 2) return;
    if (!this.ready) return;
    this.writeBridgeCommand(BRIDGE_COMMAND_RETIRE_SUPERSEDED_TICKET);
  }

  private writeBridgeCommand(command: number): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable || socket.writableEnded) return false;
    try {
      socket.write(Buffer.from([command]));
      return true;
    } catch {
      this.stop();
      return false;
    }
  }
}

function resolveSteamBridgeHelper(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? join(resourcesPath, "steam", "SteamBridge.exe") : "",
    resolve(process.cwd(), "native", "steam-bridge", "bin", "SteamBridge.exe"),
  ].filter(Boolean);
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (!helper) throw new Error("Steam Login bridge is missing. Rebuild or reinstall Shockless.");
  return helper;
}
