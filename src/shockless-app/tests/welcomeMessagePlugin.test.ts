import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";

type Handler = (event: unknown) => unknown;

test("welcome message plugin sends one room chat welcome for a new non-self user", async () => {
  const moduleUrl = pathToFileURL(resolve("examples/premade-plugins/welcome-message/plugin.js")).href;
  const plugin = await import(moduleUrl) as { activate: (api: unknown) => Promise<() => void> };
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ readonly message: string; readonly options: unknown }> = [];
  const logs: string[] = [];
  const api = {
    log: {
      info: (message: unknown) => logs.push(String(message)),
      warn: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(String(message)),
    },
    events: {
      on: (name: string, handler: Handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
        return () => handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
      },
    },
    storage: {
      get: async (_key: string, fallback: unknown) => fallback,
    },
    chat: {
      send: async (message: string, options: unknown) => {
        sentMessages.push({ message, options });
        return { ok: true, message: "sent" };
      },
    },
  };

  const dispose = await plugin.activate(api);
  await emit(handlers, "room.userJoined", {
    clientId: 1,
    room: { id: "44390", name: "Codex Test LAB" },
    user: { accountId: "2", id: "2", name: "shockless", isSelf: false },
    initial: false,
  });
  await emit(handlers, "room.userJoined", {
    clientId: 1,
    room: { id: "44390", name: "Codex Test LAB" },
    user: { accountId: "2", id: "2", name: "shockless", isSelf: false },
    initial: false,
  });
  await emit(handlers, "room.userJoined", {
    clientId: 1,
    room: { id: "44390", name: "Codex Test LAB" },
    user: { accountId: "1", id: "1", name: "dek", isSelf: true },
    initial: false,
  });
  dispose();

  assert.deepEqual(sentMessages.map((entry) => entry.message), ["Welcome shockless!"]);
  assert.deepEqual(sentMessages[0]?.options, { clientId: 1 });
  assert.ok(logs.some((entry) => /ready/i.test(entry)));
  assert.ok(logs.some((entry) => /Welcomed shockless/i.test(entry)));
});

async function emit(handlers: Map<string, Handler[]>, name: string, event: unknown): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    await handler(event);
  }
}
