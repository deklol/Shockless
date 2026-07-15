import { History, Terminal } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction, UIEvent } from "react";
import type { ConsoleCommandStateSnapshot, RelayLogEntry, RelayLogSnapshot } from "../../shared/window-api";
import {
  consoleSuggestionInsertText,
  type PacketConsoleSuggestion,
} from "../features/packet-console/suggestions";
import type { PacketConsoleEntry } from "../features/packet-console/types";
import { compactValue, relayEntryV3Line, statusLabel } from "./helpers";

interface PacketConsoleOverlayProps {
  readonly open: boolean;
  readonly packetEntriesCount: number;
  readonly packetConsolePacketEntriesCount: number;
  readonly packetConsoleQuery: string;
  readonly packetConsoleClientFilter: string;
  readonly packetClientChoices: readonly { readonly value: string; readonly label: string }[];
  readonly packetHistoryLoading: boolean;
  readonly packetHistory: { readonly logPath: string | null; readonly clientId: number; readonly hasMore: boolean } | null;
  readonly relayLog: RelayLogSnapshot | null;
  readonly transcript: { readonly command: PacketConsoleEntry | null; readonly output: readonly PacketConsoleEntry[] };
  readonly packetConsoleListRef: RefObject<HTMLDivElement>;
  readonly packetConsolePacketListRef: RefObject<HTMLDivElement>;
  readonly virtualRange: { readonly top: number; readonly height: number };
  readonly renderedEntries: readonly RelayLogEntry[];
  readonly suggestions: readonly PacketConsoleSuggestion[];
  readonly suggestionTargetPrefix: string;
  readonly input: string;
  readonly historyIndex: number | null;
  readonly commandState: ConsoleCommandStateSnapshot | null;
  readonly onClientFilterChange: (value: string) => void;
  readonly onLoadOlderHistory: () => void;
  readonly onClose: () => void;
  readonly onPacketScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onInputChange: Dispatch<SetStateAction<string>>;
  readonly onHistoryIndexChange: Dispatch<SetStateAction<number | null>>;
  readonly onExecute: () => void;
}

export function PacketConsoleOverlay(props: PacketConsoleOverlayProps) {
  if (!props.open) return null;
  const selectSuggestion = (suggestion: PacketConsoleSuggestion): void => {
    props.onHistoryIndexChange(null);
    props.onInputChange(consoleSuggestionInsertText(suggestion, props.suggestionTargetPrefix));
  };

  return (
    <div className="packet-console" aria-label="Packet log console">
      <div className="packet-console-header">
        <div>
          <Terminal size={14} />
          <strong>Packet Log</strong>
          <span>{compactValue(props.packetConsolePacketEntriesCount)} rows</span>
          <span>{props.packetConsoleClientFilter === "All" ? "all clients" : `client${props.packetConsoleClientFilter}`}</span>
          {props.packetConsoleQuery ? <span>filter: {props.packetConsoleQuery}</span> : null}
        </div>
        <select
          className="packet-console-client-select"
          value={props.packetConsoleClientFilter}
          onChange={(event) => props.onClientFilterChange(event.currentTarget.value)}
          aria-label="Packet console client filter"
        >
          {props.packetClientChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={props.onLoadOlderHistory}
          disabled={
            props.packetHistoryLoading ||
            props.packetConsoleClientFilter === "All" ||
            Boolean(
              props.packetHistory &&
                props.packetHistory.logPath === props.relayLog?.logPath &&
                props.packetHistory.clientId === Number(props.packetConsoleClientFilter) &&
                props.packetHistory.hasMore === false,
            )
          }
          aria-label="Load older packet history"
          title={
            props.packetConsoleClientFilter === "All"
              ? "Select one client to load older packet history"
              : "Load older packet history from disk"
          }
        >
          <History size={13} />
        </button>
        <button type="button" onClick={props.onClose} aria-label="Close packet log console">
          `
        </button>
      </div>
      <div className="packet-console-list">
        {props.transcript.command || props.transcript.output.length > 0 ? (
          <div className="packet-console-output-list" ref={props.packetConsoleListRef}>
            {props.transcript.command ? (
              <div className="packet-console-output command" key={props.transcript.command.id}>
                <span>{props.transcript.command.time}</span>
                <strong>&gt;</strong>
                <small>{props.transcript.command.text}</small>
              </div>
            ) : null}
            {props.transcript.output.map((entry) => (
              <div className={`packet-console-output ${entry.kind}`} key={entry.id}>
                <span>{entry.time}</span>
                <strong>{statusLabel(entry.kind)}</strong>
                <small>{entry.text}</small>
              </div>
            ))}
          </div>
        ) : null}
        {props.packetConsolePacketEntriesCount > 0 ? (
          <div className="packet-console-packet-list" ref={props.packetConsolePacketListRef} onScroll={props.onPacketScroll}>
            <div className="packet-console-packet-space" style={{ height: props.virtualRange.height }}>
              <div
                className="packet-console-packet-window"
                style={{ transform: `translateY(${props.virtualRange.top}px)` }}
              >
                {props.renderedEntries.map((entry) => (
                  <code className={`packet-console-packet-row packet-${entry.direction.toLowerCase()}`} key={entry.id}>
                    {relayEntryV3Line(entry, props.relayLog?.updatedAt)}
                  </code>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {props.packetConsolePacketEntriesCount === 0 ? (
          <div className="packet-console-empty">
            {props.packetEntriesCount === 0 ? "Start the embedded client to create relay rows." : "No packets match this filter."}
          </div>
        ) : null}
      </div>
      <div className="packet-console-input-row">
        <span>`</span>
        {props.suggestions.length > 0 ? (
          <div className="packet-console-suggestions" role="listbox" aria-label="Console command suggestions">
            {props.suggestions.map((suggestion) => (
              <button
                type="button"
                className="packet-console-suggestion"
                key={`${suggestion.usage}:${suggestion.detail}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectSuggestion(suggestion);
                }}
              >
                <strong>{consoleSuggestionInsertText(suggestion, props.suggestionTargetPrefix)}</strong>
                <small>{suggestion.source ? `${suggestion.source}: ${suggestion.detail}` : suggestion.detail}</small>
              </button>
            ))}
          </div>
        ) : null}
        <input
          value={props.input}
          onChange={(event) => props.onInputChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Tab" && props.suggestions.length > 0) {
              event.preventDefault();
              selectSuggestion(props.suggestions[0]!);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              props.onExecute();
              return;
            }
            const history = props.commandState?.history ?? [];
            if (event.key === "ArrowUp" && history.length > 0) {
              event.preventDefault();
              const nextIndex = props.historyIndex === null ? history.length - 1 : Math.max(0, props.historyIndex - 1);
              props.onHistoryIndexChange(nextIndex);
              props.onInputChange(history[nextIndex] ?? "");
              return;
            }
            if (event.key !== "ArrowDown" || history.length === 0 || props.historyIndex === null) return;
            event.preventDefault();
            const nextIndex = props.historyIndex + 1;
            if (nextIndex >= history.length) {
              props.onHistoryIndexChange(null);
              props.onInputChange("");
            } else {
              props.onHistoryIndexChange(nextIndex);
              props.onInputChange(history[nextIndex] ?? "");
            }
          }}
          placeholder="help / alias bringall summon all / bind F1 bringall / packets client 2"
          aria-label="Packet console command"
        />
      </div>
    </div>
  );
}
