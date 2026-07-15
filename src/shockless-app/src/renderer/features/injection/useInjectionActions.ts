import { useCallback, type Dispatch, type SetStateAction } from "react";
import { buildShockwavePluginPacketFromControl } from "../../../shared/shockwavePluginPacketBuilder";
import type { ClientSessionList, RelayLogSnapshot } from "../../../shared/window-api";
import {
  clampRepeatCount,
  clampRepeatInterval,
  cloneInjectionDraft,
  delay,
  injectionCommandLabel,
  normalizeInjectionSnippets,
  type InjectionCommandDraft,
  type InjectionHistoryEntry,
  type InjectionSnippet,
} from "./model";

export interface InjectionActionsContext {
  readonly appendTimeline: (severity: "info" | "success" | "warning" | "error", message: string) => void;
  readonly clientSessions: ClientSessionList | null;
  readonly injectionDraft: InjectionCommandDraft;
  readonly injectionRepeatCount: string;
  readonly injectionRepeatInterval: string;
  readonly injectionSendAll: boolean;
  readonly injectionSnippets: readonly InjectionSnippet[];
  readonly refreshRelayLog: () => Promise<RelayLogSnapshot | null>;
  readonly selectedClientId: number;
  readonly setInjectionDraft: Dispatch<SetStateAction<InjectionCommandDraft>>;
  readonly setInjectionHistory: Dispatch<SetStateAction<InjectionHistoryEntry[]>>;
  readonly setInjectionMessage: Dispatch<SetStateAction<string>>;
  readonly setInjectionSnippets: Dispatch<SetStateAction<InjectionSnippet[]>>;
  readonly setRuntimeBusy: Dispatch<SetStateAction<boolean>>;
  readonly setRuntimeMessage: Dispatch<SetStateAction<string>>;
  readonly setSelectedInjectionSnippetId: Dispatch<SetStateAction<string>>;
}

export function useInjectionActions(context: InjectionActionsContext) {
  const {
    appendTimeline, clientSessions, injectionDraft, injectionRepeatCount, injectionRepeatInterval, injectionSendAll, injectionSnippets,
    refreshRelayLog, selectedClientId, setInjectionDraft, setInjectionHistory,
    setInjectionMessage, setInjectionSnippets, setRuntimeBusy, setRuntimeMessage, setSelectedInjectionSnippetId,
  } = context;

  const updateInjectionDraft = useCallback(
    <K extends keyof InjectionCommandDraft>(key: K, value: InjectionCommandDraft[K]) => {
      setInjectionDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const pushInjectionHistory = useCallback((entry: Omit<InjectionHistoryEntry, "id" | "time">) => {
    setInjectionHistory((current) =>
      [
        {
          ...entry,
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          time: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 50),
    );
  }, []);

  const executeInjectionCommand = useCallback(
    async (command: InjectionCommandDraft) => {
      const historyContext = { direction: command.rawDirection, packetText: command.rawText } as const;
      if (!window.shockless) {
          const message = "Run the Electron shell before injecting packets.";
          setInjectionMessage(message);
          pushInjectionHistory({ ...historyContext, status: "warning", message });
          return;
      }
      const packet = {
          target: command.rawDirection === "CLIENT" ? "client" : "server",
          packetText: command.rawText,
      } as const;
      const preview = buildShockwavePluginPacketFromControl(packet);
      if (!preview.ok) {
          setInjectionMessage(preview.message);
          pushInjectionHistory({ ...historyContext, status: "warning", message: preview.message });
          return;
      }
      const targetClientIds = injectionSendAll
          ? (clientSessions?.sessions ?? []).filter((session) => session.status === "running").map((session) => session.id)
          : [selectedClientId];
      if (targetClientIds.length === 0) {
          const message = "No running client sessions are available.";
          setInjectionMessage(message);
          pushInjectionHistory({ ...historyContext, status: "warning", message });
          return;
      }
      const repeatCount = clampRepeatCount(injectionRepeatCount);
      const repeatInterval = clampRepeatInterval(injectionRepeatInterval);
      setRuntimeBusy(true);
      try {
          let sent = 0;
          let failure = "";
          for (let repeat = 0; repeat < repeatCount && !failure; repeat += 1) {
            for (const clientId of targetClientIds) {
              const result = await window.shockless.sendPluginPacket(packet, clientId);
              if (!result.ok) {
                failure = `client${clientId}: ${result.message}`;
                break;
              }
              sent += 1;
            }
            if (!failure && repeat < repeatCount - 1) await delay(repeatInterval);
          }
          const packetName = preview.packet.packetName ?? "UNKNOWN_HEADER";
          const message = failure || `Sent ${packetName} [${preview.packet.header}] to ${packet.target} ${sent} time${sent === 1 ? "" : "s"}.`;
          const ok = !failure;
          setInjectionMessage(message);
          setRuntimeMessage(message);
          pushInjectionHistory({ ...historyContext, status: ok ? "success" : "warning", message });
          appendTimeline(ok ? "success" : "warning", message);
          await refreshRelayLog().catch(() => null);
      } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setInjectionMessage(message);
          pushInjectionHistory({ ...historyContext, status: "error", message });
          appendTimeline("error", message);
      } finally {
          setRuntimeBusy(false);
      }
    },
    [
      appendTimeline,
      clientSessions,
      injectionRepeatCount,
      injectionRepeatInterval,
      injectionSendAll,
      pushInjectionHistory,
      refreshRelayLog,
      selectedClientId,
    ],
  );

  const addInjectionSnippet = useCallback(() => {
    const command = cloneInjectionDraft(injectionDraft);
    const preview = buildShockwavePluginPacketFromControl({
      target: command.rawDirection === "CLIENT" ? "client" : "server",
      packetText: command.rawText,
    });
    if (!preview.ok) {
      setInjectionMessage(preview.message);
      return;
    }
    const label = injectionCommandLabel(command);
    const snippet: InjectionSnippet = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
      command,
      createdAt: new Date().toISOString(),
    };
    setInjectionSnippets((current) => [snippet, ...current.filter((entry) => entry.label !== label)].slice(0, 50));
    setSelectedInjectionSnippetId(snippet.id);
    setInjectionMessage(`Saved snippet: ${label}`);
  }, [injectionDraft]);

  const loadInjectionSnippet = useCallback((snippet: InjectionSnippet) => {
    setInjectionDraft(cloneInjectionDraft(snippet.command));
    setSelectedInjectionSnippetId(snippet.id);
    setInjectionMessage(`Loaded snippet: ${snippet.label}`);
  }, []);

  const exportInjectionSnippets = useCallback(() => {
    if (injectionSnippets.length === 0) {
      setInjectionMessage("No saved snippets to export.");
      return;
    }
    const blob = new Blob([`${JSON.stringify(injectionSnippets, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `shockless-injection-snippets-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setInjectionMessage(`Prepared export for ${injectionSnippets.length} snippets.`);
  }, [injectionSnippets]);

  const importInjectionSnippets = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const loaded = normalizeInjectionSnippets(parsed);
      if (loaded.length === 0) {
        setInjectionMessage("Snippet file did not contain supported v4 or v3 entries.");
        return;
      }
      setInjectionSnippets((current) => [...loaded, ...current].slice(0, 50));
      setSelectedInjectionSnippetId(loaded[0]?.id ?? "");
      setInjectionMessage(`Loaded ${loaded.length} snippets.`);
    } catch (error) {
      setInjectionMessage(error instanceof Error ? `Load failed: ${error.message}` : "Load failed.");
    }
  }, []);

  return {
    addInjectionSnippet,
    executeInjectionCommand,
    exportInjectionSnippets,
    importInjectionSnippets,
    loadInjectionSnippet,
    updateInjectionDraft,
  };
}
