export interface EngineStatus {
  readonly running: boolean;
  readonly embedded: boolean;
  readonly profileLabel: string;
  readonly buildLabel: string;
  readonly location: string;
  readonly fps: number | null;
  readonly tickRate: number | null;
  readonly latencyMs: number | null;
  readonly errors: number;
}

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type: "hotel-view" | "private" | "public" | "unknown";
  readonly users: number;
  readonly floorItems: number;
  readonly wallItems: number;
}

export interface AccountSummary {
  readonly name: string;
  readonly badge: string;
  readonly credits: number | null;
  readonly clubDays: number | null;
}

export interface AppState {
  readonly engine: EngineStatus;
  readonly account: AccountSummary;
  readonly room: RoomSummary;
  readonly ui: UiState;
  readonly plugins: PluginRuntimeState;
  readonly selectedPluginId: string;
  readonly commandTimeline: readonly TimelineEntry[];
}

export interface UiState {
  readonly dockCollapsed: boolean;
}

export interface PluginRuntimeState {
  readonly enabledById: Readonly<Record<string, boolean>>;
  readonly uiSurfaceEnabledByPluginId: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export interface TimelineEntry {
  readonly id: string;
  readonly time: string;
  readonly severity: "info" | "success" | "warning" | "error";
  readonly message: string;
}
