import { createContext, useId, useRef, useState, type ReactNode } from "react";
import { X } from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";

export const TimelineToolbarHost = createContext<HTMLDivElement | null>(null);
export const TimelineInspectorHost = createContext<HTMLDivElement | null>(null);

export function DockPanel({
  title,
  children,
  onClose,
  timeline = false,
  actions,
  resizeHandle,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  timeline?: boolean;
  actions?: ReactNode;
  resizeHandle?: ReactNode;
}) {
  const { t } = useStudioI18n();
  const id = useId();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  return (
    <section className={timeline ? "author-panel author-timeline" : "author-panel"} aria-labelledby={id}>
      {resizeHandle}
      <header className="author-panel-header">
        <h2 id={id}>{title}</h2>
        {timeline && <div className="author-timeline-toolbar" ref={setToolbar} />}
        {actions && <div className="author-panel-context-actions">{actions}</div>}
        <button type="button" className="author-icon-button" aria-label={t("Close")} onClick={onClose}>
          <X aria-hidden />
        </button>
      </header>
      <div className="author-panel-body">
        <TimelineToolbarHost.Provider value={toolbar}>{children}</TimelineToolbarHost.Provider>
      </div>
    </section>
  );
}

export function TimelineDivider({ height, onResize }: { height: number; onResize(value: number): void }) {
  const { t } = useStudioI18n();
  const drag = useRef<{ startY: number; initial: number; available: number } | null>(null);
  const resize = (percent: number) => onResize(Math.max(25, Math.min(70, Math.round(percent))));
  return (
    <div
      className="author-timeline-divider"
      role="separator"
      tabIndex={0}
      aria-label={t("Resize timeline")}
      aria-orientation="horizontal"
      aria-valuenow={height}
      aria-valuemin={25}
      aria-valuemax={70}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") resize(height + 5);
        else if (event.key === "ArrowDown") resize(height - 5);
        else if (event.key === "Home") resize(25);
        else if (event.key === "End") resize(70);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        const workbench = event.currentTarget.closest(".author-workbench");
        if (event.button !== 0 || !workbench) return;
        drag.current = { startY: event.clientY, initial: height, available: workbench.clientHeight };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
          resize(drag.current.initial + (100 * (drag.current.startY - event.clientY)) / drag.current.available);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}
