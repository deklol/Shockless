import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import {
  LINGO_VOID,
  LingoSymbol,
  type LingoValue,
} from "@director/values";
import type { RoomReadySummary } from "./RoomReadinessController";

interface PrivateRoomEntryControllerOptions {
  readonly movie: DirectorMovie;
  readonly navigatorComponent: () => ScriptInstance | null;
  readonly roomComponent: () => ScriptInstance | null;
  readonly currentFlatId: () => string | null;
  readonly activeEntryFlatId: () => string | null;
  readonly roomReady: () => RoomReadySummary;
  readonly waitForRoomReady: (timeoutMs?: number) => Promise<RoomReadySummary>;
  readonly summarizeValue: (value: LingoValue, depth: number) => unknown;
  readonly log: (kind: "info" | "error", message: string) => void;
}

export interface PrivateRoomEntryResult {
  readonly route: string;
  readonly flatId: string | null;
  readonly result: unknown;
  readonly roomReady: RoomReadySummary;
  readonly errors: string[];
}

/** Source-routed private-room entry with bounded stalled-entry recovery. */
export class PrivateRoomEntryController {
  private static readonly STALL_MS = 1800;
  private static readonly MAX_RETRIES = 8;

  private watch: { flatId: string; fingerprint: string; sinceMs: number; retries: number } | null = null;
  private readonly watchdogTimer: number;

  constructor(private readonly options: PrivateRoomEntryControllerOptions) {
    this.watchdogTimer = window.setInterval(() => this.watchdogTick(), 1000);
  }

  dispose(): void {
    window.clearInterval(this.watchdogTimer);
  }

  async enter(flatId?: string, skipRoomEntryChecks = true, timeoutMs = 60000): Promise<PrivateRoomEntryResult> {
    const errors: string[] = [];
    const targetFlatId = flatId && flatId.length > 0 ? flatId : this.options.currentFlatId();
    let result: LingoValue = LINGO_VOID;
    if (!targetFlatId) {
      errors.push("private room flat id not available");
    } else {
      const navigatorComponent = this.options.navigatorComponent();
      if (navigatorComponent instanceof ScriptInstance && this.options.movie.runtime.hasHandler(navigatorComponent, "prepareroomentry")) {
        try {
          result = this.options.movie.runtime.callMethod(navigatorComponent, "prepareroomentry", [
            targetFlatId,
            LingoSymbol.for("private"),
            skipRoomEntryChecks ? 1 : 0,
          ]);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      } else {
        errors.push("Navigator Component.prepareRoomEntry not available");
      }
    }
    const roomReady = await this.options.waitForRoomReady(timeoutMs);
    return {
      route: "Navigator Component.prepareRoomEntry(flatId, #private)",
      flatId: targetFlatId,
      result: this.options.summarizeValue(result, 2),
      roomReady,
      errors,
    };
  }

  watchdogSnapshot(): Record<string, unknown> {
    return {
      watching: this.watch
        ? { ...this.watch, stalledMs: Math.round(performance.now() - this.watch.sinceMs) }
        : null,
      stallMs: PrivateRoomEntryController.STALL_MS,
      maxRetries: PrivateRoomEntryController.MAX_RETRIES,
    };
  }

  private retry(flatId: string): void {
    const roomComponent = this.options.roomComponent();
    if (roomComponent) {
      try {
        this.options.movie.runtime.setInstanceProp(roomComponent, "proomconnectionrequested", 0);
      } catch {
        // Recovery remains best effort; the source re-drive below is authoritative.
      }
    }
    const navigatorComponent = this.options.navigatorComponent();
    if (navigatorComponent instanceof ScriptInstance && this.options.movie.runtime.hasHandler(navigatorComponent, "prepareroomentry")) {
      try {
        this.options.movie.runtime.callMethod(navigatorComponent, "prepareroomentry", [flatId, LingoSymbol.for("private"), 1]);
      } catch (error) {
        this.options.log("error", `room-entry retry failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private watchdogTick(): void {
    const flatId = this.options.activeEntryFlatId();
    const summary = this.options.roomReady();
    if (!flatId || summary.ready || !summary.roomComponentConnectionRequested) {
      this.watch = null;
      return;
    }

    const fingerprint = [
      summary.route,
      summary.roomId ?? "",
      summary.roomReportId ?? "",
      summary.roomLikeSpriteCount,
      summary.roomComponentCastLoaded ? 1 : 0,
      summary.roomComponentConnectionRequested ? 1 : 0,
      summary.roomComponentSavedDataCount,
      summary.roomComponentUserCount,
      summary.roomComponentActiveObjectCount,
      summary.roomComponentPassiveObjectCount,
      summary.roomComponentItemObjectCount,
    ].join("|");
    const now = performance.now();
    if (!this.watch || this.watch.flatId !== flatId) {
      this.watch = { flatId, fingerprint, sinceMs: now, retries: 0 };
      return;
    }
    if (this.watch.fingerprint !== fingerprint) {
      this.watch.fingerprint = fingerprint;
      this.watch.sinceMs = now;
      return;
    }
    if (now - this.watch.sinceMs < PrivateRoomEntryController.STALL_MS || this.watch.retries >= PrivateRoomEntryController.MAX_RETRIES) {
      return;
    }

    this.options.log(
      "info",
      `private room ${flatId} stalled at "${summary.route}" for ${Math.round(now - this.watch.sinceMs)}ms with no progress; auto-retrying entry (attempt ${this.watch.retries + 1}/${PrivateRoomEntryController.MAX_RETRIES})`,
    );
    this.retry(flatId);
    this.watch.sinceMs = now;
    this.watch.retries += 1;
  }
}
