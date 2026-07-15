import { describe, expect, it } from "vitest";
import { ManualDirectorAudioClock } from "../../src/director/audio/clock";
import { VirtualAudioBackend } from "../../src/director/audio/VirtualAudioBackend";
import { DirectorMovie, type MovieManifest } from "../../src/director/Movie";
import { CastRegistry } from "../../src/director/members";

const IMPORTED_SOUND_COUNT = 810;

describe("Director audio lifecycle and startup work", () => {
  it("keeps a full imported sound inventory lazy until Lingo requests playback", () => {
    const manifest = soundInventoryManifest(IMPORTED_SOUND_COUNT);
    const members = new CastRegistry({ movie: manifest, textFields: [], bitmaps: [] }, "/assets/");
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
      new ManualDirectorAudioClock(),
    );

    expect(backend.trace.filter((event) => event.operation === "preload" || event.operation === "play")).toEqual([]);
    expect(members.find("imported_sound_1", "sounds")).toBeNull();

    expect(members.loadCast("sounds")).toBe(true);
    const member = members.find("imported_sound_1", "sounds");
    expect(member?.sound?.assetPath).toBe("sounds/imported_sound_1.mp3");
    expect(backend.trace.filter((event) => event.operation === "preload" || event.operation === "play")).toEqual([]);

    expect(movie.audioCommand(1, "play", [member!])).toBe(1);
    expect(backend.trace.filter((event) => event.operation === "play")).toHaveLength(1);

    movie.disposeAudio();
    expect(backend.active.size).toBe(0);
    expect(backend.queueSnapshots.size).toBe(0);
  });
});

function soundInventoryManifest(count: number): MovieManifest {
  return {
    stage: { width: 960, height: 540, backgroundColor: "#000000" },
    casts: [
      {
        number: 5,
        name: "sounds",
        members: Array.from({ length: count }, (_, index) => {
          const number = index + 1;
          return {
            number,
            name: `imported_sound_${number}`,
            type: "sound",
            sound: {
              container: "mp3",
              codec: "mp3" as const,
              sampleRate: 44_100,
              channels: 2,
              sampleSize: null,
              sampleCount: 44_100,
              durationMs: 1_000,
              loopStart: null,
              loopEnd: null,
              assetPath: `sounds/imported_sound_${number}.mp3`,
              assetSha256: number.toString(16).padStart(64, "0"),
              sourceFourCC: "ediM" as const,
            },
          };
        }),
      },
    ],
    score: {
      frameRate: 12,
      markers: [],
      behaviors: [],
      frames: [{ index: 1 }],
    },
  };
}
