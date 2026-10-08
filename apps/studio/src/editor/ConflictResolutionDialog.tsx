import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { EditorSession } from "./session";
import { conflictReviewMatches } from "./conflict-resolution";
import { tr, useStudioI18n } from "./i18n";
import "./conflict-resolution.css";

const HistoryDiff = lazy(() => import("./HistoryDiff").then((module) => ({ default: module.HistoryDiff })));

export function ConflictResolutionDialog({
  session,
  path,
  onClose,
}: {
  session: EditorSession;
  path: string;
  onClose(): void;
}) {
  useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [captured, setCaptured] = useState(() => ({ session, path, review: session.conflictReview(path) }));
  const [comparison, setComparison] = useState("editor");
  const [pending, setPending] = useState<"disk" | "editor">();
  const [error, setError] = useState("");
  const [focusReturn] = useState(() => {
    const trigger = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    return { trigger, workspace: trigger?.closest(".workspace") };
  });
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      operation.current = undefined;
    };
  }, []);
  useEffect(() => () => operation.current?.abort(), [session, path, state.contextEpoch]);

  const review = captured.session === session && captured.path === path ? captured.review : undefined;
  const document = state.documents.find((document) => document.path === path);
  const hasConflict = document?.external !== undefined;
  const stale = !review || !conflictReviewMatches(state.id, document, review, state.contextEpoch ?? 0);
  const disabled = Boolean(pending) || state.saving || !hasConflict || stale;

  const close = () => {
    operation.current?.abort();
    operation.current = undefined;
    onClose();
  };
  const refresh = () => {
    if (operation.current || state.saving) return;
    setCaptured({ session, path, review: session.conflictReview(path) });
    setError("");
  };
  const resolve = (choice: "disk" | "editor") => {
    if (disabled || operation.current || !review) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(choice);
    setError("");
    void session
      .resolveReviewedConflict(review, choice, controller.signal)
      .then(() => {
        if (mounted.current && operation.current === controller && !controller.signal.aborted) onClose();
      })
      .catch((error: unknown) => {
        if (mounted.current && operation.current === controller && !controller.signal.aborted)
          setError(error instanceof Error ? tr(error.message) : String(error));
      })
      .finally(() => {
        if (operation.current !== controller) return;
        operation.current = undefined;
        if (mounted.current) setPending(undefined);
      });
  };
  const notice =
    error ||
    (!pending &&
      (!hasConflict
        ? tr("This conflict is no longer available.")
        : stale
          ? tr("The conflict changed while reviewing. Review it again.")
          : ""));

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content conflict-resolution-dialog"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target =
              focusReturn.trigger?.isConnected && !focusReturn.trigger.matches(":disabled")
                ? focusReturn.trigger
                : focusReturn.workspace?.isConnected
                  ? focusReturn.workspace.querySelector<HTMLElement>(
                      '.document-tabs [role="tab"][aria-selected="true"]',
                    )
                  : null;
            target?.focus({ preventScroll: true });
          }}
        >
          <header className="conflict-resolution-header">
            <div>
              <Dialog.Title>{tr("Review conflict")}</Dialog.Title>
              <Dialog.Description>{path}</Dialog.Description>
            </div>
            <button type="button" className="icon-button" onClick={close} aria-label={tr("Close")}>
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <p className="conflict-resolution-help">
            {tr("Choose which version to keep. The replaced content is backed up first.")}
          </p>
          {notice && (
            <div className="conflict-resolution-notice" role={error || (hasConflict && stale) ? "alert" : "status"}>
              <span>{notice}</span>
              {hasConflict && stale && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(pending) || state.saving}
                  onClick={refresh}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  {tr("Refresh comparison")}
                </button>
              )}
            </div>
          )}
          <Tabs.Root className="conflict-resolution-comparison" value={comparison} onValueChange={setComparison}>
            <Tabs.List className="conflict-resolution-tabs" aria-label={tr("Review conflict")}>
              <Tabs.Trigger value="editor">{tr("Disk and editor")}</Tabs.Trigger>
              <Tabs.Trigger value="baseline">{tr("Baseline and disk")}</Tabs.Trigger>
            </Tabs.List>
            <div className="conflict-resolution-legend" aria-hidden="true">
              <span>{tr(comparison === "baseline" ? "Saved baseline" : "Disk version")}</span>
              <ArrowRight size={16} />
              <span>{tr(comparison === "baseline" ? "Disk version" : "Editor version")}</span>
            </div>
            <Tabs.Content className="conflict-resolution-diff" value={comparison}>
              {review ? (
                <Suspense fallback={<p role="status">{tr("Loading comparison")}</p>}>
                  <HistoryDiff
                    path={review.path}
                    historical={comparison === "baseline" ? review.baseline : review.external}
                    current={comparison === "baseline" ? review.external : review.text}
                  />
                </Suspense>
              ) : (
                <p role="status">{tr("This conflict is no longer available.")}</p>
              )}
            </Tabs.Content>
          </Tabs.Root>
          <footer className="conflict-resolution-footer">
            <div className="conflict-resolution-progress" role="status" aria-live="polite">
              {pending ? (
                <>
                  <LoaderCircle size={16} className="conflict-resolution-spinner" aria-hidden="true" />
                  {tr("Working…")}
                </>
              ) : (
                tr("Keep your edits for the next save.")
              )}
            </div>
            <div className="conflict-resolution-actions">
              <button type="button" className="secondary-button" onClick={close}>
                {tr("Cancel")}
              </button>
              <button type="button" className="secondary-button" disabled={disabled} onClick={() => resolve("disk")}>
                {tr("Load disk version")}
              </button>
              <button type="button" className="primary-button" disabled={disabled} onClick={() => resolve("editor")}>
                {tr("Keep editor version")}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
