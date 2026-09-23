import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Upload, Trash2, X, Boxes } from "lucide-react";
import { tr, useStudioI18n } from "./i18n";
import { runtimeLibraries, RUNTIME_LIBRARIES, type RuntimeLibrary, type RuntimeLibraryId } from "./runtimes";
export function RuntimeSettings() {
  useStudioI18n();
  const [open, setOpen] = useState(false),
    [libraries, setLibraries] = useState<RuntimeLibrary[]>([]),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void runtimeLibraries
      .list()
      .then((value) => {
        if (!disposed) setLibraries(value);
      })
      .catch((error) => {
        if (!disposed) setIssue(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [open]);
  const change = async (id: RuntimeLibraryId, file?: File) => {
    setBusy(true);
    setIssue("");
    try {
      if (file) await runtimeLibraries.install(id, file);
      else await runtimeLibraries.remove(id);
      setLibraries(await runtimeLibraries.list());
      setChanged(true);
    } catch (error) {
      setIssue(error instanceof Error ? tr(error.message) : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="secondary-button">
          <Boxes size={15} />
          {tr("Model runtimes")}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content runtime-settings">
          <Dialog.Title>{tr("Model runtimes")}</Dialog.Title>
          <Dialog.Description>
            {tr("Runtime libraries used by model previews on this device. Projects keep their own model files.")}
          </Dialog.Description>
          <div className="runtime-libraries">
            {RUNTIME_LIBRARIES.map((definition) => {
              const installed = libraries.find((library) => library.id === definition.id);
              return (
                <div className="runtime-library" key={definition.id}>
                  <div>
                    <strong>{definition.label}</strong>
                    <p>{installed?.name ?? tr("Use application runtime")}</p>
                  </div>
                  <label className="secondary-button runtime-import">
                    <Upload size={14} />
                    {tr("Import runtime")}
                    <input
                      type="file"
                      accept=".js,text/javascript,application/javascript"
                      aria-label={`${tr("Import runtime")} · ${definition.label}`}
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void change(definition.id, file);
                      }}
                    />
                  </label>
                  {installed && (
                    <button
                      className="icon-button"
                      aria-label={`${tr("Remove runtime")} · ${definition.label}`}
                      disabled={busy}
                      onClick={() => void change(definition.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {changed && (
            <p role="status">
              {tr(
                "Refresh the preview to use an imported runtime. If a different version is already running, reopen the editor.",
              )}
            </p>
          )}
          {issue && (
            <p className="home-error" role="alert">
              {issue}
            </p>
          )}
          <Dialog.Close className="modal-close" aria-label={tr("Close")}>
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
