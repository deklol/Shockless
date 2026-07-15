import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LingoFloat, LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";

/** Optional plugin-facing override for source floor-furni placement validation. */
export interface FloorItemAnywherePlacementController {
  setEnabled(enabled: boolean): Record<string, unknown>;
  isEnabled(): boolean;
  summary(): Record<string, unknown>;
}

interface SyntheticFloorCoordinate {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

const controllers = new WeakMap<Runtime, FloorItemAnywherePlacementController>();

export function installFloorItemAnywhereCompatibility(runtime: Runtime): FloorItemAnywherePlacementController {
  const existing = controllers.get(runtime);
  if (existing) return existing;

  let enabled = false;
  let synthesizedCount = 0;
  let acceptedNativeCount = 0;
  let allowedOutsideEmptyChecks = 0;
  let advancedCommitCount = 0;
  let lastSynthetic: SyntheticFloorCoordinate | null = null;
  let lastAdvancedCommit: SyntheticFloorCoordinate | null = null;
  const originalCallMethod = runtime.callMethod.bind(runtime);

  const controller: FloorItemAnywherePlacementController = {
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) lastSynthetic = null;
      return this.summary();
    },
    isEnabled() {
      return enabled;
    },
    summary() {
      return {
        enabled,
        synthesizedCount,
        acceptedNativeCount,
        allowedOutsideEmptyChecks,
        advancedCommitCount,
        lastSynthetic,
        lastAdvancedCommit,
      };
    },
  };

  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    const rewrittenCommit = maybeRewriteSyntheticMoveCommit(runtime, receiver, method, args, lastSynthetic, originalCallMethod);
    if (rewrittenCommit) {
      advancedCommitCount += 1;
      lastAdvancedCommit = rewrittenCommit.coordinate;
      lastSynthetic = null;
      return rewrittenCommit.result;
    }

    const result = originalCallMethod(receiver, method, args);
    if (!isObjectMoverFloorValidation(runtime, receiver, method)) return result;

    const normalizedMethod = method.toLowerCase();
    if (normalizedMethod === "getworldcoordinate" || normalizedMethod === "getfloorcoordinate") {
      if (isCoordinateList(result)) {
        acceptedNativeCount += 1;
        lastSynthetic = null;
        return result;
      }
      if (!enabled) {
        lastSynthetic = null;
        return result;
      }
      const synthetic = projectFloorCoordinate(receiver, args[0], args[1]);
      if (!synthetic) return result;
      synthesizedCount += 1;
      lastSynthetic = synthetic;
      return new LingoList([synthetic.x, synthetic.y, synthetic.height]);
    }

    if (normalizedMethod === "emptytile") {
      if (ops.truthy(result) || !enabled) return result;
      if (!isOutsidePlaceMap(receiver, args[0], args[1])) return result;
      allowedOutsideEmptyChecks += 1;
      return 1;
    }

    return result;
  };

  controllers.set(runtime, controller);
  return controller;
}

function maybeRewriteSyntheticMoveCommit(
  runtime: Runtime,
  receiver: LingoValue,
  method: string,
  args: LingoValue[],
  synthetic: SyntheticFloorCoordinate | null,
  originalCallMethod: Runtime["callMethod"],
): { readonly result: LingoValue; readonly coordinate: SyntheticFloorCoordinate } | null {
  if (!synthetic) return null;
  if (!isRoomInterfaceMoveSend(runtime, receiver, method, args)) return null;
  const payload = args[1];
  if (!(payload instanceof LingoPropList) || payload.values.length < 4) return null;

  const objectId = directorInteger(numberValue(payload.values[0], Number.NaN));
  const x = directorInteger(numberValue(payload.values[1], Number.NaN));
  const y = directorInteger(numberValue(payload.values[2], Number.NaN));
  if (!Number.isFinite(objectId) || objectId <= 0) return null;
  if (x !== synthetic.x || y !== synthetic.y) return null;

  const advancedPayload = LingoPropList.fromPairs([
    [LingoSymbol.for("integer"), objectId],
    [LingoSymbol.for("integer"), synthetic.x],
    [LingoSymbol.for("integer"), synthetic.y],
    [LingoSymbol.for("string"), formatAdvancedHeight(synthetic.height)],
  ]);
  return {
    result: originalCallMethod(receiver, "send", ["ORIGINS_SET_FURNI_LOCATION", advancedPayload]),
    coordinate: synthetic,
  };
}

function isRoomInterfaceMoveSend(runtime: Runtime, receiver: LingoValue, method: string, args: LingoValue[]): receiver is ScriptInstance {
  if (!(receiver instanceof ScriptInstance)) return false;
  if (method.toLowerCase() !== "send") return false;
  if (String(args[0] ?? "").toUpperCase() !== "MOVESTUFF") return false;
  return runtime.callStack.some((entry) => {
    const normalizedEntry = entry.toLowerCase();
    return normalizedEntry === "room interface class.eventprocroom" || normalizedEntry === "room interface class.placefurniture";
  });
}

function isObjectMoverFloorValidation(runtime: Runtime, receiver: LingoValue, method: string): receiver is ScriptInstance {
  if (!(receiver instanceof ScriptInstance)) return false;
  if (receiver.module.scriptName !== "Room Geometry Class") return false;
  const normalizedMethod = method.toLowerCase();
  if (normalizedMethod !== "getworldcoordinate" && normalizedMethod !== "getfloorcoordinate" && normalizedMethod !== "emptytile") {
    return false;
  }
  return runtime.callStack.some((entry) => {
    const normalizedEntry = entry.toLowerCase();
    return (
      normalizedEntry === "object mover class.moveactive" ||
      normalizedEntry === "object mover class.getproperty" ||
      normalizedEntry === "object mover class.showactualpic"
    );
  });
}

function projectFloorCoordinate(
  geometry: ScriptInstance,
  locXValue: LingoValue | undefined,
  locYValue: LingoValue | undefined,
): SyntheticFloorCoordinate | null {
  const locX = numberValue(locXValue, Number.NaN);
  const locY = numberValue(locYValue, Number.NaN);
  const xOffset = propNumber(geometry, "pxoffset", 0);
  const yOffset = propNumber(geometry, "pyoffset", 0);
  const xFactor = propNumber(geometry, "pxfactor", 0);
  const yFactor = propNumber(geometry, "pyfactor", 0);
  const hFactor = propNumber(geometry, "phfactor", 0);
  if (!Number.isFinite(locX) || !Number.isFinite(locY) || xFactor === 0 || yFactor === 0) return null;

  const axisX = (locX - yFactor - xOffset) / xFactor;
  const axisY = (locY - yOffset) / yFactor;
  const x = directorInteger(axisX + axisY);
  const y = directorInteger(axisY - axisX);

  return { x, y, height: nearestKnownHeight(geometry, x, y) ?? nearestProjectedHeight(geometry, locX, locY, xOffset, yOffset, xFactor, yFactor, hFactor) ?? 0 };
}

function nearestProjectedHeight(
  geometry: ScriptInstance,
  locX: number,
  locY: number,
  xOffset: number,
  yOffset: number,
  xFactor: number,
  yFactor: number,
  hFactor: number,
): number | null {
  if (hFactor === 0) return null;
  for (let height = 1; height <= 9; height += 1) {
    const axisX = (locX - yFactor - xOffset) / xFactor;
    const axisY = (locY + height * hFactor - yOffset) / yFactor;
    const x = directorInteger(axisX + axisY);
    const y = directorInteger(axisY - axisX);
    const mappedHeight = nearestKnownHeight(geometry, x, y);
    if (mappedHeight === height) return height;
  }
  return null;
}

function nearestKnownHeight(geometry: ScriptInstance, x: number, y: number): number | null {
  const heightMap = geometry.props.get("pheightmap");
  const height = mapValueAt(heightMap, x, y);
  return typeof height === "number" && Number.isFinite(height) && height >= 0 && height < 100000 ? height : null;
}

function isOutsidePlaceMap(geometry: ScriptInstance, xValue: LingoValue | undefined, yValue: LingoValue | undefined): boolean {
  const x = directorInteger(numberValue(xValue, Number.NaN));
  const y = directorInteger(numberValue(yValue, Number.NaN));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const placeMap = geometry.props.get("pplacemap");
  if (!(placeMap instanceof LingoList)) return false;
  const row = placeMap.items[y];
  return !(row instanceof LingoList) || x < 0 || x >= row.items.length;
}

function mapValueAt(map: LingoValue | undefined, x: number, y: number): number | null {
  if (!(map instanceof LingoList)) return null;
  const row = map.items[y];
  if (!(row instanceof LingoList)) return null;
  const value = row.items[x];
  const numeric = numberValue(value, Number.NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

function isCoordinateList(value: LingoValue): value is LingoList {
  return value instanceof LingoList && value.items.length >= 2;
}

function propNumber(instance: ScriptInstance, key: string, fallback: number): number {
  return numberValue(instance.props.get(key), fallback);
}

function numberValue(value: LingoValue | undefined, fallback: number): number {
  if (typeof value === "number") return value;
  if (value instanceof LingoFloat) return value.value;
  if (value instanceof LingoVoid || value === undefined || value === null) return fallback;
  if (value instanceof LingoPropList || value instanceof LingoList) return fallback;
  const numeric = Number(ops.stringOf(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function directorInteger(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function formatAdvancedHeight(value: number): string {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.max(0, finite).toFixed(3);
}
