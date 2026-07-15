import { describe, expect, it } from "vitest";
import { RendererHealthMonitor } from "../../src/app/RendererHealthMonitor";

describe("RendererHealthMonitor", () => {
  it("tracks frames and standard WebGL context loss/restoration events", () => {
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    const canvas = Object.assign(new EventTarget(), { width: 1920, height: 1080 }) as unknown as HTMLCanvasElement;
    const monitor = new RendererHealthMonitor(canvas, "WebGLRenderer", () => now);

    monitor.markFrame();
    expect(monitor.snapshot()).toMatchObject({
      backend: "WebGLRenderer",
      contextState: "healthy",
      frameAgeMs: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
    });

    const loss = new Event("webglcontextlost", { cancelable: true });
    expect(canvas.dispatchEvent(loss)).toBe(false);
    now += 2_500;
    expect(monitor.snapshot()).toMatchObject({
      contextState: "lost",
      contextLossCount: 1,
      contextLostForMs: 2_500,
    });

    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(monitor.snapshot()).toMatchObject({
      contextState: "restored",
      contextRestoreCount: 1,
      contextLostForMs: 0,
    });

    monitor.dispose();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(monitor.snapshot().contextLossCount).toBe(1);
  });
});
