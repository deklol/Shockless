import { describe, expect, it } from "vitest";
import {
  allReleaseArray,
  externalMembersFromCastGraph,
  externalMembersFromGeneratedScripts,
  externalMembersFromVisuals,
  mergeDirectorBitmapAssets,
  palettesFromBitmapAssets,
  releaseArray,
  type RuntimeDataFile,
} from "../../src/habbo/runtimeData";
import { existsSync, readFileSync } from "node:fs";

// Generated runtime data is produced locally from client source and never
// committed; read it from disk so clones without it still type-check, and
// skip the supplement assertion when the file is absent.
const externalTextFieldSupplementUrl = new URL(
  "../../generated/runtime-data/external-cast-text-fields-supplement.release306.json",
  import.meta.url,
);
const externalTextFieldSupplementAvailable = existsSync(externalTextFieldSupplementUrl);

describe("Habbo runtime data helpers", () => {
  it.skipIf(!externalTextFieldSupplementAvailable)("supplements release306 private-room unkeyed text fields from source STXT chunks", () => {
    const externalTextFieldSupplementRaw = JSON.parse(
      readFileSync(externalTextFieldSupplementUrl, "utf8"),
    ) as RuntimeDataFile;
    const fields = releaseArray<{
      castName: string;
      memberName: string;
      text: string;
      properties?: Record<string, string>;
    }>(externalTextFieldSupplementRaw as RuntimeDataFile, "fields");
    const memberAlias = fields.find(
      (field) => field.castName === "hh_room_private" && field.memberName === "memberalias.index",
    );
    const variableIndex = fields.find(
      (field) => field.castName === "hh_room_private" && field.memberName === "variable.index",
    );

    expect(memberAlias?.properties?.["model_a Class"]).toBe("Private Room Engine Class");
    expect(memberAlias?.properties?.["exterior_h Class"]).toBe("Sewer Room Engine Class");
    expect(variableIndex?.text).toContain("landscape.height=400");
  });

  it("reads release arrays from array and object shaped manifests", () => {
    expect(releaseArray<{ id: number }>({ releases: [{ fields: [{ id: 1 }] }] }, "fields")).toEqual([
      { id: 1 },
    ]);
    expect(releaseArray<{ id: number }>({ releases: { "0": { assets: [{ id: 2 }] } } }, "assets")).toEqual([
      { id: 2 },
    ]);
  });

  it("can read entries across every release in a manifest", () => {
    expect(
      allReleaseArray<{ id: number }>(
        {
          releases: [
            { assets: [{ id: 1 }] },
            { assets: [{ id: 2 }] },
          ],
        },
        "assets",
      ),
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(
      allReleaseArray<{ id: number }>(
        {
          releases: {
            a: { fields: [{ id: 3 }] },
            b: { fields: [{ id: 4 }] },
          },
        },
        "fields",
      ),
    ).toEqual([{ id: 3 }, { id: 4 }]);
  });

  it("adds resolved visual shape members from the layout index", () => {
    const members = externalMembersFromVisuals([
      {
        castName: "hh_entry_uk",
        castOrder: 11,
        member: 4,
        memberName: "entry.visual",
        elements: [
          {
            memberName: "skyleft_shape",
            resolvedMember: {
              castName: "hh_entry_uk",
              castOrder: 11,
              member: 15,
              memberName: "skyleft_shape",
              memberType: "shape",
            },
          },
        ],
      },
    ]);

    expect(members).toContainEqual({
      castName: "hh_entry_uk",
      castOrder: 11,
      member: 15,
      memberName: "skyleft_shape",
      memberType: "shape",
      mediaType: undefined,
      identitySource: "visual",
    });
  });

  it("adds source-derived generated script members to external casts", () => {
    expect(
      externalMembersFromGeneratedScripts([
        {
          castFile: "hh_entry_uk",
          scriptType: "parent",
          memberNumber: 23,
          memberName: "Entry Cloud Class",
          module: { scriptName: "Entry Cloud Class", scriptType: "parent" },
        },
      ]),
    ).toEqual([
      {
        castName: "hh_entry_uk",
        member: 23,
        memberName: "Entry Cloud Class",
        memberType: "script",
      },
    ]);
  });

  it("adds source-derived external cast graph members", () => {
    expect(
      externalMembersFromCastGraph([
        {
          order: 76,
          name: "hh_room_private",
          members: [
            { number: 41, name: "flat_floor_0_a_0_0_0", type: "bitmap", memberChunkId: 646 },
            { number: 118, name: "model_a.room", type: "text", memberChunkId: 556 },
          ],
        },
      ]),
    ).toEqual([
      {
        castName: "hh_room_private",
        castOrder: 76,
        member: 41,
        memberName: "flat_floor_0_a_0_0_0",
        memberType: "bitmap",
        identitySource: "castGraph",
      },
      {
        castName: "hh_room_private",
        castOrder: 76,
        member: 118,
        memberName: "model_a.room",
        memberType: "text",
        identitySource: "castGraph",
      },
    ]);
  });

  it("preserves imported external sound media metadata", () => {
    const sound = {
      container: "director-edim-mp3",
      codec: "mp3" as const,
      sampleRate: 44100,
      channels: 1,
      sampleSize: null,
      sampleCount: 88200,
      durationMs: 2000,
      loopStart: null,
      loopEnd: null,
      assetPath: "sounds/release331/hh_soundmachine/0103-sound_machine_sample_0.mp3",
      assetSha256: "a".repeat(64),
      sourceFourCC: "ediM" as const,
    };
    expect(
      externalMembersFromCastGraph([{
        order: 74,
        name: "hh_soundmachine",
        members: [{ number: 103, name: "sound_machine_sample_0", type: "sound", sound }],
      }]),
    ).toEqual([{
      castName: "hh_soundmachine",
      castOrder: 74,
      member: 103,
      memberName: "sound_machine_sample_0",
      memberType: "sound",
      sound,
      identitySource: "castGraph",
    }]);
  });

  it("keeps the first cast graph identity when supplemental registries reuse a member slot", () => {
    expect(
      externalMembersFromCastGraph([
        {
          order: 76,
          name: "hh_room_private",
          members: [
            { number: 118, name: "model_a.room", type: "text", memberChunkId: 556 },
            { number: 118, name: "right_sstairs1_0_a_0_2_0", type: "bitmap", memberChunkId: 109 },
          ],
        },
      ]),
    ).toEqual([
      {
        castName: "hh_room_private",
        castOrder: 76,
        member: 118,
        memberName: "model_a.room",
        memberType: "text",
        identitySource: "castGraph",
      },
    ]);
  });

  it("keeps a text cast graph identity when a later bitmap record has no replacement name", () => {
    expect(
      externalMembersFromCastGraph([
        {
          order: 76,
          name: "hh_room_private",
          members: [
            { number: 118, name: "model_a.room", type: "text", memberChunkId: 556 },
            { number: 118, type: "bitmap", memberChunkId: 109 },
          ],
        },
      ]),
    ).toEqual([
      {
        castName: "hh_room_private",
        castOrder: 76,
        member: 118,
        memberName: "model_a.room",
        memberType: "text",
        identitySource: "castGraph",
      },
    ]);
  });

  it("keeps bitmap assets release-local", () => {
    expect(
      releaseArray<{ versionId?: string; memberName: string }>(
        {
          releases: [
            {
              assets: [
                {
                  versionId: "release306",
                  memberName: "flat_floor_0_a_0_0_0",
                },
              ],
            },
            {
              assets: [
                {
                  versionId: "release318",
                  memberName: "flat_floor_0_a_0_0_0",
                },
              ],
            },
          ],
        },
        "assets",
      ),
    ).toEqual([{ versionId: "release306", memberName: "flat_floor_0_a_0_0_0" }]);
  });

  it("recovers shared palette cast members from external bitmap assets", () => {
    const palettes = palettesFromBitmapAssets([
      {
        castName: "hh_messenger",
        castOrder: 20,
        member: 44,
        memberName: "screen_mid",
        width: 8,
        height: 8,
        regPoint: { x: 0, y: 0 },
        pngPath: "generated/assets/external-bitmaps/release306/hh_messenger/screen_mid.png",
        paletteCastName: "hh_messenger",
        paletteMember: 53,
        paletteName: "interface palette_messenger",
        paletteColors: [0x000000, 0xffcc00],
      },
      {
        castName: "HH_MESSENGER.cst",
        castOrder: 20,
        member: 45,
        memberName: "screen_left",
        width: 8,
        height: 8,
        regPoint: { x: 0, y: 0 },
        pngPath: "generated/assets/external-bitmaps/release306/hh_messenger/screen_left.png",
        paletteCastName: "HH_MESSENGER.cst",
        paletteMember: 53,
        paletteName: "interface palette_messenger",
        paletteColors: [0xffffff],
      },
      {
        castName: "hh_purse",
        castOrder: 21,
        member: 18,
        memberName: "purse_sd1",
        width: 8,
        height: 8,
        regPoint: { x: 0, y: 0 },
        pngPath: "generated/assets/external-bitmaps/release306/hh_purse/purse_sd1.png",
        paletteName: "purse_interface_palette",
        paletteColors: [0x111111],
      },
    ]);

    expect(palettes).toEqual([
      {
        castName: "hh_messenger",
        castOrder: 20,
        member: 53,
        memberName: "interface palette_messenger",
        colors: [0x000000, 0xffcc00],
      },
    ]);
  });

  it("keeps normal external cast bitmaps authoritative over visual supplements", () => {
    const bitmaps = mergeDirectorBitmapAssets(
      [
        {
          castName: "hh_entry_uk",
          castOrder: 638,
          member: 12,
          memberName: "Habbo UK tower",
          width: 277,
          height: 425,
          regPoint: { x: 0, y: 0 },
          pngPath: "generated/assets/external-bitmaps/release320/hh_entry_uk/0012-habbo-uk-tower.png",
        },
      ],
      [
        {
          castName: "hh_entry_uk",
          castOrder: 638,
          member: 12,
          sourceBitmapMember: 12,
          memberName: "Habbo UK tower",
          width: 277,
          height: 425,
          regPoint: { x: 0, y: 0 },
          pngPath: "visual-bitmaps/release320/hh_entry_uk/012-habbo-uk-tower-hotel_palette.png",
        },
        {
          castName: "hh_room_private",
          castOrder: 76,
          member: 544,
          sourceBitmapMember: 544,
          memberName: "Horizon_Sakura_Background",
          width: 960,
          height: 488,
          regPoint: { x: 0, y: 0 },
          pngPath: "visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background.png",
        },
      ],
    );

    expect(bitmaps.map((bitmap) => bitmap.pngPath)).toEqual([
      "generated/assets/external-bitmaps/release320/hh_entry_uk/0012-habbo-uk-tower.png",
      "visual-bitmaps/release320/hh_room_private/544-horizon_sakura_background.png",
    ]);
  });

  it("does not let a visual source alias replace an existing external member", () => {
    const bitmaps = mergeDirectorBitmapAssets(
      [
        {
          castName: "hh_entry_uk",
          castOrder: 638,
          member: 12,
          memberName: "Habbo UK tower",
          width: 277,
          height: 425,
          regPoint: { x: 0, y: 0 },
          pngPath: "generated/assets/external-bitmaps/release320/hh_entry_uk/0012-habbo-uk-tower.png",
        },
      ],
      [
        {
          castName: "hh_entry_uk",
          castOrder: 638,
          member: 99,
          sourceBitmapMember: 12,
          memberName: "Habbo UK tower visual proxy",
          width: 277,
          height: 425,
          regPoint: { x: 0, y: 0 },
          pngPath: "visual-bitmaps/release320/hh_entry_uk/099-habbo-uk-tower-proxy.png",
        },
      ],
    );

    expect(bitmaps).toEqual([
      expect.objectContaining({
        member: 12,
        pngPath: "generated/assets/external-bitmaps/release320/hh_entry_uk/0012-habbo-uk-tower.png",
      }),
      expect.not.objectContaining({ sourceBitmapMember: 12 }),
    ]);
    expect(bitmaps[1]).toEqual(
      expect.objectContaining({
        member: 99,
        pngPath: "visual-bitmaps/release320/hh_entry_uk/099-habbo-uk-tower-proxy.png",
      }),
    );
  });
});
