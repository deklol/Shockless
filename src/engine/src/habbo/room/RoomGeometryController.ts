import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import { LINGO_VOID, LingoList, numberOf, type LingoValue } from "@director/values";
import { debugValue, instancePropValue, summarizeValue } from "./RoomRuntimeDiagnostics";

export interface RoomGeometryControllerDependencies {
  movie: DirectorMovie;
  objectById: (id: string) => LingoValue;
  stageClick: (x: number, y: number) => void;
}

/** Maps between Habbo room tiles and Director stage coordinates. */
export class RoomGeometryController {
  constructor(private readonly dependencies: RoomGeometryControllerDependencies) {}

  screenCoordinate(x: number, y: number, height?: number): Record<string, unknown> {
    const geometry = this.geometryObject();
    if (!geometry) return { error: "Room_geometry unavailable" };
    const worldX = Math.trunc(Number(x));
    const worldY = Math.trunc(Number(y));
    const worldHeight = Number.isFinite(Number(height))
      ? Number(height)
      : numberOf(this.dependencies.movie.runtime.callMethod(geometry, "getcoordinateheight", [worldX, worldY]));
    const value = this.dependencies.movie.runtime.callMethod(geometry, "getscreencoordinate", [worldX, worldY, worldHeight]);
    return {
      world: [worldX, worldY, worldHeight],
      screen: this.listNumbers(value),
      raw: summarizeValue(value, 1),
      geometry: this.diagnostics(),
    };
  }

  worldCoordinate(screenX: number, screenY: number): Record<string, unknown> {
    const geometry = this.geometryObject();
    if (!geometry) return { error: "Room_geometry unavailable" };
    const point = [Math.round(Number(screenX)), Math.round(Number(screenY))];
    const value = this.dependencies.movie.runtime.callMethod(geometry, "getworldcoordinate", point);
    return { screen: point, world: this.listNumbers(value), raw: summarizeValue(value, 1) };
  }

  diagnostics(): Record<string, unknown> {
    const geometry = this.geometryObject();
    if (!geometry) return { exists: false };
    const prop = (name: string): unknown => debugValue(instancePropValue(geometry, name) ?? LINGO_VOID);
    const heightMap = instancePropValue(geometry, "pheightmap");
    const placeMap = instancePropValue(geometry, "pplacemap");
    const floorMap = instancePropValue(geometry, "pfloormap");
    return {
      exists: true,
      offset: [prop("pxoffset"), prop("pyoffset"), prop("pzoffset")],
      factors: [prop("pxfactor"), prop("pyfactor"), prop("phfactor")],
      heightMapRows: heightMap instanceof LingoList ? heightMap.count() : null,
      placeMapRows: placeMap instanceof LingoList ? placeMap.count() : null,
      floorMapRows: floorMap instanceof LingoList ? floorMap.count() : null,
    };
  }

  clickTile(x: number, y: number, height?: number): Record<string, unknown> {
    const screen = this.screenCoordinate(x, y, height);
    const screenPoint = Array.isArray(screen.screen) ? screen.screen : null;
    if (!screenPoint || screenPoint.length < 2) return { clicked: false, screen, error: "screen coordinate unavailable" };
    const tileX = Math.trunc(Number(x));
    const tileY = Math.trunc(Number(y));
    const baseX = Number(screenPoint[0]);
    const baseY = Number(screenPoint[1]);
    const geometry = this.diagnostics();
    const tileWidth = Number(Array.isArray(geometry.factors) ? geometry.factors[0] : 32) || 32;
    const tileHeight = Number(Array.isArray(geometry.factors) ? geometry.factors[1] : 16) || 16;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [0, Math.round(tileHeight / 2)],
      [0, Math.round(tileHeight)],
      [Math.round(tileWidth / 4), Math.round(tileHeight / 2)],
      [-Math.round(tileWidth / 4), Math.round(tileHeight / 2)],
      [Math.round(tileWidth / 4), Math.round(tileHeight)],
      [-Math.round(tileWidth / 4), Math.round(tileHeight)],
      [0, Math.round(tileHeight * 1.5)],
    ];
    const probes: Record<string, unknown>[] = [];
    let chosen: { x: number; y: number; world: number[] | null } | null = null;
    for (const [offsetX, offsetY] of offsets) {
      const probeX = Math.round(baseX + offsetX);
      const probeY = Math.round(baseY + offsetY);
      const world = this.worldCoordinate(probeX, probeY);
      const worldList = Array.isArray(world.world) ? world.world : null;
      probes.push({ screen: [probeX, probeY], world: world.world, raw: world.raw });
      if (worldList && Math.trunc(Number(worldList[0])) === tileX && Math.trunc(Number(worldList[1])) === tileY) {
        chosen = { x: probeX, y: probeY, world: worldList };
        break;
      }
    }
    if (!chosen) return { clicked: false, requested: [tileX, tileY, height ?? null], screen, probes, error: "no probe resolved to requested tile" };
    this.dependencies.stageClick(chosen.x, chosen.y);
    return { clicked: true, requested: [tileX, tileY, height ?? null], screen, chosen, probes };
  }

  private geometryObject(): ScriptInstance | null {
    const direct = this.dependencies.objectById("Room_geometry");
    if (direct instanceof ScriptInstance) return direct;
    const symbol = this.dependencies.objectById("#room_geometry");
    return symbol instanceof ScriptInstance ? symbol : null;
  }

  private listNumbers(value: LingoValue): number[] | null {
    if (!(value instanceof LingoList)) return null;
    const numbers: number[] = [];
    for (const item of value.items) {
      try {
        numbers.push(numberOf(item));
      } catch {
        const numeric = Number(debugValue(item));
        if (!Number.isFinite(numeric)) return null;
        numbers.push(numeric);
      }
    }
    return numbers;
  }
}
