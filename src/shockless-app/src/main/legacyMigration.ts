import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canonicalWebviewPartitionName } from "../shared/legacyCompatibility.js";

export function migrateLegacyChromiumPartitions(userDataRoot: string): void {
  const partitionsRoot = join(userDataRoot, "Partitions");
  if (!existsSync(partitionsRoot)) return;

  for (const entry of readdirSync(partitionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const canonicalName = canonicalWebviewPartitionName(entry.name);
    if (!canonicalName) continue;
    const source = join(partitionsRoot, entry.name);
    const target = join(partitionsRoot, canonicalName);
    if (existsSync(target)) continue;
    renameSync(source, target);
  }
}
