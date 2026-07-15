import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import { ShadowPresentation } from "../furni/shadow/ShadowPresentation";
import { RoomSpriteChannelCollector } from "../room/RoomSpriteChannelCollector";
import { roomUserEntries, roomUserListFromComponent } from "./UserNameLabels";
import { AvatarPresentation } from "./AvatarPresentation";

interface HiddenUserFilter {
  readonly names: Set<string>;
  readonly ids: Set<string>;
  readonly entries: string[];
}

interface UserVisibilityControllerDependencies {
  readonly movie: DirectorMovie;
  readonly objectById: (id: string) => LingoValue;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  readonly debugValue: (value: LingoValue | undefined) => unknown;
  readonly toolbarTop: () => number;
}

/** Owns avatar visibility plus persistent name/account-id filtering semantics. */
export class UserVisibilityController {
  private hidden = false;
  private filter: HiddenUserFilter = { names: new Set(), ids: new Set(), entries: [] };
  private readonly avatars: AvatarPresentation;

  constructor(private readonly dependencies: UserVisibilityControllerDependencies) {
    const collector = new RoomSpriteChannelCollector(dependencies);
    const shadows = new ShadowPresentation({ collector, instancePropValue: dependencies.instancePropValue });
    this.avatars = new AvatarPresentation({
      movie: dependencies.movie,
      collector,
      shadows,
      instancePropValue: dependencies.instancePropValue,
      toolbarTop: dependencies.toolbarTop,
    });
  }

  setHidden(value: boolean): boolean {
    this.hidden = Boolean(value);
    return this.hidden;
  }

  setFilter(entries: unknown): Record<string, unknown> {
    this.filter = this.filterFromEntries(entries);
    return {
      entries: this.filter.entries,
      names: this.filter.names.size,
      ids: this.filter.ids.size,
    };
  }

  hiddenChatEntryMatches(entry: Readonly<Record<string, unknown>>): boolean {
    if (this.filter.names.size === 0 && this.filter.ids.size === 0) return false;
    const name = this.normalizeToken(entry.userName).toLowerCase();
    if (name && this.filter.names.has(name)) return true;
    const id = this.normalizeToken(entry.userId);
    return /^\d+$/.test(id) && this.filter.ids.has(id);
  }

  collectHiddenChannels(channels: Set<number>): void {
    const roomComponent = this.dependencies.objectById("#room_component");
    if (!(roomComponent instanceof ScriptInstance)) {
      if (this.hidden) this.avatars.addFallbackChannels(channels);
      return;
    }
    if (this.hidden) this.avatars.collect(roomComponent, channels);
    if (this.filter.names.size === 0 && this.filter.ids.size === 0) return;
    for (const entry of roomUserEntries(roomUserListFromComponent(roomComponent, this.dependencies.movie.runtime))) {
      if (this.userMatches(entry.user, entry.key)) this.avatars.addUser(entry.user, channels);
    }
  }

  private userMatches(user: LingoValue | undefined, key: LingoValue | undefined): boolean {
    if (key !== undefined && (this.matchesId(key) || this.matchesName(key))) return true;
    if (!(user instanceof ScriptInstance)) return false;
    const prop = this.dependencies.instancePropValue;
    for (const candidate of [prop(user, "pname"), prop(user, "pName"), prop(user, "pclass"), prop(user, "pClass")]) {
      if (this.matchesName(candidate)) return true;
    }
    for (const candidate of [prop(user, "paccountid"), prop(user, "pAccountId"), prop(user, "id"), key]) {
      if (this.matchesId(candidate)) return true;
    }
    return false;
  }

  private matchesName(value: unknown): boolean {
    const text = this.normalizeToken(this.dependencies.debugValue(value as LingoValue | undefined)).toLowerCase();
    return text.length > 0 && this.filter.names.has(text);
  }

  private matchesId(value: unknown): boolean {
    const text = this.normalizeToken(this.dependencies.debugValue(value as LingoValue | undefined));
    return /^\d+$/.test(text) && this.filter.ids.has(text);
  }

  private filterFromEntries(entries: unknown): HiddenUserFilter {
    const source = Array.isArray(entries) ? entries : String(entries ?? "").split(/[\n,;]+/);
    const names = new Set<string>();
    const ids = new Set<string>();
    const cleaned: string[] = [];
    for (const entry of source) {
      const token = this.normalizeToken(entry);
      if (!token) continue;
      const key = token.toLowerCase();
      if (names.has(key) || ids.has(key)) continue;
      cleaned.push(token);
      if (/^\d+$/.test(token)) ids.add(token);
      else names.add(key);
    }
    return { names, ids, entries: cleaned };
  }

  private normalizeToken(value: unknown): string {
    const text = String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
    return text === "<Void>" ? "" : text.slice(0, 64);
  }
}
