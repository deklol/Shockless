import { describe, expect, it } from "vitest";
import { LingoPoint, LingoRect } from "@director/geometry";
import { Runtime, ScriptInstance, type GeneratedScriptModule } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoList, LingoPropList, LingoSymbol, type LingoValue } from "@director/values";
import { installWallItemAnywhereCompatibility } from "../src/habbo/furni/wall/WallItemAnywhereCompatibility";

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

describe("wall item anywhere compatibility", () => {
  it("synthesizes a valid Object Mover wall hit from the nearest real wall part", () => {
    const runtime = new Runtime();
    const visualizer = new ScriptInstance(
      moduleWithHandlers(
        "Visualizer Instance Class",
        {
          getwallpartunderrect: () => LingoPropList.fromPairs([[LingoSymbol.for("insideWall"), 0]]),
        },
        ["pwrappedparts"],
      ),
    );
    const wallSprite = new SpriteChannel(700);
    wallSprite.locZ = -100;
    const wallPart = LingoPropList.fromPairs([
      [LingoSymbol.for("locx"), 7],
      [LingoSymbol.for("locy"), 3],
      [LingoSymbol.for("screenrect"), new LingoRect(100, 100, 180, 180)],
    ]);
    const wrapper = new ScriptInstance(
      moduleWithHandlers(
        "Visualizer Part Wrapper Class",
        {
          getproperty: (_ctx, _me, args: LingoValue[]) => {
            const key = args[1];
            return key instanceof LingoSymbol && key.name.toLowerCase() === "type" ? LingoSymbol.for("wallleft") : 0;
          },
        },
        ["ppartlist", "psprite"],
      ),
    );
    wrapper.props.set("ppartlist", new LingoList([wallPart]));
    wrapper.props.set("psprite", wallSprite);
    visualizer.props.set("pwrappedparts", new LingoList([wrapper]));

    const controller = installWallItemAnywhereCompatibility(runtime);
    runtime.callStack.push("Object Mover Class.moveitem");
    try {
      const disabled = runtime.callMethod(visualizer, "getwallpartunderrect", [new LingoRect(300, 320, 330, 350), 0.5]);
      expect(disabled).toBeInstanceOf(LingoPropList);
      expect((disabled as LingoPropList).getaProp(LingoSymbol.for("insideWall"), () => true)).toBe(0);

      controller.setEnabled(true);
      const result = runtime.callMethod(visualizer, "getwallpartunderrect", [new LingoRect(300, 320, 330, 350), 0.5]);
      expect(result).toBeInstanceOf(LingoPropList);
      const props = result as LingoPropList;
      expect(props.getaProp(LingoSymbol.for("insideWall"), () => true)).toBe(1);
      expect(String(props.getaProp(LingoSymbol.for("direction"), () => true))).toBe("leftwall");
      const wallLocation = props.getaProp(LingoSymbol.for("wallLocation"), () => true);
      const localCoordinate = props.getaProp(LingoSymbol.for("localCoordinate"), () => true);
      expect(wallLocation).toBeInstanceOf(LingoPoint);
      expect(localCoordinate).toBeInstanceOf(LingoPoint);
      expect((wallLocation as LingoPoint).lingoToString()).toBe("point(7, 3)");
      expect((localCoordinate as LingoPoint).lingoToString()).toBe("point(200, 220)");
      const wallSprites = props.getaProp(LingoSymbol.for("wallSprites"), () => true);
      expect(wallSprites).toBeInstanceOf(LingoList);
      expect((wallSprites as LingoList).items[0]).toBe(wallSprite);
    } finally {
      runtime.callStack.pop();
    }
  });
});
