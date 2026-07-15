import type { CastRegistry } from "./members";
import { LINGO_VOID, LingoPropList, LingoSymbol, type LingoValue } from "./values";
import * as ops from "./ops";

const MAX_RETAINED_COMPLETED_NET_JOBS = 32;
const MAX_READY_PRELOAD_COMPLETIONS_PER_TICK = 4;

type NetJobState = "loading" | "done" | "failed";

interface NetJob {
  state: NetJobState;
  text: string;
  error: string | number;
  readonly url: string;
  readonly pacedPreload?: boolean;
  readyResult?: {
    readonly state: Exclude<NetJobState, "loading">;
    readonly text: string;
    readonly error: string | number;
  };
}

export interface DirectorNetJobsDependencies {
  members: CastRegistry;
  resolveUrl: (url: string) => string;
  fetchText: (url: string) => Promise<string>;
  tickCounter: () => number;
  log: (kind: "info" | "error", text: string) => void;
}

/** Owns Director's asynchronous net-job IDs and paced preload completion. */
export class DirectorNetJobs {
  private readonly jobs = new Map<number, NetJob>();
  private nextId = 1;
  private preloadCompletionTick = -1;
  private preloadCompletionsThisTick = 0;

  constructor(private readonly dependencies: DirectorNetJobsDependencies) {}

  call(name: string, args: LingoValue[]): LingoValue | undefined {
    switch (name) {
      case "preloadnetthing":
        return this.preloadNetThing(args[0] ?? LINGO_VOID);
      case "netdone":
        return this.netDone(args);
      case "preloaddone":
      case "preload":
        return this.preloadDone(args);
      case "getnettext":
        return this.getNetText(args[0] ?? LINGO_VOID);
      case "neterror": {
        const job = this.jobs.get(Number(args[0] ?? 0));
        if (!job || job.state === "loading") return "";
        return job.state === "done" ? "OK" : job.error;
      }
      case "nettextresult":
        return this.jobs.get(Number(args[0] ?? 0))?.text ?? "";
      case "netabort":
        this.jobs.delete(Number(args[0] ?? 0));
        return 1;
      case "getstreamstatus":
        return this.streamStatus(Number(args[0] ?? 0));
      default:
        return undefined;
    }
  }

  private preloadNetThing(value: LingoValue): number {
    const url = this.dependencies.resolveUrl(ops.stringOf(value));
    const id = this.allocate({ state: "loading", text: "", error: "", url, pacedPreload: true });
    if (/\.(cct|cst)(\?|$)/i.test(url)) {
      const base = url.split("/").pop()!.replace(/\.(cct|cst).*$/i, "");
      const exists = base.toLowerCase() === "empty" || this.dependencies.members.definedMembersOf(base).length > 0;
      this.queuePreloadResult(id, exists ? "done" : "failed", "", exists ? "OK" : 4165);
      return id;
    }
    this.dependencies.fetchText(url)
      .then((raw) => this.queuePreloadResult(id, "done", raw, "OK"))
      .catch(() => this.queuePreloadResult(id, "failed", "", 4165));
    return id;
  }

  private netDone(args: LingoValue[]): number {
    if (args.length > 0 && typeof args[0] === "number") {
      this.releaseReadyPreload(args[0]);
      const job = this.jobs.get(args[0]);
      return job === undefined || job.state !== "loading" ? 1 : 0;
    }
    this.releaseReadyPreload();
    return [...this.jobs.values()].every((job) => job.state !== "loading") ? 1 : 0;
  }

  private preloadDone(args: LingoValue[]): number {
    if (args.length === 0) {
      this.releaseReadyPreload();
      return [...this.jobs.values()].every((job) => job.state !== "loading") ? 1 : 0;
    }
    const id = Number(args[0] ?? 0);
    this.releaseReadyPreload(id);
    const job = this.jobs.get(id);
    return job === undefined || job.state !== "loading" ? 1 : 0;
  }

  private getNetText(value: LingoValue): number {
    const url = this.dependencies.resolveUrl(ops.stringOf(value));
    const id = this.allocate({ state: "loading", text: "", error: "", url });
    this.dependencies.log("info", `getNetText #${id} ${url}`);
    this.dependencies.fetchText(url)
      .then((raw) => {
        const text = raw.replace(/\r\n|\n/g, "\r");
        this.set(id, { state: "done", text, error: "OK", url });
        this.dependencies.log("info", `netDone #${id} (${text.length} chars)`);
      })
      .catch((error) => {
        this.set(id, { state: "failed", text: "", error: 4165, url });
        this.dependencies.log("error", `netError #${id} ${String(error)}`);
      });
    return id;
  }

  private streamStatus(id: number): LingoValue {
    const job = this.jobs.get(id);
    if (!job) return 0;
    const readyDone = job.readyResult?.state === "done";
    const bytes = job.text.length > 0 ? job.text.length : job.state === "done" || readyDone ? 1 : 0;
    return LingoPropList.fromPairs([
      [LingoSymbol.for("URL"), job.url],
      [LingoSymbol.for("state"), job.state === "done" ? "Complete" : job.state === "failed" ? "Error" : "InProgress"],
      [LingoSymbol.for("bytesSoFar"), job.state === "done" ? bytes : 0],
      [LingoSymbol.for("bytesTotal"), bytes],
      [LingoSymbol.for("error"), job.state === "failed" ? job.error : ""],
    ]);
  }

  private allocate(job: NetJob): number {
    const id = this.nextId;
    this.nextId += 1;
    this.set(id, job);
    return id;
  }

  private set(id: number, job: NetJob): void {
    this.jobs.set(id, job);
    if (job.state !== "loading") this.evictCompleted();
  }

  private queuePreloadResult(
    id: number,
    state: Exclude<NetJobState, "loading">,
    text: string,
    error: string | number,
  ): void {
    const existing = this.jobs.get(id);
    if (!existing || !existing.pacedPreload) {
      this.set(id, { state, text, error, url: existing?.url ?? "" });
      return;
    }
    existing.readyResult = { state, text, error };
  }

  private releaseReadyPreload(id?: number): void {
    const tick = this.dependencies.tickCounter();
    if (this.preloadCompletionTick !== tick) {
      this.preloadCompletionTick = tick;
      this.preloadCompletionsThisTick = 0;
    }
    if (this.preloadCompletionsThisTick >= MAX_READY_PRELOAD_COMPLETIONS_PER_TICK) return;
    const entries: Array<[number, NetJob | undefined]> = id !== undefined
      ? [[id, this.jobs.get(id)]]
      : [...this.jobs.entries()].filter(([, job]) => job.readyResult);
    for (const [, job] of entries) {
      if (!job?.readyResult || job.state !== "loading") continue;
      job.state = job.readyResult.state;
      job.text = job.readyResult.text;
      job.error = job.readyResult.error;
      job.readyResult = undefined;
      this.preloadCompletionsThisTick += 1;
      this.evictCompleted();
      return;
    }
  }

  private evictCompleted(): void {
    let completed = [...this.jobs.values()].filter((job) => job.state !== "loading").length;
    if (completed <= MAX_RETAINED_COMPLETED_NET_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (job.state === "loading") continue;
      this.jobs.delete(id);
      completed -= 1;
      if (completed <= MAX_RETAINED_COMPLETED_NET_JOBS) return;
    }
  }
}
