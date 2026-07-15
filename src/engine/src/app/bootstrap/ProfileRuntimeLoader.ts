import { LingoImage } from "@director/imaging";
import type { BitmapInfo } from "@director/members";
import type { GeneratedScriptModule } from "@director/Runtime";

export const FAST_ENTRY_DEFAULT_CAST_KEEP = [
  "hh_human_acc_face",
  "hh_human_acc_head",
  "hh_human_hats",
  "hh_human_hair",
  "hh_human_shirt",
  "hh_human_leg",
  "hh_human_shoe",
  "hh_human_acc_eye",
  "hh_human_body",
  "hh_human_face",
  "hh_human_item",
  "hh_human_acc_waist",
  "hh_human_acc_chest",
  "hh_human_50_shirt",
  "hh_human_50_leg",
  "hh_human_50_shoe",
  "hh_human_50_item",
  "hh_human_50_acc_chest",
  "hh_human_50_acc_waist",
  "hh_human_50_acc_head",
  "hh_human_50_body",
  "hh_human_50_face",
  "hh_human_50_hats",
  "hh_human_50_hair",
  "hh_human_50_acc_eye",
  "hh_human_50_acc_face",
  "hh_bulletin",
  "hh_buffer",
] as const;

export type GeneratedScriptEntry = {
  readonly castFile: string;
  readonly scriptType: string;
  readonly memberNumber: number | null;
  readonly memberName: string | null;
  readonly module: GeneratedScriptModule;
};
export type GeneratedScriptBundle = readonly GeneratedScriptEntry[];
type GeneratedScriptRegistryModule = { readonly generatedScripts: GeneratedScriptBundle };

const bundledRegistryLoaders = import.meta.glob<GeneratedScriptRegistryModule>("../../../generated/scripts/registry.ts");

export function createDecodeScheduler(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const queue: Array<() => Promise<void>> = [];
  let active = 0;
  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const task = queue.shift()!;
      active += 1;
      void task().finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
      pump();
    });
}

export async function fetchImageBitmap(
  url: string,
  cache: Map<string, Promise<ImageBitmap | null>>,
): Promise<ImageBitmap | null> {
  let promise = cache.get(url);
  if (!promise) {
    promise = fetch(url)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response.status)))
      .then((blob) => createImageBitmap(blob))
      .catch(() => null);
    cache.set(url, promise);
  }
  return promise;
}

export function deliverBitmapPixels(bitmap: BitmapInfo, decoded: ImageBitmap | null): void {
  const existing = bitmap.decoded;
  if (existing) {
    existing.setMatteCoveragePolicy(bitmap.ink8AlphaPolicy);
    existing.adoptDrawable(decoded);
  } else if (decoded) {
    bitmap.decoded = LingoImage.fromDrawable(decoded, bitmap.width, bitmap.height).setMatteCoveragePolicy(bitmap.ink8AlphaPolicy);
  } else {
    bitmap.decoded = new LingoImage(bitmap.width, bitmap.height, 32, undefined, { initWhite: false }).setMatteCoveragePolicy(bitmap.ink8AlphaPolicy);
  }
}

export function limitCastEntryVariables(text: string, limit: number, keepNames: ReadonlySet<string>): string {
  if (limit <= 0 && keepNames.size === 0) return text;
  const lines = text.split(/\r\n|\r|\n/);
  const entries: Array<{ lineIndex: number; entryNumber: number; castName: string }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = /^cast\.entry\.(\d+)=(.+)$/i.exec(lines[lineIndex]!.trim());
    if (!match) continue;
    entries.push({ lineIndex, entryNumber: Number(match[1]), castName: match[2]!.trim() });
  }
  if (entries.length === 0) return text;
  const firstEntryLine = Math.min(...entries.map((entry) => entry.lineIndex));
  const castEntryLines = new Set(entries.map((entry) => entry.lineIndex));
  const compactedEntries = entries
    .filter((entry) => (limit > 0 && entry.entryNumber <= limit) || keepNames.has(entry.castName.toLowerCase()))
    .sort((left, right) => left.entryNumber - right.entryNumber)
    .map((entry, index) => `cast.entry.${index + 1}=${entry.castName}`);
  const result: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex === firstEntryLine) result.push(...compactedEntries);
    if (!castEntryLines.has(lineIndex)) result.push(lines[lineIndex]!);
  }
  return result.join("\r");
}

export function parseCastEntryKeep(value: string | null): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

export function runtimeVersionFromParams(params: URLSearchParams): string {
  const candidate = (params.get("profileVersion") ?? params.get("versionId") ?? "release306").trim();
  return /^release\d+$/i.test(candidate) ? candidate.toLowerCase() : "release306";
}

export async function generatedScriptsForRuntimeVersion(runtimeVersion: string, profileId: string): Promise<{
  readonly version: string;
  readonly scripts: GeneratedScriptBundle;
  readonly exact: boolean;
  readonly source: "profile" | "bundled";
}> {
  const profileBundle = await loadProfileExecutableScripts(runtimeVersion, profileId);
  if (profileBundle) return profileBundle;
  if (runtimeVersion === "release306") {
    const bundled = await loadBundledRelease306Scripts();
    if (bundled) return { version: "release306", scripts: bundled, exact: true, source: "bundled" };
  }
  throw new Error(
    `No executable generated script bundle is available for ${runtimeVersion}. ` +
      "Import generated data/assets are not enough on their own; re-import the compiled client so scripts/executable/registry.js is generated for this profile.",
  );
}

async function loadBundledRelease306Scripts(): Promise<GeneratedScriptBundle | null> {
  const load = bundledRegistryLoaders["../../../generated/scripts/registry.ts"];
  if (!load) return null;
  const registry = await load();
  return Array.isArray(registry.generatedScripts) && registry.generatedScripts.length > 0 ? registry.generatedScripts : null;
}

async function loadProfileExecutableScripts(
  runtimeVersion: string,
  profileId: string,
): Promise<{
  readonly version: string;
  readonly scripts: GeneratedScriptBundle;
  readonly exact: boolean;
  readonly source: "profile";
} | null> {
  const manifestResponse = await fetch("/origins-data/scripts/executable/manifest.json", { cache: "no-store" });
  if (!manifestResponse.ok) return null;
  const manifest = (await manifestResponse.json()) as {
    readonly versionId?: unknown;
    readonly scriptCount?: unknown;
    readonly failureCount?: unknown;
  };
  const manifestVersion = String(manifest.versionId ?? "").trim().toLowerCase();
  if (manifestVersion !== runtimeVersion) {
    throw new Error(`Profile executable scripts are for ${manifestVersion || "an unknown version"}, not ${runtimeVersion}.`);
  }
  const failureCount = Number(manifest.failureCount);
  if (!Number.isInteger(failureCount) || failureCount > 0) {
    throw new Error(`Profile executable scripts for ${runtimeVersion} have ${Number.isFinite(failureCount) ? failureCount : "unknown"} compiler failure(s).`);
  }
  const scriptCount = Number(manifest.scriptCount);
  if (!Number.isInteger(scriptCount) || scriptCount <= 0) {
    throw new Error(`Profile executable scripts for ${runtimeVersion} are empty.`);
  }
  const registryUrl = `/origins-data/scripts/executable/registry.js?profile=${encodeURIComponent(profileId)}&version=${encodeURIComponent(runtimeVersion)}`;
  const module = (await import(/* @vite-ignore */ registryUrl)) as GeneratedScriptRegistryModule;
  if (!Array.isArray(module.generatedScripts) || module.generatedScripts.length === 0) {
    throw new Error(`Profile executable registry for ${runtimeVersion} did not export generatedScripts.`);
  }
  return { version: runtimeVersion, scripts: module.generatedScripts, exact: true, source: "profile" };
}
