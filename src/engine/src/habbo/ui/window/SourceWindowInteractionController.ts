import type { DirectorMovie } from "@director/Movie";
import { LingoRect } from "@director/geometry";
import { truthy as lingoTruthy } from "@director/ops";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import {
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoVoid,
  type LingoValue,
} from "@director/values";

export interface SourceWindowWheelResult {
  readonly consumed: boolean;
  readonly windowId: string | null;
  readonly element: string | null;
  readonly scrollbars: Array<{ type: string; axis: "x" | "y"; from: number; to: number }>;
  readonly errors: string[];
}

interface SourceWindowInteractionControllerOptions {
  readonly movie: DirectorMovie;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  readonly propListLookup: (list: LingoPropList, key: string) => LingoValue;
  readonly debugValue: (value: LingoValue | undefined) => unknown;
  readonly valueToNumber: (value: LingoValue | undefined, fallback?: number) => number;
  readonly valueToId: (value: LingoValue) => string;
  readonly render: () => void;
}

/** Habbo Source-window geometry, stacking, hit ownership, and wheel routing. */
export class SourceWindowInteractionController {
  constructor(private readonly options: SourceWindowInteractionControllerOptions) {}

  manager(): ScriptInstance | null {
    try {
      const manager = this.options.movie.runtime.call("getwindowmanager", []);
      return manager instanceof ScriptInstance ? manager : null;
    } catch {
      return null;
    }
  }

  ids(windowManager: ScriptInstance): LingoValue[] {
    const itemList = this.options.instancePropValue(windowManager, "pitemlist");
    return itemList instanceof LingoList ? [...itemList.items] : [];
  }

  windowById(windowManager: ScriptInstance, id: LingoValue): ScriptInstance | null {
    try {
      const windowObject = this.options.movie.runtime.callMethod(windowManager, "get", [id]);
      return windowObject instanceof ScriptInstance ? windowObject : null;
    } catch {
      return null;
    }
  }

  windowVisible(windowObject: ScriptInstance): boolean {
    const visible = this.options.instancePropValue(windowObject, "pvisible");
    return visible === undefined || visible instanceof LingoVoid ? true : lingoTruthy(visible);
  }

  windowRect(windowObject: ScriptInstance): LingoRect | null {
    const left = this.options.valueToNumber(this.options.instancePropValue(windowObject, "plocx"), Number.NaN);
    const top = this.options.valueToNumber(this.options.instancePropValue(windowObject, "plocy"), Number.NaN);
    const width = this.options.valueToNumber(this.options.instancePropValue(windowObject, "pwidth"), 0);
    const height = this.options.valueToNumber(this.options.instancePropValue(windowObject, "pheight"), 0);
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) return null;
    return new LingoRect(left, top, left + width, top + height);
  }

  elements(windowObject: ScriptInstance): ScriptInstance[] {
    const elements = this.options.instancePropValue(windowObject, "pelemlist");
    if (!(elements instanceof LingoPropList)) return [];
    return elements.values.filter((entry): entry is ScriptInstance => entry instanceof ScriptInstance);
  }

  elementTree(element: ScriptInstance): ScriptInstance[] {
    const children = this.elementChildren(element);
    return [element, ...children.flatMap((child) => this.elementTree(child))];
  }

  allElements(windowObject: ScriptInstance): ScriptInstance[] {
    return this.elements(windowObject).flatMap((entry) => this.elementTree(entry));
  }

  sprites(windowObject: ScriptInstance): SpriteChannel[] {
    const sprites = this.options.instancePropValue(windowObject, "pspritelist");
    const values = sprites instanceof LingoPropList ? sprites.values : sprites instanceof LingoList ? sprites.items : [];
    return values.filter((entry): entry is SpriteChannel => entry instanceof SpriteChannel);
  }

  elementRect(element: ScriptInstance): LingoRect | null {
    const sprite = this.options.instancePropValue(element, "psprite");
    if (!(sprite instanceof SpriteChannel)) return null;
    const spriteRect = this.options.movie.spriteBounds(sprite.number);
    if (!spriteRect) return null;
    const hasOwnRect = this.hasElementProp(element, "pownx") && this.hasElementProp(element, "powny");
    const grouped = this.elementStyle(element) === "grouped";
    const ownX = hasOwnRect
      ? this.options.valueToNumber(this.options.instancePropValue(element, "pownx"), 0)
      : grouped
        ? this.options.valueToNumber(this.options.instancePropValue(element, "plocx"), 0)
        : 0;
    const ownY = hasOwnRect
      ? this.options.valueToNumber(this.options.instancePropValue(element, "powny"), 0)
      : grouped
        ? this.options.valueToNumber(this.options.instancePropValue(element, "plocy"), 0)
        : 0;
    const width = this.options.valueToNumber(
      hasOwnRect ? this.options.instancePropValue(element, "pownw") : this.options.instancePropValue(element, "pwidth"),
      spriteRect.width,
    );
    const height = this.options.valueToNumber(
      hasOwnRect ? this.options.instancePropValue(element, "pownh") : this.options.instancePropValue(element, "pheight"),
      spriteRect.height,
    );
    if (width <= 0 || height <= 0) return null;
    return new LingoRect(spriteRect.left + ownX, spriteRect.top + ownY, spriteRect.left + ownX + width, spriteRect.top + ownY + height);
  }

  elementId(element: ScriptInstance): string {
    const id = this.options.instancePropValue(element, "pid");
    if (id === undefined || id instanceof LingoVoid) return "";
    if (id instanceof LingoSymbol) return id.name;
    return typeof id === "string" ? id : String(this.options.debugValue(id));
  }

  containsPoint(x: number, y: number): boolean {
    const windowManager = this.manager();
    if (!windowManager) return false;
    const ids = this.ids(windowManager);
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const windowObject = this.windowById(windowManager, ids[index]!);
      if (!windowObject || !this.windowVisible(windowObject)) continue;
      const windowRect = this.windowRect(windowObject);
      if (windowRect && this.rectContains(windowRect, x, y)) return true;
      for (const element of this.allElements(windowObject)) {
        if (!this.elementVisible(element)) continue;
        const rect = this.elementRect(element);
        if (rect && this.rectContains(rect, x, y)) return true;
      }
    }
    return false;
  }

  ownsSpriteAt(sprite: SpriteChannel, x: number, y: number): boolean | null {
    const targetSprite = this.targetSpriteAcrossWindowsAt(x, y);
    if (!targetSprite) return null;
    return sprite === targetSprite;
  }

  wheelAt(x: number, y: number, deltaY: number, deltaX = 0, shiftDown = false): SourceWindowWheelResult {
    const errors: string[] = [];
    const windowManager = this.manager();
    if (!windowManager) return { consumed: false, windowId: null, element: null, scrollbars: [], errors };
    const ids = this.ids(windowManager);
    for (let idIndex = ids.length - 1; idIndex >= 0; idIndex -= 1) {
      const id = ids[idIndex]!;
      const windowObject = this.windowById(windowManager, id);
      if (!windowObject || !this.windowVisible(windowObject)) continue;
      const candidates = this.elements(windowObject)
        .filter((element) => this.elementVisible(element))
        .map((element) => {
          const rect = this.elementRect(element);
          const sprite = this.options.instancePropValue(element, "psprite");
          return {
            element,
            rect,
            z: sprite instanceof SpriteChannel ? sprite.locZ : 0,
            scrollbars: this.scrollbarsForElement(windowObject, element),
          };
        })
        .filter((candidate) => candidate.rect && this.rectContains(candidate.rect, x, y) && candidate.scrollbars.length > 0)
        .sort((left, right) => right.z - left.z);
      for (const candidate of candidates) {
        const applied: SourceWindowWheelResult["scrollbars"] = [];
        for (const scrollbar of candidate.scrollbars) {
          try {
            const result = this.applyWheelToScrollbar(scrollbar, deltaY, deltaX, shiftDown);
            if (result) applied.push({ type: this.elementType(scrollbar), ...result });
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (applied.length > 0) {
          this.options.render();
          return {
            consumed: true,
            windowId: this.options.valueToId(id),
            element: String(this.options.debugValue(this.options.instancePropValue(candidate.element, "pid")) ?? candidate.element.module.scriptName),
            scrollbars: applied,
            errors,
          };
        }
      }
    }
    return { consumed: false, windowId: null, element: null, scrollbars: [], errors };
  }

  elementVisible(element: ScriptInstance): boolean {
    const value = this.options.instancePropValue(element, "pvisible");
    return value === undefined || value instanceof LingoVoid ? true : lingoTruthy(value);
  }

  private hasElementProp(element: ScriptInstance, name: string): boolean {
    const value = this.options.instancePropValue(element, name);
    return value !== undefined && !(value instanceof LingoVoid);
  }

  private elementStyle(element: ScriptInstance): string {
    const props = this.options.instancePropValue(element, "pprops");
    const style = props instanceof LingoPropList
      ? this.options.propListLookup(props, "#style")
      : this.options.instancePropValue(element, "pstyle");
    if (style instanceof LingoSymbol) return style.name.toLowerCase();
    return typeof style === "string" ? style.toLowerCase() : "";
  }

  private elementChildren(element: ScriptInstance): ScriptInstance[] {
    const children = this.options.instancePropValue(element, "pelemlist");
    return children instanceof LingoList
      ? children.items.filter((entry): entry is ScriptInstance => entry instanceof ScriptInstance)
      : [];
  }

  private pointerCursorValue(element: ScriptInstance): LingoValue | undefined {
    const props = this.options.instancePropValue(element, "pprops");
    if (!(props instanceof LingoPropList)) return undefined;
    const cursor = this.options.propListLookup(props, "#cursor");
    return cursor instanceof LingoVoid ? undefined : cursor;
  }

  private spriteCursorValue(element: ScriptInstance): LingoValue | undefined {
    const sprite = this.options.instancePropValue(element, "psprite");
    return sprite instanceof SpriteChannel ? (sprite.cursor as LingoValue) : undefined;
  }

  private cursorIsPointerLike(cursor: LingoValue | undefined): boolean {
    if (cursor === undefined || cursor instanceof LingoVoid) return false;
    if (typeof cursor === "number") return cursor !== 0 && cursor !== -1;
    if (cursor instanceof LingoSymbol) return cursor.name.toLowerCase() !== "arrow";
    const normalized = String(cursor).trim().toLowerCase();
    return normalized.length > 0 && normalized !== "arrow" && normalized !== "#arrow";
  }

  private treeUsesPointerCursor(element: ScriptInstance): boolean {
    const current = this.cursorIsPointerLike(this.pointerCursorValue(element)) || this.cursorIsPointerLike(this.spriteCursorValue(element));
    return current || this.elementChildren(element).some((child) => this.treeUsesPointerCursor(child));
  }

  private specialIds(windowObject: ScriptInstance): string[] {
    const list = this.options.instancePropValue(windowObject, "pspecialidlist");
    if (!(list instanceof LingoList)) return [];
    return list.items.map((entry) => (entry instanceof LingoSymbol ? entry.name : String(this.options.debugValue(entry))));
  }

  private isSpecialControl(windowObject: ScriptInstance, element: ScriptInstance): boolean {
    const id = this.elementId(element);
    return id.length > 0 && this.specialIds(windowObject).includes(id);
  }

  private interactivityRank(windowObject: ScriptInstance, element: ScriptInstance): number {
    if (this.treeUsesPointerCursor(element)) return 3;
    if (this.isSpecialControl(windowObject, element) && !this.elementId(element).toLowerCase().includes("drag")) return 3;
    return 1;
  }

  private targetSpriteAt(windowObject: ScriptInstance, x: number, y: number): SpriteChannel | null {
    const candidates = this.allElements(windowObject)
      .filter((element) => this.elementVisible(element))
      .map((element, sourceIndex) => {
        const rect = this.elementRect(element);
        const sprite = this.options.instancePropValue(element, "psprite");
        return {
          sprite: sprite instanceof SpriteChannel ? sprite : null,
          rect,
          z: sprite instanceof SpriteChannel ? sprite.locZ : 0,
          sourceIndex,
          area: rect ? Math.max(1, rect.width * rect.height) : Number.POSITIVE_INFINITY,
          rank: this.interactivityRank(windowObject, element),
        };
      })
      .filter((candidate) => candidate.sprite && candidate.rect && this.rectContains(candidate.rect, x, y))
      .sort((left, right) => right.rank - left.rank || right.z - left.z || right.sourceIndex - left.sourceIndex || left.area - right.area);
    return candidates[0]?.sprite ?? null;
  }

  private targetSpriteAcrossWindowsAt(x: number, y: number): SpriteChannel | null {
    const windowManager = this.manager();
    if (!windowManager) return null;
    const candidates: SpriteChannel[] = [];
    for (const id of this.ids(windowManager)) {
      const windowObject = this.windowById(windowManager, id);
      if (!windowObject || !this.windowVisible(windowObject)) continue;
      const target = this.targetSpriteAt(windowObject, x, y);
      if (target) candidates.push(target);
    }
    candidates.sort((left, right) => right.locZ - left.locZ || right.number - left.number);
    return candidates[0] ?? null;
  }

  elementType(element: ScriptInstance): string {
    const type = this.options.instancePropValue(element, "ptype");
    if (type instanceof LingoSymbol) return type.name.toLowerCase();
    return typeof type === "string" ? type.toLowerCase() : "";
  }

  private scrollbarsForElement(windowObject: ScriptInstance, element: ScriptInstance): ScriptInstance[] {
    if (this.options.movie.runtime.hasHandler(element, "setscrolloffset")) return [element];
    const scrolls = this.options.instancePropValue(element, "pscrolls");
    if (!(scrolls instanceof LingoList)) return [];
    const result: ScriptInstance[] = [];
    for (const id of scrolls.items) {
      try {
        const scrollbar = this.options.movie.runtime.callMethod(windowObject, "getelement", [id]);
        if (scrollbar instanceof ScriptInstance && this.options.movie.runtime.hasHandler(scrollbar, "setscrolloffset")) result.push(scrollbar);
      } catch {
        // Missing generated scrollbar ids are ignored as the source does.
      }
    }
    return result;
  }

  private applyWheelToScrollbar(
    scrollbar: ScriptInstance,
    deltaY: number,
    deltaX: number,
    shiftDown: boolean,
  ): { axis: "x" | "y"; from: number; to: number } | null {
    const type = this.elementType(scrollbar);
    const axis = type === "scrollbarv" ? "y" : type === "scrollbarh" ? "x" : null;
    if (!axis) return null;
    const delta = axis === "y" ? deltaY : shiftDown && deltaX === 0 ? deltaY : deltaX;
    if (delta === 0) return null;
    let current = 0;
    let step = 16;
    try {
      current = this.options.valueToNumber(this.options.movie.runtime.callMethod(scrollbar, "getproperty", [LingoSymbol.for("offset")]), 0);
      step = Math.max(
        1,
        Math.abs(this.options.valueToNumber(this.options.movie.runtime.callMethod(scrollbar, "getproperty", [LingoSymbol.for("scrollStep")]), 16)),
      );
    } catch {
      current = this.options.valueToNumber(this.options.instancePropValue(scrollbar, "pscrolloffset"), 0);
      step = Math.max(1, Math.abs(this.options.valueToNumber(this.options.instancePropValue(scrollbar, "pscrollstep"), 16)));
    }
    const units = Math.max(1, Math.min(12, Math.round(Math.abs(delta) / 120) || 1));
    const next = current + Math.sign(delta) * step * units;
    this.options.movie.runtime.callMethod(scrollbar, "setscrolloffset", [next]);
    return { axis, from: current, to: this.options.valueToNumber(this.options.instancePropValue(scrollbar, "pscrolloffset"), next) };
  }

  rectContains(rect: LingoRect, x: number, y: number): boolean {
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  }
}
