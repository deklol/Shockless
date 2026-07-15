import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  UpdateManager,
  buildPowerShellInstallerLauncherScript,
  replaceableInstallerPath,
  validateStagedUpdatePayload,
} from "../src/main/updateService";
import {
  isNewerAppVersion,
  publicUpdatePathIsForbidden,
  portableInstallPathIsPreserved,
  updatePercent,
  validateSafeZipEntryName,
  validateUpdateManifest,
} from "../src/shared/update";

test("update version comparison accepts newer stable versions only", () => {
  assert.equal(isNewerAppVersion("0.1.1", "0.1.0"), true);
  assert.equal(isNewerAppVersion("v0.2.0", "0.1.9"), true);
  assert.equal(isNewerAppVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerAppVersion("0.0.9", "0.1.0"), false);
  assert.equal(isNewerAppVersion("0.2.0-beta.1", "0.2.0"), false);
});

test("update manifest validation rejects unsafe assets and accepts a stable portable zip", () => {
  const valid = validateUpdateManifest({
    schemaVersion: 1,
    version: "0.2.0",
    channel: "stable",
    platform: "win32-x64",
    assetName: "shockless-portable-windows.zip",
    sha256: "a".repeat(64),
    size: 1024,
    releaseUrl: "https://github.com/deklol/Shockless/releases/tag/v0.2.0",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.manifest?.version, "0.2.0");

  assert.equal(validateUpdateManifest({ ...valid.manifest, assetName: "../bad.zip" }).ok, false);
  assert.equal(validateUpdateManifest({ ...valid.manifest, sha256: "abc" }).ok, false);
  assert.equal(validateUpdateManifest({ ...valid.manifest, releaseUrl: "http://github.com/deklol/Shockless" }).ok, false);
  assert.equal(validateUpdateManifest({ ...valid.manifest, channel: "beta" }).ok, false);
});

test("update path checks reject traversal, clients, and private files", () => {
  assert.equal(validateSafeZipEntryName("Shockless/resources/app/package.json").ok, true);
  assert.equal(validateSafeZipEntryName("../outside.txt").ok, false);
  assert.equal(validateSafeZipEntryName("C:/outside.txt").ok, false);
  assert.equal(publicUpdatePathIsForbidden("clients/release324/profile.json"), true);
  assert.equal(publicUpdatePathIsForbidden("data/profile/Local Storage/file"), false);
  assert.equal(publicUpdatePathIsForbidden("goal.md"), true);
  assert.equal(publicUpdatePathIsForbidden("resources/app/dist/main/main.js"), false);
  assert.equal(portableInstallPathIsPreserved("data/Shockless/app-preferences.json"), true);
  assert.equal(portableInstallPathIsPreserved("clients/release326/profile.json"), true);
  assert.equal(portableInstallPathIsPreserved("resources/app/package.json"), false);
  assert.equal(updatePercent(50, 200), 25);
});

test("updater ignores same or older GitHub releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-update-old-"));
  try {
    const manager = new UpdateManager({
      appDataPath: join(root, "data"),
      currentVersion: "0.1.0",
      installDir: join(root, "portable"),
      executablePath: join(root, "portable", "Shockless.exe"),
      isPackaged: false,
      fetchImpl: mockGitHubFetch("0.0.9") as typeof fetch,
    });
    const state = await manager.checkForUpdates();
    assert.equal(state.status, "up-to-date");
    assert.equal(state.available?.version, "0.0.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updater reports newer GitHub releases as available", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-update-new-"));
  try {
    const manager = new UpdateManager({
      appDataPath: join(root, "data"),
      currentVersion: "0.1.0",
      installDir: join(root, "portable"),
      executablePath: join(root, "portable", "Shockless.exe"),
      isPackaged: false,
      fetchImpl: mockGitHubFetch("0.1.1") as typeof fetch,
    });
    const state = await manager.checkForUpdates();
    assert.equal(state.status, "available");
    assert.equal(state.available?.version, "0.1.1");
    assert.equal(state.available?.assetName, "shockless-portable-windows.zip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged update validation requires portable payload and rejects imported clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-stage-"));
  try {
    const payload = join(root, "Shockless");
    writeStagedPayload(payload);
    let result = await validateStagedUpdatePayload(root);
    assert.equal(result.ok, true);
    assert.equal(result.payloadRoot, payload);

    mkdirSync(join(payload, "clients", "release324"), { recursive: true });
    writeFileSync(join(payload, "clients", "release324", "profile.json"), "{}", "utf8");
    result = await validateStagedUpdatePayload(root);
    assert.equal(result.ok, false);
    assert.match(result.message, /forbidden path/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged update validation does not flag updater scanner implementation text", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-stage-self-scan-"));
  try {
    const payload = join(root, "Shockless");
    writeStagedPayload(payload);
    writeFileSync(
      join(payload, "resources/app/dist/main/main/updateService.js"),
      'const PRIVATE_ENDPOINT_ENV_NAME = ["HABBPY", "V4", "DISCORD", "WEB" + "HOOK", "URL"].join("_");\n',
      "utf8",
    );

    const result = await validateStagedUpdatePayload(root);
    assert.equal(result.ok, true);
    assert.equal(result.payloadRoot, payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged update validation still rejects real private text needles", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-stage-private-text-"));
  try {
    const payload = join(root, "Shockless");
    writeStagedPayload(payload);
    const forbiddenEnvName = ["HABBPY", "V4", "DISCORD", "WEB" + "HOOK", "URL"].join("_");
    writeFileSync(join(payload, "resources/app/dist/main/main/leak.js"), forbiddenEnvName, "utf8");

    const result = await validateStagedUpdatePayload(root);
    assert.equal(result.ok, false);
    assert.match(result.message, /private\/local text needle/i);
    assert.match(result.message, /leak\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged update validation accepts one-cycle legacy portable payload names", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-stage-legacy-"));
  try {
    const payload = join(root, "HabbpyV4");
    writeStagedPayload(payload, "Habbpy v4.exe");
    const result = await validateStagedUpdatePayload(root);
    assert.equal(result.ok, true);
    assert.equal(result.payloadRoot, payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer replacement rules preserve user plugin folders and manage bundled plugin roots only", () => {
  assert.equal(replaceableInstallerPath("resources/app/package.json"), true);
  assert.equal(replaceableInstallerPath("plugins/welcome-message/plugin.js"), true);
  assert.equal(replaceableInstallerPath("plugins/_premade-modules/room/plugin.js"), true);
  assert.equal(replaceableInstallerPath("plugins/my-private-addon/plugin.js"), false);
  assert.equal(replaceableInstallerPath("data/Shockless/app-preferences.json"), false);
});

test("PowerShell update launcher starts installer from spaced paths", async (context) => {
  if (process.platform !== "win32") {
    context.skip("PowerShell launcher regression is Windows-specific.");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "habbpy v4 update launcher "));
  try {
    const launcherPath = join(root, "launch update.ps1");
    const installerPath = join(root, "install update.ps1");
    const planPath = join(root, "install plan.json");
    const logPath = join(root, "install log.txt");
    writeFileSync(launcherPath, buildPowerShellInstallerLauncherScript(), "utf8");
    writeFileSync(planPath, "{}", "utf8");
    writeFileSync(
      installerPath,
      [
        "param([string]$PlanPath,[string]$LogPath)",
        'Add-Content -LiteralPath $LogPath -Value "External updater bootstrap started." -Encoding UTF8',
        'Add-Content -LiteralPath $LogPath -Value "External updater installer ready." -Encoding UTF8',
        'Add-Content -LiteralPath $LogPath -Value "Install complete." -Encoding UTF8',
      ].join("\n"),
      "utf8",
    );

    const code = await spawnPowerShell([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-InstallerScriptPath",
      installerPath,
      "-PlanPath",
      planPath,
      "-LogPath",
      logPath,
      "-WorkingDirectory",
      root,
    ]);
    assert.equal(code, 0);

    const log = await waitForTextFile(logPath, "Install complete.");
    assert.match(log, /External updater launcher started\./);
    assert.match(log, /External updater installer process launched\./);
    assert.match(log, /External updater installer ready\./);
    assert.match(log, /Install complete\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mockGitHubFetch(version: string): typeof fetch {
  const manifest = {
    schemaVersion: 1,
    version,
    channel: "stable",
    platform: "win32-x64",
    assetName: "shockless-portable-windows.zip",
    sha256: "b".repeat(64),
    size: 4096,
    releaseUrl: `https://github.com/deklol/Shockless/releases/tag/v${version}`,
  };
  const release = {
    tag_name: `v${version}`,
    html_url: manifest.releaseUrl,
    draft: false,
    prerelease: false,
    published_at: "2026-06-30T00:00:00.000Z",
    assets: [
      {
        name: "update.json",
        browser_download_url: "https://github.com/deklol/Shockless/releases/download/test/update.json",
        size: 100,
      },
      {
        name: manifest.assetName,
        browser_download_url: "https://github.com/deklol/Shockless/releases/download/test/shockless-portable-windows.zip",
        size: manifest.size,
      },
    ],
  };
  return (async (url: string | URL | Request) => {
    const text = String(url);
    const body = text.endsWith("update.json") ? manifest : release;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function writeStagedPayload(root: string, executableName = "Shockless.exe"): void {
  const files = [
    executableName,
    "resources/app/package.json",
    "resources/app/dist/main/main/main.js",
    "resources/app/dist/main/main/updateInstallerHelper.js",
    "resources/engine/dist/index.html",
    "resources/relay/origins-relay.mjs",
  ];
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "ok", "utf8");
  }
}

function spawnPowerShell(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function waitForTextFile(filePath: string, needle: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${needle} in ${filePath}`);
}
