import { ScriptInstance } from "../../director/Runtime";
import { SpriteChannel } from "../../director/sprites";
import { LingoList, LingoPropList, type LingoValue } from "../../director/values";
import { collectFurniAnimationDiagnostics } from "../furni/animation/FurniAnimationDiagnostics";

export interface AvatarMotionDiagnostics {
  readonly signature: string;
  readonly cacheHit: boolean;
  readonly scannedAtMs: number;
  readonly roomComponentPresent: boolean;
  readonly userObjectCount: number;
  readonly userObjectsWithSprites: number;
  readonly userObjectsWithoutSprites: number;
  readonly userChannels: number;
  readonly fallbackAvatarChannels: number;
  readonly activeObjectCount: number;
  readonly activeObjectsWithSprites: number;
  readonly activeObjectsWithoutSprites: number;
  readonly activeObjectChannels: number;
  readonly totalChannels: number;
}

export interface AvatarMotionDiscovery {
  readonly channels: ReadonlySet<number>;
  readonly diagnostics: AvatarMotionDiagnostics;
}

interface SpriteBounds {
  readonly top: number;
}

export interface AvatarMotionPresentationOptions {
  readonly roomComponent: ScriptInstance | null;
  readonly channels: readonly SpriteChannel[];
  readonly spriteBounds: (channelNumber: number) => SpriteBounds | null | undefined;
  readonly toolbarTop: number;
  readonly nowMs?: number;
}

type SpriteGroup = "user";

const USER_SPRITE_PROPS = ["psprlist", "psprite", "pmattespr", "pshadowspr", "pinteractionbubblespr"] as const;

export const EMPTY_AVATAR_MOTION_DIAGNOSTICS: AvatarMotionDiagnostics = {
  signature: "empty",
  cacheHit: false,
  scannedAtMs: 0,
  roomComponentPresent: false,
  userObjectCount: 0,
  userObjectsWithSprites: 0,
  userObjectsWithoutSprites: 0,
  userChannels: 0,
  fallbackAvatarChannels: 0,
  activeObjectCount: 0,
  activeObjectsWithSprites: 0,
  activeObjectsWithoutSprites: 0,
  activeObjectChannels: 0,
  totalChannels: 0,
};

/**
 * Discovers room motion channels from the live generated Room Component.
 *
 * The generated Origins source owns user/object lifecycle in puserobjlist and
 * pactiveobjlist. This collector only reads those Director-owned objects and
 * their sprite properties, then feeds a presentation-only smoother. It never
 * edits Lingo state, object lists, locs, packets, or hit testing.
 */
export class AvatarMotionPresentationCollector {
  private previousSignature = "";
  private previousResult: AvatarMotionDiscovery | null = null;

  collect(options: AvatarMotionPresentationOptions): AvatarMotionDiscovery {
    const scannedAtMs = Math.round(options.nowMs ?? performance.now());
    const channels = new Set<number>();
    const userChannels = new Set<number>();
    let activeObjectChannels: ReadonlySet<number> = new Set<number>();
    const signatureParts: string[] = [];
    let userObjectCount = 0;
    let userObjectsWithSprites = 0;
    let activeObjectCount = 0;
    let activeObjectsWithSprites = 0;

    const addSpriteValue = (
      value: LingoValue | undefined,
      target: Set<number>,
      group: SpriteGroup,
      includeInMotion: boolean,
    ): number => {
      if (value instanceof SpriteChannel) {
        if (includeInMotion) signatureParts.push(`${group}:sprite:${value.number}:${value.visible}`);
        if (value.visible !== 0) {
          target.add(value.number);
          if (includeInMotion) channels.add(value.number);
          return 1;
        }
        return 0;
      }
      if (value instanceof LingoList) {
        let added = 0;
        if (includeInMotion) signatureParts.push(`${group}:list:${value.count()}`);
        for (const entry of value.items) added += addSpriteValue(entry, target, group, includeInMotion);
        return added;
      }
      if (value instanceof LingoPropList) {
        let added = 0;
        if (includeInMotion) signatureParts.push(`${group}:props:${value.count()}`);
        for (const entry of value.values) added += addSpriteValue(entry, target, group, includeInMotion);
        return added;
      }
      return 0;
    };

    const collectObjectSprites = (
      object: LingoValue | undefined,
      props: readonly string[],
      target: Set<number>,
      group: SpriteGroup,
      includeInMotion: boolean,
    ): boolean => {
      if (!(object instanceof ScriptInstance)) return false;
      if (includeInMotion) signatureParts.push(`${group}:object:${object.module.scriptName}`);
      let before = target.size;
      for (const propName of props) addSpriteValue(instancePropValue(object, propName), target, group, includeInMotion);
      return target.size > before;
    };

    const collectObjectList = (
      value: LingoValue | undefined,
      props: readonly string[],
      target: Set<number>,
      group: SpriteGroup,
      includeInMotion: boolean,
    ): { readonly count: number; readonly withSprites: number } => {
      let count = 0;
      let withSprites = 0;
      const visit = (entry: LingoValue | undefined): void => {
        if (!(entry instanceof ScriptInstance)) return;
        count += 1;
        if (collectObjectSprites(entry, props, target, group, includeInMotion)) withSprites += 1;
      };
      if (value instanceof LingoPropList) {
        signatureParts.push(`${group}:objectProps:${value.count()}`);
        for (const entry of value.values) visit(entry);
      } else if (value instanceof LingoList) {
        signatureParts.push(`${group}:objectList:${value.count()}`);
        for (const entry of value.items) visit(entry);
      } else {
        signatureParts.push(`${group}:objectList:missing`);
      }
      return { count, withSprites };
    };

    const roomComponent = options.roomComponent;
    if (roomComponent) {
      const users = collectObjectList(instancePropValue(roomComponent, "puserobjlist"), USER_SPRITE_PROPS, userChannels, "user", true);
      userObjectCount = users.count;
      userObjectsWithSprites = users.withSprites;

      const activeObjects = collectFurniAnimationDiagnostics(roomComponent, signatureParts);
      activeObjectCount = activeObjects.count;
      activeObjectsWithSprites = activeObjects.withSprites;
      activeObjectChannels = activeObjects.channels;
    } else {
      signatureParts.push("roomComponent:missing");
    }

    const beforeFallback = userChannels.size;
    if (!roomComponent || userObjectsWithSprites === 0) {
      collectFallbackAvatarStageSprites(options, userChannels, channels, signatureParts);
    } else {
      signatureParts.push("fallbackAvatar:skipped:userObjectsPresent");
      signatureParts.push("fallbackAvatarCandidates:0");
    }
    const fallbackAvatarChannels = userChannels.size - beforeFallback;

    const signature = signatureParts.join("|") || "empty";
    const diagnostics: AvatarMotionDiagnostics = {
      signature,
      cacheHit: false,
      scannedAtMs,
      roomComponentPresent: Boolean(roomComponent),
      userObjectCount,
      userObjectsWithSprites,
      userObjectsWithoutSprites: Math.max(0, userObjectCount - userObjectsWithSprites),
      userChannels: userChannels.size,
      fallbackAvatarChannels,
      activeObjectCount,
      activeObjectsWithSprites,
      activeObjectsWithoutSprites: Math.max(0, activeObjectCount - activeObjectsWithSprites),
      activeObjectChannels: activeObjectChannels.size,
      totalChannels: channels.size,
    };
    if (this.previousResult && signature === this.previousSignature) {
      return {
        channels: this.previousResult.channels,
        diagnostics: {
          ...diagnostics,
          cacheHit: true,
        },
      };
    }

    const result = { channels, diagnostics };
    this.previousSignature = signature;
    this.previousResult = result;
    return result;
  }
}

function collectFallbackAvatarStageSprites(
  options: AvatarMotionPresentationOptions,
  userChannels: Set<number>,
  allChannels: Set<number>,
  signatureParts: string[],
): void {
  let candidates = 0;
  for (const channel of options.channels) {
    if (channel.visible === 0 || channel.blend <= 0 || !channel.member) continue;
    const memberName = channel.member.name ?? "";
    if (!isFallbackAvatarMemberName(memberName)) continue;
    const rect = options.spriteBounds(channel.number);
    if (rect && rect.top >= options.toolbarTop) continue;
    candidates += 1;
    signatureParts.push(`fallbackAvatar:${channel.number}:${channel.visible}:${memberName}`);
    userChannels.add(channel.number);
    allChannels.add(channel.number);
  }
  signatureParts.push(`fallbackAvatarCandidates:${candidates}`);
}

function isFallbackAvatarMemberName(memberName: string): boolean {
  return /^Canvas:uid:/i.test(memberName) || /^h_std_/i.test(memberName);
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
