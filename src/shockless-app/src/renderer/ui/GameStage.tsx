import type { PointerEventHandler } from "react";
import type { AppUpdateState } from "../../shared/update";
import type { OriginsRealmId } from "../../shared/originsRealm";
import type {
  ClientProfileSummary,
  ClientSessionSummary,
  EngineLaunchState,
} from "../../shared/window-api";
import type { GameWebviewMount, ProfileImportUiState } from "./helpers";
import { ImporterWorkspace } from "./ImporterWorkspace";

interface GameStageProps {
  readonly mountedVisibleGameViews: readonly GameWebviewMount[];
  readonly selectedClientId: number;
  readonly engineUrl: string | null;
  readonly stageClickCaptureCount: number;
  readonly selectedClientSession: ClientSessionSummary | null;
  readonly selectedClientIsVisible: boolean;
  readonly desktopBridgeAvailable: boolean;
  readonly bridgeMessage: string;
  readonly engineBusy: boolean;
  readonly profileImportRunning: boolean;
  readonly engineLaunch: EngineLaunchState | null;
  readonly profileImportElapsedMs: number;
  readonly profileImportUi: ProfileImportUiState;
  readonly profiles: readonly ClientProfileSummary[];
  readonly selectedProfile: ClientProfileSummary | null;
  readonly updateState: AppUpdateState | null;
  readonly versionCheckDraft: string;
  readonly gameWebviewRefForClient: (clientId: number) => (element: Element | null) => void;
  readonly onStageCapturePointerDown: PointerEventHandler<HTMLDivElement>;
  readonly onImport: () => void;
  readonly onRefresh: () => void;
  readonly onStart: () => void;
  readonly onOpenUpdates: () => void;
  readonly onSetRealm: (value: OriginsRealmId) => void;
  readonly onSetHotelView: (value: string) => void;
  readonly onSetResizablePresentation: (enabled: boolean) => void;
  readonly onSetVersionCheckBuild: () => void;
  readonly onVersionCheckDraftChange: (value: string) => void;
}

export function GameStage(props: GameStageProps) {
  const importerOrHeadless = (overlay: boolean) => (
    <div className={`game-placeholder${overlay ? " game-placeholder-overlay" : ""}`}>
      {props.selectedClientSession && !props.selectedClientIsVisible ? (
        <div className="hotel-card">
          <img className="hotel-avatar" src="./img/avatar.png" alt="" aria-hidden="true" />
          <div>
            <strong>Headless client selected</strong>
            <p>client{props.selectedClientId} is headless; select a visible session to render a game view.</p>
          </div>
        </div>
      ) : (
        <ImporterWorkspace
          bridgeAvailable={props.desktopBridgeAvailable}
          bridgeMessage={props.bridgeMessage}
          engineBusy={props.engineBusy || props.profileImportRunning}
          settingsBusy={props.engineBusy && !props.profileImportRunning}
          engineLaunch={props.engineLaunch}
          elapsedMs={props.profileImportElapsedMs}
          importState={props.profileImportUi}
          profiles={props.profiles}
          selectedProfile={props.selectedProfile}
          updateState={props.updateState}
          onImport={props.onImport}
          onRefresh={props.onRefresh}
          onStart={props.onStart}
          onOpenUpdates={props.onOpenUpdates}
          onSetRealm={props.onSetRealm}
          onSetHotelView={props.onSetHotelView}
          onSetResizablePresentation={props.onSetResizablePresentation}
          onSetVersionCheckBuild={props.onSetVersionCheckBuild}
          versionCheckDraft={props.versionCheckDraft}
          onVersionCheckDraftChange={props.onVersionCheckDraftChange}
        />
      )}
    </div>
  );

  return (
    <div className="game-stage">
      {props.mountedVisibleGameViews.length > 0 ? (
        <div className="game-webview-stack">
          {props.mountedVisibleGameViews.map((view) => {
            const active = view.id === props.selectedClientId && Boolean(props.engineUrl) && view.url === props.engineUrl;
            return (
              <div
                key={`client-${view.id}`}
                className={`game-webview-zoom-surface ${active ? "active" : "inactive"}`}
                aria-hidden={!active}
                data-client-id={view.id}
                data-client-label={view.label}
              >
                <webview
                  ref={props.gameWebviewRefForClient(view.id)}
                  className="game-webview"
                  src={view.url}
                  partition={view.partition}
                  webpreferences="contextIsolation=yes,nodeIntegration=no"
                />
              </div>
            );
          })}
          {props.engineUrl && props.stageClickCaptureCount > 0 ? (
            <div className="stage-click-capture" role="button" tabIndex={-1} onPointerDown={props.onStageCapturePointerDown}>
              <span>Click stage to continue</span>
            </div>
          ) : null}
          {!props.engineUrl ? importerOrHeadless(true) : null}
        </div>
      ) : (
        importerOrHeadless(false)
      )}
    </div>
  );
}
