import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LingoPropList, LingoVoid, type LingoValue } from "@director/values";

const installedRuntimes = new WeakSet<Runtime>();

function directionNumber(value: LingoValue): number {
  if (value instanceof LingoVoid) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(ops.stringOf(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function convertRelease306SpecialChars(
  input: LingoValue,
  direction: LingoValue,
  convList: LingoPropList,
): string {
  const text = ops.stringOf(input);
  if (convList.count() === 0 || text.length === 0) return text;

  const reverse = directionNumber(direction) !== 0;
  const output: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (reverse) {
      const pos = convList.getPos(char, ops.lingoEquals);
      output.push(pos > 0 ? ops.stringOf(convList.getPropAt(pos)) : char);
    } else {
      const converted = convList.getaProp(char, ops.lingoKeyEquals);
      output.push(converted instanceof LingoVoid ? char : ops.stringOf(converted));
    }
  }
  return output.join("");
}

/**
 * Source-backed fast path for release306 String Services Class.convertSpecialChars.
 *
 * On Unicode Director the source initializes pConvList to an empty prop list
 * and convertSpecialChars is therefore an identity transform. Running the
 * generated character loop through full Lingo dispatch makes text dumps and
 * large packet fields stall the browser, so keep the same data contract while
 * executing it as a direct host operation.
 */
export function installRelease306StringServicesCompatibility(runtime: Runtime): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (
      receiver instanceof ScriptInstance &&
      receiver.module.scriptName === "String Services Class" &&
      method.toLowerCase() === "convertspecialchars"
    ) {
      const convList = receiver.props.get("pconvlist");
      if (convList instanceof LingoPropList) {
        return convertRelease306SpecialChars(args[0] ?? "", args[1] ?? 0, convList);
      }
    }
    return originalCallMethod(receiver, method, args);
  };
}
