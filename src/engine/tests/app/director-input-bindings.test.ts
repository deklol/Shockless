import { describe, expect, it } from "vitest";
import { DirectorInputBindings, type DirectorModifierState } from "../../src/habbo/ui/input/DirectorInputBindings";

function eventLike(values: {
  readonly key?: string;
  readonly code?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}): KeyboardEvent {
  return {
    key: values.key ?? "",
    code: values.code ?? "",
    shiftKey: Boolean(values.shiftKey),
    ctrlKey: Boolean(values.ctrlKey),
    altKey: Boolean(values.altKey),
    metaKey: Boolean(values.metaKey),
  } as KeyboardEvent;
}

describe("Director input bindings", () => {
  it("maps physical pointer modifiers into Director modifier state", () => {
    let last: DirectorModifierState | null = null;
    const bindings = new DirectorInputBindings({
      setKeyboardModifierState(modifiers) {
        last = {
          shiftDown: Boolean(modifiers.shiftDown),
          controlDown: Boolean(modifiers.controlDown),
          optionDown: Boolean(modifiers.optionDown),
          commandDown: Boolean(modifiers.commandDown),
        };
      },
    });

    const modifiers = bindings.apply(eventLike({ shiftKey: true, ctrlKey: true }));

    expect(modifiers).toEqual({
      shiftDown: true,
      controlDown: true,
      optionDown: false,
      commandDown: true,
    });
    expect(last).toEqual(modifiers);
  });

  it("keeps custom modifier bindings active while the bound key is held during a pointer click", () => {
    const bindings = new DirectorInputBindings({ setKeyboardModifierState() {} });
    bindings.setNativeKeyBinds({ shift: "F8", option: "F9" });

    bindings.rememberKeyDown(eventLike({ key: "F8", code: "F8" }));
    let modifiers = bindings.apply(eventLike({}), { includeKeyboardKey: false });

    expect(modifiers.shiftDown).toBe(true);
    expect(modifiers.optionDown).toBe(false);

    bindings.rememberKeyDown(eventLike({ key: "F9", code: "F9" }));
    modifiers = bindings.apply(eventLike({}), { includeKeyboardKey: false });

    expect(modifiers.shiftDown).toBe(true);
    expect(modifiers.optionDown).toBe(true);

    bindings.rememberKeyUp(eventLike({ key: "F8", code: "F8" }));
    modifiers = bindings.apply(eventLike({}), { includeKeyboardKey: false });

    expect(modifiers.shiftDown).toBe(false);
    expect(modifiers.optionDown).toBe(true);
  });
});
