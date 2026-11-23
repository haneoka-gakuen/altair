import type { CSSProperties, ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Play,
  Pause,
  RotateCcw,
  SlidersHorizontal,
  StepForward,
} from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";
import type { TimelineTransportState } from "./DockPanel";
import type { CastRef } from "./Manuscript";

export interface StageDockProps {
  stage: ReactNode;
  aspect: number;
  collapsed: boolean;
  playing: boolean;
  position: number;
  length: number;
  canPlay: boolean;
  speakers: CastRef[];
  activeTools?: ReactNode;
  stageMenu: ReactNode;
  panelOpen?: boolean;
  timelineTransport?: TimelineTransportState | null;
  onToggleCollapsed(): void;
  onTogglePanel?(): void;
  onFullscreen?(): void;
  onPlay(): void;
  onResume(): void;
  onRestart(): void;
  onSeek(index: number): void;
  onStop(): void;
}

export function StageDock({
  stage,
  aspect,
  collapsed,
  playing,
  position,
  length,
  canPlay,
  speakers,
  activeTools,
  stageMenu,
  panelOpen,
  timelineTransport,
  onToggleCollapsed,
  onTogglePanel,
  onFullscreen,
  onPlay,
  onResume,
  onRestart,
  onSeek,
  onStop,
}: StageDockProps) {
  const { t } = useStudioI18n();
  const hasTimelineTransport = Boolean(timelineTransport);
  return (
    <section
      className={collapsed ? "author-stage is-collapsed" : "author-stage"}
      aria-label={t("Stage")}
      style={{ "--author-stage-aspect": aspect } as CSSProperties}
    >
      <header className="author-monitor-header">
        <div className="author-monitor-heading">
          <h2 className="author-monitor-title">{t("Stage")}</h2>
          {speakers.length > 0 && (
            <ul className="author-stage-cast" aria-label={t("authoring.speakers")}>
              {speakers.map((speaker) => (
                <li key={speaker.castId} title={speaker.displayName}>
                  {speaker.avatar ? (
                    <img src={speaker.avatar} alt={speaker.displayName} width={28} height={28} loading="lazy" />
                  ) : (
                    <span aria-label={speaker.displayName}>{Array.from(speaker.displayName)[0]}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="author-monitor-actions">
          {activeTools}
          {onFullscreen && (
            <button
              type="button"
              className="author-icon-button"
              aria-label={t("Fullscreen preview")}
              title={t("Fullscreen preview")}
              onClick={onFullscreen}
            >
              <Maximize2 aria-hidden />
            </button>
          )}
          {onTogglePanel && (
            <button
              type="button"
              className="author-icon-button"
              aria-pressed={Boolean(panelOpen)}
              aria-label={t("Toggle properties")}
              title={t("Toggle properties")}
              onClick={onTogglePanel}
            >
              <SlidersHorizontal aria-hidden />
            </button>
          )}
          {stageMenu}
        </div>
      </header>
      <div className="author-monitor">
        <div className="author-stage-frame">{stage}</div>
      </div>
      <div className="author-stage-bar" data-transport={hasTimelineTransport ? "timeline" : "scene"}>
        <button
          type="button"
          className="author-icon-button author-button--filled"
          disabled={!canPlay}
          aria-label={t(playing ? "Pause" : "Play")}
          title={t(playing ? "Pause" : "Play")}
          onClick={() => {
            if (playing) onStop();
            else {
              timelineTransport?.clearSample();
              onResume();
            }
          }}
        >
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </button>
        {timelineTransport ? (
          <>
            <button
              type="button"
              className="author-icon-button"
              disabled={!timelineTransport.ready}
              aria-label={t("Previous frame")}
              title={t("Previous frame")}
              onClick={(event) => timelineTransport.stepFrame(-1, event.shiftKey ? 1 : undefined)}
            >
              <ChevronLeft aria-hidden />
            </button>
            <button
              type="button"
              className="author-icon-button"
              disabled={!timelineTransport.ready}
              aria-label={t("Next frame")}
              title={t("Next frame")}
              onClick={(event) => timelineTransport.stepFrame(1, event.shiftKey ? 1 : undefined)}
            >
              <ChevronRight aria-hidden />
            </button>
            <button
              type="button"
              className="author-icon-button author-stage-desktop-only"
              disabled={!timelineTransport.ready}
              onClick={() => timelineTransport.seekStart()}
              aria-label={t("Jump to start")}
              title={t("Jump to start")}
            >
              <RotateCcw aria-hidden />
            </button>
            <button
              type="button"
              className="author-icon-button author-stage-desktop-only"
              disabled={!canPlay}
              onClick={() => {
                timelineTransport.clearSample();
                onPlay();
              }}
              aria-label={t("Run from current statement")}
              title={t("Run from current statement")}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              <StepForward aria-hidden />
            </button>
            <output className="author-stage-timecode" aria-live="off">
              {timelineTransport.seconds.toFixed(2)} s / {timelineTransport.duration.toFixed(2)} s
            </output>
          </>
        ) : (
          <>
            <button
              type="button"
              className="author-icon-button author-stage-desktop-only"
              disabled={!canPlay}
              onClick={onRestart}
              aria-label={t("Run from the beginning")}
              title={t("Run from the beginning")}
            >
              <RotateCcw aria-hidden />
            </button>
            <button
              type="button"
              className="author-icon-button"
              disabled={!canPlay}
              onClick={onPlay}
              aria-label={t("Run from current statement")}
              title={t("Run from current statement")}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              <StepForward aria-hidden />
            </button>
            <label className="author-stage-position">
              <input
                type="range"
                min={0}
                max={Math.max(0, length - 1)}
                step={1}
                value={Math.min(position, Math.max(0, length - 1))}
                disabled={!canPlay}
                aria-label={t("Playback position")}
                onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
              />
              <output>{t("authoring.lineProgress", { current: length ? position + 1 : 0, total: length })}</output>
            </label>
          </>
        )}
        <div className="author-stage-phone-only">
          {stageMenu}
          <button
            type="button"
            className="author-icon-button author-stage-collapse"
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? "authoring.expandStage" : "authoring.collapseStage")}
            title={t(collapsed ? "authoring.expandStage" : "authoring.collapseStage")}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          </button>
        </div>
      </div>
    </section>
  );
}
