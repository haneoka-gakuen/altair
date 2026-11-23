import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, Video, Square, X } from "@haneoka/altair-ui-react";
import { createFilesZip } from "./archive";
import type { StudioPreviewBridge } from "../preview-bridge";
import { downloadStudioFile } from "./studio-host";
import type { VegaPreviewBreakpoint } from "@haneoka/altair-preview-client";
import { ExportRouteEditor } from "./ExportRouteEditor";
import type { ExportRoute } from "./export-route";
import type { EditorSession } from "./session";
import { tr } from "./i18n";

const videoFormats = ["webm", "mp4", "mov", "gif", "apng", "wav"] as const;
const imageFormats = ["png", "webp", "jpeg"] as const;
type ExportFormat = (typeof videoFormats)[number] | (typeof imageFormats)[number];
const ratios = { "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "1:1": 1 } as const;
const sizes = [720, 1080, 2160];
function dimensions(size: number, ratio: number) {
  const even = (value: number) => Math.round(value / 2) * 2;
  return ratio >= 1 ? { width: even(size * ratio), height: size } : { width: size, height: even(size / ratio) };
}

export function VideoExport({
  bridge,
  session,
  restorePreview,
  ready,
  onError,
  hideIdleTrigger = false,
  openRef,
  onStateChange,
}: {
  bridge: StudioPreviewBridge;
  session: EditorSession;
  restorePreview(breakpoints?: readonly VegaPreviewBreakpoint[]): void;
  ready: boolean;
  onError(error: unknown): void;
  hideIdleTrigger?: boolean;
  openRef?: { current: (() => void) | null };
  onStateChange?: (state: { recording: boolean; replaying: boolean; disabled: boolean }) => void;
}) {
  const [open, setOpen] = useState(false),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false);
  const [size, setSize] = useState(720),
    [fps, setFps] = useState(30);
  const [ratio, setRatio] = useState<keyof typeof ratios>("16:9");
  const [transparentBackground, setTransparentBackground] = useState(false);
  const supportsAlpha = (value: ExportFormat) =>
    value === "webm" || value === "mov" || value === "gif" || value === "apng";
  const [burnSubtitles, setBurnSubtitles] = useState(false);
  const [issue, setIssue] = useState("");
  const report = (error: unknown) => {
    setIssue(tr(error instanceof Error ? error.message : String(error)));
    setOpen(true);
    onError(error);
  };
  const [format, setFormat] = useState<ExportFormat>("webm");
  const videoFormat = videoFormats.find((item) => item === format);
  const [frameByFrame, setFrameByFrame] = useState(true);
  const [route, setRoute] = useState<ExportRoute>();
  const [replaying, setReplaying] = useState(false);
  const temporaryPlayer = useRef(false);
  const originalBreakpoints = useRef<readonly VegaPreviewBreakpoint[] | undefined>(undefined);
  const archiveName = useRef("story-video.zip");
  const active = useRef<"record" | "preview" | "finishing" | undefined>(undefined);
  const task = useRef<AbortController | undefined>(undefined);
  const [progress, setProgress] = useState({ frame: 0, seconds: 0, phase: "render" as "render" | "mix" });
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const [output, setOutput] = useState<Blob>();
  const [subtitles, setSubtitles] = useState<Blob>();
  const restore = () => {
    if (!temporaryPlayer.current) return;
    temporaryPlayer.current = false;
    restorePreview(originalBreakpoints.current);
    originalBreakpoints.current = undefined;
  };
  const start = async (previewOnly = false) => {
    if (!videoFormat || !ready) return;
    setIssue("");
    setProgress({ frame: 0, seconds: 0, phase: "render" });
    setBusy(true);
    if (!previewOnly) {
      setOutput(undefined);
      setSubtitles(undefined);
    }
    try {
      if (route || frameByFrame) {
        const sceneId = session.getSnapshot().compilation?.sceneId;
        if (!sceneId) throw new Error(tr("Route scene is missing"));
        const compiled = await session.compileExportRoute(route ?? { id: "", name: "", sceneId, answers: {} });
        originalBreakpoints.current = bridge.configuredBreakpoints;
        await bridge.loadExportRoute(compiled.story, compiled.choices);
        temporaryPlayer.current = true;
        for (const [name, value] of Object.entries(route?.variables ?? {})) await bridge.setVariable(name, value);
        if (originalBreakpoints.current?.length) await bridge.setBreakpoints([]);
      } else await bridge.seek(0);
      if (!previewOnly) {
        await bridge.startRecording({
          ...dimensions(size, ratios[ratio]),
          fps,
          container: videoFormat,
          frameByFrame,
          transparentBackground: supportsAlpha(videoFormat) && transparentBackground,
          burnSubtitles: videoFormat !== "wav" && burnSubtitles,
        });
      }
      active.current = previewOnly ? "preview" : "record";
      task.current = new AbortController();
      unsubscribe.current = bridge.onEvent((event) => {
        if (event.event === "stage.recording.progress")
          setProgress({ frame: event.frame, seconds: event.seconds, phase: event.phase });
        if (event.event === "runtime.stopped" && event.reason === "end") void finish();
        if (event.event === "runtime.diagnostic" && event.level === "error" && event.code === "playback") {
          void finish(event.message);
        }
      });
      setRecording(!previewOnly);
      setReplaying(previewOnly);
      setOpen(!previewOnly);
      await bridge.play();
    } catch (error) {
      const mode = active.current;
      active.current = undefined;
      unsubscribe.current?.();
      unsubscribe.current = undefined;
      if (mode === "record") await bridge.releaseRecording().catch(() => {});
      setRecording(false);
      setReplaying(false);
      restore();
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const finish = useCallback(
    async (failure?: string) => {
      const mode = active.current;
      if (!mode || mode === "finishing") return;
      active.current = "finishing";
      const controller = task.current;
      setBusy(true);
      try {
        if (failure) {
          if (mode === "record") await bridge.releaseRecording();
          throw new Error(failure);
        }
        if (mode === "preview") {
          await bridge.pause();
          return;
        }
        const { blob, subtitles } = await bridge.finishRecording(controller?.signal);
        controller?.signal.throwIfAborted();
        const extension = blob.type.includes("wav")
          ? "wav"
          : blob.type.includes("mp4")
            ? "mp4"
            : blob.type.includes("quicktime")
              ? "mov"
              : blob.type.includes("apng")
                ? "apng"
                : blob.type === "image/gif"
                  ? "gif"
                  : "webm";
        const videoName = `story-stage.${extension}`;
        const subtitleFile = new Blob([subtitles], { type: "application/x-subrip" });
        const files = [
          { path: videoName, blob },
          { path: "story-stage.srt", blob: subtitleFile },
        ];
        const filename = route?.name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-");
        archiveName.current = filename ? filename + ".zip" : "story-video.zip";
        const archive = await createFilesZip(files);
        controller?.signal.throwIfAborted();
        setOutput(archive);
        setOpen(false);
        if (subtitles) setSubtitles(subtitleFile);
      } catch (error) {
        if (!controller?.signal.aborted) report(error);
      } finally {
        if (!controller?.signal.aborted) {
          active.current = undefined;
          task.current = undefined;
          unsubscribe.current?.();
          unsubscribe.current = undefined;
          setBusy(false);
          setRecording(false);
          setReplaying(false);
          restore();
        }
      }
    },
    [bridge, onError, restorePreview, route?.name],
  );
  const cancel = async () => {
    if (!active.current) return;
    active.current = undefined;
    task.current?.abort();
    task.current = undefined;
    unsubscribe.current?.();
    unsubscribe.current = undefined;
    setBusy(true);
    try {
      await bridge.releaseRecording();
      await bridge.pause();
      setOpen(false);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
      setRecording(false);
      restore();
    }
  };
  const captureFrame = async () => {
    if (
      format === "webm" ||
      format === "mp4" ||
      format === "mov" ||
      format === "gif" ||
      format === "apng" ||
      format === "wav"
    )
      return;
    setBusy(true);
    try {
      const source = await bridge.captureStage(undefined, { height: size, format: `image/${format}`, burnSubtitles });
      const response = await fetch(source);
      downloadStudioFile(await response.blob(), `story-frame.${format === "jpeg" ? "jpg" : format}`);
      setOpen(false);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  useEffect(
    () => () => {
      if (!active.current) return;
      const mode = active.current;
      active.current = undefined;
      unsubscribe.current?.();
      unsubscribe.current = undefined;
      task.current?.abort();
      if (mode !== "preview") void bridge.releaseRecording();
    },
    [bridge],
  );
  const triggerDisabled = (!recording && busy) || (!ready && !recording && !replaying);
  const triggerRef = useRef<() => void>(() => {});
  triggerRef.current = () => (replaying ? void finish() : setOpen(true));
  useEffect(() => {
    if (!openRef) return;
    openRef.current = () => triggerRef.current();
    return () => {
      openRef.current = null;
    };
  }, [openRef]);
  useEffect(() => {
    onStateChange?.({ recording, replaying, disabled: triggerDisabled });
  }, [onStateChange, recording, replaying, triggerDisabled]);
  return (
    <>
      {(!hideIdleTrigger || recording || replaying) && (
        <button
          disabled={triggerDisabled}
          title={tr(replaying ? "Stop route preview" : recording ? "Export progress" : "Export stage video")}
          aria-label={tr(replaying ? "Stop route preview" : recording ? "Export progress" : "Export stage video")}
          onClick={() => (replaying ? void finish() : setOpen(true))}
        >
          {recording || replaying ? <Square size={14} /> : <Video size={14} />}
        </button>
      )}
      {output && (
        <button
          type="button"
          title={tr("Download stage video")}
          aria-label={tr("Download stage video")}
          onClick={() => downloadStudioFile(output, archiveName.current)}
        >
          <Download size={14} />
        </button>
      )}
      {subtitles && (
        <button
          type="button"
          title={tr("Download subtitles")}
          aria-label={tr("Download subtitles")}
          onClick={() => downloadStudioFile(subtitles, "story-stage.srt")}
        >
          SRT
        </button>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content video-export-dialog" aria-describedby={undefined}>
            <Dialog.Title>{tr(recording ? "Export progress" : "Export stage video")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={tr("Close")}>
              <X size={18} />
            </Dialog.Close>
            {recording ? (
              <>
                <output className="export-route-progress" aria-live="off">
                  {progress.phase === "mix"
                    ? tr("Mixing audio")
                    : frameByFrame
                      ? tr("Frame {{frame}} · {{seconds}} s", {
                          frame: progress.frame,
                          seconds: progress.seconds.toFixed(1),
                        })
                      : tr("Recording")}
                </output>
                <div className="export-route-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || active.current === "finishing"}
                    onClick={() => void finish()}
                  >
                    {tr("Finish and save")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!active.current}
                    onClick={() => void cancel()}
                  >
                    {tr("Cancel export")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  <span>{tr("Export format")}</span>
                  <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
                    <option value="webm">WebM</option>
                    <option value="mp4">MP4</option>
                    <option value="mov">MOV</option>
                    <option value="gif">GIF</option>
                    <option value="apng">APNG</option>
                    <option value="wav">WAV</option>
                    {imageFormats.map((item) => (
                      <option key={item} value={item}>
                        {tr("Current frame")} · {item === "jpeg" ? "JPG" : item.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                {videoFormat && (
                  <>
                    <ExportRouteEditor
                      session={session}
                      route={route}
                      change={setRoute}
                      replay={() => void start(true)}
                      disabled={busy || !ready}
                      onError={report}
                    />
                    <label className="toggle-field">
                      <input
                        type="checkbox"
                        checked={frameByFrame}
                        onChange={(event) => setFrameByFrame(event.target.checked)}
                      />
                      <span>{tr("Frame-by-frame export")}</span>
                    </label>
                  </>
                )}
                {videoFormat && videoFormat !== "wav" && (
                  <label className="field">
                    <span>{tr("Aspect ratio")}</span>
                    <select value={ratio} onChange={(event) => setRatio(event.target.value as keyof typeof ratios)}>
                      {Object.keys(ratios).map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {videoFormat !== "wav" && (
                  <label className="field">
                    <span>{tr("Resolution")}</span>
                    <select value={size} onChange={(event) => setSize(Number(event.target.value))}>
                      {sizes.map((item) => {
                        const { width, height } = dimensions(item, ratios[ratio]);
                        return (
                          <option key={item} value={item}>
                            {videoFormat ? `${width} × ${height}` : `${item} px`}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}
                {videoFormat && videoFormat !== "wav" && (
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
                )}
                {supportsAlpha(format) && (
                  <label className="toggle-field">
                    <input
                      type="checkbox"
                      checked={transparentBackground}
                      onChange={(event) => setTransparentBackground(event.target.checked)}
                    />
                    <span>{tr("Transparent background")}</span>
                  </label>
                )}
                {videoFormat !== "wav" && (
                  <label className="toggle-field">
                    <input
                      type="checkbox"
                      checked={burnSubtitles}
                      onChange={(event) => setBurnSubtitles(event.target.checked)}
                    />
                    <span>{tr("Include subtitles")}</span>
                  </label>
                )}
                {issue && <div role="alert">{issue}</div>}
                <button
                  className="primary-button"
                  disabled={busy || !ready}
                  onClick={() => void (videoFormat ? start() : captureFrame())}
                >
                  {tr(videoFormat ? "Start recording" : "Capture frame")}
                </button>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
