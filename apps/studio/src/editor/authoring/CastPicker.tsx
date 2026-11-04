import { useEffect, useState } from "react";
import { Plus, Search, UserRound } from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";
import type { CastOption, CastOptionGroup, CastRef, StudioBridge, StudioChange, StudioLine } from "./Manuscript";

export type CastPickerTab = "character" | CastOptionGroup;

export interface CastPickerProps {
  bridge: StudioBridge;
  sceneId: string;
  cast: CastRef[];
  castId: string | null;
  lines: StudioLine[];
  initialTab: CastPickerTab;
  onApply(change: StudioChange): void;
  onAdd?(): void;
}

const GROUP_LABEL: Record<CastPickerTab, string> = {
  character: "Character",
  costume: "command.Costume",
  motion: "Motion",
  face: "Expression",
};

interface OptionsState {
  key: string;
  status: "loading" | "ready" | "failed";
  options: CastOption[];
}

export function CastPicker({
  bridge,
  sceneId,
  cast,
  castId: initialCastId,
  lines,
  initialTab,
  onApply,
  onAdd,
}: CastPickerProps) {
  const { t } = useStudioI18n();
  const [castId, setCastId] = useState(initialCastId);
  const [tab, setTab] = useState<CastPickerTab>(initialCastId ? initialTab : "character");
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<OptionsState>({ key: "", status: "loading", options: [] });
  const lineIds = lines.map((line) => line.id);
  const lineKey = lineIds.join("\n");
  const key = [sceneId, castId, tab, query.trim(), lineKey].join("\u0000");
  const speakers = lines[0]?.speakers.map((speaker) => speaker.castId) ?? [];

  useEffect(() => {
    if (!castId || tab === "character") return;
    const controller = new AbortController();
    setState((previous) => ({ key, status: "loading", options: previous.key === key ? previous.options : [] }));
    const timer = window.setTimeout(
      () => {
        bridge
          .options({ sceneId, castId, group: tab, query: query.trim(), lines: lineKey.split("\n") }, controller.signal)
          .then(
            (options) => {
              if (!controller.signal.aborted) setState({ key, status: "ready", options });
            },
            () => {
              if (!controller.signal.aborted) setState({ key, status: "failed", options: [] });
            },
          );
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [bridge, sceneId, castId, tab, query, lineKey, key, reload]);

  const toggleSpeaker = (id: string) => {
    const next = speakers.includes(id) ? speakers.filter((speaker) => speaker !== id) : [...speakers, id];
    onApply({ kind: "speakers", speakers: next });
    if (next.includes(id)) setCastId(id);
  };

  const tabs: CastPickerTab[] = castId ? ["character", "costume", "motion", "face"] : ["character"];
  const current = state.key === key ? state : null;

  return (
    <div className="author-picker">
      <div className="author-segmented" role="tablist">
        {tabs.map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {t(GROUP_LABEL[value])}
          </button>
        ))}
      </div>

      {tab === "character" ? (
        <div className="author-picker-grid" role="group" aria-label={t("authoring.speakers")}>
          <button
            type="button"
            className="author-picker-option"
            aria-pressed={speakers.length === 0}
            onClick={() => onApply({ kind: "speakers", speakers: [] })}
          >
            <span className="author-picker-thumb" aria-hidden>
              <UserRound />
            </span>
            <span className="author-picker-label">{t("Narration")}</span>
          </button>
          {cast.map((member) => (
            <button
              key={member.castId}
              type="button"
              className="author-picker-option"
              aria-pressed={speakers.includes(member.castId)}
              onClick={() => toggleSpeaker(member.castId)}
            >
              <span className="author-picker-thumb">
                {member.avatar ? (
                  <img src={member.avatar} alt="" width={96} height={96} loading="lazy" />
                ) : (
                  <UserRound aria-hidden />
                )}
              </span>
              <span className="author-picker-label">{member.displayName}</span>
            </button>
          ))}
          {onAdd && (
            <button type="button" className="author-picker-option" onClick={onAdd}>
              <span className="author-picker-thumb">
                <Plus aria-hidden />
              </span>
              <span className="author-picker-label">{t("Assets")}</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <label className="author-search">
            <Search aria-hidden />
            <input
              type="search"
              value={query}
              placeholder={t("authoring.searchAssets")}
              aria-label={t("authoring.searchAssets")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {current?.status === "failed" ? (
            <p className="author-picker-state">
              {t("authoring.optionsFailed")}
              <button type="button" className="author-button" onClick={() => setReload((value) => value + 1)}>
                {t("authoring.retry")}
              </button>
            </p>
          ) : current && current.options.length > 0 ? (
            <div
              className="author-picker-grid"
              role="group"
              aria-label={t(GROUP_LABEL[tab])}
              aria-busy={current.status === "loading"}
            >
              {current.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="author-picker-option"
                  aria-pressed={option.selected === true}
                  onClick={() => {
                    onApply({ kind: "cast-option", castId: castId!, group: option.group, optionId: option.id });
                    setReload((value) => value + 1);
                  }}
                >
                  <span className="author-picker-thumb">
                    {option.thumb ? <img src={option.thumb} alt="" width={96} height={96} loading="lazy" /> : null}
                  </span>
                  <span className="author-picker-label">{option.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="author-picker-state" role="status">
              {t(current?.status === "ready" ? "authoring.noOptions" : "Loading")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
