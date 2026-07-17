export interface ValveKeyValuesObject {
  [key: string]: ValveKeyValuesValue;
}
export type ValveKeyValuesValue = string | ValveKeyValuesObject;

type Token = { readonly kind: "string"; readonly value: string } | { readonly kind: "open" | "close" };

/** Parses Valve's quoted KeyValues format used by Steam library and app manifests. */
export function parseValveKeyValues(source: string): ValveKeyValuesObject {
  const tokens = tokenizeValveKeyValues(source);
  let index = 0;

  const parseObject = (nested: boolean): ValveKeyValuesObject => {
    const result: ValveKeyValuesObject = Object.create(null) as ValveKeyValuesObject;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.kind === "close") {
        if (!nested) throw new Error("Unexpected closing brace in Valve KeyValues data.");
        index += 1;
        return result;
      }
      if (token.kind !== "string") throw new Error("Expected a key in Valve KeyValues data.");
      const key = token.value;
      index += 1;
      const value = tokens[index];
      if (!value) throw new Error(`Missing value for Valve KeyValues key ${key}.`);
      if (value.kind === "string") {
        result[key] = value.value;
        index += 1;
        continue;
      }
      if (value.kind !== "open") throw new Error(`Invalid value for Valve KeyValues key ${key}.`);
      index += 1;
      result[key] = parseObject(true);
    }
    if (nested) throw new Error("Unterminated object in Valve KeyValues data.");
    return result;
  };

  return parseObject(false);
}

export function valveObject(value: ValveKeyValuesValue | undefined): ValveKeyValuesObject | null {
  return value && typeof value === "object" ? value : null;
}

export function valveString(value: ValveKeyValuesValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function valveValue(object: ValveKeyValuesObject, key: string): ValveKeyValuesValue | undefined {
  const normalized = key.toLowerCase();
  const entry = Object.entries(object).find(([candidate]) => candidate.toLowerCase() === normalized);
  return entry?.[1];
}

function tokenizeValveKeyValues(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "{") {
      tokens.push({ kind: "open" });
      index += 1;
      continue;
    }
    if (character === "}") {
      tokens.push({ kind: "close" });
      index += 1;
      continue;
    }
    if (character !== '"') throw new Error(`Unexpected character in Valve KeyValues data at offset ${index}.`);
    index += 1;
    let value = "";
    let closed = false;
    while (index < source.length) {
      const next = source[index++];
      if (next === '"') {
        closed = true;
        break;
      }
      if (next === "\\" && index < source.length) {
        const escaped = source[index++];
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      } else {
        value += next;
      }
    }
    if (!closed) throw new Error("Unterminated quoted string in Valve KeyValues data.");
    tokens.push({ kind: "string", value });
  }
  return tokens;
}
