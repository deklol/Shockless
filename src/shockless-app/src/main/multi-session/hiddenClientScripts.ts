import type { ClientRuntimeSummary } from "../../shared/window-api.js";

export function gpuCapabilityScript(settings: {
  readonly hardwareAccelerationActive: boolean;
  readonly hardwareAccelerationPreference: boolean;
  readonly launchSwitches: readonly string[];
}): string {
  const settingsJson = JSON.stringify({
    hardwareAccelerationActive: settings.hardwareAccelerationActive,
    hardwareAccelerationPreference: settings.hardwareAccelerationPreference,
    launchSwitches: settings.launchSwitches,
  });
  return `
    (() => {
      const settings = ${settingsJson};
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      const debug = gl && typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_debug_renderer_info") : null;
      const vendor = gl && debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null;
      const renderer = gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
      return {
        hardwareAccelerationActive: settings.hardwareAccelerationActive,
        hardwareAccelerationPreference: settings.hardwareAccelerationPreference,
        restartRequired: settings.hardwareAccelerationActive !== settings.hardwareAccelerationPreference,
        launchSwitches: settings.launchSwitches,
        webgl: Boolean(gl),
        vendor,
        renderer,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent
      };
    })()
  `;
}

export function hiddenEnterPrivateRoomScript(flatId: string, timeoutMs = 90000): string {
  return `
    (async () => {
      try {
        const dev = window.__engine?.dev;
        if (typeof dev?.enterPrivateRoom !== "function") {
          return { ok: false, message: "Private room entry helper is not available." };
        }
        const targetFlatId = ${JSON.stringify(flatId)};
        const valueFor = (source, keys) => {
          if (!source || typeof source !== "object") return null;
          for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
            const clean = String(key).replace(/^#/, "");
            if (source[clean] !== undefined && source[clean] !== null && source[clean] !== "") return source[clean];
          }
          const entries = Array.isArray(source.entries) ? source.entries : [];
          for (const key of keys) {
            const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match && match.value !== undefined && match.value !== null && match.value !== "") return match.value;
          }
          return null;
        };
        const activeFlatId = () => {
          const state = typeof dev.roomEntryState === "function" ? dev.roomEntryState() : null;
          const lastRoom = state?.lastroom && typeof state.lastroom === "object" ? state.lastroom : null;
          const roomComponent = state?.roomComponent && typeof state.roomComponent === "object" ? state.roomComponent : null;
          const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
          const candidate =
            valueFor(lastRoom, ["#flatId", "flatId", "#id", "id"]) ??
            valueFor(saveData, ["#flatId", "flatId", "#id", "id"]) ??
            roomComponent?.pReportRoomId ??
            roomComponent?.pRoomId ??
            null;
          return candidate == null ? "" : String(candidate);
        };
        const roomMatches = (state) => {
          if (!(state && state.ready === true)) return false;
          const roomId = activeFlatId() || (state.roomId == null ? "" : String(state.roomId));
          return roomId === targetFlatId || roomId === "f_" + targetFlatId;
        };
        const waitForTargetRoomReady = async (timeoutMs) => {
          const deadline = performance.now() + Math.max(1, Number(timeoutMs) || 90000);
          let state = typeof dev.roomReady === "function" ? dev.roomReady() : null;
          while (!roomMatches(state) && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            state = typeof dev.roomReady === "function" ? dev.roomReady() : null;
          }
          return state;
        };
        const closeWindowsByPattern = async (pattern) => {
          if (typeof dev.windowIds !== "function" || typeof dev.clickWindowElement !== "function") return [];
          const ids = await Promise.resolve(dev.windowIds()).catch(() => []);
          const windows = Array.isArray(ids) ? ids.map((id) => String(id)).filter((id) => pattern.test(id)) : [];
          const closed = [];
          const fallbackElementIds = [
            "Bulletin Board_close",
            "close",
            "button_close",
            "btn_close",
            "header_button_close",
            "close_button",
            "ok",
            "cancel",
          ];
          const flattenElements = (elements) => {
            const rows = [];
            const visit = (entry) => {
              if (!entry || typeof entry !== "object") return;
              rows.push(entry);
              const children = Array.isArray(entry.children) ? entry.children : [];
              for (const child of children) visit(child);
            };
            for (const entry of Array.isArray(elements) ? elements : []) visit(entry);
            return rows;
          };
          const scoreElement = (entry) => {
            const text = [entry.id, entry.class, entry.type, entry.text, entry.name, entry.member].join(" ").toLowerCase();
            if (!text.trim()) return 0;
            if (/\\b(close|closed|exit|cancel|ok|done)\\b/.test(text)) return 10;
            if (/x|cross/.test(text)) return 4;
            return 0;
          };
          for (const windowId of windows) {
            const elements = typeof dev.windowElements === "function" ? await Promise.resolve(dev.windowElements(windowId)).catch(() => []) : [];
            const ranked = flattenElements(elements)
              .filter((entry) => entry?.id != null)
              .map((entry) => ({ id: String(entry.id), score: scoreElement(entry) }))
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score);
            const candidates = [...new Set([...ranked.map((entry) => entry.id), ...fallbackElementIds])];
            for (const elementId of candidates) {
              const clicked = await Promise.resolve(dev.clickWindowElement(windowId, elementId)).catch(() => null);
              if (clicked && clicked.clicked !== false && !clicked.error) {
                closed.push({ windowId, elementId });
                break;
              }
            }
          }
          return closed;
        };
        const preClosedWindows = await closeWindowsByPattern(/bulletin|welcome|news/i);
        const result = await dev.enterPrivateRoom(targetFlatId, true, ${JSON.stringify(timeoutMs)});
        let roomReady = result && typeof result === "object" ? result.roomReady : null;
        if (!roomMatches(roomReady)) roomReady = await waitForTargetRoomReady(${JSON.stringify(timeoutMs)});
        const closedWindows = [...preClosedWindows, ...(await closeWindowsByPattern(/bulletin|welcome|news/i))];
        const ok = !(result && typeof result === "object" && result.ok === false) && roomMatches(roomReady);
        let message = "entered private room ${flatId}";
        if (typeof result === "string" && result.trim()) message = result;
        else if (result && typeof result === "object") {
          message = String(result.message ?? result.route ?? result.status ?? message);
        }
        if (!ok) message = message + "; targetRoomReady=false";
        return { ok, message, roomReady, closedWindows };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    })()
  `;
}

export function hiddenWaitForRoomReadyScript(timeoutMs: number, expectedRoomId?: string): string {
  return `
    (async () => {
      try {
        const dev = window.__engine?.dev;
        if (!dev) return { ok: false, message: "Shockless dev API is not ready.", roomReady: null };
        const expectedRoomId = ${JSON.stringify(expectedRoomId ?? null)};
        const valueFor = (source, keys) => {
          if (!source || typeof source !== "object") return null;
          for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
            const clean = String(key).replace(/^#/, "");
            if (source[clean] !== undefined && source[clean] !== null && source[clean] !== "") return source[clean];
          }
          const entries = Array.isArray(source.entries) ? source.entries : [];
          for (const key of keys) {
            const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match && match.value !== undefined && match.value !== null && match.value !== "") return match.value;
          }
          return null;
        };
        const activeFlatId = () => {
          const state = typeof dev.roomEntryState === "function" ? dev.roomEntryState() : null;
          const lastRoom = state?.lastroom && typeof state.lastroom === "object" ? state.lastroom : null;
          const roomComponent = state?.roomComponent && typeof state.roomComponent === "object" ? state.roomComponent : null;
          const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
          const candidate =
            valueFor(lastRoom, ["#flatId", "flatId", "#id", "id"]) ??
            valueFor(saveData, ["#flatId", "flatId", "#id", "id"]) ??
            roomComponent?.pReportRoomId ??
            roomComponent?.pRoomId ??
            null;
          return candidate == null ? "" : String(candidate);
        };
        const roomMatches = (state) => {
          if (!(state && state.ready === true)) return false;
          if (!expectedRoomId) return true;
          const roomId = activeFlatId() || (state.roomId == null ? "" : String(state.roomId));
          return roomId === expectedRoomId || roomId === "f_" + expectedRoomId;
        };
        const closeTransientWindows = async () => {
          if (typeof dev.windowIds !== "function" || typeof dev.clickWindowElement !== "function") return [];
          const ids = await Promise.resolve(dev.windowIds()).catch(() => []);
          const windows = Array.isArray(ids) ? ids.map((id) => String(id)).filter((id) => /bulletin|welcome|news/i.test(id)) : [];
          const closed = [];
          for (const windowId of windows) {
            const elementRows = typeof dev.windowElements === "function" ? await Promise.resolve(dev.windowElements(windowId)).catch(() => []) : [];
            const elementIds = [];
            const visit = (entry) => {
              if (!entry || typeof entry !== "object") return;
              const id = entry.id == null ? "" : String(entry.id);
              const text = [entry.id, entry.class, entry.type, entry.text, entry.name, entry.member].join(" ").toLowerCase();
              if (id && /close|cancel|ok|done|exit/.test(text)) elementIds.push(id);
              for (const child of Array.isArray(entry.children) ? entry.children : []) visit(child);
            };
            for (const row of Array.isArray(elementRows) ? elementRows : []) visit(row);
            const candidates = [
              ...new Set([
                ...elementIds,
                windowId + "_close",
                "Bulletin Board_close",
                "close",
                "button_close",
                "btn_close",
                "header_button_close",
                "close_button",
                "ok",
                "cancel",
              ]),
            ];
            for (const elementId of candidates) {
              const clicked = await Promise.resolve(dev.clickWindowElement(windowId, elementId)).catch(() => null);
              if (clicked && clicked.clicked !== false && !clicked.error) {
                closed.push({ windowId, elementId });
                break;
              }
            }
          }
          return closed;
        };
        let roomReady = null;
        const closedWindows = await closeTransientWindows();
        if (expectedRoomId && typeof dev.roomReady === "function") {
          const deadline = performance.now() + Math.max(1, ${JSON.stringify(timeoutMs)});
          roomReady = dev.roomReady();
          let lastCloseAt = performance.now();
          while (!roomMatches(roomReady) && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (performance.now() - lastCloseAt > 2000) {
              closedWindows.push(...(await closeTransientWindows()));
              lastCloseAt = performance.now();
            }
            roomReady = dev.roomReady();
          }
        } else if (typeof dev.waitForRoomReady === "function") {
          roomReady = await dev.waitForRoomReady(${JSON.stringify(timeoutMs)});
        } else if (typeof dev.roomReady === "function") {
          roomReady = dev.roomReady();
        }
        const ok = roomMatches(roomReady);
        const targetText = expectedRoomId ? " targetRoom=" + expectedRoomId : "";
        return { ok, message: ok ? "roomReady=true" + targetText : "roomReady=false" + targetText, roomReady, closedWindows };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error), roomReady: null };
      }
    })()
  `;
}

export function hiddenRuntimeSummaryScript(clientId: number): string {
  return `
    (() => {
      const compact = (value) => value === undefined || value === null || value === "" ? null : String(value);
      const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
      const valueFor = (source, keys) => {
        if (!source || typeof source !== "object") return null;
        for (const key of keys) {
          if (source[key] !== undefined) return source[key];
          const clean = String(key).replace(/^#/, "");
          if (source[clean] !== undefined) return source[clean];
        }
        const entries = Array.isArray(source.entries) ? source.entries : [];
        for (const key of keys) {
          const match = entries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
          if (match) return match.value;
        }
        return null;
      };
      try {
        const engine = window.__engine;
        const dev = engine?.dev;
        const roomReady = typeof dev?.roomReady === "function" ? dev.roomReady() : null;
        const roomEntryState = typeof dev?.roomEntryState === "function" ? dev.roomEntryState() : null;
        const performanceStats = typeof dev?.performanceStats === "function" ? dev.performanceStats() : null;
        const roomObjects = typeof engine?.roomObjects === "function" ? engine.roomObjects() : null;
        const sessionProps = typeof engine?.objectProps === "function" ? engine.objectProps("Session") : null;
        const props = sessionProps?.props ?? sessionProps?.properties ?? sessionProps;
        const itemList = props?.pitemlist ?? props?.pItemList ?? props?.PItemList;
        const roomEntries = Array.isArray(itemList?.entries) ? itemList.entries : [];
        const roomByKey = (keys) => {
          for (const key of keys) {
            const match = roomEntries.find((entry) => String(entry?.key ?? "").toLowerCase() === String(key).toLowerCase());
            if (match) return match.value;
          }
          return null;
        };
        const users = Array.isArray(roomObjects?.users) ? roomObjects.users : [];
        const sessionUserName =
          compact(props?.userName ?? props?.pUserName ?? props?.username) ??
          compact(users.find((user) => String(user?.rowId ?? user?.id ?? "") === "0")?.name) ??
          null;
        const lastRoom = roomEntryState?.lastroom && typeof roomEntryState.lastroom === "object" ? roomEntryState.lastroom : null;
        const roomComponent = roomEntryState?.roomComponent && typeof roomEntryState.roomComponent === "object" ? roomEntryState.roomComponent : null;
        const saveData = roomComponent?.pSaveData ?? roomComponent?.saveData ?? null;
        const roomName =
          compact(valueFor(lastRoom, ["#name", "name"])) ??
          compact(valueFor(saveData, ["#name", "name"])) ??
          compact(roomByKey(["#name", "name"])) ??
          compact(roomReady?.roomName) ??
          null;
        const roomId =
          compact(valueFor(lastRoom, ["#flatId", "#id", "flatId", "id"])) ??
          compact(valueFor(saveData, ["#flatId", "#id", "flatId", "id"])) ??
          compact(roomByKey(["#flatId", "#id", "flatId", "id"])) ??
          compact(roomReady?.roomId) ??
          compact(roomComponent?.pReportRoomId ?? roomComponent?.pRoomId) ??
          null;
        const roomOwner =
          compact(valueFor(lastRoom, ["#owner", "owner"])) ??
          compact(valueFor(saveData, ["#owner", "owner"])) ??
          compact(roomByKey(["#owner", "owner"])) ??
          null;
        const roomType =
          compact(valueFor(lastRoom, ["#type", "type"])) ??
          compact(valueFor(saveData, ["#type", "type"])) ??
          compact(roomByKey(["#type", "type"])) ??
          compact(roomReady?.roomType) ??
          null;
        return {
          clientId: ${JSON.stringify(clientId)},
          source: "hidden-runtime",
          updatedAt: new Date().toISOString(),
          roomReady: typeof roomReady?.ready === "boolean" ? roomReady.ready : null,
          roomId,
          roomName: roomName ?? (roomReady?.ready && roomId ? "Room " + roomId : null),
          roomType,
          roomOwner,
          userName: sessionUserName,
          userCount: users.length || numeric(roomReady?.roomLikeSpriteCount),
          fps: numeric(performanceStats?.rafPerSecond ?? performanceStats?.rafRate),
          frame: typeof engine?.frame === "function" ? numeric(engine.frame()) : null,
          error: null
        };
      } catch (error) {
        return {
          clientId: ${JSON.stringify(clientId)},
          source: "hidden-runtime",
          updatedAt: new Date().toISOString(),
          roomReady: null,
          roomId: null,
          roomName: null,
          roomType: null,
          roomOwner: null,
          userName: null,
          userCount: null,
          fps: null,
          frame: null,
          error: String(error?.message ?? error)
        };
      }
    })()
  `;
}

export function normalizeClientRuntimeSummary(clientId: number, raw: unknown, fallbackUserName: string | null): ClientRuntimeSummary {
  const value = isRecord(raw) ? raw : {};
  return {
    clientId,
    source: value.source === "hidden-runtime" || value.source === "visible-renderer" ? value.source : "hidden-runtime",
    updatedAt: stringOrNull(value.updatedAt),
    roomReady: typeof value.roomReady === "boolean" ? value.roomReady : null,
    roomId: stringOrNull(value.roomId),
    roomName: stringOrNull(value.roomName),
    roomType: stringOrNull(value.roomType),
    roomOwner: stringOrNull(value.roomOwner),
    userName: stringOrNull(value.userName) ?? fallbackUserName,
    userCount: finiteNumberOrNull(value.userCount),
    fps: finiteNumberOrNull(value.fps),
    frame: finiteNumberOrNull(value.frame),
    error: stringOrNull(value.error),
  };
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
