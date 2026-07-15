import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Director input stage pump policy", () => {
  const appMainSource = (): string => readFileSync(join(process.cwd(), "src", "app", "main.ts"), "utf8");
  const roomStagePresentationSource = (): string =>
    readFileSync(join(process.cwd(), "src", "habbo", "room", "RoomStagePresentationController.ts"), "utf8");
  const sourceWindowInteractionSource = (): string =>
    readFileSync(join(process.cwd(), "src", "habbo", "ui", "window", "SourceWindowInteractionController.ts"), "utf8");
  const sourceInputAutomationSource = (): string =>
    readFileSync(join(process.cwd(), "src", "habbo", "ui", "input", "SourceInputAutomation.ts"), "utf8");

  it("does not pump updateStage from pointer movement frequency", () => {
    const source = appMainSource();
    const pointerMoveListener = /app\.canvas\.addEventListener\("pointermove", \(event\) => \{(?<body>[\s\S]*?)\n  \}\);/.exec(source)?.groups?.body ?? "";
    expect(pointerMoveListener).not.toContain("movie.updateStage()");
  });

  it("routes Source window input in raw stage coordinates before room zoom transforms", () => {
    const source = roomStagePresentationSource();
    const sourcePointMapper =
      /sourcePoint\(point: \{ x: number; y: number \}\): \{ x: number; y: number \} \{(?<body>[\s\S]*?)\n  \}/.exec(source)
        ?.groups?.body ?? "";

    expect(sourcePointMapper).toContain("if (this.dependencies.sourceWindowContainsPoint(point.x, point.y)) return point;");
    expect(sourcePointMapper.indexOf("this.dependencies.sourceWindowContainsPoint(point.x, point.y)")).toBeLessThan(
      sourcePointMapper.indexOf("presentation.originX + (point.x - presentation.originX) / presentation.scale"),
    );
  });

  it("treats nested Source window elements as UI hit areas", () => {
    const source = sourceWindowInteractionSource();
    const sourceWindowContainsPoint =
      /containsPoint\(x: number, y: number\): boolean \{(?<body>[\s\S]*?)\n  \}/.exec(source)?.groups?.body ?? "";

    expect(source).toContain("allElements(windowObject: ScriptInstance): ScriptInstance[]");
    expect(sourceWindowContainsPoint).toContain("for (const element of this.allElements(windowObject))");
    expect(sourceWindowContainsPoint).not.toContain("for (const element of this.elements(windowObject))");
  });

  it("uses generated Source window ownership and prefers interactive controls over passive backgrounds", () => {
    const source = sourceWindowInteractionSource();
    const elementRect = /elementRect\(element: ScriptInstance\): LingoRect \| null \{(?<body>[\s\S]*?)\n  \}/.exec(source)
      ?.groups?.body ?? "";
    const sourceWindowTargetSpriteAt =
      /targetSpriteAt\(windowObject: ScriptInstance, x: number, y: number\): SpriteChannel \| null \{(?<body>[\s\S]*?)\n  \}/.exec(
        source,
      )?.groups?.body ?? "";
    const sourceWindowElementInteractivityRank =
      /interactivityRank\(windowObject: ScriptInstance, element: ScriptInstance\): number \{(?<body>[\s\S]*?)\n  \}/.exec(
        source,
      )?.groups?.body ?? "";
    const sourceWindowOwnsSpriteAt =
      /ownsSpriteAt\(sprite: SpriteChannel, x: number, y: number\): boolean \| null \{(?<body>[\s\S]*?)\n  \}/.exec(source)
        ?.groups?.body ?? "";
    const sourceWindowGlobalTarget =
      /targetSpriteAcrossWindowsAt\(x: number, y: number\): SpriteChannel \| null \{(?<body>[\s\S]*?)\n  \}/.exec(source)
        ?.groups?.body ?? "";

    expect(source).toContain("targetSpriteAcrossWindowsAt(x: number, y: number): SpriteChannel | null");
    expect(source).toContain("targetSpriteAt(windowObject: ScriptInstance, x: number, y: number): SpriteChannel | null");
    expect(elementRect).toContain("this.hasElementProp(element, \"pownx\")");
    expect(elementRect).toContain("this.elementStyle(element) === \"grouped\"");
    expect(source).toContain("treeUsesPointerCursor(element: ScriptInstance): boolean");
    expect(source).toContain("isSpecialControl(windowObject: ScriptInstance, element: ScriptInstance): boolean");
    expect(sourceWindowTargetSpriteAt).toContain("sourceIndex,");
    expect(source).toContain("interactivityRank(windowObject: ScriptInstance, element: ScriptInstance): number");
    expect(sourceWindowElementInteractivityRank).toContain("this.treeUsesPointerCursor(element)");
    expect(sourceWindowElementInteractivityRank).not.toContain("elementHasPointerHandler");
    expect(sourceWindowTargetSpriteAt).toContain("rank: this.interactivityRank(windowObject, element)");
    expect(sourceWindowTargetSpriteAt).toContain(
      "right.rank - left.rank ||",
    );
    expect(sourceWindowTargetSpriteAt).toContain(
      "left.area - right.area",
    );
    expect(sourceWindowOwnsSpriteAt).toContain("const targetSprite = this.targetSpriteAcrossWindowsAt(x, y);");
    expect(sourceWindowOwnsSpriteAt).toContain("return sprite === targetSprite;");
    expect(sourceWindowGlobalTarget).toContain("this.targetSpriteAt(windowObject, x, y)");
    expect(sourceWindowGlobalTarget).toContain("right.locZ - left.locZ || right.number - left.number");
  });

  it("submits credentials only through the authored login window fields", () => {
    const source = sourceInputAutomationSource();
    const login = /async login\(email: string, password: string, delayMs = 0\): Promise<SourceLoginResult> \{(?<body>[\s\S]*?)\n  \}/.exec(
      source,
    )?.groups?.body ?? "";

    expect(login).toContain('windowById(windowManager, LingoSymbol.for("login_b"))');
    expect(login).toContain('callMethod(loginWindow, "getelement", ["login_username"])');
    expect(login).toContain('callMethod(loginWindow, "getelement", ["login_password"])');
    expect(login).not.toContain("const fields = this.editableFields()");
  });
});
