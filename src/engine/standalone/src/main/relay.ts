import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { defaultRelayScript } from "./profilePaths.js";

export class OriginsRelayController {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;

  constructor(private readonly cacheRoot: () => string) {}

  async start(): Promise<void> {
    if (await isTcpOpen("127.0.0.1", 12326, 150)) return;
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    const script = defaultRelayScript();
    if (!existsSync(script)) {
      throw new Error(`Origins relay script not found: ${script}`);
    }
    const logPath = this.logPath();
    mkdirSync(join(this.cacheRoot(), "logs"), { recursive: true });
    writeFileSync(logPath, `\n[${new Date().toISOString()}] starting relay: ${script}\n`, { flag: "a" });
    this.logStream?.end();
    this.logStream = createWriteStream(logPath, { flags: "a" });
    const electronRunAsNode = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    const relayTrace = process.env.ORIGINS_STANDALONE_TRACE === "1" || process.env.ORIGINS_LOG_PACKETS === "1";
    this.child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        ...electronRunAsNode,
        ORIGINS_WS_HOST: "127.0.0.1",
        ORIGINS_WS_PORT: "12326",
        ...(relayTrace ? { ORIGINS_LOG_PACKETS: "1" } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.pipe(this.logStream, { end: false });
    this.child.stderr?.pipe(this.logStream, { end: false });
    this.child.on("exit", (code, signal) => {
      this.logStream?.write(`[${new Date().toISOString()}] relay exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    });

    const ready = await waitForTcp("127.0.0.1", 12326, 5000);
    if (!ready) {
      throw new Error(`Origins relay did not open ws://127.0.0.1:12326. See ${logPath}`);
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.logStream?.end();
    this.logStream = null;
  }

  logPath(): string {
    return join(this.cacheRoot(), "logs", "origins-relay.log");
  }
}

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpOpen(host, port, 250)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function isTcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
