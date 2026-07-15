import { startTransition, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { profileImportUiWithProgress, type ProfileImportUiState } from "./model";

interface UseProfileImportLifecycleOptions {
  readonly profileImportUi: ProfileImportUiState;
  readonly profileImportRunning: boolean;
  readonly refreshLibrary: () => Promise<unknown>;
  readonly setBooting: Dispatch<SetStateAction<boolean>>;
  readonly setBridgeMessage: Dispatch<SetStateAction<string>>;
  readonly setProfileImportUi: Dispatch<SetStateAction<ProfileImportUiState>>;
  readonly setProfileImportNow: Dispatch<SetStateAction<number>>;
}

/** Owns startup and importer progress timing while App remains composition-only. */
export function useProfileImportLifecycle(options: UseProfileImportLifecycleOptions): void {
  const completedImportRefreshRef = useRef("");

  useEffect(() => {
    let active = true;
    const startedAt = performance.now();
    const maximumTimer = window.setTimeout(() => {
      if (active) options.setBooting(false);
    }, 6_000);
    void options.refreshLibrary()
      .catch((error) => {
        if (active) options.setBridgeMessage(error instanceof Error ? error.message : "Startup initialization failed.");
      })
      .finally(() => {
        const remainingMinimumMs = Math.max(0, 700 - (performance.now() - startedAt));
        window.setTimeout(() => {
          if (active) options.setBooting(false);
        }, remainingMinimumMs);
      });
    return () => {
      active = false;
      window.clearTimeout(maximumTimer);
    };
  }, [options.refreshLibrary, options.setBooting, options.setBridgeMessage]);

  useEffect(() => {
    const latest = options.profileImportUi.latest;
    const completed =
      latest?.stage === "validate-profile" &&
      (latest.state === "done" || latest.state === "warning") &&
      latest.jobId !== completedImportRefreshRef.current;
    if (!completed) return;
    completedImportRefreshRef.current = latest.jobId;
    void options.refreshLibrary();
  }, [options.profileImportUi.latest, options.refreshLibrary]);

  useEffect(() => {
    const unsubscribe = window.shockless?.onProfileImportProgress?.((progress) => {
      startTransition(() => {
        options.setProfileImportUi((current) => profileImportUiWithProgress(current, progress));
      });
    });
    return () => unsubscribe?.();
  }, [options.setProfileImportUi]);

  useEffect(() => {
    if (!options.profileImportRunning) return;
    options.setProfileImportNow(Date.now());
    const timer = window.setInterval(() => options.setProfileImportNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [options.profileImportRunning, options.setProfileImportNow]);
}
