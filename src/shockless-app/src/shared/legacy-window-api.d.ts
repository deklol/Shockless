import type { ShocklessApi } from "./window-api";

declare global {
  interface Window {
    habbpyV4?: ShocklessApi;
  }
}

export {};
