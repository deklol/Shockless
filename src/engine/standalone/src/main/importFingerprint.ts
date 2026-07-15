import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const SOURCE_FINGERPRINT_SCHEMA = "shockless-import-source-v1";
const PIPELINE_FINGERPRINT_SCHEMA = "shockless-import-pipeline-v1";

export interface ImportSourceFingerprint {
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly skippedZeroByteFiles: readonly string[];
}

export interface ImportFingerprintProgress {
  readonly filesProcessed: number;
  readonly totalFiles: number;
  readonly bytesProcessed: number;
  readonly totalBytes: number;
}

interface SourceEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly size: number;
  readonly skippedZeroByteDirectorFile: boolean;
}

export async function fingerprintImportSource(
  sourceRoot: string,
  onProgress: (progress: ImportFingerprintProgress) => void = () => undefined,
): Promise<ImportSourceFingerprint> {
  const root = resolve(sourceRoot);
  const entries = await collectSourceEntries(root);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.skippedZeroByteDirectorFile ? 0 : entry.size), 0);
  const digest = createHash("sha256");
  digest.update(`${SOURCE_FINGERPRINT_SCHEMA}\n`);

  let filesProcessed = 0;
  let bytesProcessed = 0;
  let lastProgressAt = 0;
  const skippedZeroByteFiles: string[] = [];
  for (const entry of entries) {
    if (entry.skippedZeroByteDirectorFile) {
      skippedZeroByteFiles.push(entry.relativePath);
      digest.update(`${JSON.stringify(["skipped-zero-director", entry.relativePath])}\n`);
    } else {
      const fileDigest = await hashFile(entry.path, (bytes) => {
        bytesProcessed += bytes;
      });
      digest.update(`${JSON.stringify(["file", entry.relativePath, entry.size, fileDigest])}\n`);
    }
    filesProcessed += 1;
    const now = Date.now();
    if (filesProcessed === entries.length || filesProcessed % 10 === 0 || now - lastProgressAt >= 250) {
      lastProgressAt = now;
      onProgress({ filesProcessed, totalFiles: entries.length, bytesProcessed, totalBytes });
    }
  }

  return {
    fingerprint: `sha256:${digest.digest("hex")}`,
    fileCount: entries.length - skippedZeroByteFiles.length,
    byteCount: totalBytes,
    skippedZeroByteFiles,
  };
}

export async function fingerprintImportPipeline(files: readonly string[], identity: Record<string, unknown>): Promise<string> {
  const digest = createHash("sha256");
  digest.update(`${PIPELINE_FINGERPRINT_SCHEMA}\n`);
  digest.update(`${stableJson(identity)}\n`);
  const normalizedFiles = [...new Set(files.map((file) => resolve(file)))].sort(compareOrdinal);
  for (const file of normalizedFiles) {
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`Import pipeline dependency is not a file: ${file}`);
    digest.update(`${JSON.stringify([fileNameForFingerprint(file), info.size, await hashFile(file)])}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

async function collectSourceEntries(root: string): Promise<SourceEntry[]> {
  const collected: SourceEntry[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path);
      const relativePath = portablePath(relative(root, path));
      collected.push({
        path,
        relativePath,
        size: info.size,
        skippedZeroByteDirectorFile: info.size === 0 && isDirectorFile(entry.name),
      });
    }
  }
  return collected.sort((left, right) => compareOrdinal(left.relativePath, right.relativePath));
}

async function hashFile(path: string, onBytes: (bytes: number) => void = () => undefined): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    onBytes(bytes.length);
  }
  return digest.digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fileNameForFingerprint(path: string): string {
  const normalized = portablePath(path);
  const extractionMarker = "/resources/extraction/";
  const extractionIndex = normalized.lastIndexOf(extractionMarker);
  if (extractionIndex >= 0) return `extraction/${normalized.slice(extractionIndex + extractionMarker.length)}`;
  const compilerMarker = "/resources/compiler/";
  const compilerIndex = normalized.lastIndexOf(compilerMarker);
  if (compilerIndex >= 0) return `compiler/${normalized.slice(compilerIndex + compilerMarker.length)}`;
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirectorFile(name: string): boolean {
  return [".cct", ".cst", ".dcr", ".dir", ".dxr"].includes(extname(name).toLowerCase());
}
