import { describe, expect, it } from "vitest";
import { Runtime, ScriptInstance, type GeneratedScriptModule } from "@director/Runtime";
import { LingoList, LingoPropList, LingoSymbol, type LingoValue } from "@director/values";
import { installFloorItemAnywhereCompatibility } from "../src/habbo/furni/floor/FloorItemAnywhereCompatibility";

const moduleWithHandlers = (
  scriptName: string,
  handlers: GeneratedScriptModule["handlers"],
  scriptProperties: string[] = [],
): GeneratedScriptModule => ({
  scriptName,
  scriptType: "parent",
  scriptProperties,
  scriptGlobals: [],
  handlers,
});

function roomGeometry(): ScriptInstance {
  const geometry = new ScriptInstance(
    moduleWithHandlers(
      "Room Geometry Class",
      {
        getworldcoordinate: () => 0,
        getfloorcoordinate: () => 0,
        emptytile: () => 0,
      },
      ["pxoffset", "pyoffset", "pxfactor", "pyfactor", "phfactor", "pheightmap", "pplacemap"],
    ),
  );
  geometry.props.set("pxoffset", 0);
  geometry.props.set("pyoffset", 0);
  geometry.props.set("pxfactor", 32);
  geometry.props.set("pyfactor", 16);
  geometry.props.set("phfactor", 8);
  geometry.props.set("pheightmap", new LingoList([new LingoList([0, 0]), new LingoList([0, 0])]));
  geometry.props.set("pplacemap", new LingoList([new LingoList([100000, 100000]), new LingoList([100000, 100000])]));
  return geometry;
}

describe("floor item anywhere compatibility", () => {
  it("projects failed Object Mover floor hit tests onto the room floor plane only while enabled", () => {
    const runtime = new Runtime();
    const geometry = roomGeometry();
    const controller = installFloorItemAnywhereCompatibility(runtime);

    runtime.callStack.push("Object Mover Class.moveactive");
    try {
      expect(runtime.callMethod(geometry, "getworldcoordinate", [100, 100])).toBe(0);

      controller.setEnabled(true);
      const result = runtime.callMethod(geometry, "getworldcoordinate", [100, 100]);
      expect(result).toBeInstanceOf(LingoList);
      expect((result as LingoList).items).toEqual([8, 3, 0]);
      expect(controller.summary()).toMatchObject({ enabled: true, synthesizedCount: 1 });
    } finally {
      runtime.callStack.pop();
    }
  });

  it("does not replace valid native coordinates", () => {
    const runtime = new Runtime();
    const nativeCoordinate = new LingoList([1, 1, 0]);
    const geometry = new ScriptInstance(
      moduleWithHandlers(
        "Room Geometry Class",
        {
          getworldcoordinate: () => nativeCoordinate,
        },
        ["pxoffset", "pyoffset", "pxfactor", "pyfactor", "phfactor"],
      ),
    );
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Object Mover Class.moveactive");
    try {
      expect(runtime.callMethod(geometry, "getworldcoordinate", [100, 100])).toBe(nativeCoordinate);
      expect(controller.summary()).toMatchObject({ acceptedNativeCount: 1, synthesizedCount: 0 });
    } finally {
      runtime.callStack.pop();
    }
  });

  it("projects failed coordinates during Object Mover commit property reads", () => {
    const runtime = new Runtime();
    const geometry = roomGeometry();
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Room Interface Class.placefurniture", "Object Mover Class.getproperty");
    try {
      const result = runtime.callMethod(geometry, "getworldcoordinate", [100, 100]);
      expect(result).toBeInstanceOf(LingoList);
      expect((result as LingoList).items).toEqual([8, 3, 0]);
      expect(controller.summary()).toMatchObject({ enabled: true, synthesizedCount: 1 });
    } finally {
      runtime.callStack.pop();
      runtime.callStack.pop();
    }
  });

  it("rewrites only synthetic off-map move commits to the source advanced floor-location packet", () => {
    const runtime = new Runtime();
    const geometry = roomGeometry();
    const sent: Array<{ command: LingoValue; payload: LingoValue }> = [];
    const roomConnection = new ScriptInstance(
      moduleWithHandlers("Room Connection Class", {
        send: (_ctx, _me, args) => {
          sent.push({ command: args[1]!, payload: args[2]! });
          return 1;
        },
      }),
    );
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Room Interface Class.placefurniture", "Object Mover Class.getproperty");
    try {
      const projected = runtime.callMethod(geometry, "getworldcoordinate", [100, 100]);
      expect(projected).toBeInstanceOf(LingoList);
      expect((projected as LingoList).items).toEqual([8, 3, 0]);
    } finally {
      runtime.callStack.pop();
      runtime.callStack.pop();
    }

    runtime.callStack.push("Room Interface Class.eventprocroom");
    try {
      const movePayload = LingoPropList.fromPairs([
        [LingoSymbol.for("integer"), 42],
        [LingoSymbol.for("integer"), 8],
        [LingoSymbol.for("integer"), 3],
        [LingoSymbol.for("integer"), 2],
      ]);
      expect(runtime.callMethod(roomConnection, "send", ["MOVESTUFF", movePayload])).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.command).toBe("ORIGINS_SET_FURNI_LOCATION");
      expect(sent[0]!.payload).toBeInstanceOf(LingoPropList);
      expect((sent[0]!.payload as LingoPropList).values).toEqual([42, 8, 3, "0.000"]);
      expect(controller.summary()).toMatchObject({ advancedCommitCount: 1, lastSynthetic: null });
    } finally {
      runtime.callStack.pop();
    }
  });

  it("keeps regular room-interface move commits on MOVESTUFF when no synthetic coordinate was used", () => {
    const runtime = new Runtime();
    const sent: Array<{ command: LingoValue; payload: LingoValue }> = [];
    const roomConnection = new ScriptInstance(
      moduleWithHandlers("Room Connection Class", {
        send: (_ctx, _me, args) => {
          sent.push({ command: args[1]!, payload: args[2]! });
          return 1;
        },
      }),
    );
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Room Interface Class.eventprocroom");
    try {
      const movePayload = LingoPropList.fromPairs([
        [LingoSymbol.for("integer"), 42],
        [LingoSymbol.for("integer"), 1],
        [LingoSymbol.for("integer"), 1],
        [LingoSymbol.for("integer"), 2],
      ]);
      expect(runtime.callMethod(roomConnection, "send", ["MOVESTUFF", movePayload])).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.command).toBe("MOVESTUFF");
      expect(sent[0]!.payload).toBe(movePayload);
      expect(controller.summary()).toMatchObject({ advancedCommitCount: 0 });
    } finally {
      runtime.callStack.pop();
    }
  });

  it("keeps unrelated floor coordinate lookups native even while enabled", () => {
    const runtime = new Runtime();
    const geometry = roomGeometry();
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Room Interface Class.eventprocroom");
    try {
      expect(runtime.callMethod(geometry, "getworldcoordinate", [100, 100])).toBe(0);
      expect(controller.summary()).toMatchObject({ enabled: true, synthesizedCount: 0 });
    } finally {
      runtime.callStack.pop();
    }
  });

  it("allows only out-of-map emptytile checks used by older Object Mover variants", () => {
    const runtime = new Runtime();
    const geometry = roomGeometry();
    const controller = installFloorItemAnywhereCompatibility(runtime);
    controller.setEnabled(true);

    runtime.callStack.push("Object Mover Class.moveactive");
    try {
      expect(runtime.callMethod(geometry, "emptytile", [0, 0])).toBe(0);
      expect(runtime.callMethod(geometry, "emptytile", [-1, 0])).toBe(1);
      expect(runtime.callMethod(geometry, "emptytile", [2, 0])).toBe(1);
      expect(controller.summary()).toMatchObject({ allowedOutsideEmptyChecks: 2 });
    } finally {
      runtime.callStack.pop();
    }
  });
});
