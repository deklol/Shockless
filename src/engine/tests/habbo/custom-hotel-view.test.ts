import { describe, expect, it } from "vitest";
import {
  customHotelViewBannerMetrics,
  customHotelViewBannerUrl,
  customHotelViewLayout,
  customHotelViewToolbarUnderlayHeight,
  customHotelViewUsesLargeStage,
} from "../../src/habbo/customHotelView";

describe("custom hotel-view presentation layout", () => {
  it("uses the compact draggable stage layer at the fixed client size", () => {
    const layout = customHotelViewLayout({ viewportWidth: 960, viewportHeight: 540 });

    expect(layout.stageX).toBe(32);
    expect(layout.stageY).toBe(-89);
  });

  it("centers the large draggable stage layer when maximized mode is selected", () => {
    const layout = customHotelViewLayout({ viewportWidth: 2048, viewportHeight: 1100, useLargeStage: true });

    expect(layout.stageX).toBe(-256);
    expect(layout.stageY).toBe(-146);
  });

  it("applies manual drag offsets without resizing the layer", () => {
    const layout = customHotelViewLayout({
      viewportWidth: 960,
      viewportHeight: 540,
      manualOffsetX: 32,
      manualOffsetY: -12,
    });

    expect(layout.stageX).toBe(64);
    expect(layout.stageY).toBe(-101);
  });

  it("slides the compact badge down to the top left without a presentation gap", () => {
    const start = customHotelViewLayout({ viewportWidth: 1500, viewportHeight: 760, elapsedMs: 0 });
    const end = customHotelViewLayout({ viewportWidth: 1500, viewportHeight: 760, elapsedMs: 700 });

    expect(start.bannerX).toBe(0);
    expect(start.bannerY).toBe(-168);
    expect(end.bannerX).toBe(0);
    expect(end.bannerY).toBe(0);
  });

  it("slides the large badge by its full source height when large mode is selected", () => {
    const start = customHotelViewLayout({ viewportWidth: 2048, viewportHeight: 1100, useLargeStage: true, elapsedMs: 0 });
    const end = customHotelViewLayout({ viewportWidth: 2048, viewportHeight: 1100, useLargeStage: true, elapsedMs: 700 });

    expect(start.bannerX).toBe(0);
    expect(start.bannerY).toBe(-336);
    expect(end.bannerX).toBe(0);
    expect(end.bannerY).toBe(0);
  });

  it("uses the small banner asset with the compact stage and the large banner asset with the large stage", () => {
    expect(customHotelViewBannerMetrics(false)).toEqual({ width: 182, height: 168 });
    expect(customHotelViewBannerMetrics(true)).toEqual({ width: 364, height: 336 });
    expect(customHotelViewBannerUrl(false)).toBe("/presentation/custom-hotelview/origins-banner-small.png");
    expect(customHotelViewBannerUrl(true)).toBe("/presentation/custom-hotelview/origins-banner.png");
  });

  it("extends the custom black toolbar underlay through the final viewport row", () => {
    expect(customHotelViewToolbarUnderlayHeight(54)).toBe(55);
  });

  it("only switches to the large stage on a maximized-like viewport", () => {
    expect(
      customHotelViewUsesLargeStage({
        viewportWidth: 960,
        viewportHeight: 540,
        screenWidth: 2048,
        screenHeight: 1152,
        resizable: true,
      }),
    ).toBe(false);
    expect(
      customHotelViewUsesLargeStage({
        viewportWidth: 1500,
        viewportHeight: 760,
        screenWidth: 2048,
        screenHeight: 1152,
        resizable: true,
      }),
    ).toBe(false);
    expect(
      customHotelViewUsesLargeStage({
        viewportWidth: 2048,
        viewportHeight: 1048,
        screenWidth: 2048,
        screenHeight: 1152,
        resizable: true,
      }),
    ).toBe(true);
  });

  it("keeps fixed-stage standalone launches on the compact stage", () => {
    expect(
      customHotelViewUsesLargeStage({
        viewportWidth: 2048,
        viewportHeight: 1048,
        screenWidth: 2048,
        screenHeight: 1152,
        resizable: false,
      }),
    ).toBe(false);
  });
});
