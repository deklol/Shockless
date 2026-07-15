#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const outputPath = path.resolve(args.out ?? "generated/runtime-data/external-fields.json");

const sources = args.source.length > 0
  ? args.source
  : [
      "release7:auratus-v7:src/Auratus/assets/hotel/ext/external_variables.txt",
      "release7:auratus-v7:src/Auratus/assets/hotel/ext/external_texts.txt",
      "release14:compiled-v14-uk:generated/runtime-data/release14/external_variables.txt",
      "release14:compiled-v14-uk:generated/runtime-data/release14/external_texts.txt",
      "release306:compiled-306:compiled/306/external_variables.txt",
      "release306:compiled-306:compiled/306/external_texts.txt"
    ];

const releases = new Map();

for (const source of sources) {
  const [versionId, sourceId, rawFilePath] = source.split(":");
  if (!versionId || !sourceId || !rawFilePath) {
    throw new Error(`Invalid source spec "${source}". Expected versionId:sourceId:path`);
  }

  const filePath = path.resolve(rawFilePath);
  if (!existsSync(filePath)) {
    throw new Error(`External field source not found: ${relative(filePath)}`);
  }

  const release = releases.get(versionId) ?? {
    versionId,
    sourceId,
    fields: []
  };

  const name = path.basename(filePath);
  const rawText = readFileSync(filePath, "latin1");
  const text = name.toLowerCase() === "external_variables.txt"
    ? normalizeOriginsExternalVariables(rawText)
    : rawText;
  release.fields.push({
    name,
    sourcePath: relative(filePath),
    text,
    lineCount: text.split(/\r\n?|\n/).length,
    properties: parseFieldProperties(text)
  });
  releases.set(versionId, release);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generator: "tools/extraction/index-external-fields.mjs",
      releases: [...releases.values()].map((release) => ({
        ...release,
        fields: release.fields.sort((left, right) => left.name.localeCompare(right.name))
      }))
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Indexed ${sources.length} external field source(s)`);
console.log(`External field index: ${relative(outputPath)}`);

function parseFieldProperties(text) {
  const properties = {};
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      properties[key] = value;
    }
  }

  return Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeOriginsExternalVariables(text) {
  const lines = text.split(/\r\n?|\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  const keys = new Map();
  for (let index = 0; index < lines.length; index++) {
    const key = variableKey(lines[index] ?? "");
    if (key && !keys.has(key.toLowerCase())) keys.set(key.toLowerCase(), index);
  }

  const flashDynamicDownload = valueForKey(lines, keys, "flash.dynamic.download.url");
  if (!keys.has("dynamic.download.url") && flashDynamicDownload) {
    lines.push(`dynamic.download.url=${flashDynamicDownload}`);
  }
  if (!keys.has("furnidata.load.url")) {
    lines.push("furnidata.load.url=furnidata.txt");
  }
  if (!keys.has("productdata.load.url")) {
    lines.push("productdata.load.url=productdata.txt");
  }

  return lines.join("\r");
}

function variableKey(line) {
  const separator = line.indexOf("=");
  if (separator <= 0) return null;
  const key = line.slice(0, separator).trim();
  return key.length > 0 ? key : null;
}

function valueForKey(lines, keys, key) {
  const index = keys.get(key.toLowerCase());
  if (index === undefined) return null;
  const line = lines[index] ?? "";
  const separator = line.indexOf("=");
  return separator >= 0 ? line.slice(separator + 1).trim() : null;
}

function relative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function parseArgs(rawArgs) {
  const parsed = {
    source: []
  };

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--out":
        parsed.out = requireNext(rawArgs, ++index, arg);
        break;
      case "--source":
        parsed.source.push(requireNext(rawArgs, ++index, arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireNext(rawArgs, index, flag) {
  const value = rawArgs[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
