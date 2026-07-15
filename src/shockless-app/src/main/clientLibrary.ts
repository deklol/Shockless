import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ClientLibraryState, ClientProfileSummary } from "../shared/window-api.js";
import { habbpyClientsRoot, runPlayableProfileImport, type ProfileImportProgressSink } from "./profileImportRunner.js";
import { appDataStorePath, appDataStoreRootsForRead, firstExistingAppDataStorePath } from "./appDataPaths.js";

const STORE_FILE = "client-library.json";

interface StoredClientLibrary {
  readonly selectedProfileRoot?: string | null;
  readonly registeredProfileRoots?: readonly string[];
}

interface RuntimeProfileJson {
  readonly id?: string;
  readonly displayName?: string;
  readonly versionId?: string;
  readonly buildNumber?: number | null;
  readonly versionCheckBuild?: number | null;
  readonly importedAt?: string;
  readonly sourceFolderName?: string;
  readonly runtime?: {
    readonly ready?: boolean;
    readonly reason?: string;
    readonly validation?: {
      readonly fidelityComplete?: boolean;
      readonly warningCount?: number;
    };
  };
  readonly paths?: {
    readonly client?: string;
  };
}

export interface ClientLibraryProfile extends ClientProfileSummary {
  readonly profileRoot: string;
}

export interface CompiledClientReference {
  readonly clientRoot: string;
  readonly selectedFromParent: boolean;
  readonly entryMovie: string;
  readonly castCount: number;
  readonly versionId: string;
  readonly buildNumber: number | null;
  readonly sourceFolderName: string;
  readonly warnings: readonly string[];
}

export class ClientLibraryStore {
  constructor(private readonly appDataPath: string) {}

  state(message = ""): ClientLibraryState {
    const stored = this.readStore();
    const profiles = this.discoverProfiles(stored);
    const selected = selectProfile(profiles, stored.selectedProfileRoot);
    return {
      profiles,
      selectedProfileRoot: selected?.profileRoot ?? null,
      selectedProfileId: selected?.id ?? null,
      message:
        message ||
        (profiles.length > 0
          ? "Ready profiles are registered by reference. Existing Shockless imports are not copied or decompiled again."
          : "No ready Shockless profile is registered. Import an existing profile or clients folder by reference."),
    };
  }

  selectedProfile(): ClientLibraryProfile | null {
    const state = this.state();
    return state.selectedProfileRoot
      ? (state.profiles.find((profile) => profile.profileRoot === state.selectedProfileRoot) as ClientLibraryProfile | undefined) ?? null
      : null;
  }

  registerSource(sourcePath: string): ClientLibraryState {
    const resolved = resolve(sourcePath);
    const found = findProfileRootsInSource(resolved);
    if (found.kind === "compiled-client") {
      const stored = this.readStore();
      const match = found.compiledClient ? matchingProfileForCompiledClient(found.compiledClient, this.discoverProfiles(stored)) : null;
      if (match) {
        const registered = new Set([...(stored.registeredProfileRoots ?? []), match.profileRoot]);
        this.writeStore({
          selectedProfileRoot: match.profileRoot,
          registeredProfileRoots: [...registered].sort(),
        });
        return this.state(
          `Registered existing ${match.versionId} profile cache by reference for compiled client ${found.compiledClient?.sourceFolderName ?? "folder"}; no files copied or decompiled.`,
        );
      }
      return this.state(
        found.compiledClient
          ? `Compiled client ${found.compiledClient.versionId} was recognized, but no matching imported profile cache is registered or discoverable. Use Import Client/Profile from the app to build a playable profile.`
          : "Compiled client folder was recognized, but no matching imported profile cache is registered or discoverable.",
      );
    }
    if (found.profileRoots.length === 0) {
      return this.state("No Shockless profile.json files were found in the selected folder.");
    }

    const stored = this.readStore();
    const registered = new Set([...(stored.registeredProfileRoots ?? []), ...found.profileRoots]);
    const selectedProfileRoot = found.profileRoots[0] ?? stored.selectedProfileRoot ?? null;
    this.writeStore({
      selectedProfileRoot,
      registeredProfileRoots: [...registered].sort(),
    });
    return this.state(`Registered ${found.profileRoots.length} profile folder(s) by reference.`);
  }

  async importOrRegisterSource(
    sourcePath: string,
    options: {
      readonly jobId?: string;
      readonly onProgress?: ProfileImportProgressSink;
    } = {},
  ): Promise<ClientLibraryState> {
    const resolved = resolve(sourcePath);
    const found = findProfileRootsInSource(resolved);
    if (found.kind !== "compiled-client" || !found.compiledClient) {
      return this.registerSource(resolved);
    }

    const stored = this.readStore();
    const match = matchingProfileForCompiledClient(found.compiledClient, this.discoverProfiles(stored));
    if (match) {
      const registered = new Set([...(stored.registeredProfileRoots ?? []), match.profileRoot]);
      this.writeStore({
        selectedProfileRoot: match.profileRoot,
        registeredProfileRoots: [...registered].sort(),
      });
      return this.state(
        `Registered existing ${match.versionId} profile cache by reference for compiled client ${found.compiledClient.sourceFolderName}; no files copied or decompiled.`,
      );
    }

    const imported = await runPlayableProfileImport({
      appDataPath: this.appDataPath,
      clientRoot: found.compiledClient.clientRoot,
      jobId: options.jobId,
      sourceName: found.compiledClient.sourceFolderName,
      onProgress: options.onProgress,
    });
    if (!existsSync(join(imported.profileRoot, "profile.json"))) {
      throw new Error(`Profile importer reported success, but ${join(imported.profileRoot, "profile.json")} was not created.`);
    }
    const registered = new Set([...(stored.registeredProfileRoots ?? []), imported.profileRoot]);
    this.writeStore({
      selectedProfileRoot: imported.profileRoot,
      registeredProfileRoots: [...registered].sort(),
    });
    const profileLabel = imported.profileId ? ` ${imported.profileId}` : "";
    const readyLabel = imported.ready === false ? "imported, but is not launch-ready yet" : "imported into a playable Shockless profile";
    return this.state(
      `Compiled client ${found.compiledClient.versionId} was ${readyLabel}${profileLabel}. Import log: ${imported.logPath}`,
    );
  }

  setSelectedProfile(profileRoot: string): ClientLibraryState {
    const resolved = resolve(profileRoot);
    const stored = this.readStore();
    const profiles = this.discoverProfiles(stored);
    if (!profiles.some((profile) => profile.profileRoot === resolved)) {
      return this.state("Selected profile is not registered.");
    }
    this.writeStore({
      selectedProfileRoot: resolved,
      registeredProfileRoots: stored.registeredProfileRoots ?? [],
    });
    return this.state("Active Shockless client profile updated.");
  }

  private discoverProfiles(stored: StoredClientLibrary): ClientLibraryProfile[] {
    const roots = new Set<string>();
    for (const root of stored.registeredProfileRoots ?? []) roots.add(resolve(root));
    for (const root of defaultProfileRoots(this.appDataPath)) roots.add(root);

    return [...roots]
      .map(readProfileSummary)
      .filter((profile): profile is ClientLibraryProfile => Boolean(profile))
      .sort((left, right) => {
        if (left.ready !== right.ready) return left.ready ? -1 : 1;
        return right.importedAt.localeCompare(left.importedAt);
      });
  }

  private readStore(): StoredClientLibrary {
    const path = firstExistingAppDataStorePath(this.appDataPath, STORE_FILE);
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredClientLibrary;
      return {
        selectedProfileRoot: typeof parsed.selectedProfileRoot === "string" ? resolve(parsed.selectedProfileRoot) : null,
        registeredProfileRoots: Array.isArray(parsed.registeredProfileRoots)
          ? parsed.registeredProfileRoots.filter((entry): entry is string => typeof entry === "string").map((entry) => resolve(entry))
          : [],
      };
    } catch {
      return {};
    }
  }

  private writeStore(store: StoredClientLibrary): void {
    const path = this.storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private storePath(): string {
    return appDataStorePath(this.appDataPath, STORE_FILE);
  }
}

export function findProfileRootsInSource(sourcePath: string): {
  readonly kind: "profiles" | "compiled-client" | "unknown";
  readonly profileRoots: readonly string[];
  readonly compiledClient?: CompiledClientReference;
} {
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { kind: "unknown", profileRoots: [] };

  if (!isTransientProfileRoot(resolved) && existsSync(join(resolved, "profile.json"))) {
    return { kind: "profiles", profileRoots: [resolved] };
  }

  const parentProfileRoot = parentProfileForClientDir(resolved);
  if (parentProfileRoot) {
    return { kind: "profiles", profileRoots: [parentProfileRoot] };
  }

  const childProfileRoots = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !isTransientProfileName(entry.name))
    .map((entry) => join(resolved, entry.name))
    .filter((candidate) => existsSync(join(candidate, "profile.json")));
  if (childProfileRoots.length > 0) {
    return { kind: "profiles", profileRoots: childProfileRoots.map((entry) => resolve(entry)) };
  }

  const compiledClient = resolveCompiledClientReference(resolved);
  return compiledClient ? { kind: "compiled-client", profileRoots: [], compiledClient } : { kind: "unknown", profileRoots: [] };
}

function isTransientProfileRoot(profileRoot: string): boolean {
  return isTransientProfileName(basename(resolve(profileRoot)));
}

function isTransientProfileName(name: string): boolean {
  return name.startsWith(".importing-") || name.startsWith(".failed-");
}

function defaultProfileRoots(appDataPath: string): readonly string[] {
  const roots = new Set<string>();
  const configuredEngineRoot = process.env.SHOCKLESS_ENGINE_ROOT;
  const devProfileRoots = runningFromPackagedResources()
    ? []
    : [
        configuredEngineRoot ? join(configuredEngineRoot, "standalone", "release", "win-unpacked", "clients") : undefined,
        configuredEngineRoot ? join(configuredEngineRoot, "standalone", "clients") : undefined,
        siblingPath("engine", "standalone", "release", "win-unpacked", "clients"),
        siblingPath("engine", "standalone", "clients"),
        ...ancestorSiblingPaths("engine", "standalone", "release", "win-unpacked", "clients"),
        ...ancestorSiblingPaths("engine", "standalone", "clients"),
      ];
  for (const source of [
    process.env.SHOCKLESS_PROFILE_ROOT,
    process.env.SHOCKLESS_CLIENTS_ROOT,
    process.env.SHOCKLESS_CLIENTS_ROOT,
    habbpyClientsRoot(appDataPath),
    ...appDataStoreRootsForRead(appDataPath).map((root) => join(root, "clients")),
    ...devProfileRoots,
  ]) {
    if (!source) continue;
    const found = findProfileRootsInSource(source);
    for (const root of found.profileRoots) roots.add(root);
  }
  return [...roots].sort();
}

function runningFromPackagedResources(): boolean {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return Boolean(resourcesPath && existsSync(join(resourcesPath, "app", "package.json")));
}

function siblingPath(...parts: readonly string[]): string {
  return resolve(process.cwd(), "..", ...parts);
}

function ancestorSiblingPaths(...parts: readonly string[]): readonly string[] {
  const starts = new Set([process.cwd(), process.execPath ? dirname(process.execPath) : process.cwd()]);
  const candidates = new Set<string>();
  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      candidates.add(join(current, ...parts));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...candidates];
}

function readProfileSummary(profileRoot: string): ClientLibraryProfile | null {
  const profilePath = join(profileRoot, "profile.json");
  if (!existsSync(profilePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as RuntimeProfileJson;
    if (!parsed.id || !parsed.versionId) return null;
    const ready = parsed.runtime?.ready === true;
    const fidelityComplete =
      typeof parsed.runtime?.validation?.fidelityComplete === "boolean"
        ? parsed.runtime.validation.fidelityComplete
        : null;
    const fidelityWarningCount = Number.isInteger(parsed.runtime?.validation?.warningCount)
      ? Math.max(0, Number(parsed.runtime?.validation?.warningCount))
      : 0;
    return {
      id: parsed.id,
      label: parsed.displayName || parsed.id,
      versionId: parsed.versionId,
      buildNumber: Number.isInteger(parsed.buildNumber) ? parsed.buildNumber ?? null : null,
      versionCheckBuild: Number.isInteger(parsed.versionCheckBuild) ? parsed.versionCheckBuild ?? null : null,
      importedAt: parsed.importedAt || "",
      sourceFolderName: parsed.sourceFolderName || "",
      profileRoot: resolve(profileRoot),
      ready,
      reason: ready ? null : parsed.runtime?.reason || "Profile is not ready.",
      fidelityComplete,
      fidelityWarningCount,
      storageMode: "referenced",
    };
  } catch {
    return null;
  }
}

function matchingProfileForCompiledClient(
  compiledClient: CompiledClientReference,
  profiles: readonly ClientLibraryProfile[],
): ClientLibraryProfile | null {
  const candidates = profiles
    .filter((profile) => profile.versionId.toLowerCase() === compiledClient.versionId.toLowerCase())
    .filter((profile) => profile.ready)
    .sort((left, right) => {
      const leftSourceMatch = left.sourceFolderName.toLowerCase() === compiledClient.sourceFolderName.toLowerCase() ? 1 : 0;
      const rightSourceMatch = right.sourceFolderName.toLowerCase() === compiledClient.sourceFolderName.toLowerCase() ? 1 : 0;
      if (leftSourceMatch !== rightSourceMatch) return rightSourceMatch - leftSourceMatch;
      const leftBuildMatch = left.buildNumber === compiledClient.buildNumber ? 1 : 0;
      const rightBuildMatch = right.buildNumber === compiledClient.buildNumber ? 1 : 0;
      if (leftBuildMatch !== rightBuildMatch) return rightBuildMatch - leftBuildMatch;
      return right.importedAt.localeCompare(left.importedAt);
    });
  return candidates[0] ?? null;
}

function parentProfileForClientDir(sourcePath: string): string | null {
  const parent = dirname(sourcePath);
  if (parent === sourcePath) return null;
  const profilePath = join(parent, "profile.json");
  if (!existsSync(profilePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as RuntimeProfileJson;
    const clientPath = parsed.paths?.client;
    return clientPath && resolve(parent, clientPath) === resolve(sourcePath) ? parent : null;
  } catch {
    return null;
  }
}

function resolveCompiledClientReference(sourcePath: string): CompiledClientReference | null {
  const direct = validateCompiledClientReference(sourcePath);
  if (direct) return { ...direct, selectedFromParent: false };

  const candidates = readdirSync(sourcePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const childRoot = join(sourcePath, entry.name);
      const validation = validateCompiledClientReference(childRoot);
      return validation ? { ...validation, mtimeMs: statSync(childRoot).mtimeMs } : null;
    })
    .filter(
      (candidate): candidate is CompiledClientReference & { readonly mtimeMs: number } => candidate !== null,
    )
    .sort((left, right) => {
      const leftBuild = left.buildNumber ?? -1;
      const rightBuild = right.buildNumber ?? -1;
      if (leftBuild !== rightBuild) return rightBuild - leftBuild;
      if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return left.clientRoot.localeCompare(right.clientRoot);
    });
  const selected = candidates[0];
  return selected ? { ...selected, selectedFromParent: true } : null;
}

function validateCompiledClientReference(clientRoot: string): Omit<CompiledClientReference, "selectedFromParent"> | null {
  if (!existsSync(clientRoot) || !statSync(clientRoot).isDirectory()) return null;
  const files = readdirSync(clientRoot, { withFileTypes: true }).filter((entry) => entry.isFile());
  const entryMovie = files.find((entry) => entry.name.toLowerCase() === "habbo.dcr");
  const fuseClient = files.find((entry) => entry.name.toLowerCase() === "fuse_client.cct");
  if (!entryMovie || !fuseClient) return null;
  if (statSync(join(clientRoot, entryMovie.name)).size <= 0 || statSync(join(clientRoot, fuseClient.name)).size <= 0) {
    return null;
  }
  const castCount = files.filter((entry) => isDirectorCastFile(entry.name) && statSync(join(clientRoot, entry.name)).size > 0).length;
  if (castCount < 25) return null;
  const buildNumber = inferBuildNumber(clientRoot);
  const warnings: string[] = [];
  if (!existsSync(join(clientRoot, "external_variables.txt"))) {
    warnings.push("external_variables.txt is missing from the compiled folder.");
  }
  if (!existsSync(join(clientRoot, "external_texts.txt"))) {
    warnings.push("external_texts.txt is missing from the compiled folder.");
  }
  return {
    clientRoot: resolve(clientRoot),
    entryMovie: entryMovie.name,
    castCount,
    versionId: buildNumber ? `release${buildNumber}` : "release-unknown",
    buildNumber,
    sourceFolderName: basename(clientRoot),
    warnings,
  };
}

function inferBuildNumber(clientRoot: string): number | null {
  const pathParts = resolve(clientRoot).split(/[\\/]/).reverse();
  for (const part of pathParts) {
    const match = /^(?:release|build|version|compiled|v)?[-_ ]?(\d{3,4})$/i.exec(part);
    if (match?.[1]) return Number(match[1]);
  }
  const iniPath = join(clientRoot, "Habbo.INI");
  if (existsSync(iniPath)) {
    const match = /(?:release|build|version)\D*(\d{3,4})/i.exec(readFileSync(iniPath, "utf8"));
    if (match) return Number(match[1]);
  }
  return null;
}

function isDirectorCastFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === ".cct" || ext === ".cst" || ext === ".dcr" || ext === ".dir" || ext === ".dxr";
}

function selectProfile(
  profiles: readonly ClientLibraryProfile[],
  selectedProfileRoot: string | null | undefined,
): ClientLibraryProfile | null {
  if (selectedProfileRoot) {
    const selected = profiles.find((profile) => profile.profileRoot === resolve(selectedProfileRoot));
    if (selected) return selected;
  }
  return profiles.find((profile) => profile.ready) ?? profiles[0] ?? null;
}
