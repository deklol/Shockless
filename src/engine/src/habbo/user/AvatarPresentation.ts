import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { RoomSpriteChannelCollector } from "../room/RoomSpriteChannelCollector";
import type { ShadowPresentation } from "../furni/shadow/ShadowPresentation";

interface AvatarPresentationDependencies {
  readonly movie: DirectorMovie;
  readonly collector: RoomSpriteChannelCollector;
  readonly shadows: ShadowPresentation;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  readonly toolbarTop: () => number;
}

/** Resolves room-user avatar, matte, and shadow channels. */
export class AvatarPresentation {
  constructor(private readonly dependencies: AvatarPresentationDependencies) {}

  collect(roomComponent: ScriptInstance, channels: Set<number>): void {
    const users = this.dependencies.instancePropValue(roomComponent, "puserobjlist");
    for (const user of this.dependencies.collector.objectEntries(users)) this.addUser(user, channels);
    this.addFallbackChannels(channels);
  }

  addUser(user: LingoValue | undefined, channels: Set<number>): void {
    if (!(user instanceof ScriptInstance)) return;
    this.dependencies.collector.addObjectBase(user, channels);
    this.dependencies.shadows.addObject(user, channels);
    if (this.dependencies.movie.runtime.hasHandler(user, "getSprites")) {
      try {
        this.dependencies.collector.addValue(this.dependencies.movie.runtime.callMethod(user, "getSprites", []), channels);
      } catch {
        // A room user may leave while presentation channels are being refreshed.
      }
    }
  }

  addFallbackChannels(channels: Set<number>): void {
    for (const channel of this.dependencies.movie.channels) {
      if (channel.visible === 0 || channel.blend <= 0 || !channel.member) continue;
      const memberName = channel.member.name ?? "";
      if (!/^Canvas:uid:/i.test(memberName) && !/^h_/i.test(memberName)) continue;
      const rect = this.dependencies.movie.spriteBounds(channel.number);
      if (rect && rect.top >= this.dependencies.toolbarTop()) continue;
      channels.add(channel.number);
    }
  }
}
