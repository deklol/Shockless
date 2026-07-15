import type { RuntimeObjectSummary } from "../../engineRuntime";
import { compactValue, finiteNumber } from "../common/model";
import { objectMeta } from "./items";

export function wallObjectMeta(entry: RuntimeObjectSummary): string {
  const parts = [
    entry.objectId ?? entry.id ? `id ${compactValue(entry.objectId ?? entry.id)}` : "",
    entry.wall ? `wall ${entry.wall}` : "",
    entry.local ? `local ${entry.local}` : "",
    entry.orientation ? `face ${compactValue(entry.orientation)}` : entry.direction !== undefined ? `dir ${compactValue(entry.direction)}` : "",
    entry.state !== undefined && entry.state !== null ? `state ${compactValue(entry.state)}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || objectMeta(entry);
}

export interface WallMoverLocation {
  readonly wallX: number;
  readonly wallY: number;
  readonly localX: number;
  readonly localY: number;
  readonly orientation: "l" | "r";
}

export interface StagePoint {
  readonly x: number;
  readonly y: number;
}

export function signedPair(value: unknown): { readonly x: number; readonly y: number } | null {
  const match = compactValue(value).match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!match) return null;
  return { x: Number.parseInt(match[1]!, 10), y: Number.parseInt(match[2]!, 10) };
}

export function wallOrientation(value: unknown): "l" | "r" | null {
  const normalized = compactValue(value).trim().toLowerCase();
  if (normalized === "l" || normalized === "left") return "l";
  if (normalized === "r" || normalized === "right") return "r";
  return null;
}

export function wallMoverLocation(entry: RuntimeObjectSummary | null | undefined): WallMoverLocation | null {
  const raw = compactValue(entry?.rawLocation);
  const rawMatch = raw.match(/:w=(-?\d+)\s*,\s*(-?\d+)\s+l=(-?\d+)\s*,\s*(-?\d+)\s+([lr])/i);
  if (rawMatch) {
    return {
      wallX: Number.parseInt(rawMatch[1]!, 10),
      wallY: Number.parseInt(rawMatch[2]!, 10),
      localX: Number.parseInt(rawMatch[3]!, 10),
      localY: Number.parseInt(rawMatch[4]!, 10),
      orientation: rawMatch[5]!.toLowerCase() as "l" | "r",
    };
  }
  const wall = signedPair(entry?.wall);
  const local = signedPair(entry?.local);
  const orientation = wallOrientation(entry?.orientation ?? entry?.direction);
  if (!wall || !local || !orientation) return null;
  return { wallX: wall.x, wallY: wall.y, localX: local.x, localY: local.y, orientation };
}

export function wallLocationFromStagePoint(
  entry: RuntimeObjectSummary | null | undefined,
  point: StagePoint,
  options: {
    readonly wallX?: unknown;
    readonly wallY?: unknown;
    readonly orientation?: unknown;
    readonly sourceX?: unknown;
    readonly sourceY?: unknown;
  } = {},
): WallMoverLocation | null {
  const base = wallMoverLocation(entry);
  const stageX = finiteNumber(point.x);
  const stageY = finiteNumber(point.y);
  if (!base || stageX === null || stageY === null) return null;

  const sourceX = finiteNumber(options.sourceX ?? entry?.x);
  const sourceY = finiteNumber(options.sourceY ?? entry?.y);
  const orientation = wallOrientation(options.orientation) ?? base.orientation;
  const wallX = finiteNumber(options.wallX);
  const wallY = finiteNumber(options.wallY);

  return {
    wallX: wallX === null ? base.wallX : Math.trunc(wallX),
    wallY: wallY === null ? base.wallY : Math.trunc(wallY),
    localX: sourceX === null ? Math.round(stageX) : base.localX + Math.round(stageX - sourceX),
    localY: sourceY === null ? Math.round(stageY) : base.localY + Math.round(stageY - sourceY),
    orientation,
  };
}
