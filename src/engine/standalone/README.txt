# Shockless Engine Standalone

This folder is an isolated Windows-first Electron launcher. It does not replace
or edit the root Vite browser app.

## What It Does Now

- Shows a first-run launcher and profile import flow.
- Stores new profiles under `clients/<profile-id>/` beside the unpacked EXE
  in packaged builds, or `standalone/clients/<profile-id>/` in development.
  Legacy `%APPDATA%/ShocklessEngine/profiles` profiles remain readable for
  transition.
- Copies the selected compiled client into a profile cache without modifying
  the source folder.
- Downloads required Sulek `external_variables.txt` and `external_texts.txt`
  build metadata when the compiled folder does not contain those files.
- Skips invalid zero-byte Director cast files and records them in the import
  report.
- Runs bundled ProjectorRays into the profile extraction directory.
- Generates profile-local runtime data, bitmap assets, script-member metadata,
  and executable profile scripts for imported Origins builds.
- Keeps imports atomic: a failed import preserves a `.failed-*` diagnostic
  folder and leaves the previous active profile intact.
- Supports optional local fast-login data using Electron `safeStorage`.
- Starts a local static/profile server and Origins relay for launchable
  profiles.
- Packages a Windows NSIS installer and unpacked app under `release/`.
- Launches fixed-stage standalone play with `?standalone=1`, hiding the
  browser dev chrome and keeping the Director canvas at exact 960x540.
- Provides a hidden Playwright smoke probe that launches the packaged app,
  clicks Play, captures logs, and closes its own Electron process.

## Current Engine Boundary

Standalone profiles are versioned and portable. The EXE ships the engine and a
release306 baseline for the existing browser/dev workflow. Newer compiled
Origins clients are not bundled into the EXE. Instead, import generates a
profile-local executable script registry at
`clients/<profile-id>/scripts/executable/registry.js`, and the game boot path
loads that registry dynamically for `profileVersion=<versionId>`.

The launcher enables Play only when the selected profile has complete required
profile data, materialized referenced assets, and executable profile scripts.
Silent fallback to release306 scripts for a newer profile is not allowed.

## Commands

From this folder:

```powershell
npm install
npm run standalone:build
npm run standalone:dev
npm run standalone:smoke
```

Profile import without Electron:

```powershell
npm run profile:import -- --client-root F:\path\to\compiled\320
```

For a dry import that skips ProjectorRays:

```powershell
npm run profile:import -- --client-root F:\path\to\compiled\320 --skip-projectorrays
```

The built installer is:

```text
release\ShocklessEngine-Standalone-0.1.0-x64.exe
```

The unpacked executable for smoke testing without installing is:

```text
release\win-unpacked\Shockless Engine.exe
```

The hidden smoke probe writes:

```text
..\tmp\standalone-smoke\result.json
..\tmp\standalone-smoke\page.log
..\tmp\standalone-smoke\game.png
```

For a longer capture:

```powershell
$env:ORIGINS_SMOKE_WAIT_MS=120000
npm run standalone:smoke
Remove-Item Env:ORIGINS_SMOKE_WAIT_MS
```

On this Windows workspace the build wrapper stages electron-builder output in
`%TEMP%` first, then copies the finished installer and unpacked app into
`release/`. That avoids a Windows rename lock seen when electron-builder wrote
directly to the `F:` drive.

## Resize Status

Default standalone play is fixed 960x540. The launcher exposes the experimental
resizable presentation checkbox, but right-side anchoring for infostand/hand,
bottom toolbar policies, inverse pointer mapping, and source-window aware
layout rules still need a dedicated audited pass before resize should be
considered correct.

## Attribution

ProjectorRays is credited as the local Director/Shockwave decompiler used by
the standalone importer.

## Licence

The standalone source is licensed under AGPL-3.0-or-later. See the repository
root `LICENSE` file for the full terms.
