export interface MultiClientAccount {
  readonly label: string;
  readonly email: string;
  readonly password: string;
}

export interface MultiClientAccountParseResult {
  readonly accounts: readonly MultiClientAccount[];
  readonly warnings: readonly string[];
}

export function parseMultiClientAccounts(text: string): MultiClientAccountParseResult {
  const lines = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const accounts: MultiClientAccount[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < lines.length; index += 2) {
    const label = lines[index] ?? "";
    const credentials = lines[index + 1] ?? "";
    if (!label || !credentials) {
      warnings.push(`Skipped incomplete account block at line ${index + 1}.`);
      continue;
    }
    const separator = credentials.indexOf(":");
    if (separator <= 0 || separator === credentials.length - 1) {
      warnings.push(`Skipped account block "${label}" because credentials were not email:password.`);
      continue;
    }
    accounts.push({
      label: label.slice(0, 32),
      email: credentials.slice(0, separator).trim(),
      password: credentials.slice(separator + 1),
    });
  }

  return { accounts, warnings };
}
