import { startTransition, useEffect, type MutableRefObject } from "react";

interface UsePanelAutoScrollOptions {
  readonly selectedPluginId: string;
  readonly chatAutoscroll: boolean;
  readonly visibleChatCount: number;
  readonly packetAutoscroll: boolean;
  readonly visiblePacketCount: number;
  readonly packetConsoleOpen: boolean;
  readonly packetConsoleEntryCount: number;
  readonly packetConsolePacketCount: number;
  readonly packetConsoleLatestPacketKey: string;
  readonly chatListRef: MutableRefObject<HTMLDivElement | null>;
  readonly packetListRef: MutableRefObject<HTMLDivElement | null>;
  readonly packetConsoleListRef: MutableRefObject<HTMLDivElement | null>;
  readonly packetConsolePacketListRef: MutableRefObject<HTMLDivElement | null>;
  readonly setPacketListScrollTop: (value: number) => void;
  readonly setPacketConsoleScrollTop: (value: number) => void;
}

/** Keeps live chat and packet surfaces pinned to their newest rows when requested. */
export function usePanelAutoScroll(options: UsePanelAutoScrollOptions): void {
  useEffect(() => {
    if (options.selectedPluginId !== "chat" || !options.chatAutoscroll) return;
    const list = options.chatListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [options.chatAutoscroll, options.chatListRef, options.selectedPluginId, options.visibleChatCount]);

  useEffect(() => {
    if (options.selectedPluginId !== "packet-log" || !options.packetAutoscroll) return;
    const list = options.packetListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    startTransition(() => options.setPacketListScrollTop(list.scrollTop));
  }, [options.packetAutoscroll, options.packetListRef, options.selectedPluginId, options.setPacketListScrollTop, options.visiblePacketCount]);

  useEffect(() => {
    if (!options.packetConsoleOpen) return;
    const list = options.packetConsoleListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    const packetList = options.packetConsolePacketListRef.current;
    if (!packetList) return;
    packetList.scrollTop = packetList.scrollHeight;
    startTransition(() => options.setPacketConsoleScrollTop(packetList.scrollTop));
  }, [
    options.packetConsoleEntryCount,
    options.packetConsoleListRef,
    options.packetConsoleOpen,
    options.packetConsolePacketCount,
    options.packetConsoleLatestPacketKey,
    options.packetConsolePacketListRef,
    options.setPacketConsoleScrollTop,
  ]);
}
