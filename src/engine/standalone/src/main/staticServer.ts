import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { RuntimeProfile } from "../common/types.js";
import { normalizeOriginsExternalVariables, ORIGINS_GAMEDATA_URLS } from "./originsGamedata.js";
import { repoRootFromStandalone } from "./profilePaths.js";

export class StandaloneStaticServer {
  private server: Server | null = null;
  private portValue = 0;
  private currentProfile: RuntimeProfile | null = null;
  private missingLogCount = 0;

  constructor(
    private readonly cacheRoot: string,
    private readonly options: { engineRoot?: string; profilesRoot?: string } = {},
  ) {}

  get port(): number {
    return this.portValue;
  }

  async start(profile: RuntimeProfile): Promise<string> {
    this.currentProfile = profile;
    if (this.server) return this.url(profile);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logServerError(error);
        if (!response.headersSent) {
          sendText(response, 500, "standalone static server error");
        } else {
          response.end();
        }
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolveStart());
    });
    const address = this.server.address();
    this.portValue = typeof address === "object" && address ? address.port : 0;
    return this.url(profile);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.portValue = 0;
    this.currentProfile = null;
  }

  url(profile: RuntimeProfile): string {
    return `http://127.0.0.1:${this.portValue}/?profile=${encodeURIComponent(profile.id)}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const profile = this.currentProfile;
    if (!profile) {
      sendText(response, 503, "No standalone profile is active.");
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const profileRoot = profile.profileRoot ?? join(this.options.profilesRoot ?? join(this.cacheRoot, "profiles"), profile.id);
    const engineRoot = this.options.engineRoot ?? repoRootFromStandalone();

    if (pathname.startsWith("/origins-data/")) {
      const relativePath = pathname.slice("/origins-data/".length);
      const [rootKey, ...rest] = relativePath.split("/");
      const requestPath = rest.join("/");
      const roots =
        rootKey === "client"
          ? [join(profileRoot, profile.paths.client)]
          : rootKey === "runtime-data"
            ? [join(profileRoot, profile.paths.runtimeData)]
            : rootKey === "assets"
              ? [join(profileRoot, profile.paths.assets)]
              : rootKey === "scripts"
                ? [join(profileRoot, profile.paths.scripts)]
              : [];
      const match = roots
        .map((root) => safeJoin(root, requestPath))
        .find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile());
      if (match) {
        if (rootKey === "client" && requestPath.toLowerCase() === "external_variables.txt") {
          sendText(response, 200, normalizeOriginsExternalVariables(readFileSync(match, "utf8")));
          return;
        }
        sendFile(response, match);
        return;
      }
      if (rootKey === "client") {
        const cachedGamedata = await this.cachedOriginsGamedata(requestPath);
        if (cachedGamedata) {
          sendFile(response, cachedGamedata);
          return;
        }
      }
      this.logMissing(pathname);
      sendText(response, 404, "not found");
      return;
    }

    const distRoot = join(engineRoot, "dist");
    const publicRoot = engineRoot;
    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const match = [safeJoin(distRoot, requested), safeJoin(publicRoot, requested)].find(
      (candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (match) {
      sendFile(response, match);
      return;
    }

    sendText(
      response,
      503,
      "Engine build not found. Run npm run build in the engine repo before launching standalone Play.",
    );
  }

  private logMissing(pathname: string): void {
    if (this.missingLogCount >= 5000) return;
    this.missingLogCount += 1;
    const logRoot = join(this.cacheRoot, "logs");
    mkdirSync(logRoot, { recursive: true });
    appendFileSync(join(logRoot, "static-server.log"), `[${new Date().toISOString()}] 404 ${pathname}\n`, "utf8");
  }

  private logServerError(error: unknown): void {
    const logRoot = join(this.cacheRoot, "logs");
    mkdirSync(logRoot, { recursive: true });
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    appendFileSync(join(logRoot, "static-server.log"), `[${new Date().toISOString()}] ERROR ${message}\n`, "utf8");
  }

  private async cachedOriginsGamedata(requestPath: string): Promise<string | null> {
    const normalizedPath = requestPath.replace(/\\/g, "/").toLowerCase();
    const sourceUrl = ORIGINS_GAMEDATA_URLS[normalizedPath];
    if (!sourceUrl) return null;

    const cacheDir = join(this.cacheRoot, "gamedata");
    mkdirSync(cacheDir, { recursive: true });
    const target = safeJoin(cacheDir, normalizedPath);
    if (!target) return null;

    if (existsSync(target)) {
      const stats = statSync(target);
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      if (stats.isFile() && stats.size > 0 && Date.now() - stats.mtimeMs < maxAgeMs) {
        return target;
      }
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${sourceUrl}: HTTP ${response.status}`);
    }
    const text = await response.text();
    writeFileSync(target, text, "utf8");
    return target;
  }
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
  response.end(readFileSync(filePath));
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
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
