import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import type { LingoValue } from "@director/values";
import type { StageRenderer } from "../../render/StageRenderer";
import { FurniVisibilityController } from "../furni/FurniVisibilityController";
import { UiVisibilityController } from "../ui/UiVisibilityController";
import { UserVisibilityController } from "../user/UserVisibilityController";

export interface RoomVisibilityControllerDependencies {
  movie: DirectorMovie;
  renderer: StageRenderer;
  objectById: (id: string) => LingoValue;
  instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  debugValue: (value: LingoValue | undefined) => unknown;
  collectUiChannels: (channels: Set<number>) => void;
  toolbarTop: () => number;
  markPresentationsDirty: () => void;
}

/** Coordinates independent furni, avatar, and Habbo UI visibility policies. */
export class RoomVisibilityController {
  private readonly furni: FurniVisibilityController;
  private readonly users: UserVisibilityController;
  private readonly ui: UiVisibilityController;

  constructor(private readonly dependencies: RoomVisibilityControllerDependencies) {
    this.furni = new FurniVisibilityController(dependencies);
    this.users = new UserVisibilityController(dependencies);
    this.ui = new UiVisibilityController(dependencies.collectUiChannels);
  }

  hiddenChatEntryMatches(entry: Readonly<Record<string, unknown>>): boolean {
    return this.users.hiddenChatEntryMatches(entry);
  }

  manualHiddenChannels(): Set<number> {
    const channels = new Set<number>();
    this.furni.collectHiddenChannels(channels);
    this.users.collectHiddenChannels(channels);
    this.ui.collectHiddenChannels(channels);
    return channels;
  }

  setHideFurni(value: boolean): Record<string, unknown> {
    const hideFurni = this.furni.setHidden(value);
    this.invalidatePresentation();
    return { hideFurni };
  }

  setHideUsers(value: boolean): Record<string, unknown> {
    const hideUsers = this.users.setHidden(value);
    this.invalidatePresentation();
    return { hideUsers };
  }

  setHideUi(value: boolean): Record<string, unknown> {
    const hideUi = this.ui.setHidden(value);
    this.invalidatePresentation();
    return { hideUi };
  }

  setHiddenUserFilter(entries: unknown): Record<string, unknown> {
    const result = this.users.setFilter(entries);
    this.invalidatePresentation();
    return result;
  }

  private invalidatePresentation(): void {
    this.dependencies.markPresentationsDirty();
    this.dependencies.renderer.markDirty();
  }
}
