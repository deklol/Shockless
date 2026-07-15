import "./standalone-api";
import "./styles.css";
import type {
  ImportProgress,
  LauncherState,
  ProfileImportStage,
  RuntimeProfile,
  StageState,
  UpdateLauncherSettingsRequest,
} from "../common/types";

type LauncherView = "launch" | "setup" | "progress" | "help";
type LaunchSettingsDraft = Required<Omit<UpdateLauncherSettingsRequest, "versionCheckBuild">> & {
  readonly versionCheckBuild: number | null;
};

const root = document.getElementById("app");
if (!root) throw new Error("Missing app root");
const appRoot = root;

let state: LauncherState | null = null;
let selectedFolder = "";
let progress: ImportProgress[] = [];
let busy = false;
let message = "";
let importStartedAt = 0;
let progressTicker: number | null = null;
let currentView: LauncherView = "launch";
const api = window.standalone ?? previewApi();

const IMPORT_STAGES: ProfileImportStage[] = [
  "validate",
  "sanitize",
  "projectorrays",
  "index-casts",
  "text-fields",
  "materialize-bitmaps",
  "generate-scripts",
  "validate-profile",
];

const STAGE_LABELS: Record<ProfileImportStage, string> = {
  validate: "Validate folder",
  sanitize: "Copy client",
  projectorrays: "Decompile",
  "index-casts": "Index casts",
  "text-fields": "Extract text",
  "materialize-bitmaps": "Prepare assets",
  "generate-scripts": "Prepare scripts",
  "validate-profile": "Validate profile",
};

api.onImportProgress((entry) => {
  progress = [...progress.filter((item) => item.stage !== entry.stage), entry];
  currentView = "progress";
  render();
});

void refresh();

async function refresh(): Promise<void> {
  state = await api.getState();
  render();
}

function render(): void {
  const profiles = state?.profiles ?? [];
  const settings = state?.settings;
  const activeProfile = profiles.find((profile) => profile.id === settings?.activeProfileId) ?? profiles[0] ?? null;

  appRoot.innerHTML = `
    <main class="launcher" data-view="${currentView}">
      <div class="room-art" aria-hidden="true"></div>
      <div class="shade" aria-hidden="true"></div>

      <header class="brand">
        <h1>Shockless Engine</h1>
        <p>${profiles.length === 0 ? "First-run setup" : "Standalone launcher"}</p>
      </header>

      <nav class="command-stack" aria-label="Launcher sections">
        <button class="command ${currentView === "setup" ? "active" : ""}" data-view-target="setup">Settings</button>
        <button class="command ${currentView === "help" ? "active" : ""}" data-view-target="help">Help</button>
        <button class="command primary" data-action="play" ${activeProfile?.runtime.ready && !busy ? "" : "disabled"}>Play</button>
        <button class="command subtle" id="refresh">Refresh</button>
      </nav>

      ${
        currentView === "launch"
          ? ""
          : `<section class="detail-panel" aria-live="polite">
              ${renderPanel(activeProfile, profiles)}
            </section>`
      }

      <footer class="status-strip">
        <span>${escapeHtml(statusLine(activeProfile, profiles))}</span>
        <button id="close-launcher" type="button">Exit</button>
      </footer>
    </main>
  `;

  document.getElementById("refresh")?.addEventListener("click", () => void refresh());
  document.getElementById("close-launcher")?.addEventListener("click", () => window.close());
  document.getElementById("clear-cache")?.addEventListener("click", () => void clearCache());
  document.getElementById("choose-folder")?.addEventListener("click", () => void chooseFolder());
  document.getElementById("import-profile")?.addEventListener("click", () => void importProfile());
  document.getElementById("save-launch-settings")?.addEventListener("click", () => void saveLaunchSettings());
  document.getElementById("save-credentials")?.addEventListener("click", () => void saveCredentials());
  document.getElementById("clear-credentials")?.addEventListener("click", () => void clearCredentials());
  document.querySelectorAll<HTMLButtonElement>("[data-action='play']").forEach((button) => {
    button.addEventListener("click", () => void playActive(activeProfile));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = (button.dataset.viewTarget ?? "launch") as LauncherView;
      currentView = target === "setup" && currentView === "setup" ? "launch" : target;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-profile-id]").forEach((button) => {
    button.addEventListener("click", () => void setActiveProfile(button.dataset.profileId ?? ""));
  });
}

function renderPanel(activeProfile: RuntimeProfile | null, profiles: RuntimeProfile[]): string {
  if (currentView === "setup") return renderSetupPanel(profiles);
  if (currentView === "progress") return renderProgressPanel();
  if (currentView === "help") return renderHelpPanel();
  return renderLaunchPanel(activeProfile, profiles);
}

function renderLaunchPanel(profile: RuntimeProfile | null, profiles: RuntimeProfile[]): string {
  if (!profile) {
    return `
      <div class="panel-heading">
        <span>Launch</span>
        <strong>No profile imported</strong>
      </div>
      <p class="empty">Select Setup, choose any compiled Habbo Origins folder, then import it into this standalone app's clients folder.</p>
      <button class="wide-action cyan compact" data-view-target="setup">Open Setup</button>
    `;
  }

  return `
    <div class="profile-overview launch-overview">
      <div>
        <h2>${escapeHtml(profileTitle(profile))}</h2>
        <p>${escapeHtml(profile.runtime.ready ? `${profile.entryMovie} ready` : profile.runtime.reason ?? "Profile is not ready.")}</p>
      </div>
      <button class="wide-action cyan compact" data-action="play" ${profile.runtime.ready && !busy ? "" : "disabled"}>Play Profile</button>
    </div>
    <div class="mini-actions">
      <button class="small-action" data-view-target="setup">Settings</button>
      <button class="small-action" data-view-target="help">Help</button>
      <button class="small-action" data-view-target="progress">Import Log</button>
      ${profiles.length > 1 ? `<span>${profiles.length} profiles available</span>` : `<span>${escapeHtml(state?.credentialsSaved ? "Fast login saved" : "Fast login not saved")}</span>`}
    </div>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
  `;
}

function renderSetupPanel(profiles: RuntimeProfile[]): string {
  const settings = state?.settings;
  const activeProfile = profiles.find((profile) => profile.id === settings?.activeProfileId) ?? profiles[0] ?? null;
  const autoBuildLabel = activeProfile?.versionCheckBuild ? `Auto: ${activeProfile.versionCheckBuild}` : "Auto-detect during import/play";
  return `
    <div class="panel-heading">
      <span>Setup</span>
      <strong>${profiles.length === 0 ? "Import required" : `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`}</strong>
    </div>
    <div class="setup-grid">
      <label class="label-block">
        <span>Compiled Client Folder</span>
        <div class="field-row">
          <input id="client-folder" value="${escapeHtml(selectedFolder)}" readonly placeholder="Select compiled Habbo folder" />
          <button id="choose-folder" class="small-action">Browse</button>
        </div>
      </label>
      <div class="settings-grid">
        <label class="check">
          <input id="fixed-stage" type="checkbox" ${settings?.fixedStage !== false ? "checked" : ""} />
          <span>Fixed 960x540 mode</span>
        </label>
        <label class="check">
          <input id="resizable-presentation" type="checkbox" ${settings?.resizablePresentation ? "checked" : ""} />
          <span>Resizable presentation</span>
        </label>
        <label class="check">
          <input id="custom-hotelview" type="checkbox" ${settings?.customHotelView ? "checked" : ""} />
          <span>Custom hotelview</span>
        </label>
      </div>
      <label class="label-block build-field">
        <span>Client Build Override (optional)</span>
        <input id="version-build" type="number" min="1" value="${settings?.versionCheckBuild ?? ""}" placeholder="${escapeHtml(autoBuildLabel)}" />
        <small class="hint">Leave blank to use the accepted VERSIONCHECK build detected for the imported profile.</small>
      </label>
      <div class="button-row">
        <button id="save-launch-settings" class="small-action" ${busy ? "disabled" : ""}>Save Settings</button>
        <button id="import-profile" class="small-action cyan" ${!selectedFolder || busy ? "disabled" : ""}>Import Client</button>
        <button id="clear-cache" class="small-action danger" title="Clear portable client profiles, logs, settings, and saved credentials">Clear Cache</button>
      </div>
    </div>
    <div class="credentials setup-credentials">
      <h3>Fast Login</h3>
      <div class="two-fields">
        <input id="email" type="email" placeholder="Email" autocomplete="username" />
        <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
      </div>
      <div class="button-row">
        <button id="save-credentials" class="small-action">Save Securely</button>
        <button id="clear-credentials" class="small-action danger" ${state?.credentialsSaved ? "" : "disabled"}>Clear Credentials</button>
      </div>
      <p class="hint">${state?.credentialsSaved ? "Saved with Electron safeStorage." : "Credentials are only stored if you save them."}</p>
    </div>
    ${profiles.length > 0 ? renderProfileList(profiles) : ""}
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
  `;
}

function renderHelpPanel(): string {
  return `
    <div class="panel-heading">
      <span>Help</span>
      <strong>Origins Engine</strong>
    </div>
    <div class="help-copy">
      <section>
        <h3>What This Is</h3>
        <p>Shockless Engine is a standalone Director-compatible game engine for imported Habbo Origins clients. The app does not bundle a game version into the executable.</p>
      </section>
      <section>
        <h3>How Import Works</h3>
        <p>Choose any compiled Habbo Origins folder. The importer copies it into this app's <strong>clients</strong> folder, decompiles the Director movies, indexes casts and text fields, materializes bitmap assets, generates executable Lingo script modules, then validates the profile before Play is enabled.</p>
      </section>
      <section>
        <h3>Where Files Go</h3>
        <p>Your selected source folder is read-only. Imported profiles live beside the standalone app under <strong>clients/&lt;profile-id&gt;</strong>. App settings, logs, and saved credentials are kept separately in the Windows app data folder.</p>
      </section>
      <section>
        <h3>Technology</h3>
        <p>The engine is written mainly in TypeScript. The standalone shell uses Electron, the launcher uses Vite, rendering is handled through PixiJS/WebGL, and imported Director/Lingo source is compiled into JavaScript modules that run on the engine's Director compatibility layer.</p>
      </section>
      <section>
        <h3>Play</h3>
        <p>After a profile validates, press Play. Fixed 960x540 mode is the stable default. Resizable presentation can be enabled in Settings while it remains experimental.</p>
      </section>
    </div>
  `;
}

function renderProfileList(profiles: RuntimeProfile[]): string {
  const activeId = state?.settings.activeProfileId;
  return `
    <div class="profile-list">
      ${profiles
        .map(
          (profile) => `
            <button data-profile-id="${escapeHtml(profile.id)}" class="profile ${profile.id === activeId ? "active" : ""}">
              <strong>${escapeHtml(profileTitle(profile))}</strong>
              <span>${escapeHtml(profile.runtime.ready ? "Ready" : profile.runtime.reason ?? "Not ready")}</span>
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderProgressPanel(): string {
  if (progress.length === 0) {
    return `
      <div class="panel-heading">
        <span>Progress</span>
        <strong>Idle</strong>
      </div>
      <p class="empty">No import running. Import a compiled client from Setup to see live decompile and asset preparation details here.</p>
    `;
  }
  const latest = progress[progress.length - 1];
  const elapsed = latest?.elapsedMs ?? (importStartedAt > 0 ? Date.now() - importStartedAt : 0);
  const latestPercent = Math.max(0, Math.min(100, latest?.percent ?? 0));
  const progressByStage = new Map(progress.map((entry) => [entry.stage, entry]));
  return `
    <div class="panel-heading">
      <span>Progress</span>
      <strong>${Math.round(latestPercent)}%</strong>
    </div>
    <div class="current-step">
      <strong>${escapeHtml(latest ? STAGE_LABELS[latest.stage] : "Preparing")}</strong>
      <span>${escapeHtml(latest?.message ?? "Starting import")}</span>
      ${latest?.detail ? `<small>${escapeHtml(latest.detail)}</small>` : ""}
    </div>
    <div class="progress-summary">
      <span>${formatElapsed(elapsed)}</span>
      ${latest?.current !== undefined && latest.total !== undefined ? `<span>${latest.current.toLocaleString()} / ${latest.total.toLocaleString()} files</span>` : ""}
    </div>
    <div class="bar"><span style="width:${latestPercent}%"></span></div>
    ${busy ? `<p class="import-note">Windows may scan generated files during decompile and asset preparation, so CPU or disk usage can rise while this continues.</p>` : ""}
    <ol class="stage-list">
      ${IMPORT_STAGES.map((stage) => renderStageRow(stage, progressByStage.get(stage))).join("")}
    </ol>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
  `;
}

function renderStageRow(stage: ProfileImportStage, entry: ImportProgress | undefined): string {
  const stageState: StageState = entry?.state ?? "pending";
  const stageMessage = entry?.message ?? "Waiting";
  const count = entry?.current !== undefined && entry.total !== undefined ? ` ${entry.current.toLocaleString()} / ${entry.total.toLocaleString()}` : "";
  return `
    <li class="${stageState}">
      <strong>${escapeHtml(STAGE_LABELS[stage])}</strong>
      <span>${escapeHtml(stageMessage)}${escapeHtml(count)}</span>
      ${entry?.detail ? `<small>${escapeHtml(entry.detail)}</small>` : ""}
    </li>
  `;
}

function statusLine(profile: RuntimeProfile | null, profiles: RuntimeProfile[]): string {
  if (message) return message;
  if (busy) return "Preparing Origins profile";
  if (progress.length > 0) {
    const latest = progress[progress.length - 1];
    return latest ? `${STAGE_LABELS[latest.stage]} - ${Math.round(latest.percent)}%` : "Import progress ready";
  }
  if (profile?.runtime.ready) return `${profileBuildLabel(profile)} ready`;
  if (profile) return profile.runtime.reason ?? "Profile needs attention";
  if (profiles.length === 0) return "Import a compiled Habbo Origins client to begin";
  return "Select a profile";
}

function profileTitle(profile: RuntimeProfile): string {
  const folder = profile.sourceFolderName ? ` (${profile.sourceFolderName})` : "";
  return `${profileBuildLabel(profile)}${folder}`;
}

function profileBuildLabel(profile: RuntimeProfile): string {
  if (profile.buildNumber) return `Origins build ${profile.buildNumber}`;
  if (/^release\d+$/i.test(profile.versionId)) return `Origins build ${profile.versionId.replace(/\D/g, "")}`;
  return "Origins profile";
}

async function chooseFolder(): Promise<void> {
  const folder = await api.selectFolder();
  if (folder) {
    selectedFolder = folder;
    message = "";
    currentView = "setup";
    render();
  }
}

async function importProfile(): Promise<void> {
  let launchSettings: LaunchSettingsDraft;
  try {
    launchSettings = currentLaunchSettings();
  } catch (error) {
    message = String(error);
    render();
    return;
  }
  busy = true;
  currentView = "progress";
  importStartedAt = Date.now();
  startProgressTicker();
  progress = [];
  message = "";
  render();
  try {
    state = await api.importProfile({ clientRoot: selectedFolder, ...launchSettings });
    selectedFolder = "";
  } catch (error) {
    message = String(error);
  } finally {
    busy = false;
    stopProgressTicker();
    render();
  }
}

async function saveLaunchSettings(showMessage = true): Promise<void> {
  let launchSettings: LaunchSettingsDraft;
  try {
    launchSettings = currentLaunchSettings();
  } catch (error) {
    message = String(error);
    render();
    return;
  }
  state = await api.updateSettings(launchSettings);
  if (showMessage) {
    message =
      launchSettings.versionCheckBuild === null
        ? "Launch settings saved. Client build will auto-detect from the imported profile."
        : `Launch settings saved. Manual VERSIONCHECK build ${launchSettings.versionCheckBuild}.`;
  }
  render();
}

async function playActive(profile: RuntimeProfile | null): Promise<void> {
  if (!profile) {
    currentView = "setup";
    render();
    return;
  }
  let launchSettings: LaunchSettingsDraft;
  try {
    launchSettings = currentLaunchSettings();
  } catch (error) {
    message = String(error);
    render();
    return;
  }
  busy = true;
  render();
  try {
    state = await api.updateSettings(launchSettings);
    state = await api.playProfile(profile.id);
  } catch (error) {
    message = String(error);
  } finally {
    busy = false;
    render();
  }
}

function currentLaunchSettings(): LaunchSettingsDraft {
  const saved = state?.settings;
  return {
    fixedStage: checked("fixed-stage", saved?.fixedStage ?? true),
    resizablePresentation: checked("resizable-presentation", saved?.resizablePresentation ?? false),
    customHotelView: checked("custom-hotelview", saved?.customHotelView ?? false),
    versionCheckBuild: versionBuildValue(saved?.versionCheckBuild ?? null),
  };
}

function versionBuildValue(fallback: number | null): number | null {
  const input = document.getElementById("version-build") as HTMLInputElement | null;
  if (!input) return fallback;
  const raw = input.value.trim();
  if (raw.length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Client build override must be a positive integer.");
  }
  return parsed;
}

async function saveCredentials(): Promise<void> {
  const email = (document.getElementById("email") as HTMLInputElement | null)?.value.trim() ?? "";
  const password = (document.getElementById("password") as HTMLInputElement | null)?.value ?? "";
  try {
    state = await api.saveCredentials({ email, password });
    message = "Stored credentials saved.";
  } catch (error) {
    message = String(error);
  }
  render();
}

async function clearCredentials(): Promise<void> {
  state = await api.clearCredentials();
  message = "Stored credentials cleared.";
  render();
}

async function clearCache(): Promise<void> {
  if (!window.confirm("Clear all Shockless Engine portable client profiles, logs, settings, and saved credentials?")) return;
  busy = true;
  message = "";
  progress = [];
  render();
  try {
    state = await api.clearCache();
    selectedFolder = "";
    currentView = "setup";
    message = "Cache cleared.";
  } catch (error) {
    message = String(error);
  } finally {
    busy = false;
    render();
  }
}

async function setActiveProfile(profileId: string): Promise<void> {
  if (!profileId) return;
  state = await api.setActiveProfile(profileId);
  currentView = "launch";
  render();
}

function checked(id: string, fallback: boolean): boolean {
  const input = document.getElementById(id) as HTMLInputElement | null;
  return input ? input.checked === true : fallback;
}

function startProgressTicker(): void {
  stopProgressTicker();
  progressTicker = window.setInterval(() => {
    if (busy && progress.length > 0) render();
  }, 1000);
}

function stopProgressTicker(): void {
  if (progressTicker !== null) {
    window.clearInterval(progressTicker);
    progressTicker = null;
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} elapsed`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function previewApi() {
  const previewState: LauncherState = {
    cacheRoot: "%APPDATA%\\ShocklessEngine",
    clientsRoot: ".\\clients",
    profiles: [],
    settings: {
      activeProfileId: null,
      fixedStage: true,
      resizablePresentation: false,
      customHotelView: false,
      rememberCredentials: false,
      versionCheckBuild: null,
    },
    credentialsSaved: false,
  };
  return {
    getState: async () => previewState,
    selectFolder: async () => "F:\\compiled\\320",
    importProfile: async () => previewState,
    updateSettings: async () => previewState,
    setActiveProfile: async () => previewState,
    playProfile: async () => previewState,
    clearCache: async () => previewState,
    saveCredentials: async () => ({ ...previewState, credentialsSaved: true }),
    clearCredentials: async () => previewState,
    onImportProgress: () => () => undefined,
  };
}
