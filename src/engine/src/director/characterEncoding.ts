const WINDOWS_1252_EXTENDED: readonly string[] = [
  "\u20ac", "\u0081", "\u201a", "\u0192", "\u201e", "\u2026", "\u2020", "\u2021",
  "\u02c6", "\u2030", "\u0160", "\u2039", "\u0152", "\u008d", "\u017d", "\u008f",
  "\u0090", "\u2018", "\u2019", "\u201c", "\u201d", "\u2022", "\u2013", "\u2014",
  "\u02dc", "\u2122", "\u0161", "\u203a", "\u0153", "\u009d", "\u017e", "\u0178",
];

const WINDOWS_1252_REVERSE = new Map(
  WINDOWS_1252_EXTENDED.map((character, index) => [character, 0x80 + index] as const),
);

/** Director's extended numToChar values use the host platform code page.
 * Origins is a Windows projector, so bytes 128-159 follow Windows-1252. */
export function directorNumToChar(value: number): string {
  const code = Math.trunc(value);
  if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252_EXTENDED[code - 0x80]!;
  return String.fromCharCode(code);
}

/** Reverse of directorNumToChar for the first character of a Lingo string. */
export function directorCharToNum(value: string): number {
  if (value.length === 0) return 0;
  return WINDOWS_1252_REVERSE.get(value[0]!) ?? value.charCodeAt(0);
}
