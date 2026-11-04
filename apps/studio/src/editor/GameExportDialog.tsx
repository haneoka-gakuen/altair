import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "@haneoka/altair-ui-react";
import { exportVegaGame } from "./game-export";
import { WebGalEngineDialog } from "./WebGalEngineDialog";
import type { EditorSession } from "./session";
import { tr } from "./i18n";
export function GameExportDialog({
  session,
  open,
  onOpenChange,
}: {
  session: EditorSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  const task = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => task.current?.abort(), [session]);
  const run = async () => {
    if (busy) return;
    const controller = new AbortController();
    task.current = controller;
    setBusy(true);
    setIssue("");
    try {
      await exportVegaGame(session, controller.signal);
      onOpenChange(false);
    } catch (error) {
      if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title>{tr("Export game")}</Dialog.Title>
          <div className="stack">
            <button className="primary-button" disabled={busy} onClick={() => void run()}>
              <Download size={18} />
              {tr("Export Vega game")}
            </button>
            <WebGalEngineDialog session={session} exportMode />
            {issue && <p role="alert">{issue}</p>}
          </div>
          <Dialog.Close className="modal-close" disabled={busy} aria-label={tr("Close")}>
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
