import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  serializeAltairDocument,
  cloneAltairNodeGroup,
  type AltairAuthoredNode,
  type AltairSceneDocument,
  type JsonObject,
  type JsonValue,
} from "@haneoka/altair/documents";
import {
  createNativeScriptDraft,
  rebaseNativeScriptDraft,
  applyNativeScript,
  cleanNativeScriptScene,
  nativeScriptRegistry,
  withNativeScriptProviders,
  nativeScriptState,
  NATIVE_SCRIPT_STATE,
} from "@haneoka/altair-plugin-webgal/native-script";
import {
  AuthoringWorkspace,
  type CastRef,
  type StudioBridge,
  type StudioLine,
  type StudioModel,
  type StudioNote,
  type LockField,
  type CastOptionsRequest,
} from "./Manuscript";
import { ResourceRecovery } from "./ResourceRecovery";
import { TaskSheet } from "./TaskSheet";
import "./integration.css";
import { Preview } from "../Preview";
import { ArrowUp, ArrowDown, Copy, Trash2 } from "lucide-react";
import { NativeInspector } from "../NativeInspector";
import { NativeCommandPalette } from "../NativeCommandPalette";
import { adaptProseDeterministically } from "@haneoka/altair-plugin-prose";
import { parseWebGalScene, editWebGalStatement } from "@haneoka/altair-plugin-webgal/codec";
import { advCommandToAuthoredNode } from "@haneoka/altair-plugin-adv/documents";
import type { EditorSession } from "../session";
import {
  nativeDialogueNodes,
  nativeStatementIsVisible,
  nativeNodeLabel,
  nativeScenePath,
  nativeStatements,
  NATIVE_PROJECT_PATH,
} from "../native-project";
import { readLocalizedText, editLocalizedText } from "../localized-text";
import { tr, useStudioI18n } from "../i18n";
const TimelineEditor = lazy(() => import("../TimelineEditor").then((module) => ({ default: module.TimelineEditor })));
const StoryboardEditor = lazy(() =>
  import("../StoryboardEditor").then((module) => ({ default: module.StoryboardEditor })),
);
const LOCKS = "haneoka.authoring.locks";
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const nodes = (node: AltairAuthoredNode): AltairAuthoredNode[] => [node, ...(node.children ?? []).flatMap(nodes)];
const keyOf = (node: AltairAuthoredNode) => String(node.arguments.targetName ?? "");
const localeIndex = (locale: string) => Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(locale));
function context(session: EditorSession) {
  const state = session.getSnapshot();
  const manifest = session.document(NATIVE_PROJECT_PATH);
  if (!manifest) throw new Error(tr("File is missing"));
  const project = parseAltairProjectDocument(manifest.text);
  const scenes = project.scenes.flatMap((ref) => {
    const doc = session.document(ref.path);
    return doc ? [{ ref, doc, scene: parseAltairSceneDocument(doc.text) }] : [];
  });
  return { state, project, scenes, locale: project.locales[0] ?? "ja" };
}
function compileScene(session: EditorSession, scene: AltairSceneDocument) {
  const ctx = context(session);
  return nativeScriptRegistry().compileDraft(
    withNativeScriptProviders({
      project: ctx.project,
      scenes: ctx.scenes.map((entry) => cleanNativeScriptScene(entry.scene.id === scene.id ? scene : entry.scene)),
    }),
  );
}
function locked(node: AltairAuthoredNode, root: AltairAuthoredNode): Partial<Record<LockField, boolean>> {
  return { ...object(root.extensions?.[LOCKS]), ...object(node.extensions?.[LOCKS]) } as Partial<
    Record<LockField, boolean>
  >;
}
function replaceTree(
  node: AltairAuthoredNode,
  edits: ReadonlyMap<string, AltairAuthoredNode | null>,
): AltairAuthoredNode | undefined {
  const edit = edits.get(node.id);
  if (edit === null) return;
  let result = edit ?? node;
  if (result.children) {
    const children = result.children.flatMap((child) => {
      const next = replaceTree(child, edits);
      return next ? [next] : [];
    });
    const ids = new Set(children.map((child) => child.id));
    const tracks = result.arguments.tracks;
    result = {
      ...result,
      children,
      arguments: {
        ...result.arguments,
        ...(Array.isArray(tracks) ? { tracks: tracks.filter((track) => ids.has(String(object(track).nodeId))) } : {}),
      },
    };
  }
  return result;
}
function storeScene(session: EditorSession, scene: AltairSceneDocument, preserveSource = true, merge = false) {
  const entry = context(session).scenes.find((entry) => entry.scene.id === scene.id)!;
  const previous = nativeScriptState(entry.scene);
  let next = cleanNativeScriptScene(scene);
  if (preserveSource && previous) {
    applyNativeScript(
      compileScene(session, entry.scene),
      cleanNativeScriptScene(entry.scene),
      previous.map,
      previous.text,
    );
    const draft = rebaseNativeScriptDraft(compileScene(session, next), next, previous);
    next = { ...next, extensions: { ...next.extensions, [NATIVE_SCRIPT_STATE]: draft as unknown as JsonObject } };
  }
  session.update(entry.doc.path, serializeAltairDocument(next, entry.doc.text), merge);
}
function members(session: EditorSession): CastRef[] {
  const ctx = context(session),
    cast = new Map<string, CastRef>();
  const url = (path: unknown) => (typeof path === "string" ? session.url(path) : undefined);
  for (const entry of ctx.scenes)
    for (const root of entry.scene.nodes)
      for (const node of nodes(root)) {
        if (node.type.name !== "Talk") continue;
        const targets = object(node.extensions?.fields).targets;
        const names = Array.isArray(node.arguments.targetTextNames) ? node.arguments.targetTextNames : [];
        const values = Array.isArray(targets) ? targets.map(object) : keyOf(node) ? [{ target: keyOf(node) }] : [];
        values.forEach((target, index) => {
          const id = String(target.target ?? "");
          if (!id) return;
          const name =
            readLocalizedText(names[index], ctx.locale) ||
            (Array.isArray(target.name) ? String(target.name[localeIndex(ctx.locale)] ?? target.name[0] ?? "") : "") ||
            cast.get(id)?.displayName ||
            id;
          cast.set(id, { castId: id, displayName: name, avatar: url(target.faceImage) ?? cast.get(id)?.avatar });
        });
      }
  return [...cast.values()];
}
function noteKind(node: AltairAuthoredNode): StudioNote["kind"] {
  if (node.type.name === "propertyClip")
    return node.arguments.target === "scene-camera"
      ? "camera"
      : String(node.arguments.target).startsWith("volume:")
        ? "stage"
        : "motion";
  if (node.type.name === "Motion") return node.arguments.motionName ? "motion" : "face";
  if (/Focus|Camera|Dof|Shake/u.test(node.type.name)) return "camera";
  if (/Bgm|Se|Voice|Audio|audioClip/u.test(node.type.name)) return "audio";
  if (/Character|Costume/u.test(node.type.name)) return "costume";
  if (/Wait|timeline/u.test(node.type.name)) return "timing";
  if (/Stage|In|Out|Move|Fade|Still/u.test(node.type.name)) return "stage";
  return "other";
}
function label(node: AltairAuthoredNode): string {
  const resource = node.arguments.motionName || node.arguments.expressionName;
  return [nativeNodeLabel(node), resource].filter(Boolean).join(" · ");
}
function makeLines(session: EditorSession, scene: AltairSceneDocument, cast: CastRef[], locale: string): StudioLine[] {
  const castById = new Map(cast.map((member) => [member.castId, member]));
  const lines: StudioLine[] = [];
  let pending: StudioNote[] = [];
  for (const root of scene.nodes) {
    const speech = nativeDialogueNodes(root),
      atoms = nodes(root).filter((node) => !node.children?.length);
    const notes = atoms
      .filter((node) => node.type.name !== "Talk")
      .map((node) => ({
        id: node.id,
        kind: noteKind(node),
        label: label(node),
        ...(keyOf(node) ? { castId: keyOf(node) } : {}),
      }));
    if (!speech.length) {
      pending.push(...notes);
      if (nativeStatementIsVisible(root)) {
        lines.push({
          id: root.id,
          kind: "direction",
          speakers: [],
          text: notes.map((note) => note.label).join(tr("authoring.listJoin")) || nativeNodeLabel(root),
          notes: pending,
          locked: locked(root, root),
          issues: [],
        });
        pending = [];
      }
      continue;
    }
    for (const [index, node] of speech.entries()) {
      const targets = object(node.extensions?.fields).targets;
      const ids = Array.isArray(targets)
        ? targets.map((target) => String(object(target).target ?? "")).filter(Boolean)
        : [keyOf(node)].filter(Boolean);
      const names = Array.isArray(node.arguments.targetTextNames)
        ? node.arguments.targetTextNames.map((name) => readLocalizedText(name, locale)).filter((name) => name.trim())
        : [];
      const status = node.arguments.targetStatus ?? object(node.extensions?.fields).targetStatus;
      lines.push({
        id: node.id,
        kind: "speech",
        speakers: ids.flatMap((id) => (castById.has(id) ? [castById.get(id)!] : [])),
        ...(status === 1
          ? { speakerLabel: "???" }
          : status === 2
            ? { speakerLabel: tr("Narration") }
            : names.length
              ? { speakerLabel: names.join(tr("authoring.speakerJoin")) }
              : {}),
        text: readLocalizedText(node.arguments.text, locale),
        notes: [...(index === 0 ? pending : []), ...notes],
        locked: locked(node, root),
        issues: [],
      });
    }
    pending = [];
  }
  if (pending.length && lines.length)
    lines[lines.length - 1] = { ...lines[lines.length - 1]!, notes: [...lines[lines.length - 1]!.notes, ...pending] };
  else if (pending.length && scene.nodes[0])
    lines.push({
      id: scene.nodes[0].id,
      kind: "direction",
      speakers: [],
      text: pending.map((note) => note.label).join(tr("authoring.listJoin")),
      notes: pending,
      locked: locked(scene.nodes[0], scene.nodes[0]),
      issues: [],
    });
  return lines;
}
function modelsFor(session: EditorSession, castId: string, includeAll = false) {
  const ctx = context(session),
    all = ctx.scenes.flatMap((entry) => entry.scene.nodes.flatMap(nodes));
  const bindings = all
    .filter((node) => keyOf(node) === castId && typeof node.arguments.live2dKey === "string")
    .map((node) => String(node.arguments.live2dKey));
  const assets = ["live2d", "models", "characters"].flatMap((key) => {
    const value = ctx.project.assets[key];
    return Array.isArray(value)
      ? value.map(object)
      : Object.entries(object(value)).map(([id, value]) => ({ id, ...object(value) }));
  });
  if (includeAll) return assets;
  const prefixes = bindings.map((id) => id.split(/[_-]/u)[0]);
  return assets.filter(
    (asset) => bindings.includes(String(asset.id)) || prefixes.includes(String(asset.id).split(/[_-]/u)[0]),
  );
}
async function options(session: EditorSession, request: CastOptionsRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const models = modelsFor(session, request.castId, request.group === "costume"),
    member = members(session).find((member) => member.castId === request.castId);
  let values: { id: string; label: string; thumb?: string }[];
  if (request.group === "costume")
    values = models.map((model) => ({
      id: String(model.resourceRef ?? model.id ?? model.live2dKey),
      label:
        readLocalizedText(model.name ?? model.label ?? model.title, context(session).locale) ||
        String(model.resourceRef ?? model.id ?? model.live2dKey),
      thumb:
        typeof (model.thumbnailImage ?? model.thumbnail ?? model.faceImage) === "string"
          ? session.url(String(model.thumbnailImage ?? model.thumbnail ?? model.faceImage))
          : member?.avatar,
    }));
  else {
    values = models.flatMap((model) => {
      const runtime = object(model.runtime);
      const entries =
        request.group === "motion" ? (model.motions ?? runtime.motions) : (model.expressions ?? runtime.expressions);
      return (Array.isArray(entries) ? entries : []).map((entry) => {
        const value = object(entry),
          name = String(value.name ?? value.id ?? "");
        return { id: name, label: name, thumb: member?.avatar };
      });
    });
  }
  signal.throwIfAborted();
  return [
    ...new Map(
      values
        .filter((value) => value.id && value.label.toLocaleLowerCase().includes(request.query.toLocaleLowerCase()))
        .map((value) => [value.id, { ...value, group: request.group }]),
    ).values(),
  ];
}
function createBridge(session: EditorSession, notify: (message: string) => void): StudioBridge {
  const run = (operation: Promise<void>) =>
    void operation.catch((error) => notify(error instanceof Error ? error.message : String(error)));
  const select = async (sceneId: string, id: string) => {
    const entry = context(session).scenes.find((entry) => entry.scene.id === sceneId)!;
    const root = entry.scene.nodes.find((root) => nodes(root).some((node) => node.id === id));
    if (!root) return;
    const line = nativeStatements(entry.doc.text).find((statement) => statement.id === root.id)!.line;
    if (session.getSnapshot().active !== entry.doc.path) await session.activate(entry.doc.path, line);
    else session.select(line);
    return root;
  };
  return {
    edit({ sceneId, lines, change }) {
      const ctx = context(session),
        entry = ctx.scenes.find((entry) => entry.scene.id === sceneId)!;
      const edits = new Map<string, AltairAuthoredNode | null>(),
        additions = new Map<string, AltairAuthoredNode[]>();
      const cast = new Map(members(session).map((member) => [member.castId, member]));
      let skippedLocked = 0;
      const field: LockField | undefined =
        change.kind === "text"
          ? "text"
          : change.kind === "speakers"
            ? "cast"
            : change.kind === "cast-option"
              ? change.group === "costume"
                ? "cast"
                : change.group === "motion"
                  ? "motion"
                  : "face"
              : undefined;
      for (const id of lines) {
        const root = entry.scene.nodes.find((root) => nodes(root).some((node) => node.id === id));
        const node = root && nodes(root).find((node) => node.id === id);
        if (!root || !node) continue;
        const locks = locked(node, root);
        if (change.kind !== "lock" && (field ? locks[field] : Object.values(locks).some(Boolean))) {
          skippedLocked++;
          continue;
        }
        if (change.kind === "text")
          edits.set(id, {
            ...node,
            arguments: {
              ...node.arguments,
              text: editLocalizedText(node.arguments.text, ctx.locale, ctx.locale, change.text),
            },
          });
        else if (change.kind === "speakers") {
          const previous = object(node.extensions?.fields),
            targets = Array.isArray(previous.targets) ? previous.targets : [];
          const nextTargets = change.speakers.map(
            (id) =>
              targets.find((target) => object(target).target === id) ?? {
                target: id,
                name: [cast.get(id)?.displayName ?? id],
              },
          );
          edits.set(id, {
            ...node,
            arguments: {
              ...node.arguments,
              targetName: change.speakers.join("・"),
              targetTextNames: change.speakers.map((id) => ({ [ctx.locale]: cast.get(id)?.displayName ?? id })),
            },
            extensions: {
              ...node.extensions,
              fields: { ...previous, targets: nextTargets, lipSyncTargets: change.speakers },
            },
          });
        } else if (change.kind === "lock")
          edits.set(id, {
            ...node,
            extensions: {
              ...node.extensions,
              [LOCKS]: { ...object(node.extensions?.[LOCKS]), [change.field]: change.locked },
            },
          });
        else if (change.kind === "delete") edits.set(id, null);
        else if (change.kind === "remove-note") edits.set(change.noteId, null);
        else if (change.kind === "cast-option") {
          const type = change.group === "costume" ? "Character" : "Motion";
          const key =
            change.group === "costume" ? "live2dKey" : change.group === "motion" ? "motionName" : "expressionName";
          const existing = nodes(root).find((node) => node.type.name === type && keyOf(node) === change.castId);
          if (existing)
            edits.set(existing.id, { ...existing, arguments: { ...existing.arguments, [key]: change.optionId } });
          else {
            const cue: AltairAuthoredNode = {
              id: crypto.randomUUID(),
              type: { plugin: "haneoka.altair-adv", name: type },
              schemaVersion: 1,
              arguments: { targetName: change.castId, [key]: change.optionId },
              extensions: {},
            };
            if (root.type.name === "timeline") {
              const current = edits.get(root.id) ?? root;
              edits.set(root.id, {
                ...current,
                arguments: {
                  ...current.arguments,
                  tracks: [
                    ...(Array.isArray(current.arguments.tracks) ? current.arguments.tracks : []),
                    { nodeId: cue.id, atSeconds: 0, role: "event" },
                  ],
                },
                children: [...(current.children ?? []), cue],
              });
            } else additions.set(root.id, [...(additions.get(root.id) ?? []), cue]);
          }
        }
      }
      const next = entry.scene.nodes.flatMap((root) => {
        const node = replaceTree(root, edits);
        return node ? [...(additions.get(root.id) ?? []), node] : [];
      });
      storeScene(session, { ...entry.scene, nodes: next });
      return { skippedLocked };
    },
    insertAfter(sceneId, after, line) {
      const ctx = context(session),
        entry = ctx.scenes.find((entry) => entry.scene.id === sceneId)!;
      const id = crypto.randomUUID(),
        cast = members(session);
      const node: AltairAuthoredNode = {
        id,
        type: { plugin: "haneoka.altair-adv", name: "Talk" },
        schemaVersion: 1,
        arguments: {
          text: { [ctx.locale]: line.text },
          targetName: line.speakers.join("・"),
          targetTextNames: line.speakers.map((id) => ({
            [ctx.locale]: cast.find((member) => member.castId === id)?.displayName ?? id,
          })),
        },
        extensions: { fields: { targets: line.speakers.map((target) => ({ target })), lipSyncTargets: line.speakers } },
      };
      const index = after
        ? entry.scene.nodes.findIndex((root) => nodes(root).some((node) => node.id === after)) + 1
        : 0;
      storeScene(session, {
        ...entry.scene,
        nodes: [...entry.scene.nodes.slice(0, index), node, ...entry.scene.nodes.slice(index)],
      });
      return id;
    },
    openScene(id) {
      const entry = context(session).scenes.find((entry) => entry.scene.id === id);
      if (entry) run(session.activate(entry.doc.path));
    },
    options: (request, signal) => options(session, request, signal),
    seek(scene, id) {
      run(select(scene, id).then((root) => (root ? session.previewAt(root.id) : undefined)));
    },
    play(scene, id) {
      run(select(scene, id).then((root) => (root ? session.previewAt(root.id, true) : undefined)));
    },
    stop: () => run(session.pausePreview()),
    resume: () => run(session.resumePreview()),
    restart: () => run(session.restartPreview()),
    seekIndex: (index) => run(session.seekPreview(index)),
    undo: () => session.undo(),
    redo: () => session.redo(),
  };
}
export function AuthoringSession({
  session,
  onImport,
  onAssets,
  onTools,
  onLibrary,
  onHistory,
  destinations,
  notify,
}: {
  session: EditorSession;
  onImport(): void;
  onAssets(): void;
  onTools(): void;
  onLibrary(): void;
  onHistory(): void;
  destinations?: { id: string; label: string; icon: ReactNode; content: ReactNode }[];
  notify(message: string): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { i18n } = useStudioI18n();
  const [previewTools, setPreviewTools] = useState<HTMLDivElement | null>(null);
  const [insertTarget, setInsertTarget] = useState<{ after: string | null }>();
  const [inserted, setInserted] = useState<string>();
  const bridge = useMemo(() => createBridge(session, notify), [session, notify]);
  const manuscript = useMemo(() => {
    const ctx = context(session),
      active =
        ctx.scenes.find((entry) => entry.doc.path === state.active) ??
        ctx.scenes.find((entry) => entry.scene.id === state.authoringSelection?.sceneId) ??
        ctx.scenes[0];
    if (!active) return;
    const cast = members(session);
    const scenes = ctx.scenes.map((entry) => ({
      id: entry.scene.id,
      title: entry.scene.name,
      lines: makeLines(session, entry.scene, cast, ctx.locale),
    }));
    const compiled = compileScene(session, active.scene);
    const draft =
      nativeScriptState(active.scene) ?? createNativeScriptDraft(compiled, active.scene, localeIndex(ctx.locale));
    return { ctx, active, cast, scenes, draft };
  }, [session, state.documents, state.active, state.authoringSelection?.sceneId, i18n.language]);
  const model = useMemo((): StudioModel | undefined => {
    if (!manuscript) return;
    const { active, cast, scenes } = manuscript;
    const issues = state.error
      ? [{ id: "source", severity: "error" as const, message: state.error, sceneId: active.scene.id }]
      : [];
    const source = state.project?.scenes.find((scene) => scene.id === state.compilation?.sceneId);
    const mapping = state.compilation?.commandMappings
      .filter((mapping) => mapping.commandIndex <= (state.preview?.commandIndex ?? 0) && mapping.sceneId === source?.id)
      .at(-1);
    const rootId = mapping ? source?.commands[mapping.sourceCommandIndex]?.id : undefined;
    const root = active.scene.nodes.find((node) => node.id === rootId);
    return {
      scenes,
      activeSceneId: active.scene.id,
      cast,
      issues,
      playback: {
        ready: Boolean(state.preview?.ready),
        playing: Boolean(state.preview?.playing),
        lineId: root ? (nativeDialogueNodes(root)[0]?.id ?? root.id) : null,
        position: state.preview?.commandIndex ?? 0,
        length: Array.isArray(object(state.compilation?.story).commands)
          ? (object(state.compilation?.story).commands as unknown[]).length
          : 0,
      },
    };
  }, [manuscript, state.project, state.compilation, state.preview, state.error]);
  const initializedSelection = useRef(new Set<string>());
  const initialLine = useMemo(() => {
    if (!manuscript) return;
    const lines = manuscript.scenes.find((scene) => scene.id === manuscript.active.scene.id)?.lines ?? [];
    const firstSpeech = lines.find((line) => line.kind === "speech");
    const rootIndex = firstSpeech
      ? manuscript.active.scene.nodes.findIndex((root) => nodes(root).some((node) => node.id === firstSpeech.id))
      : manuscript.active.scene.nodes.length;
    const control = manuscript.active.scene.nodes
      .slice(0, rootIndex + 1)
      .find((root) =>
        nodes(root).some((node) =>
          /^(?:ChoiceShow|GoTo|branch|input|jump|call|Branch|Input|JumpScene|CallScene)$/u.test(
            node.type.name.replace(/^system\./u, ""),
          ),
        ),
      );
    return control
      ? (lines.find((line) => nodes(control).some((node) => node.id === line.id)) ?? lines[0])
      : (firstSpeech ?? lines[0]);
  }, [manuscript]);
  useEffect(() => {
    if (!manuscript || !initialLine || state.active !== manuscript.active.doc.path) return;
    const key = `${state.id}/${manuscript.active.scene.id}`;
    if (initializedSelection.current.has(key)) return;
    initializedSelection.current.add(key);
    if (state.authoringSelection?.cursor) return;
    const root = manuscript.active.scene.nodes.find((root) => nodes(root).some((node) => node.id === initialLine.id));
    const statement =
      root && nativeStatements(manuscript.active.doc.text).find((statement) => statement.id === root.id);
    if (statement) session.select(statement.line);
    session.setAuthoringSelection(manuscript.active.scene.id, [initialLine.id], initialLine.id);
  }, [session, state.id, state.active, manuscript, initialLine, state.authoringSelection?.cursor]);
  if (!model || !manuscript) return <div role="status">{tr("Loading")}</div>;
  const { ctx, active, draft } = manuscript;
  const onSourceChange = (text: string) => {
    const current = context(session).scenes.find((entry) => entry.scene.id === active.scene.id)!;
    const compiled = compileScene(session, current.scene);
    const previousMap = (nativeScriptState(current.scene) ?? draft).map;
    let next = cleanNativeScriptScene(current.scene),
      map = previousMap,
      source = text;
    try {
      let references: string[] | undefined;
      const candidate = applyNativeScript(compiled, next, map, text, (roots) => {
        references = roots;
      });
      const rebased = createNativeScriptDraft(
        compileScene(session, candidate),
        candidate,
        map.localeIndex,
        previousMap,
      );
      if (references) {
        const statements = parseWebGalScene(text, { additionalCommandNames: ["perform"] }).statements.filter(
          (statement) => statement.name === "perform" && statement.kind === "command",
        );
        if (statements.length !== references.length) throw new Error("Script references cannot be assigned safely");
        const aliases = new Map(Object.entries(rebased.map.performanceNodes).map(([name, id]) => [id, name]));
        for (let index = statements.length - 1; index >= 0; index--) {
          const name = aliases.get(references[index]!);
          if (name && name !== statements[index]!.content)
            source = editWebGalStatement(source, statements[index]!, { content: name });
        }
      }
      next = candidate;
      map = rebased.map;
    } catch {
      /* The raw draft remains editable beside the last valid scene. */
    }
    storeScene(
      session,
      {
        ...next,
        extensions: { ...next.extensions, [NATIVE_SCRIPT_STATE]: { text: source, map } as unknown as JsonObject },
      },
      false,
      true,
    );
  };
  const layout = object(object(object(state.compilation?.story).runtime).layout);
  const aspect = Number(layout.landscapeTargetAspect ?? layout.designViewportAspect ?? 13 / 6);

  const scope =
    state.authoringSelection?.sceneId === active.scene.id
      ? active.scene.nodes
          .filter((root) => nodes(root).some((node) => state.authoringSelection!.lines.includes(node.id)))
          .map((root) => root.id)
      : [];
  const renderInspector = (sceneId: string, ids: string[]) => {
    const entry = context(session).scenes.find((entry) => entry.scene.id === sceneId)!;
    const roots = new Set(
      ids.map((id) => entry.scene.nodes.find((root) => nodes(root).some((node) => node.id === id))?.id),
    );
    return nativeStatements(entry.doc.text)
      .filter((statement) => roots.has(statement.id))
      .map((statement) => (
        <section key={statement.id}>
          <div className="author-file-actions" role="group" aria-label={tr("Properties")}>
            {[
              { label: "Move statement up", icon: <ArrowUp aria-hidden />, run: () => session.move(statement, -1) },
              { label: "Move statement down", icon: <ArrowDown aria-hidden />, run: () => session.move(statement, 1) },
              {
                label: "Duplicate statement",
                icon: <Copy aria-hidden />,
                run: () => session.insert(statement.node, statement.line),
              },
              { label: "Delete statement", icon: <Trash2 aria-hidden />, run: () => session.remove(statement) },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                className="author-icon-button"
                aria-label={tr(action.label)}
                title={tr(action.label)}
                onClick={() => {
                  try {
                    action.run();
                  } catch (error) {
                    notify(tr(error instanceof Error ? error.message : String(error)));
                  }
                }}
              >
                {action.icon}
              </button>
            ))}
          </div>
          <NativeInspector statement={statement} session={session} embedded />
        </section>
      ));
  };
  const insert = (sceneId: string, after: string | null) => {
    const entry = context(session).scenes.find((entry) => entry.scene.id === sceneId)!;
    const root = after ? entry.scene.nodes.find((root) => nodes(root).some((node) => node.id === after)) : undefined;
    const line = root ? (nativeStatements(entry.doc.text).find((statement) => statement.id === root.id)?.line ?? 1) : 1;
    if (session.getSnapshot().active !== entry.doc.path)
      void session
        .activate(entry.doc.path, line)
        .then(() => setInsertTarget({ after: root?.id ?? null }))
        .catch((error) => notify(String(error)));
    else setInsertTarget({ after: root?.id ?? null });
  };
  const pasted = (text: string) => {
    const current = context(session).scenes.find((entry) => entry.scene.id === active.scene.id)!;
    const adapted = adaptProseDeterministically({ source: text, locale: ctx.locale });
    const sourceScene = adapted.project.scenes[0]!;
    const additions = cloneAltairNodeGroup(
      sourceScene.commands.map((command) => advCommandToAuthoredNode(command)),
      sourceScene.id,
      current.scene.id,
    );
    const cursor = state.authoringSelection?.sceneId === active.scene.id ? state.authoringSelection.cursor : null;
    const index = cursor
      ? current.scene.nodes.findIndex((root) => nodes(root).some((node) => node.id === cursor)) + 1
      : current.scene.nodes.length;
    const originals = current.scene.extensions?.["haneoka.authoring.originals"];
    storeScene(session, {
      ...current.scene,
      nodes: [...current.scene.nodes.slice(0, index), ...additions, ...current.scene.nodes.slice(index)],
      extensions: {
        ...current.scene.extensions,
        "haneoka.authoring.originals": [
          ...(Array.isArray(originals) ? originals : []),
          { text, ...adapted.provenance },
        ] as JsonValue[],
      },
    });
  };
  return (
    <>
      <AuthoringWorkspace
        model={model}
        bridge={bridge}
        stage={<Preview session={session} surfaceOnly toolsMount={previewTools} />}
        stageAspect={Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9}
        source={{ text: draft.text, onChange: onSourceChange }}
        selection={{
          sceneId: state.authoringSelection?.sceneId ?? active.scene.id,
          lines: [...(state.authoringSelection?.lines ?? [])],
          cursor: state.authoringSelection?.cursor ?? null,
        }}
        onSelectionChange={(scene, lines, cursor) => session.setAuthoringSelection(scene, lines, cursor)}
        onInsert={insert}
        renderInspector={renderInspector}
        destinations={destinations}
        onDestinationChange={(id) => {
          if (id !== "script") return;
          const current = context(session).scenes.find((entry) => entry.scene.id === active.scene.id)!;
          const root = current.scene.nodes.find((node) =>
            nodes(node).some((node) => node.id === state.authoringSelection?.cursor),
          );
          const line = root
            ? (nativeStatements(current.doc.text).find((statement) => statement.id === root.id)?.line ?? 1)
            : 1;
          if (session.getSnapshot().active !== current.doc.path)
            void session.activate(current.doc.path, line).catch((error) => notify(String(error)));
        }}
        timeline={
          <Suspense fallback={null}>
            <TimelineEditor session={session} scope={scope} />
          </Suspense>
        }
        storyboard={
          <Suspense fallback={null}>
            <StoryboardEditor session={session} scope={scope} />
          </Suspense>
        }
        onImport={onImport}
        onAssets={onAssets}
        onTools={onTools}
        onLibrary={onLibrary}
        onHistory={onHistory}
        onPasteText={pasted}
        previewTools={
          <>
            <ResourceRecovery session={session} />
            <div className="author-preview-tools" ref={setPreviewTools} />
          </>
        }
        notify={notify}
      />
      {insertTarget && (
        <NativeCommandPalette
          session={session}
          after={insertTarget.after}
          onClose={() => setInsertTarget(undefined)}
          onInserted={() => {
            const current = context(session).scenes.find((entry) => entry.scene.id === active.scene.id)!;
            const root = current.scene.nodes.find((node) => node.id === session.getSnapshot().selectedNodeId);
            if (root) {
              const id = nativeDialogueNodes(root)[0]?.id ?? root.id;
              session.setAuthoringSelection(active.scene.id, [id], id);
              setInserted(id);
            }
          }}
        />
      )}
      {inserted && (
        <TaskSheet title={tr("Properties")} wide onClose={() => setInserted(undefined)}>
          {renderInspector(active.scene.id, [inserted])}
        </TaskSheet>
      )}
    </>
  );
}
