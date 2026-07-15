import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly baseX: number;
  readonly baseY: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly baseWidth: number;
  readonly baseHeight: number;
}

interface DraggablePopoutResult {
  readonly ref: RefObject<HTMLElement>;
  readonly style: CSSProperties;
  readonly onHeaderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

const interactiveSelector = "button,input,select,textarea,a,[role='button'],[data-no-drag='true']";

export function useDraggablePopout(open: boolean): DraggablePopoutResult {
  const popoutRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState<{ readonly width: number | null; readonly height: number | null }>({ width: null, height: null });
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  useEffect(() => {
    if (!open) {
      dragRef.current = null;
      resizeRef.current = null;
      setPosition({ x: 0, y: 0 });
      setSize({ width: null, height: null });
    }
  }, [open]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (resize && event.pointerId === resize.pointerId) {
        const maxWidth = Math.max(520, window.innerWidth - 40);
        const maxHeight = Math.max(420, window.innerHeight - 40);
        setSize({
          width: Math.min(maxWidth, Math.max(760, resize.baseWidth + event.clientX - resize.startX)),
          height: Math.min(maxHeight, Math.max(520, resize.baseHeight + event.clientY - resize.startY)),
        });
        return;
      }
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      setPosition({
        x: drag.baseX + event.clientX - drag.startX,
        y: drag.baseY + event.clientY - drag.startY,
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && event.pointerId === drag.pointerId) dragRef.current = null;
      const resize = resizeRef.current;
      if (resize && event.pointerId === resize.pointerId) resizeRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  const onHeaderPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(interactiveSelector)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: position.x,
      baseY: position.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }, [position.x, position.y]);

  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const rect = popoutRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseWidth: rect.width,
      baseHeight: rect.height,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const sizeStyle = size.width && size.height
    ? ({
        "--popout-width": `${size.width}px`,
        "--popout-height": `${size.height}px`,
      } as CSSProperties)
    : null;

  return {
    ref: popoutRef,
    style: {
      translate: `${position.x}px ${position.y}px`,
      ...sizeStyle,
    },
    onHeaderPointerDown,
    onResizePointerDown,
  };
}
