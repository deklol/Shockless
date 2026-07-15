import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import { LINGO_VOID, type LingoPropList, type LingoValue } from "@director/values";
import {
  collectUserNameLabels,
  roomUserListFromComponent,
  type UserNameLabelStyleSettings,
} from "./UserNameLabels";
import type { StageRenderer, UserNameLabel } from "../../render/StageRenderer";

export interface UserNameLabelControllerDependencies {
  movie: DirectorMovie;
  renderer: StageRenderer;
  objectManagerList: (gCore: LingoValue) => LingoPropList | null;
  propListLookup: (list: LingoPropList, key: string) => LingoValue;
  sourceSessionText: (key: string) => string;
  hiddenUserMatches: (entry: Readonly<Record<string, unknown>>) => boolean;
  markPresentationsDirty: () => void;
}

/** Owns avatar name-label settings, collection, and cached presentation. */
export class UserNameLabelController {
  private enabled = false;
  private settings: UserNameLabelStyleSettings = {};
  private cachedLabels: readonly UserNameLabel[] = [];

  constructor(private readonly dependencies: UserNameLabelControllerDependencies) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  presentation(): readonly UserNameLabel[] {
    return this.cachedLabels;
  }

  labels(): UserNameLabel[] {
    if (!this.enabled) return [];
    const { movie, objectManagerList, propListLookup, sourceSessionText, hiddenUserMatches } = this.dependencies;
    const objectList = objectManagerList(movie.runtime.getGlobal("gcore"));
    const roomComponent = objectList ? propListLookup(objectList, "#room_component") : LINGO_VOID;
    if (!(roomComponent instanceof ScriptInstance)) return [];
    return collectUserNameLabels({
      runtime: movie.runtime,
      userList: roomUserListFromComponent(roomComponent, movie.runtime),
      channels: movie.channels,
      spriteBounds: (channelNumber) => movie.spriteBounds(channelNumber),
      settings: {
        ...this.settings,
        sessionUserName: sourceSessionText("userName") || sourceSessionText("#userName"),
      },
    }).filter((label) => !hiddenUserMatches({ userName: label.name, userId: label.id }));
  }

  refresh(): readonly UserNameLabel[] {
    this.cachedLabels = this.enabled ? this.labels() : [];
    return this.cachedLabels;
  }

  setEnabled(enabled: boolean, settings: UserNameLabelStyleSettings = {}): Record<string, unknown> {
    this.enabled = Boolean(enabled);
    this.settings = this.cleanSettings({ ...this.settings, ...settings });
    this.dependencies.markPresentationsDirty();
    if (!this.enabled) {
      this.cachedLabels = [];
      this.dependencies.renderer.setUserNameLabels([]);
    }
    this.dependencies.renderer.markDirty();
    return { enabled: this.enabled, settings: this.settings };
  }

  summary(): Record<string, unknown> {
    return { enabled: this.enabled, labels: this.labels() };
  }

  private cleanSettings(settings: UserNameLabelStyleSettings): UserNameLabelStyleSettings {
    return {
      sourceYOffset: this.cleanFiniteNumber(settings.sourceYOffset),
      selfColor: this.cleanHexColor(settings.selfColor),
      otherColor: this.cleanHexColor(settings.otherColor),
    };
  }

  private cleanFiniteNumber(value: unknown): number | undefined {
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  private cleanHexColor(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : undefined;
  }
}
