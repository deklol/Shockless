import { describe, expect, it } from "vitest";
import { AvatarMotionPresentationCollector } from "../../src/habbo/user/AvatarMotionPresentation";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { SpriteChannel } from "../../src/director/sprites";
import { LingoList, LingoPropList } from "../../src/director/values";

function moduleFor(scriptName: string, scriptProperties: string[] = []): GeneratedScriptModule {
  return {
    scriptName,
    scriptType: "parent",
    scriptProperties,
    scriptGlobals: [],
    handlers: {},
  };
}

function sprite(number: number, memberName = `member-${number}`): SpriteChannel {
  const channel = new SpriteChannel(number);
  channel.member = { name: memberName } as SpriteChannel["member"];
  channel.visible = 1;
  channel.markChanged();
  return channel;
}

describe("Room motion presentation collector", () => {
  it("smooths generated room user sprites while keeping active object coverage diagnostic-only", () => {
    const roomComponent = new ScriptInstance(moduleFor("Room Component Class", ["pUserObjList", "pActiveObjList"]));
    const user = new ScriptInstance(moduleFor("Human Class EX", ["pSprite", "pMatteSpr", "pShadowSpr"]));
    const activeObject = new ScriptInstance(moduleFor("Active Object Class", ["pSprList"]));
    const channels = Array.from({ length: 9 }, (_, index) => sprite(index));

    user.props.set("psprite", channels[1]!);
    user.props.set("pmattespr", channels[2]!);
    user.props.set("pshadowspr", channels[3]!);
    activeObject.props.set("psprlist", new LingoList([channels[4]!, channels[5]!]));
    channels[6]!.member = { name: "h_std_001" } as SpriteChannel["member"];

    roomComponent.props.set("puserobjlist", LingoPropList.fromPairs([["dek", user]]));
    roomComponent.props.set("pactiveobjlist", LingoPropList.fromPairs([["roller", activeObject]]));

    const collector = new AvatarMotionPresentationCollector();
    const first = collector.collect({
      roomComponent,
      channels,
      spriteBounds: () => ({ top: 100 }),
      toolbarTop: 500,
      nowMs: 10,
    });
    const second = collector.collect({
      roomComponent,
      channels,
      spriteBounds: () => ({ top: 100 }),
      toolbarTop: 500,
      nowMs: 20,
    });

    expect([...first.channels].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(first.diagnostics).toMatchObject({
      roomComponentPresent: true,
      userObjectCount: 1,
      userObjectsWithSprites: 1,
      userChannels: 3,
      fallbackAvatarChannels: 0,
      activeObjectCount: 1,
      activeObjectsWithSprites: 1,
      activeObjectChannels: 2,
      totalChannels: 3,
    });
    expect(second.channels).toBe(first.channels);
    expect(second.diagnostics.cacheHit).toBe(true);
  });

  it("uses fallback avatar sprites only when generated room users are not available", () => {
    const channels = Array.from({ length: 4 }, (_, index) => sprite(index));
    channels[1]!.member = { name: "Canvas:uid:143:16390" } as SpriteChannel["member"];
    channels[2]!.member = { name: "h_hooked_object_0_0" } as SpriteChannel["member"];
    channels[3]!.member = { name: "h_std_sd_1_0_0" } as SpriteChannel["member"];

    const collector = new AvatarMotionPresentationCollector();
    const result = collector.collect({
      roomComponent: null,
      channels,
      spriteBounds: () => ({ top: 100 }),
      toolbarTop: 500,
      nowMs: 10,
    });

    expect([...result.channels].sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.diagnostics).toMatchObject({
      roomComponentPresent: false,
      userObjectCount: 0,
      fallbackAvatarChannels: 2,
      totalChannels: 2,
    });
  });
});
