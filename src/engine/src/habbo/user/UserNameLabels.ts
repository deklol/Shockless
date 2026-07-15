import { LingoPoint, LingoRect } from "../../director/geometry";
import { ScriptInstance, type Runtime } from "../../director/Runtime";
import { SpriteChannel } from "../../director/sprites";
import {
  LINGO_VOID,
  LingoFloat,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoVoid,
  numberOf,
  type LingoValue,
} from "../../director/values";
import type { UserNameLabel } from "../../render/StageRenderer";

export interface RoomUserEntry {
  readonly key: LingoValue;
  readonly user: LingoValue;
  readonly index: number;
}

export interface UserNameLabelCollector {
  readonly runtime: Runtime;
  readonly userList: LingoValue;
  readonly channels: readonly SpriteChannel[];
  readonly spriteBounds: (channelNumber: number) => LingoRect | null;
  readonly settings?: UserNameLabelStyleSettings;
}

/** Persistent presentation settings for avatar name labels. */
export interface UserNameLabelStyleSettings {
  readonly sourceYOffset?: number;
  readonly sessionUserName?: string | null;
  readonly selfColor?: string;
  readonly otherColor?: string;
}

interface LabelPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number | null;
}

export const DEFAULT_USER_NAME_LABEL_SOURCE_Y_OFFSET = 40;
const MIN_USER_NAME_LABEL_SOURCE_Y_OFFSET = 0;
const MAX_USER_NAME_LABEL_SOURCE_Y_OFFSET = 96;
const DEFAULT_USER_NAME_LABEL_SELF_COLOR = "#ffffff";
const DEFAULT_USER_NAME_LABEL_OTHER_COLOR = "#ffffff";
const DEK_NAME_LABEL_COLOR = "#ffd700";

export function roomUserEntries(userList: LingoValue): RoomUserEntry[] {
  if (userList instanceof LingoPropList) {
    return userList.values.map((user, index) => ({
      key: userList.keys[index] ?? index + 1,
      user,
      index,
    }));
  }
  if (userList instanceof LingoList) {
    return userList.items.map((user, index) => ({
      key: index + 1,
      user,
      index,
    }));
  }
  return [];
}

export function collectUserNameLabels(input: UserNameLabelCollector): UserNameLabel[] {
  const entries = roomUserEntries(input.userList);
  const fallbackGroups = fallbackAvatarSpriteGroups(input.channels);
  const settings = normalizeUserNameLabelStyle(input.settings);
  return entries.flatMap((entry): UserNameLabel[] => {
    if (!(entry.user instanceof ScriptInstance)) return [];
    const name = userDisplayName(input.runtime, entry.user, entry.key);
    if (!name) return [];
    const point =
      pointFromAvatarParts(input.runtime, entry.user) ??
      pointFromScreenLocation(input.runtime, entry.user) ??
      pointFromUserSprites(input.runtime, entry.user, input.spriteBounds) ??
      pointFromSpriteGroup(fallbackGroups[entry.index] ?? [], input.spriteBounds);
    if (!point) return [];
    return [
      {
        id: userStableId(input.runtime, entry.user, entry.key, name),
        name,
        x: Math.round(point.x),
        y: Math.round(point.y - settings.sourceYOffset),
        z: Math.round(point.z ?? avatarLocZ(input.runtime, entry.user) ?? 1),
        color: userNameLabelColor(name, settings),
      },
    ];
  });
}

export function normalizeUserNameLabelStyle(settings: UserNameLabelStyleSettings | undefined): Required<UserNameLabelStyleSettings> {
  return {
    sourceYOffset: normalizeSourceYOffset(settings?.sourceYOffset),
    sessionUserName: cleanUserName(String(settings?.sessionUserName ?? "")),
    selfColor: normalizeColor(settings?.selfColor, DEFAULT_USER_NAME_LABEL_SELF_COLOR),
    otherColor: normalizeColor(settings?.otherColor, DEFAULT_USER_NAME_LABEL_OTHER_COLOR),
  };
}

function userNameLabelColor(name: string, settings: Required<UserNameLabelStyleSettings>): string {
  const normalizedName = cleanUserName(name).toLowerCase();
  const sessionUserName = cleanUserName(settings.sessionUserName ?? "").toLowerCase();
  if (sessionUserName && normalizedName === sessionUserName) return settings.selfColor;
  if (normalizedName === "dek") return DEK_NAME_LABEL_COLOR;
  return settings.otherColor;
}

function normalizeSourceYOffset(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_USER_NAME_LABEL_SOURCE_Y_OFFSET;
  return Math.max(MIN_USER_NAME_LABEL_SOURCE_Y_OFFSET, Math.min(MAX_USER_NAME_LABEL_SOURCE_Y_OFFSET, Math.round(numeric)));
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

export function fallbackAvatarSpriteGroups(channels: readonly SpriteChannel[]): SpriteChannel[][] {
  const groups = new Map<string, SpriteChannel[]>();
  for (const channel of channels) {
    if (channel.visible === 0 || channel.blend <= 0) continue;
    const memberName = channel.member?.name ?? "";
    if (!isAvatarMemberName(memberName)) continue;
    const key = `${Math.round(channel.locH)}:${Math.round(channel.locV)}`;
    const group = groups.get(key) ?? [];
    group.push(channel);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.some((channel) => isAvatarMemberName(channel.member?.name ?? "")))
    .sort((left, right) => {
      const leftZ = Math.max(...left.map((channel) => channel.locZ));
      const rightZ = Math.max(...right.map((channel) => channel.locZ));
      return leftZ - rightZ;
    });
}

function userDisplayName(runtime: Runtime, user: ScriptInstance, key: LingoValue): string {
  const fromHandler = safeCall(runtime, user, "getName");
  const fromProp = propValue(runtime, user, "pname");
  return cleanLabelText(fromHandler) || cleanLabelText(fromProp) || cleanLabelText(key);
}

function userStableId(runtime: Runtime, user: ScriptInstance, key: LingoValue, name: string): string {
  const accountId = propValue(runtime, user, "paccountid");
  return cleanLabelText(accountId) || cleanLabelText(key) || name;
}

function pointFromAvatarParts(runtime: Runtime, user: ScriptInstance): LabelPoint | null {
  for (const part of ["hd", "bd", "ch"]) {
    const point = pointValue(safeCall(runtime, user, "getPartLocation", [part]));
    if (point) return { ...point, z: avatarLocZ(runtime, user) };
  }
  return null;
}

function pointFromScreenLocation(runtime: Runtime, user: ScriptInstance): LabelPoint | null {
  const point = listPointValue(safeCall(runtime, user, "getScrLocation"));
  if (point) return { ...point, z: avatarLocZ(runtime, user) };
  const screenLoc = listPointValue(propValue(runtime, user, "pscreenloc"));
  return screenLoc ? { ...screenLoc, z: avatarLocZ(runtime, user) } : null;
}

function pointFromUserSprites(
  runtime: Runtime,
  user: ScriptInstance,
  spriteBounds: (channelNumber: number) => LingoRect | null,
): LabelPoint | null {
  const sprites = userSpriteCandidates(runtime, user);
  return pointFromSpriteGroup(sprites, spriteBounds);
}

function pointFromSpriteGroup(
  sprites: readonly LingoValue[],
  spriteBounds: (channelNumber: number) => LingoRect | null,
): LabelPoint | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const entry of sprites) {
    if (!(entry instanceof SpriteChannel) || entry.visible === 0) continue;
    const rect = spriteBounds(entry.number);
    if (!rect) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    maxZ = Math.max(maxZ, entry.locZ);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right)) return null;
  return {
    x: (left + right) / 2,
    y: top,
    z: Number.isFinite(maxZ) ? maxZ : null,
  };
}

function userSpriteCandidates(runtime: Runtime, user: ScriptInstance): LingoValue[] {
  const candidates: LingoValue[] = [];
  const spritesFromHandler = safeCall(runtime, user, "getSprites");
  if (spritesFromHandler instanceof LingoList) candidates.push(...spritesFromHandler.items);
  if (spritesFromHandler instanceof LingoPropList) candidates.push(...spritesFromHandler.values);
  for (const propName of ["psprite", "pmattespr", "pshadowspr"]) {
    const sprite = propValue(runtime, user, propName);
    if (sprite instanceof SpriteChannel && !candidates.includes(sprite)) candidates.push(sprite);
  }
  const spriteList = propValue(runtime, user, "psprlist");
  if (spriteList instanceof LingoList) candidates.push(...spriteList.items);
  if (spriteList instanceof LingoPropList) candidates.push(...spriteList.values);
  return candidates;
}

function avatarLocZ(runtime: Runtime, user: ScriptInstance): number | null {
  const fromHandler = numericValue(safeCall(runtime, user, "getAvatarLocZ"), Number.NaN);
  if (Number.isFinite(fromHandler)) return fromHandler;
  const sprite = propValue(runtime, user, "psprite");
  return sprite instanceof SpriteChannel ? sprite.locZ : null;
}

function propValue(_runtime: Runtime, object: ScriptInstance, name: string): LingoValue {
  return instancePropValue(object, name) ?? LINGO_VOID;
}

function instancePropValue(instance: ScriptInstance, name: string): LingoValue | undefined {
  const key = name.toLowerCase();
  let target: ScriptInstance | null = instance;
  while (target) {
    if (target.props.has(key)) return target.props.get(key);
    const ancestor = target.props.get("ancestor");
    target = ancestor instanceof ScriptInstance ? ancestor : null;
  }
  return undefined;
}

function safeCall(runtime: Runtime, user: ScriptInstance, method: string, args: LingoValue[] = []): LingoValue {
  if (!runtime.hasHandler(user, method)) return LINGO_VOID;
  try {
    return runtime.callMethod(user, method, args);
  } catch {
    return LINGO_VOID;
  }
}

function pointValue(value: LingoValue): { readonly x: number; readonly y: number } | null {
  if (value instanceof LingoPoint) {
    return finitePoint(value.x, value.y);
  }
  return listPointValue(value);
}

function listPointValue(value: LingoValue): { readonly x: number; readonly y: number } | null {
  if (!(value instanceof LingoList) || value.items.length < 2) return null;
  return finitePoint(numericValue(value.items[0], Number.NaN), numericValue(value.items[1], Number.NaN));
}

function finitePoint(x: number, y: number): { readonly x: number; readonly y: number } | null {
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function numericValue(value: LingoValue | undefined, fallback: number): number {
  if (value === undefined || value instanceof LingoVoid) return fallback;
  try {
    const numeric = numberOf(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  } catch {
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }
}

function cleanLabelText(value: LingoValue | undefined): string {
  if (value === undefined || value instanceof LingoVoid) return "";
  if (value instanceof LingoSymbol) return value.name.trim();
  if (value instanceof LingoFloat) return String(value.value);
  if (typeof value === "string") return cleanUserName(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return cleanUserName("lingoToString" in value && typeof value.lingoToString === "function" ? value.lingoToString() : "");
}

function cleanUserName(value: string): string {
  const text = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text === "<Void>") return "";
  return text.slice(0, 64);
}

function isAvatarMemberName(memberName: string): boolean {
  return /^Canvas:uid:/i.test(memberName) || /^h_/i.test(memberName);
}

export function roomUserListFromComponent(roomComponent: ScriptInstance, _runtime: Runtime): LingoValue {
  return instancePropValue(roomComponent, "puserobjlist") ?? LINGO_VOID;
}
