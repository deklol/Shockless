import { describe, expect, it } from "vitest";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { CastMember, CastRegistry } from "../../src/director/members";
import { LingoPoint } from "../../src/director/geometry";
import { LingoImage } from "../../src/director/imaging";
import { lingoKeyEquals } from "../../src/director/ops";
import { SpriteChannel } from "../../src/director/sprites";
import { OriginsResizeEngine } from "../../src/habbo/resize/OriginsResizeEngine";
import { LINGO_VOID, LingoList, LingoPropList, LingoSymbol, symbol, type LingoValue } from "../../src/director/values";

function manifest(): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 24, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

function moduleFor(
  scriptName: string,
  scriptProperties: string[] = [],
  handlers: GeneratedScriptModule["handlers"] = {},
): GeneratedScriptModule {
  return {
    scriptName,
    scriptType: "parent",
    scriptProperties,
    scriptGlobals: [],
    handlers,
  };
}

function createMovie(): DirectorMovie {
  return new DirectorMovie(
    manifest(),
    { log: () => undefined },
    async () => undefined,
    async () => "",
    new CastRegistry({ movie: manifest(), textFields: [], bitmaps: [] }, "/assets/"),
  );
}

describe("OriginsResizeEngine", () => {
  it("only requires frame sync after viewport or manual room presentation offsets are active", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pSpriteList", "pWrappedParts"]),
    );
    roomVisualizer.props.set("plocx", 0);
    roomVisualizer.props.set("plocy", 0);
    roomVisualizer.props.set("pspritelist", new LingoList());
    roomVisualizer.props.set("pwrappedparts", new LingoPropList());
    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const visualizer = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (visualizer instanceof ScriptInstance) {
            visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
            visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
          }
          return LINGO_VOID;
        },
      }),
    );
    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);

    expect(engine.needsFrameSync()).toBe(false);
    engine.setViewport(1500, 760);
    expect(engine.needsFrameSync()).toBe(true);
    engine.setViewport(960, 540);
    expect(engine.needsFrameSync()).toBe(false);
    engine.dragRoomBy(12, 0);
    expect(engine.needsFrameSync()).toBe(true);
  });

  it("does not mutate Director's logical stage rect for presentation resize", () => {
    const movie = createMovie();
    const engine = new OriginsResizeEngine(movie);

    engine.setViewport(1500, 760);

    expect(movie.runtime.theProp("stageRight")).toBe(960);
    expect(movie.runtime.theProp("stageBottom")).toBe(540);
    const stage = movie.runtime.theProp("stage");
    const rect = movie.getProp(stage, "rect");
    expect(rect).toMatchObject({ left: 0, top: 0, right: 960, bottom: 540 });
  });

  it("anchors wall wrappers flush with the floor instead of double-offsetting them after resize", () => {
    const movie = createMovie();
    const objectList = new LingoPropList();
    const gCore = new ScriptInstance(moduleFor("Object Manager Class", ["pObjectList"]));
    gCore.props.set("pobjectlist", objectList);
    movie.runtime.setGlobal("gcore", gCore);

    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pSpriteList", "pWrappedParts"]),
    );
    roomVisualizer.props.set("plocx", 0);
    roomVisualizer.props.set("plocy", 0);

    const floorSprite = new SpriteChannel(10);
    floorSprite.locH = 32;
    floorSprite.locV = 0;
    const wallSprite = new SpriteChannel(11);
    wallSprite.locH = 32;
    wallSprite.locV = 0;
    roomVisualizer.props.set("pspritelist", new LingoList([floorSprite, wallSprite]));

    const floorWrapper = wrapper("floor", floorSprite, 32, 0);
    const wallWrapper = wrapper("wallleft", wallSprite, 32, 0, [{ locH: 120, locV: 80 }]);
    roomVisualizer.props.set(
      "pwrappedparts",
      LingoPropList.fromPairs([
        ["floor", floorWrapper],
        ["wall", wallWrapper],
      ]),
    );

    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const visualizer = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (visualizer instanceof ScriptInstance) {
            visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
            visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
            const sprites = visualizer.props.get("pspritelist");
            if (sprites instanceof LingoList) {
              for (const value of sprites.items) {
                if (!(value instanceof SpriteChannel)) continue;
                value.locH += dx;
                value.locV += dy;
              }
            }
            moveWrapperParts(visualizer, dx, dy);
          }
          return LINGO_VOID;
        },
        updatescreenoffset() {
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 32);

    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    expect(floorSprite.locH).toBe(302);
    expect(floorSprite.locV).toBe(110);

    floorSprite.locH = 32;
    floorSprite.locV = 0;
    wallSprite.locH = 32;
    wallSprite.locV = 0;
    const snapshot = engine.apply("same-viewport-wrapper-refresh");

    expect(snapshot.anchors).toEqual(expect.arrayContaining([expect.objectContaining({ id: "wrapper:floor", action: "wrapper-follow" })]));
    expect(snapshot.anchors.some((anchor) => anchor.id === "wrapper:wall" && anchor.action === "wrapper-follow")).toBe(true);
    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    expect(floorSprite.locH).toBe(302);
    expect(floorSprite.locV).toBe(110);
    expect(wallSprite.locH).toBe(302);
    expect(wallSprite.locV).toBe(110);
  });

  it("resets the room presentation baseline when source rebuilds a visualizer in the same viewport", () => {
    const movie = createMovie();
    const objectList = new LingoPropList();
    const gCore = new ScriptInstance(moduleFor("Object Manager Class", ["pObjectList"]));
    gCore.props.set("pobjectlist", objectList);
    movie.runtime.setGlobal("gcore", gCore);

    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pLayout", "pSpriteList", "pWrappedParts"]),
    );
    roomVisualizer.props.set("plocx", 0);
    roomVisualizer.props.set("plocy", 0);
    roomVisualizer.props.set("playout", "model_a.room");

    const wallWrapperSprite = new SpriteChannel(13);
    wallWrapperSprite.locH = 0;
    wallWrapperSprite.locV = 0;
    roomVisualizer.props.set("pspritelist", new LingoList([wallWrapperSprite]));

    const wallWrapper = wrapper("wallleft", wallWrapperSprite, 0, 0);
    roomVisualizer.props.set("pwrappedparts", LingoPropList.fromPairs([["wall", wallWrapper]]));

    const objectShadow = new SpriteChannel(14);
    objectShadow.locH = 0;
    objectShadow.locV = 0;

    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const visualizer = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (visualizer instanceof ScriptInstance) {
            visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
            visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
            const sprites = visualizer.props.get("pspritelist");
            if (sprites instanceof LingoList) {
              for (const value of sprites.items) {
                if (!(value instanceof SpriteChannel)) continue;
                value.locH += dx;
                value.locV += dy;
              }
            }
          }
          objectShadow.locH += dx;
          objectShadow.locV += dy;
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 0);

    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    expect(wallWrapperSprite.locH).toBe(270);
    expect(wallWrapperSprite.locV).toBe(110);
    expect(objectShadow.locH).toBe(270);
    expect(objectShadow.locV).toBe(110);

    roomVisualizer.props.set("plocx", 40);
    roomVisualizer.props.set("plocy", 50);
    wallWrapperSprite.locH = 40;
    wallWrapperSprite.locV = 50;
    objectShadow.locH = 40;
    objectShadow.locV = 50;
    wallWrapper.props.set("poffsets", new LingoList([40, 50]));

    const snapshot = engine.apply("source-room-rebuild-same-visualizer");

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Room_stage", action: "source-moveRoomBy", x: 270, y: 110 }),
      ]),
    );
    expect(roomVisualizer.props.get("plocx")).toBe(310);
    expect(roomVisualizer.props.get("plocy")).toBe(160);
    expect(wallWrapperSprite.locH).toBe(310);
    expect(wallWrapperSprite.locV).toBe(160);
    expect(objectShadow.locH).toBe(310);
    expect(objectShadow.locV).toBe(160);
  });

  it("does not treat late source-owned shadow wrappers as a room rebuild", () => {
    const movie = createMovie();
    const objectList = new LingoPropList();
    const gCore = new ScriptInstance(moduleFor("Object Manager Class", ["pObjectList"]));
    gCore.props.set("pobjectlist", objectList);
    movie.runtime.setGlobal("gcore", gCore);

    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pLayout", "pSpriteList", "pWrappedParts"]),
    );
    roomVisualizer.props.set("plocx", 0);
    roomVisualizer.props.set("plocy", 0);
    roomVisualizer.props.set("playout", "model_a.room");
    roomVisualizer.props.set("pspritelist", new LingoList());
    roomVisualizer.props.set("pwrappedparts", new LingoPropList());

    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const visualizer = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (visualizer instanceof ScriptInstance) {
            visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
            visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
            const sprites = visualizer.props.get("pspritelist");
            if (sprites instanceof LingoList) {
              for (const value of sprites.items) {
                if (!(value instanceof SpriteChannel)) continue;
                value.locH += dx;
                value.locV += dy;
              }
            }
          }
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 0);

    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);

    const shadowSprite = new SpriteChannel(15);
    shadowSprite.locH = 0;
    shadowSprite.locV = 0;
    const shadowMember = new CastMember("Runtime", 1, 1, "lateRoomShadow", "bitmap");
    shadowMember.image = new LingoImage(960, 540, 32);
    shadowSprite.member = shadowMember;
    const spriteList = roomVisualizer.props.get("pspritelist");
    if (spriteList instanceof LingoList) spriteList.add(shadowSprite);
    const renderedLocations: Array<[number, number]> = [];
    const shadowWrapper = renderingShadowWrapper(shadowSprite, shadowMember, [{ locH: 590, locV: 370 }], renderedLocations);
    roomVisualizer.props.set("pwrappedparts", LingoPropList.fromPairs([["roomShadow", shadowWrapper]]));

    const sameViewport = engine.apply("late-shadow-wrapper");

    expect(sameViewport.anchors.some((anchor) => anchor.id === "Room_stage" && anchor.x === 270)).toBe(false);
    expect(
      sameViewport.anchors.some(
        (anchor) => anchor.id === "wrapper:roomShadow" && anchor.action === "shadow-follow" && anchor.x === 270 && anchor.y === 110,
      ),
    ).toBe(true);
    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    // Source added this wrapper after the room was centered, so its part data
    // contains +270,+110 screen coordinates. The resize presentation reruns
    // Source's renderer at authored coordinates before positioning the complete
    // logical-stage image with the room.
    expect(renderedLocations).toEqual([[320, 260]]);
    expect(shadowSprite.locH).toBe(270);
    expect(shadowSprite.locV).toBe(110);
    const latePart = (shadowWrapper.props.get("ppartlist") as LingoList).getAt(1) as LingoPropList;
    expect(latePart.getaProp(symbol("locH"), lingoKeyEquals)).toBe(590);
    expect(latePart.getaProp(symbol("locV"), lingoKeyEquals)).toBe(370);

    engine.setViewport(1600, 760);

    expect(roomVisualizer.props.get("plocx")).toBe(320);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    expect(shadowSprite.locH).toBe(320);
    expect(shadowSprite.locV).toBe(110);
    expect(renderedLocations).toHaveLength(1);
  });

  it("reanchors a stage-sized shadow wrapper after Source renders a replacement image", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const shadowSprite = new SpriteChannel(16);
    shadowSprite.locH = 0;
    shadowSprite.locV = 0;
    const shadowMember = new CastMember("Runtime", 1, 1, "roomShadow", "bitmap");
    shadowMember.image = new LingoImage(960, 540, 32);
    shadowSprite.member = shadowMember;
    const roomVisualizer = visualizerInstance(0, 0, -20_099_999, [shadowSprite]);
    const renderedLocations: Array<[number, number]> = [];
    const shadowWrapper = renderingShadowWrapper(
      shadowSprite,
      shadowMember,
      [
        { locH: 320, locV: 260 },
        { locH: 360, locV: 280 },
      ],
      renderedLocations,
    );
    roomVisualizer.props.set("pwrappedparts", LingoPropList.fromPairs([["roomShadow", shadowWrapper]]));
    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          ctx.callMethod(roomVisualizer, "moveby", [Number(args[1] ?? 0), Number(args[2] ?? 0)]);
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 0);
    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.apply("initial-shadow-baseline");
    engine.setViewport(1500, 760);
    expect(shadowSprite.locH).toBe(270);
    expect(shadowSprite.locV).toBe(110);
    expect(renderedLocations).toHaveLength(0);

    // Visualizer Part Wrapper.updatewrap replaces the composed member image
    // and resets the sprite to pOffsets after a furniture shadow changes. The
    // newly-added part coordinates include the room's current presentation
    // offset, matching Shadow Manager.addShadow in the live client.
    shadowMember.image = new LingoImage(960, 540, 32);
    shadowSprite.locH = 0;
    shadowSprite.locV = 0;
    const replacementPart = LingoPropList.fromPairs([
      [symbol("locH"), 670],
      [symbol("locV"), 410],
    ]);
    (shadowWrapper.props.get("ppartlist") as LingoList).setAt(2, replacementPart);
    engine.apply("shadow-updatewrap");

    expect(renderedLocations).toEqual([
      [320, 260],
      [400, 300],
    ]);
    expect(shadowSprite.locH).toBe(270);
    expect(shadowSprite.locV).toBe(110);
    expect(replacementPart.getaProp(symbol("locH"), lingoKeyEquals)).toBe(670);
    expect(replacementPart.getaProp(symbol("locV"), lingoKeyEquals)).toBe(410);

    engine.setViewport(1600, 760);
    expect(shadowSprite.locH).toBe(320);
    expect(shadowSprite.locV).toBe(110);
    expect(renderedLocations).toHaveLength(2);
  });

  it("reanchors the source action-button window when source room selection snaps it back", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const roomInterface = new ScriptInstance(moduleFor("Room Interface Class", ["pLastStageW", "pLastStageH"]));
    const actionWindow = windowInstance(545, 470, 390, 48);
    const actionSprite = new SpriteChannel(51);
    actionSprite.locH = 550;
    actionSprite.locV = 475;
    actionWindow.props.set("pspritelist", LingoPropList.fromPairs([["action.button", actionSprite]]));

    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_interface", actionWindow, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(actionWindow.props.get("plocx")).toBe(1085);
    expect(actionWindow.props.get("plocy")).toBe(690);
    expect(actionSprite.locH).toBe(1090);
    expect(actionSprite.locV).toBe(695);

    movie.runtime.callMethod(actionWindow, "moveto", [545, 690]);
    expect(actionWindow.props.get("plocx")).toBe(545);

    const snapshot = engine.apply("same-viewport-source-snap");

    expect(snapshot.anchors.some((anchor) => anchor.id === "Room_interface")).toBe(true);
    expect(actionWindow.props.get("plocx")).toBe(1085);
    expect(actionWindow.props.get("plocy")).toBe(690);
    expect(actionSprite.locH).toBe(1090);
    expect(actionSprite.locV).toBe(695);
  });

  it("does not confuse the room interface thread with the optional action-button window", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const roomInterface = new ScriptInstance(moduleFor("Room Interface Class", ["pLastStageW", "pLastStageH"]));
    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1264, 761);

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.anchors.some((anchor) => anchor.id === "Room_interface")).toBe(false);
    expect(roomInterface.props.get("plaststagew")).toBe(1264);
    expect(roomInterface.props.get("plaststageh")).toBe(761);
  });

  it("moves infostand title overlay sprites with the infostand window", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", [
        "pLastStageW",
        "pLastStageH",
        "pInfoStandTitleSpr",
        "pInfoStandTitleBgSpr",
        "pInfoStandTitlePanelSpr",
      ]),
    );
    const standWindow = windowInstance(792, 332, 168, 208);
    const title = new SpriteChannel(61);
    title.locH = 774;
    title.locV = 196;
    const titleBg = new SpriteChannel(62);
    titleBg.locH = 774;
    titleBg.locV = 196;
    const titlePanel = new SpriteChannel(63);
    titlePanel.locH = 774;
    titlePanel.locV = 212;
    roomInterface.props.set("pinfostandtitlespr", title);
    roomInterface.props.set("pinfostandtitlebgspr", titleBg);
    roomInterface.props.set("pinfostandtitlepanelspr", titlePanel);

    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_info_stand", standWindow, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    expect(snapshot.anchors.some((anchor) => anchor.action === "infostand-title-follow")).toBe(true);
    expect(standWindow.props.get("plocx")).toBe(1332);
    expect(standWindow.props.get("plocy")).toBe(552);
    expect(title.locH).toBe(1314);
    expect(title.locV).toBe(416);
    expect(titleBg.locH).toBe(1314);
    expect(titlePanel.locV).toBe(432);
  });

  it("adds a presentation toolbar underlay without resizing source toolbar sprites", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const bg = new SpriteChannel(71);
    bg.member = new CastMember("hh_room_bar", 1, 1, "alapalkki_bg", "bitmap", {
      bitmap: { width: 960, height: 54, regX: 10, regY: 0, pngUrl: null },
    });
    bg.locH = 10;
    bg.locV = 452;
    bg.width = 960;
    bg.height = 54;
    bg.puppet = 1;
    const iconShadow = new SpriteChannel(72);
    iconShadow.member = new CastMember("hh_room_bar", 1, 2, "shadow.bar", "bitmap", {
      bitmap: { width: 38, height: 22, regX: 0, regY: 0, pngUrl: null },
    });
    iconShadow.locH = 930;
    iconShadow.locV = 468;
    iconShadow.width = 38;
    iconShadow.height = 22;
    iconShadow.puppet = 1;
    const bottomBar = windowInstance(0, 452, 960, 92);
    bottomBar.props.set("pspritelist", LingoPropList.fromPairs([["bg", bg], ["shadow", iconShadow]]));

    objectList.setaProp("Room_bar", bottomBar, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    const underlay = snapshot.anchors.find((anchor) => anchor.action === "toolbar-underlay");
    expect(underlay).toMatchObject({ x: 0, y: 705, width: 1500, height: 54 });
    expect(bottomBar.props.get("plocx")).toBe(270);
    expect(bottomBar.props.get("plocy")).toBe(668);
    expect(bg.width).toBe(960);
    expect(bg.locH).toBe(280);
    expect(bg.locV).toBe(668);
    expect(iconShadow.width).toBe(38);
    expect(iconShadow.locH).toBe(1200);
    expect(iconShadow.locV).toBe(684);
  });

  it("keeps presentation cover and dimmer sprites out of the toolbar hit strip", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const cover = new SpriteChannel(80);
    cover.width = 960;
    cover.height = 540;
    const dimmer = new SpriteChannel(81);
    dimmer.width = 980;
    dimmer.height = 540;
    const roomInterface = new ScriptInstance(moduleFor("Room Interface Class", ["pCoverSpr", "pWideScreenOffset"], {
      moveroomby() {
        return LINGO_VOID;
      },
    }));
    roomInterface.props.set("pcoverspr", cover);
    roomInterface.props.set("pwidescreenoffset", 32);
    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pSpriteList", "pWrappedParts", "pRoomDimmerSprite"]),
    );
    roomVisualizer.props.set("plocx", 32);
    roomVisualizer.props.set("plocy", 0);
    roomVisualizer.props.set("pspritelist", new LingoList());
    roomVisualizer.props.set("pwrappedparts", new LingoPropList());
    roomVisualizer.props.set("proomdimmersprite", dimmer);
    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    expect(cover.width).toBe(1500);
    expect(cover.height).toBe(705);
    expect(dimmer.width).toBe(1520);
    expect(dimmer.height).toBe(705);
    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pCoverSpr", height: 705 }),
        expect.objectContaining({ id: "pRoomDimmerSprite", height: 705 }),
      ]),
    );
  });

  it("drags the room through the same source moveRoomBy path used by viewport anchoring", () => {
    const movie = createMovie();
    const objectList = new LingoPropList();
    const gCore = new ScriptInstance(moduleFor("Object Manager Class", ["pObjectList"]));
    gCore.props.set("pobjectlist", objectList);
    movie.runtime.setGlobal("gcore", gCore);

    const roomVisualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pSpriteList", "pWrappedParts"]),
    );
    roomVisualizer.props.set("plocx", 0);
    roomVisualizer.props.set("plocy", 0);
    roomVisualizer.props.set("pspritelist", new LingoList());
    roomVisualizer.props.set("pwrappedparts", new LingoPropList());

    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const visualizer = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (visualizer instanceof ScriptInstance) {
            visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
            visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
          }
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 32);
    objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
    objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);
    expect(roomVisualizer.props.get("plocx")).toBe(270);
    expect(roomVisualizer.props.get("plocy")).toBe(110);
    expect(engine.canDragRoomAt(50, 50)).toBe(true);
    expect(engine.canDragRoomAt(50, 730)).toBe(false);

    engine.dragRoomBy(25, -15);
    expect(roomVisualizer.props.get("plocx")).toBe(295);
    expect(roomVisualizer.props.get("plocy")).toBe(95);

    engine.apply("same-viewport-after-drag");
    expect(roomVisualizer.props.get("plocx")).toBe(295);
    expect(roomVisualizer.props.get("plocy")).toBe(95);
  });

  it("anchors newly reopened hand visualizers to the wide viewport right edge", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    const firstHand = windowInstance(704, -22, 256, 220);
    objectList.setaProp("Hand_visualizer", firstHand, lingoKeyEquals);

    let snapshot = engine.apply("hand-opened-after-wide-resize");

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Hand_visualizer", action: "right-preserve", x: 1244, y: -22 }),
      ]),
    );
    expect(firstHand.props.get("plocx")).toBe(1244);
    expect(firstHand.props.get("plocy")).toBe(-22);

    snapshot = engine.apply("same-viewport-after-hand-anchor");
    expect(snapshot.anchors.some((anchor) => anchor.id === "Hand_visualizer")).toBe(false);
    expect(firstHand.props.get("plocx")).toBe(1244);

    const reopenedHand = windowInstance(704, -22, 256, 220);
    objectList.setaProp("Hand_visualizer", reopenedHand, lingoKeyEquals);

    engine.apply("hand-reopened-after-close");

    expect(reopenedHand.props.get("plocx")).toBe(1244);
    expect(reopenedHand.props.get("plocy")).toBe(-22);
  });

  it("centers the hotel entry visualizer and bottom bar in a wide presentation viewport", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const entryView = windowInstance(0, 0, 960, 540);
    const entryCloud = new SpriteChannel(91);
    entryCloud.locH = 480;
    entryCloud.locV = 120;
    const entryCar = new SpriteChannel(93);
    entryCar.locH = 184;
    entryCar.locV = 505;
    entryView.props.set("pspritelist", LingoPropList.fromPairs([["entry_cloud", entryCloud], ["entry_car", entryCar]]));
    const entryInterface = new ScriptInstance(moduleFor("Entry Interface Class", ["pItemObjList"]));
    const cloudAnimation = new ScriptInstance(moduleFor("Entry Cloud Class", ["pSprite", "pLoc"]));
    cloudAnimation.props.set("psprite", entryCloud);
    cloudAnimation.props.set("ploc", new LingoPoint(480, 120));
    const carAnimation = new ScriptInstance(moduleFor("Entry Car Class", ["pSprite"]));
    carAnimation.props.set("psprite", entryCar);
    entryInterface.props.set("pitemobjlist", new LingoList([cloudAnimation, carAnimation]));
    const entryBar = windowInstance(0, 535, 960, 54);
    const entryBarIcon = new SpriteChannel(92);
    entryBarIcon.locH = 220;
    entryBarIcon.locV = 536;
    entryBar.props.set("pspritelist", LingoPropList.fromPairs([["entry_icon", entryBarIcon]]));
    const loginA = windowInstance(640, 100, 220, 120);
    const loginASprite = new SpriteChannel(94);
    loginASprite.locH = 650;
    loginASprite.locV = 110;
    loginA.props.set("pspritelist", LingoPropList.fromPairs([["login_a_bg", loginASprite]]));
    const loginB = windowInstance(640, 230, 220, 220);
    const loginBSprite = new SpriteChannel(95);
    loginBSprite.locH = 650;
    loginBSprite.locV = 240;
    loginB.props.set("pspritelist", LingoPropList.fromPairs([["login_b_bg", loginBSprite]]));
    const loginSteam = windowInstance(640, 100, 202, 102);
    const loginSteamSprite = new SpriteChannel(96);
    loginSteamSprite.locH = 650;
    loginSteamSprite.locV = 110;
    loginSteam.props.set("pspritelist", LingoPropList.fromPairs([["steam_logo", loginSteamSprite]]));
    const loginInterface = new ScriptInstance(moduleFor("Login Interface Class"));
    const unrelatedInterface = new ScriptInstance(moduleFor("Unrelated Interface Class"));
    const unrelatedWindow = windowInstance(80, 80, 100, 100);
    objectList.setaProp(symbol("login_interface"), loginInterface, lingoKeyEquals);
    objectList.setaProp(symbol("unrelated_interface"), unrelatedInterface, lingoKeyEquals);
    loginA.props.set("pclientid", symbol("login_interface"));
    loginB.props.set("pclientid", symbol("login_interface"));
    loginSteam.props.set("pclientid", symbol("login_interface"));
    unrelatedWindow.props.set("pclientid", symbol("unrelated_interface"));
    objectList.setaProp(symbol("entry_interface"), entryInterface, lingoKeyEquals);
    objectList.setaProp("entry_view", entryView, lingoKeyEquals);
    objectList.setaProp("entry_bar", entryBar, lingoKeyEquals);
    objectList.setaProp(symbol("login_a"), loginA, lingoKeyEquals);
    objectList.setaProp(symbol("login_b"), loginB, lingoKeyEquals);
    objectList.setaProp(symbol("login_steam"), loginSteam, lingoKeyEquals);
    objectList.setaProp(symbol("unrelated_entry_window"), unrelatedWindow, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entry_view", action: "stage-center", x: 270, y: 0 }),
        expect.objectContaining({ id: "entry_bar", action: "bottom-center", x: 270, y: 706 }),
        expect.objectContaining({ id: "login_a", action: "entry-stage-follow", x: 910, y: 100 }),
        expect.objectContaining({ id: "login_b", action: "entry-stage-follow", x: 910, y: 230 }),
        expect.objectContaining({ id: "login_steam", action: "entry-stage-follow", x: 910, y: 100 }),
      ]),
    );
    expect(entryView.props.get("plocx")).toBe(270);
    expect(entryView.props.get("plocy")).toBe(0);
    expect(entryCloud.locH).toBe(750);
    expect(entryCloud.locV).toBe(120);
    expect(entryCar.locH).toBe(454);
    expect(entryCar.locV).toBe(505);
    expect(entryBar.props.get("plocx")).toBe(270);
    expect(entryBar.props.get("plocy")).toBe(706);
    expect(entryBarIcon.locH).toBe(490);
    expect(entryBarIcon.locV).toBe(707);
    expect(loginA.props.get("plocx")).toBe(910);
    expect(loginA.props.get("plocy")).toBe(100);
    expect(loginASprite.locH).toBe(920);
    expect(loginASprite.locV).toBe(110);
    expect(loginB.props.get("plocx")).toBe(910);
    expect(loginB.props.get("plocy")).toBe(230);
    expect(loginBSprite.locH).toBe(920);
    expect(loginBSprite.locV).toBe(240);
    expect(loginSteam.props.get("plocx")).toBe(910);
    expect(loginSteam.props.get("plocy")).toBe(100);
    expect(loginSteamSprite.locH).toBe(920);
    expect(loginSteamSprite.locV).toBe(110);
    expect(unrelatedWindow.props.get("plocx")).toBe(80);
    expect(unrelatedWindow.props.get("plocy")).toBe(80);

    movie.runtime.callMethod(entryView, "moveto", [0, 0]);
    movie.runtime.callMethod(entryBar, "moveto", [0, 535]);
    movie.runtime.callMethod(loginA, "moveto", [640, 100]);
    movie.runtime.callMethod(loginB, "moveto", [640, 230]);
    movie.runtime.callMethod(loginSteam, "moveto", [640, 100]);
    const refreshed = engine.apply("source-entry-reset");

    expect(refreshed.anchors.some((anchor) => anchor.id === "entry_view")).toBe(true);
    expect(refreshed.anchors.some((anchor) => anchor.id === "entry_bar")).toBe(true);
    expect(refreshed.anchors.some((anchor) => anchor.id === "login_a")).toBe(true);
    expect(refreshed.anchors.some((anchor) => anchor.id === "login_b")).toBe(true);
    expect(refreshed.anchors.some((anchor) => anchor.id === "login_steam")).toBe(true);
    expect(entryView.props.get("plocx")).toBe(270);
    expect(entryView.props.get("plocy")).toBe(0);
    expect(entryBar.props.get("plocx")).toBe(270);
    expect(entryBar.props.get("plocy")).toBe(706);
    expect(loginA.props.get("plocx")).toBe(910);
    expect(loginA.props.get("plocy")).toBe(100);
    expect(loginB.props.get("plocx")).toBe(910);
    expect(loginB.props.get("plocy")).toBe(230);
    expect(loginSteam.props.get("plocx")).toBe(910);
    expect(loginSteam.props.get("plocy")).toBe(100);

    entryCloud.locH = 481;
    entryCloud.locV = 121;
    entryCar.locH = 456;
    entryCar.locV = 504;
    const animationRefresh = engine.apply("entry-animation-source-refresh");
    expect(animationRefresh.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entry_animation:91", action: "animation-stage-center", x: 750, y: 120 }),
      ]),
    );
    expect(entryCloud.locH).toBe(750);
    expect(entryCloud.locV).toBe(120);
    expect(entryCar.locH).toBe(456);
    expect(entryCar.locV).toBe(504);

    entryCar.locH = 184;
    entryCar.locV = 505;
    engine.apply("entry-car-source-reset");
    expect(entryCar.locH).toBe(454);
    expect(entryCar.locV).toBe(505);
  });

  it("recenters source-created loading windows in the presentation viewport", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const loadingRoom = windowInstance(330, 220, 300, 100);
    const loadingRoomSprite = new SpriteChannel(95);
    loadingRoomSprite.locH = 340;
    loadingRoomSprite.locV = 230;
    loadingRoom.props.set("pspritelist", LingoPropList.fromPairs([["loader", loadingRoomSprite]]));
    objectList.setaProp("Loading room", loadingRoom, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    let snapshot = engine.setViewport(1500, 760);

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Loading room", action: "viewport-center", x: 600, y: 330 }),
      ]),
    );
    expect(loadingRoom.props.get("plocx")).toBe(600);
    expect(loadingRoom.props.get("plocy")).toBe(330);
    expect(loadingRoomSprite.locH).toBe(610);
    expect(loadingRoomSprite.locV).toBe(340);

    movie.runtime.callMethod(loadingRoom, "moveto", [330, 220]);
    snapshot = engine.apply("source-loading-room-center-reset");

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Loading room", action: "viewport-center", x: 600, y: 330 }),
      ]),
    );
    expect(loadingRoom.props.get("plocx")).toBe(600);
    expect(loadingRoom.props.get("plocy")).toBe(330);
  });

  it("does not double-offset generated loading bar windows as high-z stage presentations", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const loadingWindow = windowInstance(416, 262, 128, 16);
    const loadingSprite = new SpriteChannel(96);
    loadingSprite.locH = 416;
    loadingSprite.locV = 262;
    loadingSprite.locZ = 19_000_000;
    loadingWindow.props.set("plocz", 19_000_000);
    loadingWindow.props.set("pspritelist", LingoPropList.fromPairs([["progress", loadingSprite]]));
    objectList.setaProp("loader 123", loadingWindow, lingoKeyEquals);

    const loadingBar = new ScriptInstance(moduleFor("Loading Bar Class", ["pWindowID"]));
    loadingBar.props.set("pwindowid", "loader 123");
    objectList.setaProp(symbol("random-loading-bar"), loadingBar, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "loader 123", action: "viewport-center", x: 686, y: 372 }),
      ]),
    );
    expect(snapshot.anchors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "loader 123", action: "stage-presentation-follow" }),
      ]),
    );
    expect(loadingWindow.props.get("plocx")).toBe(686);
    expect(loadingWindow.props.get("plocy")).toBe(372);
    expect(loadingSprite.locH).toBe(686);
    expect(loadingSprite.locV).toBe(372);
  });

  it("keeps mouseLoc-authored high-depth object previews in pointer space after resize", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const preview = new SpriteChannel(97);
    preview.locH = 120;
    preview.locV = 80;
    preview.locZ = 20_000_000;
    const mover = new ScriptInstance(moduleFor("Object Mover Class", ["pSmallSpr"]));
    mover.props.set("psmallspr", preview);
    objectList.setaProp("Object Mover", mover, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(preview.locH).toBe(390);
    expect(preview.locV).toBe(190);

    movie.pointerMove(410, 260);
    preview.locH = 410;
    preview.locV = 260;
    engine.apply("source-showsmallpic");

    expect(preview.locH).toBe(410);
    expect(preview.locV).toBe(260);

    movie.pointerMove(430, 280);
    preview.locH = 430;
    preview.locV = 280;
    engine.apply("source-showsmallpic-next-frame");

    expect(preview.locH).toBe(430);
    expect(preview.locV).toBe(280);
  });

  it("still anchors high-depth object sprites that were not authored at the pointer", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    movie.pointerMove(410, 260);
    const sprite = new SpriteChannel(98);
    sprite.locH = 120;
    sprite.locV = 80;
    sprite.locZ = 20_000_000;
    const stageObject = new ScriptInstance(moduleFor("Stage Presentation Object", ["pSprite"]));
    stageObject.props.set("psprite", sprite);
    objectList.setaProp("stage_object", stageObject, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    engine.setViewport(1500, 760);

    expect(sprite.locH).toBe(390);
    expect(sprite.locV).toBe(190);
  });

  it("anchors source-created bulletin notifications to the presentation viewport right edge", () => {
    const movie = createMovie();
    const objectList = installObjectManager(movie);
    const notificationSprite = new SpriteChannel(101);
    notificationSprite.locH = 702;
    notificationSprite.locV = 620;
    notificationSprite.width = 254;
    notificationSprite.ink = 8;
    notificationSprite.blend = 100;
    const notificationManager = new ScriptInstance(
      moduleFor("Bulletin Notification Manager", ["pNotifications", "pRightMargin"]),
    );
    notificationManager.props.set("prightmargin", 4);
    notificationManager.props.set(
      "pnotifications",
      LingoPropList.fromPairs([
        [
          "notification_1",
          LingoPropList.fromPairs([
            [symbol("sprite"), notificationSprite],
            [symbol("progress"), 40],
          ]),
        ],
      ]),
    );
    objectList.setaProp("bulletin_notification_manager", notificationManager, lingoKeyEquals);

    const engine = new OriginsResizeEngine(movie);
    const snapshot = engine.setViewport(1500, 760);

    expect(snapshot.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bulletin_notification:notification_1",
          action: "top-right-notification",
          x: 1242,
          y: 620,
          width: 254,
        }),
      ]),
    );
    expect(notificationSprite.locH).toBe(1242);
    expect(notificationSprite.locV).toBe(620);
    expect(notificationSprite.ink).toBe(8);
    expect(notificationSprite.blend).toBe(100);
  });
});

function wrapper(
  type: string,
  sprite: SpriteChannel,
  offsetX: number,
  offsetY: number,
  parts: Array<{ locH: number; locV: number }> = [],
): ScriptInstance {
  const instance = new ScriptInstance(
    moduleFor("Visualizer Part Wrapper Class", ["pTypeDef", "pSprite", "pOffsets", "pPartList"]),
  );
  instance.props.set("ptypedef", symbol(type));
  instance.props.set("psprite", sprite);
  instance.props.set("poffsets", new LingoList([offsetX, offsetY]));
  instance.props.set(
    "ppartlist",
    new LingoList(
      parts.map((part) =>
        LingoPropList.fromPairs([
          [symbol("locH"), part.locH],
          [symbol("locV"), part.locV],
        ]),
      ),
    ),
  );
  return instance;
}

function renderingShadowWrapper(
  sprite: SpriteChannel,
  member: CastMember,
  parts: Array<{ locH: number; locV: number }>,
  renderedLocations: Array<[number, number]>,
): ScriptInstance {
  const instance = new ScriptInstance(
    moduleFor(
      "Visualizer Part Wrapper Class",
      ["pTypeDef", "pSprite", "pOffsets", "pPartList"],
      {
        renderimage(ctx, me) {
          const partList = ctx.getInstanceProp(me, "ppartlist");
          if (partList instanceof LingoList) {
            for (const value of partList.items) {
              if (!(value instanceof LingoPropList)) continue;
              renderedLocations.push([
                Number(value.getaProp(symbol("locH"), lingoKeyEquals)),
                Number(value.getaProp(symbol("locV"), lingoKeyEquals)),
              ]);
            }
          }
          member.image = new LingoImage(960, 540, 32);
          return 1;
        },
      },
    ),
  );
  instance.props.set("ptypedef", symbol("other"));
  instance.props.set("psprite", sprite);
  instance.props.set("poffsets", new LingoList([0, 0]));
  instance.props.set(
    "ppartlist",
    new LingoList(
      parts.map((part) =>
        LingoPropList.fromPairs([
          [symbol("locH"), part.locH],
          [symbol("locV"), part.locV],
        ]),
      ),
    ),
  );
  return instance;
}

function moveWrapperParts(visualizer: ScriptInstance, dx: number, dy: number): void {
  const wrappedParts = visualizer.props.get("pwrappedparts");
  if (!(wrappedParts instanceof LingoPropList)) return;
  for (const wrapperValue of wrappedParts.values) {
    if (!(wrapperValue instanceof ScriptInstance)) continue;
    const partList = wrapperValue.props.get("ppartlist");
    if (!(partList instanceof LingoList)) continue;
    for (const partValue of partList.items) {
      if (!(partValue instanceof LingoPropList)) continue;
      const locH = Number(partValue.getaProp(symbol("locH"), lingoKeyEquals));
      const locV = Number(partValue.getaProp(symbol("locV"), lingoKeyEquals));
      partValue.setaProp(symbol("locH"), locH + dx, lingoKeyEquals);
      partValue.setaProp(symbol("locV"), locV + dy, lingoKeyEquals);
    }
  }
}

function installObjectManager(movie: DirectorMovie): LingoPropList {
  const objectList = new LingoPropList();
  const gCore = new ScriptInstance(moduleFor("Object Manager Class", ["pObjectList"]));
  gCore.props.set("pobjectlist", objectList);
  movie.runtime.setGlobal("gcore", gCore);
  return objectList;
}

function windowInstance(x: number, y: number, width: number, height: number): ScriptInstance {
  const instance = new ScriptInstance(
    moduleFor("Window Instance Class", ["pLocX", "pLocY", "pwidth", "pheight", "pSpriteList", "pBoundary"], {
      moveto(ctx, me, args) {
        const targetX = Number(args[1] ?? 0);
        const targetY = Number(args[2] ?? 0);
        const dx = targetX - Number(ctx.getInstanceProp(me, "plocx") ?? 0);
        const dy = targetY - Number(ctx.getInstanceProp(me, "plocy") ?? 0);
        ctx.callMethod(me, "moveby", [dx, dy]);
        return LINGO_VOID;
      },
      moveby(ctx, me, args) {
        const dx = Number(args[1] ?? 0);
        const dy = Number(args[2] ?? 0);
        ctx.setInstanceProp(me, "plocx", Number(ctx.getInstanceProp(me, "plocx") ?? 0) + dx);
        ctx.setInstanceProp(me, "plocy", Number(ctx.getInstanceProp(me, "plocy") ?? 0) + dy);
        for (const sprite of windowSprites(ctx.getInstanceProp(me, "pspritelist"))) {
          sprite.locH += dx;
          sprite.locV += dy;
        }
        return LINGO_VOID;
      },
      getproperty(ctx, me, args) {
        const prop = propName(args[1] ?? LINGO_VOID);
        if (prop === "width") return ctx.getInstanceProp(me, "pwidth");
        if (prop === "height") return ctx.getInstanceProp(me, "pheight");
        if (prop === "spritlist" || prop === "spritelist") return ctx.getInstanceProp(me, "pspritelist");
        return LINGO_VOID;
      },
      setproperty(ctx, me, args) {
        if (propName(args[1] ?? LINGO_VOID) === "boundary") ctx.setInstanceProp(me, "pboundary", args[2] ?? LINGO_VOID);
        return 1;
      },
    }),
  );
  instance.props.set("plocx", x);
  instance.props.set("plocy", y);
  instance.props.set("pwidth", width);
  instance.props.set("pheight", height);
  instance.props.set("pspritelist", new LingoList());
  return instance;
}

function visualizerInstance(x: number, y: number, z: number, sprites: SpriteChannel[] = []): ScriptInstance {
  const instance = new ScriptInstance(
    moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pLocZ", "pLayout", "pSpriteList", "pWrappedParts"], {
      moveto(ctx, me, args) {
        const targetX = Number(args[1] ?? 0);
        const targetY = Number(args[2] ?? 0);
        const dx = targetX - Number(ctx.getInstanceProp(me, "plocx") ?? 0);
        const dy = targetY - Number(ctx.getInstanceProp(me, "plocy") ?? 0);
        ctx.callMethod(me, "moveby", [dx, dy]);
        return LINGO_VOID;
      },
      moveby(ctx, me, args) {
        const dx = Number(args[1] ?? 0);
        const dy = Number(args[2] ?? 0);
        ctx.setInstanceProp(me, "plocx", Number(ctx.getInstanceProp(me, "plocx") ?? 0) + dx);
        ctx.setInstanceProp(me, "plocy", Number(ctx.getInstanceProp(me, "plocy") ?? 0) + dy);
        for (const sprite of windowSprites(ctx.getInstanceProp(me, "pspritelist"))) {
          sprite.locH += dx;
          sprite.locV += dy;
        }
        return LINGO_VOID;
      },
      getproperty(ctx, me, args) {
        const prop = propName(args[1] ?? LINGO_VOID);
        if (prop === "sprcount") return windowSprites(ctx.getInstanceProp(me, "pspritelist")).length;
        if (prop === "spritlist" || prop === "spritelist") return ctx.getInstanceProp(me, "pspritelist");
        if (prop === "layout") return ctx.getInstanceProp(me, "playout");
        return LINGO_VOID;
      },
    }),
  );
  instance.props.set("plocx", x);
  instance.props.set("plocy", y);
  instance.props.set("plocz", z);
  instance.props.set("playout", "stage.room");
  instance.props.set("pspritelist", new LingoList(sprites));
  instance.props.set("pwrappedparts", new LingoPropList());
  return instance;
}

function objectWithSprites(scriptName: string, sprites: SpriteChannel[], props: Record<string, LingoValue> = {}): ScriptInstance {
  const instance = new ScriptInstance(
    moduleFor(scriptName, ["pSpriteList", ...Object.keys(props)], {
      getsprites() {
        return new LingoList(sprites);
      },
      getclass() {
        return scriptName.toLowerCase().includes("pet") ? "pet" : "human";
      },
    }),
  );
  for (const [key, value] of Object.entries(props)) instance.props.set(key.toLowerCase(), value);
  return instance;
}

function roomComponent(lists: {
  users: LingoList;
  active: LingoList;
  items: LingoList;
  passive: LingoList;
}): ScriptInstance {
  return new ScriptInstance(
    moduleFor("Room Component Class", [], {
      getuserobject() {
        return lists.users;
      },
      getactiveobject() {
        return lists.active;
      },
      getitemobject() {
        return lists.items;
      },
      getpassiveobject() {
        return lists.passive;
      },
    }),
  );
}

function windowSprites(value: LingoValue): SpriteChannel[] {
  if (value instanceof LingoList) return value.items.filter((item): item is SpriteChannel => item instanceof SpriteChannel);
  if (value instanceof LingoPropList) return value.values.filter((item): item is SpriteChannel => item instanceof SpriteChannel);
  return [];
}

function propName(value: LingoValue): string {
  if (value instanceof LingoSymbol) return value.name.toLowerCase();
  return String(value).replace(/^#/, "").toLowerCase();
}

it("keeps wall and floor wrappers locked to room position across multiple frames", () => {
  // Models real game: moveroomby does NOT move wrapper parts (matching real Lingo at
  // ParentScript_3_-_Room_Interface_Class.ts:2834). Source resets wrapper sprites to
  // pOffsets each frame (Visualizer Part Wrapper Class.updateSprite:432).
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const floorSprite = new SpriteChannel(10);
  const wallSprite = new SpriteChannel(11);
  floorSprite.locH = 32;
  floorSprite.locV = 0;
  wallSprite.locH = 32;
  wallSprite.locV = 0;

  const visualizer = new ScriptInstance(
    moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pSpriteList", "pWrappedParts"]),
  );
  visualizer.props.set("plocx", 0);
  visualizer.props.set("plocy", 0);
  visualizer.props.set("pspritelist", new LingoList([floorSprite, wallSprite]));

  const floorWrapper = wrapper("floor", floorSprite, 32, 0);
  const wallWrapper = wrapper("wallleft", wallSprite, 32, 0, [{ locH: 120, locV: 80 }]);
  visualizer.props.set(
    "pwrappedparts",
    LingoPropList.fromPairs([["floor", floorWrapper], ["wall", wallWrapper]]),
  );

  const roomInterface = new ScriptInstance(
    moduleFor("Room Interface Class", ["pWideScreenOffset"], {
      moveroomby(ctx, me, args) {
        const dx = Number(args[1] ?? 0);
        const dy = Number(args[2] ?? 0);
        const viz = objectList.getaProp("Room_visualizer", (a, b) => a === b);
        if (viz instanceof ScriptInstance) {
          viz.props.set("plocx", Number(viz.props.get("plocx") ?? 0) + dx);
          viz.props.set("plocy", Number(viz.props.get("plocy") ?? 0) + dy);
          for (const v of (viz.props.get("pspritelist") as LingoList).items) {
            if (v instanceof SpriteChannel) { v.locH += dx; v.locV += dy; }
          }
          // Real Lingo does NOT call moveWrapperParts — wrapper parts stay at original
        }
        return LINGO_VOID;
      },
    }),
  );
  roomInterface.props.set("pwidescreenoffset", 32);
  objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(2560, 1440);
  const offsetX = Math.round((2560 - 960) / 2); // 800

  // After resize: visualizer moved, wrappers corrected
  expect(visualizer.props.get("plocx")).toBe(800);
  expect(floorSprite.locH).toBe(832); // 32 + 800
  expect(wallSprite.locH).toBe(832); // wall also corrected

  // Simulate 10 frames: source resets sprites each frame, engine re-corrects
  for (let frame = 0; frame < 10; frame++) {
    floorSprite.locH = 32; // source updateSprite resets to pOffsets
    floorSprite.locV = 0;
    wallSprite.locH = 32;
    wallSprite.locV = 0;
    engine.apply(`frame-${frame}`);
  }

  // After 10 frames, wrappers must still be at the correct offset position
  expect(floorSprite.locH).toBe(832);
  expect(wallSprite.locH).toBe(832);

  // Change viewport and verify wrappers follow
  engine.setViewport(1920, 1080);
  const offset2 = Math.round((1920 - 960) / 2); // 480
  expect(floorSprite.locH).toBe(512); // 32 + 480
  expect(wallSprite.locH).toBe(512); // wall follows floor

  // 10 more frames
  for (let frame = 0; frame < 10; frame++) {
    floorSprite.locH = 32;
    wallSprite.locH = 32;
    engine.apply(`frame2-${frame}`);
  }
  expect(floorSprite.locH).toBe(512);
  expect(wallSprite.locH).toBe(512);
});

it("does not accumulate wrapper position drift across resize and room rejoin cycles", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  // Room at 2560x1440 viewport (2K monitor) with two walls and a floor
  function buildRoom(): { visualizer: ScriptInstance; interface: ScriptInstance; walls: SpriteChannel[]; floor: SpriteChannel } {
    const visualizer = new ScriptInstance(
      moduleFor("Visualizer Instance Class", ["pLocX", "pLocY", "pLayout", "pSpriteList", "pWrappedParts"]),
    );
    visualizer.props.set("plocx", 0);
    visualizer.props.set("plocy", 0);
    visualizer.props.set("playout", "model_a.room");

    const wallLeftSprite = new SpriteChannel(10);
    wallLeftSprite.locH = 32;
    wallLeftSprite.locV = 0;
    const wallRightSprite = new SpriteChannel(11);
    wallRightSprite.locH = 480;
    wallRightSprite.locV = 0;
    const floorSprite = new SpriteChannel(12);
    floorSprite.locH = 0;
    floorSprite.locV = 160;
    visualizer.props.set("pspritelist", new LingoList([wallLeftSprite, wallRightSprite, floorSprite]));

    const wallLeftWrapper = wrapper("wallleft", wallLeftSprite, 32, 0, [
      { locH: 120, locV: 80 },
      { locH: 180, locV: 80 },
    ]);
    const wallRightWrapper = wrapper("wallright", wallRightSprite, 480, 0, [
      { locH: 600, locV: 80 },
      { locH: 660, locV: 80 },
    ]);
    const floorWrapper = wrapper("floor", floorSprite, 0, 160);
    visualizer.props.set(
      "pwrappedparts",
      LingoPropList.fromPairs([
        ["wallleft", wallLeftWrapper],
        ["wallright", wallRightWrapper],
        ["floor", floorWrapper],
      ]),
    );

    const roomInterface = new ScriptInstance(
      moduleFor("Room Interface Class", ["pWideScreenOffset"], {
        moveroomby(ctx, me, args) {
          const dx = Number(args[1] ?? 0);
          const dy = Number(args[2] ?? 0);
          const viz = objectList.getaProp("Room_visualizer", (left: LingoValue, right: LingoValue) => left === right);
          if (viz instanceof ScriptInstance) {
            viz.props.set("plocx", Number(viz.props.get("plocx") ?? 0) + dx);
            viz.props.set("plocy", Number(viz.props.get("plocy") ?? 0) + dy);
            for (const v of (viz.props.get("pspritelist") as LingoList).items) {
              if (v instanceof SpriteChannel) { v.locH += dx; v.locV += dy; }
            }
            moveWrapperParts(viz, dx, dy);
          }
          return LINGO_VOID;
        },
      }),
    );
    roomInterface.props.set("pwidescreenoffset", 32);
    return { visualizer, interface: roomInterface, walls: [wallLeftSprite, wallRightSprite], floor: floorSprite };
  }

  // First room
  let { visualizer, interface: iface, walls: walls1, floor: floor1 } = buildRoom();
  objectList.setaProp(symbol("room_interface"), iface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);

  // Resize to 2K monitor
  engine.setViewport(2560, 1440);
  const offset = Math.round((2560 - 960) / 2); // 800
  const offsetY = Math.round((1440 - 540) / 2); // 450

  // After resize: room centered, wrappers corrected
  expect(visualizer.props.get("plocx")).toBe(800);
  expect(walls1[0]!.locH).toBe(832); // 32 + 800
  expect(walls1[1]!.locH).toBe(1280); // 480 + 800
  expect(floor1.locH).toBe(800); // 0 + 800

  // Simulate room rejoin: source rebuilds visualizer at original positions
  objectList.deleteProp(symbol("room_interface"), (a: LingoValue, b: LingoValue) => a === b);
  objectList.deleteProp("Room_visualizer", (a: LingoValue, b: LingoValue) => a === b);
  const { visualizer: viz2, interface: iface2, walls: walls2, floor: floor2 } = buildRoom();
  objectList.setaProp(symbol("room_interface"), iface2, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", viz2, lingoKeyEquals);

  // Source resets wrapper sprites (simulating updateSprite)
  const wl = walls2[0]!;
  const wr = walls2[1]!;
  wl.locH = 32;
  wr.locH = 480;
  floor2.locH = 0;

  // Apply should re-correct wrappers based on current viewport
  engine.apply("post-rejoin-refresh");

  // Wrappers should be at the CORRECT positions for 2560x1440
  expect(wl.locH).toBe(832); // 32 + 800 — left wall
  expect(wr.locH).toBe(1280); // 480 + 800 — right wall
  expect(floor2.locH).toBe(800); // 0 + 800 — floor

  // Resize to a different size
  engine.setViewport(1920, 1080);
  const offset2 = Math.round((1920 - 960) / 2); // 480
  const offsetY2 = Math.round((1080 - 540) / 2); // 270

  // Source resets again
  const wl2 = walls2[0]!;
  const wr2 = walls2[1]!;
  wl2.locH = 32;
  wr2.locH = 480;
  floor2.locH = 0;
  engine.apply("second-resize-refresh");

  // Should be at new positions
  expect(wl2.locH).toBe(512); // 32 + 480
  expect(wr2.locH).toBe(960); // 480 + 480
  expect(floor2.locH).toBe(480); // 0 + 480
});

it("centers high-z stage presentation visualizers, windows, and free sprites", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const towerSprite = new SpriteChannel(20);
  towerSprite.locH = 0;
  towerSprite.locV = 0;
  towerSprite.locZ = 19_000_000;
  const poolTower = visualizerInstance(0, 0, 19_000_000, [towerSprite]);
  poolTower.props.set("playout", "pool_tower.room");
  objectList.setaProp(symbol("pooltower"), poolTower, lingoKeyEquals);

  const helpButtonSprite = new SpriteChannel(21);
  helpButtonSprite.locH = 20;
  helpButtonSprite.locV = 20;
  helpButtonSprite.locZ = 19_000_040;
  const helpWindow = windowInstance(20, 20, 120, 120);
  helpWindow.props.set("plocz", 19_000_040);
  helpWindow.props.set("pspritelist", new LingoList([helpButtonSprite]));
  objectList.setaProp("pool_helpbuttons", helpWindow, lingoKeyEquals);

  const normalWindow = windowInstance(100, 100, 200, 120);
  normalWindow.props.set("plocz", 30);
  objectList.setaProp("navigator", normalWindow, lingoKeyEquals);

  const jumperSprite = new SpriteChannel(22);
  jumperSprite.locH = 545;
  jumperSprite.locV = 99;
  jumperSprite.locZ = 20_000_000;
  const jumper = new ScriptInstance(moduleFor("Jumping Pelle Class", ["pSpr", "pMyLoc"]));
  jumper.props.set("pspr", jumperSprite);
  jumper.props.set("pmyloc", new LingoPoint(545, 99));
  objectList.setaProp(symbol("jumpingpelle_obj"), jumper, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(poolTower.props.get("plocx")).toBe(offsetX);
  expect(poolTower.props.get("plocy")).toBe(offsetY);
  expect(towerSprite.locH).toBe(offsetX);
  expect(towerSprite.locV).toBe(offsetY);
  expect(helpWindow.props.get("plocx")).toBe(20 + offsetX);
  expect(helpWindow.props.get("plocy")).toBe(20 + offsetY);
  expect(helpButtonSprite.locH).toBe(20 + offsetX);
  expect(helpButtonSprite.locV).toBe(20 + offsetY);
  expect(normalWindow.props.get("plocx")).toBe(100);
  expect(normalWindow.props.get("plocy")).toBe(100);
  expect(jumperSprite.locH).toBe(545 + offsetX);
  expect(jumperSprite.locV).toBe(99 + offsetY);

  // The source script writes the jumper's native-stage location again every frame.
  // The resize pass must reapply the presentation offset without accumulating drift.
  jumperSprite.locH = 552;
  jumperSprite.locV = 104;
  jumperSprite.locZ = 20;
  jumper.props.set("pmyloc", new LingoPoint(552, 104));
  engine.apply("source-reset");
  expect(jumperSprite.locH).toBe(552 + offsetX);
  expect(jumperSprite.locV).toBe(104 + offsetY);

  engine.apply("second-frame");
  expect(jumperSprite.locH).toBe(552 + offsetX);
  expect(jumperSprite.locV).toBe(104 + offsetY);

  // The pool camera/replay branch keeps pMyLoc as logic/crop state but pins the
  // rendered sprite to a separate native stage point. The rendered sprite loc
  // must win, otherwise the avatar detaches from the visualizer scene.
  jumperSprite.locH = 660;
  jumperSprite.locV = 72;
  jumperSprite.locZ = 20;
  jumper.props.set("pmyloc", new LingoPoint(545, 99));
  engine.apply("source-pinned-rendered-loc");
  expect(jumperSprite.locH).toBe(660 + offsetX);
  expect(jumperSprite.locV).toBe(72 + offsetY);

  engine.apply("pinned-rendered-loc-second-frame");
  expect(jumperSprite.locH).toBe(660 + offsetX);
  expect(jumperSprite.locV).toBe(72 + offsetY);
});

it("does not double-offset room sprites borrowed by camera or manager objects", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);
  const avatar = new SpriteChannel(23);
  avatar.locH = 100;
  avatar.locV = 120;
  avatar.locZ = 20_000_000;
  const avatarShadow = new SpriteChannel(24);
  avatarShadow.locH = 100;
  avatarShadow.locV = 120;
  avatarShadow.locZ = 19_999_997;
  const furni = new SpriteChannel(25);
  furni.locH = 300;
  furni.locV = 220;
  furni.locZ = 20_000_010;
  const furniShadow = new SpriteChannel(26);
  furniShadow.locH = 300;
  furniShadow.locV = 220;
  furniShadow.locZ = 19_999_990;
  const user = objectWithSprites("Human Class EX", [avatar, avatarShadow]);
  const activeObject = objectWithSprites("Active Object Class", [furni, furniShadow]);
  const component = roomComponent({
    users: new LingoList([user]),
    active: new LingoList([activeObject]),
    items: new LingoList(),
    passive: new LingoList(),
  });
  objectList.setaProp(symbol("room_component"), component, lingoKeyEquals);

  const visualizer = visualizerInstance(0, 0, -20_099_999);
  const roomInterface = new ScriptInstance(
    moduleFor("Room Interface Class", ["pWideScreenOffset"], {
      moveroomby(ctx, me, args) {
        const dx = Number(args[1] ?? 0);
        const dy = Number(args[2] ?? 0);
        ctx.callMethod(visualizer, "moveby", [dx, dy]);
        for (const sprite of [avatar, avatarShadow, furni, furniShadow]) {
          sprite.locH += dx;
          sprite.locV += dy;
        }
        return LINGO_VOID;
      },
    }),
  );
  roomInterface.props.set("pwidescreenoffset", 0);
  objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);

  // FUSE screen Class stores the selected user's primary sprite in pTargetSpr.
  // Shadow managers and other room systems likewise retain non-owning refs.
  const camera = new ScriptInstance(moduleFor("FUSE screen Class", ["pTargetSpr"]));
  camera.props.set("ptargetspr", avatar);
  objectList.setaProp("dew_camera", camera, lingoKeyEquals);
  const manager = new ScriptInstance(moduleFor("Room Object Manager", ["pObservedShadow"]));
  manager.props.set("pobservedshadow", furniShadow);
  objectList.setaProp("room_object_manager", manager, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  const snapshot = engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(avatar.locH).toBe(100 + offsetX);
  expect(avatar.locV).toBe(120 + offsetY);
  expect(avatarShadow.locH).toBe(100 + offsetX);
  expect(avatarShadow.locV).toBe(120 + offsetY);
  expect(furni.locH).toBe(300 + offsetX);
  expect(furni.locV).toBe(220 + offsetY);
  expect(furniShadow.locH).toBe(300 + offsetX);
  expect(furniShadow.locV).toBe(220 + offsetY);
  expect(snapshot.anchors.some((anchor) => anchor.id.includes("ptargetspr"))).toBe(false);
  expect(snapshot.anchors.some((anchor) => anchor.id.includes("pobservedshadow"))).toBe(false);
});

it("anchors Source-owned stage sprites stored inside pSpriteProps lists", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const cloudSprite = new SpriteChannel(30);
  cloudSprite.locH = 447;
  cloudSprite.locV = 79;
  cloudSprite.locZ = -20_099_999;
  const fallingPetalSprite = new SpriteChannel(31);
  fallingPetalSprite.locH = 260;
  fallingPetalSprite.locV = 120;
  fallingPetalSprite.locZ = -20_099_998;
  const wrapCloudSprite = new SpriteChannel(32);
  wrapCloudSprite.locH = -960;
  wrapCloudSprite.locV = 79;
  wrapCloudSprite.locZ = 20;
  const roomProgram = new ScriptInstance(moduleFor("CloudMountain Room Engine Class", ["pSpriteProps"]));
  roomProgram.props.set(
    "pspriteprops",
    new LingoList([
      LingoPropList.fromPairs([
        [symbol("sprite"), cloudSprite],
        [symbol("motionEnabled"), 1],
        [symbol("speedH"), 1],
      ]),
      LingoPropList.fromPairs([
        [symbol("sprite"), fallingPetalSprite],
        [symbol("locH"), 260],
        [symbol("locV"), 120],
        [symbol("baseLocH"), 250],
        [symbol("baseLocV"), 100],
      ]),
      LingoPropList.fromPairs([
        [symbol("sprite"), wrapCloudSprite],
        [symbol("motionEnabled"), 1],
        [symbol("speedH"), 1],
      ]),
    ]),
  );
  objectList.setaProp("Room Program", roomProgram, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(cloudSprite.locH).toBe(447 + offsetX);
  expect(cloudSprite.locV).toBe(79 + offsetY);
  expect(fallingPetalSprite.locH).toBe(260 + offsetX);
  expect(fallingPetalSprite.locV).toBe(120 + offsetY);
  expect(wrapCloudSprite.locH).toBe(-960 + offsetX);
  expect(wrapCloudSprite.locV).toBe(79 + offsetY);

  // The generated Horizon room engines rewrite these sprite locs every update tick.
  // The resize layer must rediscover the authored point from the Source container
  // without accumulating the prior presentation offset.
  cloudSprite.locH = 452;
  cloudSprite.locV = 79;
  fallingPetalSprite.locH = 270;
  fallingPetalSprite.locV = 140;
  wrapCloudSprite.locH = -955;
  wrapCloudSprite.locV = 79;
  const config = (roomProgram.props.get("pspriteprops") as LingoList).items[1] as LingoPropList;
  config.setaProp(symbol("locH"), 270, lingoKeyEquals);
  config.setaProp(symbol("locV"), 140, lingoKeyEquals);

  const snapshot = engine.apply("source-sprite-props-reset");

  expect(snapshot.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "room program.pspriteprops[1]", action: "free-stage-sprite-follow" }),
      expect.objectContaining({ id: "room program.pspriteprops[2]", action: "free-stage-sprite-follow" }),
      expect.objectContaining({ id: "room program.pspriteprops[3]", action: "free-stage-sprite-follow" }),
    ]),
  );
  expect(cloudSprite.locH).toBe(452 + offsetX);
  expect(cloudSprite.locV).toBe(79 + offsetY);
  expect(fallingPetalSprite.locH).toBe(270 + offsetX);
  expect(fallingPetalSprite.locV).toBe(140 + offsetY);
  expect(wrapCloudSprite.locH).toBe(-955 + offsetX);
  expect(wrapCloudSprite.locV).toBe(79 + offsetY);
});

it("applies resize-only room centering residuals when Source moveroomby drag clamp refuses wide room movement", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const stageSprite = new SpriteChannel(40);
  stageSprite.locH = -960;
  stageSprite.locV = 0;
  const wallSprite = new SpriteChannel(41);
  wallSprite.locH = -960;
  wallSprite.locV = 0;
  const visualizer = visualizerInstance(-960, 0, -20_099_999, [stageSprite, wallSprite]);
  visualizer.props.set("pwidth", 1940);
  visualizer.props.set("pheight", 585);
  visualizer.props.set(
    "pwrappedparts",
    LingoPropList.fromPairs([
      ["wall", wrapper("wallleft", wallSprite, -960, 0, [{ locH: 40, locV: 50 }])],
    ]),
  );

  const geometry = new ScriptInstance(moduleFor("Room Geometry Class", ["pXOffset", "pYOffset"]));
  geometry.props.set("pxoffset", 0);
  geometry.props.set("pyoffset", 0);

  const userSprite = new SpriteChannel(42);
  userSprite.locH = 100;
  userSprite.locV = 120;
  const user = objectWithSprites("Human Class EX", [userSprite], {
    pscreenloc: new LingoList([100, 120, 0]),
    pstartlscreen: new LingoList([100, 120, 0]),
    pdestlscreen: new LingoList([100, 120, 0]),
    ppreviousloc: new LingoList([100, 120, 0]),
  });

  const activeSprite = new SpriteChannel(43);
  activeSprite.locH = 300;
  activeSprite.locV = 200;
  const activeObject = objectWithSprites("Active Object Class", [activeSprite]);

  const component = roomComponent({
    users: new LingoList([user]),
    active: new LingoList([activeObject]),
    items: new LingoList(),
    passive: new LingoList(),
  });

  const roomInterface = new ScriptInstance(
    moduleFor("Room Interface Class", ["pWideScreenOffset"], {
      getroomvisualizer() {
        return visualizer;
      },
      getgeometry() {
        return geometry;
      },
      getcomponent() {
        return component;
      },
      moveroomby(ctx, me, args) {
        let dx = Number(args[1] ?? 0);
        let dy = Number(args[2] ?? 0);
        const locX = Number(visualizer.props.get("plocx") ?? 0);
        if (locX + dx < -81) dx = 0;
        if (locX + dy < -60) dy = 0;
        ctx.callMethod(visualizer, "moveby", [dx, dy]);
        geometry.props.set("pxoffset", Number(geometry.props.get("pxoffset") ?? 0) + dx);
        geometry.props.set("pyoffset", Number(geometry.props.get("pyoffset") ?? 0) + dy);
        return LINGO_VOID;
      },
    }),
  );
  roomInterface.props.set("pwidescreenoffset", 32);
  objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  const snapshot = engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(snapshot.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "Room_stage", action: "resize-residual-move", x: offsetX, y: offsetY }),
    ]),
  );
  expect(visualizer.props.get("plocx")).toBe(-960 + offsetX);
  expect(visualizer.props.get("plocy")).toBe(offsetY);
  expect(stageSprite.locH).toBe(-960 + offsetX);
  expect(stageSprite.locV).toBe(offsetY);
  expect(geometry.props.get("pxoffset")).toBe(offsetX);
  expect(geometry.props.get("pyoffset")).toBe(offsetY);
  expect(userSprite.locH).toBe(100 + offsetX);
  expect(userSprite.locV).toBe(120 + offsetY);
  expect(activeSprite.locH).toBe(300 + offsetX);
  expect(activeSprite.locV).toBe(200 + offsetY);
  expect((user.props.get("pscreenloc") as LingoList).items).toEqual([100 + offsetX, 120 + offsetY, 0]);
  const wallPart = ((visualizer.props.get("pwrappedparts") as LingoPropList).values[0] as ScriptInstance).props.get("ppartlist") as LingoList;
  const firstPart = wallPart.items[0] as LingoPropList;
  expect(firstPart.getaProp(symbol("locH"), lingoKeyEquals)).toBe(40 + offsetX);
  expect(firstPart.getaProp(symbol("locV"), lingoKeyEquals)).toBe(50 + offsetY);
});

it("keeps manual room drag moving when Source moveroomby clamps wide authored rooms", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const stageSprite = new SpriteChannel(44);
  stageSprite.locH = -960;
  stageSprite.locV = 0;
  const wallSprite = new SpriteChannel(45);
  wallSprite.locH = -960;
  wallSprite.locV = 0;
  const visualizer = visualizerInstance(-960, 0, -20_099_999, [stageSprite, wallSprite]);
  visualizer.props.set("pwidth", 1940);
  visualizer.props.set("pheight", 585);
  visualizer.props.set(
    "pwrappedparts",
    LingoPropList.fromPairs([
      ["wall", wrapper("wallleft", wallSprite, -960, 0, [{ locH: 40, locV: 50 }])],
    ]),
  );

  const geometry = new ScriptInstance(moduleFor("Room Geometry Class", ["pXOffset", "pYOffset"]));
  geometry.props.set("pxoffset", 0);
  geometry.props.set("pyoffset", 0);

  const userSprite = new SpriteChannel(46);
  userSprite.locH = 100;
  userSprite.locV = 120;
  const user = objectWithSprites("Human Class EX", [userSprite], {
    pscreenloc: new LingoList([100, 120, 0]),
    pstartlscreen: new LingoList([100, 120, 0]),
    pdestlscreen: new LingoList([100, 120, 0]),
    ppreviousloc: new LingoList([100, 120, 0]),
  });

  const activeSprite = new SpriteChannel(47);
  activeSprite.locH = 300;
  activeSprite.locV = 200;
  const activeObject = objectWithSprites("Active Object Class", [activeSprite]);

  const component = roomComponent({
    users: new LingoList([user]),
    active: new LingoList([activeObject]),
    items: new LingoList(),
    passive: new LingoList(),
  });

  const roomInterface = new ScriptInstance(
    moduleFor("Room Interface Class", ["pWideScreenOffset"], {
      getroomvisualizer() {
        return visualizer;
      },
      getgeometry() {
        return geometry;
      },
      getcomponent() {
        return component;
      },
      moveroomby(ctx, me, args) {
        let dx = Number(args[1] ?? 0);
        let dy = Number(args[2] ?? 0);
        const locX = Number(visualizer.props.get("plocx") ?? 0);
        if (locX + dx < -81) dx = 0;
        if (locX + dy < -60) dy = 0;
        ctx.callMethod(visualizer, "moveby", [dx, dy]);
        geometry.props.set("pxoffset", Number(geometry.props.get("pxoffset") ?? 0) + dx);
        geometry.props.set("pyoffset", Number(geometry.props.get("pyoffset") ?? 0) + dy);
        return LINGO_VOID;
      },
    }),
  );
  roomInterface.props.set("pwidescreenoffset", 32);
  objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  const snapshot = engine.dragRoomBy(50, 25);

  expect(snapshot.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "Room_stage", action: "resize-residual-move", x: 50, y: 25 }),
    ]),
  );
  expect(visualizer.props.get("plocx")).toBe(-960 + offsetX + 50);
  expect(visualizer.props.get("plocy")).toBe(offsetY + 25);
  expect(stageSprite.locH).toBe(-960 + offsetX + 50);
  expect(stageSprite.locV).toBe(offsetY + 25);
  expect(geometry.props.get("pxoffset")).toBe(offsetX + 50);
  expect(geometry.props.get("pyoffset")).toBe(offsetY + 25);
  expect(userSprite.locH).toBe(100 + offsetX + 50);
  expect(userSprite.locV).toBe(120 + offsetY + 25);
  expect(activeSprite.locH).toBe(300 + offsetX + 50);
  expect(activeSprite.locV).toBe(200 + offsetY + 25);
  expect((user.props.get("pscreenloc") as LingoList).items).toEqual([100 + offsetX + 50, 120 + offsetY + 25, 0]);
  const wallPart = ((visualizer.props.get("pwrappedparts") as LingoPropList).values[0] as ScriptInstance).props.get("ppartlist") as LingoList;
  const firstPart = wallPart.items[0] as LingoPropList;
  expect(firstPart.getaProp(symbol("locH"), lingoKeyEquals)).toBe(40 + offsetX + 50);
  expect(firstPart.getaProp(symbol("locV"), lingoKeyEquals)).toBe(50 + offsetY + 25);
});

it("lets Source pSpriteProps ownership override room visualizer channel ownership", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const ordinaryVisualizerSprite = movie.channels[29]!;
  ordinaryVisualizerSprite.locH = 50;
  ordinaryVisualizerSprite.locV = 60;
  ordinaryVisualizerSprite.locZ = -20_099_999;

  const horizonSprite = movie.channels[30]!;
  horizonSprite.locH = 447;
  horizonSprite.locV = 79;
  horizonSprite.locZ = -20_099_998;

  const roomVisualizer = visualizerInstance(0, 0, -20_099_999, [ordinaryVisualizerSprite, horizonSprite]);
  objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

  const roomProgram = new ScriptInstance(moduleFor("CloudMountain Room Engine Class", ["pSpriteProps"]));
  roomProgram.props.set(
    "pspriteprops",
    new LingoList([
      LingoPropList.fromPairs([
        [symbol("sprite"), horizonSprite],
        [symbol("motionEnabled"), 1],
        [symbol("speedH"), 1],
      ]),
    ]),
  );
  objectList.setaProp("Room Program", roomProgram, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(ordinaryVisualizerSprite.locH).toBe(50);
  expect(ordinaryVisualizerSprite.locV).toBe(60);
  expect(horizonSprite.locH).toBe(447 + offsetX);
  expect(horizonSprite.locV).toBe(79 + offsetY);

  // Horizon room programs mutate the visualizer channel directly on every tick.
  // Even though the sprite is in Room_visualizer.pSpriteList, pSpriteProps is
  // the Source-owned presentation container and must be re-anchored.
  horizonSprite.locH = 452;
  horizonSprite.locV = 79;
  const snapshot = engine.apply("source-managed-pspriteprops-reset");

  expect(snapshot.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "room program.pspriteprops[1]", action: "free-stage-sprite-follow" }),
    ]),
  );
  expect(ordinaryVisualizerSprite.locH).toBe(50);
  expect(ordinaryVisualizerSprite.locV).toBe(60);
  expect(horizonSprite.locH).toBe(452 + offsetX);
  expect(horizonSprite.locV).toBe(79 + offsetY);
});

it("anchors unowned high-depth stage channels while leaving managed sprites alone", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const managedSprite = movie.channels[29]!;
  managedSprite.locH = 50;
  managedSprite.locV = 60;
  managedSprite.locZ = -20_099_999;
  const roomVisualizer = visualizerInstance(0, 0, -20_099_999, [managedSprite]);
  objectList.setaProp("Room_visualizer", roomVisualizer, lingoKeyEquals);

  const cloudSprite = movie.channels[30]!;
  cloudSprite.locH = 447;
  cloudSprite.locV = 79;
  cloudSprite.locZ = -20_099_998;

  const lowDepthSprite = movie.channels[31]!;
  lowDepthSprite.locH = 120;
  lowDepthSprite.locV = 140;
  lowDepthSprite.locZ = 20;

  const nestedObjectSprite = movie.channels[32]!;
  nestedObjectSprite.locH = 210;
  nestedObjectSprite.locV = 180;
  nestedObjectSprite.locZ = -20_099_997;
  const roomObject = new ScriptInstance(moduleFor("Room Object Class", ["pPartList"]));
  roomObject.props.set(
    "ppartlist",
    new LingoList([
      LingoPropList.fromPairs([
        [symbol("sprite"), nestedObjectSprite],
        [symbol("locH"), 210],
        [symbol("locV"), 180],
      ]),
    ]),
  );
  objectList.setaProp("room-object", roomObject, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  const snapshot = engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(snapshot.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "channel:30", action: "free-stage-channel-follow" }),
    ]),
  );
  expect(managedSprite.locH).toBe(50);
  expect(managedSprite.locV).toBe(60);
  expect(cloudSprite.locH).toBe(447 + offsetX);
  expect(cloudSprite.locV).toBe(79 + offsetY);
  expect(lowDepthSprite.locH).toBe(120);
  expect(lowDepthSprite.locV).toBe(140);
  expect(nestedObjectSprite.locH).toBe(210);
  expect(nestedObjectSprite.locV).toBe(180);

  // Some room-program scripts write raw channel locs directly every frame without
  // storing the sprite in a discoverable Source object container. The resize layer
  // must treat that authored channel point like Director presentation state, without
  // accumulating its previous offset.
  cloudSprite.locH = 452;
  cloudSprite.locV = 79;
  engine.apply("source-channel-reset");
  expect(cloudSprite.locH).toBe(452 + offsetX);
  expect(cloudSprite.locV).toBe(79 + offsetY);

  cloudSprite.locH += 5;
  engine.apply("source-channel-already-offset");
  expect(cloudSprite.locH).toBe(457 + offsetX);
  expect(cloudSprite.locV).toBe(79 + offsetY);

  engine.setViewport(960, 540);
  expect(cloudSprite.locH).toBe(457);
  expect(cloudSprite.locV).toBe(79);
});

it("keeps presentation-owned free sprites anchored after source removes the visualizer", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const towerSprite = new SpriteChannel(120);
  towerSprite.locH = 0;
  towerSprite.locV = 0;
  towerSprite.locZ = 19_000_000;
  const poolTower = visualizerInstance(0, 0, 19_000_000, [towerSprite]);
  poolTower.props.set("playout", "pool_tower.room");
  objectList.setaProp(symbol("pooltower"), poolTower, lingoKeyEquals);

  const jumperSprite = new SpriteChannel(121);
  jumperSprite.locH = 545;
  jumperSprite.locV = 99;
  jumperSprite.locZ = 20_000_000;
  const jumper = new ScriptInstance(moduleFor("Jumping Pelle Class", ["pSpr", "pMyLoc"]));
  jumper.props.set("pspr", jumperSprite);
  jumper.props.set("pmyloc", new LingoPoint(545, 99));
  objectList.setaProp(symbol("jumpingpelle_obj"), jumper, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(jumperSprite.locH).toBe(545 + offsetX);
  expect(jumperSprite.locV).toBe(99 + offsetY);

  // The diving source removes the high-z pool tower visualizer while the jumper object
  // continues to run and writes native mini-game coordinates every frame. The resize
  // layer must preserve the already-discovered presentation delta until the free sprite
  // itself is removed, otherwise the body snaps back to the top-left native scene while
  // the resized presentation remains centered.
  objectList.deleteProp(symbol("pooltower"), lingoKeyEquals);
  jumperSprite.locH = 552;
  jumperSprite.locV = 104;
  jumperSprite.locZ = 20;
  jumper.props.set("pmyloc", new LingoPoint(552, 104));

  engine.apply("pooltower-removed-source-reset");

  expect(jumperSprite.locH).toBe(552 + offsetX);
  expect(jumperSprite.locV).toBe(104 + offsetY);

  jumperSprite.locH = 558;
  jumperSprite.locV = -20;
  jumper.props.set("pmyloc", new LingoPoint(558, -20));
  engine.apply("pooltower-removed-screen-down");

  expect(jumperSprite.locH).toBe(558 + offsetX);
  expect(jumperSprite.locV).toBe(-20 + offsetY);
});

it("anchors free presentation sprites stored on an object ancestor", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);

  const towerSprite = new SpriteChannel(220);
  towerSprite.locH = 0;
  towerSprite.locV = 0;
  towerSprite.locZ = 19_000_000;
  const poolTower = visualizerInstance(0, 0, 19_000_000, [towerSprite]);
  poolTower.props.set("playout", "pool_tower.room");
  objectList.setaProp(symbol("pooltower"), poolTower, lingoKeyEquals);

  const jumperSprite = new SpriteChannel(221);
  jumperSprite.locH = 545;
  jumperSprite.locV = 99;
  jumperSprite.locZ = 20;
  const jumperBase = new ScriptInstance(moduleFor("Jumping Pelle Class", ["pSpr", "pMyLoc"]));
  jumperBase.props.set("pspr", jumperSprite);
  jumperBase.props.set("pmyloc", new LingoPoint(545, 99));
  const jumperController = new ScriptInstance(moduleFor("Pelle KeyDown Class"));
  jumperController.props.set("ancestor", jumperBase);
  objectList.setaProp(symbol("jumpingpelle_obj"), jumperController, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);
  const offsetX = Math.round((1500 - 960) / 2);
  const offsetY = Math.round((760 - 540) / 2);

  expect(jumperSprite.locH).toBe(545 + offsetX);
  expect(jumperSprite.locV).toBe(99 + offsetY);

  // Runtime object-manager entries point at the child object, but the Lingo source
  // writes pSpr/pMyLoc on its Jumping Pelle ancestor every frame.
  jumperSprite.locH = 558;
  jumperSprite.locV = -20;
  jumperBase.props.set("pmyloc", new LingoPoint(558, -20));
  engine.apply("ancestor-source-reset");

  expect(jumperSprite.locH).toBe(558 + offsetX);
  expect(jumperSprite.locV).toBe(-20 + offsetY);
});

it("does not move low-z free stage-point sprites without an active stage presentation", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);
  const sprite = new SpriteChannel(23);
  sprite.locH = 120;
  sprite.locV = 140;
  sprite.locZ = 20;
  const owner = new ScriptInstance(moduleFor("Stage Point Test Class", ["pSprite", "pLoc"]));
  owner.props.set("psprite", sprite);
  owner.props.set("ploc", new LingoPoint(120, 140));
  objectList.setaProp("stage-point-test", owner, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);

  expect(sprite.locH).toBe(120);
  expect(sprite.locV).toBe(140);
});

it("composes private-room landscapes in logical coordinates before presentation offset", () => {
  const movie = createMovie();
  const objectList = installObjectManager(movie);
  const maskEntry = LingoPropList.fromPairs([
    [symbol("class"), "window_double_default"],
    [symbol("dir"), "rightwall"],
    [symbol("size"), 64],
    [symbol("loc"), new LingoPoint(356, 142)],
  ]);
  const maskList = LingoPropList.fromPairs([["window-1", maskEntry]]);
  const wallMaskManager = new ScriptInstance(moduleFor("Wall Mask Manager", ["pMaskList", "pRequiresUpdate"]));
  wallMaskManager.props.set("pmasklist", maskList);
  wallMaskManager.props.set("prequiresupdate", 0);

  const background = new ScriptInstance(moduleFor("Landscape Test Image"));
  const backgroundManager = new ScriptInstance(moduleFor("Landscape Background Manager", ["pImage"]));
  backgroundManager.props.set("pimage", background);

  const composedLocations: Array<Array<[number, number]>> = [];
  const landscapeManager = new ScriptInstance(
    moduleFor("Landscape Manager", [], {
      updatelandscape() {
        composedLocations.push(
          maskList.values.map((value) => {
            const loc = (value as LingoPropList).getaProp(symbol("loc"), lingoKeyEquals) as LingoPoint;
            return [loc.x, loc.y];
          }),
        );
        return 1;
      },
    }),
  );

  const landscapeSprite = new SpriteChannel(224);
  landscapeSprite.member = new CastMember("hh_room_private", 1, 1, "room_landscape", "bitmap", {
    bitmap: { width: 960, height: 400, regX: 0, regY: 0, pngUrl: null },
  });
  const cloudSprite = new SpriteChannel(225);
  cloudSprite.locZ = 20_000_001;
  const animationManager = new ScriptInstance(moduleFor("Landscape Animation Manager", ["pSprite"]));
  animationManager.props.set("psprite", cloudSprite);
  const visualizer = new ScriptInstance(
    moduleFor(
      "Visualizer Instance Class",
      ["pLocX", "pLocY", "pLayout", "pSpriteList", "pWrappedParts"],
      {
        getsprbyid() {
          return landscapeSprite;
        },
      },
    ),
  );
  visualizer.props.set("plocx", 0);
  visualizer.props.set("plocy", 0);
  visualizer.props.set("playout", "model_g.room");
  visualizer.props.set("pspritelist", new LingoList([landscapeSprite]));
  visualizer.props.set("pwrappedparts", new LingoPropList());

  const roomInterface = new ScriptInstance(
    moduleFor("Room Interface Class", ["pWideScreenOffset"], {
      moveroomby(ctx, me, args) {
        const dx = Number(args[1] ?? 0);
        const dy = Number(args[2] ?? 0);
        visualizer.props.set("plocx", Number(visualizer.props.get("plocx") ?? 0) + dx);
        visualizer.props.set("plocy", Number(visualizer.props.get("plocy") ?? 0) + dy);
        for (const value of maskList.values) {
          const item = value as LingoPropList;
          const loc = item.getaProp(symbol("loc"), lingoKeyEquals) as LingoPoint;
          item.setaProp(symbol("loc"), new LingoPoint(loc.x + dx, loc.y + dy), lingoKeyEquals);
        }
        return LINGO_VOID;
      },
    }),
  );
  roomInterface.props.set("pwidescreenoffset", 32);

  objectList.setaProp(symbol("room_interface"), roomInterface, lingoKeyEquals);
  objectList.setaProp("Room_visualizer", visualizer, lingoKeyEquals);
  objectList.setaProp("landscape_manager", landscapeManager, lingoKeyEquals);
  objectList.setaProp("landscape_background_manager", backgroundManager, lingoKeyEquals);
  objectList.setaProp("landscape_animation_manager", animationManager, lingoKeyEquals);
  objectList.setaProp("wall_mask_manager", wallMaskManager, lingoKeyEquals);

  const engine = new OriginsResizeEngine(movie);
  engine.setViewport(1500, 760);

  expect(composedLocations).toEqual([[[356, 142]]]);
  expect(maskEntry.getaProp(symbol("loc"), lingoKeyEquals)).toMatchObject({ x: 626, y: 252 });
  expect(landscapeSprite.locH).toBe(270);
  expect(landscapeSprite.locV).toBe(110);
  expect(cloudSprite.locH).toBe(270);
  expect(cloudSprite.locV).toBe(110);

  engine.dragRoomBy(40, 20);

  expect(composedLocations).toHaveLength(1);
  expect(landscapeSprite.locH).toBe(310);
  expect(landscapeSprite.locV).toBe(130);
  expect(cloudSprite.locH).toBe(310);
  expect(cloudSprite.locV).toBe(130);

  const secondMaskEntry = LingoPropList.fromPairs([
    [symbol("class"), "window_default"],
    [symbol("dir"), "leftwall"],
    [symbol("size"), 32],
    [symbol("loc"), new LingoPoint(810, 290)],
  ]);
  maskList.setaProp("window-2", secondMaskEntry, lingoKeyEquals);
  engine.apply("late-window-mask");

  expect(composedLocations.at(-1)).toEqual([
    [356, 142],
    [500, 160],
  ]);
  expect(secondMaskEntry.getaProp(symbol("loc"), lingoKeyEquals)).toMatchObject({ x: 810, y: 290 });
});
