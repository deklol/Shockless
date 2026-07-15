export type DirectorKeyMapping = {
  key: string;
  code: number;
};

export type BrowserKeyboardEventLike = {
  key: string;
  code?: string | null;
};

const CONTROL_KEY_BY_BROWSER_KEY: Record<string, DirectorKeyMapping> = {
  Backspace: { key: "\b", code: 51 },
  Delete: { key: String.fromCharCode(127), code: 117 },
  Tab: { key: "\t", code: 48 },
  Escape: { key: String.fromCharCode(27), code: 53 },
  ArrowLeft: { key: String.fromCharCode(28), code: 123 },
  ArrowRight: { key: String.fromCharCode(29), code: 124 },
  ArrowDown: { key: String.fromCharCode(31), code: 125 },
  ArrowUp: { key: String.fromCharCode(30), code: 126 },
};

const ENTER_KEY: DirectorKeyMapping = { key: "\r", code: 36 };
const NUMPAD_ENTER_KEY: DirectorKeyMapping = { key: "\r", code: 76 };

// Director MX exposes `the keyCode` as classic Mac virtual key codes, not
// ASCII character codes. Habbo source checks these values directly, for
// example Return = 36 and keypad Enter = 76.
export const MAC_KEY_CODE_BY_BROWSER_CODE: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Equal: 24,
  Digit9: 25,
  Digit7: 26,
  Minus: 27,
  Digit8: 28,
  Digit0: 29,
  BracketRight: 30,
  KeyO: 31,
  KeyU: 32,
  BracketLeft: 33,
  KeyI: 34,
  KeyP: 35,
  KeyL: 37,
  KeyJ: 38,
  Quote: 39,
  KeyK: 40,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  KeyN: 45,
  KeyM: 46,
  Period: 47,
  Space: 49,
  Backquote: 50,
  NumpadDecimal: 65,
  NumpadMultiply: 67,
  NumpadAdd: 69,
  NumLock: 71,
  NumpadDivide: 75,
  NumpadEnter: 76,
  NumpadSubtract: 78,
  NumpadEqual: 81,
  Numpad0: 82,
  Numpad1: 83,
  Numpad2: 84,
  Numpad3: 85,
  Numpad4: 86,
  Numpad5: 87,
  Numpad6: 88,
  Numpad7: 89,
  Numpad8: 91,
  Numpad9: 92,
};

const MAC_KEY_CODE_BY_TEXT_KEY = new Map<string, number>([
  ["a", 0],
  ["s", 1],
  ["d", 2],
  ["f", 3],
  ["h", 4],
  ["g", 5],
  ["z", 6],
  ["x", 7],
  ["c", 8],
  ["v", 9],
  ["b", 11],
  ["q", 12],
  ["w", 13],
  ["e", 14],
  ["r", 15],
  ["y", 16],
  ["t", 17],
  ["1", 18],
  ["!", 18],
  ["2", 19],
  ["@", 19],
  ["3", 20],
  ["#", 20],
  ["4", 21],
  ["$", 21],
  ["6", 22],
  ["^", 22],
  ["5", 23],
  ["%", 23],
  ["=", 24],
  ["+", 24],
  ["9", 25],
  ["(", 25],
  ["7", 26],
  ["&", 26],
  ["-", 27],
  ["_", 27],
  ["8", 28],
  ["*", 28],
  ["0", 29],
  [")", 29],
  ["]", 30],
  ["}", 30],
  ["o", 31],
  ["u", 32],
  ["[", 33],
  ["{", 33],
  ["i", 34],
  ["p", 35],
  ["l", 37],
  ["j", 38],
  ["'", 39],
  ['"', 39],
  ["k", 40],
  [";", 41],
  [":", 41],
  ["\\", 42],
  ["|", 42],
  [",", 43],
  ["<", 43],
  ["/", 44],
  ["?", 44],
  ["n", 45],
  ["m", 46],
  [".", 47],
  [">", 47],
  [" ", 49],
  ["`", 50],
  ["~", 50],
]);

function printableKeyCodeFor(key: string, browserCode?: string | null): number | null {
  if (browserCode) {
    const physicalCode = MAC_KEY_CODE_BY_BROWSER_CODE[browserCode];
    if (physicalCode !== undefined) return physicalCode;
  }
  return MAC_KEY_CODE_BY_TEXT_KEY.get(key.toLowerCase()) ?? null;
}

export function directorKeyForBrowserEvent(event: BrowserKeyboardEventLike): DirectorKeyMapping | null {
  if (event.key === "Enter") {
    return event.code === "NumpadEnter" ? NUMPAD_ENTER_KEY : ENTER_KEY;
  }
  const control = CONTROL_KEY_BY_BROWSER_KEY[event.key];
  if (control) return control;
  if (event.key.length !== 1) return null;
  const code = printableKeyCodeFor(event.key, event.code);
  return code === null ? null : { key: event.key, code };
}

export function directorKeyForTextKey(key: string): DirectorKeyMapping | null {
  if (key === "Enter") return ENTER_KEY;
  const control = CONTROL_KEY_BY_BROWSER_KEY[key];
  if (control) return control;
  if (key.length !== 1) return null;
  const code = printableKeyCodeFor(key);
  return code === null ? null : { key, code };
}
