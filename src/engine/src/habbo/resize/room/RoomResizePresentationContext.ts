import type { DirectorMovie } from "@director/Movie";
import type { ScriptInstance } from "@director/Runtime";
import type { SpriteChannel } from "@director/sprites";
import type { LingoPropList, LingoValue } from "@director/values";

/** Shared Director access used by resize-only room presentation modules. */
export interface RoomResizePresentationContext {
  readonly movie: DirectorMovie;
  readonly objectById: (id: string) => ScriptInstance | null;
  readonly instanceProp: (instance: ScriptInstance, prop: string) => LingoValue;
  readonly propListLookup: (list: LingoPropList, key: string) => LingoValue;
  readonly numberValue: (value: LingoValue, fallback: number) => number;
  readonly normalizedSymbol: (value: LingoValue) => string;
  readonly setSpriteLoc: (sprite: SpriteChannel, locH: number, locV: number) => boolean;
  readonly spriteMemberImage: (value: LingoValue) => object | undefined;
}
