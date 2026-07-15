import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const standaloneRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(standaloneRoot, "..");
const sourceCompiler = join(repoRoot, "tools", "profile-script-compiler.ts");
const bundledCompiler = join(standaloneRoot, "resources", "compiler", "profile-script-compiler.mjs");

mkdirSync(join(standaloneRoot, "resources", "compiler"), { recursive: true });

if (!existsSync(sourceCompiler)) {
  if (existsSync(bundledCompiler)) {
    console.log("Profile script compiler source not present; using bundled compiler resource.");
    process.exit(0);
  }
  throw new Error(`Profile script compiler source was not found: ${sourceCompiler}`);
}

await build({
  entryPoints: [sourceCompiler],
  outfile: bundledCompiler,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  sourcemap: false,
  banner: {
    js:
      "import { createRequire as __profileCreateRequire } from 'node:module'; " +
      "import { fileURLToPath as __profileFileURLToPath } from 'node:url'; " +
      "import { dirname as __profileDirname } from 'node:path'; " +
      "const require = __profileCreateRequire(import.meta.url); " +
      "const __filename = __profileFileURLToPath(import.meta.url); " +
      "const __dirname = __profileDirname(__filename);",
  },
});

console.log("Profile script compiler bundled.");
