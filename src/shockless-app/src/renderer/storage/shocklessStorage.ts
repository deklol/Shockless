import { legacyStorageKey } from "../../shared/legacyCompatibility";

export function readShocklessStorage(storage: Storage, canonicalKey: string): string | null {
  const current = storage.getItem(canonicalKey);
  if (current !== null) return current;

  const legacyKey = legacyStorageKey(canonicalKey);
  if (!legacyKey) return null;
  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue === null) return null;
  storage.setItem(canonicalKey, legacyValue);
  return legacyValue;
}

export function removeShocklessStorage(storage: Storage, canonicalKey: string): void {
  storage.removeItem(canonicalKey);
  const legacyKey = legacyStorageKey(canonicalKey);
  if (legacyKey) storage.removeItem(legacyKey);
}
