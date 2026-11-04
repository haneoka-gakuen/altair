import { useState, useSyncExternalStore } from "react";
import { FileWarning, Upload } from "lucide-react";
import type { EditorSession } from "../session";
import { useStudioI18n } from "../i18n";
import { TaskSheet } from "./TaskSheet";

export function ResourceRecovery({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { t } = useStudioI18n();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(""),
    [issue, setIssue] = useState("");
  const declared = state.project?.extensions["haneoka.authoring.missingFiles"];
  const missing = (Array.isArray(declared) ? declared : []).filter(
    (path): path is string => typeof path === "string" && !state.files.some((file) => file.path === path),
  );
  return (
    <>
      <button type="button" className="author-button" disabled={!missing.length} onClick={() => setOpen(true)}>
        <FileWarning aria-hidden />
        {t("Missing resources")}
        <span>{missing.length}</span>
      </button>
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
