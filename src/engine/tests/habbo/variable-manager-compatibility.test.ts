import { describe, expect, it } from "vitest";
import { Runtime, ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { LingoList } from "../../src/director/values";
import { installOriginsVariableManagerCompatibility } from "../../src/habbo/variableManagerCompatibility";

const variableContainerModule: GeneratedScriptModule = {
  scriptName: "Variable Container Class",
  scriptType: "parent",
  scriptProperties: [],
  scriptGlobals: [],
  handlers: {
    getstring(_ctx, _me, args) {
      return args[2] ?? "";
    },
    getvalue(ctx, _me, args) {
      return ctx.callLocal(_me, "value", [args[2] ?? ""]);
    },
  },
};

describe("Origins Variable Manager compatibility", () => {
  it("unwraps complete quoted string literals returned by getString", () => {
    const runtime = new Runtime();
    installOriginsVariableManagerCompatibility(runtime);
    const variableManager = new ScriptInstance(variableContainerModule);

    expect(runtime.callMethod(variableManager, "getstring", ["swap.animation.class", "\"Swap Animation Class\""])).toBe(
      "Swap Animation Class",
    );
    expect(runtime.callMethod(variableManager, "getstring", ["plain", "Swap Animation Class"])).toBe(
      "Swap Animation Class",
    );
    expect(runtime.callMethod(variableManager, "getstring", ["partial", "prefix \"Swap Animation Class\""])).toBe(
      "prefix \"Swap Animation Class\"",
    );
  });

  it("leaves value() list parsing on variable data untouched", () => {
    const runtime = new Runtime();
    installOriginsVariableManagerCompatibility(runtime);
    const variableManager = new ScriptInstance(variableContainerModule);

    const parsed = runtime.callMethod(variableManager, "getvalue", [
      "hotel.view.animations",
      "[[\"bicycle\", \"Entry Bicycle Class\"]]",
    ]);

    expect(parsed).toBeInstanceOf(LingoList);
    expect((parsed as LingoList).items.length).toBe(1);
  });
});
