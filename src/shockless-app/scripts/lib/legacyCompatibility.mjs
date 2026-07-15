const LEGACY_ENVIRONMENT_PREFIX = "HABBPY_V4_";
const CANONICAL_ENVIRONMENT_PREFIX = "SHOCKLESS_";

for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith(LEGACY_ENVIRONMENT_PREFIX) || value === undefined) continue;
  const canonicalName = `${CANONICAL_ENVIRONMENT_PREFIX}${name.slice(LEGACY_ENVIRONMENT_PREFIX.length)}`;
  if (process.env[canonicalName] === undefined) process.env[canonicalName] = value;
}

export const LEGACY_PORTABLE_DIRECTORY_NAMES = ["HabbpyV4"];
export const LEGACY_EXECUTABLE_NAMES = ["Habbpy v4.exe"];
export const LEGACY_PLUGIN_MANIFEST_NAMES = ["habbpy.plugin.json"];
