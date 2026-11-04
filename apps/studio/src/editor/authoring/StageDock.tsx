import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronUp, Play, Pause, RotateCcw, StepForward } from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";
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
  tools: ReactNode;
  onToggleCollapsed(): void;
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
  tools,
  onToggleCollapsed,
  onPlay,
  onResume,
  onRestart,
  onSeek,
  onStop,
}: StageDockProps) {
  const { t } = useStudioI18n();
  return (
    <section
      className={collapsed ? "author-stage is-collapsed" : "author-stage"}
      aria-label={t("Stage")}
      style={{ "--author-stage-aspect": aspect } as CSSProperties}
    >
      <div className="author-stage-frame">{stage}</div>
      <div className="author-stage-bar">
        <button
          type="button"
          className="author-icon-button author-button--filled"
          disabled={!canPlay}
          aria-label={t(playing ? "Pause" : "Play")}
          title={t(playing ? "Pause" : "Play")}
          onClick={playing ? onStop : onResume}
        >
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </button>
        <button
          type="button"
          className="author-icon-button"
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
        <ul className="author-stage-cast" aria-label={t("authoring.speakers")}>
          {speakers.map((speaker) => (
            <li key={speaker.castId} title={speaker.displayName}>
              {speaker.avatar ? (
                <img src={speaker.avatar} alt={speaker.displayName} width={32} height={32} loading="lazy" />
              ) : (
                <span aria-label={speaker.displayName}>{Array.from(speaker.displayName)[0]}</span>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="author-icon-button author-stage-collapse"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "authoring.expandStage" : "authoring.collapseStage")}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </button>
        <div className="author-stage-tools">{tools}</div>
      </div>
    </section>
  );
}
