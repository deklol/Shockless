import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { runtimeRoomId, runtimeRoomName, runtimeRoomType } from "../../../engine-adapter/shocklessSessionAdapter";
import type { EngineRuntimeSnapshot, RuntimeChatEntry } from "../../engineRuntime";

interface UseRoomSessionEffectsOptions {
  readonly selectedRuntimeSnapshot: EngineRuntimeSnapshot | null;
  readonly engineUrl: string | null;
  readonly roomReady: boolean;
  readonly autoHideBulletin: boolean;
  readonly hideBulletinBoard: (mode: "auto" | "manual") => Promise<void>;
  readonly setChatRoomMarkers: Dispatch<SetStateAction<RuntimeChatEntry[]>>;
}

/** Tracks room transitions in chat and performs the optional bulletin cleanup once per window set. */
export function useRoomSessionEffects(options: UseRoomSessionEffectsOptions): void {
  const lastChatRoomMarkerKeyRef = useRef("");
  const lastAutoHideBulletinKeyRef = useRef("");

  useEffect(() => {
    if (!options.selectedRuntimeSnapshot) return;
    const nextKey = options.roomReady
      ? `room:${runtimeRoomType(options.selectedRuntimeSnapshot)}:${runtimeRoomId(options.selectedRuntimeSnapshot)}:${runtimeRoomName(options.selectedRuntimeSnapshot)}`
      : options.engineUrl
        ? "not-ready"
        : "stopped";
    const previousKey = lastChatRoomMarkerKeyRef.current;
    if (previousKey === nextKey) return;
    lastChatRoomMarkerKeyRef.current = nextKey;

    const markerText = options.roomReady
      ? `Entered room: ${runtimeRoomName(options.selectedRuntimeSnapshot)}`
      : previousKey.startsWith("room:")
        ? "Room cleared."
        : "";
    if (!markerText) return;

    const marker: RuntimeChatEntry = {
      index: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      userName: "Room",
      chatMode: "system",
      text: markerText,
    };
    options.setChatRoomMarkers((current) => [...current.slice(-99), marker]);
  }, [options.engineUrl, options.roomReady, options.selectedRuntimeSnapshot, options.setChatRoomMarkers]);

  useEffect(() => {
    if (!options.autoHideBulletin || !options.selectedRuntimeSnapshot || !options.engineUrl) return;
    const bulletinWindows = options.selectedRuntimeSnapshot.windowIds.filter((id) => /bulletin|welcome|news/i.test(id));
    if (bulletinWindows.length === 0) return;
    const nextKey = `${options.engineUrl}:${bulletinWindows.join("|")}`;
    if (lastAutoHideBulletinKeyRef.current === nextKey) return;
    lastAutoHideBulletinKeyRef.current = nextKey;
    void options.hideBulletinBoard("auto");
  }, [options.autoHideBulletin, options.engineUrl, options.hideBulletinBoard, options.selectedRuntimeSnapshot]);
}
