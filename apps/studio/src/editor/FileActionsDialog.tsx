import { useMemo, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { planProjectPathMove, planProjectPathCopy, projectDirectories, projectFilePath } from "./file-operations";
import type { EditorSession } from "./session";
import { tr, useStudioI18n } from "./i18n";

export function FileActionsDialog({
  session,
  source,
  onClose,
  onMoved,
  action = "move",
  initialTarget,
}: {
  session: EditorSession;
  source: string;
  onClose(): void;
  onMoved(paths: ReadonlyMap<string, string>): void;
  action?: "move" | "copy" | "folder";
  initialTarget?: string;
}) {
  useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [target, setTarget] = useState(initialTarget ?? source),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const validation = useMemo(() => {
    if (action === "move" && target === source) return {};
    if (!target) return {};
    try {
      if (action === "folder") {
        projectFilePath(target);
        if (state.directories.includes(target) || state.files.some((file) => file.path === target))
          throw new Error(tr("A file with this name already exists"));
        projectDirectories(state.files, [...state.directories, target]);
        return { valid: true };
      }
      if (action === "copy")
        return {
          valid: true,
          copy: planProjectPathCopy(state.files, state.documents, source, target, state.directories),
        };
      return {
        valid: true,
        plan: planProjectPathMove(state.files, state.documents, source, target, state.directories),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [state.files, state.documents, state.directories, action, source, target]);
  const title =
    action === "folder" ? tr("New folder") : action === "copy" ? tr("Copy file or folder") : tr("Rename or move");
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
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{source || tr("Project folder")}</Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!validation.valid) return;
              setPending(true);
              setError("");
              void (
                action === "folder"
                  ? session.createProjectDirectory(target)
                  : action === "copy"
                    ? session.copyProjectPath(source, target)
                    : session.moveProjectPath(source, target)
              )
                .then((result) => {
                  onMoved(result?.paths ?? new Map());
                  onClose();
                })
                .catch((error) => setError(error instanceof Error ? tr(error.message) : String(error)))
                .finally(() => setPending(false));
            }}
          >
            <label className="field">
              {tr("New project path")}
              <input
                autoFocus
                required
                disabled={pending}
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setError("");
                }}
              />
            </label>
            {validation.plan && (
              <p>
                {tr("References updated in {{count}} documents", { count: validation.plan.changedReferences.length })}
              </p>
            )}
            {(validation.plan ?? validation.copy)?.warnings.length ? (
              <p role="status">
                {tr("Check references in these files")}: {(validation.plan ?? validation.copy)!.warnings.join(", ")}
              </p>
            ) : null}
            {(error || validation.error) && (
              <p role="alert" className="home-error">
                {error || tr(validation.error ?? "")}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" disabled={pending} onClick={onClose}>
                {tr("Cancel")}
              </button>
              <button className="primary-button" disabled={pending || state.saving || !validation.valid}>
                {tr(pending ? "Saving" : "Apply")}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
