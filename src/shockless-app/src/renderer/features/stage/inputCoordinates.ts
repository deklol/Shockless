import { finiteNumber } from "../common/model";
import type { StagePoint } from "../room/wallPlacement";

function pluginStagePoint(value: unknown): StagePoint | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const x = finiteNumber(record.x ?? record.stageX ?? record.localX);
  const y = finiteNumber(record.y ?? record.stageY ?? record.localY);
  if (x === null || y === null) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

interface StageInputMetrics {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly resizablePresentation: boolean;
}

function normalizeStageInputMetrics(value: unknown): StageInputMetrics | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numberValue = (key: keyof StageInputMetrics): number | null => {
    const parsed = Number(record[key]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const left = numberValue("left");
  const top = numberValue("top");
  const width = numberValue("width");
  const height = numberValue("height");
  const stageWidth = numberValue("stageWidth");
  const stageHeight = numberValue("stageHeight");
  if (left === null || top === null || width === null || height === null || stageWidth === null || stageHeight === null) return null;
  if (width <= 0 || height <= 0 || stageWidth <= 0 || stageHeight <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    stageWidth,
    stageHeight,
    resizablePresentation: record.resizablePresentation === true,
  };
}

function stagePointFromWebviewPoint(localX: number, localY: number, metrics: StageInputMetrics | null): StagePoint {
  if (!metrics) return { x: Math.round(localX), y: Math.round(localY) };
  const canvasX = localX - metrics.left;
  const canvasY = localY - metrics.top;
  if (metrics.resizablePresentation) {
    return { x: Math.round(canvasX), y: Math.round(canvasY) };
  }
  return {
    x: Math.round((canvasX / metrics.width) * metrics.stageWidth),
    y: Math.round((canvasY / metrics.height) * metrics.stageHeight),
  };
}

export { pluginStagePoint, normalizeStageInputMetrics, stagePointFromWebviewPoint };
export type { StageInputMetrics };
