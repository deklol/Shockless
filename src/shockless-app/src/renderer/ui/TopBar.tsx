import { Download, Package, Plus, Play, RefreshCw, Settings, Square } from "lucide-react";
import type { ClientSessionList, ClientSessionSummary, EngineLaunchState } from "../../shared/window-api";
import type { AppUpdateState } from "../../shared/update";

interface TopBarProps {
  readonly desktopBridgeAvailable: boolean;
  readonly engineBusy: boolean;
  readonly profileImportRunning: boolean;
  readonly engineUrl: string | null;
  readonly engineLaunch: EngineLaunchState | null;
  readonly selectedProfile: { readonly ready: boolean } | null;
  readonly clientSessions: ClientSessionList | null;
  readonly selectedClientSession: ClientSessionSummary | null;
  readonly selectedClientSnapshotLabel: string;
  readonly updateState: AppUpdateState | null;
  readonly engineLocation: string;
  readonly engineEmbedded: boolean;
  readonly clientSessionTitle: (session: ClientSessionSummary) => string;
  readonly onRefresh: () => void;
  readonly onStop: () => void;
  readonly onStart: () => void;
  readonly onOpenPlugins: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenUpdates: () => void;
  readonly onSelectClientSession: (id: number) => void;
  readonly onAddManualVisibleClient: () => void;
}

export function TopBar({
  desktopBridgeAvailable, engineBusy, profileImportRunning, engineUrl, engineLaunch,
  selectedProfile, clientSessions, selectedClientSession, selectedClientSnapshotLabel,
  updateState, engineLocation, engineEmbedded, clientSessionTitle,
  onRefresh, onStop, onStart, onOpenPlugins, onOpenSettings, onOpenUpdates, onSelectClientSession, onAddManualVisibleClient,
}: TopBarProps) {
  const updateAvailable = updateState?.status === "available" || updateState?.status === "downloaded";
  return (
    <header className="top-bar">
      <div className="top-bar-copy">
        <img className="app-brand-sprite" src="./img/headicon.png" alt="" aria-hidden="true" />
        <div>
          <div className="app-title">Shockless Engine</div>
          <div className="app-subtitle">Habbo Origins Companion App</div>
        </div>
      </div>
      <div className="engine-actions" aria-label="Embedded engine controls">
        <button className="engine-action-button" type="button" onClick={() => void onOpenPlugins()} title="Plugins">
          <Package size={14} /><span>Plugins</span>
        </button>
        <button className="engine-action-button" type="button" onClick={() => void onOpenSettings()} title="Settings">
          <Settings size={14} /><span>Settings</span>
        </button>
        <button
          className={`engine-action-button update-action ${updateAvailable ? "update-available" : ""}`}
          type="button"
          onClick={() => void onOpenUpdates()}
          title={updateState?.message ?? "Updates"}
        >
          <Download size={14} /><span>{updateAvailable ? "Update" : "Updates"}</span>
        </button>
        <button className="engine-action-button" type="button" onClick={() => void onRefresh()} disabled={!desktopBridgeAvailable || engineBusy || profileImportRunning} title="Refresh">
          <RefreshCw size={14} /><span>Refresh</span>
        </button>
        {engineUrl ? (
          <button className="engine-action-button" type="button" onClick={() => void onStop()} disabled={!desktopBridgeAvailable || engineBusy || profileImportRunning} title="Stop">
            <Square size={13} /><span>Stop</span>
          </button>
        ) : (
          <button className="engine-action-button primary" type="button" onClick={() => void onStart()} disabled={!desktopBridgeAvailable || engineBusy || profileImportRunning || (!selectedProfile?.ready && engineLaunch?.status === "not-configured")} title="Start">
            <Play size={14} /><span>Start</span>
          </button>
        )}
      </div>
      <div className="session-strip" aria-label="Client sessions">
        {(clientSessions?.sessions.length ? clientSessions.sessions : selectedClientSession ? [selectedClientSession] : []).map((session) => (
          <button key={session.id} type="button" className={`session-chip ${session.selected ? "selected" : ""} ${session.status === "running" ? "running" : session.status === "error" ? "error" : ""}`} onClick={() => void onSelectClientSession(session.id)} title={clientSessionTitle(session)} aria-label={`Select client ${session.id}`}>
            <span>{session.id}</span>
            {session.headless ? <small>H</small> : null}
          </button>
        ))}
        {!clientSessions?.sessions.length && !selectedClientSession ? <span className="session-empty">1</span> : null}
        <button className="session-add-button" type="button" onClick={() => void onAddManualVisibleClient()} title="Start a manual visible client" aria-label="Add client session">
          <Plus size={15} />
        </button>
      </div>
      <div className={`conn-status ${engineEmbedded ? "online" : engineLaunch?.status === "ready" ? "ready" : "idle"}`} aria-label="Engine status" title={engineLocation}>
        <span className="conn-dot" />
        <span>{engineEmbedded ? "Connected" : engineLaunch?.status === "ready" ? "Ready" : "Preview"}</span>
      </div>
    </header>
  );
}
