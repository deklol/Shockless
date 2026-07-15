import type { PluginDefinition, PluginEntrySourceResult, PluginPermission } from "../shared/plugin";

export interface UserPluginHostRequest {
  readonly id: number;
  readonly api: string;
  readonly args: unknown;
}

export interface UserPluginHostContext {
  readonly readEntrySource: (pluginId: string) => Promise<PluginEntrySourceResult>;
  readonly handleRequest: (plugin: PluginDefinition, request: UserPluginHostRequest) => Promise<unknown>;
  readonly log: (plugin: PluginDefinition, level: "info" | "warning" | "error", message: string) => void;
}

interface RuntimeRecord {
  readonly plugin: PluginDefinition;
  readonly worker: Worker;
  disposeTimer?: ReturnType<typeof setTimeout>;
}

export class RendererUserPluginHost {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly loading = new Set<string>();
  private expectedRuntimeIds = new Set<string>();

  constructor(private readonly context: UserPluginHostContext) {}

  sync(plugins: readonly PluginDefinition[], enabledById: Readonly<Record<string, boolean>>): void {
    const expected = new Set<string>();
    for (const plugin of plugins) {
      if (plugin.origin !== "user" || !plugin.entry || enabledById[plugin.id] === false) continue;
      expected.add(plugin.id);
      void this.ensureRuntime(plugin);
    }
    this.expectedRuntimeIds = expected;

    for (const pluginId of [...this.runtimes.keys()]) {
      if (!expected.has(pluginId)) this.disposeRuntime(pluginId);
    }
  }

  dispatchEvent(name: string, payload: unknown): void {
    for (const runtime of this.runtimes.values()) {
      if (!canReceiveEvent(runtime.plugin, name)) continue;
      runtime.worker.postMessage({ type: "event", name, payload });
    }
  }

  dispatchPluginEvent(pluginId: string, name: string, payload: unknown): void {
    const runtime = this.runtimes.get(pluginId);
    if (!runtime || !canReceiveEvent(runtime.plugin, name)) return;
    runtime.worker.postMessage({ type: "event", name, payload });
  }

  dispose(): void {
    for (const pluginId of [...this.runtimes.keys()]) this.disposeRuntime(pluginId);
    this.loading.clear();
    this.expectedRuntimeIds.clear();
  }

  private async ensureRuntime(plugin: PluginDefinition): Promise<void> {
    if (this.runtimes.has(plugin.id) || this.loading.has(plugin.id)) return;
    this.loading.add(plugin.id);
    try {
      const source = await this.context.readEntrySource(plugin.id);
      if (!this.expectedRuntimeIds.has(plugin.id)) return;
      if (!source.ok) {
        this.context.log(plugin, "warning", source.message);
        return;
      }

      const workerUrl = URL.createObjectURL(new Blob([userPluginWorkerSource()], { type: "text/javascript" }));
      const worker = new Worker(workerUrl, { type: "module", name: `habbpy-plugin-${plugin.id}` });
      URL.revokeObjectURL(workerUrl);
      const runtime: RuntimeRecord = { plugin, worker };
      this.runtimes.set(plugin.id, runtime);
      worker.onmessage = (event: MessageEvent) => void this.handleWorkerMessage(runtime, event.data);
      worker.onerror = (event) => {
        this.context.log(plugin, "error", event.message || "Plugin worker error.");
      };
      worker.postMessage({
        type: "init",
        plugin: {
          id: plugin.id,
          name: plugin.name,
          permissions: plugin.permissions ?? [],
          surfaces: plugin.uiSurfaces,
          managedRuntime: plugin.managedRuntime ?? null,
        },
        source: source.source,
      });
    } finally {
      this.loading.delete(plugin.id);
    }
  }

  private async handleWorkerMessage(runtime: RuntimeRecord, data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;
    const message = data as Record<string, unknown>;
    if (message.type === "log") {
      const level = message.level === "warning" || message.level === "error" ? message.level : "info";
      this.context.log(runtime.plugin, level, String(message.message ?? ""));
      return;
    }
    if (message.type === "status") {
      const status = String(message.status ?? "");
      if (status === "active") this.context.log(runtime.plugin, "info", "Plugin activated.");
      if (status === "disposed") {
        if (runtime.disposeTimer) clearTimeout(runtime.disposeTimer);
        runtime.worker.terminate();
      }
      return;
    }
    if (message.type !== "request") return;
    const request = normalizeHostRequest(message);
    if (!request) return;
    try {
      const result = await this.context.handleRequest(runtime.plugin, request);
      runtime.worker.postMessage({ type: "response", id: request.id, ok: true, result });
    } catch (error) {
      runtime.worker.postMessage({ type: "response", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private disposeRuntime(pluginId: string): void {
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) return;
    runtime.worker.postMessage({ type: "dispose" });
    this.runtimes.delete(pluginId);
    runtime.disposeTimer = setTimeout(() => runtime.worker.terminate(), 1500);
  }
}

function canReceiveEvent(plugin: PluginDefinition, name: string): boolean {
  const permission = permissionForEventName(name);
  if (!permission) return true;
  const permissions = plugin.permissions ?? [];
  if (permissions.includes(permission)) return true;
  if (permission === "events.packet") {
    return permissions.includes("packet.read") || permissions.includes("packet.intercept") || permissions.includes("packet.intercept.sensitive");
  }
  return false;
}

function permissionForEventName(name: string): PluginPermission | null {
  if (name === "packet" || name.startsWith("packet.")) return "events.packet";
  if (name.startsWith("chat.")) return "events.chat";
  if (name.startsWith("room.")) return "events.room";
  if (name.startsWith("ui.")) return "ui.panel";
  if (name.startsWith("session.") || name.startsWith("client.")) return "events.session";
  if (name.startsWith("runtime.") || name.startsWith("engine.")) return "engine.snapshot";
  return null;
}

function normalizeHostRequest(message: Record<string, unknown>): UserPluginHostRequest | null {
  const id = Number(message.id);
  const api = String(message.api ?? "");
  if (!Number.isInteger(id) || id < 0 || !api) return null;
  return { id, api, args: message.args };
}

function userPluginWorkerSource(): string {
  return `
function blockedPluginCapability(name) {
  return function () {
    throw new Error("Plugin capability blocked: " + name + ". Use Shockless host APIs instead.");
  };
}

function installBlockedGlobal(name) {
  const blocked = blockedPluginCapability(name);
  try {
    Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: blocked });
  } catch (_) {
    try { globalThis[name] = blocked; } catch (_) {}
  }
}

["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "BroadcastChannel", "importScripts", "eval", "Function"].forEach(installBlockedGlobal);
try {
  if (globalThis.navigator && "sendBeacon" in globalThis.navigator) Object.defineProperty(globalThis.navigator, "sendBeacon", { configurable: false, value: blockedPluginCapability("navigator.sendBeacon") });
  if (globalThis.navigator && "clipboard" in globalThis.navigator) Object.defineProperty(globalThis.navigator, "clipboard", { configurable: false, value: undefined });
} catch (_) {}
try {
  if ("localStorage" in globalThis) Object.defineProperty(globalThis, "localStorage", { configurable: false, value: undefined });
  if ("sessionStorage" in globalThis) Object.defineProperty(globalThis, "sessionStorage", { configurable: false, value: undefined });
  if ("indexedDB" in globalThis) Object.defineProperty(globalThis, "indexedDB", { configurable: false, value: undefined });
  if ("caches" in globalThis) Object.defineProperty(globalThis, "caches", { configurable: false, value: undefined });
} catch (_) {}
const nativeAddEventListener = typeof globalThis.addEventListener === "function" ? globalThis.addEventListener.bind(globalThis) : null;
if (nativeAddEventListener) {
  try {
    Object.defineProperty(globalThis, "addEventListener", {
      configurable: false,
      writable: false,
      value(type, listener, options) {
        const eventType = String(type || "").toLowerCase();
        if (eventType === "keydown" || eventType === "keyup" || eventType === "keypress" || eventType === "beforeinput") {
          throw new Error("Plugin keyboard event listeners are blocked. Use declared hotkeys or schema actions.");
        }
        return nativeAddEventListener(type, listener, options);
      },
    });
  } catch (_) {}
}

const pending = new Map();
const eventHandlers = new Map();
let nextRequestId = 1;
let disposeCallbacks = [];
const pluginInfo = {
  id: "",
  name: "",
  permissions: [],
  surfaces: [],
  managedRuntime: null,
};

function log(level, message) {
  postMessage({ type: "log", level, message: String(message ?? "") });
}

function request(api, args) {
  const id = nextRequestId++;
  postMessage({ type: "request", id, api, args });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function addHandler(name, handler) {
  const key = String(name || "");
  if (!key || typeof handler !== "function") return () => undefined;
  const handlers = eventHandlers.get(key) || new Map();
  const id = nextRequestId++;
  handlers.set(id, handler);
  eventHandlers.set(key, handlers);
  return () => {
    const current = eventHandlers.get(key);
    current?.delete(id);
    if (current?.size === 0) eventHandlers.delete(key);
  };
}

function normalizeTimeoutMs(options) {
  if (!options || typeof options !== "object") return null;
  const raw = options.timeoutMs ?? options.timeout;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function waitForEvent(name, options = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const off = addHandler(name, (payload) => {
      if (done) return undefined;
      done = true;
      if (timer !== null) clearTimeout(timer);
      off();
      resolve(payload);
      return undefined;
    });
    const timeoutMs = normalizeTimeoutMs(options);
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        reject(new Error("Timed out waiting for event " + String(name || "")));
      }, timeoutMs);
    }
  });
}

function waitForPacket(direction, filter = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const off = api.packets.on(direction, filter, (packet) => {
      if (done) return packet.allow();
      done = true;
      if (timer !== null) clearTimeout(timer);
      off();
      resolve(packet);
      return packet.allow();
    });
    const timeoutMs = normalizeTimeoutMs(options);
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        reject(new Error("Timed out waiting for packet."));
      }, timeoutMs);
    }
  });
}

function sleep(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration < 0) return Promise.reject(new Error("sleep requires a non-negative duration."));
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function createSubscriptionCollector() {
  const disposers = [];
  let disposed = false;
  return {
    add(disposer) {
      if (typeof disposer !== "function") return disposer;
      if (disposed) {
        try { disposer(); } catch (_) {}
      } else {
        disposers.push(disposer);
      }
      return disposer;
    },
    addAll(...items) {
      for (const item of items) this.add(item);
      return items;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try { dispose(); } catch (error) { log("error", error?.message || error); }
      }
    },
  };
}

function clientIdFromOptions(options) {
  if (typeof options === "number") return options;
  if (!options || typeof options !== "object") return undefined;
  return options.clientId;
}

function nowIso() {
  return new Date().toISOString();
}

function tileOf(entity) {
  const x = Number(entity?.x);
  const y = Number(entity?.y);
  const direction = Number(entity?.direction ?? 0);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x: Math.trunc(x), y: Math.trunc(y), direction: Number.isFinite(direction) ? Math.trunc(direction) : 0 };
  }
  const match = String(entity?.position ?? "").match(/(-?\d+)\s*,\s*(-?\d+)/);
  return match ? { x: Number.parseInt(match[1], 10), y: Number.parseInt(match[2], 10), direction: 0 } : null;
}

function objectIdOf(item) {
  const value = Number(item?.objectId ?? item?.id ?? item?.itemId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function itemKeyOf(item) {
  return String(item?.key ?? item?.objectId ?? item?.itemId ?? item?.id ?? item?.name ?? Math.random());
}

function userKeyOf(user) {
  return String(user?.accountId ?? user?.id ?? user?.name ?? "unknown").toLowerCase();
}

function itemSummaryOf(item) {
  if (!item) return null;
  const tile = item.tile ?? tileOf(item);
  return {
    key: item.key ?? null,
    kind: item.kind ?? null,
    id: objectIdOf(item),
    objectId: item.objectId ?? null,
    itemId: item.itemId ?? null,
    className: item.className ?? item.name ?? null,
    name: item.name ?? null,
    ownerName: item.ownerName ?? null,
    tile,
    x: item.x ?? tile?.x ?? null,
    y: item.y ?? tile?.y ?? null,
    wallLocation: item.wallLocation ?? null,
    wall: item.wall ?? null,
    local: item.local ?? null,
    orientation: item.orientation ?? item.direction ?? null,
    state: item.state ?? null,
  };
}

function itemSummaries(items) {
  return (Array.isArray(items) ? items : []).map(itemSummaryOf).filter(Boolean);
}

function countRoomItems(event) {
  return {
    users: event?.counts?.users ?? (Array.isArray(event?.users) ? event.users.length : 0),
    floor: (event?.floorItems ?? []).length,
    wall: (event?.wallItems ?? []).length,
    all: (event?.items ?? []).length,
  };
}

function floorItemsFromSnapshot(snapshot) {
  return [...(snapshot?.roomObjects?.activeObjects ?? []), ...(snapshot?.roomObjects?.passiveObjects ?? [])];
}

function wallItemsFromSnapshot(snapshot) {
  return snapshot?.roomObjects?.wallItems ?? [];
}

function keepSelectedItem(selected, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const selectedId = objectIdOf(selected);
  return selectedId ? items.find((item) => objectIdOf(item) === selectedId) ?? items[0] : items[0];
}

function parsePair(value) {
  if (Array.isArray(value) && value.length >= 2) return value.map(Number).slice(0, 2);
  const parts = String(value ?? "").match(/-?\d+/g)?.map(Number) ?? [];
  return parts.length >= 2 ? parts.slice(0, 2) : null;
}

function wallMoveLocation(item, options = {}) {
  const id = objectIdOf(item);
  if (!id) return null;
  const rawLocation = String(item?.rawLocation ?? "");
  const rawMatch = rawLocation.match(/:w=(-?\d+)\s*,\s*(-?\d+)\s+l=(-?\d+)\s*,\s*(-?\d+)\s+([lr])/i);
  const wall = rawMatch ? [Number.parseInt(rawMatch[1], 10), Number.parseInt(rawMatch[2], 10)] : parsePair(item?.wall ?? item?.wallLocation);
  const local = rawMatch ? [Number.parseInt(rawMatch[3], 10), Number.parseInt(rawMatch[4], 10)] : parsePair(item?.local ?? item?.wallLocation?.local);
  if (!wall || !local) return null;
  const deltaX = Number(options?.deltaX ?? 0);
  const deltaY = Number(options?.deltaY ?? 0);
  return {
    kind: "wall",
    itemId: id,
    wallX: wall[0] + (Number.isFinite(deltaX) ? Math.trunc(deltaX) : 0),
    wallY: wall[1] + (Number.isFinite(deltaY) ? Math.trunc(deltaY) : 0),
    localX: local[0],
    localY: local[1],
    orientation: options?.orientation || rawMatch?.[5] || item?.orientation || item?.direction || item?.wallLocation?.orientation || "l",
    className: item?.className ?? item?.name,
  };
}

function wallLocationFromStagePoint(item, point = {}, options = {}) {
  const base = wallMoveLocation(item, options);
  if (!base) return null;
  const stageX = Number(point?.x ?? point?.stageX ?? point?.localX);
  const stageY = Number(point?.y ?? point?.stageY ?? point?.localY);
  if (!Number.isFinite(stageX) || !Number.isFinite(stageY)) return null;
  const sourceX = Number(options?.sourceX ?? item?.x ?? item?.raw?.x);
  const sourceY = Number(options?.sourceY ?? item?.y ?? item?.raw?.y);
  const wallX = Number(options?.wallX);
  const wallY = Number(options?.wallY);
  return {
    kind: "wall",
    itemId: base.itemId,
    wallX: Number.isFinite(wallX) ? Math.trunc(wallX) : base.wallX,
    wallY: Number.isFinite(wallY) ? Math.trunc(wallY) : base.wallY,
    localX: Number.isFinite(sourceX) ? base.localX + Math.round(stageX - sourceX) : Math.round(stageX),
    localY: Number.isFinite(sourceY) ? base.localY + Math.round(stageY - sourceY) : Math.round(stageY),
    orientation: options?.orientation || base.orientation,
    className: base.className,
  };
}

function packetSummary(packet) {
  return {
    clientId: packet?.clientId ?? null,
    direction: packet?.direction ?? null,
    header: packet?.header ?? null,
    packetName: packet?.packetName ?? "UNKNOWN_HEADER",
    lineNumber: packet?.lineNumber ?? null,
    fields: packet?.decodedFields ?? [],
    bodyStatus: packet?.bodyStatus ?? null,
  };
}

function packetHasName(packet, ...names) {
  const packetName = String(packet?.packetName ?? "").toLowerCase();
  return names.flat().map((name) => String(name).toLowerCase()).some((name) => packetName === name || packetName.includes(name));
}

function packetField(packet, matcher) {
  const fields = packet?.decodedFields ?? [];
  if (matcher instanceof RegExp) return fields.find((field) => matcher.test(String(field?.label ?? ""))) ?? null;
  const wanted = String(matcher ?? "").toLowerCase();
  return fields.find((field) => String(field?.label ?? "").toLowerCase() === wanted) ?? null;
}

function dispatchEvent(name, payload) {
  const exactName = String(name || "");
  const handlerGroups = [eventHandlers.get(exactName), exactName === "*" ? null : eventHandlers.get("*")].filter(Boolean);
  for (const handlers of handlerGroups) {
    for (const handler of handlers.values()) {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((error) => log("error", error?.message || error));
    }
  }
}

function packetEvent(packet) {
  return {
    ...packet,
    allow: () => ({ action: "allow" }),
    block: (reason) => ({ action: "block", reason }),
    replace: (nextPacket) => ({ action: "replace", packet: nextPacket }),
    inject: (nextPacket) => ({ action: "inject", packet: nextPacket }),
  };
}

const api = {
  plugin: pluginInfo,
  subscriptions: {
    create: createSubscriptionCollector,
  },
  log: {
    info: (message) => log("info", message),
    warn: (message) => log("warning", message),
    error: (message) => log("error", message),
  },
  events: {
    on: addHandler,
    once: waitForEvent,
    waitFor: waitForEvent,
    emit: (name, payload = {}) => {
      dispatchEvent(name, payload);
      return true;
    },
    defineFromPacket: (eventName, direction = "all", filter = {}, mapper = (packet) => packet) =>
      api.packets.on(direction, filter, (packet) => {
        const payload = mapper(packet);
        if (payload !== undefined) dispatchEvent(eventName, payload);
        return packet.allow();
      }),
  },
  packets: {
    summary: packetSummary,
    hasName: packetHasName,
    field: packetField,
    on(direction, filter, handler) {
      const normalizedDirection = String(direction || "all").toLowerCase();
      const eventName = normalizedDirection === "all" || normalizedDirection === "*" ? "packet" : "packet." + normalizedDirection;
      return addHandler(eventName, (packet) => {
        const wantedHeader = filter && Object.prototype.hasOwnProperty.call(filter, "header") ? Number(filter.header) : null;
        const wantedName = filter?.packetName ? String(filter.packetName).toUpperCase() : "";
        if (wantedHeader !== null && packet?.header !== wantedHeader) return undefined;
        if (wantedName && String(packet?.packetName || "").toUpperCase() !== wantedName) return undefined;
        return handler(packetEvent(packet));
      });
    },
    once: waitForPacket,
    waitFor: waitForPacket,
    send: (clientId, packet) => request("packets.send", { clientId, packet }),
    sendRaw: (target, packetText, options = {}) => request("packets.send", {
      clientId: options.clientId,
      packet: { target, packetText },
    }),
  },
  timers: {
    sleep,
  },
  chat: {
    send: (message, options = {}) => request("chat.send", { message, options }),
    say: (message, options = {}) => request("chat.send", { message, options }),
    shout: (message, options = {}) => request("chat.shout", { message, options }),
    whisper: (target, message, options = {}) => request("chat.whisper", { target, message, options }),
    onMessage: (handler) => addHandler("chat.message", handler),
  },
  stage: {
    click: (x, y, options = {}) => request("stage.click", { x, y, options }),
    captureNextClick: (options = {}) => request("stage.captureNextClick", { options }),
    nextClick: (options = {}) => request("stage.captureNextClick", { options }),
  },
  rooms: {
    enterPrivateRoom: (flatId, options = {}) => request("rooms.enterPrivateRoom", { flatId, options }),
    enterPublicRoom: (query, options = {}) => request("rooms.enterPublicRoom", { query, options }),
    leave: (options = {}) => request("rooms.leave", { options }),
  },
  navigator: {
    open: (view = "nav_pr", options = {}) => request("navigator.open", { view, options }),
  },
  windows: {
    clickElement: (windowId, elementId, options = {}) => request("windows.clickElement", { windowId, elementId, options }),
  },
  room: {
    tileOf,
    objectId: objectIdOf,
    itemKey: itemKeyOf,
    userKey: userKeyOf,
    summarizeItem: itemSummaryOf,
    summarizeItems: itemSummaries,
    countItems: countRoomItems,
    floorItemsFromSnapshot,
    wallItemsFromSnapshot,
    keepSelectedItem,
    keepSelectedWallItem: keepSelectedItem,
    getState: (options = {}) => request("engine.getSnapshot", { clientId: clientIdFromOptions(options) }),
    onChanged: (handler) => addHandler("room.changed", handler),
    onReady: (handler) => addHandler("room.ready", handler),
    onUsers: (handler) => addHandler("room.users", handler),
    onUserJoined: (handler) => addHandler("room.userJoined", handler),
    onUserLeft: (handler) => addHandler("room.userLeft", handler),
    onItems: (handler) => addHandler("room.items", handler),
    onItemAdded: (handler) => addHandler("room.itemAdded", handler),
    onItemUpdated: (handler) => addHandler("room.itemUpdated", handler),
    onItemRemoved: (handler) => addHandler("room.itemRemoved", handler),
    onFloorItems: (handler) => addHandler("room.floorItemsLoaded", handler),
    onFloorItemAdded: (handler) => addHandler("room.floorItemAdded", handler),
    onFloorItemUpdated: (handler) => addHandler("room.floorItemUpdated", handler),
    onFloorItemRemoved: (handler) => addHandler("room.floorItemRemoved", handler),
    onWallItems: (handler) => addHandler("room.wallItemsLoaded", handler),
    onWallItemAdded: (handler) => addHandler("room.wallItemAdded", handler),
    onWallItemUpdated: (handler) => addHandler("room.wallItemUpdated", handler),
    onWallItemRemoved: (handler) => addHandler("room.wallItemRemoved", handler),
  },
  avatar: {
    walkTo: (x, y, furniId = 0, options = {}) => request("avatar.walkTo", { x, y, furniId, options }),
    walkToArea: (selector, options = {}) => request("avatar.walkToArea", { selector, options }),
    walkToItem: (selector, options = {}) => request("avatar.walkToItem", { selector, options }),
    walkToUser: (selector, options = {}) => request("avatar.walkToUser", { selector, options }),
    wave: (options = {}) => request("avatar.wave", { options }),
    dance: (number = 1, options = {}) => request("avatar.dance", { number, options }),
    stopDance: (options = {}) => request("avatar.stopDance", { options }),
    hcDance: (number = 1, options = {}) => request("avatar.hcDance", { number, options }),
    carryDrink: (options = {}) => request("avatar.carryDrink", { options }),
    applyLook: (figure, options = {}) => request("avatar.applyLook", { figure, options }),
  },
  social: {
    message: (accountId, message, options = {}) => request("social.message", { accountId, message, options }),
    addUser: (name, options = {}) => request("social.addUser", { name, options }),
    refreshRequests: (options = {}) => request("social.refreshRequests", { options }),
    acceptRequest: (accountId, options = {}) => request("social.acceptRequest", { accountId, options }),
    declineRequest: (accountId, options = {}) => request("social.declineRequest", { accountId, options }),
    removeFriend: (accountId, options = {}) => request("social.removeFriend", { accountId, options }),
    followFriend: (accountId, options = {}) => request("social.followFriend", { accountId, options }),
  },
  plants: {
    getState: (options = {}) => request("plants.getState", { options }),
    findPlants: (selector = {}, options = {}) => request("plants.findPlants", { selector, options }),
    planCycle: (selector = {}, options = {}) => request("plants.planCycle", { selector, options }),
    runCycle: (selector = {}, options = {}) => request("plants.runCycle", { selector, options }),
    movePlant: (objectId, x, y, direction = 0, options = {}) => request("plants.movePlant", { objectId, x, y, direction, options }),
    waterPlant: (objectId, options = {}) => request("plants.waterPlant", { objectId, options }),
    harvestPlant: (objectId, options = {}) => request("plants.harvestPlant", { objectId, options }),
    compostPlant: (objectId, options = {}) => request("plants.compostPlant", { objectId, options }),
  },
  wallItems: {
    setAnywherePlacementEnabled: (enabled, options = {}) => request("wallItems.setAnywherePlacementEnabled", { enabled, options }),
    locationFromStagePoint: (item, point, options = {}) => request("wallItems.locationFromStagePoint", { selector: item, point, options }),
    moveAnywhere: (item, pointOrLocation, options = {}) => request("wallItems.moveAnywhere", { selector: item, pointOrLocation, options }),
    placeAnywhere: (item, pointOrLocation, options = {}) => request("wallItems.placeAnywhere", { selector: item, pointOrLocation, options }),
    moveItem: (item, options = {}) => request("wallItems.moveItem", { item, options }),
    pickupItem: (itemId, options = {}) => request("wallItems.pickupItem", { itemId, options }),
  },
  filters: {
    getHiddenUsers: (options = {}) => request("filters.getHiddenUsers", { options }),
    setHiddenUsers: (entries, options = {}) => request("filters.setHiddenUsers", { entries, options }),
    addHiddenUser: (target, options = {}) => request("filters.addHiddenUser", { target, options }),
    removeHiddenUser: (target, options = {}) => request("filters.removeHiddenUser", { target, options }),
    clearHiddenUsers: (options = {}) => request("filters.clearHiddenUsers", { options }),
  },
  teleport: {
    enter: (selector, options = {}) => request("teleport.enter", { selector, options }),
  },
  furni: {
    wallMoveLocation,
    setAnywherePlacementEnabled: (enabled, options = {}) => request("furni.setAnywherePlacementEnabled", { enabled, options }),
    findItems: (selector = {}, options = {}) => request("furni.findItems", { selector, options }),
    findItem: (selector = {}, options = {}) => request("furni.findItem", { selector, options }),
    moveFloorItem: (selector, x, y, direction = null, options = {}) => request("furni.moveFloorItem", { selector, x, y, direction, options }),
    setFloorItemLocation: (selector, x, y, height = 0, options = {}) => request("furni.setFloorItemLocation", { selector, x, y, height, options }),
    rotateFloorItem: (selector, direction, options = {}) => request("furni.rotateFloorItem", { selector, direction, options }),
    useFloorItem: (selector, value = "0", options = {}) => request("furni.useFloorItem", { selector, value, options }),
    pickupFloorItem: (selector, options = {}) => request("furni.pickupFloorItem", { selector, options }),
    moveWallItem: (selector, location, options = {}) => request("furni.moveWallItem", { selector, location, options }),
    pickupWallItem: (selector, options = {}) => request("furni.pickupWallItem", { selector, options }),
    pickupItem: (selector, options = {}) => request("furni.pickupItem", { selector, options }),
  },
  fishing: {
    getState: (options = {}) => request("fishing.getState", { options }),
    walkToArea: (areaIdOrOptions = null, options = {}) => {
      const areaId = areaIdOrOptions && typeof areaIdOrOptions === "object" ? null : areaIdOrOptions;
      const resolvedOptions = areaIdOrOptions && typeof areaIdOrOptions === "object" ? areaIdOrOptions : options;
      return request("fishing.walkToArea", { areaId, options: resolvedOptions });
    },
    startFishing: (areaId, options = {}) => request("fishing.startFishing", { areaId, options }),
    minigameInput: (direction, options = {}) => request("fishing.minigameInput", { direction, options }),
    purchaseProduct: (productCode, options = {}) => request("fishing.purchaseProduct", { productCode, options }),
    registerDerby: (options = {}) => request("fishing.registerDerby", { options }),
    requestTokens: (options = {}) => request("fishing.requestTokens", { options }),
    requestProducts: (options = {}) => request("fishing.requestProducts", { options }),
    requestRodLevel: (options = {}) => request("fishing.requestRodLevel", { options }),
    requestStats: (options = {}) => request("fishing.requestStats", { options }),
    requestFishopedia: (options = {}) => request("fishing.requestFishopedia", { options }),
  },
  runtime: {
    getSnapshot: (options = {}) => request("engine.getSnapshot", { clientId: clientIdFromOptions(options) }),
    onSnapshot: (handler) => addHandler("runtime.snapshot", handler),
  },
  engine: {
    getSnapshot: (clientId) => request("engine.getSnapshot", { clientId }),
  },
  notifications: {
    showBulletin: (notification = {}) => request("notifications.showBulletin", notification),
  },
  client: {
    getRights: (options = {}) => request("client.getRights", { options }),
    setRights: (rights, options = {}) => request("client.setRights", { rights, options }),
    grantRights: (rights, options = {}) => request("client.grantRights", { rights, options }),
    removeRights: (rights, options = {}) => request("client.removeRights", { rights, options }),
    enableChooserCommands: (options = {}) => request("client.enableChooserCommands", { options }),
  },
  session: {
    getClients: () => request("session.getClients", {}),
    onSelected: (handler) => addHandler("session.selected", handler),
  },
  storage: {
    get: (key, fallbackValue = null) => request("storage.get", { key }).then((value) => value === null || value === undefined ? fallbackValue : value),
    set: (key, value) => request("storage.set", { key, value }),
    remember: (key, value) => request("storage.set", { key, value: { value, updatedAt: nowIso() } }),
    delete: (key) => request("storage.delete", { key }),
  },
  console: {
    registerCommand: (command) => request("console.registerCommand", { command }),
  },
  ui: {
    registerPanel: (surface) => request("ui.registerSurface", { surface }),
    registerSurface: (surface) => request("ui.registerSurface", { surface }),
    updateSurface: (surfaceId, layout) => request("ui.updateSurface", { surfaceId, layout }),
    setValue: (key, value) => request("ui.setValue", { key, value }),
    onAction: (handler) => addHandler("ui.action", handler),
  },
};

async function activatePlugin(source) {
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const pluginModule = await import(moduleUrl);
    if (typeof pluginModule.activate !== "function") throw new Error("Plugin entry must export activate(api).");
    const dispose = await pluginModule.activate(api);
    if (typeof dispose === "function") disposeCallbacks.push(dispose);
    postMessage({ type: "status", status: "active" });
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    const plugin = message.plugin && typeof message.plugin === "object" ? message.plugin : {};
    pluginInfo.id = String(plugin.id ?? "");
    pluginInfo.name = String(plugin.name ?? "");
    pluginInfo.permissions = Array.isArray(plugin.permissions) ? plugin.permissions.map((entry) => String(entry)) : [];
    pluginInfo.surfaces = Array.isArray(plugin.surfaces) ? plugin.surfaces : [];
    pluginInfo.managedRuntime = plugin.managedRuntime && typeof plugin.managedRuntime === "object" ? plugin.managedRuntime : null;
    activatePlugin(String(message.source || "")).catch((error) => log("error", error?.message || error));
    return;
  }
  if (message.type === "response") {
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    pending.delete(message.id);
    if (message.ok) pendingRequest.resolve(message.result);
    else pendingRequest.reject(new Error(String(message.error || "Plugin host request failed.")));
    return;
  }
  if (message.type === "event") {
    dispatchEvent(message.name, message.payload);
    return;
  }
  if (message.type === "dispose") {
    const callbacks = disposeCallbacks.splice(0);
    Promise.allSettled(callbacks.map((dispose) => Promise.resolve().then(dispose)))
      .then(() => postMessage({ type: "status", status: "disposed" }))
      .catch((error) => {
        log("error", error?.message || error);
        postMessage({ type: "status", status: "disposed" });
      });
  }
};
`;
}
