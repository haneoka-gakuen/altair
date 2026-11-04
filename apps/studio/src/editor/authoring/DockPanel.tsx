import { useId, type ReactNode } from "react";
import { X } from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";

export function DockPanel({
  title,
  children,
  onClose,
  timeline = false,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  timeline?: boolean;
  actions?: ReactNode;
}) {
  const { t } = useStudioI18n();
  const id = useId();
  return (
    <section className={timeline ? "author-panel author-timeline" : "author-panel"} aria-labelledby={id}>
      <header className="author-panel-header">
        <h2 id={id}>{title}</h2>
        {actions && <div className="author-panel-context-actions">{actions}</div>}
        <button type="button" className="author-icon-button" aria-label={t("Close")} onClick={onClose}>
          <X aria-hidden />
        </button>
      </header>
      <div className="author-panel-body">{children}</div>
    </section>
  );
}
