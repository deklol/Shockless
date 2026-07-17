import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Steam bridge build skipped: the native helper targets Windows x86.");
  process.exit(0);
}

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(workspace, "native", "steam-bridge", "SteamBridge.cs");
const output = join(workspace, "native", "steam-bridge", "bin", "SteamBridge.exe");
const windir = process.env.WINDIR || process.env.SystemRoot;
if (!windir) throw new Error("Windows directory is unavailable; cannot locate the .NET C# compiler.");

const candidates = [
  join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
];
let compiler = null;
for (const candidate of candidates) {
  try {
    await stat(candidate);
    compiler = candidate;
    break;
  } catch {
    // Continue to the next standard .NET Framework compiler.
  }
}
if (!compiler) throw new Error(".NET Framework 4 C# compiler was not found.");

await mkdir(dirname(output), { recursive: true });
await run(compiler, [
  "/nologo",
  "/target:winexe",
  "/platform:x86",
  "/optimize+",
  `/out:${output}`,
  source,
]);
console.log(JSON.stringify({ steamBridge: output }, null, 2));

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: workspace, windowsHide: true, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Steam bridge compiler exited with code ${code ?? "unknown"}.`));
    });
  });
}
