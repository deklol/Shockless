/**
 * Generates TypeScript modules from ProjectorRays Lingo scripts.
 *
 * Usage:
 *   npm run lingo:generate -- --filter hh_room_pool
 *   npm run lingo:generate -- --source-root <projectorrays-root> --out-root <out>
 *   npm run lingo:generate
 *
 * A full run writes generated/scripts/registry.ts. Filtered runs leave the
 * registry untouched so a narrow regeneration cannot remove unrelated casts.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLingoScript } from "../src/lingo/parser";
import { parseScriptFileName } from "../src/lingo/analysis/ProjectIndex";
import { generateScript } from "../src/lingo/codegen/generate";

interface EngineConfig {
  originsSourceRoot: string;
}

interface RegistryEntry {
  importPath: string;
  constName: string;
  castFile: string;
  scriptType: string;
  memberNumber: number | null;
  memberName: string | null;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(repoRoot, "engine.config.json"), "utf8")) as EngineConfig;

function collectLingoFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry.toLowerCase().endsWith(".ls")) {
        result.push(full);
      }
    }
  }
  return result.sort();
}

function argValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function filterFiles(files: string[], filter: string | null): string[] {
  if (!filter) return files;
  const needles = filter
    .toLowerCase()
    .split(",")
    .map((needle) => needle.trim())
    .filter(Boolean);
  if (needles.length === 0) throw new Error("--filter requires at least one non-empty pattern");
  return files.filter((file) => {
    const normalized = file.toLowerCase().replace(/\\/g, "/");
    return needles.some((needle) => normalized.includes(needle));
  });
}

function writeRegistry(outRoot: string, registryEntries: readonly RegistryEntry[]): void {
  const lines: string[] = ["// Generated registry; do not edit.", ""];
  for (const entry of registryEntries) {
    lines.push(`import * as ${entry.constName} from ${JSON.stringify(entry.importPath)};`);
  }
  lines.push("");
  lines.push("export const generatedScripts = [");
  for (const entry of registryEntries) {
    lines.push(
      `  { castFile: ${JSON.stringify(entry.castFile)}, scriptType: ${JSON.stringify(entry.scriptType)}, ` +
        `memberNumber: ${JSON.stringify(entry.memberNumber)}, memberName: ${JSON.stringify(entry.memberName)}, ` +
        `module: ${entry.constName} },`,
    );
  }
  lines.push("];");
  writeFileSync(join(outRoot, "registry.ts"), lines.join("\n"));
}

const args = process.argv.slice(2);
const filter = argValue(args, "--filter");
const sourceRoot = argValue(args, "--source-root") ?? config.originsSourceRoot;
const outRoot = argValue(args, "--out-root") ?? join(repoRoot, "generated", "scripts");
const checkOnly = args.includes("--check");

const files = filterFiles(collectLingoFiles(sourceRoot), filter);
const failures: { file: string; error: string }[] = [];
const registryEntries: RegistryEntry[] = [];
let written = 0;

for (const file of files) {
  const relativePath = relative(sourceRoot, file).replace(/\\/g, "/");
  try {
    const script = parseLingoScript(readFileSync(file, "utf8"), relativePath);
    const nameInfo = parseScriptFileName(relativePath);
    const generated = generateScript(script, {
      scriptName: nameInfo.memberName,
      scriptType: nameInfo.scriptType,
      runtimeImport: "@director",
    });
    if (checkOnly) {
      written += 1;
      continue;
    }
    const outPath = join(
      outRoot,
      relativePath
        .replace(/\.ls$/i, ".ts")
        .replace(/casts\//, "")
        .replace(/[^A-Za-z0-9/._-]/g, "_"),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, generated.code);
    const importPath = "./" + relative(outRoot, outPath).replace(/\\/g, "/").replace(/\.ts$/, "");
    const constName = `s${registryEntries.length}`;
    registryEntries.push({
      importPath,
      constName,
      castFile: nameInfo.castFile,
      scriptType: nameInfo.scriptType,
      memberNumber: nameInfo.memberNumber,
      memberName: nameInfo.memberName,
    });
    written += 1;
  } catch (error) {
    failures.push({
      file: relativePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

if (!checkOnly && registryEntries.length > 0 && !filter) {
  writeRegistry(outRoot, registryEntries);
} else if (!checkOnly && filter) {
  console.log("filtered generation: registry.ts unchanged; run without --filter to rebuild the full registry");
}

console.log(`generated ${written}/${files.length} scripts, ${failures.length} failures`);
for (const failure of failures.slice(0, 10)) {
  console.log(`  FAIL ${failure.file}: ${failure.error}`);
}
if (failures.length > 0) process.exitCode = 1;
