export type RendererContextState = "healthy" | "lost" | "restored";

export interface RendererHealthSnapshot {
  readonly backend: string;
  readonly contextState: RendererContextState;
  readonly contextLossCount: number;
  readonly contextRestoreCount: number;
  readonly lastContextLossAt: string | null;
  readonly lastContextRestoreAt: string | null;
  readonly contextLostForMs: number;
  readonly lastFrameAt: string | null;
  readonly frameAgeMs: number | null;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export class RendererHealthMonitor {
  private contextState: RendererContextState = "healthy";
  private contextLossCount = 0;
  private contextRestoreCount = 0;
  private lastContextLossMs: number | null = null;
  private lastContextRestoreMs: number | null = null;
  private lastFrameMs: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly backend: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
  }

  markFrame(): void {
    this.lastFrameMs = this.now();
  }

  snapshot(): RendererHealthSnapshot {
    const now = this.now();
    return {
      backend: this.backend,
      contextState: this.contextState,
      contextLossCount: this.contextLossCount,
      contextRestoreCount: this.contextRestoreCount,
      lastContextLossAt: isoOrNull(this.lastContextLossMs),
      lastContextRestoreAt: isoOrNull(this.lastContextRestoreMs),
      contextLostForMs:
        this.contextState === "lost" && this.lastContextLossMs !== null ? Math.max(0, now - this.lastContextLossMs) : 0,
      lastFrameAt: isoOrNull(this.lastFrameMs),
      frameAgeMs: this.lastFrameMs === null ? null : Math.max(0, now - this.lastFrameMs),
      canvasWidth: Math.max(0, Number(this.canvas.width) || 0),
      canvasHeight: Math.max(0, Number(this.canvas.height) || 0),
    };
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored, false);
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextState = "lost";
    this.contextLossCount += 1;
    this.lastContextLossMs = this.now();
  };

  private readonly onContextRestored = (): void => {
    this.contextState = "restored";
    this.contextRestoreCount += 1;
    this.lastContextRestoreMs = this.now();
  };
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
