import "./DirectorAudioHarness.css";

import type { MovieManifest } from "@director/Movie";
import { DirectorMovie } from "@director/Movie";
import { CastMember, CastRegistry } from "@director/members";
import type { GeneratedScriptModule } from "@director/runtimeObjects";
import { ScriptInstance } from "@director/Runtime";
import {
  LINGO_VOID,
  LingoList,
  LingoPropList,
  LingoSymbol,
  type LingoValue,
} from "@director/values";
import type { GeneratedScriptBundle, GeneratedScriptEntry } from "../bootstrap/ProfileRuntimeLoader";

const TRAX_POLL_INTERVAL_MS = 1_500;
const TRAX_HARNESS_STACK_INDEX = 32_000;

interface SoundInventoryEntry {
  readonly key: string;
  readonly castName: string;
  readonly castNumber: number;
  readonly memberNumber: number;
  readonly memberName: string;
  readonly durationMs: number;
  readonly codec: string;
  readonly container: string;
}

export interface DirectorAudioHarnessOptions {
  readonly movie: DirectorMovie;
  readonly members: CastRegistry;
  readonly manifest: MovieManifest;
  readonly generatedScripts: GeneratedScriptBundle;
  readonly profileId: string;
}

export interface DirectorAudioHarnessHandle {
  dispose(): void;
}

const identityModule: GeneratedScriptModule = {
  scriptName: "Shockless Audio Harness Identity",
  scriptType: "parent",
  scriptProperties: [],
  scriptGlobals: [],
  handlers: {
    getid() {
      return "shockless audio harness song player";
    },
  },
};

export function mountDirectorAudioHarness(options: DirectorAudioHarnessOptions): DirectorAudioHarnessHandle {
  const inventory = soundInventory(options.manifest);
  if (inventory.length === 0) {
    throw new Error(`Profile ${options.profileId} contains no authored Director sound members.`);
  }

  const root = document.createElement("aside");
  root.className = "director-audio-harness";
  root.setAttribute("aria-label", "Director audio diagnostics");
  root.innerHTML = harnessMarkup(options.profileId, inventory.length);
  document.body.appendChild(root);

  // The harness is an HTML diagnostic surface, not part of the Director stage.
  // Keep its keyboard, pointer, and wheel events away from the game input path.
  for (const eventName of ["keydown", "keyup", "mousedown", "mouseup", "click", "wheel", "pointerdown", "pointerup"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }

  const status = required<HTMLElement>(root, "[data-audio-status]");
  const primarySelect = required<HTMLSelectElement>(root, "[data-sound-primary]");
  const queuedSelect = required<HTMLSelectElement>(root, "[data-sound-queued]");
  const traxASelect = required<HTMLSelectElement>(root, "[data-trax-a]");
  const traxBSelect = required<HTMLSelectElement>(root, "[data-trax-b]");
  const inventoryByKey = new Map(inventory.map((entry) => [entry.key, entry]));
  for (const select of [primarySelect, queuedSelect, traxASelect, traxBSelect]) {
    populateSoundSelect(select, inventory);
  }
  selectPreferred(primarySelect, inventory, (entry) => entry.memberName !== "sound_machine_sample_0");
  selectPreferred(queuedSelect, inventory, (entry) => entry.key !== primarySelect.value);
  selectPreferred(traxASelect, inventory, (entry) => entry.memberName === "sound_machine_sample_1");
  selectPreferred(traxBSelect, inventory, (entry) => entry.memberName === "sound_machine_sample_2");

  const trax = new ImportedTraxHarness(options.movie, options.members, options.generatedScripts);
  let disposed = false;
  let snapshotTimer = 0;

  const report = (message: string, level: "ready" | "error" = "ready"): void => {
    status.textContent = message;
    status.dataset.level = level;
  };

  const execute = async (label: string, action: () => LingoValue | void | Promise<LingoValue | void>): Promise<void> => {
    try {
      await options.movie.resumeAudio();
      const result = await action();
      report(`${label}${result === undefined || result === LINGO_VOID ? "" : `: ${String(result)}`}`);
      renderSoundSnapshot(root, options.movie);
    } catch (error) {
      report(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const channelNumber = (): number => clampInt(numberValue(root, "[data-channel]", 1), 1, 8);
  const selectedEntry = (select: HTMLSelectElement): SoundInventoryEntry => {
    const entry = inventoryByKey.get(select.value);
    if (!entry) throw new Error("Select an imported sound member first.");
    return entry;
  };
  const selectedMember = (select: HTMLSelectElement): CastMember =>
    materializeSoundMember(options.members, selectedEntry(select));
  const playEntry = (select: HTMLSelectElement): LingoPropList =>
    directorSoundEntry(selectedMember(select), soundEntryOptions(root));

  bind(root, "[data-command='play']", () => execute("Play", () => options.movie.audioCommand(channelNumber(), "play", [playEntry(primarySelect)])));
  bind(root, "[data-command='queue']", () => execute("Queue", () => options.movie.audioCommand(channelNumber(), "queue", [playEntry(queuedSelect)])));
  bind(root, "[data-command='play-queue']", () => execute("Two-item queue", () => {
    const channel = channelNumber();
    options.movie.audioCommand(channel, "play", [playEntry(primarySelect)]);
    return options.movie.audioCommand(channel, "queue", [playEntry(queuedSelect)]);
  }));
  bind(root, "[data-command='play-four']", () => execute("Channels 1-4", () => playOnChannels(options.movie, playEntry(primarySelect), 4)));
  bind(root, "[data-command='play-eight']", () => execute("Channels 1-8", () => playOnChannels(options.movie, playEntry(primarySelect), 8)));

  for (const command of ["pause", "rewind", "playnext", "breakloop", "stop"] as const) {
    bind(root, `[data-command='${command}']`, () => execute(command, () => options.movie.audioCommand(channelNumber(), command, [])));
  }
  bind(root, "[data-command='fadein']", () => execute("Fade in", () =>
    options.movie.audioCommand(channelNumber(), "fadein", [numberValue(root, "[data-fade-ms]", 1_000)])));
  bind(root, "[data-command='fadeout']", () => execute("Fade out", () =>
    options.movie.audioCommand(channelNumber(), "fadeout", [numberValue(root, "[data-fade-ms]", 1_000)])));
  bind(root, "[data-command='fadeto']", () => execute("Fade to", () =>
    options.movie.audioCommand(channelNumber(), "fadeto", [
      numberValue(root, "[data-fade-volume]", 128),
      numberValue(root, "[data-fade-ms]", 1_000),
    ])));

  bind(root, "[data-apply-channel]", () => execute("Channel properties", () => {
    const sound = options.movie.runtime.call("sound", [channelNumber()]);
    options.movie.runtime.setProp(sound, "volume", clampInt(numberValue(root, "[data-volume]", 255), 0, 255));
    options.movie.runtime.setProp(sound, "pan", clampInt(numberValue(root, "[data-pan]", 0), -100, 100));
  }));
  bind(root, "[data-apply-global]", () => execute("Global sound properties", () => {
    options.movie.runtime.setTheProp("soundenabled", checked(root, "[data-sound-enabled]") ? 1 : 0);
    options.movie.runtime.setTheProp("soundlevel", clampInt(numberValue(root, "[data-sound-level]", 7), 0, 7));
  }));

  bind(root, "[data-trax-start]", () => execute("Imported Trax song", () => trax.start([
    { member: selectedMember(traxASelect), channel: 1, loops: clampInt(numberValue(root, "[data-trax-loops-a]", 1), 1, 64) },
    { member: selectedMember(traxBSelect), channel: 2, loops: clampInt(numberValue(root, "[data-trax-loops-b]", 1), 1, 64) },
  ], checked(root, "[data-trax-loop]"))));
  bind(root, "[data-trax-stop]", () => execute("Stop imported Trax song", () => trax.stop()));
  bind(root, "[data-trax-preview]", () => execute("Trax sample preview", () => trax.preview(selectedMember(traxASelect))));
  bind(root, "[data-trax-preview-stop]", () => execute("Stop Trax preview", () => trax.stopPreview()));

  bind(root, "[data-trace-toggle]", () => {
    const enabled = checked(root, "[data-trace-toggle]");
    options.movie.setAudioTraceEnabled(enabled);
    report(`Audio trace ${enabled ? "enabled" : "disabled"}.`);
  }, "change");
  bind(root, "[data-trace-clear]", () => {
    options.movie.clearAudioTrace();
    report("Audio trace cleared.");
  });
  bind(root, "[data-trace-download]", () => {
    downloadJson(options.movie.exportAudioTrace(), `shockless-audio-trace-${timestampForFile()}.json`);
    report(`Exported ${options.movie.audioTraceSnapshot().length} trace events.`);
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(snapshotTimer);
    trax.dispose();
    options.movie.setAudioTraceEnabled(false);
    root.remove();
  };
  bind(root, "[data-close]", dispose);

  renderSoundSnapshot(root, options.movie);
  snapshotTimer = window.setInterval(() => renderSoundSnapshot(root, options.movie), 125);
  report(`Ready: ${inventory.length} authored sounds; imported Trax player ${trax.available ? "available" : "unavailable"}.`);
  return { dispose };
}

class ImportedTraxHarness {
  private readonly songPlayerEntry: GeneratedScriptEntry | null;
  private player: ScriptInstance | null = null;
  private refillTimer = 0;

  constructor(
    private readonly movie: DirectorMovie,
    private readonly members: CastRegistry,
    generatedScripts: GeneratedScriptBundle,
  ) {
    this.songPlayerEntry = findTraxSongPlayer(generatedScripts);
  }

  get available(): boolean {
    return this.songPlayerEntry !== null;
  }

  start(
    samples: readonly { member: CastMember; channel: number; loops: number }[],
    loop: boolean,
  ): LingoValue {
    this.stop();
    const player = this.ensurePlayer();
    this.indexSongMembers(samples.map((sample) => sample.member));
    const soundRows = samples.map(({ member, channel, loops }) =>
      LingoPropList.fromPairs([
        [LingoSymbol.for("name"), member.name],
        [LingoSymbol.for("loops"), loops],
        [LingoSymbol.for("channel"), channel],
      ]));
    const songData = LingoPropList.fromPairs([
      [LingoSymbol.for("sounds"), new LingoList(soundRows)],
      [LingoSymbol.for("channelList"), new LingoList(samples.map((sample) => sample.channel))],
    ]);

    const started = this.movie.runtime.callMethod(player, "startsong", [TRAX_HARNESS_STACK_INDEX, songData, loop ? 1 : 0]);
    // The source schedules these through Object Manager timeout identifiers.
    // This isolated harness instance is deliberately not registered in the
    // game's Object Manager, so invoke the same imported handlers directly and
    // remove their named timeout requests before polling checkLoopData.
    this.movie.runtime.callMethod(player, "queuechannels", []);
    this.movie.runtime.callMethod(player, "startchannels", []);
    this.movie.runtime.callMethod(player, "deconstruct", []);
    this.refillTimer = window.setInterval(() => {
      if (!this.player) return;
      this.movie.runtime.callMethod(this.player, "checkloopdata", []);
    }, TRAX_POLL_INTERVAL_MS);
    return started;
  }

  stop(): LingoValue {
    window.clearInterval(this.refillTimer);
    this.refillTimer = 0;
    if (!this.player) return 1;
    let result: LingoValue = 1;
    try {
      result = this.movie.runtime.callMethod(this.player, "stopsong", [TRAX_HARNESS_STACK_INDEX, 1]);
      this.movie.runtime.callMethod(this.player, "deconstruct", []);
    } finally {
      this.player = null;
    }
    return result;
  }

  preview(member: CastMember): LingoValue {
    const player = this.ensurePlayer();
    const params = LingoPropList.fromPairs([[LingoSymbol.for("name"), member.name]]);
    return this.movie.runtime.callMethod(player, "startsamplepreview", [params]);
  }

  stopPreview(): LingoValue {
    return this.player ? this.movie.runtime.callMethod(this.player, "stopsamplepreview", []) : 1;
  }

  dispose(): void {
    this.stopPreview();
    this.stop();
  }

  private ensurePlayer(): ScriptInstance {
    if (this.player) return this.player;
    const entry = this.songPlayerEntry;
    if (!entry) throw new Error("The imported hh_soundmachine Song Player Class is not present in this profile.");
    this.members.loadCast(entry.castFile);
    const player = this.movie.runtime.instantiate(entry.module, []);
    const identity = this.movie.runtime.instantiate(identityModule, []);
    if (!(player instanceof ScriptInstance) || !(identity instanceof ScriptInstance)) {
      throw new Error("The imported Trax Song Player could not be instantiated.");
    }
    this.movie.runtime.setInstanceProp(player, "ancestor", identity);
    this.movie.runtime.callMethod(player, "construct", []);
    this.player = player;
    return player;
  }

  private indexSongMembers(samples: readonly CastMember[]): void {
    const silentSample = this.members.find("sound_machine_sample_0", null);
    if (!silentSample?.sound || silentSample.type.toLowerCase() !== "sound") {
      throw new Error("The imported Trax silent padding sample is unavailable.");
    }

    for (const member of new Map(
      [...samples, silentSample].map((candidate) => [candidate.slotNumber, candidate]),
    ).values()) {
      const registered = this.movie.runtime.call("registermember", [member.name, member.slotNumber]);
      if (registered !== member.slotNumber) {
        throw new Error(
          `The imported Resource API did not register ${member.name} at slot ${member.slotNumber}; returned ${String(registered)}.`,
        );
      }
      const resolved = this.movie.runtime.call("getmember", [member.name]);
      if (!(resolved instanceof CastMember) || resolved.slotNumber !== member.slotNumber) {
        throw new Error(`The imported Resource API could not resolve the registered sound member ${member.name}.`);
      }
    }
  }
}

function soundInventory(manifest: MovieManifest): SoundInventoryEntry[] {
  const inventory: SoundInventoryEntry[] = [];
  for (const cast of manifest.casts) {
    for (const member of cast.members) {
      if (!member.sound) continue;
      inventory.push({
        key: `${cast.number}:${member.number}`,
        castName: cast.name,
        castNumber: cast.number,
        memberNumber: member.number,
        memberName: member.name,
        durationMs: member.sound.durationMs,
        codec: member.sound.codec,
        container: member.sound.container,
      });
    }
  }
  return inventory.sort((left, right) =>
    left.memberName.localeCompare(right.memberName) || left.castName.localeCompare(right.castName));
}

function findTraxSongPlayer(scripts: GeneratedScriptBundle): GeneratedScriptEntry | null {
  const matches = scripts.filter((entry) =>
    normalizeCastName(entry.castFile) === "hh_soundmachine" &&
    String(entry.memberName ?? entry.module.scriptName).trim().toLowerCase() === "song player class");
  if (matches.length > 1) {
    throw new Error(`Profile contains ${matches.length} hh_soundmachine Song Player Class scripts; expected exactly one.`);
  }
  return matches[0] ?? null;
}

function normalizeCastName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop()!.replace(/\.(cct|cst)$/i, "").toLowerCase();
}

function materializeSoundMember(members: CastRegistry, entry: SoundInventoryEntry): CastMember {
  members.loadCast(entry.castName, entry.castNumber);
  const member = members.find(entry.memberNumber, entry.castName);
  if (!member?.sound || member.type.toLowerCase() !== "sound") {
    throw new Error(`Imported sound member ${entry.castName}:${entry.memberNumber} (${entry.memberName}) is unavailable.`);
  }
  return member;
}

function directorSoundEntry(member: CastMember, options: Readonly<Record<string, number>>): LingoPropList {
  const pairs: Array<[LingoValue, LingoValue]> = [[LingoSymbol.for("member"), member]];
  for (const [name, value] of Object.entries(options)) pairs.push([LingoSymbol.for(name), value]);
  return LingoPropList.fromPairs(pairs);
}

function soundEntryOptions(root: ParentNode): Record<string, number> {
  const options: Record<string, number> = {};
  for (const [selector, name] of [
    ["[data-start-ms]", "startTime"],
    ["[data-end-ms]", "endTime"],
    ["[data-loop-count]", "loopCount"],
    ["[data-loop-start-ms]", "loopStartTime"],
    ["[data-loop-end-ms]", "loopEndTime"],
    ["[data-preload-ms]", "preLoadTime"],
  ] as const) {
    const input = required<HTMLInputElement>(root, selector);
    if (input.value.trim() !== "") options[name] = Number(input.value);
  }
  return options;
}

function playOnChannels(movie: DirectorMovie, entry: LingoPropList, count: number): LingoValue {
  let result: LingoValue = LINGO_VOID;
  for (let channel = 1; channel <= count; channel += 1) {
    result = movie.audioCommand(channel, "play", [entry.duplicate()]);
  }
  return result;
}

function populateSoundSelect(select: HTMLSelectElement, inventory: readonly SoundInventoryEntry[]): void {
  const fragment = document.createDocumentFragment();
  for (const entry of inventory) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = `${entry.memberName} | ${entry.castName} | ${entry.durationMs} ms | ${entry.codec}/${entry.container}`;
    fragment.appendChild(option);
  }
  select.replaceChildren(fragment);
}

function selectPreferred(
  select: HTMLSelectElement,
  inventory: readonly SoundInventoryEntry[],
  predicate: (entry: SoundInventoryEntry) => boolean,
): void {
  const preferred = inventory.find(predicate);
  if (preferred) select.value = preferred.key;
}

function renderSoundSnapshot(root: ParentNode, movie: DirectorMovie): void {
  const body = required<HTMLTableSectionElement>(root, "[data-channel-rows]");
  const rows = movie.soundSnapshot().map((channel) => {
    const row = document.createElement("tr");
    for (const value of [
      channel.number,
      channel.status,
      channel.memberName ?? "-",
      channel.elapsedTime,
      channel.queued,
      channel.volume,
      channel.pan,
      channel.loopsRemaining,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.appendChild(cell);
    }
    return row;
  });
  body.replaceChildren(...rows);
  required<HTMLElement>(root, "[data-trace-count]").textContent = `${movie.audioTraceSnapshot().length} events`;
}

function harnessMarkup(profileId: string, soundCount: number): string {
  return `
    <header class="director-audio-harness__header">
      <div><strong>Director Audio Harness</strong><span>${escapeHtml(profileId)} | ${soundCount} authored sounds</span></div>
      <button type="button" data-close aria-label="Close audio harness">x</button>
    </header>
    <div class="director-audio-harness__body">
      <section>
        <h2>Sound Member Playback</h2>
        <label>Primary member<select data-sound-primary></select></label>
        <label>Queued member<select data-sound-queued></select></label>
        <div class="director-audio-harness__grid director-audio-harness__grid--six">
          <label>Channel<input data-channel type="number" min="1" max="8" value="1"></label>
          <label>Start ms<input data-start-ms type="number" min="0" placeholder="authored"></label>
          <label>End ms<input data-end-ms type="number" min="0" placeholder="authored"></label>
          <label>Loop count<input data-loop-count type="number" min="0" value="1" title="0 means infinite"></label>
          <label>Loop start<input data-loop-start-ms type="number" min="0" placeholder="authored"></label>
          <label>Loop end<input data-loop-end-ms type="number" min="0" placeholder="authored"></label>
          <label>Preload ms<input data-preload-ms type="number" min="0" placeholder="0"></label>
        </div>
        <div class="director-audio-harness__buttons">
          <button type="button" data-command="play">Play</button>
          <button type="button" data-command="queue">Queue</button>
          <button type="button" data-command="play-queue">Play + Queue</button>
          <button type="button" data-command="play-four">Play 1-4</button>
          <button type="button" data-command="play-eight">Play 1-8</button>
        </div>
      </section>
      <section>
        <h2>Channel Transport and Mix</h2>
        <div class="director-audio-harness__buttons">
          <button type="button" data-command="pause">Pause / Resume</button>
          <button type="button" data-command="rewind">Rewind</button>
          <button type="button" data-command="playnext">Play Next</button>
          <button type="button" data-command="breakloop">Break Loop</button>
          <button type="button" data-command="stop">Stop</button>
        </div>
        <div class="director-audio-harness__grid director-audio-harness__grid--five">
          <label>Volume<input data-volume type="number" min="0" max="255" value="255"></label>
          <label>Pan<input data-pan type="number" min="-100" max="100" value="0"></label>
          <label>Fade target<input data-fade-volume type="number" min="0" max="255" value="128"></label>
          <label>Fade ms<input data-fade-ms type="number" min="0" value="1000"></label>
          <button type="button" data-apply-channel>Apply channel</button>
        </div>
        <div class="director-audio-harness__buttons">
          <button type="button" data-command="fadein">Fade In</button>
          <button type="button" data-command="fadeout">Fade Out</button>
          <button type="button" data-command="fadeto">Fade To</button>
          <label class="director-audio-harness__check"><input data-sound-enabled type="checkbox" checked> Sound enabled</label>
          <label>Level 0-7<input data-sound-level type="number" min="0" max="7" value="7"></label>
          <button type="button" data-apply-global>Apply global</button>
        </div>
      </section>
      <section>
        <h2>Imported Sound Machine / Trax</h2>
        <p>The controls below invoke the imported <code>hh_soundmachine</code> Song Player handlers. They do not use a replacement sequencer.</p>
        <div class="director-audio-harness__grid director-audio-harness__grid--two">
          <label>Channel 1 sample<select data-trax-a></select></label>
          <label>Loops<input data-trax-loops-a type="number" min="1" max="64" value="2"></label>
          <label>Channel 2 sample<select data-trax-b></select></label>
          <label>Loops<input data-trax-loops-b type="number" min="1" max="64" value="1"></label>
        </div>
        <div class="director-audio-harness__buttons">
          <label class="director-audio-harness__check"><input data-trax-loop type="checkbox" checked> Loop song</label>
          <button type="button" data-trax-start>Start Imported Song</button>
          <button type="button" data-trax-stop>Stop Song</button>
          <button type="button" data-trax-preview>Preview Sample</button>
          <button type="button" data-trax-preview-stop>Stop Preview</button>
        </div>
      </section>
      <section>
        <div class="director-audio-harness__section-heading">
          <h2>Live Director Channels</h2>
          <div>
            <label class="director-audio-harness__check"><input data-trace-toggle type="checkbox"> Trace</label>
            <span data-trace-count>0 events</span>
            <button type="button" data-trace-clear>Clear</button>
            <button type="button" data-trace-download>Download JSON</button>
          </div>
        </div>
        <div class="director-audio-harness__table-wrap">
          <table><thead><tr><th>Ch</th><th>Status</th><th>Member</th><th>Elapsed</th><th>Queue</th><th>Vol</th><th>Pan</th><th>Loops</th></tr></thead><tbody data-channel-rows></tbody></table>
        </div>
      </section>
    </div>
    <footer data-audio-status data-level="ready">Initializing...</footer>
  `;
}

function bind(
  root: ParentNode,
  selector: string,
  listener: () => void,
  eventName = "click",
): void {
  required<HTMLElement>(root, selector).addEventListener(eventName, listener);
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Audio harness element is missing: ${selector}`);
  return element;
}

function numberValue(root: ParentNode, selector: string, fallback: number): number {
  const value = Number(required<HTMLInputElement>(root, selector).value);
  return Number.isFinite(value) ? value : fallback;
}

function checked(root: ParentNode, selector: string): boolean {
  return required<HTMLInputElement>(root, selector).checked;
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function downloadJson(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
