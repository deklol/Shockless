import { describe, expect, it } from "vitest";
import { directorKeyForBrowserEvent, directorKeyForTextKey } from "../../src/director/keyboard";

describe("Director keyboard mapping", () => {
  it("maps printable keys to classic Mac virtual key codes, not ASCII", () => {
    expect(directorKeyForBrowserEvent({ key: "l", code: "KeyL" })).toEqual({ key: "l", code: 37 });
    expect(directorKeyForTextKey("l")).toEqual({ key: "l", code: 37 });
    expect(directorKeyForBrowserEvent({ key: "h", code: "KeyH" })).toEqual({ key: "h", code: 4 });
  });

  it("keeps Return and keypad Enter distinct for source handlers", () => {
    expect(directorKeyForBrowserEvent({ key: "Enter", code: "Enter" })).toEqual({ key: "\r", code: 36 });
    expect(directorKeyForBrowserEvent({ key: "Enter", code: "NumpadEnter" })).toEqual({ key: "\r", code: 76 });
    expect(directorKeyForTextKey("Enter")).toEqual({ key: "\r", code: 36 });
  });

  it("maps Director control keys used by generated Habbo source", () => {
    expect(directorKeyForBrowserEvent({ key: "Escape", code: "Escape" })).toEqual({ key: String.fromCharCode(27), code: 53 });
    expect(directorKeyForBrowserEvent({ key: "Tab", code: "Tab" })).toEqual({ key: "\t", code: 48 });
    expect(directorKeyForBrowserEvent({ key: "Delete", code: "Delete" })).toEqual({ key: String.fromCharCode(127), code: 117 });
    expect(directorKeyForBrowserEvent({ key: "ArrowLeft", code: "ArrowLeft" })).toEqual({ key: String.fromCharCode(28), code: 123 });
  });
});
