import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registryModuleId = "../../generated/profiles/release320/scripts/registry";
const generatedSoundRegistryAvailable = existsSync(new URL(`${registryModuleId}.ts`, import.meta.url));

interface GeneratedSoundRegistryEntry {
  readonly castFile: string;
  readonly memberName: string;
  readonly scriptType: string;
  readonly module: {
    readonly scriptName: string;
    readonly scriptType: string;
    readonly handlers: Readonly<Record<string, unknown>>;
  };
}

interface SoundScriptContract {
  readonly castFile: string;
  readonly memberName: string;
  readonly scriptType: "movie" | "parent";
  readonly handlers: readonly string[];
}

const SOUND_SCRIPT_CONTRACTS: readonly SoundScriptContract[] = [
  {
    castFile: "hh_shared",
    memberName: "Sound API",
    scriptType: "movie",
    handlers: ["getsoundmanager", "playsound", "playsoundinchannel", "queuesound", "stopallsounds"],
  },
  {
    castFile: "hh_shared",
    memberName: "Sound Channel Class",
    scriptType: "parent",
    handlers: ["define", "setsoundstate", "reset", "play", "queue", "startplaying", "gettimeremaining"],
  },
  {
    castFile: "hh_shared",
    memberName: "Sound Instance Class",
    scriptType: "parent",
    handlers: ["define", "getproperty", "getmember"],
  },
  {
    castFile: "hh_shared",
    memberName: "Sound Manager Class",
    scriptType: "parent",
    handlers: ["construct", "play", "playinchannel", "queue", "stopallsounds", "setsoundstate"],
  },
  {
    castFile: "hh_shared",
    memberName: "Song Player Class",
    scriptType: "parent",
    handlers: ["startsong", "stopsong", "queuechannels", "startchannels", "checkloopdata"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Jukebox Manager Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Song Controller Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Song Player Class",
    scriptType: "parent",
    handlers: ["startsong", "stopsong", "queuechannels", "startchannels", "checkloopdata"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Furniture Sound Machine Class",
    scriptType: "parent",
    handlers: ["define", "select", "changestate", "setstate", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Furniture Song Disk Class",
    scriptType: "parent",
    handlers: ["construct", "define", "getinfo", "select", "setstate", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Furniture Jukebox Class",
    scriptType: "parent",
    handlers: ["define", "select", "getinfo", "setstate", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "SoundMachine Interface Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "SoundMachine Component Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "SoundMachine Handler Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Sound Machine Instance",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "Song TimeLine Class",
    scriptType: "parent",
    handlers: ["construct", "parsesongdata", "getsongdata", "getsamplename"],
  },
  {
    castFile: "hh_soundmachine",
    memberName: "SongList Manager Class",
    scriptType: "parent",
    handlers: ["construct", "deconstruct"],
  },
];

describe.skipIf(!generatedSoundRegistryAvailable)("generated sound registry", () => {
  it("retains every ordinary Sound Manager and Sound Machine controller used by the imported client", async () => {
    const { generatedScripts } = (await import(registryModuleId)) as {
      generatedScripts: readonly GeneratedSoundRegistryEntry[];
    };
    for (const contract of SOUND_SCRIPT_CONTRACTS) {
      const matches = generatedScripts.filter(
        (entry) => entry.castFile === contract.castFile && entry.memberName === contract.memberName,
      );
      expect(matches, `${contract.castFile}:${contract.memberName}`).toHaveLength(1);

      const entry = matches[0]!;
      expect(entry.scriptType).toBe(contract.scriptType);
      expect(entry.module.scriptName).toBe(contract.memberName);
      expect(entry.module.scriptType).toBe(contract.scriptType);
      expect(Object.keys(entry.module.handlers)).toEqual(expect.arrayContaining([...contract.handlers]));
    }
  }, 30_000);
});
