/**
 * The `L` helper module imported by generated code. Thin re-export of the
 * value model and operator semantics plus literal constructors.
 */
import { LINGO_VOID, LingoList, LingoPropList, LingoSymbol, LingoValue, float } from "./values";
import { lingoEquals } from "./ops";

export {
  add,
  sub,
  mul,
  div,
  mod,
  neg,
  concat,
  concatSpace,
  eq,
  ne,
  lt,
  gt,
  le,
  ge,
  and,
  or,
  not,
  contains,
  startsWith,
  truthy,
  stringOf,
  lingoEquals,
} from "./ops";
export { float } from "./values";
export type { LingoValue } from "./values";

export const VOID = LINGO_VOID;

export function sym(name: string): LingoSymbol {
  return LingoSymbol.for(name);
}

export function list(...elements: LingoValue[]): LingoList {
  return new LingoList(elements);
}

export function propList(...pairs: [LingoValue, LingoValue][]): LingoPropList {
  return LingoPropList.fromPairs(pairs);
}

/** Loop bounds in `repeat with` coerce to integers. */
export function toInt(value: LingoValue): number {
  if (typeof value === "number") return Math.trunc(value);
  if (value instanceof Object && "value" in value && typeof (value as { value: unknown }).value === "number") {
    return Math.trunc((value as { value: number }).value);
  }
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Math.trunc(Number(value));
  }
  if (value === LINGO_VOID) return 0;
  throw new TypeError("repeat bound is not a number");
}

export function equalsHelper(a: LingoValue, b: LingoValue): boolean {
  return lingoEquals(a, b);
}
