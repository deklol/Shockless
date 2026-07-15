import { CastMember } from "./members";
import { LingoList, LingoObjectLike, LingoValue } from "./values";

/**
 * Director sprite channel state. The score's channel count bounds `the
 * lastChannel`; fuse_client's Sprite Manager allocates puppet channels and
 * drives all visuals through these properties. The renderer reads this
 * state; nothing here knows about Pixi.
 */
export class SpriteChannel implements LingoObjectLike {
  readonly lingoType = "sprite";
  puppet = 0;
  member: CastMember | null = null;
  /** Cast library used for local castNum resolution. */
  castLibNum = 0;
  locH = 0;
  locV = 0;
  locZ: number;
  ink = 0;
  blend = 100;
  visible = 1;
  /** Explicit size overrides; 0 means use the member's natural size. */
  width = 0;
  height = 0;
  stretch = 0;
  trails = 0;
  flipH = 0;
  flipV = 0;
  rotation = 0;
  skew = 0;
  foreColor = 255;
  backColor = 0;
  /** Editable field sprite (Director native text input). */
  editable = 0;
  /** sprite.color / sprite.bgColor tint values (rgb color objects). */
  color: LingoValue = 0;
  bgColor: LingoValue = 0;
  cursor: unknown = 0;
  id: LingoValue = 0;
  name = "";
  scriptInstanceList = new LingoList();
  /** Engine-side presentation version. Not visible to Lingo. */
  version = 0;

  constructor(public readonly number: number) {
    this.locZ = number;
  }

  /**
   * Return a channel to the blank score-like state this runtime uses for
   * empty dynamic channels. Habbo's Sprite Manager releases pooled sprites by
   * calling puppetSprite(channel, FALSE); Director resets immediate sprite
   * properties at that point instead of letting scripted transforms leak into
   * the next reservation.
   */
  resetImmediateProperties(): void {
    this.puppet = 0;
    this.member = null;
    this.castLibNum = 0;
    this.locH = 0;
    this.locV = 0;
    this.locZ = this.number;
    this.ink = 0;
    this.blend = 100;
    this.visible = 0;
    this.width = 0;
    this.height = 0;
    this.stretch = 0;
    this.trails = 0;
    this.flipH = 0;
    this.flipV = 0;
    this.rotation = 0;
    this.skew = 0;
    this.foreColor = 255;
    this.backColor = 0;
    this.editable = 0;
    this.color = 0;
    this.bgColor = 0;
    this.cursor = 0;
    this.id = 0;
    this.name = "";
    this.scriptInstanceList = new LingoList();
    this.markChanged();
  }

  markChanged(): void {
    this.version = (this.version + 1) >>> 0;
  }

  lingoToString(): string {
    return `(sprite ${this.number})`;
  }
}

export const LAST_CHANNEL = 1000;

export function createChannels(): SpriteChannel[] {
  const channels: SpriteChannel[] = [];
  for (let i = 0; i <= LAST_CHANNEL; i += 1) {
    channels.push(new SpriteChannel(i));
  }
  return channels;
}
