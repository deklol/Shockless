import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import type { CredentialsInput } from "../common/types.js";

export class CredentialStore {
  private readonly filePath: string;

  constructor(root: string) {
    this.filePath = join(root, "credentials.bin");
  }

  hasCredentials(): boolean {
    return existsSync(this.filePath);
  }

  save(input: CredentialsInput): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is not available on this Windows session");
    }
    const email = input.email.trim();
    if (!email || !input.password) {
      throw new Error("Email and password are required before credentials can be saved");
    }
    const encrypted = safeStorage.encryptString(JSON.stringify({ email, password: input.password }));
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, encrypted);
  }

  read(): CredentialsInput | null {
    if (!existsSync(this.filePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(readFileSync(this.filePath));
    const parsed = JSON.parse(decrypted) as Partial<CredentialsInput>;
    if (typeof parsed.email !== "string" || typeof parsed.password !== "string") return null;
    return { email: parsed.email, password: parsed.password };
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}
