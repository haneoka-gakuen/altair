import type { RefObject } from "react";
import type { StoryDiagnostic } from "@haneoka/altair";
import type { AltairStudioEmbeddedPreviewConfig } from "./preview-bridge";
import { StudioIcon } from "./StudioIcon";
import { useStudioI18n } from "./i18n";

export type StudioPreviewStatus = "connecting" | "connected" | "error";

export interface StudioPreviewPanelProps {
  readonly configuration?: AltairStudioEmbeddedPreviewConfig;
  readonly cursorLine: number;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly previewError: string;
  readonly pluginLockKey: string;
  readonly runtimeMountRef: RefObject<HTMLDivElement | null>;
  readonly runtimeBusy: boolean;
  readonly runtimeRevision: number;
  readonly sceneName: string;
  readonly sourceLineCount: number;
  readonly status: StudioPreviewStatus;
  readonly onConnect: () => void;
  readonly onCursorLine: (line: number) => void;
  readonly onPause: () => void;
  readonly onRefreshRuntime: () => void;
  readonly onRunCursor: () => void;
  readonly onRunScene: () => void;
  readonly onRunSnippet: () => void;
  readonly onStep: () => void;
}

export function StudioPreviewPanel({
  configuration,
  cursorLine,
  iframeRef,
  previewError,
  pluginLockKey,
  runtimeMountRef,
  runtimeBusy,
  runtimeRevision,
  sceneName,
  sourceLineCount,
  status,
  onConnect,
  onCursorLine,
  onPause,
  onRefreshRuntime,
  onRunCursor,
  onRunScene,
  onRunSnippet,
  onStep,
}: StudioPreviewPanelProps) {
  const { t } = useStudioI18n();
  const runtimeUnavailable = status !== "connected" || runtimeBusy;
  return (
    <section aria-labelledby="preview-heading" className="preview-panel">
      <h2 className="sr-only" id="preview-heading">
        {t("preview")}
      </h2>
      <div className="preview-toolbar">
        <span>Vega runtime</span>
        <small aria-live="polite" role="status">
          {status} · {sceneName}
        </small>
        <button
          aria-label={t("openRuntime")}
          disabled={!configuration}
          onClick={() => configuration && window.open(configuration.runtimeUrl, "_blank", "noopener,noreferrer")}
        >
          <StudioIcon name="external" />
        </button>
        <button aria-label={t("refreshRuntime")} onClick={onRefreshRuntime}>
          <StudioIcon name="refresh" />
        </button>
      </div>
      <div className="preview-stage">
        {configuration ? (
          <iframe
            allow="autoplay; fullscreen"
            key={`${runtimeRevision}:${pluginLockKey}`}
            onLoad={onConnect}
            ref={iframeRef}
            sandbox="allow-scripts allow-pointer-lock allow-same-origin"
            src={configuration.runtimeUrl}
            title="Vega runtime preview"
          />
        ) : (
          <div aria-label="Bundled Vega runtime" className="preview-runtime" ref={runtimeMountRef} />
        )}
        {previewError && (
          <div className="preview-error" role="alert">
            {previewError}
          </div>
        )}
      </div>
      <div className="preview-controls">
        <button disabled={runtimeUnavailable} onClick={onRunScene}>
          <StudioIcon name="play" /> {t("runScene")}
        </button>
        <button disabled={runtimeUnavailable} onClick={onRunCursor}>
          <StudioIcon name="play" /> {t("cursor")}
        </button>
        <button disabled={runtimeUnavailable} onClick={onRunSnippet}>
          {t("snippet")}
        </button>
        <button disabled={runtimeUnavailable} onClick={onPause}>
          <StudioIcon name="pause" /> {t("pause")}
        </button>
        <button disabled={runtimeUnavailable} onClick={onStep}>
          {t("step")}
        </button>
      </div>
      <div className="timeline">
        <button aria-label="Previous source line" onClick={() => onCursorLine(cursorLine - 1)}>
          <StudioIcon name="chevron-left" />
        </button>
        <input
          aria-label="Preview source line"
          max={sourceLineCount}
          min="1"
          onChange={(event) => onCursorLine(Number(event.target.value))}
          type="range"
          value={cursorLine}
        />
        <button aria-label="Next source line" onClick={() => onCursorLine(cursorLine + 1)}>
          <StudioIcon name="chevron-right" />
        </button>
      </div>
    </section>
  );
}
