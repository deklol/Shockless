import React from "react";
import { Download, ExternalLink, RefreshCw, RotateCw, X } from "lucide-react";
import type { AppUpdateState } from "../../shared/update";

interface UpdateModalProps {
  readonly open: boolean;
  readonly state: AppUpdateState | null;
  readonly onClose: () => void;
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
  readonly onSkip: (version: string) => void;
}

export function UpdateModal({
  open,
  state,
  onClose,
  onCheck,
  onDownload,
  onInstall,
  onSkip,
}: UpdateModalProps): React.ReactElement | null {
  if (!open) return null;
  const available = state?.available ?? null;
  const busy = state?.status === "checking" || state?.status === "downloading" || state?.status === "installing";
  const canDownload = state?.status === "available" && Boolean(available);
  const canInstall = state?.status === "downloaded" && Boolean(available);
  const progress = state?.progress;
  const releaseUrl = available?.releaseUrl;

  return (
    <div className="about-overlay" role="presentation" onMouseDown={onClose}>
      <section className="update-modal" role="dialog" aria-modal="true" aria-label="Shockless updates" onMouseDown={(event) => event.stopPropagation()}>
        <header className="update-modal-header">
          <div>
            <h2><Download size={18} /> Updates</h2>
            <p>{state?.message ?? "Check GitHub releases for a newer Shockless Engine build."}</p>
          </div>
          <button className="icon-action" type="button" onClick={onClose} aria-label="Close updates"><X size={16} /></button>
        </header>

        <div className="update-modal-body">
          <div className={`update-status-card update-${state?.status ?? "idle"}`}>
            <span>Current</span>
            <strong>{state?.currentVersion ? `v${state.currentVersion}` : "development build"}</strong>
            <span>Latest</span>
            <strong>{available ? `v${available.version}` : state?.status === "up-to-date" ? "Installed" : "-"}</strong>
            <span>Status</span>
            <strong>{statusText(state?.status)}</strong>
          </div>

          {available ? (
            <div className="update-release-card">
              <h3>Release {available.version}</h3>
              <p>{available.notes || "A newer public release is available from GitHub."}</p>
              <dl>
                <dt>Asset</dt>
                <dd>{available.assetName}</dd>
                <dt>Size</dt>
                <dd>{formatBytes(available.size)}</dd>
                <dt>Published</dt>
                <dd>{available.publishedAt ? new Date(available.publishedAt).toLocaleString() : "-"}</dd>
              </dl>
              {releaseUrl ? (
                <button className="update-link-button" type="button" onClick={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}>
                  <ExternalLink size={14} /> View Release
                </button>
              ) : null}
            </div>
          ) : null}

          {progress ? (
            <div className="update-progress" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
              <div>
                <span>{formatBytes(progress.bytesReceived)} / {formatBytes(progress.totalBytes)}</span>
                <strong>{progress.percent}%</strong>
              </div>
              <i style={{ width: `${progress.percent}%` }} />
            </div>
          ) : null}

          {state?.error ? <div className="update-error">{state.error}</div> : null}
        </div>

        <footer className="update-modal-actions">
          <button type="button" onClick={onCheck} disabled={busy}>
            <RefreshCw size={14} /> Check Again
          </button>
          {available ? (
            <button type="button" onClick={() => onSkip(available.version)} disabled={busy}>
              Skip This Version
            </button>
          ) : null}
          {canDownload ? (
            <button className="primary" type="button" onClick={onDownload}>
              <Download size={14} /> Download
            </button>
          ) : null}
          {canInstall ? (
            <button className="primary" type="button" onClick={onInstall}>
              <RotateCw size={14} /> Restart & Install
            </button>
          ) : null}
          <button type="button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function statusText(status: AppUpdateState["status"] | undefined): string {
  if (!status) return "Idle";
  return status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
