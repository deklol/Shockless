import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const engineRoot = resolveEngineRoot(workspaceRoot);
const projects = [
  { label: "desktop", root: workspaceRoot },
  { label: "engine", root: engineRoot },
  { label: "standalone", root: join(engineRoot, "standalone") },
];

for (const project of projects) verifyProject(project);

function resolveEngineRoot(appRoot) {
  for (const candidate of [join(appRoot, "engine"), resolve(appRoot, "..", "engine")]) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "standalone", "package.json"))) {
      return candidate;
    }
  }
  throw new Error("Shockless engine source was not found beside or inside the desktop source tree.");
}

function verifyProject(project) {
  const manifest = readJson(join(project.root, "package.json"));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const nativeSpec = requiredString(dependencies["@typescript/native"], `${project.label} @typescript/native`);
  const compatibilitySpec = requiredString(dependencies.typescript, `${project.label} typescript`);
  const nativeVersion = installedVersion(project.root, "@typescript/native");
  const compatibilityVersion = installedVersion(project.root, "typescript");

  assertExpectedMajor(nativeVersion, aliasTargetMajor(nativeSpec), `${project.label} native compiler`);
  assertExpectedMajor(compatibilityVersion, aliasTargetMajor(compatibilitySpec), `${project.label} compatibility API`);

  const nativeCliVersion = compilerVersion(project.root, "tsc");
  const compatibilityCliVersion = compilerVersion(project.root, "tsc6");
  assertExpectedMajor(nativeCliVersion, aliasTargetMajor(nativeSpec), `${project.label} tsc`);
  assertExpectedMajor(compatibilityCliVersion, aliasTargetMajor(compatibilitySpec), `${project.label} tsc6`);

  console.log(
    `${project.label}: tsc ${nativeCliVersion}; TypeScript API package ${compatibilityVersion}; tsc6 ${compatibilityCliVersion}`,
  );
}

function compilerVersion(projectRoot, command) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const executable = join(projectRoot, "node_modules", ".bin", `${command}${extension}`);
  if (!existsSync(executable)) throw new Error(`Compiler executable is missing: ${executable}`);
  const result = spawnSync(executable, ["--version"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed in ${projectRoot}: ${String(result.stderr || result.stdout).trim()}`);
  }
  const output = String(result.stdout).trim();
  const version = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) throw new Error(`Cannot parse ${command} version from: ${output}`);
  return version;
}

function installedVersion(projectRoot, packageName) {
  return requiredString(
    readJson(join(projectRoot, "node_modules", ...packageName.split("/"), "package.json")).version,
    `${packageName} installed version`,
  );
}

function aliasTargetMajor(spec) {
  const matches = [...spec.matchAll(/@(\^|~)?(\d+)(?:\.|$)/g)];
  const major = Number(matches.at(-1)?.[2]);
  if (!Number.isInteger(major)) throw new Error(`Cannot determine expected compiler major from ${spec}.`);
  return major;
}

function assertExpectedMajor(version, expectedMajor, label) {
  const actualMajor = Number(version.split(".")[0]);
  if (actualMajor !== expectedMajor) {
    throw new Error(`${label} is ${version}; package alias requires major ${expectedMajor}.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  return value.trim();
}
