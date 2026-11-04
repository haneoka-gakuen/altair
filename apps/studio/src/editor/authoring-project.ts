import {
  nativePresentationPolicy,
  canonicalizeNativeWorkspace,
  isCanonicalNativeWorkspace,
} from "@haneoka/altair-plugin-vega-preview/projection";
import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  type AltairAuthoredWorkspace,
  type AltairAuthoredNode,
  type JsonObject,
} from "@haneoka/altair/documents";
import {
  nativeScriptReferences,
  nativeScriptWorkspaceFiles,
  nativeScriptRegistry,
  withNativeScriptProviders,
  cleanNativeScriptScene,
  nativeScriptState,
  createNativeScriptDraft,
  rebaseNativeScriptDraft,
  NATIVE_SCRIPT_STATE,
} from "@haneoka/altair-plugin-webgal/native-script";
import type { ProjectFile } from "./library";

export function nativePresentationWorkspace(workspace: AltairAuthoredWorkspace): AltairAuthoredWorkspace {
  if (isCanonicalNativeWorkspace(workspace)) return workspace;
  const object = (value: unknown): JsonObject =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  const settings = object(workspace.project.runtime.presentation);
  const nodes = (values: readonly AltairAuthoredNode[]): AltairAuthoredNode[] =>
    values.flatMap((node) => [node, ...nodes(node.children ?? [])]);
  const models = ["models", "live2d", "characters"]
    .flatMap((key) => {
      const values = workspace.project.assets[key];
      return Array.isArray(values) ? values : Object.values(object(values));
    })
    .concat(
      workspace.scenes.flatMap((scene) =>
        nodes(scene.nodes).map((node) => object(node.extensions?.fields).characterModel ?? null),
      ),
    );
  const baked =
    settings.blockingVersion === 1 && workspace.scenes.every((scene) => scene.extensions?.presentationBaked === true);
  const normalized = nativePresentationPolicy(
    { ...settings, mode: "our-notes", ...(settings.mode === "source" ? { cameraMode: "manual" } : {}) },
    models,
    baked,
    object(workspace.project.extensions?.archiveSource).provider,
  );
  const prepared = withNativeScriptProviders({
    ...workspace,
    project: { ...workspace.project, runtime: { ...workspace.project.runtime, presentation: normalized } },
    scenes: workspace.scenes.map(cleanNativeScriptScene),
  });
  const registry = nativeScriptRegistry();
  const canonical = canonicalizeNativeWorkspace(prepared, registry);
  const sourceStates = new Map(workspace.scenes.map((scene) => [scene.id, nativeScriptState(scene)]));
  if (![...sourceStates.values()].some(Boolean)) return canonical;
  const compiled = registry.compile(canonical);
  return {
    ...canonical,
    scenes: canonical.scenes.map((scene) => {
      const previous = sourceStates.get(scene.id);
      if (!previous) return scene;
      const original = workspace.scenes.find((value) => value.id === scene.id)!;
      let state = previous;
      if (JSON.stringify(cleanNativeScriptScene(original)) !== JSON.stringify(scene)) {
        try {
          state = rebaseNativeScriptDraft(compiled, scene, previous, previous.map.localeIndex);
        } catch {
          state = {
            text: previous.text,
            map: createNativeScriptDraft(compiled, scene, previous.map.localeIndex, previous.map).map,
          };
        }
      }
      return { ...scene, extensions: { ...scene.extensions, [NATIVE_SCRIPT_STATE]: state as unknown as JsonObject } };
    }),
  };
}

export async function authoringProjectFiles(
  files: readonly ProjectFile[],
  documents: readonly { path: string; text: string; baseline?: string }[],
): Promise<ProjectFile[]> {
  const pending = new Map(
    documents
      .filter((doc) => doc.baseline === undefined || doc.text !== doc.baseline)
      .map((doc) => [doc.path, doc.text]),
  );
  const result = new Map(
    files.map((file) => [
      file.path,
      pending.has(file.path) ? { ...file, blob: new Blob([pending.get(file.path)!], { type: "text/plain" }) } : file,
    ]),
  );
  const manifest = result.get("project.yaml");
  if (!manifest) return [...result.values()];
  const originalManifest = await manifest.blob.text();
  const originals = new Map([["project.yaml", originalManifest]]);
  const project = parseAltairProjectDocument(originalManifest);
  const scenes = await Promise.all(
    project.scenes.map(async (reference) => {
      const file = result.get(reference.path);
      if (!file) throw new Error(`File is missing: ${reference.path}`);
      const text = await file.blob.text();
      originals.set(reference.path, text);
      return parseAltairSceneDocument(text);
    }),
  );
  for (const reference of project.scenes) result.delete(reference.path);
  for (const reference of nativeScriptReferences(project)) {
    result.delete(reference.source);
    result.delete(reference.map);
  }
  for (const [path, text] of nativeScriptWorkspaceFiles(nativePresentationWorkspace({ project, scenes }), 0, originals))
    result.set(path, {
      path,
      blob: new Blob([text], { type: path.endsWith(".json") ? "application/json" : "text/plain" }),
    });
  return [...result.values()];
}
