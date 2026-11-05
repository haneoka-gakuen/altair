import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  type AltairSceneDocument,
  type AltairAuthoredNode,
  type JsonObject,
  type StoryProject,
} from "@haneoka/altair";
import {
  planStoryShots,
  planAutomaticStoryShots,
  STORYBOARD_KEY,
  type StoryShot,
  type StoryIntent,
} from "@haneoka/altair-plugin-vega-preview/projection";
import { prepareSceneWrite } from "./authoring/AuthoringSession";
import type { EditorSession } from "./session";
import type { EditorProposal } from "./proposal";
import { NATIVE_PROJECT_PATH } from "./native-project";
import { tr } from "./i18n";
export interface ShotProposal {
  source: { path: string; text: string };
  sceneId: string;
  extensions: JsonObject;
  shots: readonly StoryShot[];
}
export interface ProjectShotProposal {
  kind: "project-shots";
  scenes: ShotProposal[];
}
const flatten = (node: AltairAuthoredNode): AltairAuthoredNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
export const cameraLocked = (node: AltairAuthoredNode) =>
  flatten(node).some((node) => {
    const locks = node.extensions?.["haneoka.authoring.locks"] as JsonObject | undefined;
    return locks?.camera === true || locks?.stage === true;
  });
export function planProtectedShots(
  project: StoryProject,
  authored: AltairSceneDocument,
  options: { start: string; end: string; intent: StoryIntent },
): readonly StoryShot[] {
  const compiled = project.scenes.find((scene) => scene.id === authored.id);
  if (!compiled) throw new Error(tr("ai.targetMissing"));
  const scene = { ...compiled, extensions: authored.extensions ?? {} };
  const bindings = (project.runtime.presentation as JsonObject | undefined)?.bindings as JsonObject | undefined;
  const locks = new Set(authored.nodes.filter(cameraLocked).map((node) => node.id));
  if (!locks.size) return planStoryShots(scene, { ...options, bindings });
  const indexes = new Map(scene.commands.map((command, index) => [command.id, index]));
  const baseline = planAutomaticStoryShots(scene, { bindings, locale: project.meta.locale });
  const temporary = new Set<string>();
  const protectedShots = baseline.map((shot) => {
    const from = indexes.get(shot.start) ?? -1,
      to = indexes.get(shot.end) ?? -1;
    const locked = scene.commands.slice(Math.max(0, from), to + 1).some((command) => locks.has(command.id));
    if (!locked || shot.locked) return shot;
    temporary.add(shot.id);
    return { ...shot, origin: "author" as const, locked: true };
  });
  const planned = planStoryShots(
    {
      ...scene,
      extensions: {
        ...scene.extensions,
        [STORYBOARD_KEY]: { version: 1, shots: protectedShots as unknown as JsonObject[] },
      },
    },
    { ...options, bindings },
  );
  return planned.map((shot) => (temporary.has(shot.id) ? { ...shot, locked: false } : shot));
}
export function shotProposalChange(session: EditorSession, proposal: ShotProposal) {
  const scene = parseAltairSceneDocument(proposal.source.text);
  return prepareSceneWrite(session, {
    ...scene,
    extensions: {
      ...scene.extensions,
      ...proposal.extensions,
      [STORYBOARD_KEY]: {
        version: 1,
        shots: proposal.shots.filter((shot) => shot.origin !== "automatic") as unknown as JsonObject[],
      },
    },
  });
}
export async function cinematicProjectProposal(
  session: EditorSession,
  intent: StoryIntent = "dialogue",
): Promise<EditorProposal> {
  await session.compile();
  const state = session.getSnapshot(),
    project = state.project;
  if (!project || state.error) throw new Error(tr("ai.sourceInvalid"));
  const manifest = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)!.text);
  const scenes: ShotProposal[] = [];
  for (const ref of manifest.scenes) {
    const doc = session.document(ref.path)!,
      scene = parseAltairSceneDocument(doc.text);
    if (!scene.nodes.length) continue;
    const shots = planProtectedShots(project, scene, {
      start: scene.nodes[0]!.id,
      end: scene.nodes.at(-1)!.id,
      intent,
    });
    scenes.push({
      source: { path: doc.path, text: doc.text },
      sceneId: scene.id,
      extensions: scene.extensions ?? {},
      shots,
    });
  }
  const changes = scenes
    .map((scene) => shotProposalChange(session, scene))
    .filter((change) => change.before !== change.after);
  return {
    id: crypto.randomUUID(),
    origin: "storyboard",
    title: tr("ai.projectCinematic"),
    createdAt: new Date().toISOString(),
    changes,
    detail: tr("ai.sceneShotCount", {
      scenes: scenes.length,
      count: scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
    }),
    data: { kind: "project-shots", scenes } satisfies ProjectShotProposal,
  };
}
export function replaceProjectShot(
  session: EditorSession,
  stored: EditorProposal,
  replacement: ShotProposal,
): EditorProposal {
  const bundle = stored.data as ProjectShotProposal;
  const scenes = bundle.scenes.map((scene) => (scene.sceneId === replacement.sceneId ? replacement : scene));
  return {
    ...stored,
    changes: scenes.map((scene) => shotProposalChange(session, scene)),
    data: { kind: "project-shots", scenes } satisfies ProjectShotProposal,
  };
}
