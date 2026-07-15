function clampNameLabelOffset(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(0, Math.min(96, Math.trunc(numeric))) : 40;
}

function normalizeNameLabelColor(value: unknown, fallback = "#ffffff"): string {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim().toLowerCase();
  return fallback;
}

function normalizeNativeBindValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return (cleaned || fallback).slice(0, 80);
}

function parseConsoleBoolean(value: string | undefined): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "on", "1", "yes", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "off", "0", "no", "disable", "disabled"].includes(normalized)) return false;
  return null;
}

export { clampNameLabelOffset, normalizeNameLabelColor, normalizeNativeBindValue, parseConsoleBoolean };
