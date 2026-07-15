import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scannedRoots = ["src", "docs", "scripts", "tests", "examples"];
const scannedFiles = ["package.json", "package-lock.json"];
const textExtensions = new Set([".ts", ".tsx", ".cts", ".mts", ".js", ".mjs", ".json", ".md", ".txt"]);

test("source and package-facing files do not contain local credentials or webhook URLs", () => {
  const accountNeedles = localAccountNeedles();
  const webhookNeedle = `discord.com${"/api/webhooks/"}`;
  for (const filePath of sourceFacingFiles()) {
    const text = readFileSync(filePath, "utf8");
    assert.equal(text.includes(webhookNeedle), false, `Discord webhook URL leaked in ${relative(repoRoot, filePath)}`);
    for (const needle of accountNeedles) {
      assert.equal(text.includes(needle), false, `Local test credential value leaked in ${relative(repoRoot, filePath)}`);
    }
  }
});

function localAccountNeedles(): readonly string[] {
  const accountPath = join(repoRoot, "multiclient-accounts.txt");
  if (!existsSync(accountPath)) return [];
  const needles = new Set<string>();
  const lines = readFileSync(accountPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0 || separator === line.length - 1) continue;
    const email = line.slice(0, separator).trim();
    const password = line.slice(separator + 1);
    if (email.includes("@")) needles.add(email);
    if (email && password) needles.add(`${email}:${password}`);
  }
  return [...needles];
}

function sourceFacingFiles(): readonly string[] {
  const files: string[] = [];
  for (const root of scannedRoots) {
    const absolute = join(repoRoot, root);
    if (existsSync(absolute)) collectTextFiles(absolute, files);
  }
  for (const file of scannedFiles) {
    const absolute = join(repoRoot, file);
    if (existsSync(absolute)) files.push(absolute);
  }
  return files;
}

function collectTextFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const info = statSync(absolute);
    if (info.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      collectTextFiles(absolute, files);
      continue;
    }
    const extension = entry.includes(".") ? entry.slice(entry.lastIndexOf(".")).toLowerCase() : "";
    if (textExtensions.has(extension)) files.push(absolute);
  }
}
