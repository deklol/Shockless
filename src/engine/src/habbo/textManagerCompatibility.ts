import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LINGO_VOID, LingoPropList, LingoVoid, type LingoValue } from "@director/values";
import { convertRelease306SpecialChars } from "./stringServicesCompatibility";

const installedRuntimes = new WeakSet<Runtime>();

function instancePropValue(instance: ScriptInstance, name: string): LingoValue | undefined {
  const key = name.toLowerCase();
  let target: ScriptInstance | null = instance;
  while (target) {
    if (target.props.has(key)) return target.props.get(key);
    const ancestor = target.props.get("ancestor");
    target = ancestor instanceof ScriptInstance ? ancestor : null;
  }
  return undefined;
}

function trimDirectorWords(text: string): string {
  const first = text.search(/\S/);
  if (first < 0) return "";
  let last = text.length - 1;
  while (last >= first && /\s/.test(text[last]!)) {
    last -= 1;
  }
  return text.slice(first, last + 1);
}

function firstDirectorWord(text: string): string {
  const trimmed = trimDirectorWords(text);
  const match = /^\S+/.exec(trimmed);
  return match?.[0] ?? "";
}

function itemRangeFromSecond(text: string, delimiter: string): string {
  if (delimiter.length === 0) return "";
  const first = text.indexOf(delimiter);
  if (first < 0) return "";
  return text.slice(first + delimiter.length);
}

function splitDirectorItems(text: string, delimiter: string): string[] {
  if (delimiter.length === 0) return [text];
  return text.split(delimiter);
}

function replaceChunksCaseInsensitive(text: string, mark: string, replacement: string): string {
  if (mark.length === 0 || text.length === 0) return text;
  let source = text;
  let output = "";
  const lowerMark = mark.toLowerCase();
  while (true) {
    const pos = source.toLowerCase().indexOf(lowerMark);
    if (pos < 0) break;
    output += source.slice(0, pos);
    output += replacement;
    source = source.slice(pos + mark.length);
  }
  return output + source;
}

export function parseRelease306TextDump(
  text: string,
  delimiter: string,
  convList: LingoPropList,
): LingoPropList {
  const result = new LingoPropList();
  const pairDelimiter = delimiter.length > 0 ? delimiter : "\r";
  for (const pair of splitDirectorItems(text, pairDelimiter)) {
    if (pair === "") continue;
    const firstWord = firstDirectorWord(pair);
    if (firstWord.charAt(0) === "#") continue;

    const equalsPos = pair.indexOf("=");
    const propText = trimDirectorWords(equalsPos < 0 ? pair : pair.slice(0, equalsPos));
    let valueText = trimDirectorWords(itemRangeFromSecond(pair, "="));
    valueText = convertRelease306SpecialChars(valueText, 0, convList);
    valueText = replaceChunksCaseInsensitive(valueText, "\\r", "\r");
    valueText = replaceChunksCaseInsensitive(valueText, "\\t", "\t");
    valueText = replaceChunksCaseInsensitive(valueText, "\\s", " ");
    valueText = replaceChunksCaseInsensitive(valueText, "<BR>", "\r");
    result.setaProp(propText, valueText, ops.lingoKeyEquals);
  }
  return result;
}

function dumpRelease306TextManagerFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  field: LingoValue,
  delimiterArg: LingoValue,
): LingoValue | null {
  const itemList = instancePropValue(receiver, "pitemlist");
  if (!(itemList instanceof LingoPropList)) return null;

  let fieldText: LingoValue;
  try {
    fieldText = runtime.call("field", [field]);
  } catch {
    return null;
  }
  if (fieldText instanceof LingoVoid) return null;

  let stringServices: LingoValue = LINGO_VOID;
  try {
    stringServices = runtime.call("getstringservices", []);
  } catch {
    return null;
  }
  if (!(stringServices instanceof ScriptInstance)) return null;
  const convList = instancePropValue(stringServices, "pconvlist");
  if (!(convList instanceof LingoPropList)) return null;

  const previousDelimiter = runtime.theProp("itemdelimiter");
  const delimiter = delimiterArg instanceof LingoVoid ? "\r" : ops.stringOf(delimiterArg);
  try {
    runtime.setTheProp("itemdelimiter", delimiter);
    const parsed = parseRelease306TextDump(ops.stringOf(fieldText), delimiter, convList);
    for (let index = 0; index < parsed.keys.length; index += 1) {
      itemList.setaProp(parsed.keys[index]!, parsed.values[index]!, ops.lingoKeyEquals);
    }
    return 1;
  } finally {
    runtime.setTheProp("itemdelimiter", previousDelimiter);
  }
}

function getRelease306TextManagerFast(receiver: ScriptInstance, key: LingoValue, defaultValue: LingoValue): LingoValue | null {
  const itemList = instancePropValue(receiver, "pitemlist");
  if (!(itemList instanceof LingoPropList)) return null;

  const value = itemList.getaProp(key, ops.lingoKeyEquals);
  if (!(value instanceof LingoVoid)) return value;
  const compatibleValue = itemList.getaProp(key, ops.lingoEquals);
  if (!(compatibleValue instanceof LingoVoid)) return compatibleValue;

  // Source Text Manager logs every missing key even when the caller supplies
  // a fallback. Timer-driven UI such as the bulletin clock legitimately uses
  // that fallback path every tick, so returning the same source value here
  // avoids unbounded diagnostic spam without changing displayed text.
  if (!(defaultValue instanceof LingoVoid)) return defaultValue;
  return null;
}

/**
 * Source-equivalent fast path for release306 Text Manager Class.dump.
 *
 * The generated handler is correct but expensive because every item/word/char
 * chunk and every String Services call crosses the generic Lingo dispatch
 * layer. The source writes only Text Manager.pItemList, so this host path
 * performs the same field parsing directly and falls back to generated Lingo
 * whenever the expected release306 source state is not present.
 */
export function installRelease306TextManagerCompatibility(runtime: Runtime): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (
      receiver instanceof ScriptInstance &&
      receiver.module.scriptName === "Text Manager Class" &&
      method.toLowerCase() === "get"
    ) {
      const result = getRelease306TextManagerFast(
        receiver,
        args[0] ?? LINGO_VOID,
        args[1] ?? LINGO_VOID,
      );
      if (result !== null) return result;
    }
    if (
      receiver instanceof ScriptInstance &&
      receiver.module.scriptName === "Text Manager Class" &&
      method.toLowerCase() === "dump"
    ) {
      const result = dumpRelease306TextManagerFast(
        runtime,
        receiver,
        args[0] ?? LINGO_VOID,
        args[1] ?? LINGO_VOID,
      );
      if (result !== null) return result;
    }
    return originalCallMethod(receiver, method, args);
  };
}
