import type { Runtime, ScriptInstance } from "@director/Runtime";
import * as ops from "@director/ops";
import { type LingoValue } from "@director/values";

const installedRuntimes = new WeakSet<Runtime>();

function unwrapQuotedStringLiteral(runtime: Runtime, value: LingoValue): LingoValue {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return value;
  }
  const parsed = runtime.call("value", [trimmed]);
  return typeof parsed === "string" ? parsed : value;
}

export function installOriginsVariableManagerCompatibility(runtime: Runtime): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    const result = originalCallMethod(receiver, method, args);
    if (
      (receiver as ScriptInstance)?.module?.scriptName === "Variable Container Class" &&
      method.toLowerCase() === "getstring"
    ) {
      return unwrapQuotedStringLiteral(runtime, result);
    }
    return result;
  };
}

export function originsVariableStringValue(runtime: Runtime, value: LingoValue): string {
  return ops.stringOf(unwrapQuotedStringLiteral(runtime, value));
}
