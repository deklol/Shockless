import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { AppUpdateState } from "../../../shared/update";

type AppendTimeline = (severity: "info" | "success" | "warning" | "error", message: string) => void;

interface UseUpdateActionsOptions {
  readonly appendTimeline: AppendTimeline;
  readonly setUpdateModalOpen: Dispatch<SetStateAction<boolean>>;
  readonly setUpdateState: Dispatch<SetStateAction<AppUpdateState | null>>;
}

/** Desktop update IPC actions and live update-state subscription. */
export function useUpdateActions(options: UseUpdateActionsOptions) {
  const refreshUpdateState = useCallback(async () => {
    if (!window.shockless?.getUpdateState) return null;
    const next = await window.shockless.getUpdateState();
    options.setUpdateState(next);
    return next;
  }, [options.setUpdateState]);

  const checkForUpdates = useCallback(async () => {
    if (!window.shockless?.checkForUpdates) return;
    options.setUpdateModalOpen(true);
    const next = await window.shockless.checkForUpdates();
    options.setUpdateState(next);
    options.appendTimeline(next.status === "error" ? "warning" : "info", next.message);
  }, [options.appendTimeline, options.setUpdateModalOpen, options.setUpdateState]);

  const downloadUpdate = useCallback(async () => {
    if (!window.shockless?.downloadUpdate) return;
    options.setUpdateModalOpen(true);
    const next = await window.shockless.downloadUpdate();
    options.setUpdateState(next);
    options.appendTimeline(next.status === "error" ? "warning" : "success", next.message);
  }, [options.appendTimeline, options.setUpdateModalOpen, options.setUpdateState]);

  const installDownloadedUpdate = useCallback(async () => {
    if (!window.shockless?.installDownloadedUpdate) return;
    if (!window.confirm("Restart Shockless Engine and install the downloaded update now?")) return;
    const next = await window.shockless.installDownloadedUpdate();
    options.setUpdateState(next);
    options.appendTimeline(next.status === "error" ? "warning" : "success", next.message);
  }, [options.appendTimeline, options.setUpdateState]);

  const skipUpdate = useCallback(
    async (version: string) => {
      if (!window.shockless?.skipUpdate) return;
      const next = await window.shockless.skipUpdate(version);
      options.setUpdateState(next);
      options.appendTimeline("info", next.message);
    },
    [options.appendTimeline, options.setUpdateState],
  );

  useEffect(() => {
    void refreshUpdateState();
    return window.shockless?.onUpdateState?.((next) => options.setUpdateState(next));
  }, [options.setUpdateState, refreshUpdateState]);

  return { refreshUpdateState, checkForUpdates, downloadUpdate, installDownloadedUpdate, skipUpdate };
}
