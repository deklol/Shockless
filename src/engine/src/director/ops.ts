import {
  LINGO_VOID,
  LingoFloat,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoValue,
  LingoVoid,
  float,
  isLingoObject,
} from "./values";
import { LingoColor, LingoPoint, LingoRect } from "./geometry";

/** Director coerces a 2-element list to a point and a 4-element list to a
 * rect for geometric arithmetic. */
function asPoint(value: LingoValue): LingoPoint | null {
  if (value instanceof LingoPoint) return value;
  if (value instanceof LingoList && value.items.length === 2) {
    return new LingoPoint(numericOr0(value.items[0]!), numericOr0(value.items[1]!));
  }
  return null;
}

function asRect(value: LingoValue): LingoRect | null {
  if (value instanceof LingoRect) return value;
  if (value instanceof LingoList && value.items.length === 4) {
    return new LingoRect(
      numericOr0(value.items[0]!),
      numericOr0(value.items[1]!),
      numericOr0(value.items[2]!),
      numericOr0(value.items[3]!),
    );
  }
  return null;
}

function numericOr0(value: LingoValue): number {
  if (typeof value === "number") return value;
  if (value instanceof LingoFloat) return value.value;
  return 0;
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

function colorParts(value: LingoValue, context: string): { r: number; g: number; b: number } {
  if (value instanceof LingoColor) {
    return { r: value.r, g: value.g, b: value.b };
  }
  const scalar = toNumeric(value, context).value;
  return { r: scalar, g: scalar, b: scalar };
}

/** Director allows arithmetic on color values; release306 uses this for
 * room wall shading (`rgb(...) - rgb(16,16,16)`). */
function colorOp(a: LingoValue, b: LingoValue, sign: 1 | -1): LingoValue | null {
  if (!(a instanceof LingoColor) && !(b instanceof LingoColor)) return null;
  const left = colorParts(a, sign === 1 ? "+" : "-");
  const right = colorParts(b, sign === 1 ? "+" : "-");
  return new LingoColor(
    clampColorChannel(left.r + sign * right.r),
    clampColorChannel(left.g + sign * right.g),
    clampColorChannel(left.b + sign * right.b),
  );
}

/** Geometric +/- for point and rect operands; returns null when neither
 * operand is geometric so the numeric path runs. */
function geometricOp(a: LingoValue, b: LingoValue, sign: 1 | -1): LingoValue | null {
  const aRect = a instanceof LingoRect ? a : null;
  const bRect = b instanceof LingoRect ? b : null;
  if (aRect || bRect) {
    const left = asRect(a);
    const right = asRect(b);
    if (left && right) {
      return new LingoRect(
        left.left + sign * right.left,
        left.top + sign * right.top,
        left.right + sign * right.right,
        left.bottom + sign * right.bottom,
      );
    }
    // rect +/- scalar inflates all edges.
    const rect = (aRect ?? bRect)!;
    const scalar = numericOr0(aRect ? b : a);
    return new LingoRect(
      rect.left + sign * scalar,
      rect.top + sign * scalar,
      rect.right + sign * scalar,
      rect.bottom + sign * scalar,
    );
  }
  const aPoint = a instanceof LingoPoint ? a : null;
  const bPoint = b instanceof LingoPoint ? b : null;
  if (aPoint || bPoint) {
    const left = asPoint(a);
    const right = asPoint(b);
    if (left && right) {
      return new LingoPoint(left.x + sign * right.x, left.y + sign * right.y);
    }
    const point = (aPoint ?? bPoint)!;
    const scalar = numericOr0(aPoint ? b : a);
    return new LingoPoint(point.x + sign * scalar, point.y + sign * scalar);
  }
  return null;
}

/** Director uses rect/point arithmetic in source UI layout code. Multiplying
 * by a scalar scales each coordinate; non-geometric operands fall through to
 * numeric/list arithmetic. */
function geometricScaleOp(a: LingoValue, b: LingoValue): LingoValue | null {
  const aRect = a instanceof LingoRect ? a : null;
  const bRect = b instanceof LingoRect ? b : null;
  if (aRect || bRect) {
    const rect = (aRect ?? bRect)!;
    const scalar = toNumeric(aRect ? b : a, "*").value;
    return new LingoRect(
      rect.left * scalar,
      rect.top * scalar,
      rect.right * scalar,
      rect.bottom * scalar,
    );
  }
  const aPoint = a instanceof LingoPoint ? a : null;
  const bPoint = b instanceof LingoPoint ? b : null;
  if (aPoint || bPoint) {
    const point = (aPoint ?? bPoint)!;
    const scalar = toNumeric(aPoint ? b : a, "*").value;
    return new LingoPoint(point.x * scalar, point.y * scalar);
  }
  return null;
}

/**
 * Lingo operator semantics (Lingo in a Nutshell ch. 5/8, cross-checked with
 * ScummVM Director and dirplayer behavior):
 *
 * - integer op integer stays integer; `/` truncates toward zero.
 * - any float operand promotes the result to float.
 * - numeric strings coerce in arithmetic ("3" + 2 = 5); non-numeric strings
 *   are a script error.
 * - VOID coerces to 0 in arithmetic.
 * - string comparison and contains/starts are case-insensitive.
 * - lists compare by content.
 * - and/or evaluate both operands (no short-circuit) and return 1/0; codegen
 *   must call these helpers rather than using JS && / ||.
 * - float-to-string uses `the floatPrecision` (default 4): string(1.5) is
 *   "1.5000".
 */

export class LingoScriptError extends Error {}

let floatPrecision = 4;

export function setFloatPrecision(value: number): void {
  floatPrecision = Math.max(0, Math.min(15, Math.trunc(value)));
}

export function getFloatPrecision(): number {
  return floatPrecision;
}

interface NumericOperand {
  value: number;
  isFloat: boolean;
}

function toNumeric(value: LingoValue, context: string): NumericOperand {
  if (typeof value === "number") {
    return { value, isFloat: false };
  }
  if (value instanceof LingoFloat) {
    return { value: value.value, isFloat: true };
  }
  if (value instanceof LingoVoid) {
    return { value: 0, isFloat: false };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
      const parsed = Number(trimmed);
      return { value: parsed, isFloat: /[.eE]/.test(trimmed) };
    }
    throw new LingoScriptError(`${context}: expected a number, got "${value}"`);
  }
  throw new LingoScriptError(
    `${context}: expected a number, got <${(value as { lingoType?: string })?.lingoType ?? typeof value}>`,
  );
}

function numericResult(value: number, isFloat: boolean): LingoValue {
  return isFloat ? float(value) : Math.trunc(value);
}

/** Director list arithmetic is element-wise: [1,2]+1 = [2,3]; [1,2]+[3,4] =
 * [4,6]. */
function listOp(
  a: LingoValue,
  b: LingoValue,
  op: (x: LingoValue, y: LingoValue) => LingoValue,
): LingoValue | null {
  const aList = a instanceof LingoList ? a : null;
  const bList = b instanceof LingoList ? b : null;
  if (!aList && !bList) return null;
  if (aList && bList) {
    const length = Math.min(aList.items.length, bList.items.length);
    const items: LingoValue[] = [];
    for (let i = 0; i < length; i += 1) {
      items.push(op(aList.items[i]!, bList.items[i]!));
    }
    return new LingoList(items);
  }
  const list = (aList ?? bList)!;
  const scalar = aList ? b : a;
  return new LingoList(list.items.map((item) => (aList ? op(item, scalar) : op(scalar, item))));
}

export function add(a: LingoValue, b: LingoValue): LingoValue {
  const color = colorOp(a, b, 1);
  if (color !== null) return color;
  const geometric = geometricOp(a, b, 1);
  if (geometric !== null) return geometric;
  const listResult = listOp(a, b, add);
  if (listResult !== null) return listResult;
  const left = toNumeric(a, "+");
  const right = toNumeric(b, "+");
  return numericResult(left.value + right.value, left.isFloat || right.isFloat);
}

export function sub(a: LingoValue, b: LingoValue): LingoValue {
  const color = colorOp(a, b, -1);
  if (color !== null) return color;
  const geometric = geometricOp(a, b, -1);
  if (geometric !== null) return geometric;
  const listResult = listOp(a, b, sub);
  if (listResult !== null) return listResult;
  const left = toNumeric(a, "-");
  const right = toNumeric(b, "-");
  return numericResult(left.value - right.value, left.isFloat || right.isFloat);
}

export function mul(a: LingoValue, b: LingoValue): LingoValue {
  const geometric = geometricScaleOp(a, b);
  if (geometric !== null) return geometric;
  const listResult = listOp(a, b, mul);
  if (listResult !== null) return listResult;
  const left = toNumeric(a, "*");
  const right = toNumeric(b, "*");
  return numericResult(left.value * right.value, left.isFloat || right.isFloat);
}

export function div(a: LingoValue, b: LingoValue): LingoValue {
  const listResult = listOp(a, b, div);
  if (listResult !== null) return listResult;
  const left = toNumeric(a, "/");
  const right = toNumeric(b, "/");
  if (right.value === 0 && !left.isFloat && !right.isFloat) {
    throw new LingoScriptError("division by zero");
  }
  if (left.isFloat || right.isFloat) {
    return float(left.value / right.value);
  }
  // Integer division truncates toward zero: 5/2 = 2, -5/2 = -2.
  return Math.trunc(left.value / right.value);
}

export function mod(a: LingoValue, b: LingoValue): LingoValue {
  const listResult = listOp(a, b, mod);
  if (listResult !== null) return listResult;
  const left = Math.trunc(toNumeric(a, "mod").value);
  const right = Math.trunc(toNumeric(b, "mod").value);
  if (right === 0) {
    throw new LingoScriptError("mod by zero");
  }
  // Result sign follows the dividend, like Lingo: -7 mod 3 = -1.
  return left % right;
}

export function neg(a: LingoValue): LingoValue {
  if (a instanceof LingoPoint) {
    return new LingoPoint(-a.x, -a.y);
  }
  if (a instanceof LingoRect) {
    return new LingoRect(-a.left, -a.top, -a.right, -a.bottom);
  }
  if (a instanceof LingoList) {
    return new LingoList(a.items.map((item) => neg(item)));
  }
  const operand = toNumeric(a, "unary -");
  return numericResult(-operand.value, operand.isFloat);
}

export function stringOf(value: LingoValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value instanceof LingoFloat) {
    return value.value.toFixed(floatPrecision);
  }
  // VOID concatenates as empty string (release306 int2hex relies on this);
  // displayString shows <Void> for put output.
  if (value instanceof LingoVoid) return "";
  if (value instanceof LingoSymbol) return value.name;
  if (value instanceof LingoList) {
    return `[${value.items.map(displayString).join(", ")}]`;
  }
  if (value instanceof LingoPropList) {
    if (value.count() === 0) return "[:]";
    const parts: string[] = [];
    for (let i = 0; i < value.keys.length; i += 1) {
      parts.push(`${displayString(value.keys[i]!)}: ${displayString(value.values[i]!)}`);
    }
    return `[${parts.join(", ")}]`;
  }
  if (isLingoObject(value) && value.lingoToString) {
    return value.lingoToString();
  }
  return `<${(value as { lingoType?: string }).lingoType ?? "object"}>`;
}

/** String form used inside list display: strings get quotes, symbols a #. */
export function displayString(value: LingoValue): string {
  if (typeof value === "string") return `"${value}"`;
  if (value instanceof LingoSymbol) return `#${value.name}`;
  if (value instanceof LingoVoid) return "<Void>";
  return stringOf(value);
}

export function concat(a: LingoValue, b: LingoValue): string {
  return stringOf(a) + stringOf(b);
}

export function concatSpace(a: LingoValue, b: LingoValue): string {
  return `${stringOf(a)} ${stringOf(b)}`;
}

function symbolComparableString(value: LingoValue): string {
  if (value instanceof LingoSymbol) return value.name;
  const text = stringOf(value);
  return text.startsWith("#") ? text.slice(1) : text;
}

/** Three-way comparison used by all comparison operators and sort. */
export function compareValues(a: LingoValue, b: LingoValue): number {
  // Symbols order by name, case-insensitively (prop-list sort relies on it).
  if (a instanceof LingoSymbol || b instanceof LingoSymbol) {
    const left = symbolComparableString(a).toLowerCase();
    const right = symbolComparableString(b).toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const aIsNumber = typeof a === "number" || a instanceof LingoFloat || a instanceof LingoVoid;
  const bIsNumber = typeof b === "number" || b instanceof LingoFloat || b instanceof LingoVoid;
  if (aIsNumber && bIsNumber) {
    const left = toNumeric(a, "compare").value;
    const right = toNumeric(b, "compare").value;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    // Lingo string comparison is case-insensitive.
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
  // VOID participates as numeric zero in arithmetic and numeric comparisons,
  // but remains Director's missing-value sentinel when compared with text.
  // Coercing "0" to numeric zero here makes source checks such as
  // `if tText = VOID` erase a legitimate zero before Writer renders it.
  if ((a instanceof LingoVoid && typeof b === "string") || (typeof a === "string" && b instanceof LingoVoid)) {
    return a instanceof LingoVoid ? -1 : 1;
  }
  if ((aIsNumber && typeof b === "string") || (typeof a === "string" && bIsNumber)) {
    // Mixed string/number: coerce the string when numeric, else compare as
    // strings (matches observed Director behavior).
    const stringSide = typeof a === "string" ? a : (b as string);
    if (stringSide.trim() !== "" && !Number.isNaN(Number(stringSide))) {
      const left = toNumeric(a, "compare").value;
      const right = toNumeric(b, "compare").value;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const left = stringOf(a).toLowerCase();
    const right = stringOf(b).toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
  throw new LingoScriptError("incomparable values");
}

/** Director linear-list sorting compares nested row lists lexicographically.
 * Relational operators remain scalar-only through compareValues(). */
export function compareSortValues(a: LingoValue, b: LingoValue): number {
  if (a instanceof LingoList || b instanceof LingoList) {
    if (!(a instanceof LingoList) || !(b instanceof LingoList)) {
      throw new LingoScriptError("incomparable values");
    }
    const sharedLength = Math.min(a.items.length, b.items.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const compared = compareSortValues(a.items[index]!, b.items[index]!);
      if (compared !== 0) return compared;
    }
    return a.items.length < b.items.length ? -1 : a.items.length > b.items.length ? 1 : 0;
  }
  return compareValues(a, b);
}

export function lingoEquals(a: LingoValue, b: LingoValue): boolean {
  if (a instanceof LingoSymbol || b instanceof LingoSymbol) {
    if (a instanceof LingoSymbol && b instanceof LingoSymbol) {
      return a === b;
    }
    // Symbol vs string compares the names case-insensitively.
    if (typeof a === "string" || typeof b === "string") {
      const symbolName = a instanceof LingoSymbol ? a.name : (b as LingoSymbol).name;
      const other = symbolComparableString(typeof a === "string" ? a : b);
      return symbolName.toLowerCase() === other.toLowerCase();
    }
    return false;
  }
  if (a instanceof LingoVoid && b instanceof LingoVoid) return true;
  if (a instanceof LingoList && b instanceof LingoList) {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, i) => lingoEquals(item, b.items[i]!));
  }
  if (a instanceof LingoPropList && b instanceof LingoPropList) {
    if (a.keys.length !== b.keys.length) return false;
    return (
      a.keys.every((key, i) => lingoEquals(key, b.keys[i]!)) &&
      a.values.every((value, i) => lingoEquals(value, b.values[i]!))
    );
  }
  if (isLingoObject(a) || isLingoObject(b)) {
    if (isLingoObject(a) && a.lingoEquals) return a.lingoEquals(b);
    if (isLingoObject(b) && b.lingoEquals) return b.lingoEquals(a);
    return a === b;
  }
  try {
    return compareValues(a, b) === 0;
  } catch {
    return false;
  }
}

/** Equality for property-list keys.
 *
 * Director value comparisons are loose enough that `#info = "info"` is true,
 * but property lists may contain both a symbol key and a string key with the
 * same spelling. release306 relies on that for Object Manager ids such as
 * `#room_interface` and window ids such as `"Room_interface"`.
 */
export function lingoKeyEquals(a: LingoValue, b: LingoValue): boolean {
  if (a instanceof LingoSymbol || b instanceof LingoSymbol) {
    return a instanceof LingoSymbol && b instanceof LingoSymbol && a === b;
  }
  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  }
  return lingoEquals(a, b);
}

export function eq(a: LingoValue, b: LingoValue): number {
  return lingoEquals(a, b) ? 1 : 0;
}

export function ne(a: LingoValue, b: LingoValue): number {
  return lingoEquals(a, b) ? 0 : 1;
}

export function lt(a: LingoValue, b: LingoValue): number {
  return compareValues(a, b) < 0 ? 1 : 0;
}

export function gt(a: LingoValue, b: LingoValue): number {
  return compareValues(a, b) > 0 ? 1 : 0;
}

export function le(a: LingoValue, b: LingoValue): number {
  return compareValues(a, b) <= 0 ? 1 : 0;
}

export function ge(a: LingoValue, b: LingoValue): number {
  return compareValues(a, b) >= 0 ? 1 : 0;
}

export function truthy(value: LingoValue): boolean {
  if (typeof value === "number") return value !== 0;
  if (value instanceof LingoFloat) return value.value !== 0;
  if (value instanceof LingoVoid) return false;
  // Object references are true in Lingo conditionals (startClient does
  // `if not constructObjectManager() then` on the returned gCore object).
  if (isLingoObject(value) || value instanceof LingoSymbol) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
      return Number(trimmed) !== 0;
    }
    return true;
  }
  throw new LingoScriptError("expected a boolean/integer");
}

/** Both operands are always evaluated by the caller; Lingo and/or do not
 * short-circuit. */
export function and(a: LingoValue, b: LingoValue): number {
  return truthy(a) && truthy(b) ? 1 : 0;
}

export function or(a: LingoValue, b: LingoValue): number {
  return truthy(a) || truthy(b) ? 1 : 0;
}

export function not(a: LingoValue): number {
  return truthy(a) ? 0 : 1;
}

export function contains(a: LingoValue, b: LingoValue): number {
  return stringOf(a).toLowerCase().includes(stringOf(b).toLowerCase()) ? 1 : 0;
}

export function startsWith(a: LingoValue, b: LingoValue): number {
  return stringOf(a).toLowerCase().startsWith(stringOf(b).toLowerCase()) ? 1 : 0;
}
