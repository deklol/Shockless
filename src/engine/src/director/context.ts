import type { LingoValue } from "./values";

export type { LingoValue };

/**
 * The runtime surface generated code calls. Implemented by Runtime.
 * Every member corresponds to a Lingo construct; nothing here is
 * Habbo-specific.
 */
export interface LingoContext {
  /** Free handler/builtin/command call by lowercased name. */
  call(name: string, args: LingoValue[]): LingoValue;
  /** Bare call from inside a handler: tries `me`'s own script (and
   * ancestors) first, then global handlers/builtins - Lingo's dispatch
   * order. */
  callLocal(me: LingoValue, name: string, args: LingoValue[]): LingoValue;
  /** receiver.method(args) */
  callMethod(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue;
  /** receiver.property read / write */
  getProp(receiver: LingoValue, property: string): LingoValue;
  setProp(receiver: LingoValue, property: string, value: LingoValue): void;
  /** receiver[indices], receiver[start..end] */
  getIndex(receiver: LingoValue, indices: LingoValue[], rangeEnd: LingoValue | null): LingoValue;
  setIndex(
    receiver: LingoValue,
    indices: LingoValue[],
    rangeEnd: LingoValue | null,
    value: LingoValue,
  ): void;
  /** `the prop` / `the prop of obj` */
  theProp(property: string): LingoValue;
  setTheProp(property: string, value: LingoValue): void;
  theOf(property: string, object: LingoValue): LingoValue;
  setTheOf(property: string, object: LingoValue, value: LingoValue): void;
  /** member "x" of castLib "y", sprite 3, script "Foo", ... */
  objectRef(refType: string, id: LingoValue, castLib: LingoValue | null): LingoValue;
  /** globals */
  getGlobal(name: string): LingoValue;
  setGlobal(name: string, value: LingoValue): void;
  /** script-instance property access for `me` */
  getInstanceProp(me: LingoValue, name: string): LingoValue;
  setInstanceProp(me: LingoValue, name: string, value: LingoValue): void;
  /** put debug output */
  put(values: LingoValue[]): void;
  putInto(mode: "into" | "after" | "before", value: LingoValue, target: unknown): void;
  /** chunk expressions */
  chunk(
    chunkType: string,
    start: LingoValue,
    end: LingoValue | null,
    source: LingoValue,
  ): LingoValue;
  countOf(chunkType: string, source: LingoValue | null): LingoValue;
  lastChunk(chunkType: string, source: LingoValue): LingoValue;
  /** list helpers used by generated loops */
  listCount(list: LingoValue): number;
  /** `delete <chunk> of <stringVar>`: returns the modified string. */
  deleteChunk(source: string, chunkType: string, start: number, end: number | null): string;
  /** `put <value> into|after|before <chunk>`: returns the modified string. */
  replaceChunk(
    source: string,
    chunkType: string,
    start: number,
    end: number | null,
    value: LingoValue,
    mode: "into" | "after" | "before",
  ): string;
  /** structured failure for source constructs the runtime cannot honor yet */
  unsupported(feature: string): never;
}
