import { AnogoPanel } from "./AnogoPanel";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Settings2, Sparkles, Check, X, Copy } from "@haneoka/altair-ui-react";
import { parseAltairProjectDocument } from "@haneoka/altair";
import type { EditorSession } from "../session";
import type { StudioBridge, StudioModel } from "../authoring/Manuscript";
import type { EditorAiDraft } from "../proposal";
import { NATIVE_PROJECT_PATH } from "../native-project";
import { projectLanguageOrder, projectLanguageLabel } from "../project-language";
import { tr, useStudioI18n } from "../i18n";
import { executeStudioAction } from "../studio-host";
import { completeAi } from "./client";
import { AI_TASKS, AiError, type AiProfile, type AiRoutes } from "./services";
import { readAiProfiles, readAiRoutes } from "./storage";
import { AI_SETTINGS_CHANGED, aiErrorText } from "./AiSettings";
import {
  AI_SYSTEM,
  AI_PLAN_SCHEMA,
  publicAiContext,
  buildAiContext,
  parseAiPlan,
  prepareAiPlan,
  type AiPlan,
  type AiContext,
  type AiOperationReview,
} from "./plan";
import "./ai.css";

export function AiAssistant({
  session,
  model,
  bridge,
}: {
  session: EditorSession;
  model: StudioModel;
  bridge: StudioBridge;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { i18n } = useStudioI18n();
  const draft: EditorAiDraft = state.aiDraft ?? {
    prompt: "",
    response: "",
    task: "edit",
    scope: state.authoringSelection?.lines.length ? "selection" : "scene",
    targetLocale: "en",
  };
  const [profiles, setProfiles] = useState<AiProfile[]>([]),
    [routes, setRoutes] = useState<AiRoutes>({});
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [status, setStatus] = useState("");
  const [reviews, setReviews] = useState<AiOperationReview[]>([]);
  const controller = useRef<AbortController | undefined>(undefined);
  const stored = state.proposals?.find((proposal) => proposal.origin === "ai");
  const data = stored?.data as { plan: AiPlan; context: AiContext; selected: string[] } | undefined;
  const current = stored ? session.proposalCurrent(stored) : false;
  useEffect(() => {
    const refresh = () => {
      void Promise.all([readAiProfiles(), readAiRoutes()])
        .then(([items, routing]) => {
          setProfiles(items);
          setRoutes(routing);
        })
        .catch((error) => setIssue(aiErrorText(error)));
    };
    refresh();
    window.addEventListener(AI_SETTINGS_CHANGED, refresh);
    return () => {
      window.removeEventListener(AI_SETTINGS_CHANGED, refresh);
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!data || !current) return;
    try {
      setReviews(prepareAiPlan(session, data.context, data.plan, new Set(data.selected)).reviews);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : tr("ai.invalidPlan"));
    }
  }, [stored?.id, stored?.data, current, session]);
  const update = (values: Partial<EditorAiDraft>) => session.setAiDraft({ ...draft, ...values });
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setIssue("");
    setStatus("");
    try {
      await action(operation.signal);
    } catch (error) {
      setIssue(
        error instanceof AiError ? aiErrorText(error) : error instanceof Error ? error.message : tr("ai.invalidPlan"),
      );
    } finally {
      if (controller.current === operation) {
        controller.current = undefined;
        setBusy(false);
      }
    }
  };
  const stage = async (context: AiContext, text: string) => {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const plan = parseAiPlan(text, context, `ai-${hash}`),
      result = prepareAiPlan(session, context, plan, new Set(plan.operations.map((operation) => operation.id)));
    setReviews(result.reviews);
    await session.stageProposal(result.proposal);
  };
  const generate = () =>
    run(async (signal) => {
      const route = routes[draft.task],
        profile = profiles.find((profile) => profile.id === route?.profileId);
      if (!profile || !(route?.model || profile.model)) throw new AiError({ code: "model" });
      const context = await buildAiContext(session, model, bridge, draft.scope, draft.task, draft.targetLocale, signal);
      let image: string | undefined;
      if (draft.task === "vision") {
        if (profile.models?.find((model) => model.id === (route?.model || profile.model))?.vision === false)
          throw new Error(tr("ai.visionModelRequired"));
        const id =
          state.authoringSelection?.cursor ??
          model.scenes.find((scene) => scene.id === model.activeSceneId)?.lines[0]?.id;
        if (!id) throw new Error(tr("ai.emptyScope"));
        image = await session.captureFrame(id, signal);
      }
      const text = await completeAi(
        profile,
        {
          system: AI_SYSTEM,
          prompt: JSON.stringify({ task: draft.task, instructions: draft.prompt, context: publicAiContext(context) }),
          schema: AI_PLAN_SCHEMA,
          image,
          model: route?.model,
        },
        signal,
      );
      signal.throwIfAborted();
      update({ response: text });
      await stage(context, text);
    });
  const analyze = () =>
    run(async (signal) => {
      const context = await buildAiContext(session, model, bridge, draft.scope, draft.task, draft.targetLocale, signal);
      await stage(context, draft.response);
    });
  const select = (ids: string[]) =>
    run(async () => {
      if (!data) return;
      const result = prepareAiPlan(session, data.context, data.plan, new Set(ids));
      setReviews(result.reviews);
      await session.stageProposal(result.proposal);
    });
  const manifest = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)!.text);
  const route = routes[draft.task],
    provider = profiles.find((profile) => profile.id === route?.profileId);
  return (
    <div className="ai-assistant">
      <div className="ai-button-row">
        <div className="ai-service-title">
          <strong>{provider?.name ?? tr("ai.notAssigned")}</strong>{" "}
          <span className="ai-status" role="status">
            {issue || status || (busy ? tr("Loading") : stored && !current ? tr("ai.proposalExpired") : "")}
          </span>
        </div>
        <button
          className="icon-button"
          aria-label={tr("ai.services")}
          onClick={() => void executeStudioAction("ai-settings")}
        >
          <Settings2 size={20} />
        </button>
      </div>
      <details className="argument-section ai-request" open={!stored}>
        <summary>{tr("ai.request")}</summary>
        <label className="field">
          <span>{tr("ai.task")}</span>
          <select
            value={draft.task}
            onChange={(event) => update({ task: event.target.value as EditorAiDraft["task"] })}
            disabled={busy}
          >
            {AI_TASKS.map((task) => (
              <option key={task} value={task}>
                {tr(`ai.task.${task}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{tr("ai.scope")}</span>
          <select
            value={draft.scope}
            onChange={(event) => update({ scope: event.target.value as EditorAiDraft["scope"] })}
            disabled={busy}
          >
            {["selection", "scene", "project"].map((scope) => (
              <option key={scope} value={scope}>
                {tr(`ai.scope.${scope}`)}
              </option>
            ))}
          </select>
        </label>
        {draft.task === "translate" && (
          <label className="field">
            <span>{tr("ai.targetLanguage")}</span>
            <select
              value={draft.targetLocale}
              disabled={busy}
              onChange={(event) => update({ targetLocale: event.target.value })}
            >
              {[...new Set([...projectLanguageOrder(i18n.resolvedLanguage), ...manifest.locales])].map((locale) => (
                <option key={locale} value={locale}>
                  {projectLanguageLabel(manifest, locale, i18n.resolvedLanguage)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{tr("ai.instructions")}</span>
          <textarea value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} disabled={busy} />
        </label>
        <div className="ai-button-row">
          <button
            className="primary-button"
            disabled={busy || !draft.prompt.trim() || !provider}
            onClick={() => void generate()}
          >
            <Sparkles size={20} />
            {tr("ai.generate")}
          </button>
          {busy && <button onClick={() => controller.current?.abort()}>{tr("Cancel")}</button>}
          <button
            className="icon-button"
            aria-label={tr("ai.copyContext")}
            disabled={busy}
            onClick={() =>
              void run(async (signal) => {
                const context = await buildAiContext(
                  session,
                  model,
                  bridge,
                  draft.scope,
                  draft.task,
                  draft.targetLocale,
                  signal,
                );
                await navigator.clipboard.writeText(
                  AI_SYSTEM +
                    "\n" +
                    JSON.stringify(
                      { instructions: draft.prompt, context: publicAiContext(context), schema: AI_PLAN_SCHEMA },
                      null,
                      2,
                    ),
                );
                setStatus(tr("ai.copied"));
              })
            }
          >
            <Copy size={20} />
          </button>
        </div>
        <details className="argument-section">
          <summary>{tr("ai.anogoImport")}</summary>
          <AnogoPanel session={session} model={model} bridge={bridge} />
        </details>
        <details className="argument-section">
          <summary>{tr("ai.pasteProposal")}</summary>
          <label className="field">
            <span>JSON</span>
            <textarea
              value={draft.response}
              onChange={(event) => update({ response: event.target.value })}
              maxLength={2_000_000}
              disabled={busy}
            />
          </label>
          <button className="secondary-button" disabled={busy || !draft.response.trim()} onClick={() => void analyze()}>
            {tr("ai.reviewProposal")}
          </button>
        </details>
      </details>

      {stored && (
        <section className="ai-section">
          {(state.proposals?.filter((item) => item.origin === "ai").length ?? 0) > 1 && (
            <label className="field">
              <span>{tr("ai.proposals")}</span>
              <select value={stored.id} onChange={(event) => session.selectProposal(event.target.value)}>
                {state.proposals
                  ?.filter((item) => item.origin === "ai")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <h3>{stored.title}</h3>
          {!current && data && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const context = await buildAiContext(
                    session,
                    model,
                    bridge,
                    data.context.scope,
                    data.context.task,
                    data.context.targetLocale,
                    signal,
                    data.context,
                  );
                  const result = prepareAiPlan(session, context, data.plan, new Set(data.selected));
                  setReviews(result.reviews);
                  await session.stageProposal(result.proposal);
                })
              }
            >
              {tr("ai.replay")}
            </button>
          )}
          <div className="ai-button-row">
            <button
              disabled={!current || !!stored.issues?.length}
              aria-pressed={state.previewProposalId === stored.id}
              onClick={() => session.previewProposal(state.previewProposalId === stored.id ? undefined : stored.id)}
            >
              {tr(state.previewProposalId === stored.id ? "ai.currentVersion" : "ai.previewVersion")}
            </button>
            <button
              className="primary-button"
              disabled={busy || !current || !!stored.issues?.length || !stored.changes.length}
              onClick={() =>
                void run(async () => {
                  await session.acceptProposal(stored.id);
                  setStatus(tr("ai.applied"));
                })
              }
            >
              <Check size={20} />
              {tr("ai.apply")}
            </button>
            <button disabled={busy} onClick={() => void run(async () => session.discardProposal(stored.id))}>
              <X size={20} />
              {tr("ai.discard")}
            </button>
          </div>
          {reviews.map(({ operation, before, after, error }) => (
            <div key={operation.id} className="ai-operation">
              <label>
                <input
                  type="checkbox"
                  checked={!!data?.selected.includes(operation.id)}
                  disabled={busy || !current}
                  onChange={(event) =>
                    void select(
                      event.target.checked
                        ? [...(data?.selected ?? []), operation.id]
                        : (data?.selected.filter((id) => id !== operation.id) ?? []),
                    )
                  }
                />
                <strong>{tr(`ai.operation.${operation.kind}`)}</strong>
              </label>
              <button className="secondary-button" onClick={() => bridge.seek(operation.sceneId, operation.nodeId)}>
                {model.scenes.find((scene) => scene.id === operation.sceneId)?.title ?? operation.sceneId}
              </button>
              <pre>
                <del>{before}</del>
              </pre>
              <pre>
                <ins>{after}</ins>
              </pre>
              {error && <span role="alert">{error}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
