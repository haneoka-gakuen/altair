import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { EditorSession } from "../session";
import type { StudioBridge, StudioModel, CastOption } from "../authoring/Manuscript";
import { tr } from "../i18n";
import {
  parseAnogo,
  defaultAnogoBindings,
  anogoActionKey,
  anogoResources,
  prepareAnogo,
  type AnogoBindings,
  type AnogoRow,
} from "./anogo";

export function AnogoPanel({
  session,
  model,
  bridge,
}: {
  session: EditorSession;
  model: StudioModel;
  bridge: StudioBridge;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const draft = state.aiDraft?.anogo ?? { source: "", parsed: "", bindings: undefined, placement: "after" as const };
  const update = (values: Partial<typeof draft>) =>
    session.setAiDraft({
      prompt: "",
      response: "",
      task: "edit",
      scope: "scene",
      targetLocale: "en",
      ...state.aiDraft,
      anogo: { ...draft, ...values },
    });
  const rows = useMemo(() => {
    try {
      return draft.parsed ? parseAnogo(draft.parsed) : [];
    } catch {
      return [];
    }
  }, [draft.parsed]);
  const [issue, setIssue] = useState(""),
    [busy, setBusy] = useState(false),
    [choices, setChoices] = useState<Record<string, CastOption[]>>({});
  const bindings = draft.bindings;
  const resources = useMemo(() => anogoResources(session), [state.contentVersion, session]);
  const backgrounds = [
    ...new Set(
      rows
        .filter((row): row is Extract<AnogoRow, { kind: "background" }> => row.kind === "background")
        .map((row) => row.value),
    ),
  ];
  const speakers = [
    ...new Set(
      rows
        .filter((row): row is Extract<AnogoRow, { kind: "dialogue" }> => row.kind === "dialogue")
        .map((row) => row.speaker),
    ),
  ];
  const actions = [
    ...new Map(
      rows
        .filter((row): row is Extract<AnogoRow, { kind: "dialogue" }> => row.kind === "dialogue" && !!row.action.trim())
        .map((row) => [anogoActionKey(row.speaker, row.action), row]),
    ).values(),
  ];
  const sceneId = state.authoringSelection?.sceneId ?? model.activeSceneId;
  useEffect(() => {
    const controller = new AbortController();
    const ids = [
      ...new Set(speakers.map((name) => bindings?.speakers[name]).filter((id): id is string => !!id && id !== "@text")),
    ];
    void Promise.all(
      ids.flatMap((id) =>
        ["motion", "face"].map(
          async (group) =>
            [
              id,
              group,
              await bridge.options(
                {
                  sceneId,
                  castId: id,
                  group: group as "motion" | "face",
                  lines: [...(state.authoringSelection?.lines ?? [])],
                  query: "",
                },
                controller.signal,
              ),
            ] as const,
        ),
      ),
    )
      .then((entries) => {
        if (!controller.signal.aborted)
          setChoices(Object.fromEntries(entries.map(([id, group, values]) => [`${id}:${group}`, [...values]])));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : tr("ai.resourceMissing"));
      });
    return () => controller.abort();
  }, [bridge, sceneId, JSON.stringify(bindings?.speakers)]);
  const bind = (field: "backgrounds" | "speakers" | "actions", name: string, value: string) => {
    if (!bindings) return;
    update({ bindings: { ...bindings, [field]: { ...bindings[field], [name]: value } } });
    setIssue("");
  };
  const analyze = () => {
    try {
      const rows = parseAnogo(draft.source);
      if (!rows.length) throw new Error(tr("ai.emptyScope"));
      const defaults = defaultAnogoBindings(rows, model),
        previous = bindings;
      const next: AnogoBindings = {
        backgrounds: { ...defaults.backgrounds, ...previous?.backgrounds },
        speakers: { ...defaults.speakers, ...previous?.speakers },
        actions: { ...defaults.actions, ...previous?.actions },
        roleIds: { ...defaults.roleIds, ...previous?.roleIds },
      };
      for (const row of rows)
        if (row.kind === "background" && resources.backgrounds.includes(row.value))
          next.backgrounds[row.value] = row.value;
      update({ parsed: draft.source, bindings: next });
      setIssue("");
    } catch (error) {
      setIssue(error instanceof Error ? error.message : tr("ai.anogoInvalid"));
    }
  };
  const review = async () => {
    if (!bindings || draft.source !== draft.parsed) return;
    setBusy(true);
    setIssue("");
    try {
      for (const row of actions) {
        const value = bindings.actions[anogoActionKey(row.speaker, row.action)];
        if (!value || value === "@none") continue;
        const chosen = JSON.parse(value) as { motion: string; expression: string };
        for (const [field, group] of [
          ["motion", "motion"],
          ["expression", "face"],
        ] as const)
          if (
            chosen[field] &&
            !choices[`${bindings.speakers[row.speaker]}:${group}`]?.some((option) => option.id === chosen[field])
          )
            throw new Error(tr("ai.resourceMissing"));
      }
      const signature = JSON.stringify({
        source: draft.source,
        bindings,
        placement: draft.placement,
        sceneId,
        cursor: state.authoringSelection?.cursor,
      });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature)))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      await session.stageProposal(
        prepareAnogo(session, model, draft.source, rows, bindings, draft.placement, `anogo-${hash}`),
      );
    } catch (error) {
      setIssue(error instanceof Error ? error.message : tr("ai.anogoInvalid"));
    } finally {
      setBusy(false);
    }
  };
  const proposal = state.proposals?.find((proposal) => proposal.origin === "prose");
  return (
    <div className="ai-section">
      <details className="argument-section ai-request" open={!proposal}>
        <summary>{tr("ai.parseBindings")}</summary>
        <label className="field">
          <span>{tr("ai.anogoSource")}</span>
          <textarea
            value={draft.source}
            onChange={(event) => update({ source: event.target.value })}
            maxLength={2_000_000}
            disabled={busy}
          />
        </label>
        <button className="secondary-button" onClick={analyze} disabled={busy || !draft.source.trim()}>
          {tr("ai.parseBindings")}
        </button>
        {rows.length > 0 && bindings && (
          <>
            <label className="field">
              <span>{tr("ai.insertPosition")}</span>
              <select
                value={draft.placement}
                disabled={busy}
                onChange={(event) => update({ placement: event.target.value as typeof draft.placement })}
              >
                {["after", "end", "replace"].map((value) => (
                  <option key={value} value={value}>
                    {tr(`ai.insert.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            {backgrounds.map((name) => (
              <label className="field" key={name}>
                <span>
                  {tr("Background")} / {name}
                </span>
                <select
                  value={Object.hasOwn(bindings.backgrounds, name) ? bindings.backgrounds[name] : ""}
                  onChange={(event) => bind("backgrounds", name, event.target.value)}
                  disabled={busy}
                >
                  <option value="">{tr("ai.notAssigned")}</option>
                  <option value="none">{tr("Clear")}</option>
                  {resources.backgrounds.map((path) => (
                    <option key={path} value={path}>
                      {path.split("/").at(-1) || path}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {speakers.map((name) => (
              <label className="field" key={name}>
                <span>
                  {tr("Character")} / {name}
                </span>
                <select
                  value={bindings.speakers[name]}
                  onChange={(event) => bind("speakers", name, event.target.value)}
                  disabled={busy}
                >
                  <option value="@text">{tr("ai.textRole")}</option>
                  {model.cast.map((member) => (
                    <option key={member.castId} value={member.castId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {actions.map((row) => {
              const id = bindings.speakers[row.speaker],
                key = anogoActionKey(row.speaker, row.action),
                binding = bindings.actions[key];
              const value =
                binding && binding !== "@none"
                  ? (JSON.parse(binding) as { motion: string; expression: string })
                  : { motion: "", expression: "" };
              return (
                <section className="ai-section" key={key}>
                  <strong>
                    {row.speaker} / {row.action}
                  </strong>
                  {(
                    [
                      ["motion", "motion", "Motion"],
                      ["expression", "face", "Expression"],
                    ] as const
                  ).map(([field, group, label]) => (
                    <label className="field" key={field}>
                      <span>{tr(label)}</span>
                      <select
                        value={binding ? value[field] : "@unbound"}
                        onChange={(event) =>
                          bind(
                            "actions",
                            key,
                            JSON.stringify({
                              ...value,
                              [field]: event.target.value === "@unbound" ? "" : event.target.value,
                            }),
                          )
                        }
                        disabled={busy}
                      >
                        <option value="@unbound">{tr("ai.notAssigned")}</option>
                        <option value="">{tr("ai.noAction")}</option>
                        {choices[`${id}:${group}`]?.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </section>
              );
            })}
            <button
              className="primary-button"
              disabled={busy || draft.source !== draft.parsed}
              onClick={() => void review()}
            >
              {tr("ai.reviewProposal")}
            </button>
          </>
        )}
        <span className="ai-status" role="status">
          {issue || (draft.parsed && draft.source !== draft.parsed ? tr("ai.reparse") : "")}
        </span>
      </details>
      {proposal && (
        <section className="ai-section">
          <h3>{proposal.title}</h3>
          <span>{proposal.detail}</span>
          <div className="ai-button-row">
            <button
              disabled={!session.proposalCurrent(proposal)}
              onClick={() => session.previewProposal(state.previewProposalId === proposal.id ? undefined : proposal.id)}
            >
              {tr(state.previewProposalId === proposal.id ? "ai.currentVersion" : "ai.previewVersion")}
            </button>
            <button
              className="primary-button"
              disabled={busy || !session.proposalCurrent(proposal)}
              onClick={() => void session.acceptProposal(proposal.id).catch((error) => setIssue(String(error)))}
            >
              {tr("ai.apply")}
            </button>
            <button disabled={busy} onClick={() => void session.discardProposal(proposal.id)}>
              {tr("ai.discard")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
