import type { DirectorMovie } from "@director/Movie";
import { directorKeyForTextKey } from "@director/keyboard";
import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LINGO_VOID, LingoPropList, LingoSymbol } from "@director/values";
import {
  debugValue,
  instancePropValue,
  objectManagerList,
  propListLookup,
} from "../../room/RoomRuntimeDiagnostics";
import type { SourceWindowInteractionController } from "../window/SourceWindowInteractionController";

export interface SourceLoginResult {
  readonly fields: [number, number];
  readonly focus: number;
  readonly passwordTimeoutDrain?: { before: string[]; after: string[]; ticks: number };
  readonly submit: "source-handler" | "button" | "enter";
}

interface SourceInputAutomationOptions {
  readonly movie: DirectorMovie;
  readonly windows: SourceWindowInteractionController;
  readonly clickSprite: (spriteNumber: number) => boolean;
  readonly delay: (milliseconds: number) => Promise<void>;
}

/** Source-driven editable field and login automation used by diagnostics and operators. */
export class SourceInputAutomation {
  constructor(private readonly options: SourceInputAutomationOptions) {}

  async pressKey(key: string, shiftDown = false): Promise<boolean> {
    const mapped = directorKeyForTextKey(key);
    if (!mapped) return false;
    this.options.movie.keyDown(mapped.key, mapped.code, shiftDown);
    this.options.movie.keyUp(mapped.key, mapped.code, shiftDown);
    await this.options.delay(0);
    return true;
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    for (const char of text) {
      await this.pressKey(char, char !== char.toLowerCase());
      if (delayMs > 0) await this.options.delay(delayMs);
    }
  }

  editableFields(): Array<{
    n: number;
    member: string;
    rect: [number, number, number, number];
    text: string;
  }> {
    return this.options.movie.channels
      .filter(
        (channel) =>
          channel.puppet === 1 &&
          channel.visible === 1 &&
          channel.member &&
          this.options.movie.channelEditable(channel),
      )
      .map((channel) => {
        const rect = this.options.movie.spriteBounds(channel.number);
        return rect
          ? {
              n: channel.number,
              member: channel.member!.name,
              rect: [rect.left, rect.top, rect.right, rect.bottom] as [number, number, number, number],
              text: channel.member!.text,
            }
          : null;
      })
      .filter(
        (entry): entry is { n: number; member: string; rect: [number, number, number, number]; text: string } => !!entry,
      )
      .sort((left, right) => left.rect[1] - right.rect[1] || left.rect[0] - right.rect[0]);
  }

  sourceTimeoutIds(): string[] {
    const objectList = objectManagerList(this.options.movie.runtime.getGlobal("gcore"));
    const timeoutManager = objectList ? propListLookup(objectList, "#timeout_manager") : LINGO_VOID;
    if (!(timeoutManager instanceof ScriptInstance)) return [];
    const itemList = instancePropValue(timeoutManager, "pitemlist");
    if (!(itemList instanceof LingoPropList)) return [];
    return itemList.keys.map((key) => String(debugValue(key)));
  }

  async login(email: string, password: string, delayMs = 0): Promise<SourceLoginResult> {
    const windowManager = this.options.windows.manager();
    const loginWindow = windowManager
      ? this.options.windows.windowById(windowManager, LingoSymbol.for("login_b"))
      : null;
    if (!loginWindow || !this.options.windows.windowVisible(loginWindow)) {
      throw new Error("source login window login_b is not ready");
    }
    const usernameElement = this.options.movie.runtime.callMethod(loginWindow, "getelement", ["login_username"]);
    const passwordElement = this.options.movie.runtime.callMethod(loginWindow, "getelement", ["login_password"]);
    const usernameSprite = usernameElement instanceof ScriptInstance
      ? this.options.movie.runtime.getProp(usernameElement, "psprite")
      : null;
    const passwordSprite = passwordElement instanceof ScriptInstance
      ? this.options.movie.runtime.getProp(passwordElement, "psprite")
      : null;
    if (!(usernameSprite instanceof SpriteChannel) || !(passwordSprite instanceof SpriteChannel)) {
      throw new Error("source login fields login_username/login_password are not ready");
    }
    if (!this.options.movie.channelEditable(usernameSprite) || !this.options.movie.channelEditable(passwordSprite)) {
      throw new Error("source login fields are not editable");
    }
    const emailField = { n: usernameSprite.number };
    const passwordField = { n: passwordSprite.number };
    this.options.clickSprite(emailField.n);
    await this.clearFocusedField();
    await this.typeText(email, delayMs);
    this.options.clickSprite(passwordField.n);
    await this.clearFocusedField();
    await this.typeText(password, delayMs);
    const passwordTimeoutDrain = await this.drainSourceTimeouts((id) => id.toLowerCase().startsWith("pwdhide"));
    const objectList = objectManagerList(this.options.movie.runtime.getGlobal("gcore"));
    const loginInterface = objectList ? propListLookup(objectList, "#login_interface") : LINGO_VOID;
    if (loginInterface instanceof ScriptInstance && this.options.movie.runtime.hasHandler(loginInterface, "eventproclogin")) {
      if (usernameElement instanceof ScriptInstance && this.options.movie.runtime.hasHandler(usernameElement, "settext")) {
        this.options.movie.runtime.callMethod(usernameElement, "settext", [email]);
      }
      if (passwordElement instanceof ScriptInstance && this.options.movie.runtime.hasHandler(passwordElement, "settext")) {
        this.options.movie.runtime.callMethod(passwordElement, "settext", ["*".repeat(password.length)]);
      }
      this.options.movie.runtime.setInstanceProp(loginInterface, "ptemppassword", password);
      this.options.movie.runtime.callMethod(loginInterface, "eventproclogin", [
        LingoSymbol.for("mouseUp"),
        "login_ok",
        LINGO_VOID,
      ]);
      return {
        fields: [emailField.n, passwordField.n],
        focus: Number(this.options.movie.keyboardFocusSprite) | 0,
        passwordTimeoutDrain,
        submit: "source-handler",
      };
    }
    const submitSprite = this.options.movie.channels.find(
      (channel) =>
        channel.puppet === 1 &&
        channel.visible === 1 &&
        !!channel.member &&
        /login.*(?:totp_)?ok/i.test(channel.member.name),
    );
    if (submitSprite && this.options.clickSprite(submitSprite.number)) {
      return {
        fields: [emailField.n, passwordField.n],
        focus: Number(this.options.movie.keyboardFocusSprite) | 0,
        passwordTimeoutDrain,
        submit: "button",
      };
    }
    await this.pressKey("Enter");
    return {
      fields: [emailField.n, passwordField.n],
      focus: Number(this.options.movie.keyboardFocusSprite) | 0,
      passwordTimeoutDrain,
      submit: "enter",
    };
  }

  async clearFocusedField(): Promise<void> {
    const focus = Number(this.options.movie.keyboardFocusSprite) | 0;
    const member = focus > 0 ? this.options.movie.channels[focus]?.member : null;
    const count = member?.text.length ?? 0;
    for (let index = 0; index < count; index += 1) await this.pressKey("Backspace");
  }

  private async drainSourceTimeouts(
    shouldDrain: (id: string) => boolean,
    maxTicks = 8,
  ): Promise<{ before: string[]; after: string[]; ticks: number }> {
    const before = this.sourceTimeoutIds().filter(shouldDrain);
    let after = before;
    let ticks = 0;
    while (after.length > 0 && ticks < maxTicks) {
      await this.options.delay(0);
      this.options.movie.tick();
      ticks += 1;
      after = this.sourceTimeoutIds().filter(shouldDrain);
    }
    return { before, after, ticks };
  }
}
