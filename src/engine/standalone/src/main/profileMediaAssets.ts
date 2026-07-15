import { existsSync, openSync, closeSync, readSync, readFileSync, statSync } from "node:fs";
import { open as openAsync, stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import { bitmapAssetIndexFiles, soundAssetIndexFiles } from "./originsRuntimeAdapter.js";

export type ProfileMediaKind = "bitmap" | "sound";

export interface ProfileMediaReference {
  readonly kind: ProfileMediaKind;
  readonly path: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function collectReferencedProfileMedia(
  runtimeDataRoot: string,
  versionId: string,
): ProfileMediaReference[] {
  const references = new Map<string, ProfileMediaKind>();
  collectIndexReferences(runtimeDataRoot, bitmapAssetIndexFiles(versionId), "bitmap", references);
  collectIndexReferences(runtimeDataRoot, soundAssetIndexFiles(versionId), "sound", references);
  return [...references.entries()]
    .map(([path, kind]) => ({ kind, path }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

export function profileMediaLooksValid(reference: ProfileMediaReference, assetsRoot: string): boolean {
  const filePath = join(assetsRoot, reference.path);
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    if (reference.kind === "bitmap") {
      if (stats.size < 33) return false;
      const file = openSync(filePath, "r");
      try {
        const signature = Buffer.alloc(PNG_SIGNATURE.length);
        return readSync(file, signature, 0, signature.length, 0) === signature.length && signature.equals(PNG_SIGNATURE);
      } finally {
        closeSync(file);
      }
    }
    if (stats.size < 12) return false;
    const signature = readFileSync(filePath, { flag: "r" }).subarray(0, 12);
    return soundSignatureLooksValid(reference.path, signature);
  } catch {
    return false;
  }
}

export async function profileMediaLooksValidAsync(
  reference: ProfileMediaReference,
  assetsRoot: string,
): Promise<boolean> {
  const filePath = join(assetsRoot, reference.path);
  try {
    const stats = await statAsync(filePath);
    if (!stats.isFile()) return false;
    const requiredBytes = reference.kind === "bitmap" ? PNG_SIGNATURE.length : 12;
    if (stats.size < (reference.kind === "bitmap" ? 33 : requiredBytes)) return false;
    const file = await openAsync(filePath, "r");
    try {
      const signature = Buffer.alloc(requiredBytes);
      const result = await file.read(signature, 0, signature.length, 0);
      if (result.bytesRead !== signature.length) return false;
      return reference.kind === "bitmap"
        ? signature.equals(PNG_SIGNATURE)
        : soundSignatureLooksValid(reference.path, signature);
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

function collectIndexReferences(
  runtimeDataRoot: string,
  files: readonly string[],
  kind: ProfileMediaKind,
  references: Map<string, ProfileMediaKind>,
): void {
  for (const file of files) {
    const fullPath = join(runtimeDataRoot, file);
    if (!existsSync(fullPath)) continue;
    collectMediaPathsFromValue(JSON.parse(readFileSync(fullPath, "utf8")), kind, references);
  }
}

function collectMediaPathsFromValue(
  value: unknown,
  kind: ProfileMediaKind,
  references: Map<string, ProfileMediaKind>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectMediaPathsFromValue(entry, kind, references);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value)) {
    if ((key === "pngPath" || key === "assetPath") && typeof entry === "string") {
      addMediaPath(references, entry, kind);
    } else if (key === "inkAssetPaths" && entry && typeof entry === "object") {
      for (const assetPath of Object.values(entry)) addMediaPath(references, assetPath, kind);
    } else if (kind === "bitmap" && typeof entry === "string" && /generated[\\/]assets[\\/].+\.png$/i.test(entry)) {
      addMediaPath(references, entry, kind);
    } else {
      collectMediaPathsFromValue(entry, kind, references);
    }
  }
}

function addMediaPath(
  references: Map<string, ProfileMediaKind>,
  value: unknown,
  kind: ProfileMediaKind,
): void {
  if (typeof value !== "string" || !pathMatchesKind(value, kind)) return;
  const path = value.replace(/^generated[\\/]+assets[\\/]+/i, "").replaceAll("\\", "/");
  if (!path || path.startsWith("../")) return;
  const existingKind = references.get(path);
  if (existingKind && existingKind !== kind) {
    throw new Error(`Profile media path is declared as both ${existingKind} and ${kind}: ${path}`);
  }
  references.set(path, kind);
}

function pathMatchesKind(path: string, kind: ProfileMediaKind): boolean {
  return kind === "bitmap" ? /\.png$/i.test(path) : /\.(?:mp3|wav)$/i.test(path);
}

function soundSignatureLooksValid(path: string, signature: Buffer): boolean {
  if (/\.wav$/i.test(path)) {
    return signature.subarray(0, 4).toString("ascii") === "RIFF" && signature.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (/\.mp3$/i.test(path)) {
    return signature.subarray(0, 3).toString("ascii") === "ID3" || (signature[0] === 0xff && (signature[1]! & 0xe0) === 0xe0);
  }
  return false;
}
