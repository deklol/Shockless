import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  automationPrefsStorageKey,
  injectionHistoryStorageKey,
  injectionSnippetStorageKey,
  normalizeInjectionHistory,
  normalizeInjectionSnippets,
  userStoredLookStorageKey,
  type InjectionHistoryEntry,
  type InjectionSnippet,
} from "../injection/model";
import {
  pluginRuntimeUiValueSnapshot,
  pluginUiValuesStorageKey,
  type RuntimePluginUiState,
} from "../plugins/runtimeUiState";
import { readShocklessStorage } from "../../storage/shocklessStorage";

interface UseLocalFeaturePersistenceOptions {
  readonly injectionSnippets: readonly InjectionSnippet[];
  readonly injectionHistory: readonly InjectionHistoryEntry[];
  readonly userStoredLooks: readonly string[];
  readonly selectedStoredUserLook: string;
  readonly automationPrefs: { readonly autoHideBulletin: boolean };
  readonly pluginRuntimeUiById: Readonly<Record<string, RuntimePluginUiState | undefined>>;
  readonly setInjectionSnippets: Dispatch<SetStateAction<InjectionSnippet[]>>;
  readonly setInjectionHistory: Dispatch<SetStateAction<InjectionHistoryEntry[]>>;
  readonly setSelectedStoredUserLook: Dispatch<SetStateAction<string>>;
}

/** Persists renderer-only feature preferences without coupling them to App composition. */
export function useLocalFeaturePersistence(options: UseLocalFeaturePersistenceOptions): void {
  useEffect(() => {
    try {
      options.setInjectionSnippets(
        normalizeInjectionSnippets(
          JSON.parse(readShocklessStorage(window.localStorage, injectionSnippetStorageKey) || "[]"),
        ),
      );
      const parsedHistory = JSON.parse(
        readShocklessStorage(window.localStorage, injectionHistoryStorageKey) || "[]",
      );
      options.setInjectionHistory(normalizeInjectionHistory(parsedHistory));
    } catch {
      options.setInjectionSnippets([]);
      options.setInjectionHistory([]);
    }
  }, [options.setInjectionHistory, options.setInjectionSnippets]);

  useEffect(() => {
    try {
      window.localStorage.setItem(injectionSnippetStorageKey, JSON.stringify(options.injectionSnippets.slice(0, 50)));
    } catch {
      // Local browser storage is optional; snippets still work in memory.
    }
  }, [options.injectionSnippets]);

  useEffect(() => {
    try {
      window.localStorage.setItem(injectionHistoryStorageKey, JSON.stringify(options.injectionHistory.slice(0, 50)));
    } catch {
      // Local browser storage is optional; history still works in memory.
    }
  }, [options.injectionHistory]);

  useEffect(() => {
    if (!options.selectedStoredUserLook && options.userStoredLooks.length > 0) {
      options.setSelectedStoredUserLook(options.userStoredLooks[0]!);
    }
  }, [options.selectedStoredUserLook, options.setSelectedStoredUserLook, options.userStoredLooks]);

  useEffect(() => {
    try {
      window.localStorage.setItem(userStoredLookStorageKey, JSON.stringify(options.userStoredLooks.slice(0, 20)));
    } catch {
      // Local browser storage is optional; stored looks still work in memory.
    }
  }, [options.userStoredLooks]);

  useEffect(() => {
    try {
      window.localStorage.setItem(automationPrefsStorageKey, JSON.stringify(options.automationPrefs));
    } catch {
      // Local browser storage is optional; automation preferences still work in memory.
    }
  }, [options.automationPrefs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        pluginUiValuesStorageKey,
        JSON.stringify(pluginRuntimeUiValueSnapshot(options.pluginRuntimeUiById)),
      );
    } catch {
      // Local browser storage is optional; plugin schema values still work in memory.
    }
  }, [options.pluginRuntimeUiById]);
}
