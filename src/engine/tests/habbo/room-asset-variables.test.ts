import { describe, expect, it } from "vitest";
import {
  enableRelease306RoomAssetVariables,
  isRelease306DynamicRoomCast,
  release306DynamicRoomCastsFromVariables,
  RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE,
} from "../../src/habbo/roomAssetVariables";

describe("release306 room asset variables", () => {
  it("identifies release306 dynamic private-room asset casts", () => {
    expect(isRelease306DynamicRoomCast("hh_furni_items")).toBe(true);
    expect(isRelease306DynamicRoomCast("hh_furni_s_assets_3")).toBe(true);
    expect(isRelease306DynamicRoomCast("hh_furni_2025_small")).toBe(true);
    expect(isRelease306DynamicRoomCast("hh_furni_small")).toBe(false);
    expect(isRelease306DynamicRoomCast("hh_farming")).toBe(false);
    expect(isRelease306DynamicRoomCast("hh_pets_50")).toBe(false);
    expect(isRelease306DynamicRoomCast("hh_room_private")).toBe(false);
    expect(isRelease306DynamicRoomCast("hh_human_body")).toBe(false);
  });

  it("derives dynamic casts from release306 cast.entry declarations", () => {
    expect(
      release306DynamicRoomCastsFromVariables(
        [
          "cast.entry.1=hh_interface",
          "cast.entry.2=hh_furni_items",
          "cast.entry.3=hh_furni_items",
          "cast.entry.4=hh_furni_small",
          "cast.entry.5=hh_room_private",
          "cast.entry.6=hh_farming",
          "cast.entry.7=hh_furni_2025_small",
        ].join("\r"),
      ),
    ).toEqual(["hh_furni_items", "hh_furni_2025_small"]);
  });

  it("enables the source Room Asset Buffer globally without duplicating room casts", () => {
    const variables = enableRelease306RoomAssetVariables(
      [
        "cast.entry.1=hh_interface",
        "cast.entry.2=hh_furni_items",
        "cast.entry.3=hh_pets_50",
        "cast.entry.4=hh_furni_2025_small",
        "room.cast.1=hh_soundmachine",
        "room.cast.2=hh_furni_items",
        "room.dynamic.assets.enabled=0",
        "room.dynamic.furniture.queue.batch.size=1",
      ].join("\r"),
    );

    expect(variables).toContain("room.dynamic.assets.enabled=1");
    expect(variables).toContain("room.asset.buffer.component.class=Buffer Component Class");
    expect(variables).toContain("room.dynamic.furniture.queue.batch.size=64");
    expect(variables).toContain("room.dynamic.furniture.queue.delay=1");
    expect(variables).toContain("room.dynamic.furniture.defer.delay=1");
    expect(variables).toContain(
      `${RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE}=["hh_furni_items", "hh_furni_2025_small"]`,
    );
    expect(variables.match(/room\.dynamic\.assets\.enabled=/g)).toHaveLength(1);
    expect(variables.match(/room\.dynamic\.furniture\.queue\.batch\.size=/g)).toHaveLength(1);
    expect(variables.match(/room\.cast\.\d+=hh_furni_items/g)).toHaveLength(1);
    expect(variables).not.toMatch(/room\.cast\.\d+=hh_furni_2025/);
    expect(variables).not.toMatch(/room\.cast\.\d+=hh_pets_50/);
  });
});
