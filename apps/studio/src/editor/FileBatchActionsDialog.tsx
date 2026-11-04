import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { EditorSession } from "./session";
import { tr } from "./i18n";

export function FileBatchActionsDialog({
  session,
  paths,
  action,
  onClose,
  onDone,
}: {
  session: EditorSession;
  paths: readonly string[];
  action: "copy" | "move" | "delete";
  onClose(): void;
  onDone(paths: ReadonlyMap<string, string>): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const signature = paths.join("\0");
  const roots = useMemo(() => {
    const all = signature.split("\0");
    return all.filter((path) => !all.some((other) => other !== path && path.startsWith(`${other}/`)));
  }, [signature]);
  const [directory, setDirectory] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const running = useRef(false);
  const label = tr(action === "copy" ? "Copy files" : action === "move" ? "Move files" : "Delete files");
  const submit = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const moved = await session.operateProjectPaths(
        roots.filter((path) => !done.has(path)),
        action,
        directory,
        (source) => setDone((previous) => new Set([...previous, source])),
      );
      onDone(moved);
    } catch (error) {
      setError(error instanceof Error ? tr(error.message) : String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title>{label}</Dialog.Title>
          <Dialog.Description>{tr("{{count}} selected files", { count: roots.length })}</Dialog.Description>
          <ul className="file-recovery-list">
            {roots.map((path) => (
              <li key={path}>
                {done.has(path) ? "✓ " : ""}
                {path}
              </li>
            ))}
          </ul>
          {action !== "delete" && (
            <label className="field">
              <span>{tr("Destination folder")}</span>
              <select
                value={directory}
                disabled={busy || done.size > 0}
                onChange={(event) => setDirectory(event.target.value)}
              >
                <option value="">{tr("Project folder")}</option>
                {state.directories.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="home-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button disabled={busy} onClick={onClose}>
              {tr("Cancel")}
            </button>
            <button
              className="primary-button"
              disabled={busy || state.saving || done.size === roots.length}
              onClick={() => void submit()}
            >
              {busy ? `${done.size} / ${roots.length}` : label}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
