import {
  parseAltairProjectDocument,
  parseAuthoredText,
  parseAltairSceneDocument,
  type AltairAuthoredNode,
  type JsonValue,
} from "@haneoka/altair";
import { advCommandToAuthoredNode, createStoryCommand } from "@haneoka/altair-plugin-adv";
import { assertNativeScriptLocks } from "@haneoka/altair-plugin-webgal/native-script";
import type { EditorSession } from "../session";
import type { StudioModel } from "../authoring/Manuscript";
import type { EditorProposal } from "../proposal";
import { prepareSceneWrite, planStudioChange } from "../authoring/AuthoringSession";
import { NATIVE_PROJECT_PATH } from "../native-project";
import { tr } from "../i18n";
export type AnogoRow =
  | { kind: "background"; value: string }
  | { kind: "narration"; text: string }
  | { kind: "dialogue"; speaker: string; action: string; text: string };
export interface AnogoBindings {
  backgrounds: Record<string, string>;
  speakers: Record<string, string>;
  actions: Record<string, string>;
  roleIds: Record<string, string>;
}
export const anogoActionKey = (speaker: string, action: string) => JSON.stringify([speaker, action]);
export function parseAnogo(source: string): AnogoRow[] {
  let values: unknown;
  try {
    values = parseAuthoredText(
      source
        .trim()
        .replace(/^```(?:json|ya?ml)?\s*\n/iu, "")
        .replace(/\n```\s*$/u, ""),
    );
  } catch {
    throw new Error(tr("ai.anogoInvalid"));
  }
  if (!Array.isArray(values) || values.length > 5000) throw new Error(tr("ai.anogoInvalid"));
  const text = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") throw new Error(tr("ai.anogoInvalid"));
    return String(value);
  };
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(tr("ai.anogoInvalid"));
    const row = value as Record<string, unknown>;
    if (Object.hasOwn(row, "背景") && Object.keys(row).length === 1)
      return { kind: "background", value: text(row.背景) };
    if (Object.hasOwn(row, "旁白") && Object.keys(row).length === 1) return { kind: "narration", text: text(row.旁白) };
    if (
      ["角色", "对话"].every((field) => Object.hasOwn(row, field)) &&
      Object.keys(row).every((field) => ["角色", "动作", "对话"].includes(field))
    )
      return {
        kind: "dialogue",
        speaker: text(row.角色),
        action: row.动作 == null ? "" : text(row.动作),
        text: text(row.对话),
      };
    throw new Error(tr("ai.anogoInvalid"));
  });
}
const flatten = (node: AltairAuthoredNode): AltairAuthoredNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
export function anogoResources(session: EditorSession) {
  const manifest = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)!.text);
  const nodes = manifest.scenes.flatMap((ref) =>
    parseAltairSceneDocument(session.document(ref.path)!.text).nodes.flatMap(flatten),
  );
  const backgrounds = new Set(
    nodes
      .filter((node) => node.type.name === "Stage" && typeof node.arguments.backgroundRef === "string")
      .flatMap((node) => (typeof node.arguments.backgroundRef === "string" ? [node.arguments.backgroundRef] : [])),
  );
  for (const file of session.getSnapshot().files)
    if (
      /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(file.path) &&
      !/(?:\/(?:live2d|textures?|thumbs?|faces?)\/|model3)/iu.test(file.path)
    )
      backgrounds.add(file.path);
  return { nodes, backgrounds: [...backgrounds] };
}
export function defaultAnogoBindings(rows: readonly AnogoRow[], model: StudioModel): AnogoBindings {
  const speakers = Object.create(null) as Record<string, string>,
    roleIds = Object.create(null) as Record<string, string>;
  for (const row of rows)
    if (row.kind === "dialogue") {
      speakers[row.speaker] =
        model.cast.find((member) => member.castId === row.speaker || member.displayName === row.speaker)?.castId ??
        "@text";
      roleIds[row.speaker] ??= `speaker-${crypto.randomUUID()}`;
    }
  return { backgrounds: Object.create(null), speakers, actions: Object.create(null), roleIds };
}
export function prepareAnogo(
  session: EditorSession,
  model: StudioModel,
  source: string,
  rows: readonly AnogoRow[],
  bindings: AnogoBindings,
  placement: "after" | "end" | "replace",
  id: string,
): EditorProposal {
  const state = session.getSnapshot(),
    manifest = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)!.text),
    locale = manifest.locales[0] ?? "ja";
  const sceneId = state.authoringSelection?.sceneId ?? model.activeSceneId,
    ref = manifest.scenes.find((ref) => ref.id === sceneId)!;
  const doc = session.document(ref.path)!,
    original = parseAltairSceneDocument(doc.text);
  if ((original.extensions?.["haneoka.authoring.anogo.applied"] as string[] | undefined)?.includes(id))
    throw new Error(tr("ai.alreadyApplied"));
  let scene = original;
  const selected = state.authoringSelection?.sceneId === sceneId ? state.authoringSelection.lines : [];
  const roots = scene.nodes.filter((root) => flatten(root).some((node) => selected.includes(node.id)));
  const cursorRoot = scene.nodes.find((root) =>
    flatten(root).some((node) => node.id === state.authoringSelection?.cursor),
  );
  let at =
    placement === "end" ? scene.nodes.length : cursorRoot ? scene.nodes.indexOf(cursorRoot) + 1 : scene.nodes.length;
  if (placement === "replace") {
    if (!selected.length) throw new Error(tr("ai.emptyScope"));
    at = scene.nodes.indexOf(roots[0]!);
    const plan = planStudioChange(session, { sceneId, lines: [...selected], change: { kind: "delete" } }, scene);
    if (plan.skippedLocked) throw new Error(tr("ai.locked"));
    scene = plan.scene;
  }
  const resources = anogoResources(session),
    allowedBackgrounds = new Set(["none", ...resources.backgrounds]);
  const additions: AltairAuthoredNode[] = [],
    initialized = new Set<string>();
  const command = (name: Parameters<typeof createStoryCommand>[0], fields: Record<string, JsonValue>) =>
    advCommandToAuthoredNode(createStoryCommand(name, fields));
  for (const row of rows) {
    if (row.kind === "background") {
      const path =
        (Object.hasOwn(bindings.backgrounds, row.value) ? bindings.backgrounds[row.value] : "") ||
        (allowedBackgrounds.has(row.value) ? row.value : "");
      if (!path || !allowedBackgrounds.has(path)) throw new Error(tr("ai.backgroundUnbound", { name: row.value }));
      additions.push(command("Stage", { backgroundRef: path }));
      continue;
    }
    if (row.kind === "narration") {
      additions.push(command("Talk", { text: { [locale]: row.text }, targetName: "", targetTextNames: [] }));
      continue;
    }
    const chosen = bindings.speakers[row.speaker],
      member = model.cast.find((member) => member.castId === chosen);
    const castId = chosen === "@text" ? bindings.roleIds[row.speaker]! : member?.castId;
    if (!castId) throw new Error(tr("ai.characterUnbound", { name: row.speaker }));
    if (member && !initialized.has(castId)) {
      for (const name of ["Character", "In"]) {
        const template = resources.nodes.find(
          (node) => node.type.name === name && node.arguments.targetName === castId,
        );
        if (template) additions.push({ ...structuredClone(template), id: crypto.randomUUID() });
      }
      initialized.add(castId);
    }
    if (row.action.trim()) {
      const action = bindings.actions[anogoActionKey(row.speaker, row.action)];
      if (!action) throw new Error(tr("ai.actionUnbound", { name: row.action }));
      if (action !== "@none") {
        const value = JSON.parse(action) as { motion: string; expression: string };
        if (value.motion || value.expression)
          additions.push(
            command("Motion", {
              targetName: castId,
              ...(value.motion ? { motionName: value.motion } : {}),
              ...(value.expression ? { expressionName: value.expression } : {}),
            }),
          );
      }
    }
    additions.push(
      command("Talk", {
        targetName: castId,
        targetTextNames: [{ [locale]: member?.displayName ?? row.speaker }],
        text: { [locale]: row.text },
      }),
    );
  }
  const previous = original.extensions?.["haneoka.authoring.originals"];
  const next = {
    ...scene,
    nodes: [...scene.nodes.slice(0, at), ...additions, ...scene.nodes.slice(at)],
    extensions: {
      ...scene.extensions,
      "haneoka.authoring.originals": [
        ...(Array.isArray(previous) ? previous : []),
        { format: "anogo", text: source, bindings: bindings as unknown as JsonValue },
      ],
      "haneoka.authoring.anogo.applied": [
        ...((original.extensions?.["haneoka.authoring.anogo.applied"] as string[] | undefined) ?? []),
        id,
      ].slice(-100),
    },
  };
  try {
    assertNativeScriptLocks(original, next);
  } catch {
    throw new Error(tr("ai.locked"));
  }
  return {
    id,
    origin: "prose",
    title: tr("ai.anogoImport"),
    createdAt: new Date().toISOString(),
    changes: [prepareSceneWrite(session, next)],
    detail: tr("ai.lineCount", { count: rows.length }),
    data: { source, bindings, placement },
  };
}
