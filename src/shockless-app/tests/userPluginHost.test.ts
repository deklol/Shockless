import assert from "node:assert/strict";
import { test } from "node:test";
import { RendererUserPluginHost } from "../src/renderer/userPluginHost";
import type { PluginDefinition, PluginEntrySourceResult } from "../src/shared/plugin";

test("user plugin host does not start a worker after the plugin is disabled during load", async () => {
  const plugin: PluginDefinition = {
    id: "delayed-user-plugin",
    name: "Delayed User Plugin",
    category: "developer",
    icon: "puzzle",
    enabledByDefault: false,
    status: "ready",
    summary: "Test plugin",
    capabilities: ["Test"],
    uiSurfaces: [{ id: "panel", kind: "panel", label: "Panel", enabledByDefault: true, summary: "Panel", layout: [{ type: "text", text: "Test" }] }],
    sourceMapping: { habbpyV3: ["test"], shockless: ["test"] },
    origin: "user",
    entry: "plugin.js",
    permissions: ["ui.panel"],
  };
  let resolveSource!: (value: PluginEntrySourceResult) => void;
  let workerCount = 0;
  const globals = globalThis as unknown as {
    Worker?: unknown;
  };
  const urlStatics = URL as unknown as { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
  const previousWorker = globals.Worker;
  const previousCreateObjectURL = urlStatics.createObjectURL;
  const previousRevokeObjectURL = urlStatics.revokeObjectURL;
  globals.Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() { workerCount += 1; }
    postMessage(): void {}
    terminate(): void {}
  };
  urlStatics.createObjectURL = () => "blob:test";
  urlStatics.revokeObjectURL = () => {};

  try {
    const host = new RendererUserPluginHost({
      readEntrySource: () => new Promise<PluginEntrySourceResult>((resolve) => { resolveSource = resolve; }),
      handleRequest: async () => null,
      log: () => {},
    });

    host.sync([plugin], { [plugin.id]: true });
    host.sync([plugin], { [plugin.id]: false });
    resolveSource({ ok: true, pluginId: plugin.id, source: "export function activate() {}", message: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(workerCount, 0);
    host.dispose();
  } finally {
    globals.Worker = previousWorker;
    if (previousCreateObjectURL) urlStatics.createObjectURL = previousCreateObjectURL;
    else delete urlStatics.createObjectURL;
    if (previousRevokeObjectURL) urlStatics.revokeObjectURL = previousRevokeObjectURL;
    else delete urlStatics.revokeObjectURL;
  }
});
