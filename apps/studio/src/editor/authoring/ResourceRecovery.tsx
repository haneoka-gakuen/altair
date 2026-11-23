import { useState, useSyncExternalStore } from "react";
import { FileWarning, Upload } from "@haneoka/altair-ui-react";
import type { EditorSession } from "../session";
import { useStudioI18n } from "../i18n";
import { TaskSheet } from "./TaskSheet";

export function ResourceRecovery({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t, i18n } = useStudioI18n();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(""),
    [issue, setIssue] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const imported = state.project?.extensions["haneoka.authoring.importNotes"];
  const notes = Array.isArray(imported)
    ? imported.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const message = value[i18n.resolvedLanguage ?? "en"] ?? value.en;
        return typeof message === "string" ? [message] : [];
      })
    : [];
  const declared = state.project?.extensions["haneoka.authoring.missingFiles"];
  const missing = (Array.isArray(declared) ? declared : []).filter(
    (path): path is string => typeof path === "string" && !state.files.some((file) => file.path === path),
  );
  return (
    <>
      {missing.length > 0 && (
        <button type="button" className="author-button" onClick={() => setOpen(true)}>
          <FileWarning aria-hidden />
          {t("Missing resources")}
          <span>{missing.length}</span>
        </button>
      )}
      {notes.length > 0 && (
        <button type="button" className="author-button" onClick={() => setNotesOpen(true)}>
          {t("Import notes")} <span>{notes.length}</span>
        </button>
      )}
      {notesOpen && (
        <TaskSheet title={t("Import notes")} onClose={() => setNotesOpen(false)}>
          <ul>
            {[...new Set(notes)].map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </TaskSheet>
      )}
      {open && (
        <TaskSheet title={t("Missing resources")} onClose={() => setOpen(false)}>
          <div className="author-resource-recovery">
            {missing.map((path) => (
              <div className="author-resource-recovery-row" key={path}>
                <span>{path}</span>
                <label className="author-button">
                  <Upload aria-hidden />
                  {t("Upload resource")}
                  <input
                    type="file"
                    disabled={Boolean(pending)}
                    aria-label={`${t("Upload resource")}: ${path}`}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      setPending(path);
                      setIssue("");
                      void session
                        .addFile(path, file, { open: false })
                        .catch((error) => setIssue(error instanceof Error ? error.message : String(error)))
                        .finally(() => setPending(""));
                    }}
                  />
                </label>
              </div>
            ))}
            {!missing.length && <span role="status">{t("Resources complete")}</span>}
            {issue && <span role="alert">{issue}</span>}
          </div>
        </TaskSheet>
      )}
    </>
  );
}
