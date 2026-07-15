<p align="center">
  <img src="https://i.dek.cx/gtkc.gif" alt="Shockless" width="640" />
</p>

<h1 align="center">Shockless</h1>

<p align="center">
  A modern, source-driven Director runtime and desktop companion for Habbo Origins.
</p>

<p align="center">
  <a href="https://github.com/deklol/Shockless/releases/latest"><img src="https://img.shields.io/github/v/release/deklol/Shockless?color=F2C230&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Platform: Windows" />
  <img src="https://img.shields.io/badge/language-TypeScript%207-3178C6" alt="Language: TypeScript 7" />
  <img src="https://img.shields.io/badge/runtime-Electron%20%2B%20PixiJS-47848F" alt="Runtime: Electron and PixiJS" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/deklol/Shockless?color=lightgrey" alt="License" /></a>
</p>

<p align="center">
  <a href="https://github.com/deklol/Shockless/releases/latest"><strong>Download</strong></a>
  &nbsp;&bull;&nbsp;
  <a href="https://deklol.github.io/Shockless/"><strong>Documentation</strong></a>
  &nbsp;&bull;&nbsp;
  <a href="https://deklol.github.io/Shockless/plugin-api.html"><strong>Plugin API</strong></a>
  &nbsp;&bull;&nbsp;
  <a href="https://discord.gg/rXgvjE4y3G"><strong>Discord</strong></a>
</p>

## What Is Shockless?

Shockless imports a user-supplied compiled client, builds a local playable profile, and runs it through a human-readable TypeScript runtime that implements the Director behavior the client expects. The Electron companion provides the game host, client importer, plugin manager, packet tools, multi-session controls, updater, and diagnostics around that runtime.

This repository includes both the desktop application and engine source under the GNU Affero General Public License v3.0. Playable client files are not bundled.

## How It Works

`Compiled Director client (.dcr/.cct)` &rarr; `Shockless ProjectorRays extraction` &rarr; `Lingo and cast metadata` &rarr; `generated TypeScript profile` &rarr; `Shockless Director runtime` &rarr; `PixiJS rendering and browser APIs` &rarr; `playable client inside Electron`

1. **Import and decompile:** the importer copies the selected client into an isolated profile and extracts its Director movies, casts, scripts, text fields, bitmap media, palettes, and manifests without modifying the original files.
2. **Generate executable TypeScript:** the profile compiler converts the extracted Lingo handlers into native TypeScript modules and builds registries that preserve the original cast, member, script, and asset identities.
3. **Run the Director model:** the Shockless Director runtime provides the movie, score, sprite, cast, member, event, list, networking, imaging, and eight-channel sound behavior expected by the generated client code.
4. **Render and present:** PixiJS presents Director sprites, text, bitmaps, inks, rooms, avatars, furniture, and UI through the browser renderer. The Electron app hosts that renderer and adds importing, plugins, sessions, packet tools, settings, diagnostics, and updates.
5. **Reuse the profile:** later launches use the generated local profile directly. Exact source and pipeline fingerprints allow an unchanged ready profile to skip unnecessary extraction and compilation work.

## Highlights

- Source-driven Director/Lingo compatibility with PixiJS rendering.
- Director-compatible audio with eight independent channels, queues, loops, offsets, fades, pan, volume, mute, ordinary client sounds, and source-controlled Trax playback.
- Guided client import with detailed stages, progress, timings, and reusable profiles.
- Persistent Origins realm selection for US / UK, Spain, and Brazil / Portugal, including complete regional boot data and service routing.
- Responsive game stage, zoom, session switching, custom cursor support, and performance controls.
- RuneLite-inspired plugin manager with schema-rendered panels and persistent settings.
- Sandboxed user plugins with documented room, user, furniture, chat, packet, session, storage, timer, and UI APIs.
- Readable packet log and backtick console with per-session filtering and raw packet injection.
- Visible and headless multi-session support with per-client command routing.
- Signed update metadata with SHA-256 verification and restart-to-install updates.
- TypeScript 7 toolchain with TypeScript 6 compatibility checks.

## Screenshots

![Main App Screenshot](https://i.dek.cx/fpp0.png)

<details>
<summary><strong>Decompiling</strong></summary>

![Decompiling](https://i.dek.cx/3k9p.png)

</details>

<details>
<summary><strong>Hotel View Select</strong></summary>

![Hotel View Select](https://i.dek.cx/h7qv.png)

</details>

<details>
<summary><strong>Resizable Client (Very buggy, especially with Hotel Views)</strong></summary>

![Resizable Client (Very buggy, especially with Hotel Views)](https://i.dek.cx/2iiv.png)

</details>

<details>
<summary><strong>Plugin Manager</strong></summary>

![Plugin Manager](https://i.dek.cx/x8nv.png)

</details>

<details>
<summary><strong>Settings</strong></summary>

![Settings](https://i.dek.cx/3329.png)

</details>

<details>
<summary><strong>Loading</strong></summary>

![Loading](https://i.dek.cx/w1pf.png)

</details>

<details>
<summary><strong>In-Game</strong></summary>

![In-Game](https://i.dek.cx/fpp0.png)

</details>

<details>
<summary><strong>About</strong></summary>

![About](https://i.dek.cx/cllp.png)

</details>

## Quick Start

1. Download the latest portable archive from [GitHub Releases](https://github.com/deklol/Shockless/releases/latest).
2. Extract the complete `Shockless` folder.
3. Run `Shockless.exe`.
4. Choose **Import/Build Client** and select a compatible compiled client folder or an existing Shockless profile.
5. Select the Origins realm to connect to. **US / UK (OUS)** is the default.
6. Wait for **Validate profile** to report that the profile is ready, then press **Start**.

Imported profiles remain local under the portable app's `clients/` folder and are reused on later launches.
The selected realm persists in Shockless settings and controls the regional game/MUS endpoints, boot casts, external variables, external text, gamedata, and public API data used by later launches.

## Build From Source

Requirements: Node.js 20 or newer, npm, and Windows for portable packaging.

```powershell
cd src/engine
npm install
npm run build
cd standalone
npm install
npm run compile

cd ../../shockless-app
npm install
npm run package:portable
```

The packaged app is written to `src/shockless-app/dist/portable/Shockless`. The public source includes a minimal generated registry placeholder so a clean checkout can build before a user imports a client.

The verified Shockless ProjectorRays executable is included for normal builds. Its MPL-2.0 source is under `src/engine/native/projectorrays`. Contributors with MSYS2 UCRT64 and its native dependencies can rebuild it from `src/shockless-app` with `npm run build:projectorrays`.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/shockless-app` | Electron/React app, relay, plugin host, updater, and packaging |
| `src/engine` | Director-compatible engine and standalone profile importer |
| `src/engine/native/projectorrays` | Source for the deterministic Shockless import extractor |
| `docs` | Self-contained offline HTML documentation and plugin API |

## Documentation

- [Documentation Home](https://deklol.github.io/Shockless/)
- [Getting Started](https://deklol.github.io/Shockless/getting-started.html)
- [Building From Source](https://deklol.github.io/Shockless/building-from-source.html)
- [Plugin Authoring](https://deklol.github.io/Shockless/plugin-authoring.html)
- [Complete Plugin API](https://deklol.github.io/Shockless/plugin-api.html)
- [Console Commands](https://deklol.github.io/Shockless/console-commands.html)
- [Multi-Client Sessions](https://deklol.github.io/Shockless/multi-client.html)

## Credits

Shockless uses ProjectorRays resources in its Director/Shockwave import workflow. [ProjectorRays](https://github.com/ProjectorRays/ProjectorRays) is maintained by the ProjectorRays project.
Shockless used [LibreShockwave](https://github.com/Quackster/LibreShockwave), [ScummVM](https://github.com/scummvm/scummvm) & [DirPlayer](https://github.com/igorlira/dirplayer-rs) as a source of logic reference & inspiration for this project, theirs will be updated a lot more than mine. Please consider supporting them over Shockless.

## License

Shockless is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Shockless is not affiliated with, endorsed, sponsored, or specifically approved by Sulake Corporation Oy or its affiliates.
