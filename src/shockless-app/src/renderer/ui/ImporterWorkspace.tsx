import { ChevronDown, Download, FolderInput, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EngineLaunchState, ClientProfileSummary } from "../../shared/window-api";
import { ORIGINS_REALMS, type OriginsRealmId } from "../../shared/originsRealm";
import type { AppUpdateState } from "../../shared/update";
import {
  profileLine,
  statusLabel,
  compactValue,
  profileImportStatusLabel,
  profileImportStageEntry,
  formatImportElapsed,
  profileImportMetricText,
  PROFILE_IMPORT_STAGES,
  PROFILE_IMPORT_STAGE_LABELS,
  type ProfileImportUiState,
} from "./helpers";

/** Hotel-view choices for the pre-launch picker. "custom" maps to the Shockless
 * custom hotel view; the rest swap the client's country entry cast (cast.entry). */
const HOTEL_VIEW_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "custom", label: "Shockless Custom" },
  { value: "hh_entry_uk", label: "United Kingdom" },
  { value: "hh_entry_es", label: "Spain" },
  { value: "hh_entry_br", label: "Brazil" },
  { value: "hh_entry_ru", label: "Russia" },
];

const REALM_OPTIONS: ReadonlyArray<{ readonly value: OriginsRealmId; readonly label: string }> =
  ORIGINS_REALMS.map((realm) => ({ value: realm.id, label: `${realm.label} (${realm.id.toUpperCase()})` }));

/** Themed dropdown replacing the native <select> (whose OS popup mispositions in
 * Electron and ignores the app theme). Closes on outside-click / Escape. */
function ThemedDropdown({
  value, options, disabled, onSelect,
}: {
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className="importer-hotelview-dd" ref={containerRef}>
      <button
        type="button"
        className="importer-hotelview-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span>{current?.label ?? "Default"}</span>
        <ChevronDown size={14} className={open ? "is-open" : ""} />
      </button>
      {open ? (
        <ul className="importer-hotelview-menu" role="listbox">
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                className={`importer-hotelview-option ${option.value === value ? "active" : ""}`}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface ImporterWorkspaceProps {
  readonly bridgeAvailable: boolean;
  readonly bridgeMessage: string;
  readonly engineBusy: boolean;
  readonly settingsBusy: boolean;
  readonly engineLaunch: EngineLaunchState | null;
  readonly elapsedMs: number;
  readonly importState: ProfileImportUiState;
  readonly profiles: readonly ClientProfileSummary[];
  readonly selectedProfile: ClientProfileSummary | null;
  readonly updateState: AppUpdateState | null;
  readonly onImport: () => void;
  readonly onRefresh: () => void;
  readonly onStart: () => void;
  readonly onOpenUpdates: () => void;
  readonly onSetRealm: (value: OriginsRealmId) => void;
  readonly onSetHotelView: (value: string) => void;
  readonly onSetResizablePresentation: (enabled: boolean) => void;
  readonly onSetSteamLogin: (enabled: boolean) => void;
  readonly onSetVersionCheckBuild: () => void;
  readonly versionCheckDraft: string;
  readonly onVersionCheckDraftChange: (value: string) => void;
}

export function ImporterWorkspace({
  bridgeAvailable, bridgeMessage, engineBusy, settingsBusy, engineLaunch,
  elapsedMs, importState, profiles, selectedProfile,
  updateState,
  onImport, onRefresh, onStart, onOpenUpdates,
  onSetRealm, onSetHotelView, onSetResizablePresentation, onSetSteamLogin, onSetVersionCheckBuild,
  versionCheckDraft, onVersionCheckDraftChange,
}: ImporterWorkspaceProps) {
  const latest = importState.latest;
  const latestMetrics = profileImportMetricText(latest);
  const latestPercent = Math.max(0, Math.min(100, Math.round(latest?.percent ?? 0)));
  const profileReady = Boolean(selectedProfile?.ready && engineLaunch?.status !== "running");
  const status = profileImportStatusLabel(importState);
  const message = importState.message || engineLaunch?.message || bridgeMessage;
  const fidelityLabel = !selectedProfile
    ? "-"
    : selectedProfile.fidelityComplete === null
      ? "Unknown"
      : selectedProfile.fidelityComplete
        ? "Complete"
        : `Launchable / ${selectedProfile.fidelityWarningCount.toLocaleString()} warning categor${selectedProfile.fidelityWarningCount === 1 ? "y" : "ies"}`;
  const fidelityDetail = selectedProfile?.fidelityComplete === false
    ? "The profile is playable. Re-importing the same source will not resolve source extraction warnings; see profile-validation-report.json for the affected records."
    : undefined;
  const launchSettingsDisabled = !bridgeAvailable || settingsBusy || engineLaunch?.status === "running";
  const currentHotelView = engineLaunch?.settings?.customHotelView
    ? "custom"
    : engineLaunch?.settings?.entryView ?? "custom";
  const currentRealm = engineLaunch?.settings?.realm ?? "ous";
  const resizablePresentation = engineLaunch?.settings?.resizablePresentation !== false;
  const steamLogin = engineLaunch?.settings?.steamLogin === true;
  const showResizeHotelViewWarning =
    resizablePresentation &&
    (currentHotelView === "hh_entry_uk" || currentHotelView === "hh_entry_es" || currentHotelView === "hh_entry_br" || currentHotelView === "hh_entry_ru");
  const showUpdateCallout =
    updateState?.status === "available" ||
    updateState?.status === "downloaded" ||
    updateState?.status === "error";
  return (
    <div className="importer-workspace" aria-label="Client importer">
      <section className="importer-hero">
        <div className="importer-identity">
          <img className="hotel-avatar importer-avatar" src="./img/avatar.png" alt="" aria-hidden="true" />
          <div>
            <strong>Client Importer</strong>
            <span>{profiles.length > 0 ? profileLine(selectedProfile) : "No playable profile attached"}</span>
          </div>
        </div>
        <div className="importer-actions">
          <button type="button" onClick={onRefresh} disabled={!bridgeAvailable || engineBusy} title="Refresh client library">
            <RefreshCw size={14} /><span>Refresh</span>
          </button>
          <button type="button" className="primary" onClick={onImport} disabled={!bridgeAvailable || engineBusy} title="Import or build client">
            <FolderInput size={14} /><span>{importState.running ? "Importing" : "Import/Build Client"}</span>
          </button>
          {profileReady ? (
            <button type="button" className="primary" onClick={onStart} disabled={!bridgeAvailable || engineBusy} title="Start embedded client">
              <Play size={14} /><span>Start</span>
            </button>
          ) : null}
        </div>
      </section>
      {showUpdateCallout ? (
        <button type="button" className={`importer-update-callout update-${updateState.status}`} onClick={onOpenUpdates}>
          <Download size={15} />
          <span>{updateState.message}</span>
          <strong>{updateState.available?.version ? `v${updateState.available.version}` : "Details"}</strong>
        </button>
      ) : null}
      <section className="importer-main">
        <div className="importer-progress-panel">
          <div className="importer-panel-heading"><span>{status}</span><strong>{latestPercent}%</strong></div>
          <div className="importer-current-step">
            <strong>{latest ? PROFILE_IMPORT_STAGE_LABELS[latest.stage] : "Ready"}</strong>
            <span>{latest?.message ?? message ?? "Select a compiled client folder to build a playable Shockless profile."}</span>
            {latest?.detail ? <small>{latest.detail}</small> : null}
          </div>
          <div className="importer-progress-meta">
            <span>{formatImportElapsed(elapsedMs)} elapsed</span>
            <span>{importState.sourceName || latest?.sourceName || "No folder selected"}</span>
            {latest?.current !== undefined && latest.total !== undefined ? (
              <span>{latest.current.toLocaleString()} / {latest.total.toLocaleString()}</span>
            ) : latest?.current !== undefined ? (
              <span>{latest.current.toLocaleString()} written</span>
            ) : null}
            {latestMetrics.map((metric) => <span key={metric}>{metric}</span>)}
          </div>
          <div className="importer-progress-bar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={latestPercent}>
            <span style={{ width: `${latestPercent}%` }} />
          </div>
          {importState.running ? <p className="importer-note">Decompile and asset preparation can use CPU and disk while generated files are written.</p> : null}
          <ol className="importer-stage-list">
            {PROFILE_IMPORT_STAGES.map((stage) => {
              const entry = profileImportStageEntry(importState.entries, stage);
              const stateClass = entry?.state ?? "pending";
              const metrics = profileImportMetricText(entry);
              return (
                <li className={stateClass} key={stage}>
                  <strong>{PROFILE_IMPORT_STAGE_LABELS[stage]}</strong>
                  <span>{entry?.message ?? "Waiting"}</span>
                  {entry?.detail ? <small>{entry.detail}</small> : null}
                  {metrics.length > 0 ? <small className="importer-stage-metrics">{metrics.join(" | ")}</small> : null}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="importer-detail-panel">
          <div className="importer-panel-heading"><span>Details</span><strong>{profiles.length} profile{profiles.length === 1 ? "" : "s"}</strong></div>
          <div className="importer-detail-grid">
            <span>Selected</span><strong>{profileLine(selectedProfile)}</strong>
            <span>Engine</span><strong>{statusLabel(engineLaunch?.status)}</strong>
            <span>Stage</span><strong>{engineLaunch?.settings?.resizablePresentation ? "Responsive" : "Fixed Stage"}</strong>
            <span>Realm</span><strong>{ORIGINS_REALMS.find((realm) => realm.id === currentRealm)?.label ?? "US / UK"}</strong>
            <span>Hotel View</span><strong>{HOTEL_VIEW_OPTIONS.find((option) => option.value === currentHotelView)?.label ?? "Default"}</strong>
            <span>Version</span><strong>{compactValue(engineLaunch?.settings?.versionCheckBuild ?? selectedProfile?.versionCheckBuild ?? null)}</strong>
            <span>Login</span><strong>{steamLogin ? "Steam" : "Standard"}</strong>
            <span>Fidelity</span><strong title={fidelityDetail}>{fidelityLabel}</strong>
            <span>Log</span><strong>{compactValue(latest?.logPath ? latest.logPath.split(/[\\/]/).pop() : null)}</strong>
          </div>
          <div className="importer-launch-settings" aria-label="Launch settings">
            <div className="toggle-row importer-hotelview-row">
              <span>Realm</span>
              <ThemedDropdown
                value={currentRealm}
                options={REALM_OPTIONS}
                disabled={launchSettingsDisabled}
                onSelect={(value) => onSetRealm(value as OriginsRealmId)}
              />
            </div>
            <div className="toggle-row importer-hotelview-row">
              <span>Hotel view</span>
              <ThemedDropdown value={currentHotelView} options={HOTEL_VIEW_OPTIONS} disabled={launchSettingsDisabled} onSelect={onSetHotelView} />
            </div>
            {showResizeHotelViewWarning ? (
              <p className="importer-setting-warning">
                This hotel view is currently visually broken while Responsive stage resize is enabled.
              </p>
            ) : null}
            <label className="toggle-row checkbox-first-row">
              <input type="checkbox" checked={resizablePresentation} disabled={launchSettingsDisabled} onChange={(event) => onSetResizablePresentation(event.currentTarget.checked)} />
              <span>Responsive stage resize</span>
            </label>
            <label className="toggle-row checkbox-first-row importer-steam-login-row">
              <input type="checkbox" checked={steamLogin} disabled={launchSettingsDisabled} onChange={(event) => onSetSteamLogin(event.currentTarget.checked)} />
              <span>
                <strong>Steam Login</strong>
                <small>Steam must be running and logged in before starting.</small>
              </span>
            </label>
            <form className="runtime-input-row importer-version-row" onSubmit={(event) => { event.preventDefault(); onSetVersionCheckBuild(); }}>
              <input value={versionCheckDraft} onChange={(event) => onVersionCheckDraftChange(event.currentTarget.value)} placeholder={selectedProfile?.versionCheckBuild ? String(selectedProfile.versionCheckBuild) : "auto"} disabled={!bridgeAvailable || engineBusy || !selectedProfile} aria-label="Version check build override" />
              <button type="submit" disabled={!bridgeAvailable || engineBusy || !selectedProfile}>Apply</button>
            </form>
          </div>
          <div className="importer-log-lines" aria-label="Importer detail log">
            {importState.events.length > 0 ? (
              importState.events.slice(-12).map((entry, index) => (
                <code className={entry.state} key={`${entry.jobId}-${entry.stage}-${entry.updatedAt}-${index}`}>
                  [{statusLabel(entry.state)}] {PROFILE_IMPORT_STAGE_LABELS[entry.stage]}: {entry.message}
                  {entry.detail ? ` (${entry.detail})` : ""}
                </code>
              ))
            ) : (
              <p>{message || "Importer idle."}</p>
            )}
          </div>
        </div>
      </section>
      <footer className="importer-disclaimer">
        Shockless is not affiliated with, endorsed, or approved by Sulake Oy or Habbo Origins. Use at own risk.
      </footer>
    </div>
  );
}
