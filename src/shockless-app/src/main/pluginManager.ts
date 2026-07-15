import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPinnedPlugin, plugins, pluginSortValue } from "../plugins/registry.js";
import type {
  PluginCreateRequest,
  PluginDefinition,
  PluginEntrySourceResult,
  PluginInstallResult,
  PluginLoadError,
  PluginManifest,
  PluginCommandDefinition,
  PluginHotkeyDefinition,
  PluginManagedRuntime,
  PluginPermission,
  PluginRegistryState,
  PluginUiDefinition,
  PluginUiElement,
  PluginUiSurface,
} from "../shared/plugin.js";
import { defaultSensitiveClientHeaders, type PluginRelayPolicy } from "../shared/pluginRelayHooks.js";
import { withPluginSchemaDefaults } from "../shared/pluginSchemaDefaults.js";
import { errorMessage } from "../shared/errors.js";
import { PLUGIN_MANIFEST_FILE } from "../shared/branding.js";
import { LEGACY_PLUGIN_MANIFEST_FILES } from "../shared/legacyCompatibility.js";
import { appDataStorePath, firstExistingAppDataStorePath, legacyAppDataStoreRoots } from "./appDataPaths.js";

const PLUGIN_DIR = "plugins";
const SETTINGS_FILE = "settings.json";
const MANIFEST_FILE = PLUGIN_MANIFEST_FILE;
const REGISTRY_VERSION = 1;
const APP_TOOL_PLUGIN_IDS = new Set(["settings", "plugin-manager", "app-settings", "plugins"]);

function reservedPluginIds(): Set<string> {
  return new Set([...plugins.map((plugin) => plugin.id), ...APP_TOOL_PLUGIN_IDS]);
}

const allowedCategories = new Set(["session", "room", "user", "inventory", "automation", "social", "developer"]);
const allowedPermissions = new Set<PluginPermission>([
  "ui.panel",
  "ui.status",
  "ui.overlay",
  "console.commands",
  "engine.snapshot",
  "engine.control",
  "notifications.show",
  "client.rights",
  "events.room",
  "events.chat",
  "events.packet",
  "events.session",
  "actions.avatar",
  "actions.social",
  "actions.fishing",
  "actions.furni",
  "actions.plants",
  "actions.wallItems",
  "chat.send",
  "storage",
  "packet.read",
  "packet.inject",
  "packet.intercept",
  "packet.intercept.sensitive",
]);
const MAX_PLUGIN_ENTRY_BYTES = 512 * 1024;
// Matches filenames that almost certainly contain local credentials or secrets.
// Deliberately narrow Ã¢â‚¬â€ false positives would block legitimate plugin installs.
const obviousPrivateFilePattern = /(multiclient-accounts|password|credential|secret|token|webhook)/i;
const forbiddenPluginSourceRules: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "external URL literals", pattern: /\b(?:https?|wss?):\/\//i },
  { label: "network APIs", pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/ },
  { label: "worker or broadcast APIs", pattern: /\b(?:Worker|SharedWorker|BroadcastChannel|importScripts)\b/ },
  { label: "dynamic code execution", pattern: /\b(?:eval|Function)\s*\(/ },
  { label: "dynamic imports", pattern: /\bimport\s*\(/ },
  { label: "static imports", pattern: /^\s*import\s+(?:[\s\S]*?from\s+)?["']/m },
  { label: "browser storage or clipboard globals", pattern: /\b(?:localStorage|sessionStorage|indexedDB|caches)\b|navigator\.clipboard/ },
  { label: "keyboard event capture", pattern: /\b(?:keydown|keyup|keypress|beforeinput|KeyboardEvent)\b/ },
  { label: "DOM globals", pattern: /\b(?:document|window)\b/ },
];

function validatePluginSourceSecurity(source: string): string | null {
  for (const rule of forbiddenPluginSourceRules) {
    if (rule.pattern.test(source)) return "Plugin source uses blocked " + rule.label + ". Use Shockless host APIs instead.";
  }
  return null;
}

interface StoredPluginSettings {
  readonly version: number;
  readonly enabledById: Record<string, boolean>;
  readonly uiSurfaceEnabledByPluginId: Record<string, Record<string, boolean>>;
  readonly permissionGrants: Record<string, readonly PluginPermission[]>;
}

interface DiscoveryResult {
  readonly plugins: readonly PluginDefinition[];
  readonly errors: readonly PluginLoadError[];
}

export class PluginManager {
  constructor(private readonly appDataPath: string) {}

  state(message = "Plugin manager ready."): PluginRegistryState {
    const discovered = this.discoverUserPlugins();
    const allPlugins = this.sortedPlugins([...plugins, ...discovered.plugins]);
    const stored = this.readSettings();
    const enabledById = this.enabledState(allPlugins, stored);
    const uiSurfaceEnabledByPluginId = this.surfaceState(allPlugins, stored);
    return {
      plugins: allPlugins,
      enabledById,
      uiSurfaceEnabledByPluginId,
      pinnedPluginIds: allPlugins.filter(isPinnedPlugin).map((plugin) => plugin.id),
      userPluginRoot: this.userPluginRoot(),
      portablePluginRoot: this.portablePluginRoot(),
      loadErrors: discovered.errors,
      message,
    };
  }

  setPluginEnabled(pluginId: string, enabled: boolean): PluginRegistryState {
    const current = this.state();
    const plugin = current.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) return this.state(`Plugin not found: ${pluginId}`);
    if (isPinnedPlugin(plugin) && !enabled) return this.state(`${plugin.name} is pinned and cannot be disabled.`);
    const stored = this.readSettings();
    const uiSurfaceEnabledByPluginId = enabled
      ? activateUsablePluginSurfaces(plugin, stored.uiSurfaceEnabledByPluginId)
      : stored.uiSurfaceEnabledByPluginId;
    this.writeSettings({
      ...stored,
      enabledById: {
        ...stored.enabledById,
        [pluginId]: enabled,
      },
      uiSurfaceEnabledByPluginId,
    });
    return this.state(`${plugin.name} ${enabled ? "enabled" : "disabled"}.`);
  }

  setPluginSurfaceEnabled(pluginId: string, surfaceId: string, enabled: boolean): PluginRegistryState {
    const current = this.state();
    const plugin = current.plugins.find((entry) => entry.id === pluginId);
    const surface = plugin?.uiSurfaces.find((entry) => entry.id === surfaceId);
    if (!plugin || !surface) return this.state(`Plugin surface not found: ${pluginId}.${surfaceId}`);
    const stored = this.readSettings();
    this.writeSettings({
      ...stored,
      uiSurfaceEnabledByPluginId: {
        ...stored.uiSurfaceEnabledByPluginId,
        [pluginId]: {
          ...stored.uiSurfaceEnabledByPluginId[pluginId],
          [surfaceId]: enabled,
        },
      },
    });
    return this.state(`${plugin.name} ${surface.label} ${enabled ? "enabled" : "disabled"}.`);
  }

  reload(): PluginRegistryState {
    return this.state("Plugins reloaded.");
  }

  readPluginEntrySource(pluginId: string): PluginEntrySourceResult {
    const id = String(pluginId ?? "").trim();
    const state = this.state();
    const plugin = state.plugins.find((entry) => entry.id === id && entry.origin === "user");
    if (!plugin) return { ok: false, pluginId: id, source: null, message: `User plugin not found: ${id}` };
    if (state.enabledById[plugin.id] === false) {
      return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} is disabled.` };
    }
    if (!plugin.entry || !plugin.pluginRoot) {
      return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} has no entry file.` };
    }
    const entryPath = safePluginPath(plugin.pluginRoot, relative(plugin.pluginRoot, plugin.entry));
    if (!entryPath || entryPath !== plugin.entry || !existsSync(entryPath)) {
      return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} entry is no longer valid.` };
    }
    const entryStats = statSync(entryPath);
    if (!entryStats.isFile()) {
      return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} entry is not a file.` };
    }
    if (entryStats.size > MAX_PLUGIN_ENTRY_BYTES) {
      return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} entry is larger than the 512 KB host limit.` };
    }
    const source = readFileSync(entryPath, "utf8");
    const securityError = validatePluginSourceSecurity(source);
    if (securityError) return { ok: false, pluginId: plugin.id, source: null, message: `${plugin.name} blocked: ${securityError}` };
    return {
      ok: true,
      pluginId: plugin.id,
      source,
      message: `${plugin.name} entry loaded.`,
    };
  }

  relayPolicy(): PluginRelayPolicy {
    const state = this.state();
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      sensitiveClientHeaders: defaultSensitiveClientHeaders(),
      grants: state.plugins
        .filter((plugin) => state.enabledById[plugin.id] !== false)
        .filter((plugin) => plugin.permissions?.some((permission) => permission.startsWith("packet.")))
        .map((plugin) => ({
          pluginId: plugin.id,
          permissions: plugin.permissions ?? [],
        })),
    };
  }

  createFromTemplate(request: PluginCreateRequest): PluginInstallResult {
    const id = sanitizePluginId(request.id);
    const name = String(request.name ?? "").trim() || titleFromPluginId(id);
    if (!id) return { ok: false, message: "Plugin id must use lowercase letters, numbers, and hyphens.", state: this.state() };
    const reserved = reservedPluginIds().has(id);
    if (reserved) return { ok: false, message: `Plugin id '${id}' is reserved by Shockless.`, state: this.state() };
    const targetRoot = join(this.userPluginRoot(), id);
    if (existsSync(targetRoot)) return { ok: false, message: `Plugin folder already exists: ${id}`, state: this.state() };
    const templateRoot = resolveTemplateRoot();
    mkdirSync(dirname(targetRoot), { recursive: true });
    cpSync(templateRoot, targetRoot, { recursive: true, errorOnExist: true });
    const copiedManifestPath = pluginManifestPath(targetRoot);
    if (!copiedManifestPath) throw new Error("Copied plugin template is missing a manifest.");
    const manifest = JSON.parse(readFileSync(copiedManifestPath, "utf8")) as Record<string, unknown>;
    manifest.id = id;
    manifest.name = name;
    const manifestPath = join(targetRoot, MANIFEST_FILE);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const legacyFile of LEGACY_PLUGIN_MANIFEST_FILES) rmSync(join(targetRoot, legacyFile), { force: true });
    const validation = this.validateUserPluginRoot(targetRoot, reservedPluginIds());
    if (!validation.ok) {
      rmSync(targetRoot, { recursive: true, force: true });
      return { ok: false, message: validation.message, state: this.state() };
    }
    this.enableNewPlugin(id);
    return { ok: true, message: `Created plugin '${name}' from template.`, state: this.state(`Created plugin '${name}'.`) };
  }

  installFromFolder(sourceFolder: string): PluginInstallResult {
    const sourceRoot = resolve(String(sourceFolder ?? ""));
    const validation = this.validateUserPluginRoot(sourceRoot, reservedPluginIds());
    if (!validation.ok) return { ok: false, message: validation.message, state: this.state() };
    if (folderHasObviousPrivateFiles(sourceRoot)) {
      return { ok: false, message: "Plugin install refused because the folder contains obvious credential/webhook files.", state: this.state() };
    }
    const id = validation.plugin.id;
    const targetRoot = join(this.userPluginRoot(), id);
    if (existsSync(targetRoot)) return { ok: false, message: `Plugin folder already exists: ${id}`, state: this.state() };
    mkdirSync(dirname(targetRoot), { recursive: true });
    cpSync(sourceRoot, targetRoot, { recursive: true, errorOnExist: true });
    this.enableNewPlugin(id);
    return { ok: true, message: `Installed plugin '${validation.plugin.name}'.`, state: this.state(`Installed plugin '${validation.plugin.name}'.`) };
  }

  uninstallPlugin(pluginId: string): PluginInstallResult {
    const id = sanitizePluginId(pluginId);
    if (!id) return { ok: false, message: "Plugin id is invalid.", state: this.state() };
    const current = this.state();
    const plugin = current.plugins.find((entry) => entry.id === id);
    if (!plugin) return { ok: false, message: `Plugin not found: ${id}`, state: current };
    if (plugin.origin !== "user" || !plugin.pluginRoot) {
      return { ok: false, message: `${plugin.name} is built in and cannot be uninstalled.`, state: current };
    }
    const targetRoot = safeRemovablePluginRoot(
      plugin.pluginRoot,
      [...this.userPluginRootsForRead(), this.portablePluginRoot()].filter((entry): entry is string => Boolean(entry)),
    );
    if (!targetRoot) return { ok: false, message: `${plugin.name} is not inside a managed plugin folder.`, state: current };
    if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) return { ok: false, message: `${plugin.name} folder no longer exists.`, state: this.state() };
    rmSync(targetRoot, { recursive: true, force: true });
    const stored = this.readSettings();
    const enabledById = { ...stored.enabledById };
    const uiSurfaceEnabledByPluginId = { ...stored.uiSurfaceEnabledByPluginId };
    const permissionGrants = { ...stored.permissionGrants };
    delete enabledById[id];
    delete uiSurfaceEnabledByPluginId[id];
    delete permissionGrants[id];
    this.writeSettings({ ...stored, enabledById, uiSurfaceEnabledByPluginId, permissionGrants });
    return { ok: true, message: `Uninstalled plugin '${plugin.name}'.`, state: this.state(`Uninstalled plugin '${plugin.name}'.`) };
  }

  userPluginRoot(): string {
    return appDataStorePath(this.appDataPath, PLUGIN_DIR);
  }

  portablePluginRoot(): string | null {
    const execPath = process.execPath ? dirname(process.execPath) : "";
    const candidate = execPath ? join(execPath, PLUGIN_DIR) : "";
    return candidate || null;
  }

  private discoverUserPlugins(): DiscoveryResult {
    const errors: PluginLoadError[] = [];
    const accepted = new Map<string, PluginDefinition>();
    const seenIds = reservedPluginIds();
    for (const root of [...this.userPluginRootsForRead(), this.portablePluginRoot()].filter((entry): entry is string => Boolean(entry))) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipPluginDirectory(entry.name)) continue;
        const pluginRoot = join(root, entry.name);
        const validation = this.validateUserPluginRoot(pluginRoot, seenIds);
        if (!validation.ok) {
          errors.push({ pluginId: validation.pluginId, sourcePath: pluginRoot, message: validation.message });
          continue;
        }
        accepted.set(validation.plugin.id, validation.plugin);
        seenIds.add(validation.plugin.id);
      }
    }
    return { plugins: [...accepted.values()], errors };
  }

  private validateUserPluginRoot(
    pluginRoot: string,
    reservedIds: ReadonlySet<string>,
  ):
    | { readonly ok: true; readonly plugin: PluginDefinition }
    | { readonly ok: false; readonly pluginId: string | null; readonly message: string } {
    const root = resolve(pluginRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) return { ok: false, pluginId: null, message: "Plugin folder does not exist." };
    const manifestPath = pluginManifestPath(root);
    if (!manifestPath) return { ok: false, pluginId: null, message: `Missing ${MANIFEST_FILE}.` };
    let manifest: PluginManifest;
    try {
      manifest = normalizeManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch (error) {
      return { ok: false, pluginId: null, message: errorMessage(error) };
    }
    if (reservedIds.has(manifest.id)) return { ok: false, pluginId: manifest.id, message: `Duplicate or reserved plugin id: ${manifest.id}.` };
    const entryPath = safePluginPath(root, manifest.entry);
    if (!entryPath || !existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return { ok: false, pluginId: manifest.id, message: `Plugin entry not found: ${manifest.entry}.` };
    }
    const entryStats = statSync(entryPath);
    if (entryStats.size > MAX_PLUGIN_ENTRY_BYTES) {
      return { ok: false, pluginId: manifest.id, message: `Plugin entry is larger than the 512 KB host limit: ${manifest.entry}.` };
    }
    const securityError = validatePluginSourceSecurity(readFileSync(entryPath, "utf8"));
    if (securityError) return { ok: false, pluginId: manifest.id, message: securityError };
    return {
      ok: true,
      plugin: withPluginSchemaDefaults({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        private: manifest.private,
        category: manifest.category,
        icon: manifest.icon ?? "terminal",
        enabledByDefault: false,
        status: "ready",
        summary: manifest.description ?? "User plugin.",
        capabilities: manifest.permissions.map((permission) => permission),
        uiSurfaces: manifest.surfaces,
        sourceMapping: {
          habbpyV3: ["User plugin"],
          shockless: [manifest.entry],
          notes: "Loaded from a user plugin manifest.",
        },
        origin: "user",
        core: false,
        entry: entryPath,
        pluginRoot: root,
        permissions: manifest.permissions,
        managedRuntime: manifest.managedRuntime,
        ui: manifest.ui,
        commands: manifest.commands,
        hotkeys: manifest.hotkeys,
        loadError: null,
      }),
    };
  }

  private sortedPlugins(pluginList: readonly PluginDefinition[]): readonly PluginDefinition[] {
    return [...pluginList].sort((left, right) => {
      const leftPinned = isPinnedPlugin(left) ? 0 : 1;
      const rightPinned = isPinnedPlugin(right) ? 0 : 1;
      if (leftPinned !== rightPinned) return leftPinned - rightPinned;
      const leftSort = pluginSortValue(left.id);
      const rightSort = pluginSortValue(right.id);
      if (leftSort !== rightSort) return leftSort - rightSort;
      return left.name.localeCompare(right.name);
    });
  }

  private enabledState(pluginList: readonly PluginDefinition[], stored: StoredPluginSettings): Readonly<Record<string, boolean>> {
    return Object.fromEntries(
      pluginList.map((plugin) => [
        plugin.id,
        isPinnedPlugin(plugin) ? true : stored.enabledById[plugin.id] ?? plugin.enabledByDefault,
      ]),
    );
  }

  private surfaceState(
    pluginList: readonly PluginDefinition[],
    stored: StoredPluginSettings,
  ): Readonly<Record<string, Readonly<Record<string, boolean>>>> {
    return Object.fromEntries(
      pluginList.map((plugin) => {
        const enabled = isPinnedPlugin(plugin) ? true : stored.enabledById[plugin.id] ?? plugin.enabledByDefault;
        return [plugin.id, surfaceStateForPlugin(plugin, stored.uiSurfaceEnabledByPluginId, enabled)];
      }),
    );
  }

  private enableNewPlugin(pluginId: string): void {
    const stored = this.readSettings();
    this.writeSettings({
      ...stored,
      enabledById: {
        ...stored.enabledById,
        [pluginId]: true,
      },
    });
  }

  private readSettings(): StoredPluginSettings {
    const filePath = firstExistingAppDataStorePath(this.appDataPath, PLUGIN_DIR, SETTINGS_FILE);
    if (!existsSync(filePath)) return defaultStoredPluginSettings();
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredPluginSettings>;
      return {
        version: REGISTRY_VERSION,
        enabledById: cleanBooleanRecord(parsed.enabledById),
        uiSurfaceEnabledByPluginId: cleanNestedBooleanRecord(parsed.uiSurfaceEnabledByPluginId),
        permissionGrants: cleanPermissionRecord(parsed.permissionGrants),
      };
    } catch {
      return defaultStoredPluginSettings();
    }
  }

  private writeSettings(settings: StoredPluginSettings): void {
    const filePath = this.settingsPath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private settingsPath(): string {
    return appDataStorePath(this.appDataPath, PLUGIN_DIR, SETTINGS_FILE);
  }

  private userPluginRootsForRead(): readonly string[] {
    const roots = [this.userPluginRoot(), ...legacyAppDataStoreRoots(this.appDataPath).map((root) => join(root, PLUGIN_DIR))];
    return [...new Set(roots.map((root) => resolve(root)))];
  }
}

function normalizeManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object") throw new Error("Plugin manifest must be an object.");
  const record = value as Record<string, unknown>;
  const id = sanitizePluginId(record.id);
  if (!id) throw new Error("Plugin id must use lowercase letters, numbers, and hyphens.");
  const name = cleanRequiredString(record.name, "Plugin name");
  const version = cleanRequiredString(record.version, "Plugin version");
  const entry = cleanRequiredString(record.entry, "Plugin entry");
  const category = cleanRequiredString(record.category, "Plugin category");
  if (!allowedCategories.has(category)) throw new Error(`Invalid plugin category: ${category}.`);
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.map((entry) => cleanRequiredString(entry, "Plugin permission"))
    : [];
  for (const permission of permissions) {
    if (!allowedPermissions.has(permission as PluginPermission)) throw new Error(`Invalid plugin permission: ${permission}.`);
  }
  const surfaces = Array.isArray(record.surfaces) ? record.surfaces.map(normalizeSurface) : [];
  if (surfaces.length === 0) throw new Error("Plugin manifest must define at least one surface.");
  const managedRuntime = normalizeManagedRuntime(record.managedRuntime);
  if ((managedRuntime?.clientRights?.length ?? 0) > 0 && !permissions.includes("client.rights")) {
    throw new Error("managedRuntime.clientRights requires the client.rights permission.");
  }
  return {
    id,
    name,
    version,
    author: typeof record.author === "string" ? record.author.trim() : undefined,
    private: record.private === true,
    description: typeof record.description === "string" ? record.description.trim() : undefined,
    entry,
    icon: typeof record.icon === "string" ? record.icon.trim() || "terminal" : "terminal",
    category: category as PluginManifest["category"],
    permissions: permissions as readonly PluginPermission[],
    surfaces,
    managedRuntime,
    ui: normalizeUiDefinition(record.ui),
    commands: normalizeCommands(record.commands),
    hotkeys: normalizeHotkeys(record.hotkeys),
  };
}

function normalizeManagedRuntime(value: unknown): PluginManagedRuntime | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const clientRights = Array.isArray(record.clientRights)
    ? uniqueClientRights(record.clientRights.map((entry) => String(entry ?? "")))
    : [];
  return clientRights.length > 0 ? { clientRights } : undefined;
}

function normalizeSurface(value: unknown): PluginUiSurface {
  if (!value || typeof value !== "object") throw new Error("Plugin surface must be an object.");
  const record = value as Record<string, unknown>;
  const id = sanitizeSurfaceId(record.id);
  const kind = cleanRequiredString(record.kind, "Plugin surface kind");
  if (!["panel", "overlay", "status", "commands"].includes(kind)) throw new Error(`Invalid plugin surface kind: ${kind}.`);
  return {
    id,
    kind: kind as PluginUiSurface["kind"],
    label: cleanRequiredString(record.label, "Plugin surface label"),
    enabledByDefault: record.enabledByDefault !== false,
    summary: cleanRequiredString(record.summary, "Plugin surface summary"),
    layout: Array.isArray(record.layout) ? normalizeUiElements(record.layout, 0) : undefined,
  };
}

function normalizeUiDefinition(value: unknown): PluginUiDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const preview = Array.isArray(record.preview) ? normalizeUiElements(record.preview, 0) : undefined;
  const settings = Array.isArray(record.settings) ? normalizeUiElements(record.settings, 0) : undefined;
  return preview || settings ? { preview, settings } : undefined;
}

function normalizeCommands(value: unknown): readonly PluginCommandDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Plugin command must be an object.");
    const record = entry as Record<string, unknown>;
    const name = cleanCommandName(record.name);
    const aliases = Array.isArray(record.aliases) ? record.aliases.map(cleanCommandName).filter(Boolean) : [];
    return {
      name,
      label: optionalShortString(record.label, 80),
      description: cleanRequiredString(record.description, `Plugin command ${name} description`),
      usage: typeof record.usage === "string" && record.usage.trim() ? record.usage.trim().slice(0, 160) : undefined,
      aliases,
    };
  });
}

function normalizeHotkeys(value: unknown): readonly PluginHotkeyDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Plugin hotkey must be an object.");
    const record = entry as Record<string, unknown>;
    const key = cleanRequiredString(record.key, "Plugin hotkey key").slice(0, 64);
    const command = cleanRequiredString(record.command, "Plugin hotkey command").slice(0, 160);
    return {
      id: typeof record.id === "string" && record.id.trim() ? sanitizeSurfaceId(record.id) : undefined,
      key,
      command,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim().slice(0, 80) : undefined,
      enabledByDefault: record.enabledByDefault !== false,
    };
  });
}

function normalizeUiElements(value: readonly unknown[], depth: number): readonly PluginUiElement[] {
  if (depth > 4) throw new Error("Plugin UI schema is nested too deeply.");
  if (value.length > 100) throw new Error("Plugin UI schema has too many elements.");
  return value.map((entry) => normalizeUiElement(entry, depth));
}

function normalizeUiElement(value: unknown, depth: number): PluginUiElement {
  if (!value || typeof value !== "object") throw new Error("Plugin UI element must be an object.");
  const record = value as Record<string, unknown>;
  const type = cleanRequiredString(record.type, "Plugin UI element type");
  const base = normalizeUiBase(record);
  switch (type) {
    case "header":
      return { ...base, type, text: cleanRequiredString(record.text, "Header text"), level: normalizeHeaderLevel(record.level) };
    case "text":
      return { ...base, type, text: cleanRequiredString(record.text, "Text element text"), tone: normalizeTone(record.tone) };
    case "divider":
      return { ...base, type };
    case "section":
      return {
        ...base,
        type,
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim().slice(0, 80) : undefined,
        children: Array.isArray(record.children) ? normalizeUiElements(record.children, depth + 1) : [],
      };
    case "notice":
      return {
        ...base,
        type,
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim().slice(0, 80) : undefined,
        text: cleanRequiredString(record.text, "Notice text"),
        tone: normalizeTone(record.tone),
      };
    case "button":
      return { ...base, ...normalizeUiAction(record), type, label: cleanRequiredString(record.label, "Button label"), variant: normalizeButtonVariant(record.variant) };
    case "buttonGrid":
      return {
        ...base,
        type,
        columns: optionalFiniteNumber(record.columns),
        buttons: normalizeButtonGridButtons(record.buttons, depth),
      };
    case "toggle":
    case "checkbox":
      return { ...base, ...normalizeUiAction(record), type, id: sanitizeSurfaceId(record.id), label: cleanRequiredString(record.label, "Control label"), defaultValue: record.defaultValue === true };
    case "textInput":
      return { ...base, ...normalizeUiAction(record), type, id: sanitizeSurfaceId(record.id), label: cleanRequiredString(record.label, "Input label"), placeholder: optionalShortString(record.placeholder, 100), defaultValue: optionalShortString(record.defaultValue, 500) ?? "" };
    case "textArea":
      return {
        ...base,
        ...normalizeUiAction(record),
        type,
        id: sanitizeSurfaceId(record.id),
        label: cleanRequiredString(record.label, "Text area label"),
        placeholder: optionalShortString(record.placeholder, 200),
        defaultValue: optionalShortString(record.defaultValue, 32_768) ?? "",
        rows: Math.max(2, Math.min(20, Math.trunc(optionalFiniteNumber(record.rows) ?? 6))),
        monospace: record.monospace !== false,
      };
    case "numberInput":
      return { ...base, ...normalizeUiAction(record), type, id: sanitizeSurfaceId(record.id), label: cleanRequiredString(record.label, "Number input label"), min: optionalFiniteNumber(record.min), max: optionalFiniteNumber(record.max), step: optionalFiniteNumber(record.step), defaultValue: optionalFiniteNumber(record.defaultValue) ?? 0 };
    case "slider":
      return {
        ...base,
        ...normalizeUiAction(record),
        type,
        id: sanitizeSurfaceId(record.id),
        label: cleanRequiredString(record.label, "Slider label"),
        min: optionalFiniteNumber(record.min) ?? 0,
        max: optionalFiniteNumber(record.max) ?? 100,
        step: optionalFiniteNumber(record.step),
        defaultValue: optionalFiniteNumber(record.defaultValue) ?? optionalFiniteNumber(record.min) ?? 0,
      };
    case "colorInput":
      return {
        ...base,
        ...normalizeUiAction(record),
        type,
        id: sanitizeSurfaceId(record.id),
        label: cleanRequiredString(record.label, "Color input label"),
        defaultValue: normalizeHexColor(record.defaultValue) ?? "#ffffff",
      };
    case "select":
      return { ...base, ...normalizeUiAction(record), type, id: sanitizeSurfaceId(record.id), label: cleanRequiredString(record.label, "Select label"), options: normalizeSelectOptions(record.options), defaultValue: optionalShortString(record.defaultValue, 120) };
    case "keybind":
      return { ...base, ...normalizeUiAction(record), type, id: sanitizeSurfaceId(record.id), label: cleanRequiredString(record.label, "Keybind label"), defaultValue: optionalShortString(record.defaultValue, 64) };
    case "table":
      return {
        ...base,
        type,
        columns: normalizeTableColumns(record.columns),
        rows: normalizeTableRows(record.rows),
        rowKey: optionalSanitizedId(record.rowKey),
        selectedRowKey: optionalShortString(record.selectedRowKey, 160),
        rowAction: optionalShortString(record.rowAction, 80),
        maxRows: optionalFiniteNumber(record.maxRows),
      };
    case "kv":
      return { ...base, type, rows: normalizeKeyValueRows(record.rows) };
    case "log":
      return { ...base, type, rows: Array.isArray(record.rows) ? record.rows.map((row) => String(row ?? "").slice(0, 500)).slice(-200) : [] };
    default:
      throw new Error(`Invalid plugin UI element type: ${type}.`);
  }
}

function normalizeUiBase(record: Record<string, unknown>): { readonly id?: string; readonly label?: string; readonly description?: string } {
  return {
    id: typeof record.id === "string" && record.id.trim() ? sanitizeSurfaceId(record.id) : undefined,
    label: optionalShortString(record.label, 80),
    description: optionalShortString(record.description, 240),
  };
}

function normalizeUiAction(record: Record<string, unknown>): { readonly action?: string; readonly command?: string } {
  return {
    action: optionalShortString(record.action, 80),
    command: optionalShortString(record.command, 200),
  };
}

function normalizeButtonGridButtons(value: unknown, depth: number): readonly Extract<PluginUiElement, { readonly type: "button" }>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Button grid entry must be an object.");
    const button = normalizeUiElement({ ...(entry as Record<string, unknown>), type: "button" }, depth + 1);
    if (button.type !== "button") throw new Error("Button grid entries must be buttons.");
    return button;
  });
}

function normalizeHeaderLevel(value: unknown): 2 | 3 | 4 {
  return value === 2 || value === 4 ? value : 3;
}

function normalizeTone(value: unknown): "default" | "info" | "success" | "warning" | "danger" | undefined {
  return value === "info" || value === "success" || value === "warning" || value === "danger" ? value : undefined;
}

function normalizeButtonVariant(value: unknown): "default" | "primary" | "danger" | undefined {
  return value === "primary" || value === "danger" ? value : undefined;
}

function normalizeSelectOptions(value: unknown): readonly { readonly value: string; readonly label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Select option must be an object.");
    const record = entry as Record<string, unknown>;
    return { value: cleanRequiredString(record.value, "Select option value").slice(0, 120), label: cleanRequiredString(record.label, "Select option label").slice(0, 120) };
  });
}

function normalizeTableColumns(value: unknown): readonly { readonly key: string; readonly label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Table column must be an object.");
    const record = entry as Record<string, unknown>;
    return { key: sanitizeSurfaceId(record.key), label: cleanRequiredString(record.label, "Table column label").slice(0, 80) };
  });
}

function normalizeTableRows(value: unknown): readonly Readonly<Record<string, string | number | boolean | null>>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((entry) => {
    if (!entry || typeof entry !== "object") return {};
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).slice(0, 48).map(([key, rowValue]) => [key, normalizePrimitive(rowValue)]),
    );
  });
}

function normalizeKeyValueRows(value: unknown): readonly { readonly key: string; readonly value: string | number | boolean | null }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Key/value row must be an object.");
    const record = entry as Record<string, unknown>;
    return { key: cleanRequiredString(record.key, "Key/value row key").slice(0, 80), value: normalizePrimitive(record.value) };
  });
}

function normalizePrimitive(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  return String(value ?? "").slice(0, 500);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalShortString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : undefined;
}

function optionalSanitizedId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? sanitizeSurfaceId(value) : undefined;
}

function cleanCommandName(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._:-]{1,63}$/.test(text)) throw new Error("Plugin command name is invalid.");
  return text;
}

function safePluginPath(root: string, requestedPath: string): string | null {
  if (isAbsolute(requestedPath)) return null;
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(root, normalize(requestedPath));
  const offset = relative(resolvedRoot, resolvedPath);
  if (offset.startsWith("..") || isAbsolute(offset)) return null;
  return resolvedPath;
}

function safeRemovablePluginRoot(pluginRoot: string, allowedRoots: readonly string[]): string | null {
  const resolvedPluginRoot = resolve(pluginRoot);
  for (const allowedRoot of allowedRoots) {
    const resolvedAllowedRoot = resolve(allowedRoot);
    const offset = relative(resolvedAllowedRoot, resolvedPluginRoot);
    if (!offset || offset.startsWith("..") || isAbsolute(offset)) continue;
    return resolvedPluginRoot;
  }
  return null;
}

function folderHasObviousPrivateFiles(root: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (obviousPrivateFilePattern.test(entry.name)) return true;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
    }
  }
  return false;
}

function sanitizePluginId(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(text) ? text : "";
}

function sanitizeSurfaceId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(text)) throw new Error("Plugin surface id is invalid.");
  return text;
}

function cleanRequiredString(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key && typeof entry === "boolean"),
  ) as Record<string, boolean>;
}

function cleanNestedBooleanRecord(value: unknown): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([pluginId, surfaces]) => [
      pluginId,
      cleanBooleanRecord(surfaces),
    ]),
  );
}

function cleanPermissionRecord(value: unknown): Record<string, readonly PluginPermission[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([pluginId, entries]) => [
      pluginId,
      Array.isArray(entries) ? entries.filter((entry): entry is PluginPermission => allowedPermissions.has(entry as PluginPermission)) : [],
    ]),
  );
}

function surfaceStateForPlugin(
  plugin: PluginDefinition,
  storedSurfaces: StoredPluginSettings["uiSurfaceEnabledByPluginId"],
  enabled: boolean,
): Readonly<Record<string, boolean>> {
  const base = rawSurfaceStateForPlugin(plugin, storedSurfaces);
  if (!enabled || plugin.uiSurfaces.length === 0 || Object.values(base).some(Boolean)) return base;
  return {
    ...base,
    ...primaryPluginSurfaceState(plugin),
  };
}

function rawSurfaceStateForPlugin(
  plugin: PluginDefinition,
  storedSurfaces: StoredPluginSettings["uiSurfaceEnabledByPluginId"],
): Readonly<Record<string, boolean>> {
  const stored = storedSurfaces[plugin.id] ?? {};
  return Object.fromEntries(
    plugin.uiSurfaces.map((surface) => [
      surface.id,
      stored[surface.id] ?? surface.enabledByDefault,
    ]),
  ) as Record<string, boolean>;
}

function activateUsablePluginSurfaces(
  plugin: PluginDefinition,
  storedSurfaces: StoredPluginSettings["uiSurfaceEnabledByPluginId"],
): StoredPluginSettings["uiSurfaceEnabledByPluginId"] {
  const current = storedSurfaces[plugin.id] ?? {};
  const activeState = rawSurfaceStateForPlugin(plugin, storedSurfaces);
  const activeIds = Object.entries(activeState).filter(([, enabled]) => enabled).map(([surfaceId]) => surfaceId);
  if (activeIds.length > 0) return storedSurfaces;
  const primaryState = primaryPluginSurfaceState(plugin);
  if (Object.keys(primaryState).length === 0) return storedSurfaces;
  return {
    ...storedSurfaces,
    [plugin.id]: {
      ...current,
      ...primaryState,
    },
  };
}

function primaryPluginSurfaceState(plugin: PluginDefinition): Record<string, boolean> {
  const primary = plugin.uiSurfaces.find((surface) => surface.kind === "panel") ?? plugin.uiSurfaces[0];
  return primary ? { [primary.id]: true } : {};
}

function uniqueClientRights(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const rights: string[] = [];
  for (const value of values) {
    const right = value.trim();
    const key = right.toLowerCase();
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(right) || seen.has(key)) continue;
    seen.add(key);
    rights.push(right);
  }
  return rights;
}

function defaultStoredPluginSettings(): StoredPluginSettings {
  return {
    version: REGISTRY_VERSION,
    enabledById: {},
    uiSurfaceEnabledByPluginId: {},
    permissionGrants: {},
  };
}

function shouldSkipPluginDirectory(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

function pluginManifestPath(root: string): string | null {
  const candidates = [MANIFEST_FILE, ...LEGACY_PLUGIN_MANIFEST_FILES];
  return candidates.map((file) => join(root, file)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function resolveTemplateRoot(): string {
  const mainDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(mainDir, "..", "..", "plugins", "template"),
    join(process.cwd(), "src", "plugins", "template"),
    process.resourcesPath ? join(process.resourcesPath, "app", "dist", "plugins", "template") : "",
  ].filter(Boolean);
  const match = candidates.map((candidate) => resolve(candidate)).find((candidate) => Boolean(pluginManifestPath(candidate)));
  if (!match) throw new Error("Plugin template folder was not found.");
  return match;
}

function titleFromPluginId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
