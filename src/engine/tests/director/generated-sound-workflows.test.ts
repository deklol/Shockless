import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ManualDirectorAudioClock } from "../../src/director/audio/clock";
import { VirtualAudioBackend } from "../../src/director/audio/VirtualAudioBackend";
import { CastRegistry } from "../../src/director/members";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import * as ops from "../../src/director/ops";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import {
  LINGO_VOID,
  LingoList,
  LingoPropList,
  LingoSymbol,
  type LingoValue,
  symbol,
} from "../../src/director/values";

const channelModuleId =
  "../../generated/profiles/release320/scripts/hh_shared/External/ParentScript_53_-_Sound_Channel_Class";
const apiModuleId =
  "../../generated/profiles/release320/scripts/hh_shared/External/MovieScript_52_-_Sound_API";
const objectBaseModuleId =
  "../../generated/profiles/release320/scripts/fuse_client/External/ParentScript_46_-_Object_Base_Class";
const instanceModuleId =
  "../../generated/profiles/release320/scripts/hh_shared/External/ParentScript_54_-_Sound_Instance_Class";
const managerModuleId =
  "../../generated/profiles/release320/scripts/hh_shared/External/ParentScript_55_-_Sound_Manager_Class";
const songPlayerModuleId =
  "../../generated/profiles/release320/scripts/hh_soundmachine/External/ParentScript_12_-_Song_Player_Class";
const generalSongPlayerModuleId =
  "../../generated/profiles/release320/scripts/hh_shared/External/ParentScript_51_-_Song_Player_Class";
const timelineModuleId =
  "../../generated/profiles/release320/scripts/hh_soundmachine/External/ParentScript_8_-_Song_TimeLine_Class";
const controllerModuleId =
  "../../generated/profiles/release320/scripts/hh_soundmachine/External/ParentScript_11_-_Song_Controller_Class";
const jukeboxModuleId =
  "../../generated/profiles/release320/scripts/hh_soundmachine/External/ParentScript_10_-_Jukebox_Manager_Class";
const componentModuleId =
  "../../generated/profiles/release320/scripts/hh_soundmachine/External/ParentScript_4_-_SoundMachine_Component_Class";
const threadInstanceModuleId =
  "../../generated/profiles/release320/scripts/fuse_client/External/ParentScript_71_-_Thread_Instance_Class";
const generatedSoundModulesAvailable = [
  apiModuleId,
  objectBaseModuleId,
  channelModuleId,
  instanceModuleId,
  managerModuleId,
  songPlayerModuleId,
  generalSongPlayerModuleId,
  timelineModuleId,
  controllerModuleId,
  jukeboxModuleId,
  componentModuleId,
  threadInstanceModuleId,
]
  .every((moduleId) => existsSync(new URL(`${moduleId}.ts`, import.meta.url)));

interface GeneratedSoundModules {
  api: GeneratedScriptModule;
  objectBase: GeneratedScriptModule;
  channel: GeneratedScriptModule;
  instance: GeneratedScriptModule;
  manager: GeneratedScriptModule;
  songPlayer: GeneratedScriptModule;
  generalSongPlayer: GeneratedScriptModule;
  timeline: GeneratedScriptModule;
  controller: GeneratedScriptModule;
  jukebox: GeneratedScriptModule;
  component: GeneratedScriptModule;
  threadInstance: GeneratedScriptModule;
}

interface GeneratedSoundHarness {
  movie: DirectorMovie;
  members: CastRegistry;
  clock: ManualDirectorAudioClock;
  modules: GeneratedSoundModules;
  timeoutRequests: Array<{ name: string; period: number; handler: string }>;
  objects: Map<string, ScriptInstance>;
  writers: Set<string>;
}

describe.skipIf(!generatedSoundModulesAvailable)("generated Habbo sound workflows", () => {
  it("runs imported ordinary-sound channel selection, queueing, reservation, and mute logic", async () => {
    const harness = await createHarness();
    const { movie } = harness;
    const manager = movie.runtime.call("getsoundmanager", []) as ScriptInstance;
    expect(movie.runtime.getInstanceProp(manager, "pchannelcount")).toBe(5);
    expect(movie.runtime.getInstanceProp(manager, "pchannellist")).toMatchObject({ items: { length: 5 } });
    expect(
      [1, 2, 3, 4, 5].map((index) =>
        movie.runtime.getInstanceProp(
          movie.runtime.callMethod(manager, "getchannel", [index]) as ScriptInstance,
          "pchannelnum",
        ),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(movie.runtime.call("playsound", ["sample_1", symbol("pass"), LINGO_VOID])).toBe(1);
    expect(movie.soundSnapshot()[0]).toMatchObject({ status: 3, memberName: "sample_1" });
    const channelOneWrapper = movie.runtime.callMethod(manager, "getchannel", [1]) as ScriptInstance;
    expect(
      [1, 2, 3, 4, 5].map((index) =>
        movie.runtime.getInstanceProp(
          movie.runtime.callMethod(manager, "getchannel", [index]) as ScriptInstance,
          "pendtime",
        ),
      ),
    ).toEqual([11_000, 0, 0, 0, 0]);

    for (let channel = 2; channel <= 5; channel += 1) {
      expect(movie.runtime.call("playsoundinchannel", [`sample_${channel}`, channel])).toBe(channel);
      expect(movie.runtime.getInstanceProp(channelOneWrapper, "pendtime")).toBe(11_000);
    }
    expect(movie.runtime.callMethod(movie.runtime.call("sound", [1]), "isbusy", [])).toBe(1);
    expect(movie.runtime.getInstanceProp(channelOneWrapper, "pendtime")).toBe(11_000);
    expect(movie.runtime.callMethod(channelOneWrapper, "gettimeremaining", [])).toBe(1_000);

    expect(movie.runtime.call("playsound", ["sample_6", symbol("cut"), LINGO_VOID])).toBe(1);
    expect(movie.soundSnapshot()[0]).toMatchObject({ status: 3, memberName: "sample_6" });

    expect(movie.runtime.call("playsound", ["sample_7", symbol("queue"), LINGO_VOID])).toBe(1);
    expect(movie.soundSnapshot()[1]).toMatchObject({ memberName: "sample_2", queued: 1 });

    expect(movie.runtime.call("queuesound", ["sample_7", 3, LINGO_VOID])).toBe(LINGO_VOID);
    const channelThree = movie.runtime.callMethod(manager, "getchannel", [3]);
    expect(movie.runtime.callMethod(channelThree, "getisreserved", [])).toBe(1);
    expect(movie.soundSnapshot()[2]!.queued).toBe(1);

    expect(movie.runtime.call("setsoundstate", [0])).toBe(1);
    expect(movie.soundSnapshot().slice(0, 5).map((channel) => channel.volume)).toEqual([0, 0, 0, 0, 0]);
    expect(movie.runtime.call("setsoundstate", [1])).toBe(1);
    expect(movie.soundSnapshot().slice(0, 5).map((channel) => channel.volume)).toEqual([255, 255, 255, 255, 255]);
    expect(movie.runtime.unsupportedSeen).toEqual([]);
  });

  it("runs imported Trax offsets, channel padding, two-round buffering, and synchronized start", async () => {
    const harness = await createHarness();
    const { movie, modules, timeoutRequests } = harness;
    const player = movie.runtime.instantiate(modules.songPlayer, []) as ScriptInstance;
    const identity = movie.runtime.instantiate(identityModule, []) as ScriptInstance;
    movie.runtime.setInstanceProp(player, "ancestor", identity);
    movie.runtime.callMethod(player, "construct", []);

    const songData = LingoPropList.fromPairs([
      [
        symbol("sounds"),
        new LingoList([
          LingoPropList.fromPairs([
            [symbol("name"), "sample_1"],
            [symbol("loops"), 1],
            [symbol("channel"), 1],
          ]),
          LingoPropList.fromPairs([
            [symbol("name"), "trax_short"],
            [symbol("loops"), 1],
            [symbol("channel"), 2],
          ]),
        ]),
      ],
      [symbol("channelList"), new LingoList([1, 2])],
    ]);
    const playlist = movie.runtime.callMethod(player, "createplaylistinstance", [1]) as LingoPropList;
    const song = () =>
      LingoPropList.fromPairs([
        [symbol("length"), 1_000],
        [symbol("id"), 1],
        [symbol("songData"), songData],
      ]);
    playlist.setaProp(
      symbol("songList"),
      new LingoList([song(), song()]),
      ops.lingoKeyEquals,
    );
    playlist.setaProp(symbol("listIndex"), 1, ops.lingoKeyEquals);
    playlist.setaProp(symbol("playOffset"), 250, ops.lingoKeyEquals);
    playlist.setaProp(symbol("loop"), 1, ops.lingoKeyEquals);

    expect(movie.runtime.callMethod(player, "addplayround", [])).toBe(1);
    expect(movie.runtime.callMethod(player, "addplayround", [])).toBe(1);

    const channelOne = movie.runtime.call("sound", [1]);
    const channelTwo = movie.runtime.call("sound", [2]);
    const channelOneQueue = movie.runtime.callMethod(channelOne, "getplaylist", []) as LingoList;
    const channelTwoQueue = movie.runtime.callMethod(channelTwo, "getplaylist", []) as LingoList;
    expect(channelOneQueue.items).toHaveLength(2);
    expect(prop(channelOneQueue.items[0]!, "startTime")).toBe(250);
    expect(channelTwoQueue.items).toHaveLength(8);
    expect(prop(channelTwoQueue.items[3]!, "startTime")).toBe(100);

    movie.runtime.setInstanceProp(player, "psongchannelsinuse", new LingoList([1, 2]));
    expect(movie.runtime.callMethod(player, "startchannels", [])).toBe(LINGO_VOID);
    expect(movie.soundSnapshot()[0]).toMatchObject({ status: 3, memberName: "sample_1", startTime: 250, queued: 1 });
    expect(movie.soundSnapshot()[1]).toMatchObject({
      status: 3,
      memberName: "trax_short",
      startTime: 250,
      queued: 7,
    });
    expect(movie.runtime.callMethod(player, "getplaybufferlength", [])).toBe(1_750);
    expect(timeoutRequests).toContainEqual({
      name: "song player loop update",
      period: 1_500,
      handler: "checkLoopData",
    });
    expect(movie.runtime.unsupportedSeen).toEqual([]);
  });

  it("runs the imported general Song Player queue refill and member-duration path", async () => {
    const { movie, modules, timeoutRequests } = await createHarness();
    const player = movie.runtime.instantiate(modules.generalSongPlayer, []) as ScriptInstance;
    const identity = movie.runtime.instantiate(identityModule, []) as ScriptInstance;
    movie.runtime.setInstanceProp(player, "ancestor", identity);
    movie.runtime.callMethod(player, "construct", []);

    const songData = LingoPropList.fromPairs([
      [symbol("offset"), 250],
      [symbol("sounds"), new LingoList([
        LingoPropList.fromPairs([
          [symbol("name"), "sample_1"],
          [symbol("loops"), 2],
          [symbol("channel"), 7],
        ]),
        LingoPropList.fromPairs([
          [symbol("name"), "trax_short"],
          [symbol("loops"), 1],
          [symbol("channel"), 9],
        ]),
      ])],
    ]);

    expect(movie.runtime.callMethod(player, "startsong", [songData])).toBe(1);
    expect(prop(movie.runtime.getInstanceProp(player, "psongdata"), "channelList")).toMatchObject({ items: [1, 2] });
    expect(timeoutRequests).toContainEqual({
      name: "song queue timeout",
      period: 1_750,
      handler: "delayedSongStart",
    });

    movie.runtime.callMethod(player, "queuechannels", []);
    const channelOne = movie.runtime.call("sound", [1]);
    const channelTwo = movie.runtime.call("sound", [2]);
    const queueOne = movie.runtime.callMethod(channelOne, "getplaylist", []) as LingoList;
    const queueTwo = movie.runtime.callMethod(channelTwo, "getplaylist", []) as LingoList;
    // The source normalizes the 250 ms offset to 2,000 ms. The first play
    // round consumes that offset, while the second queues the audible data.
    expect(queueOne.items).toHaveLength(2);
    expect(queueTwo.items).toHaveLength(1);
    expect(prop(queueOne.items[0]!, "startTime")).toBe(0);

    movie.runtime.callMethod(player, "startchannels", []);
    expect(movie.soundSnapshot()[0]).toMatchObject({ status: 3, memberName: "sample_1", startTime: 0 });
    expect(movie.soundSnapshot()[1]).toMatchObject({ status: 3, memberName: "trax_short" });
    expect(movie.runtime.callMethod(player, "checkloopdata", [])).toBe(1);
    const refilledQueueOne = movie.runtime.callMethod(channelOne, "getplaylist", []) as LingoList;
    const refilledQueueTwo = movie.runtime.callMethod(channelTwo, "getplaylist", []) as LingoList;
    expect(refilledQueueOne.items).toHaveLength(3);
    expect(refilledQueueTwo.items).toHaveLength(1);
    expect(movie.runtime.unsupportedSeen).toEqual([]);
  });

  it("runs imported Timeline sample resolution, loop generation, encoding, and preview", async () => {
    const { movie, modules, objects } = await createHarness();
    const controller = movie.runtime.call("createobject", ["song controller", "Song Controller Class"]);
    expect(controller).toBeInstanceOf(ScriptInstance);
    expect(objects.get("song controller")).toBe(controller);

    const timeline = movie.runtime.instantiate(modules.timeline, []) as ScriptInstance;
    const identity = movie.runtime.instantiate(identityModule, []) as ScriptInstance;
    movie.runtime.setInstanceProp(timeline, "ancestor", identity);
    expect(movie.runtime.callMethod(timeline, "construct", [])).toBe(1);
    movie.runtime.callMethod(timeline, "reset", [0]);
    expect(movie.runtime.callMethod(timeline, "insertsample", [1, 1, 1])).toBe(1);
    expect(movie.runtime.callMethod(timeline, "insertsample", [3, 1, 1])).toBe(1);
    expect(movie.runtime.callMethod(timeline, "resolvesonglength", [])).toBe(4);

    const songData = movie.runtime.callMethod(timeline, "getsongdata", []) as LingoPropList;
    const sounds = prop(songData, "sounds") as LingoList;
    expect(sounds.items).toHaveLength(1);
    expect(prop(sounds.items[0]!, "name")).toBe("sound_machine_sample_1");
    expect(prop(sounds.items[0]!, "loops")).toBe(2);
    expect(prop(sounds.items[0]!, "channel")).toBe(1);
    expect(movie.runtime.callMethod(timeline, "encodetimelinedata", [])).toBe("1:1,4:2:0,4:3:0,4:4:0,4:");

    expect(movie.runtime.callMethod(controller, "startsamplepreview", ["sample_1"])).toBe(1);
    expect(movie.soundSnapshot()[4]).toMatchObject({ status: 3, memberName: "sample_1" });
    expect(movie.runtime.callMethod(controller, "stopsamplepreview", [])).toBe(1);
    expect(movie.soundSnapshot()[4]).toMatchObject({ status: 0, memberName: null });
    expect(movie.runtime.unsupportedSeen).toEqual([]);
  });

  it("constructs, resets, and deconstructs imported Sound Machine and Jukebox lifecycle objects", async () => {
    const { movie, modules, objects, writers } = await createHarness();
    const soundMachineInterface = movie.runtime.instantiate(soundMachineInterfaceSeamModule, []) as ScriptInstance;
    const thread = movie.runtime.instantiate(modules.threadInstance, []) as ScriptInstance;
    movie.runtime.callMethod(thread, "construct", []);
    movie.runtime.setInstanceProp(thread, "interface", soundMachineInterface);
    const component = instantiateThreadObject(
      movie,
      modules.objectBase,
      modules.component,
      thread,
      symbol("soundmachine_component"),
    );
    movie.runtime.setInstanceProp(thread, "component", component);

    expect(objects.get("timeline instance")).toBeInstanceOf(ScriptInstance);
    expect(objects.get("timeline instance external")).toBeInstanceOf(ScriptInstance);
    expect(objects.get("jukebox manager")).toBeInstanceOf(ScriptInstance);
    expect(objects.get("song controller")).toBeInstanceOf(ScriptInstance);
    expect(writers.size).toBe(3);

    movie.runtime.callMethod(component, "reset", [0]);
    expect(movie.runtime.getInstanceProp(component, "peditoropen")).toBe(0);
    expect(movie.runtime.callMethod(component, "deconstruct", [])).toBe(1);
    expect(writers.size).toBe(0);
    expect(movie.runtime.unsupportedSeen).toEqual([]);
  });
});

async function createHarness(): Promise<GeneratedSoundHarness> {
  const modules: GeneratedSoundModules = {
    api: (await import(apiModuleId)) as GeneratedScriptModule,
    objectBase: (await import(objectBaseModuleId)) as GeneratedScriptModule,
    channel: (await import(channelModuleId)) as GeneratedScriptModule,
    instance: (await import(instanceModuleId)) as GeneratedScriptModule,
    manager: (await import(managerModuleId)) as GeneratedScriptModule,
    songPlayer: (await import(songPlayerModuleId)) as GeneratedScriptModule,
    generalSongPlayer: (await import(generalSongPlayerModuleId)) as GeneratedScriptModule,
    timeline: (await import(timelineModuleId)) as GeneratedScriptModule,
    controller: (await import(controllerModuleId)) as GeneratedScriptModule,
    jukebox: (await import(jukeboxModuleId)) as GeneratedScriptModule,
    component: (await import(componentModuleId)) as GeneratedScriptModule,
    threadInstance: (await import(threadInstanceModuleId)) as GeneratedScriptModule,
  };
  const manifest = soundManifest();
  const members = new CastRegistry({ movie: manifest, textFields: [], bitmaps: [] }, "/assets/");
  members.loadCast("sounds");
  const clock = new ManualDirectorAudioClock(10_000);
  const backend = new VirtualAudioBackend();
  const movie = new DirectorMovie(
    manifest,
    { log: () => {} },
    async () => {},
    async () => "",
    members,
    () => {},
    "/assets/",
    new Map(),
    async () => {},
    {},
    () => null,
    backend,
    clock,
  );
  const timeoutRequests: GeneratedSoundHarness["timeoutRequests"] = [];
  const objects = new Map<string, ScriptInstance>();
  const writers = new Set<string>();
  const factory = new Map<string, GeneratedScriptModule>([
    [modules.channel.scriptName.toLowerCase(), modules.channel],
    [modules.instance.scriptName.toLowerCase(), modules.instance],
    [modules.manager.scriptName.toLowerCase(), modules.manager],
    [modules.songPlayer.scriptName.toLowerCase(), modules.songPlayer],
    [modules.timeline.scriptName.toLowerCase(), modules.timeline],
    [modules.controller.scriptName.toLowerCase(), modules.controller],
    [modules.jukebox.scriptName.toLowerCase(), modules.jukebox],
  ]);
  const managers = new Map<string, ScriptInstance>();
  const objectManager = movie.runtime.instantiate(objectManagerModule(managers), []) as ScriptInstance;
  const hostModule: GeneratedScriptModule = {
    scriptName: "Generated Sound Workflow Test Host",
    scriptType: "movie",
    scriptProperties: [],
    scriptGlobals: [],
    handlers: {
      createobject(ctx, _me, args) {
        const module = factory.get(ops.stringOf(args[1] ?? LINGO_VOID).toLowerCase());
        if (!module) throw new Error(`Unknown generated sound class: ${ops.stringOf(args[1] ?? LINGO_VOID)}`);
        const instance = instantiateObject(movie, modules.objectBase, module, args[0] ?? LINGO_VOID);
        objects.set(managerId(args[0] ?? LINGO_VOID), instance);
        return instance;
      },
      createmanager(ctx, _me, args) {
        const id = managerId(args[0] ?? LINGO_VOID);
        const module = factory.get(ops.stringOf(args[1] ?? LINGO_VOID).toLowerCase());
        if (!module) throw new Error(`Unknown generated manager class: ${ops.stringOf(args[1] ?? LINGO_VOID)}`);
        const manager = instantiateObject(movie, modules.objectBase, module, args[0] ?? LINGO_VOID);
        managers.set(id, manager);
        return manager;
      },
      removemanager(ctx, _me, args) {
        const id = managerId(args[0] ?? LINGO_VOID);
        const manager = managers.get(id);
        if (!manager) return 0;
        ctx.callMethod(manager, "deconstruct", []);
        managers.delete(id);
        return 1;
      },
      getobjectmanager() {
        return objectManager;
      },
      getobject(_ctx, _me, args) {
        return objects.get(managerId(args[0] ?? LINGO_VOID)) ?? 0;
      },
      objectexists(_ctx, _me, args) {
        return objects.has(managerId(args[0] ?? LINGO_VOID)) ? 1 : 0;
      },
      removeobject(ctx, _me, args) {
        const id = managerId(args[0] ?? LINGO_VOID);
        const object = objects.get(id);
        if (!object) return 0;
        if (movie.runtime.hasHandler(object, "deconstruct")) ctx.callMethod(object, "deconstruct", []);
        objects.delete(id);
        return 1;
      },
      unregisterobject() {
        return 1;
      },
      getclassvariable(_ctx, _me, args) {
        const name = ops.stringOf(args[0] ?? LINGO_VOID).toLowerCase();
        if (name === "soundmachine.song.timeline") return "Song TimeLine Class";
        if (name === "soundmachine.jukebox.manager") return "Jukebox Manager Class";
        return args[1] ?? LINGO_VOID;
      },
      registermessage() {
        return 1;
      },
      unregistermessage() {
        return 1;
      },
      getmemnum(_ctx, _me, args) {
        return members.find(args[0] ?? LINGO_VOID, null)?.slotNumber ?? 0;
      },
      getmember(_ctx, _me, args) {
        return members.find(args[0] ?? LINGO_VOID, null) ?? 0;
      },
      memberexists(_ctx, _me, args) {
        return members.find(args[0] ?? LINGO_VOID, null) ? 1 : 0;
      },
      getmonotonicmillis() {
        return clock.nowMs();
      },
      managerexists() {
        return 0;
      },
      timeoutexists() {
        return 0;
      },
      removetimeout() {
        return 1;
      },
      getvariablevalue() {
        return "test connection";
      },
      getconnection() {
        return 0;
      },
      getuniqueid() {
        return `writer-${writers.size + 1}`;
      },
      getstructvariable() {
        return LingoPropList.fromPairs([
          [symbol("font"), "Arial"],
          [symbol("fontStyle"), new LingoList()],
        ]);
      },
      createwriter(_ctx, _me, args) {
        writers.add(ops.stringOf(args[0] ?? LINGO_VOID));
        return 1;
      },
      writerexists(_ctx, _me, args) {
        return writers.has(ops.stringOf(args[0] ?? LINGO_VOID)) ? 1 : 0;
      },
      removewriter(_ctx, _me, args) {
        return writers.delete(ops.stringOf(args[0] ?? LINGO_VOID)) ? 1 : 0;
      },
      gettext(_ctx, _me, args) {
        return ops.stringOf(args[0] ?? LINGO_VOID);
      },
      rgb(_ctx, _me, args) {
        return ops.stringOf(args[0] ?? LINGO_VOID);
      },
      createtimeout(_ctx, _me, args) {
        const handler = args[2] instanceof LingoSymbol ? args[2].name : ops.stringOf(args[2] ?? LINGO_VOID);
        timeoutRequests.push({
          name: ops.stringOf(args[0] ?? LINGO_VOID),
          period: Number(args[1] ?? 0),
          handler,
        });
        return 1;
      },
      error(_ctx, _me, args) {
        throw new Error(args.map((value) => ops.displayString(value)).join(" "));
      },
    },
  };
  movie.runtime.register(hostModule, "test");
  movie.runtime.register(modules.api, "hh_shared");
  movie.runtime.register(modules.channel, "hh_shared");
  movie.runtime.register(modules.instance, "hh_shared");
  movie.runtime.register(modules.manager, "hh_shared");
  movie.runtime.register(modules.songPlayer, "hh_soundmachine");
  movie.runtime.register(modules.generalSongPlayer, "hh_shared");
  movie.runtime.register(modules.timeline, "hh_soundmachine");
  movie.runtime.register(modules.controller, "hh_soundmachine");
  movie.runtime.register(modules.jukebox, "hh_soundmachine");
  movie.runtime.register(modules.component, "hh_soundmachine");
  movie.runtime.register(modules.threadInstance, "fuse_client");
  return { movie, members, clock, modules, timeoutRequests, objects, writers };
}

function prop(value: LingoValue, name: string): LingoValue {
  if (!(value instanceof LingoPropList)) return LINGO_VOID;
  return value.getaProp(symbol(name), ops.lingoKeyEquals);
}

function soundManifest(): MovieManifest {
  const sounds = [
    ["sample_1", 1_000],
    ["sample_2", 2_000],
    ["sample_3", 3_000],
    ["sample_4", 4_000],
    ["sample_5", 5_000],
    ["sample_6", 6_000],
    ["sample_7", 7_000],
    ["trax_short", 500],
    ["sound_machine_sample_0", 200],
    ["sound_machine_sample_1", 4_000],
  ] as const;
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [
      {
        number: 1,
        name: "sounds",
        members: sounds.map(([name, durationMs], index) => ({
          number: index + 1,
          name,
          type: "sound",
          sound: {
            container: "wav",
            codec: "pcm" as const,
            sampleRate: 1_000,
            channels: 1,
            sampleSize: 16,
            sampleCount: durationMs,
            durationMs,
            loopStart: null,
            loopEnd: null,
            assetPath: `sounds/${name}.wav`,
            assetSha256: name,
          },
        })),
      },
    ],
    score: { frameRate: 30, markers: [], behaviors: [], frames: [{ index: 1 }] },
  };
}

const identityModule: GeneratedScriptModule = {
  scriptName: "Sound Workflow Identity",
  scriptType: "parent",
  scriptProperties: [],
  scriptGlobals: [],
  handlers: {
    getid() {
      return symbol("sound_workflow_test");
    },
  },
};

const soundMachineInterfaceSeamModule: GeneratedScriptModule = {
  scriptName: "Sound Machine Interface Lifecycle Seam",
  scriptType: "parent",
  scriptProperties: [],
  scriptGlobals: [],
  handlers: {
    updatesoundsetslots() {
      return 1;
    },
  },
};

function objectManagerModule(managers: Map<string, ScriptInstance>): GeneratedScriptModule {
  return {
    scriptName: "Sound Workflow Object Manager",
    scriptType: "parent",
    scriptProperties: [],
    scriptGlobals: [],
    handlers: {
      managerexists(_ctx, _me, args) {
        return managers.has(managerId(args[1] ?? LINGO_VOID)) ? 1 : 0;
      },
      getmanager(_ctx, _me, args) {
        return managers.get(managerId(args[1] ?? LINGO_VOID)) ?? 0;
      },
    },
  };
}

function managerId(value: LingoValue): string {
  return value instanceof LingoSymbol ? value.name.toLowerCase() : ops.stringOf(value).toLowerCase();
}

function instantiateObject(
  movie: DirectorMovie,
  objectBaseModule: GeneratedScriptModule,
  classModule: GeneratedScriptModule,
  id: LingoValue,
): ScriptInstance {
  const base = movie.runtime.instantiate(objectBaseModule, []) as ScriptInstance;
  movie.runtime.callMethod(base, "construct", []);
  movie.runtime.setInstanceProp(base, "id", id);

  const instance = movie.runtime.instantiate(classModule, []) as ScriptInstance;
  movie.runtime.setInstanceProp(instance, "ancestor", base);
  movie.runtime.callMethod(instance, "construct", []);
  return instance;
}

function instantiateThreadObject(
  movie: DirectorMovie,
  objectBaseModule: GeneratedScriptModule,
  classModule: GeneratedScriptModule,
  thread: ScriptInstance,
  id: LingoValue,
): ScriptInstance {
  const base = movie.runtime.instantiate(objectBaseModule, []) as ScriptInstance;
  movie.runtime.setInstanceProp(base, "ancestor", thread);
  movie.runtime.callMethod(base, "construct", []);
  movie.runtime.setInstanceProp(base, "id", id);

  const instance = movie.runtime.instantiate(classModule, []) as ScriptInstance;
  movie.runtime.setInstanceProp(instance, "ancestor", base);
  movie.runtime.callMethod(instance, "construct", []);
  return instance;
}
