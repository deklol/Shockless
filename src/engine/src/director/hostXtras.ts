import type { LingoValue } from "./values";

export interface DirectorHostXtraProvider {
  createXtra(name: string): LingoValue | undefined;
  createXtraInstance(reference: LingoValue): LingoValue | undefined;
  callMethod(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue | undefined;
}

export const NO_DIRECTOR_HOST_XTRAS: DirectorHostXtraProvider = Object.freeze({
  createXtra: () => undefined,
  createXtraInstance: () => undefined,
  callMethod: () => undefined,
});
