import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { projectLibrary, type ProjectRecoveryCopy } from "./library";
import { planProjectPathMove } from "./file-operations";
import type { EditorSession } from "./session";
import { tr, useStudioI18n } from "./i18n";

export function FileRecoveryDialog({
  session,
  source,
  onClose,
  onDeleted,
}: {
  session: EditorSession;
  source?: string;
  onClose(): void;
  onDeleted?(path: string): void;
}) {
  const { i18n } = useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [copies, setCopies] = useState<readonly ProjectRecoveryCopy[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!source)
      void projectLibrary
        .recoveryCopies(state.id)
        .then((copies) => {
          if (active) setCopies(copies.sort((a, b) => b.createdAt - a.createdAt));
        })
        .catch((error) => {
          if (active) setError(String(error));
        });
    return () => {
      active = false;
    };
  }, [state.id, source, revision]);
  const references = useMemo(() => {
    if (!source) return [];
    try {
      return planProjectPathMove(
        state.files,
        state.documents,
        source,
        `recovery-${crypto.randomUUID()}`,
        state.directories,
      ).changedReferences;
    } catch {
      return [];
    }
  }, [source, state.files, state.documents, state.directories]);
  const run = (operation: () => Promise<void>, done: () => void) => {
    setPending(true);
    setError("");
    void operation()
      .then(done)
      .catch((error) => setError(error instanceof Error ? tr(error.message) : String(error)))
      .finally(() => setPending(false));
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title>{tr(source ? "Delete file or folder" : "Recovery copies")}</Dialog.Title>
          <Dialog.Description>{tr("Recovery copies are saved in this browser before deletion.")}</Dialog.Description>
          {source ? (
            <>
              <p>{source}</p>
              <p>
                {tr("{{count}} files", {
                  count: state.files.filter((file) => file.path === source || file.path.startsWith(`${source}/`))
                    .length,
                })}
              </p>
              {references.length > 0 && (
                <p role="status">
                  {tr("Check references in these files")}: {references.join(", ")}
                </p>
              )}
              <p>{tr("Deleting resources can leave references unresolved.")}</p>
            </>
          ) : (
            <div className="file-recovery-list">
              {!copies.length && <p>{tr("No recovery copies")}</p>}
              {copies.map((copy) => (
                <article key={copy.id}>
                  <strong>{copy.path}</strong>
                  <time dateTime={new Date(copy.createdAt).toISOString()}>
                    {new Date(copy.createdAt).toLocaleString(i18n.resolvedLanguage)}
                  </time>
                  <button
                    disabled={pending || state.saving}
                    onClick={() =>
                      run(
                        () => session.restoreProjectPath(copy.id),
                        () => setRevision((revision) => revision + 1),
                      )
                    }
                  >
                    {tr("Restore files")}
                  </button>
                </article>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="home-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button disabled={pending} onClick={onClose}>
              {tr(source ? "Cancel" : "Close")}
            </button>
            {source && (
              <button
                className="primary-button"
                disabled={pending || state.saving}
                onClick={() =>
                  run(
                    () => session.deleteProjectPath(source),
                    () => {
                      onDeleted?.(source);
                      onClose();
                    },
                  )
                }
              >
                {tr(pending ? "Saving" : "Delete file or folder")}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
