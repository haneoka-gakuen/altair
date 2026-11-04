import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";

export interface TaskSheetProps {
  title: string;
  wide?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  onClose(): void;
}

export function TaskSheet({ title, wide = false, actions, children, onClose }: TaskSheetProps) {
  const { t } = useStudioI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current!;
    if (!returnTo.current && document.activeElement instanceof HTMLElement) returnTo.current = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (returnTo.current?.isConnected) returnTo.current.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? "author-sheet author-sheet--wide" : "author-sheet"}
      aria-labelledby={titleId}
      onClose={() => {
        // StrictMode re-runs the mount effect; the close it queues lands on a reopened dialog.
        if (!ref.current?.open) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="author-sheet-surface">
        <header className="author-sheet-header">
          <h2 id={titleId} className="author-sheet-title">
            {title}
          </h2>
          {actions}
          <button
            type="button"
            className="author-icon-button"
            aria-label={t("Close")}
            onClick={() => ref.current!.close()}
          >
            <X aria-hidden />
          </button>
        </header>
        <div className="author-sheet-body">{children}</div>
      </div>
    </dialog>
  );
}
