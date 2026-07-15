export type PluginCategory =
  | "core"
  | "session"
  | "room"
  | "user"
  | "inventory"
  | "automation"
  | "social"
  | "developer";

export type PluginStatus = "ready" | "mapped" | "partial" | "blocked";

export type PluginUiSurfaceKind = "panel" | "overlay" | "status" | "commands";

export type PluginOrigin = "built-in" | "user";

export type PluginPermission =
  | "ui.panel"
  | "ui.status"
  | "ui.overlay"
  | "console.commands"
  | "engine.snapshot"
  | "engine.control"
  | "notifications.show"
  | "client.rights"
  | "events.room"
  | "events.chat"
  | "events.packet"
  | "events.session"
  | "actions.avatar"
  | "actions.social"
  | "actions.fishing"
  | "actions.furni"
  | "actions.plants"
  | "actions.wallItems"
  | "chat.send"
  | "storage"
  | "packet.read"
  | "packet.inject"
  | "packet.intercept"
  | "packet.intercept.sensitive";

export interface PluginUiSurface {
  readonly id: string;
  readonly kind: PluginUiSurfaceKind;
  readonly label: string;
  readonly enabledByDefault: boolean;
  readonly summary: string;
  readonly layout?: readonly PluginUiElement[];
}

export type PluginUiElement =
  | PluginUiHeaderElement
  | PluginUiTextElement
  | PluginUiDividerElement
  | PluginUiSectionElement
  | PluginUiNoticeElement
  | PluginUiButtonElement
  | PluginUiButtonGridElement
  | PluginUiToggleElement
  | PluginUiCheckboxElement
  | PluginUiTextInputElement
  | PluginUiTextAreaElement
  | PluginUiNumberInputElement
  | PluginUiSliderElement
  | PluginUiColorInputElement
  | PluginUiSelectElement
  | PluginUiKeybindElement
  | PluginUiTableElement
  | PluginUiKeyValueElement
  | PluginUiLogElement;

export type PluginUiTone = "default" | "info" | "success" | "warning" | "danger";

export interface PluginUiBaseElement {
  readonly id?: string;
  readonly label?: string;
  readonly description?: string;
}

export interface PluginUiHeaderElement extends PluginUiBaseElement {
  readonly type: "header";
  readonly text: string;
  readonly level?: 2 | 3 | 4;
}

export interface PluginUiTextElement extends PluginUiBaseElement {
  readonly type: "text";
  readonly text: string;
  readonly tone?: PluginUiTone;
}

export interface PluginUiDividerElement extends PluginUiBaseElement {
  readonly type: "divider";
}

export interface PluginUiSectionElement extends PluginUiBaseElement {
  readonly type: "section";
  readonly title?: string;
  readonly children: readonly PluginUiElement[];
}

export interface PluginUiNoticeElement extends PluginUiBaseElement {
  readonly type: "notice";
  readonly title?: string;
  readonly text: string;
  readonly tone?: PluginUiTone;
}

export interface PluginUiActionElement extends PluginUiBaseElement {
  readonly action?: string;
  readonly command?: string;
}

export interface PluginUiButtonElement extends PluginUiActionElement {
  readonly type: "button";
  readonly label: string;
  readonly variant?: "default" | "primary" | "danger";
}

export interface PluginUiButtonGridElement extends PluginUiBaseElement {
  readonly type: "buttonGrid";
  readonly columns?: number;
  readonly buttons: readonly PluginUiButtonElement[];
}

export interface PluginUiToggleElement extends PluginUiActionElement {
  readonly type: "toggle";
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: boolean;
}

export interface PluginUiCheckboxElement extends PluginUiActionElement {
  readonly type: "checkbox";
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: boolean;
}

export interface PluginUiTextInputElement extends PluginUiActionElement {
  readonly type: "textInput";
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

export interface PluginUiTextAreaElement extends PluginUiActionElement {
  readonly type: "textArea";
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly rows?: number;
  readonly monospace?: boolean;
}

export interface PluginUiNumberInputElement extends PluginUiActionElement {
  readonly type: "numberInput";
  readonly id: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly defaultValue?: number;
}

export interface PluginUiSliderElement extends PluginUiActionElement {
  readonly type: "slider";
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly defaultValue?: number;
}

export interface PluginUiColorInputElement extends PluginUiActionElement {
  readonly type: "colorInput";
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: string;
}

export interface PluginUiSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface PluginUiSelectElement extends PluginUiActionElement {
  readonly type: "select";
  readonly id: string;
  readonly label: string;
  readonly options: readonly PluginUiSelectOption[];
  readonly defaultValue?: string;
}

export interface PluginUiKeybindElement extends PluginUiActionElement {
  readonly type: "keybind";
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: string;
}

export interface PluginUiTableColumn {
  readonly key: string;
  readonly label: string;
}

export interface PluginUiTableElement extends PluginUiBaseElement {
  readonly type: "table";
  readonly columns: readonly PluginUiTableColumn[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly rowKey?: string;
  readonly selectedRowKey?: string;
  readonly rowAction?: string;
  readonly maxRows?: number;
}

export interface PluginUiKeyValueRow {
  readonly key: string;
  readonly value: string | number | boolean | null;
}

export interface PluginUiKeyValueElement extends PluginUiBaseElement {
  readonly type: "kv";
  readonly rows: readonly PluginUiKeyValueRow[];
}

export interface PluginUiLogElement extends PluginUiBaseElement {
  readonly type: "log";
  readonly rows: readonly string[];
}

export interface PluginUiDefinition {
  readonly preview?: readonly PluginUiElement[];
  readonly settings?: readonly PluginUiElement[];
}

export interface PluginCommandDefinition {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly usage?: string;
  readonly aliases?: readonly string[];
}

export interface PluginHotkeyDefinition {
  readonly id?: string;
  readonly key: string;
  readonly command: string;
  readonly label?: string;
  readonly enabledByDefault?: boolean;
}

export interface SourceMapping {
  readonly habbpyV3: readonly string[];
  readonly shockless: readonly string[];
  readonly notes?: string;
}

export interface PluginManagedRuntime {
  readonly clientRights?: readonly string[];
}

export interface PluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: PluginCategory;
  readonly icon: string;
  readonly private?: boolean;
  readonly enabledByDefault: boolean;
  readonly status: PluginStatus;
  readonly summary: string;
  readonly capabilities: readonly string[];
  readonly uiSurfaces: readonly PluginUiSurface[];
  readonly sourceMapping: SourceMapping;
  readonly origin?: PluginOrigin;
  readonly core?: boolean;
  readonly version?: string;
  readonly author?: string;
  readonly entry?: string;
  readonly pluginRoot?: string;
  readonly permissions?: readonly PluginPermission[];
  readonly managedRuntime?: PluginManagedRuntime;
  readonly ui?: PluginUiDefinition;
  readonly commands?: readonly PluginCommandDefinition[];
  readonly hotkeys?: readonly PluginHotkeyDefinition[];
  readonly loadError?: string | null;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly entry: string;
  readonly icon?: string;
  readonly category: PluginCategory;
  readonly permissions: readonly PluginPermission[];
  readonly surfaces: readonly PluginUiSurface[];
  readonly managedRuntime?: PluginManagedRuntime;
  readonly ui?: PluginUiDefinition;
  readonly commands?: readonly PluginCommandDefinition[];
  readonly hotkeys?: readonly PluginHotkeyDefinition[];
}

export interface PluginLoadError {
  readonly pluginId: string | null;
  readonly sourcePath: string;
  readonly message: string;
}

export interface PluginRegistryState {
  readonly plugins: readonly PluginDefinition[];
  readonly enabledById: Readonly<Record<string, boolean>>;
  readonly uiSurfaceEnabledByPluginId: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly pinnedPluginIds: readonly string[];
  readonly userPluginRoot: string;
  readonly portablePluginRoot: string | null;
  readonly loadErrors: readonly PluginLoadError[];
  readonly message: string;
}

export interface PluginCreateRequest {
  readonly id: string;
  readonly name: string;
}

export interface PluginInstallResult {
  readonly ok: boolean;
  readonly message: string;
  readonly state: PluginRegistryState;
}

export interface PluginEntrySourceResult {
  readonly ok: boolean;
  readonly pluginId: string;
  readonly source: string | null;
  readonly message: string;
}
