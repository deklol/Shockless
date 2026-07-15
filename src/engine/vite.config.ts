import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, Plugin } from "vite";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const engineConfig = JSON.parse(readFileSync(join(repoRoot, "engine.config.json"), "utf8")) as {
  originsSourceRoot: string;
  originsClientRoot: string;
  runtimeDataRoot: string;
  decodedAssetsRoot: string;
};

/**
 * Serves the read-only donor data trees under /origins-data/ so the browser
 * runtime can fetch manifests, source casts, and decoded bitmaps without
 * copying gigabytes into this repo.
 */
function originsDataPlugin(): Plugin {
  const roots: Record<string, string[]> = {
    "runtime-data": [join(repoRoot, "generated/runtime-data"), engineConfig.runtimeDataRoot],
    source: [engineConfig.originsSourceRoot],
    client: [engineConfig.originsClientRoot],
    assets: [join(repoRoot, "generated/assets"), engineConfig.decodedAssetsRoot],
  };
  return {
    name: "origins-data",
    configureServer(server) {
      server.middlewares.use("/origins-data", (req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]!);
        const [, rootKey, ...rest] = url.split("/");
        const candidates = rootKey ? roots[rootKey] : undefined;
        if (!candidates || rest.length === 0) {
          next();
          return;
        }
        const match = candidates
          .map((root) => ({ root, filePath: normalize(join(root, ...rest)) }))
          .find(({ root, filePath }) => filePath.startsWith(normalize(root)) && existsSync(filePath));
        if (!match) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const filePath = match.filePath;
        const body = readFileSync(filePath);
        if (filePath.endsWith(".json")) {
          res.setHeader("content-type", "application/json");
        } else if (filePath.endsWith(".png")) {
          res.setHeader("content-type", "image/png");
        } else {
          res.setHeader("content-type", "application/octet-stream");
        }
        res.end(body);
      });
    },
  };
}

function executableScriptManifestPlugin(): Plugin {
  return {
    name: "origins-executable-script-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "origins-executable-scripts.json",
        source: `${JSON.stringify({ generatedAt: new Date().toISOString(), versions: discoverExecutableScriptVersions() }, null, 2)}\n`,
      });
    },
  };
}

function discoverExecutableScriptVersions(): string[] {
  const versions = new Set<string>();
  if (existsSync(join(repoRoot, "generated", "scripts", "registry.ts"))) {
    versions.add("release306");
  }
  return [...versions].sort(compareReleaseVersions);
}

function compareReleaseVersions(left: string, right: string): number {
  const leftBuild = Number(/^release(\d+)$/i.exec(left)?.[1] ?? 0);
  const rightBuild = Number(/^release(\d+)$/i.exec(right)?.[1] ?? 0);
  if (leftBuild !== rightBuild) return leftBuild - rightBuild;
  return left.localeCompare(right);
}

export default defineConfig({
  plugins: [originsDataPlugin(), executableScriptManifestPlugin()],
  resolve: {
    alias: {
      "@director": join(repoRoot, "src/director"),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    watch: {
      ignored: [
        "**/.git/**",
        "**/ref/**",
        "**/tmp/**",
        "**/standalone/release/**",
        "**/standalone/dist/**",
        "**/standalone/.vite/**",
      ],
    },
  },
});
