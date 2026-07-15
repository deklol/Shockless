import type { DirectorMovie } from "../../../director/Movie";

export type DirectorModifierName = "shift" | "control" | "option" | "command";

export type DirectorModifierBindings = Readonly<Record<DirectorModifierName, string>>;

export type DirectorModifierState = {
  readonly shiftDown: boolean;
  readonly controlDown: boolean;
  readonly optionDown: boolean;
  readonly commandDown: boolean;
};

export const DEFAULT_DIRECTOR_MODIFIER_BINDINGS: DirectorModifierBindings = {
  shift: "Shift",
  control: "Control",
  option: "Alt",
  command: "Control",
};

export class DirectorInputBindings {
  private readonly keyState = new Set<string>();
  private bindings: DirectorModifierBindings = { ...DEFAULT_DIRECTOR_MODIFIER_BINDINGS };

  constructor(private readonly movie: Pick<DirectorMovie, "setKeyboardModifierState">) {}

  setNativeKeyBinds(bindings: Partial<Record<DirectorModifierName, unknown>> = {}): Record<string, unknown> {
    this.bindings = {
      shift: normalizeKeyBindText(bindings.shift, DEFAULT_DIRECTOR_MODIFIER_BINDINGS.shift),
      control: normalizeKeyBindText(bindings.control, DEFAULT_DIRECTOR_MODIFIER_BINDINGS.control),
      option: normalizeKeyBindText(bindings.option, DEFAULT_DIRECTOR_MODIFIER_BINDINGS.option),
      command: normalizeKeyBindText(bindings.command, DEFAULT_DIRECTOR_MODIFIER_BINDINGS.command),
    };
    this.clear();
    return { ok: true, bindings: this.bindings };
  }

  currentBindings(): DirectorModifierBindings {
    return this.bindings;
  }

  rememberKeyDown(event: KeyboardEvent): void {
    for (const name of eventKeyNames(event)) this.keyState.add(name);
  }

  rememberKeyUp(event: KeyboardEvent): void {
    for (const name of eventKeyNames(event)) this.keyState.delete(name);
  }

  clear(): void {
    this.keyState.clear();
  }

  apply(
    event: KeyboardEvent | MouseEvent | WheelEvent | PointerEvent,
    options: { readonly includeKeyboardKey?: boolean } = {},
  ): DirectorModifierState {
    const modifiers = this.modifierState(event, options.includeKeyboardKey ?? true);
    this.movie.setKeyboardModifierState(modifiers);
    return modifiers;
  }

  private modifierState(
    event: KeyboardEvent | MouseEvent | WheelEvent | PointerEvent,
    includeKeyboardKey: boolean,
  ): DirectorModifierState {
    return {
      shiftDown: this.bindingActive(this.bindings.shift, event, includeKeyboardKey),
      controlDown: this.bindingActive(this.bindings.control, event, includeKeyboardKey),
      optionDown: this.bindingActive(this.bindings.option, event, includeKeyboardKey),
      commandDown: this.bindingActive(this.bindings.command, event, includeKeyboardKey),
    };
  }

  private bindingActive(
    binding: string,
    event: KeyboardEvent | MouseEvent | WheelEvent | PointerEvent,
    includeKeyboardKey: boolean,
  ): boolean {
    const parts = binding
      .split("+")
      .map((part) => normalizeKeyName(part))
      .filter(Boolean);
    if (parts.length === 0) return false;
    const eventNames = new Set(eventKeyNames(event, includeKeyboardKey));
    const hasName = (name: string): boolean => eventNames.has(name) || this.keyState.has(name);
    return parts.every((part) => hasName(part));
  }
}

export function normalizeKeyBindText(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, "").trim();
  return (text || fallback).slice(0, 80);
}

function normalizeKeyName(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  switch (text) {
    case "ctrl":
    case "control":
      return "control";
    case "cmd":
    case "command":
    case "meta":
    case "win":
    case "windows":
      return "meta";
    case "alt":
    case "option":
      return "alt";
    case "shift":
      return "shift";
    case " ":
    case "space":
    case "spacebar":
      return "space";
    case "esc":
      return "escape";
    case "del":
      return "delete";
    default:
      return text;
  }
}

function eventKeyNames(
  event: KeyboardEvent | MouseEvent | WheelEvent | PointerEvent,
  includeKeyboardKey = true,
): readonly string[] {
  const names: string[] = [];
  const keyboard = includeKeyboardKey && hasKeyboardIdentity(event) ? event : null;
  if (keyboard && includeKeyboardKey) {
    const key = normalizeKeyName(keyboard.key);
    const code = normalizeKeyName(keyboard.code);
    if (key) names.push(key);
    if (code && code !== key) names.push(code);
  }
  if (event.shiftKey) names.push("shift");
  if (event.ctrlKey) names.push("control");
  if (event.altKey) names.push("alt");
  if (event.metaKey) names.push("meta");
  return names;
}

function hasKeyboardIdentity(
  event: KeyboardEvent | MouseEvent | WheelEvent | PointerEvent,
): event is KeyboardEvent | ((MouseEvent | WheelEvent | PointerEvent) & { readonly key?: unknown; readonly code?: unknown }) {
  return (
    typeof event === "object" &&
    event !== null &&
    ("key" in event || "code" in event)
  );
}
