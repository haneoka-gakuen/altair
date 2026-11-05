import {
  planProtectedShots,
  replaceProjectShot,
  shotProposalChange,
  cameraLocked,
  type ProjectShotProposal,
} from "./cinematic";
import "./storyboard-editor.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Check, Lock, Plus, Trash2, Unlock } from "@haneoka/altair-ui-react";
import {
  parseAltairSceneDocument,
  serializeAltairDocument,
  authoredNodeLines,
  type AltairAuthoredNode,
  type JsonObject,
  type JsonValue,
} from "@haneoka/altair";
import { commandDescriptor } from "@haneoka/altair-plugin-adv/commands";
import { storyProjectToAuthoredWorkspace } from "@haneoka/altair-plugin-adv/documents";
import { webGalCommandToAuthoredNode } from "@haneoka/altair-plugin-webgal";
import {
  storyShotsOutsideRange,
  prepareStoryPresentation,
  sceneStoryboard,
  storyCommandAtoms,
  validateStoryboard,
  isStoryCameraCommand,
  STORYBOARD_KEY,
  type StoryShot,
  type StoryIntent,
} from "@haneoka/altair-plugin-vega-preview/projection";
import { VEGA_ADV_OPCODE } from "@haneoka/vega-protocol";
import { NativeInspector } from "./NativeInspector";
import { NumberInput } from "@haneoka/altair-ui-react";
import { nativeStatements, nativeNodeLabel, nativeNodeExcerpt, nativeScenePath } from "./native-project";
import { tr } from "./i18n";
import type { EditorSession } from "./session";
import { readLocalizedText } from "./localized-text";
const record = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

interface ShotProposal {
  source: { path: string; text: string };
  sceneId: string;
  extensions: JsonObject;
  shots: readonly StoryShot[];
}
function AutoPlan({ request, ready, run }: { request?: string; ready: boolean; run(): void }) {
  const consumed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (request && ready && consumed.current !== request) {
      consumed.current = request;
      run();
    }
  }, [request, ready, run]);
  return null;
}
export function StoryboardEditor({
  session,
  scope,
  autoPlanRequest,
}: {
  session: EditorSession;
  scope?: readonly string[];
  autoPlanRequest?: string;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [intent, setIntent] = useState<StoryIntent>("dialogue"),
    [range, setRange] = useState({ start: "", end: "" });
  const [thumbnails, setThumbnails] = useState<Record<string, { revision: unknown; image: string }>>({}),
    [captureError, setCaptureError] = useState("");
  const [expandedShot, setExpandedShot] = useState<string>();
  const stored = state.proposals?.find((proposal) => proposal.origin === "storyboard");
  const data = stored?.data as ShotProposal | ProjectShotProposal | undefined;
  const proposal = data && "kind" in data ? data.scenes.find((scene) => scene.source.path === state.active) : data;
  const previewProposal = !!stored && state.previewProposalId === stored.id;
  const setPreviewProposal = (preview: boolean) => session.previewProposal(preview ? stored?.id : undefined);
  const setProposal = (value?: ShotProposal, replace = false) => {
    if (!value) {
      if (stored) void session.discardProposal(stored.id);
      return;
    }
    if (replace && stored && data && "kind" in data) {
      void session
        .stageProposal(replaceProjectShot(session, stored, value))
        .catch((error) => setCaptureError(String(error)));
      return;
    }
    const change = shotProposalChange(session, value);
    void session
      .stageProposal({
        id: replace && stored ? stored.id : crypto.randomUUID(),
        origin: "storyboard",
        title: tr("Proposed shots"),
        createdAt: new Date().toISOString(),
        changes: [change],
        data: value,
      })
      .catch((error) => setCaptureError(String(error)));
  };
  const [capturing, setCapturing] = useState(false);
  const capture = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => capture.current?.abort(), []);
  const presented = useMemo(
    () => (state.project ? prepareStoryPresentation(state.project) : undefined),
    [state.project],
  );
  const doc = session.document();
  const pending =
    proposal?.source.path === doc?.path &&
    proposal?.source.text === doc?.text &&
    !!stored &&
    session.proposalCurrent(stored)
      ? proposal
      : undefined;
  const authored = doc && nativeScenePath(doc.path) ? parseAltairSceneDocument(doc.text) : undefined;
  const scene = state.project?.scenes.find((scene) => scene.id === authored?.id);
  if (!scene || !authored || !doc) return <div className="empty-panel">{tr("Open a scene first")}</div>;
  const authoredShots = pending?.shots ?? sceneStoryboard({ extensions: authored.extensions ?? {} });
  const shots = pending?.shots ?? sceneStoryboard(presented?.scenes.find((value) => value.id === scene.id) ?? scene);
  const currentScene = {
    ...scene,
    extensions: {
      ...authored.extensions,
      ...(pending ? { [STORYBOARD_KEY]: { version: 1, shots: pending.shots as unknown as JsonObject[] } } : {}),
    },
  };
  const issues = validateStoryboard(currentScene);
  const nodeIds = new Set(authored.nodes.map((node) => node.id));
  const ready =
    !state.compiling &&
    scene.commands.length === nodeIds.size &&
    scene.commands.every((command) => nodeIds.has(command.id));
  const selected = authored.nodes.filter((node) => scope?.includes(node.id));
  const start = nodeIds.has(range.start) ? range.start : (selected[0]?.id ?? authored.nodes[0]?.id ?? "");
  const end = nodeIds.has(range.end) ? range.end : (selected.at(-1)?.id ?? authored.nodes.at(-1)?.id ?? "");
  const locale = state.project?.meta.locale ?? "und";
  const label = (id: string) => {
    const index = authored.nodes.findIndex((node) => node.id === id),
      node = authored.nodes[index];
    if (!node) return tr("Missing statement");
    const excerpt = nativeNodeExcerpt(node, locale);
    return `${index + 1} · ${String(excerpt || nativeNodeLabel(node)).slice(0, 48)}`;
  };
  const caption = (shot: StoryShot) => {
    const start = authored.nodes.findIndex((node) => node.id === shot.start),
      end = authored.nodes.findIndex((node) => node.id === shot.end);
    const excerpt = authored.nodes
      .slice(start, end + 1)
      .map((node) => nativeNodeExcerpt(node, locale))
      .find(Boolean);
    return `${start + 1}–${end + 1} · ${excerpt || label(shot.start)}`;
  };
  const { presentationBaked: _legacyBake, ...sceneExtensions } = authored.extensions ?? {};
  const scenePresentation = sceneExtensions["haneoka.presentation"];
  const currentPresentation =
    scenePresentation && typeof scenePresentation === "object" && !Array.isArray(scenePresentation)
      ? scenePresentation
      : {};
  const commit = (next: readonly StoryShot[]) => {
    if (pending) {
      setProposal({ ...pending, shots: next }, true);
      return;
    }
    session.update(
      doc.path,
      serializeAltairDocument(
        {
          ...authored,
          extensions: {
            ...sceneExtensions,
            [STORYBOARD_KEY]: {
              version: 1,
              shots: next.filter((shot) => shot.origin !== "automatic") as unknown as JsonObject[],
            },
          },
        },
        doc.text,
      ),
    );
  };
  const frameId = (shot: StoryShot) => {
    const head = scene.commands.findIndex((command) => command.id === shot.start),
      tail = scene.commands.findIndex((command) => command.id === shot.end);
    return (
      scene.commands
        .slice(head, tail + 1)
        .find((command) => storyCommandAtoms([command]).some((child) => child.command === VEGA_ADV_OPCODE.Talk))?.id ??
      shot.start
    );
  };
  const captureAll = async () => {
    capture.current?.abort();
    const controller = (capture.current = new AbortController());
    const revision = state.compilation;
    setCaptureError("");
    setCapturing(true);
    try {
      for (const shot of shots) {
        controller.signal.throwIfAborted();
        if (session.getSnapshot().compilation !== revision) break;
        const image = await session.captureFrame(frameId(shot), controller.signal);
        if (!controller.signal.aborted) setThumbnails((current) => ({ ...current, [shot.id]: { revision, image } }));
      }
    } catch (error) {
      if (!controller.signal.aborted) setCaptureError(tr(error instanceof Error ? error.message : String(error)));
    } finally {
      if (capture.current === controller) setCapturing(false);
    }
  };
  const storeShot = (next: StoryShot) => {
    const head = authored.nodes.findIndex((node) => node.id === next.start),
      tail = authored.nodes.findIndex((node) => node.id === next.end);
    if (authored.nodes.slice(head, tail + 1).some(cameraLocked)) {
      setCaptureError(tr("ai.locked"));
      return;
    }
    if (
      authoredShots.some(
        (shot) =>
          shot.id !== next.id &&
          shot.locked &&
          authored.nodes.findIndex((node) => node.id === shot.start) <= tail &&
          authored.nodes.findIndex((node) => node.id === shot.end) >= head,
      )
    ) {
      setCaptureError(tr("Shot overlaps a locked range"));
      return;
    }
    setCaptureError("");
    commit(
      [
        ...storyShotsOutsideRange(currentScene, head, tail).filter((shot) => shot.id !== next.id),
        { ...next, origin: "author" as const },
      ].sort(
        (a, b) =>
          authored.nodes.findIndex((node) => node.id === a.start) -
          authored.nodes.findIndex((node) => node.id === b.start),
      ),
    );
  };
  const update = (id: string, patch: Partial<StoryShot>) => {
    const shot = shots.find((shot) => shot.id === id);
    if (shot) storeShot({ ...shot, ...patch });
  };
  const select = (id: string) => {
    const line = nativeStatements(doc.text).find((statement) => statement.id === id)?.line;
    if (line) session.select(line);
  };
  const selectShot = (shot: StoryShot) => {
    const head = scene.commands.findIndex((command) => command.id === shot.start);
    const tail = scene.commands.findIndex((command) => command.id === shot.end);
    const representative = scene.commands
      .slice(head, tail + 1)
      .find((command) => storyCommandAtoms([command]).some((atom) => atom.command === VEGA_ADV_OPCODE.Talk));
    select(representative?.id ?? shot.start);
  };
  const ranges = (value: string, onChange: (value: string) => void, name: string, locked = false) => (
    <label className="field">
      <span>{tr(name)}</span>
      <select disabled={locked} value={value} onChange={(event) => onChange(event.target.value)}>
        {authored.nodes.map((node) => (
          <option key={node.id} value={node.id}>
            {label(node.id)}
          </option>
        ))}
      </select>
    </label>
  );
  const actors = [
    ...new Set(
      storyCommandAtoms(scene.commands).flatMap((command) => {
        if (command.command !== VEGA_ADV_OPCODE.Character && command.command !== VEGA_ADV_OPCODE.In) return [];
        const values = [
          command.fields.targetName,
          ...(Array.isArray(command.fields.targets)
            ? command.fields.targets.map((target) => record(target).target)
            : []),
        ];
        return values.filter((value): value is string => typeof value === "string" && Boolean(value));
      }),
    ),
  ];
  const actorNames = new Map<string, string>();
  for (const source of state.project?.scenes ?? [])
    for (const command of storyCommandAtoms(source.commands)) {
      if (command.command !== VEGA_ADV_OPCODE.Talk) continue;
      const names = Array.isArray(command.fields.targetTextNames) ? command.fields.targetTextNames : [];
      const targets = Array.isArray(command.fields.targets)
        ? command.fields.targets
        : [{ target: command.fields.targetName ?? "" }];
      targets.forEach((target, index) => {
        const id = record(target).target,
          name = readLocalizedText(names[index], locale);
        if (typeof id === "string" && id && name) actorNames.set(id, name);
      });
    }
  const cameraStatements = (shot: StoryShot) => {
    const lines = authoredNodeLines(doc.text),
      all = nativeStatements(doc.text);
    const head = authored.nodes.findIndex((node) => node.id === shot.start),
      tail = authored.nodes.findIndex((node) => node.id === shot.end);
    const cameraIds = new Set(
      scene.commands
        .slice(head, tail + 1)
        .flatMap((command) => storyCommandAtoms([command]))
        .filter(isStoryCameraCommand)
        .map((command) => command.id),
    );
    const flatten = (node: AltairAuthoredNode): AltairAuthoredNode[] => [
      node,
      ...(node.children ?? []).flatMap(flatten),
    ];
    return authored.nodes.slice(head, tail + 1).flatMap((root) => {
      const statement = all.find((statement) => statement.id === root.id)!;
      return flatten(root)
        .filter((node) => cameraIds.has(node.id))
        .map((node) => ({
          ...statement,
          node,
          id: node.id,
          name: nativeNodeLabel(node),
          line: lines.get(node.id) ?? statement.line,
        }));
    });
  };
  const bake = () => {
    const project = {
      ...state.project!,
      scenes: state.project!.scenes.map((value) => (value.id === scene.id ? currentScene : value)),
    };
    const prepared = prepareStoryPresentation(project);
    const baked = prepared.scenes.find((value) => value.id === scene.id)!;
    const document = storyProjectToAuthoredWorkspace(
      {
        ...project,
        scenes: [
          {
            ...baked,
            extensions: {
              ...sceneExtensions,
              "haneoka.presentation": { ...currentPresentation, cameraMode: "manual" },
              [STORYBOARD_KEY]: {
                version: 1,
                shots: shots.map((shot) => ({
                  ...shot,
                  origin: "author",
                  kind: "manual",
                  locked: true,
                })) as unknown as JsonObject[],
              },
            },
          },
        ],
      },
      webGalCommandToAuthoredNode,
    ).scenes[0]!;
    session.update(doc.path, serializeAltairDocument(document, doc.text));
  };
  const generateProposal = () => {
    setProposal({
      source: { path: doc.path, text: doc.text },
      sceneId: scene.id,
      extensions: sceneExtensions,
      shots: planProtectedShots(state.project!, authored, { start, end, intent }),
    });
  };
  return (
    <section className="storyboard-editor">
      <AutoPlan
        request={autoPlanRequest}
        ready={ready && !!start && !!end}
        run={() => {
          generateProposal();
          session.consumeToolRequest(autoPlanRequest!);
        }}
      />
      <div className="panel-heading">{tr("Storyboard")}</div>
      {(state.proposals?.filter((item) => item.origin === "storyboard").length ?? 0) > 1 && (
        <label className="field">
          <span>{tr("ai.proposals")}</span>
          <select value={stored?.id ?? ""} onChange={(event) => session.selectProposal(event.target.value)}>
            {state.proposals
              ?.filter((item) => item.origin === "storyboard")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
      )}
      {stored?.detail && <span>{stored.detail}</span>}
      {stored && !session.proposalCurrent(stored) && <span className="ai-status">{tr("ai.proposalExpired")}</span>}
      <div className="storyboard-planner">
        <label className="field">
          <span>{tr("Direction mode")}</span>
          <select
            value={String(
              currentPresentation.cameraMode ??
                (authored.extensions?.presentationBaked
                  ? "manual"
                  : ((state.project?.runtime.presentation as JsonObject)?.cameraMode ?? "automatic")),
            )}
            onChange={(event) =>
              session.update(
                doc.path,
                serializeAltairDocument(
                  {
                    ...authored,
                    extensions: {
                      ...sceneExtensions,
                      "haneoka.presentation": { ...currentPresentation, cameraMode: event.currentTarget.value },
                    },
                  },
                  doc.text,
                ),
              )
            }
          >
            <option value="automatic">{tr("Automatic direction")}</option>
            <option value="manual">{tr("Manual direction")}</option>
          </select>
        </label>
        {ranges(start, (start) => setRange({ start, end }), "Range start")}
        {ranges(end, (end) => setRange({ start, end }), "Range end")}
        <label className="field">
          <span>{tr("Scene intent")}</span>
          <select value={intent} onChange={(event) => setIntent(event.target.value as StoryIntent)}>
            {(["dialogue", "quiet", "conflict", "ensemble"] as const).map((value) => (
              <option key={value} value={value}>
                {tr(`intent.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={
            !ready ||
            !start ||
            !end ||
            authored.nodes.findIndex((node) => node.id === end) < authored.nodes.findIndex((node) => node.id === start)
          }
          onClick={generateProposal}
        >
          <Camera size={18} />
          {tr("Plan shots")}
        </button>
        <button
          className="secondary-button"
          disabled={!ready || !start || !end || authoredShots.some((shot) => shot.start === start && shot.locked)}
          onClick={() => storeShot({ id: crypto.randomUUID(), start, end, kind: "wide", origin: "author" })}
        >
          <Plus size={18} />
          {tr("Add shot")}
        </button>
        <button
          className="secondary-button"
          disabled={
            !ready ||
            !shots.length ||
            issues.length > 0 ||
            state.project?.runtime.presentation === undefined ||
            (state.project.runtime.presentation as JsonObject).mode !== "our-notes" ||
            (currentPresentation.cameraMode === "manual" && shots.every((shot) => shot.kind === "manual"))
          }
          onClick={bake}
        >
          {tr("Bake camera commands")}
        </button>
      </div>
      {proposal && (
        <div className="storyboard-proposal" role="group" aria-label={tr("Shot proposal")}>
          <strong>{tr("Shot proposal")}</strong>
          <div className="storyboard-shot-tools">
            <button
              className="secondary-button"
              aria-pressed={!previewProposal}
              onClick={() => setPreviewProposal(false)}
            >
              {tr("Current shots")}
            </button>
            <button
              className="secondary-button"
              aria-pressed={previewProposal}
              onClick={() => setPreviewProposal(true)}
            >
              {tr("Preview proposal")}
            </button>
            <button
              className="primary-button"
              disabled={!ready || !pending || !stored || !session.proposalCurrent(stored)}
              onClick={() => {
                if (pending && stored)
                  void session.acceptProposal(stored.id).catch((error) => setCaptureError(String(error)));
              }}
            >
              {tr("Apply proposal")}
            </button>
            <button className="text-button" onClick={() => setProposal(undefined)}>
              {tr("Discard proposal")}
            </button>
          </div>
        </div>
      )}
      <div className="storyboard-shot-tools">
        <button
          className="secondary-button"
          disabled={!ready || !shots.length}
          onClick={() => (capturing ? capture.current?.abort() : void captureAll())}
        >
          {tr(capturing ? "Stop" : "Generate thumbnails")}
        </button>
      </div>
      <fieldset
        className="storyboard-shot-editing"
        disabled={Boolean(proposal && !pending)}
        aria-label={tr("Storyboard")}
      >
        <ol className="storyboard-shots">
          {shots.map((shot, index) => (
            <li
              className="surface storyboard-shot"
              key={shot.id}
              data-selected={state.selectedNodeId === shot.start}
              data-expanded={expandedShot === shot.id}
            >
              <div className="panel-heading">
                <button
                  className="text-button"
                  onClick={() => {
                    selectShot(shot);
                    setExpandedShot(shot.id);
                  }}
                >
                  {tr("Shot {{count}}", { count: index + 1 })}
                </button>
                <button
                  className="icon-button"
                  aria-label={tr(shot.locked ? "Unlock shot" : "Lock shot")}
                  onClick={() => update(shot.id, { locked: !shot.locked })}
                >
                  {shot.locked ? <Lock size={18} /> : <Unlock size={18} />}
                </button>
                <button
                  className="icon-button"
                  aria-label={tr(shot.origin === "automatic" ? "Keep manual camera" : "Remove shot")}
                  disabled={shot.locked}
                  onClick={() =>
                    shot.origin === "automatic"
                      ? update(shot.id, { kind: "manual" })
                      : commit(authoredShots.filter((value) => value.id !== shot.id))
                  }
                >
                  <Trash2 size={18} />
                </button>
              </div>
              <small className="storyboard-ownership">
                {tr(shot.origin === "automatic" ? "Automatic shot" : "Author shot")}
              </small>
              <p className="storyboard-shot-excerpt">{caption(shot)}</p>
              <div className="storyboard-thumbnail">
                {thumbnails[shot.id]?.revision === state.compilation && (
                  <img src={thumbnails[shot.id]!.image} alt="" width={512} height={288} />
                )}
                <button
                  className="secondary-button"
                  disabled={!ready}
                  onClick={() => {
                    capture.current?.abort();
                    const controller = (capture.current = new AbortController()),
                      revision = state.compilation;
                    setCaptureError("");
                    selectShot(shot);
                    const head = scene.commands.findIndex((command) => command.id === shot.start),
                      tail = scene.commands.findIndex((command) => command.id === shot.end);
                    const frameId =
                      scene.commands
                        .slice(head, tail + 1)
                        .find((command) =>
                          storyCommandAtoms([command]).some((child) => child.command === VEGA_ADV_OPCODE.Talk),
                        )?.id ?? shot.start;
                    void session
                      .captureFrame(frameId, controller.signal)
                      .then((image) => {
                        if (!controller.signal.aborted)
                          setThumbnails((current) => ({ ...current, [shot.id]: { revision, image } }));
                      })
                      .catch((error) => {
                        if (!controller.signal.aborted)
                          setCaptureError(tr(error instanceof Error ? error.message : String(error)));
                      });
                  }}
                >
                  {tr("Capture shot")}
                </button>
              </div>
              <div className="storyboard-shot-tools">
                <button
                  className="text-button"
                  disabled={
                    shot.locked ||
                    !state.selectedNodeId ||
                    authored.nodes.findIndex((node) => node.id === state.selectedNodeId) <=
                      authored.nodes.findIndex((node) => node.id === shot.start) ||
                    authored.nodes.findIndex((node) => node.id === state.selectedNodeId) >
                      authored.nodes.findIndex((node) => node.id === shot.end)
                  }
                  onClick={() => {
                    const at = authored.nodes.findIndex((node) => node.id === state.selectedNodeId);
                    commit(
                      shots.flatMap((value) =>
                        value.id === shot.id
                          ? [
                              { ...shot, origin: "author", end: authored.nodes[at - 1]!.id },
                              { ...shot, origin: "author", id: crypto.randomUUID(), start: authored.nodes[at]!.id },
                            ]
                          : [value],
                      ),
                    );
                  }}
                >
                  {tr("Split at selection")}
                </button>
                <button
                  className="text-button"
                  disabled={
                    shot.locked ||
                    !shots[index + 1] ||
                    shots[index + 1]!.locked ||
                    authored.nodes.findIndex((node) => node.id === shot.end) + 1 !==
                      authored.nodes.findIndex((node) => node.id === shots[index + 1]?.start)
                  }
                  onClick={() => {
                    const next = shots[index + 1]!;
                    commit(
                      shots
                        .filter((value) => value.id !== next.id)
                        .map((value) =>
                          value.id === shot.id ? { ...shot, origin: "author" as const, end: next.end } : value,
                        ),
                    );
                  }}
                >
                  {tr("Merge with next shot")}
                </button>
              </div>
              <details
                className="argument-section"
                open={expandedShot === shot.id}
                onToggle={(event) => {
                  if (event.currentTarget.open) setExpandedShot(shot.id);
                  else if (expandedShot === shot.id) setExpandedShot(undefined);
                }}
              >
                <summary>{tr("Shot settings")}</summary>
                {expandedShot === shot.id && (
                  <div className="storyboard-shot-settings">
                    {shot.kind === "manual" && (
                      <section>
                        <h3>{tr("Camera commands")}</h3>
                        {cameraStatements(shot).map((statement) => (
                          <NativeInspector key={statement.id} statement={statement} session={session} embedded />
                        ))}
                      </section>
                    )}
                    {ranges(shot.start, (value) => update(shot.id, { start: value }), "Range start", shot.locked)}
                    {ranges(shot.end, (value) => update(shot.id, { end: value }), "Range end", shot.locked)}
                    <label className="field">
                      <span>{tr("Shot kind")}</span>
                      <select
                        value={shot.kind}
                        disabled={shot.locked}
                        onChange={(event) => update(shot.id, { kind: event.target.value as StoryShot["kind"] })}
                      >
                        {(["speaker", "reaction", "two", "group", "wide", "manual"] as const).map((value) => (
                          <option key={value} value={value}>
                            {tr(`shot.${value}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr("Target")}</span>
                      <select
                        value={shot.targetName ?? ""}
                        disabled={
                          shot.locked ||
                          shot.kind === "wide" ||
                          shot.kind === "two" ||
                          shot.kind === "group" ||
                          shot.kind === "manual"
                        }
                        onChange={(event) =>
                          update(shot.id, {
                            targetName: event.target.value,
                            subjects: event.target.value ? [event.target.value] : [],
                          })
                        }
                      >
                        <option value="">{tr("Automatic")}</option>
                        {shot.targetName && !actors.includes(shot.targetName) && (
                          <option value={shot.targetName}>
                            {tr("Unbound")} · {shot.targetName}
                          </option>
                        )}
                        {actors.map((actor) => (
                          <option key={actor} value={actor}>
                            {actorNames.get(actor) ?? actor}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(shot.kind === "two" || shot.kind === "group" || shot.kind === "wide") && (
                      <div className="field">
                        <span>{tr("Shot subjects")}</span>
                        <div className="storyboard-shot-tools">
                          {actors.map((actor) => {
                            const selected = shot.subjects ?? [];
                            return (
                              <button
                                type="button"
                                className="secondary-button"
                                key={actor}
                                disabled={shot.locked}
                                aria-pressed={selected.includes(actor)}
                                style={
                                  selected.includes(actor)
                                    ? {
                                        backgroundColor: "var(--md-sys-color-secondary-container)",
                                        color: "var(--md-sys-color-on-secondary-container)",
                                      }
                                    : undefined
                                }
                                onClick={() =>
                                  update(shot.id, {
                                    subjects: selected.includes(actor)
                                      ? selected.filter((name) => name !== actor)
                                      : [...selected, actor],
                                    targetName: undefined,
                                  })
                                }
                              >
                                {selected.includes(actor) && <Check size={18} aria-hidden />}
                                {actorNames.get(actor) ?? actor}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <label className="field">
                      <span>{tr("Shot transition")}</span>
                      <select
                        disabled={shot.locked || shot.kind === "manual"}
                        value={shot.transition ?? (shot.transitionSeconds === 0 ? "cut" : "glide")}
                        onChange={(event) =>
                          update(shot.id, {
                            transition: event.target.value as "cut" | "glide",
                            transitionSeconds: event.target.value === "cut" ? 0 : 0.65,
                          })
                        }
                      >
                        <option value="cut">{tr("Cut")}</option>
                        <option value="glide">{tr("Glide")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr("Focus shot")}</span>
                      <select
                        value={shot.cameraDistance ?? 2}
                        disabled={shot.locked || shot.kind === "manual"}
                        onChange={(event) => update(shot.id, { cameraDistance: Number(event.target.value) })}
                      >
                        {commandDescriptor(VEGA_ADV_OPCODE.Focus)
                          ?.fields.find((field) => field.key === "cameraDistance")
                          ?.choices?.map((choice) => (
                            <option key={String(choice.value)} value={String(choice.value)}>
                              {tr(`choice.${choice.label}`)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr("Camera transition (s)")}</span>
                      <NumberInput
                        min={0}
                        max={2}
                        step={0.05}
                        value={shot.transitionSeconds ?? 0.35}
                        disabled={shot.locked || shot.kind === "manual"}
                        onCommit={(value) =>
                          update(shot.id, { transitionSeconds: value, transition: value > 0 ? "glide" : "cut" })
                        }
                      />
                    </label>
                  </div>
                )}
              </details>
            </li>
          ))}
        </ol>
      </fieldset>
      {captureError && <div role="alert">{captureError}</div>}
      {issues.length > 0 && <div role="alert">{issues.map((issue) => tr(issue.message)).join(" · ")}</div>}
    </section>
  );
}
