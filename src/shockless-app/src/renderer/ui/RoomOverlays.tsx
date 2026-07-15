import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, X, ZoomIn, ZoomOut } from "lucide-react";
import type { EngineRuntimeSnapshot } from "../engineRuntime";
import { runtimeRoomName, runtimeRoomType } from "../../engine-adapter/shocklessSessionAdapter";

interface RoomOverlaysProps {
  readonly roomPluginEnabled: boolean;
  readonly roomOverlayEnabled: boolean;
  readonly devToolsPluginEnabled: boolean;
  readonly devToolsStatusEnabled: boolean;
  readonly roomReady: boolean | null;
  readonly privateRoomReady: boolean | null;
  readonly runtimeSnapshot: EngineRuntimeSnapshot | null;
  readonly gameZoom: number;
  readonly fps: number | null;
  readonly onZoomToggle: () => void;
  readonly onCloseRoomOverlay: () => void;
  readonly onCloseFpsOverlay: () => void;
}

function compact(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "-";
}

/** Drag-to-move for an overlay, with the position persisted to localStorage. */
function useDraggable(storageKey: string): {
  readonly style: CSSProperties;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as { x: number; y: number }) : null;
      return parsed && typeof parsed.x === "number" && typeof parsed.y === "number" ? parsed : null;
    } catch {
      return null;
    }
  });
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      setPos({
        x: Math.max(0, d.baseX + (event.clientX - d.startX)),
        y: Math.max(0, d.baseY + (event.clientY - d.startY)),
      });
    };
    const up = (): void => {
      if (!drag.current) return;
      drag.current = null;
      setPos((current) => {
        try {
          if (current) window.localStorage.setItem(storageKey, JSON.stringify(current));
        } catch {
          /* ignore persistence errors */
        }
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [storageKey]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const el = event.currentTarget.closest<HTMLElement>(".room-overlay");
      if (!el) return;
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        // offsetLeft/Top are relative to the positioned ancestor — the same coordinate
        // space as the inline left/top we set — so the overlay doesn't jump on first drag.
        baseX: pos?.x ?? el.offsetLeft,
        baseY: pos?.y ?? el.offsetTop,
      };
      event.preventDefault();
    },
    [pos],
  );

  const style: CSSProperties = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : {};
  return { style, onPointerDown };
}

export function RoomOverlays({
  roomPluginEnabled, roomOverlayEnabled, devToolsPluginEnabled, devToolsStatusEnabled,
  roomReady, privateRoomReady, runtimeSnapshot, gameZoom, fps, onZoomToggle,
  onCloseRoomOverlay, onCloseFpsOverlay,
}: RoomOverlaysProps) {
  const roomDrag = useDraggable("habbpy.overlay.room");
  const fpsDrag = useDraggable("habbpy.overlay.fps");
  return (
    <>
      {roomPluginEnabled && roomOverlayEnabled && roomReady ? (
        <div className="room-overlay room-overlay-top room-overlay-draggable" style={roomDrag.style}>
          <button className="room-overlay-drag-handle" type="button" onPointerDown={roomDrag.onPointerDown} title="Move room overlay" aria-label="Move room overlay">
            <GripVertical size={11} />
          </button>
          <button className="room-overlay-close" type="button" onClick={onCloseRoomOverlay} title="Hide room overlay" aria-label="Hide room overlay">
            <X size={11} />
          </button>
          <strong>{runtimeRoomName(runtimeSnapshot)}</strong>
          <span>
            {runtimeRoomType(runtimeSnapshot)} / {compact(runtimeSnapshot?.userState?.roomUserCount ?? runtimeSnapshot?.roomReady?.roomLikeSpriteCount)} users
          </span>
          {privateRoomReady ? (
            <button className="room-zoom-toggle" type="button" onClick={onZoomToggle} title={gameZoom === 1 ? "Zoom to 200%" : "Zoom to 100%"} aria-label={gameZoom === 1 ? "Zoom to 200%" : "Zoom to 100%"}>
              {gameZoom === 1 ? <ZoomIn size={13} /> : <ZoomOut size={13} />}
              <span>{gameZoom === 1 ? "2x" : "1x"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {devToolsPluginEnabled && devToolsStatusEnabled && runtimeSnapshot ? (
        <div className="room-overlay room-overlay-bottom room-overlay-draggable" style={fpsDrag.style}>
          <button className="room-overlay-drag-handle" type="button" onPointerDown={fpsDrag.onPointerDown} title="Move performance overlay" aria-label="Move performance overlay">
            <GripVertical size={11} />
          </button>
          <button className="room-overlay-close" type="button" onClick={onCloseFpsOverlay} title="Hide FPS overlay" aria-label="Hide FPS overlay">
            <X size={11} />
          </button>
          <strong>FPS {compact(fps ?? runtimeSnapshot.performanceStats?.currentFps ?? runtimeSnapshot.performanceStats?.rafPerSecond)}</strong>
          <span>{runtimeRoomName(runtimeSnapshot)}</span>
        </div>
      ) : null}
    </>
  );
}
