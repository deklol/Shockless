import { LingoSymbol, LingoVoid, type LingoValue } from "./values";

export function normalizeDirectorCursorValue(value: LingoValue | undefined): LingoValue {
  if (value === undefined || value instanceof LingoVoid) return 0;
  if (typeof value === "number" && (value === -1 || value === 0)) return 0;
  if (value instanceof LingoSymbol && value.name.toLowerCase() === "arrow") return 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "arrow" || normalized === "#arrow" || normalized === "cursor.arrow") return 0;
  }
  return value;
}
