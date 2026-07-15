import { LingoPoint, LingoRect } from "@director/geometry";
import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoFloat, LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";

/** Optional plugin-facing override for source wall-furni placement validation. */
export interface WallItemAnywherePlacementController {
  setEnabled(enabled: boolean): Record<string, unknown>;
  isEnabled(): boolean;
  summary(): Record<string, unknown>;
}

interface WallAnchor {
  readonly part: LingoPropList;
  readonly direction: "leftwall" | "rightwall";
  readonly sprite: SpriteChannel | null;
}

const controllers = new WeakMap<Runtime, WallItemAnywherePlacementController>();

export function installWallItemAnywhereCompatibility(runtime: Runtime): WallItemAnywherePlacementController {
  const existing = controllers.get(runtime);
  if (existing) return existing;

  let enabled = false;
  let synthesizedCount = 0;
  let lastAnchor: WallAnchor | null = null;
  const originalCallMethod = runtime.callMethod.bind(runtime);

  const controller: WallItemAnywherePlacementController = {
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) lastAnchor = null;
      return this.summary();
    },
    isEnabled() {
      return enabled;
    },
    summary() {
      return {
        enabled,
        synthesizedCount,
        lastAnchor: lastAnchor
          ? {
              direction: lastAnchor.direction,
              wallLocation: pointSummary(propPoint(lastAnchor.part, "locx", "locy")),
              partRect: rectSummary(propRect(lastAnchor.part, "screenrect")),
            }
          : null,
      };
    },
  };

  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    const result = originalCallMethod(receiver, method, args);
    if (!isObjectMoverWallHitTest(runtime, receiver, method)) return result;

    if (isInsideWall(result)) {
      const anchor = args[0] instanceof LingoRect ? nearestWallAnchor(receiver, args[0], originalCallMethod) : null;
      if (anchor) lastAnchor = anchor;
      return result;
    }

    if (!enabled) return result;
    const rect = args[0];
    if (!(rect instanceof LingoRect)) return result;

    const anchor = lastAnchor ?? nearestWallAnchor(receiver, rect, originalCallMethod);
    if (!anchor) return result;

    const synthetic = syntheticWallHit(rect, anchor);
    lastAnchor = anchor;
    synthesizedCount += 1;
    return synthetic;
  };

  controllers.set(runtime, controller);
  return controller;
}

function isObjectMoverWallHitTest(runtime: Runtime, receiver: LingoValue, method: string): receiver is ScriptInstance {
  return (
    receiver instanceof ScriptInstance &&
    receiver.module.scriptName === "Visualizer Instance Class" &&
    method.toLowerCase() === "getwallpartunderrect" &&
    runtime.callStack.some((entry) => entry.toLowerCase() === "object mover class.moveitem")
  );
}

function isInsideWall(value: LingoValue): boolean {
  return value instanceof LingoPropList && ops.truthy(value.getaProp(LingoSymbol.for("insideWall"), ops.lingoKeyEquals));
}

function nearestWallAnchor(
  visualizer: ScriptInstance,
  rect: LingoRect,
  originalCallMethod: Runtime["callMethod"],
): WallAnchor | null {
  const wrappers = visualizer.props.get("pwrappedparts");
  const candidates = wrappers instanceof LingoList ? wrappers.items : wrappers instanceof LingoPropList ? wrappers.values : [];
  let best: { readonly anchor: WallAnchor; readonly distance: number } | null = null;

  for (const candidate of candidates) {
    if (!(candidate instanceof ScriptInstance)) continue;
    const direction = wrapperDirection(candidate, originalCallMethod);
    if (!direction) continue;
    const partList = candidate.props.get("ppartlist");
    if (!(partList instanceof LingoList)) continue;
    const sprite = wrapperSprite(candidate);

    for (const part of partList.items) {
      if (!(part instanceof LingoPropList)) continue;
      const screenRect = propRect(part, "screenrect");
      if (!screenRect) continue;
      const distance = rectDistance(rect, screenRect);
      if (!best || distance < best.distance) {
        best = { anchor: { part, direction, sprite }, distance };
      }
    }
  }

  return best?.anchor ?? null;
}

function syntheticWallHit(rect: LingoRect, anchor: WallAnchor): LingoPropList {
  const screenRect = propRect(anchor.part, "screenrect") ?? new LingoRect(0, 0, 0, 0);
  const wallLocation = propPoint(anchor.part, "locx", "locy");
  const local = new LingoPoint(Math.round(rect.left - screenRect.left), Math.round(rect.top - screenRect.top));
  const wallSprites = anchor.sprite ? new LingoList([anchor.sprite]) : 0;
  return LingoPropList.fromPairs([
    [LingoSymbol.for("insideWall"), 1],
    [LingoSymbol.for("wallLocation"), wallLocation],
    [LingoSymbol.for("localCoordinate"), local],
    [LingoSymbol.for("direction"), anchor.direction],
    [LingoSymbol.for("wallSprites"), wallSprites],
  ]);
}

function wrapperDirection(wrapper: ScriptInstance, originalCallMethod: Runtime["callMethod"]): "leftwall" | "rightwall" | null {
  const rawType = originalCallMethod(wrapper, "getproperty", [LingoSymbol.for("type")]);
  const text = rawType instanceof LingoSymbol ? rawType.name.toLowerCase() : String(ops.stringOf(rawType)).toLowerCase();
  if (text === "wallleft") return "leftwall";
  if (text === "wallright") return "rightwall";
  return null;
}

function wrapperSprite(wrapper: ScriptInstance): SpriteChannel | null {
  const sprite = wrapper.props.get("psprite");
  return sprite instanceof SpriteChannel ? sprite : null;
}

function propRect(list: LingoPropList, key: string): LingoRect | null {
  const value = list.getaProp(LingoSymbol.for(key), ops.lingoKeyEquals);
  return value instanceof LingoRect ? value : null;
}

function propPoint(list: LingoPropList, xKey: string, yKey: string): LingoPoint {
  return new LingoPoint(numberValue(list.getaProp(LingoSymbol.for(xKey), ops.lingoKeyEquals), 0), numberValue(list.getaProp(LingoSymbol.for(yKey), ops.lingoKeyEquals), 0));
}

function numberValue(value: LingoValue, fallback: number): number {
  if (typeof value === "number") return value;
  if (value instanceof LingoFloat) return value.value;
  if (value instanceof LingoVoid) return fallback;
  const numeric = Number(ops.stringOf(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function rectDistance(a: LingoRect, b: LingoRect): number {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const bx = clamp(ax, b.left, b.right);
  const by = clamp(ay, b.top, b.bottom);
  return Math.hypot(ax - bx, ay - by);
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return value;
  return Math.max(min, Math.min(max, value));
}

function pointSummary(point: LingoPoint): [number, number] {
  return [Math.round(point.x), Math.round(point.y)];
}

function rectSummary(rect: LingoRect | null): [number, number, number, number] | null {
  return rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)] : null;
}
