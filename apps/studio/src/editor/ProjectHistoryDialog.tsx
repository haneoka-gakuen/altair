import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Clock, RotateCcw, Save, X } from "lucide-react";
import { NumberInput } from "@haneoka/altair-ui-react";
import type { EditorSession } from "./session";
import { DEFAULT_HISTORY_POLICY, type HistoryEntry, type HistoryKind, type HistoryPolicy } from "./project-history";
import { tr, useStudioI18n } from "./i18n";
import "./history.css";
const HistoryDiff = lazy(() => import("./HistoryDiff").then((module) => ({ default: module.HistoryDiff })));
const sourceLabel = (kind: HistoryKind) =>
  tr(
    {
      "manual-save": "Manual save",
      "manual-snapshot": "Manual snapshot",
      "auto-save": "Automatic snapshot",
      "before-save": "Before save",
      "before-restore": "Before restore",
      restore: "Restored version",
      "system-refactor": "File operation",
    }[kind],
  );

export function ProjectHistoryDialog({
  session,
  path,
  onClose,
}: {
  session: EditorSession;
  path: string;
  onClose(): void;
}) {
  const { i18n } = useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const doc = state.documents.find((doc) => doc.path === path);
  const [entries, setEntries] = useState<readonly HistoryEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [historical, setHistorical] = useState<string>();
  const [policy, setPolicy] = useState<HistoryPolicy>({ ...DEFAULT_HISTORY_POLICY });
  const [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([session.projectHistory.list(path), session.projectHistory.policy()])
      .then(([entries, policy]) => {
        if (!active) return;
        setEntries(entries);
        setPolicy(policy);
        setSelected((selected) => (entries.some((entry) => entry.id === selected) ? selected : (entries[0]?.id ?? "")));
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session, path, revision]);
  useEffect(() => {
    let active = true;
    setHistorical(undefined);
    setConfirm(false);
    setReading(Boolean(selected));
    if (!selected) return;
    void session.projectHistory
      .read(selected, path)
      .then((text) => {
        if (active) setHistorical(text);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [session, selected, path, revision]);
  const run = (operation: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    void operation()
      .then(() => {
        setRevision((value) => value + 1);
        setConfirm(false);
      })
      .catch((error) => setError(error instanceof Error ? tr(error.message) : String(error)))
      .finally(() => setPending(false));
  };
  const applyPolicy = (next: HistoryPolicy) =>
    run(async () => {
      await session.projectHistory.setPolicy(next);
      setPolicy(next);
    });
  const entry = entries.find((entry) => entry.id === selected);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content project-history-dialog">
          <header className="history-header">
            <div>
              <Dialog.Title>{tr("Version history")}</Dialog.Title>
              <Dialog.Description>{path}</Dialog.Description>
            </div>
            <button className="icon-button" disabled={pending} onClick={onClose} aria-label={tr("Close")}>
              <X size={18} />
            </button>
          </header>
          <div className="history-settings">
            <button
              className="secondary-button"
              role="switch"
              aria-checked={policy.enabled}
              disabled={pending}
              onClick={() => applyPolicy({ ...policy, enabled: !policy.enabled })}
            >
              {tr(policy.enabled ? "History enabled" : "History disabled")}
            </button>
            <label>
              {tr("Versions per file")}
              <NumberInput
                min={1}
                max={1000}
                step={1}
                value={policy.maxVersions}
                onCommit={(value) => applyPolicy({ ...policy, maxVersions: value })}
              />
            </label>
            <label>
              {tr("Retention days")}
              <NumberInput
                min={1}
                max={3650}
                step={1}
                value={policy.maxDays}
                onCommit={(value) => applyPolicy({ ...policy, maxDays: value })}
              />
            </label>
          </div>
          {(loading || reading) && (
            <p role="status" className="history-status">
              {tr("Loading comparison")}
            </p>
          )}
          <div className="history-content">
            <nav className="history-versions" aria-label={tr("Saved versions")}>
              {!loading && !entries.length && <p>{tr("No saved versions")}</p>}
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  className={entry.id === selected ? "active" : ""}
                  aria-current={entry.id === selected ? "true" : undefined}
                  disabled={pending}
                  onClick={() => {
                    setError("");
                    setSelected(entry.id);
                  }}
                >
                  {entry.kind === "auto-save" ? (
                    <Clock size={15} />
                  ) : entry.kind === "restore" ? (
                    <RotateCcw size={15} />
                  ) : (
                    <Save size={15} />
                  )}
                  <span>
                    {sourceLabel(entry.kind)}
                    <time dateTime={new Date(entry.createdAt).toISOString()}>
                      {new Date(entry.createdAt).toLocaleString(i18n.resolvedLanguage)}
                    </time>
                  </span>
                </button>
              ))}
            </nav>
            <section className="history-comparison" aria-label={tr("Historical and current content")}>
              {historical !== undefined && doc ? (
                <Suspense fallback={<p role="status">{tr("Loading comparison")}</p>}>
                  <HistoryDiff path={path} historical={historical} current={doc.text} />
                </Suspense>
              ) : (
                <p>{tr("Select a saved version")}</p>
              )}
            </section>
          </div>
          {error && (
            <p role="alert" className="home-error">
              {error}
            </p>
          )}
          <footer className="history-footer">
            <span>
              {tr(
                session.projectHistory.location === "folder"
                  ? "History in project folder"
                  : "History in browser storage",
              )}
            </span>
            <button
              className="secondary-button"
              disabled={pending || state.saving || !doc}
              onClick={() => run(() => session.projectHistory.capture(path, doc!.text, "manual-snapshot"))}
            >
              {tr("Create snapshot")}
            </button>
            {confirm && <span>{tr("Back up current content and restore this version?")}</span>}
            <button
              className="primary-button"
              disabled={pending || state.saving || !entry || historical === undefined || !doc}
              onClick={() => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                run(() => session.restoreHistory(path, entry!.id, doc!.revision));
              }}
            >
              {tr(confirm ? "Confirm restore" : "Restore version")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
