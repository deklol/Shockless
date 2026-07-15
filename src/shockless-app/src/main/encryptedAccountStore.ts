import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MultiClientAccount } from "../shared/multiClientAccounts.js";
import { appDataStorePath, appDataStoreRoot, firstExistingAppDataStorePath, legacyAppDataStoreRoots } from "./appDataPaths.js";

const ACCOUNT_STORE_FILE = "account-store.v1.json";
const STORE_SCHEMA_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KDF = "scrypt";
const KEY_LENGTH = 32;

interface AccountStorePayload {
  readonly version: 1;
  readonly sourceLabel: string | null;
  readonly accounts: readonly MultiClientAccount[];
}

interface AccountStoreFile {
  readonly version: 1;
  readonly cipher: "aes-256-gcm";
  readonly kdf: "scrypt";
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly accountCount: number;
  readonly labels: readonly string[];
  readonly sourceLabel: string | null;
}

export interface AccountStoreSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly accountCount: number;
  readonly labels: readonly string[];
  readonly sourceLabel: string | null;
  readonly updatedAt: string | null;
}

export function accountStorePath(appDataPath: string): string {
  return appDataStorePath(appDataPath, ACCOUNT_STORE_FILE);
}

export function accountStoreSummary(appDataPath: string): AccountStoreSummary {
  const path = readableAccountStorePath(appDataPath);
  if (!existsSync(path)) {
    return { path, exists: false, accountCount: 0, labels: [], sourceLabel: null, updatedAt: null };
  }
  const file = readStoreFile(path);
  return {
    path,
    exists: true,
    accountCount: file.accountCount,
    labels: file.labels,
    sourceLabel: file.sourceLabel,
    updatedAt: file.updatedAt,
  };
}

export function writeEncryptedAccountStore(
  appDataPath: string,
  key: string,
  accounts: readonly MultiClientAccount[],
  options: { readonly sourcePath?: string | null } = {},
): AccountStoreSummary {
  if (!key) throw new Error("Account store key is empty.");
  const cleanAccounts = accounts.map(cleanAccount).filter((account): account is MultiClientAccount => Boolean(account));
  if (cleanAccounts.length === 0) throw new Error("No valid accounts to import.");

  const path = accountStorePath(appDataPath);
  const now = new Date().toISOString();
  const existingPath = readableAccountStorePath(appDataPath);
  const existing = existsSync(existingPath) ? safeReadStoreFile(existingPath) : null;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derivedKey = scryptSync(key, salt, KEY_LENGTH);
  const cipher = createCipheriv(CIPHER, derivedKey, iv);
  const payload: AccountStorePayload = {
    version: STORE_SCHEMA_VERSION,
    sourceLabel: options.sourcePath ? basename(options.sourcePath) : null,
    accounts: cleanAccounts,
  };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const file: AccountStoreFile = {
    version: STORE_SCHEMA_VERSION,
    cipher: CIPHER,
    kdf: KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    accountCount: cleanAccounts.length,
    labels: cleanAccounts.map((account) => account.label),
    sourceLabel: payload.sourceLabel,
  };
  mkdirSync(appDataStoreRoot(appDataPath), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return accountStoreSummary(appDataPath);
}

export function readEncryptedAccountStore(appDataPath: string, key: string): readonly MultiClientAccount[] {
  if (!key) throw new Error("Account store key is empty.");
  const path = readableAccountStorePath(appDataPath);
  if (!existsSync(path)) throw new Error("Encrypted account store has not been imported yet.");
  const file = readStoreFile(path);
  const derivedKey = scryptSync(key, Buffer.from(file.salt, "base64"), KEY_LENGTH);
  const decipher = createDecipheriv(CIPHER, derivedKey, Buffer.from(file.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.authTag, "base64"));
  let decoded: unknown;
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]).toString("utf8");
    decoded = JSON.parse(plaintext);
  } catch {
    throw new Error("Could not decrypt account store with the provided key environment variable.");
  }
  const payload = normalizePayload(decoded);
  return payload.accounts;
}

export function clearEncryptedAccountStore(appDataPath: string): boolean {
  let removed = false;
  for (const path of [accountStorePath(appDataPath), ...legacyAppDataStoreRoots(appDataPath).map((root) => join(root, ACCOUNT_STORE_FILE))]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed = true;
  }
  return removed;
}

function readableAccountStorePath(appDataPath: string): string {
  return firstExistingAppDataStorePath(appDataPath, ACCOUNT_STORE_FILE);
}

function readStoreFile(path: string): AccountStoreFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("Encrypted account store is not an object.");
  const version = raw.version;
  const cipher = raw.cipher;
  const kdf = raw.kdf;
  if (version !== STORE_SCHEMA_VERSION || cipher !== CIPHER || kdf !== KDF) {
    throw new Error("Encrypted account store format is unsupported.");
  }
  return {
    version: STORE_SCHEMA_VERSION,
    cipher: CIPHER,
    kdf: KDF,
    salt: requiredString(raw.salt, "salt"),
    iv: requiredString(raw.iv, "iv"),
    authTag: requiredString(raw.authTag, "authTag"),
    ciphertext: requiredString(raw.ciphertext, "ciphertext"),
    createdAt: requiredString(raw.createdAt, "createdAt"),
    updatedAt: requiredString(raw.updatedAt, "updatedAt"),
    accountCount: finiteCount(raw.accountCount),
    labels: Array.isArray(raw.labels) ? raw.labels.filter((entry): entry is string => typeof entry === "string") : [],
    sourceLabel: typeof raw.sourceLabel === "string" ? raw.sourceLabel : null,
  };
}

function safeReadStoreFile(path: string): AccountStoreFile | null {
  try {
    return readStoreFile(path);
  } catch {
    return null;
  }
}

function normalizePayload(value: unknown): AccountStorePayload {
  if (!isRecord(value) || value.version !== STORE_SCHEMA_VERSION || !Array.isArray(value.accounts)) {
    throw new Error("Decrypted account store payload is unsupported.");
  }
  return {
    version: STORE_SCHEMA_VERSION,
    sourceLabel: typeof value.sourceLabel === "string" ? value.sourceLabel : null,
    accounts: value.accounts.map(cleanAccount).filter((account): account is MultiClientAccount => Boolean(account)),
  };
}

function cleanAccount(value: unknown): MultiClientAccount | null {
  if (!isRecord(value)) return null;
  const label = typeof value.label === "string" ? value.label.trim().slice(0, 32) : "";
  const email = typeof value.email === "string" ? value.email.trim() : "";
  const password = typeof value.password === "string" ? value.password : "";
  if (!label || !email || !password) return null;
  return { label, email, password };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Encrypted account store is missing ${field}.`);
  return value;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
