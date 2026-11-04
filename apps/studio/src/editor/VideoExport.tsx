import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Video, Square, X } from "@haneoka/altair-ui-react";
import { createFilesZip } from "./archive";
import type { StudioPreviewBridge } from "../preview-bridge";
import { downloadStudioFile } from "./studio-host";
import { tr } from "./i18n";

export function VideoExport({
  bridge,
  ready,
  onError,
}: {
  bridge: StudioPreviewBridge;
  ready: boolean;
  onError(error: unknown): void;
}) {
  const [open, setOpen] = useState(false),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false);
  const [height, setHeight] = useState(720),
    [fps, setFps] = useState(30);
  const start = async () => {
    setBusy(true);
    try {
      await bridge.seek(0);
      await bridge.startRecording(height, fps);
      setRecording(true);
      setOpen(false);
      await bridge.play();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      const { blob, subtitles } = await bridge.finishRecording();
      const videoName = `story-stage.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
      const files = [
        { path: videoName, blob },
        { path: "story-stage.srt", blob: new Blob([subtitles], { type: "application/x-subrip" }) },
      ];
      downloadStudioFile(await createFilesZip(files), "story-video.zip");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      setRecording(false);
    }
  };
  return (
    <>
      <button
        disabled={busy || (!ready && !recording)}
        title={tr(recording ? "Finish video export" : "Export stage video")}
        aria-label={tr(recording ? "Finish video export" : "Export stage video")}
        onClick={() => (recording ? void finish() : setOpen(true))}
      >
        {recording ? <Square size={14} /> : <Video size={14} />}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content video-export-dialog" aria-describedby={undefined}>
            <Dialog.Title>{tr("Export stage video")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={tr("Close")}>
              <X size={18} />
            </Dialog.Close>
            <label className="field">
              <span>{tr("Resolution")}</span>
              <select value={height} onChange={(event) => setHeight(Number(event.target.value))}>
                <option value={720}>1280 × 720</option>
                <option value={1080}>1920 × 1080</option>
              </select>
            </label>
            <label className="field">
              <span>{tr("Frame rate")}</span>
              <select value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                {[24, 30, 60].map((value) => (
                  <option key={value} value={value}>
                    {value} fps
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy} onClick={() => void start()}>
              {tr("Start recording")}
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
