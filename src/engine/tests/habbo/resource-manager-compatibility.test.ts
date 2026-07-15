import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { LINGO_VOID, LingoList, LingoPropList } from "../../src/director/values";
import { installRelease306ResourceManagerCompatibility } from "../../src/habbo/resourceManagerCompatibility";

function emptyManifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

const resourceManagerModule: GeneratedScriptModule = {
  scriptName: "Resource Manager Class",
  scriptType: "parent",
  scriptProperties: ["pAllMemNumList", "pDynMemNumList"],
  scriptGlobals: [],
  handlers: {},
};

describe("release306 Resource Manager compatibility", () => {
  it("resolves already-loaded cast members lazily for getmemnum and exists", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_interface",
            castOrder: 1,
            member: 504,
            memberName: "controller_icon",
            mediaType: "bitmap",
            width: 25,
            height: 31,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_interface/0504-controller-icon.png",
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_interface", 10);

    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    const index = new LingoPropList();
    resourceManager.props.set("pallmemnumlist", index);

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["controller_icon"])).toBe((10 << 16) | 504);
    expect(movie.runtime.callMethod(resourceManager, "exists", ["controller_icon"])).toBe(1);
    expect(index.getaProp("controller_icon", (a, b) => a === b)).toBe((10 << 16) | 504);
  });

  it("resolves loaded memberalias.index class aliases lazily", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 1,
            memberName: "memberalias.index",
            memberType: "text",
            text: "#private\r#alias\r#index\r\rmodel_a Class=Private Room Engine Class\r",
          },
        ],
        bitmaps: [],
        externalMembers: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 29,
            memberName: "Private Room Engine Class",
            memberType: "script",
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_room_private", 76);

    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    const index = new LingoPropList();
    resourceManager.props.set("pallmemnumlist", index);

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["model_a Class"])).toBe((76 << 16) | 29);
    expect(movie.runtime.callMethod(resourceManager, "exists", ["model_a Class"])).toBe(1);
    expect(index.getaProp("model_a Class", (a, b) => a === b)).toBe((76 << 16) | 29);
  });

  it("re-parses memberalias.index when the text member version changes", () => {
    const members = new CastRegistry(
      {
        movie: { casts: [] },
        textFields: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 1,
            memberName: "memberalias.index",
            memberType: "text",
            text: "model_a Class=Private Room Engine Class\r",
          },
        ],
        bitmaps: [],
        externalMembers: [
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 29,
            memberName: "Private Room Engine Class",
            memberType: "script",
          },
          {
            castName: "hh_room_private",
            castOrder: 76,
            member: 30,
            memberName: "Updated Room Engine Class",
            memberType: "script",
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_room_private", 76);

    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    resourceManager.props.set("pallmemnumlist", new LingoPropList());

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["model_a Class"])).toBe((76 << 16) | 29);

    const aliasMember = members.find("memberalias.index", "hh_room_private");
    expect(aliasMember).not.toBeNull();
    aliasMember!.text = "model_b Class=Updated Room Engine Class\r";
    aliasMember!.textVersion += 1;

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["model_b Class"])).toBe((76 << 16) | 30);
  });

  it("redirects colorless room palette indexes to loaded color-backed catalog palettes", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 573,
              name: "hh_room_private",
              members: [{ number: 242, name: "wall_color_invaders", type: "palette" }],
            },
            {
              number: 595,
              name: "hh_cat_gfx_all",
              members: [{ number: 421, name: "catalog_wall_color_invaders", type: "palette" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
        palettes: [
          {
            castName: "hh_cat_gfx_all",
            castOrder: 595,
            member: 421,
            memberName: "catalog_wall_color_invaders",
            colors: [0xffffff, 0x84523b],
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_room_private", 573);
    members.loadCast("hh_cat_gfx_all", 595);

    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    const index = new LingoPropList();
    index.addProp("wall_color_invaders", (573 << 16) | 242);
    index.addProp("catalog_wall_color_invaders", (595 << 16) | 421);
    resourceManager.props.set("pallmemnumlist", index);

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["wall_color_invaders"])).toBe((595 << 16) | 421);
    expect(index.getaProp("wall_color_invaders", (a, b) => a === b)).toBe((595 << 16) | 421);
  });

  it("keeps color-backed exact room palette indexes ahead of catalog palettes", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 573,
              name: "hh_room_private",
              members: [{ number: 242, name: "wall_color_invaders", type: "palette" }],
            },
            {
              number: 595,
              name: "hh_cat_gfx_all",
              members: [{ number: 421, name: "catalog_wall_color_invaders", type: "palette" }],
            },
          ],
        },
        textFields: [],
        bitmaps: [],
        palettes: [
          {
            castName: "hh_room_private",
            castOrder: 573,
            member: 242,
            memberName: "wall_color_invaders",
            colors: [0xffffff, 0xaabbcc],
          },
          {
            castName: "hh_cat_gfx_all",
            castOrder: 595,
            member: 421,
            memberName: "catalog_wall_color_invaders",
            colors: [0xffffff, 0x84523b],
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_room_private", 573);
    members.loadCast("hh_cat_gfx_all", 595);

    const movie = new DirectorMovie(emptyManifest(), { log: () => {} }, async () => {}, async () => "", members);
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    const index = new LingoPropList();
    index.addProp("wall_color_invaders", (573 << 16) | 242);
    index.addProp("catalog_wall_color_invaders", (595 << 16) | 421);
    resourceManager.props.set("pallmemnumlist", index);

    expect(movie.runtime.callMethod(resourceManager, "getmemnum", ["wall_color_invaders"])).toBe((573 << 16) | 242);
    expect(index.getaProp("wall_color_invaders", (a, b) => a === b)).toBe((573 << 16) | 242);
  });

  it("unregisters a dynamic cast from resource indexes in one source-equivalent pass", () => {
    const members = new CastRegistry(
      {
        movie: {
          casts: [
            {
              number: 573,
              name: "hh_room_private",
              members: [],
            },
          ],
        },
        textFields: [],
        bitmaps: [
          {
            castName: "hh_room_private",
            castOrder: 573,
            member: 1,
            memberName: "floorpart",
            mediaType: "bitmap",
            width: 32,
            height: 16,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_room_private/0001-floorpart.png",
          },
          {
            castName: "hh_room_private",
            castOrder: 573,
            member: 2,
            memberName: "wallpart",
            mediaType: "bitmap",
            width: 32,
            height: 32,
            regPoint: { x: 0, y: 0 },
            pngPath: "generated/assets/external-bitmaps/release306/hh_room_private/0002-wallpart.png",
          },
        ],
      },
      "/origins-data/assets/",
    );
    members.loadCast("hh_room_private", 573);

    const movie = new DirectorMovie(
      {
        ...emptyManifest(),
        casts: [{ number: 573, name: "hh_room_private", members: [] }],
      },
      { log: () => {} },
      async () => {},
      async () => "",
      members,
    );
    installRelease306ResourceManagerCompatibility(movie.runtime, members);

    const resourceManager = new ScriptInstance(resourceManagerModule);
    const index = new LingoPropList();
    index.addProp("floorpart", (573 << 16) | 1);
    index.addProp("wallpart", 1234);
    index.addProp("unrelated", 9999);
    resourceManager.props.set("pallmemnumlist", index);
    resourceManager.props.set("pdynmemnumlist", new LingoList(["floorpart", "unrelated"]));

    expect(movie.runtime.callMethod(resourceManager, "unregistermembers", [573])).toBe(1);
    expect(index.getaProp("floorpart", (a, b) => a === b)).toBe(LINGO_VOID);
    expect(index.getaProp("wallpart", (a, b) => a === b)).toBe(1234);
    expect(index.getaProp("unrelated", (a, b) => a === b)).toBe(9999);

    const dynamicMembers = resourceManager.props.get("pdynmemnumlist");
    expect(dynamicMembers).toBeInstanceOf(LingoList);
    expect((dynamicMembers as LingoList).items).toEqual(["unrelated"]);
  });
});
