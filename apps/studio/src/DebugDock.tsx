import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react";

export const MIN_DEBUG_DOCK_HEIGHT = 140;
export const DEFAULT_DEBUG_DOCK_HEIGHT = 260;

export const debugDockMaxHeight = (viewportHeight: number): number => {
  const available = viewportHeight - 52 - Math.min(280, viewportHeight * 0.38) - Math.min(120, viewportHeight * 0.2);
  return Math.max(MIN_DEBUG_DOCK_HEIGHT, Math.min(viewportHeight * 0.65, available));
};

export const clampDebugDockHeight = (value: number, viewportHeight: number): number =>
  Math.max(MIN_DEBUG_DOCK_HEIGHT, Math.min(debugDockMaxHeight(viewportHeight), value));

export interface DebugDockProps {
  readonly children: ReactNode;
  readonly height: number;
  readonly onHeightChange: (height: number) => void;
  readonly viewportHeight: number;
}

export function DebugDock({ children, height, onHeightChange, viewportHeight }: DebugDockProps) {
  const dragRef = useRef<
    | {
        readonly pointerId: number;
        readonly startHeight: number;
        readonly startY: number;
      }
    | undefined
  >(undefined);

  const resizeFromKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next = height;
    if (event.key === "ArrowUp") next += event.shiftKey ? 40 : 10;
    else if (event.key === "ArrowDown") next -= event.shiftKey ? 40 : 10;
    else if (event.key === "Home") next = MIN_DEBUG_DOCK_HEIGHT;
    else if (event.key === "End") next = viewportHeight * 0.65;
    else return;
    event.preventDefault();
    onHeightChange(clampDebugDockHeight(next, viewportHeight));
  };

  return (
    <div className="debug-dock" style={{ "--debug-dock-height": `${height}px` } as CSSProperties}>
      <div
        aria-label="Resize debugger"
        aria-orientation="horizontal"
        aria-valuemax={Math.round(debugDockMaxHeight(viewportHeight))}
        aria-valuemin={MIN_DEBUG_DOCK_HEIGHT}
        aria-valuenow={Math.round(height)}
        className="debug-resize-handle"
        onKeyDown={resizeFromKey}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = undefined;
          }
        }}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          dragRef.current = {
            pointerId: event.pointerId,
            startHeight: height,
            startY: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          onHeightChange(clampDebugDockHeight(drag.startHeight + drag.startY - event.clientY, viewportHeight));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        role="separator"
        tabIndex={0}
      >
        <span />
      </div>
      {children}
    </div>
  );
}
