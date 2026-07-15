export interface CustomHotelViewLayerMetrics {
  readonly width: number;
  readonly height: number;
}

export interface CustomHotelViewLayoutInput {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly manualOffsetX?: number;
  readonly manualOffsetY?: number;
  readonly useLargeStage?: boolean;
  readonly elapsedMs?: number;
}

export interface CustomHotelViewLayout {
  readonly backgroundX: number;
  readonly backgroundY: number;
  readonly stageX: number;
  readonly stageY: number;
  readonly bannerX: number;
  readonly bannerY: number;
}

export interface CustomHotelViewStageModeInput {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly screenWidth?: number;
  readonly screenHeight?: number;
  readonly resizable?: boolean;
}

export const CUSTOM_HOTEL_VIEW_BACKGROUND: CustomHotelViewLayerMetrics = { width: 2560, height: 1392 };
export const CUSTOM_HOTEL_VIEW_STAGE_LARGE: CustomHotelViewLayerMetrics = { width: 2560, height: 1392 };
export const CUSTOM_HOTEL_VIEW_STAGE_SMALL: CustomHotelViewLayerMetrics = { width: 896, height: 719 };
export const CUSTOM_HOTEL_VIEW_BANNER_LARGE: CustomHotelViewLayerMetrics = { width: 364, height: 336 };
export const CUSTOM_HOTEL_VIEW_BANNER_SMALL: CustomHotelViewLayerMetrics = { width: 182, height: 168 };
export const CUSTOM_HOTEL_VIEW_TOOLBAR_BOTTOM_FILL_PX = 1;

export const CUSTOM_HOTEL_VIEW_ASSETS = {
  backgroundUrl: "/presentation/custom-hotelview/background.png",
  stageUrl: "/presentation/custom-hotelview/stage.png",
  stageLargeUrl: "/presentation/custom-hotelview/stage.png",
  stageSmallUrl: "/presentation/custom-hotelview/stage-small.png",
  bannerUrl: "/presentation/custom-hotelview/origins-banner.png",
  bannerLargeUrl: "/presentation/custom-hotelview/origins-banner.png",
  bannerSmallUrl: "/presentation/custom-hotelview/origins-banner-small.png",
} as const;

const MAXIMIZED_EDGE_TOLERANCE_X = 24;
const MAXIMIZED_EDGE_TOLERANCE_Y = 96;
const LARGE_STAGE_FALLBACK_MIN_WIDTH = 1920;
const LARGE_STAGE_FALLBACK_MIN_HEIGHT = 900;
const BANNER_SLIDE_MS = 700;

export function customHotelViewUsesLargeStage(input: CustomHotelViewStageModeInput): boolean {
  if (!input.resizable) return false;
  const viewportWidth = Math.max(1, Math.round(input.viewportWidth));
  const viewportHeight = Math.max(1, Math.round(input.viewportHeight));
  const largeEnough = viewportWidth >= LARGE_STAGE_FALLBACK_MIN_WIDTH && viewportHeight >= LARGE_STAGE_FALLBACK_MIN_HEIGHT;
  if (!largeEnough) return false;
  const screenWidth = Math.max(0, Math.round(input.screenWidth ?? 0));
  const screenHeight = Math.max(0, Math.round(input.screenHeight ?? 0));
  if (screenWidth > 0 && viewportWidth >= screenWidth - MAXIMIZED_EDGE_TOLERANCE_X) return true;
  if (screenHeight > 0 && viewportHeight >= screenHeight - MAXIMIZED_EDGE_TOLERANCE_Y) return true;
  return largeEnough;
}

export function customHotelViewBannerMetrics(useLargeStage = false): CustomHotelViewLayerMetrics {
  return useLargeStage ? CUSTOM_HOTEL_VIEW_BANNER_LARGE : CUSTOM_HOTEL_VIEW_BANNER_SMALL;
}

export function customHotelViewBannerUrl(useLargeStage = false): string {
  return useLargeStage ? CUSTOM_HOTEL_VIEW_ASSETS.bannerLargeUrl : CUSTOM_HOTEL_VIEW_ASSETS.bannerSmallUrl;
}

export function customHotelViewToolbarUnderlayHeight(sourceHeight: number): number {
  return Math.max(1, Math.round(sourceHeight)) + CUSTOM_HOTEL_VIEW_TOOLBAR_BOTTOM_FILL_PX;
}

export function customHotelViewLayout(input: CustomHotelViewLayoutInput): CustomHotelViewLayout {
  const viewportWidth = Math.max(1, Math.round(input.viewportWidth));
  const viewportHeight = Math.max(1, Math.round(input.viewportHeight));
  const manualOffsetX = Math.round(input.manualOffsetX ?? 0);
  const manualOffsetY = Math.round(input.manualOffsetY ?? 0);
  const useLargeStage = input.useLargeStage ?? false;
  const stage = useLargeStage ? CUSTOM_HOTEL_VIEW_STAGE_LARGE : CUSTOM_HOTEL_VIEW_STAGE_SMALL;
  const banner = customHotelViewBannerMetrics(useLargeStage);
  const elapsedMs = Math.max(0, input.elapsedMs ?? BANNER_SLIDE_MS);
  const bannerProgress = Math.min(1, elapsedMs / BANNER_SLIDE_MS);
  const eased = 1 - Math.pow(1 - bannerProgress, 3);
  const bannerY = Math.round(-banner.height * (1 - eased));
  return {
    backgroundX: 0,
    backgroundY: 0,
    stageX: Math.round((viewportWidth - stage.width) / 2) + manualOffsetX,
    stageY: Math.round((viewportHeight - stage.height) / 2) + manualOffsetY,
    bannerX: 0,
    bannerY: Object.is(bannerY, -0) ? 0 : bannerY,
  };
}
