import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, RefreshCw, X } from "lucide-react";
import type { EditorSession } from "./session";
import { projectLibrary, type NativeImportJournal } from "./library";
import { nativeImportBackupFiles, type NativeImportReview } from "./native-import";
import { createFilesZip } from "./archive";
import { tr, useStudioI18n } from "./i18n";

export function NativeImportRecoveryDialog({
  session,
  backups = false,
  onClose,
}: {
  session: EditorSession;
  backups?: boolean;
  onClose(): void;
}) {
  useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [review, setReview] = useState<NativeImportReview>(),
    [records, setRecords] = useState<readonly NativeImportJournal[]>([]);
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [acceptChanges, setAcceptChanges] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined),
    mounted = useRef(false);
  const [focusReturn] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setIssue("");
    try {
      await action(controller.signal);
    } catch (error) {
      if (mounted.current && operation.current === controller && !controller.signal.aborted)
        setIssue(error instanceof Error ? tr(error.message) : String(error));
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const load = () =>
    void run(async (signal) => {
      if (backups) {
        const next = await projectLibrary.nativeImportBackups(state.id);
        signal.throwIfAborted();
        if (mounted.current) setRecords(next.sort((a, b) => b.createdAt - a.createdAt));
      } else {
        const next = await session.reviewNativeImport(signal);
        signal.throwIfAborted();
        if (mounted.current) {
          setReview(next);
          setAcceptChanges(false);
        }
      }
    });
  useEffect(() => {
    mounted.current = true;
    setReview(undefined);
    setRecords([]);
    setIssue("");
    load();
    return () => {
      mounted.current = false;
      operation.current?.abort();
      operation.current = undefined;
    };
  }, [session, backups, state.contextEpoch]);
  const close = () => {
    operation.current?.abort();
    operation.current = undefined;
    onClose();
  };
  const choose = (choice: "finish" | "restore") => {
    if (!review || busy || state.saving || (review.changedPaths.length && !acceptChanges)) return;
    void run(async (signal) => {
      await session.resolveNativeImport(review, choice, signal);
      signal.throwIfAborted();
      if (mounted.current) onClose();
    });
  };
  const download = (journal: NativeImportJournal, version: "before" | "after" | "external") =>
    void run(async (signal) => {
      const blob = await createFilesZip(nativeImportBackupFiles(journal, version), [], signal);
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${journal.id}-${version}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
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
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target =
              focusReturn?.isConnected && !focusReturn.matches(":disabled")
                ? focusReturn
                : document.querySelector<HTMLElement>('.document-tabs [role="tab"][aria-selected="true"]');
            target?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <header className="conflict-resolution-header">
            <div>
              <Dialog.Title>{tr(backups ? "Native import backups" : "Recover unfinished import")}</Dialog.Title>
              <Dialog.Description>
                {tr(
                  backups
                    ? "Download the original project, planned import, or preserved external files."
                    : "Review folder changes, then finish the import or restore the original files.",
                )}
              </Dialog.Description>
            </div>
            <button type="button" className="icon-button" aria-label={tr("Close")} onClick={close}>
              <X size={20} />
            </button>
          </header>
          {busy && <p role="status">{tr("Working…")}</p>}
          {issue && (
            <p className="home-error" role="alert">
              {issue}
            </p>
          )}
          {!backups && (
            <>
              <button type="button" className="secondary-button" disabled={busy || state.saving} onClick={load}>
                <RefreshCw size={16} />
                {tr("Refresh comparison")}
              </button>
              {review && (
                <>
                  <div className="inspector-body">
                    <ul>
                      {review.files.map((file, index) => (
                        <li className="conflict-resolution-notice" key={file.path}>
                          <span>
                            <strong>{file.path}</strong>
                            <br />
                            {tr(
                              review.changedPaths.includes(file.path)
                                ? "Changed outside the import"
                                : file.hash === review.journal.entries[index]!.afterHash
                                  ? "Imported version present"
                                  : "Original version present",
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {review.changedPaths.length > 0 && (
                    <label className="field">
                      <span>
                        <input
                          type="checkbox"
                          checked={acceptChanges}
                          onChange={(e) => setAcceptChanges(e.target.checked)}
                          disabled={busy || state.saving}
                        />
                        {tr("Preserve changed files in the backup, then replace them with my chosen version.")}
                      </span>
                    </label>
                  )}
                  <div className="conflict-resolution-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || state.saving || Boolean(review.changedPaths.length && !acceptChanges)}
                      onClick={() => choose("restore")}
                    >
                      {tr("Restore original files")}
                    </button>{" "}
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy || state.saving || Boolean(review.changedPaths.length && !acceptChanges)}
                      onClick={() => choose("finish")}
                    >
                      {tr("Finish import")}
                    </button>
                  </div>
                  <p>{tr("Completed recovery copies remain available in Native import backups.")}</p>
                </>
              )}
            </>
          )}
          {backups && (
            <>
              {!busy && !records.length && <p>{tr("No native import backups")}</p>}
              <ul>
                {records.map((record) => (
                  <li className="conflict-resolution-notice" key={record.id}>
                    <strong>{new Date(record.createdAt).toLocaleString()}</strong>
                    <p>{tr("{{count}} files", { count: record.entries.length })}</p>
                    {(["before", "after", "external"] as const)
                      .filter((version) => version !== "external" || record.externalCopies?.length)
                      .map((version) => (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          key={version}
                          onClick={() => download(record, version)}
                        >
                          <Download size={16} />
                          {tr(
                            version === "before"
                              ? "Original project"
                              : version === "after"
                                ? "Planned import"
                                : "Preserved external files",
                          )}
                        </button>
                      ))}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="secondary-button" onClick={close}>
            {tr("Cancel")}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
