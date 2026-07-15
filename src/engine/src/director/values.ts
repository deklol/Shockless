/**
 * Lingo value model with exact Director semantics.
 *
 * Mapping to TypeScript:
 *   Lingo integer  -> JS number (always an integer)
 *   Lingo float    -> LingoFloat wrapper (so 2.0 stays a float; integer vs
 *                     float drives division and string conversion semantics)
 *   Lingo string   -> JS string
 *   Lingo symbol   -> LingoSymbol (interned, case-insensitive)
 *   Lingo VOID     -> LINGO_VOID singleton
 *   linear list    -> LingoList (1-based)
 *   property list  -> LingoPropList (ordered, case-insensitive symbol keys)
 *
 * All arithmetic/comparison flows through ops.ts so the wrappers stay
 * invisible to generated code.
 */

export class LingoFloat {
  constructor(public readonly value: number) {}
}

export class LingoVoid {
  private constructor() {}
  static readonly instance = new LingoVoid();
}

export const LINGO_VOID = LingoVoid.instance;

const symbolTable = new Map<string, LingoSymbol>();
const keyIndexMissSafety = new WeakMap<(a: LingoValue, b: LingoValue) => boolean, boolean>();

export class LingoSymbol {
  private constructor(public readonly name: string) {}

  /** Symbols are case-insensitive: #Foo and #foo are the same symbol. The
   * first-seen spelling is preserved for display. */
  static for(name: string): LingoSymbol {
    const key = name.toLowerCase();
    let symbol = symbolTable.get(key);
    if (!symbol) {
      symbol = new LingoSymbol(name);
      symbolTable.set(key, symbol);
    }
    return symbol;
  }
}

export type LingoValue =
  | number
  | LingoFloat
  | string
  | LingoSymbol
  | LingoVoid
  | LingoList
  | LingoPropList
  | LingoObjectLike;

/** Anything object-shaped the runtime adds later (script instances, points,
 * rects, colors, images, member refs). They participate in equality by
 * reference unless they implement lingoEquals. */
export interface LingoObjectLike {
  readonly lingoType: string;
  lingoEquals?(other: LingoValue): boolean;
  lingoToString?(): string;
}

export function isLingoObject(value: LingoValue): value is LingoObjectLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "lingoType" in value &&
    !(value instanceof LingoFloat) &&
    !(value instanceof LingoVoid) &&
    !(value instanceof LingoSymbol)
  );
}

export function symbol(name: string): LingoSymbol {
  return LingoSymbol.for(name);
}

export function float(value: number): LingoFloat {
  return new LingoFloat(value);
}

export function isVoid(value: LingoValue): boolean {
  return value instanceof LingoVoid;
}

export function isNumber(value: LingoValue): boolean {
  return typeof value === "number" || value instanceof LingoFloat;
}

export function numberOf(value: LingoValue): number {
  if (typeof value === "number") return value;
  if (value instanceof LingoFloat) return value.value;
  throw new TypeError("not a Lingo number");
}

/**
 * Linear list, 1-based, pass-by-reference like Lingo.
 */
export class LingoList implements LingoObjectLike {
  readonly lingoType = "list";
  items: LingoValue[];

  constructor(items: LingoValue[] = []) {
    this.items = items;
  }

  count(): number {
    return this.items.length;
  }

  /** getAt errors on out-of-range, matching Lingo script errors. */
  getAt(position: number): LingoValue {
    if (position < 1 || position > this.items.length) {
      throw new RangeError(`index out of range: ${position} of ${this.items.length}`);
    }
    return this.items[position - 1]!;
  }

  /** setAt grows a linear list, filling gaps with 0 (Lingo behavior). */
  setAt(position: number, value: LingoValue): void {
    if (position < 1) {
      throw new RangeError(`index out of range: ${position}`);
    }
    while (this.items.length < position - 1) {
      this.items.push(0);
    }
    this.items[position - 1] = value;
  }

  add(value: LingoValue): void {
    this.items.push(value);
  }

  append(value: LingoValue): void {
    this.items.push(value);
  }

  addAt(position: number, value: LingoValue): void {
    const index = Math.max(0, Math.min(this.items.length, position - 1));
    this.items.splice(index, 0, value);
  }

  deleteAt(position: number): void {
    if (position < 1 || position > this.items.length) {
      throw new RangeError(`index out of range: ${position} of ${this.items.length}`);
    }
    this.items.splice(position - 1, 1);
  }

  deleteWhere(predicate: (value: LingoValue, position: number) => boolean): number {
    const originalCount = this.items.length;
    this.items = this.items.filter((value, index) => !predicate(value, index + 1));
    return originalCount - this.items.length;
  }

  /** Removes the first occurrence of value; returns 1 if removed, 0 if not.
   * (Lingo's deleteOne returns TRUE/FALSE in D7+.) */
  deleteOne(value: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number {
    for (let i = 0; i < this.items.length; i += 1) {
      if (equals(this.items[i]!, value)) {
        this.items.splice(i, 1);
        return 1;
      }
    }
    return 0;
  }

  /** Position of first occurrence, or 0. */
  getPos(value: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number {
    for (let i = 0; i < this.items.length; i += 1) {
      if (equals(this.items[i]!, value)) {
        return i + 1;
      }
    }
    return 0;
  }

  /** getOne: same as getPos for linear lists. */
  getOne(value: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number {
    return this.getPos(value, equals);
  }

  getLast(): LingoValue {
    if (this.items.length === 0) {
      return LINGO_VOID;
    }
    return this.items[this.items.length - 1]!;
  }

  duplicate(): LingoList {
    return new LingoList(this.items.map(duplicateValue));
  }

  sort(compare: (a: LingoValue, b: LingoValue) => number): void {
    this.items.sort(compare);
  }
}

/**
 * Property list: ordered key/value pairs. Callers provide the equality
 * function because Director uses looser equality for values than for keys:
 * symbol keys and string keys with the same spelling may coexist.
 */
export class LingoPropList implements LingoObjectLike {
  readonly lingoType = "propList";
  keys: LingoValue[] = [];
  values: LingoValue[] = [];
  private sorted = false;
  private keyIndex: Map<string, number> | null = null;

  static fromPairs(pairs: [LingoValue, LingoValue][]): LingoPropList {
    const list = new LingoPropList();
    for (const [key, value] of pairs) {
      list.keys.push(key);
      list.values.push(value);
    }
    return list;
  }

  count(): number {
    return this.keys.length;
  }

  private static keyIndexToken(key: LingoValue): string | null {
    if (typeof key === "string") return `string:${key.toLowerCase()}`;
    if (key instanceof LingoSymbol) return `symbol:${key.name.toLowerCase()}`;
    return null;
  }

  private static canTrustIndexedMiss(equals: (a: LingoValue, b: LingoValue) => boolean): boolean {
    let cached = keyIndexMissSafety.get(equals);
    if (cached !== undefined) return cached;
    const probe = "__key_index_probe__";
    cached =
      !equals(probe, LingoSymbol.for(probe)) &&
      !equals(LingoSymbol.for(probe), probe) &&
      !equals("1", 1) &&
      !equals(1, "1");
    keyIndexMissSafety.set(equals, cached);
    return cached;
  }

  private invalidateKeyIndex(): void {
    this.keyIndex = null;
  }

  private noteDeletedKey(deletedKey: LingoValue, deletedIndex: number): void {
    if (!this.keyIndex) return;
    const deletedToken = LingoPropList.keyIndexToken(deletedKey);
    for (const [token, index] of this.keyIndex) {
      if (index < deletedIndex) continue;
      if (index > deletedIndex) {
        this.keyIndex.set(token, index - 1);
        continue;
      }
      if (token !== deletedToken) {
        this.keyIndex.delete(token);
        continue;
      }
      let replacement = -1;
      for (let i = deletedIndex; i < this.keys.length; i += 1) {
        if (LingoPropList.keyIndexToken(this.keys[i]!) === token) {
          replacement = i;
          break;
        }
      }
      if (replacement >= 0) {
        this.keyIndex.set(token, replacement);
      } else {
        this.keyIndex.delete(token);
      }
    }
  }

  private rememberAppendedKey(key: LingoValue, index: number): void {
    if (!this.keyIndex) return;
    const token = LingoPropList.keyIndexToken(key);
    if (token !== null && !this.keyIndex.has(token)) {
      this.keyIndex.set(token, index);
    }
  }

  private indexedPosition(
    key: LingoValue,
    equals: (a: LingoValue, b: LingoValue) => boolean,
  ): number | LingoVoid | null {
    const token = LingoPropList.keyIndexToken(key);
    if (token === null) return null;
    if (!this.keyIndex) {
      this.keyIndex = new Map();
      for (let i = 0; i < this.keys.length; i += 1) {
        const entryToken = LingoPropList.keyIndexToken(this.keys[i]!);
        if (entryToken !== null && !this.keyIndex.has(entryToken)) {
          this.keyIndex.set(entryToken, i);
        }
      }
    }
    const index = this.keyIndex.get(token);
    if (index === undefined) {
      return LingoPropList.canTrustIndexedMiss(equals) ? LINGO_VOID : null;
    }
    const candidate = this.keys[index];
    if (candidate !== undefined && equals(candidate, key)) {
      return index + 1;
    }
    return null;
  }

  findPos(key: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number | LingoVoid {
    const indexed = this.indexedPosition(key, equals);
    if (indexed !== null) return indexed;
    for (let i = 0; i < this.keys.length; i += 1) {
      if (equals(this.keys[i]!, key)) {
        return i + 1;
      }
    }
    return LINGO_VOID;
  }

  /** getaProp: VOID when missing. */
  getaProp(key: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): LingoValue {
    const pos = this.findPos(key, equals);
    return pos instanceof LingoVoid ? LINGO_VOID : this.values[pos - 1]!;
  }

  /** getProp: script error when missing. */
  getProp(key: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): LingoValue {
    const pos = this.findPos(key, equals);
    if (pos instanceof LingoVoid) {
      throw new RangeError(`property not found: ${String(key)}`);
    }
    return this.values[pos - 1]!;
  }

  /** setaProp: replace existing or append. */
  setaProp(
    key: LingoValue,
    value: LingoValue,
    equals: (a: LingoValue, b: LingoValue) => boolean,
  ): void {
    const pos = this.findPos(key, equals);
    if (pos instanceof LingoVoid) {
      this.insert(key, value);
    } else {
      this.values[pos - 1] = value;
    }
  }

  /** addProp: always appends (allows duplicate keys, matching Lingo). */
  addProp(
    key: LingoValue,
    value: LingoValue,
    compare?: (a: LingoValue, b: LingoValue) => number,
  ): void {
    if (this.sorted && compare) {
      let index = this.keys.length;
      for (let i = 0; i < this.keys.length; i += 1) {
        if (compare(this.keys[i]!, key) > 0) {
          index = i;
          break;
        }
      }
      this.keys.splice(index, 0, key);
      this.values.splice(index, 0, value);
      this.invalidateKeyIndex();
      return;
    }
    this.keys.push(key);
    this.values.push(value);
    this.rememberAppendedKey(key, this.keys.length - 1);
  }

  private insert(key: LingoValue, value: LingoValue): void {
    this.keys.push(key);
    this.values.push(value);
    this.rememberAppendedKey(key, this.keys.length - 1);
  }

  deleteProp(key: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number {
    const pos = this.findPos(key, equals);
    if (pos instanceof LingoVoid) {
      return 0;
    }
    const index = pos - 1;
    const deletedKey = this.keys[index]!;
    this.keys.splice(pos - 1, 1);
    this.values.splice(pos - 1, 1);
    this.noteDeletedKey(deletedKey, index);
    return 1;
  }

  deleteAt(position: number): void {
    if (position < 1 || position > this.keys.length) {
      throw new RangeError(`index out of range: ${position} of ${this.keys.length}`);
    }
    this.keys.splice(position - 1, 1);
    this.values.splice(position - 1, 1);
    this.invalidateKeyIndex();
  }

  deletePropsWhere(
    predicate: (key: LingoValue, value: LingoValue, position: number) => boolean,
  ): number {
    const nextKeys: LingoValue[] = [];
    const nextValues: LingoValue[] = [];
    let removed = 0;
    for (let index = 0; index < this.keys.length; index += 1) {
      const key = this.keys[index]!;
      const value = this.values[index]!;
      if (predicate(key, value, index + 1)) {
        removed += 1;
        continue;
      }
      nextKeys.push(key);
      nextValues.push(value);
    }
    if (removed > 0) {
      this.keys = nextKeys;
      this.values = nextValues;
      this.invalidateKeyIndex();
    }
    return removed;
  }

  getAt(position: number): LingoValue {
    if (position < 1 || position > this.values.length) {
      throw new RangeError(`index out of range: ${position} of ${this.values.length}`);
    }
    return this.values[position - 1]!;
  }

  setAt(position: number, value: LingoValue): void {
    if (position < 1 || position > this.values.length) {
      throw new RangeError(`index out of range: ${position} of ${this.values.length}`);
    }
    this.values[position - 1] = value;
  }

  getPropAt(position: number): LingoValue {
    if (position < 1 || position > this.keys.length) {
      throw new RangeError(`index out of range: ${position} of ${this.keys.length}`);
    }
    return this.keys[position - 1]!;
  }

  /** getPos for prop lists searches values (Lingo quirk). */
  getPos(value: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): number {
    for (let i = 0; i < this.values.length; i += 1) {
      if (equals(this.values[i]!, value)) {
        return i + 1;
      }
    }
    return 0;
  }

  /** getOne for prop lists searches values and returns the KEY (Lingo quirk),
   * or 0 when absent. */
  getOne(value: LingoValue, equals: (a: LingoValue, b: LingoValue) => boolean): LingoValue {
    const pos = this.getPos(value, equals);
    return pos === 0 ? 0 : this.keys[pos - 1]!;
  }

  getLast(): LingoValue {
    if (this.values.length === 0) {
      return LINGO_VOID;
    }
    return this.values[this.values.length - 1]!;
  }

  duplicate(): LingoPropList {
    const copy = new LingoPropList();
    copy.keys = this.keys.map(duplicateValue);
    copy.values = this.values.map(duplicateValue);
    copy.sorted = this.sorted;
    return copy;
  }

  /** sort orders entries by key ascending and keeps the list sorted. */
  sort(compare: (a: LingoValue, b: LingoValue) => number): void {
    const order = this.keys
      .map((key, index) => ({ key, index }))
      .sort((a, b) => compare(a.key, b.key));
    this.keys = order.map((entry) => this.keys[entry.index]!);
    this.values = order.map((entry) => this.values[entry.index]!);
    this.sorted = true;
    this.invalidateKeyIndex();
  }
}

/** duplicate() deep-copies nested lists, leaves other values as-is. */
export function duplicateValue(value: LingoValue): LingoValue {
  if (value instanceof LingoList || value instanceof LingoPropList) {
    return value.duplicate();
  }
  return value;
}
