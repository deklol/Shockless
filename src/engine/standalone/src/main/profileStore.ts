import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_VERSION_CHECK_BUILD, type RuntimeProfile } from "../common/types.js";

interface ProfileStoreOptions {
  readonly profilesRoot?: string;
  readonly legacyProfilesRoot?: string;
}

export class ProfileStore {
  readonly profilesRoot: string;
  private readonly legacyProfilesRoot?: string;

  constructor(cacheRoot: string, options: ProfileStoreOptions = {}) {
    this.profilesRoot = resolve(options.profilesRoot ?? join(resolve(cacheRoot), "profiles"));
    this.legacyProfilesRoot = options.legacyProfilesRoot ? resolve(options.legacyProfilesRoot) : undefined;
    mkdirSync(this.profilesRoot, { recursive: true });
  }

  list(): RuntimeProfile[] {
    const seen = new Set<string>();
    const profiles: RuntimeProfile[] = [];
    for (const root of this.profileRoots()) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".importing-")) continue;
        if (seen.has(entry.name)) continue;
        const profile = this.readFromRoot(root, entry.name);
        if (!profile) continue;
        seen.add(entry.name);
        profiles.push(profile);
      }
    }
    return profiles.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  }

  read(id: string): RuntimeProfile | null {
    for (const root of this.profileRoots()) {
      const profile = this.readFromRoot(root, id);
      if (profile) return profile;
    }
    return null;
  }

  findReusable(sourceFingerprint: string, pipelineFingerprint: string): RuntimeProfile | null {
    return (
      this.list().find(
        (profile) =>
          profile.status === "imported" &&
          profile.runtime?.ready === true &&
          profile.sourceFingerprint === sourceFingerprint &&
          profile.pipelineFingerprint === pipelineFingerprint &&
          Boolean(profile.profileRoot && existsSync(join(profile.profileRoot, "profile.json"))),
      ) ?? null
    );
  }

  profileRoot(id: string): string | null {
    for (const root of this.profileRoots()) {
      const profilePath = join(root, id, "profile.json");
      if (existsSync(profilePath)) return join(root, id);
    }
    return null;
  }

  write(profileRoot: string, profile: RuntimeProfile): void {
    mkdirSync(profileRoot, { recursive: true });
    const { profileRoot: _profileRoot, ...persistedProfile } = profile;
    writeFileSync(join(profileRoot, "profile.json"), `${JSON.stringify(persistedProfile, null, 2)}\n`, "utf8");
  }

  private readFromRoot(root: string, id: string): RuntimeProfile | null {
    const profilePath = join(root, id, "profile.json");
    if (!existsSync(profilePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as Partial<RuntimeProfile>;
      return {
        ...parsed,
        profileRoot: join(root, id),
        versionCheckBuild: normalizeVersionCheckBuild(parsed.versionCheckBuild),
      } as RuntimeProfile;
    } catch {
      return null;
    }
  }

  private profileRoots(): string[] {
    const roots = [this.profilesRoot];
    if (this.legacyProfilesRoot && this.legacyProfilesRoot.toLowerCase() !== this.profilesRoot.toLowerCase()) {
      roots.push(this.legacyProfilesRoot);
    }
    return roots;
  }
}

function normalizeVersionCheckBuild(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VERSION_CHECK_BUILD;
}
