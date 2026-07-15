import { describe, expect, it } from "vitest";
import { LingoPoint, LingoRect } from "../../src/director/geometry";
import { Runtime, ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { SpriteChannel } from "../../src/director/sprites";
import { LINGO_VOID, LingoList, LingoPropList, LingoSymbol } from "../../src/director/values";
import { collectUserNameLabels, roomUserEntries } from "../../src/habbo/user/UserNameLabels";

const humanModule: GeneratedScriptModule = {
  scriptName: "Human Class EX",
  scriptType: "parent",
  scriptProperties: ["pName", "pAccountId", "pScreenLoc", "pSprite", "pMatteSpr", "pShadowSpr", "pHeadPoint", "pAvatarLocZ"],
  scriptGlobals: [],
  handlers: {
    getname: (_ctx, me) => (me instanceof ScriptInstance ? me.props.get("pname") ?? "" : ""),
    getpartlocation: (_ctx, me) => (me instanceof ScriptInstance ? me.props.get("pheadpoint") ?? LINGO_VOID : LINGO_VOID),
    getscrlocation: (_ctx, me) => (me instanceof ScriptInstance ? me.props.get("pscreenloc") ?? LINGO_VOID : LINGO_VOID),
    getavatarlocz: (_ctx, me) => (me instanceof ScriptInstance ? me.props.get("pavatarlocz") ?? LINGO_VOID : LINGO_VOID),
    getsprites: (_ctx, me) => {
      if (!(me instanceof ScriptInstance)) return new LingoList();
      return new LingoList([
        me.props.get("psprite") ?? LINGO_VOID,
        me.props.get("pshadowspr") ?? LINGO_VOID,
        me.props.get("pmattespr") ?? LINGO_VOID,
      ]);
    },
  },
};

describe("Habbo username label collection", () => {
  it("creates labels for every live room user from source user objects", () => {
    const runtime = new Runtime();
    const first = human("dek", 233421, new LingoPoint(320, 240), 120);
    const second = human("shockless", 902, new LingoPoint(390, 260), 140);
    const userList = propList([
      ["1", first],
      ["2", second],
    ]);

    const labels = collectUserNameLabels({
      runtime,
      userList,
      channels: [],
      spriteBounds: () => null,
    });

    expect(labels).toEqual([
      { id: "233421", name: "dek", x: 320, y: 200, z: 120, color: "#ffd700" },
      { id: "902", name: "shockless", x: 390, y: 220, z: 140, color: "#ffffff" },
    ]);
  });

  it("falls back to sprite bounds when a remote user has no part location yet", () => {
    const runtime = new Runtime();
    const sprite = new SpriteChannel(31);
    sprite.visible = 1;
    sprite.blend = 100;
    sprite.locZ = 88;
    const user = human("shockless1", 903, LINGO_VOID, 0);
    user.props.set("psprite", sprite);
    const userList = propList([["3", user]]);

    const labels = collectUserNameLabels({
      runtime,
      userList,
      channels: [sprite],
      spriteBounds: (channelNumber) => (channelNumber === 31 ? new LingoRect(200, 180, 236, 232) : null),
    });

    expect(labels).toEqual([{ id: "903", name: "shockless1", x: 218, y: 140, z: 88, color: "#ffffff" }]);
  });

  it("applies live offset and color settings with the dek gold override for other users", () => {
    const runtime = new Runtime();
    const dek = human("dek", 233421, new LingoPoint(320, 240), 120);
    const shockless = human("shockless", 902, new LingoPoint(390, 260), 140);
    const userList = propList([
      ["1", dek],
      ["2", shockless],
    ]);

    expect(collectUserNameLabels({
      runtime,
      userList,
      channels: [],
      spriteBounds: () => null,
      settings: {
        sourceYOffset: 55,
        sessionUserName: "shockless",
        selfColor: "#00ff00",
        otherColor: "#aabbcc",
      },
    })).toEqual([
      { id: "233421", name: "dek", x: 320, y: 185, z: 120, color: "#ffd700" },
      { id: "902", name: "shockless", x: 390, y: 205, z: 140, color: "#00ff00" },
    ]);

    expect(collectUserNameLabels({
      runtime,
      userList,
      channels: [],
      spriteBounds: () => null,
      settings: {
        sourceYOffset: 55,
        sessionUserName: "dek",
        selfColor: "#ff00ff",
        otherColor: "#aabbcc",
      },
    })).toEqual([
      { id: "233421", name: "dek", x: 320, y: 185, z: 120, color: "#ff00ff" },
      { id: "902", name: "shockless", x: 390, y: 205, z: 140, color: "#aabbcc" },
    ]);
  });

  it("updates from the current room user list instead of retaining departed users", () => {
    const first = human("dek", 233421, LINGO_VOID, 0);
    const second = human("shockless", 902, LINGO_VOID, 0);
    expect(roomUserEntries(propList([["1", first], ["2", second]])).map((entry) => entry.user)).toEqual([first, second]);
    expect(roomUserEntries(propList([["2", second]])).map((entry) => entry.user)).toEqual([second]);
  });
});

function human(name: string, accountId: number, point: LingoPoint | typeof LINGO_VOID, z: number): ScriptInstance {
  const user = new ScriptInstance(humanModule);
  user.props.set("pname", name);
  user.props.set("paccountid", accountId);
  user.props.set("pheadpoint", point);
  user.props.set("pavatarlocz", z);
  return user;
}

function propList(entries: readonly (readonly [string, ScriptInstance])[]): LingoPropList {
  const list = new LingoPropList();
  for (const [key, value] of entries) {
    list.addProp(LingoSymbol.for(key), value);
  }
  return list;
}
