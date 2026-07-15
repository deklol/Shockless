export const ORIGINS_FURNIDATA_FILE = "furnidata.txt";
export const ORIGINS_PRODUCTDATA_FILE = "productdata.txt";

export const ORIGINS_GAMEDATA_URLS: Record<string, string> = {
  [ORIGINS_FURNIDATA_FILE]: "https://origins.habbo.com/gamedata/furnidata/1",
  [ORIGINS_PRODUCTDATA_FILE]: "https://origins.habbo.com/gamedata/productdata/1",
};

export function normalizeOriginsExternalVariables(text: string): string {
  const lines = splitVariableLines(text);
  const keys = variableKeyIndex(lines);

  const flashDynamicDownload = valueForKey(lines, keys, "flash.dynamic.download.url");
  if (!keys.has("dynamic.download.url") && flashDynamicDownload) {
    lines.push(`dynamic.download.url=${flashDynamicDownload}`);
  }
  if (!keys.has("furnidata.load.url")) {
    lines.push(`furnidata.load.url=${ORIGINS_FURNIDATA_FILE}`);
  }
  if (!keys.has("productdata.load.url")) {
    lines.push(`productdata.load.url=${ORIGINS_PRODUCTDATA_FILE}`);
  }

  return lines.join("\r");
}

export function clientVersionIdFromExternalVariables(text: string): number | null {
  const lines = splitVariableLines(text);
  const value = valueForKey(lines, variableKeyIndex(lines), "client.version.id");
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function splitVariableLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
}

function variableKeyIndex(lines: readonly string[]): Map<string, number> {
  const keys = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const key = variableKey(lines[index] ?? "");
    if (key && !keys.has(key.toLowerCase())) keys.set(key.toLowerCase(), index);
  }
  return keys;
}

function variableKey(line: string): string | null {
  const separator = line.indexOf("=");
  if (separator <= 0) return null;
  const key = line.slice(0, separator).trim();
  return key.length > 0 ? key : null;
}

function valueForKey(lines: string[], keys: Map<string, number>, key: string): string | null {
  const index = keys.get(key.toLowerCase());
  if (index === undefined) return null;
  const line = lines[index] ?? "";
  const separator = line.indexOf("=");
  return separator >= 0 ? line.slice(separator + 1).trim() : null;
}
