import { convertWorkspaceModels } from "@haneoka/altair-plugin-models/models";
import { tr, deviceLanguage, canonicalLanguage } from "./i18n";
import {
  AltairDocumentRegistry,
  serializeAuthoredText,
  authoredNodeLines,
  cloneAltairNodeGroup,
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  serializeAltairDocument,
  type AltairAuthoredNode,
  type AltairAuthoredWorkspace,
  type AltairProjectDocument,
  type AltairSceneDocument,
  type JsonObject,
} from "@haneoka/altair";
import {
  registerAdvDocumentCommands,
  COMMAND_DESCRIPTORS,
  createStoryCommand,
  advCommandToAuthoredNode,
  storyProjectToAuthoredWorkspace,
  parseAdvStoryJson,
  parseStoryProjectJson,
} from "@haneoka/altair-plugin-adv";
import {
  importBestdoriScenario,
  importSekaiScenario,
  isBestdoriCommunitySource,
  importBestdoriCommunityStory,
} from "@haneoka/altair-plugin-bestdori";
import { restoreStoryProjectFromVegaProject } from "@haneoka/altair-plugin-vega-preview/projection";
import { parseVegaProject } from "@haneoka/vega-protocol";
import {
  registerWebGalDocumentCommands,
  importWebGalAuthoredWorkspace,
  webGalCommandToAuthoredNode,
  WEBGAL_WORKSPACE_LIMITS,
  normalizeWebGalWorkspacePath,
} from "@haneoka/altair-plugin-webgal";
import { DEFAULT_STUDIO_PROJECT_PLUGINS } from "../studio-plugin-catalog";
import { HANEOKA_STAGE_GEOMETRY } from "@haneoka/vega-plugin-haneoka/scene-profile";
import { projectLibrary, type LibraryProject, type ProjectFile } from "./library";
import { readLocalizedText } from "./localized-text";
import {
  resolveNativeScriptWorkspace,
  nativeScriptReferences,
  nativeScriptRegistry,
  createNativeScriptDraft,
  parseNativeScriptMap,
  NATIVE_SCRIPT_FILES,
  NATIVE_SCRIPT_STATE,
} from "@haneoka/altair-plugin-webgal/native-script";
import { nativePresentationWorkspace } from "./authoring-project";
export const NATIVE_RUNTIME_PLUGINS = [
  { id: "haneoka.cubism", version: "0.1.0", permissions: ["render:webgl", "audio:analysis"] },
  { id: "haneoka.composite", version: "0.1.0", permissions: ["render:webgl"] },
  { id: "haneoka.vega-richtext", version: "0.1.0", permissions: ["ui:dom"] },
  { id: "haneoka.vega-portable-ui", version: "0.1.0", permissions: ["ui:dom"] },
  {
    id: "haneoka.vega-shell-default",
    version: "0.1.0",
    permissions: ["ui:dom"],
  },
  {
    id: "haneoka.renderer-three",
    version: "0.1.0",
    permissions: ["render:webgl"],
  },
  { id: "haneoka.theme", version: "0.1.0", permissions: ["ui:dom"] },
];
export const NATIVE_PROJECT_PATH = "project.yaml";
export const webGalWeatherLabels: Readonly<Record<string, string>> = {
  rain: "Rain",
  snow: "Snow",
  "heavy-snow": "Heavy snow",
  petals: "Cherry blossoms",
  clear: "Clear WebGAL weather",
};
export const nativeScenePath = (path: string) => /\.scene\.ya?ml$/iu.test(path);
export const nativeCommands = COMMAND_DESCRIPTORS.map((command) => ({
  ...command,
  get label() {
    return tr(`command.${command.name}`, { defaultValue: command.label });
  },
  fields: command.fields.map((field) => ({
    ...field,
    choices: field.choices?.map((choice) => ({
      ...choice,
      get label() {
        return tr(`choice.${choice.label}`, { defaultValue: choice.label });
      },
    })),
    get label() {
      return tr(`field.${command.name}.${field.key}`, {
        defaultValue: field.label,
      });
    },
  })),
  initial: () => ({
    ...advCommandToAuthoredNode(createStoryCommand(command.name)),
    id: crypto.randomUUID(),
  }),
}));
export function nativeNodeLabel(node: AltairAuthoredNode): string {
  const descriptor = nativeCommands.find(
    (command) => node.type.plugin === "haneoka.altair-adv" && command.name === node.type.name,
  );
  if (descriptor) return descriptor.label;
  if (node.type.plugin === "haneoka.altair" && node.type.name === "propertyClip") {
    const clip = node.arguments.clip;
    const tracks =
      clip && typeof clip === "object" && !Array.isArray(clip) && Array.isArray(clip.tracks) ? clip.tracks : [];
    const channels = tracks.map((track) =>
      track && typeof track === "object" && !Array.isArray(track) ? String(track.channel) : "",
    );
    const label =
      node.arguments.target === "scene-camera"
        ? "Camera"
        : String(node.arguments.target).startsWith("volume:")
          ? "Visual effect"
          : channels.some((key) => key.startsWith("head"))
            ? "Head direction"
            : channels.includes("bodyAngle")
              ? "Body direction"
              : channels.some((key) => key.startsWith("look"))
                ? "Gaze"
                : channels.some((key) => key.startsWith("world"))
                  ? "Position"
                  : channels.includes("alpha")
                    ? "Opacity"
                    : "Animation curves";
    return tr(label);
  }
  const core: Record<string, string> = {
    timeline: "Timeline",
    audioClip: "Audio clip",
    sequence: "Sequence",
    note: "Note",
    jump: "Jump to scene",
    call: "Call scene",
    return: "Return",
    end: "End story",
    branch: "Conditional branch",
    setVariable: "Set variable",
    input: "Text input",
    unlock: "Unlock gallery item",
    dialogue: "Dialogue visibility",
  };
  const effects: Record<string, string> = {
    "effect.dialoguePortrait": "Dialogue portrait",
    "effect.figureDiff": "Portrait difference",
    "effect.intro": "Fullscreen text",
    "effect.setTransform": "Transform",
    "effect.setTempAnimation": "Animation",
    "effect.setTempAnimationV2": "Animation",
    "effect.setAnimation": "Animation",
    "effect.setFilter": "Visual filters",
    "effect.pixiPerform": "Visual effect",
    "effect.pixiInit": "Clear WebGAL weather",
  };
  const system: Record<string, string> = {
    SetVariable: "Set variable",
    Branch: "Conditional branch",
    JumpScene: "Jump to scene",
    CallScene: "Call scene",
    ReturnScene: "Return",
    Input: "Text input",
    Unlock: "Unlock gallery item",
    FlowCheckpoint: "Checkpoint",
    SetSetting: "Setting",
    End: "End story",
    SceneMarker: "Scene",
    SetDialogueVisibility: "Dialogue visibility",
  };
  if (node.type.plugin === "haneoka.altair-webgal" && node.type.name.startsWith("system."))
    return tr(system[node.type.name.slice(7)] ?? "System");
  if (node.type.plugin === "haneoka.altair" && core[node.type.name]) return tr(core[node.type.name]!);
  if (node.type.plugin === "haneoka.altair-webgal" && effects[node.type.name]) return tr(effects[node.type.name]!);
  return node.type.name.replace(/^(?:effect|system)\./u, "");
}
export function newNativeScene(name: string): AltairSceneDocument {
  return {
    format: "scene",
    version: 1,
    id: crypto.randomUUID(),
    name,
    nodes: [],
  };
}
export function workspaceFiles(workspace: AltairAuthoredWorkspace): ProjectFile[] {
  return [
    {
      path: NATIVE_PROJECT_PATH,
      blob: new Blob([serializeAltairDocument(workspace.project)], {
        type: "application/yaml",
      }),
    },
    ...workspace.scenes.map((scene) => ({
      path: workspace.project.scenes.find((reference) => reference.id === scene.id)!.path,
      blob: new Blob([serializeAltairDocument(scene)], {
        type: "application/yaml",
      }),
    })),
  ];
}
export function createNativeProject(title: string, locale = deviceLanguage()): LibraryProject {
  locale = canonicalLanguage(locale);
  const id = crypto.randomUUID(),
    scene = {
      ...newNativeScene(tr("Opening")),
      nodes: [
        {
          ...advCommandToAuthoredNode(
            createStoryCommand("Talk", {
              text: { [locale]: tr("Welcome to your new story.") },
              targetTextNames: [{ [locale]: tr("Character") }],
            }),
          ),
          id: crypto.randomUUID(),
        },
      ],
    };
  const project: AltairProjectDocument = {
    format: "project",
    version: 1,
    id,
    title,
    locales: [locale],
    entry: { sceneId: scene.id },
    scenes: [{ id: scene.id, path: "scenes/opening.scene.yaml" }],
    plugins: [...DEFAULT_STUDIO_PROJECT_PLUGINS, ...NATIVE_RUNTIME_PLUGINS],
    assets: {},
    runtime: {
      stage: JSON.parse(JSON.stringify(HANEOKA_STAGE_GEOMETRY)) as JsonObject,
      presentation: { mode: "our-notes", version: 2, blocking: "native", cameraMode: "automatic" },
    },
  };
  return {
    id,
    name: title,
    updatedAt: Date.now(),
    files: workspaceFiles({ project, scenes: [scene] }),
  };
}
export async function normalizeImportedProject(project: LibraryProject): Promise<LibraryProject> {
  if (
    project.files.length > WEBGAL_WORKSPACE_LIMITS.files ||
    project.files.reduce((size, file) => size + file.blob.size, 0) > WEBGAL_WORKSPACE_LIMITS.totalBytes
  )
    throw new Error(tr("The imported project exceeds workspace limits"));
  for (const file of project.files) normalizeWebGalWorkspacePath(file.path);
  const manifest = project.files.find((file) => file.path === NATIVE_PROJECT_PATH);
  if (manifest) {
    if (manifest.blob.size > 16 * 1024 ** 2) return project;
    let parsed;
    try {
      parsed = parseAltairProjectDocument(await manifest.blob.text());
    } catch {
      return project;
    }
    const references = nativeScriptReferences(parsed);
    if (references.length) {
      const byPath = new Map(project.files.map((file) => [file.path, file]));
      const read = async (path: string) => {
        const file = byPath.get(path);
        if (!file) throw new Error(`${path}: ${tr("File is missing")}`);
        if (file.blob.size > WEBGAL_WORKSPACE_LIMITS.sceneBytes)
          throw new Error(tr("The imported source document is too large"));
        return file.blob.text();
      };
      const scenes = await Promise.all(
        parsed.scenes.map(async (ref) => parseAltairSceneDocument(await read(ref.path))),
      );
      const sources = new Map(
        await Promise.all(
          references.flatMap((ref) => [ref.source, ref.map]).map(async (path) => [path, await read(path)] as const),
        ),
      );
      const maps = new Map(
        references.map((ref) => [ref.sceneId, parseNativeScriptMap(JSON.parse(sources.get(ref.map)!))]),
      );
      let resolved: AltairAuthoredWorkspace;
      let compiled: ReturnType<AltairDocumentRegistry["compile"]> | undefined;
      try {
        resolved = resolveNativeScriptWorkspace({ project: parsed, scenes }, sources);
        compiled = nativeScriptRegistry().compileDraft(resolved);
      } catch {
        resolved = { project: parsed, scenes };
      }
      const { [NATIVE_SCRIPT_FILES]: _, ...extensions } = parsed.extensions ?? {};
      const embedded = resolved.scenes.map((scene) => {
        const ref = references.find((ref) => ref.sceneId === scene.id);
        return ref
          ? {
              ...scene,
              extensions: {
                ...scene.extensions,
                [NATIVE_SCRIPT_STATE]: {
                  text: sources.get(ref.source)!,
                  map: (compiled
                    ? createNativeScriptDraft(compiled, scene, maps.get(scene.id)!.localeIndex, maps.get(scene.id)).map
                    : maps.get(scene.id)!) as unknown as JsonObject,
                },
              },
            }
          : scene;
      });
      const replaced = new Set([
        NATIVE_PROJECT_PATH,
        ...parsed.scenes.map((ref) => ref.path),
        ...references.flatMap((ref) => [ref.source, ref.map]),
      ]);
      project = {
        ...project,
        files: [
          ...workspaceFiles({ project: { ...parsed, extensions }, scenes: embedded }),
          ...project.files.filter((file) => !replaced.has(file.path)),
        ],
      };
    }
    const currentManifest = project.files.find((file) => file.path === NATIVE_PROJECT_PATH)!;
    const currentText = await currentManifest.blob.text();
    const currentProject = parseAltairProjectDocument(currentText);
    const currentFiles = new Map(project.files.map((file) => [file.path, file]));
    const currentScenes = await Promise.all(
      currentProject.scenes.map(async (ref) => parseAltairSceneDocument(await currentFiles.get(ref.path)!.blob.text())),
    );
    const canonical = nativePresentationWorkspace({ project: currentProject, scenes: currentScenes });
    if (
      canonical.project !== currentProject ||
      canonical.scenes.some((scene, index) => scene !== currentScenes[index])
    ) {
      const replacement = new Map([[NATIVE_PROJECT_PATH, serializeAltairDocument(canonical.project, currentText)]]);
      for (const scene of canonical.scenes) {
        const ref = canonical.project.scenes.find((ref) => ref.id === scene.id)!;
        const original = await currentFiles.get(ref.path)!.blob.text();
        if (JSON.stringify(scene) !== JSON.stringify(currentScenes.find((value) => value.id === scene.id)))
          replacement.set(ref.path, serializeAltairDocument(scene, original));
      }
      project = {
        ...project,
        files: project.files.map((file) =>
          replacement.has(file.path)
            ? { ...file, blob: new Blob([replacement.get(file.path)!], { type: "application/yaml" }) }
            : file,
        ),
      };
    }
    return protectImportedIdentity(project.id, { ...project, id: parsed.id, name: parsed.title });
  }
  let workspace: AltairAuthoredWorkspace | undefined;
  let nativeImport = false;
  let foreignPresentation = false;
  for (const file of project.files.filter((file) => /\.(?:json|asset)$/iu.test(file.path))) {
    // Runtime models and binary assets remain Blobs; only candidate story JSON is decoded here.
    if (file.blob.size > WEBGAL_WORKSPACE_LIMITS.sceneBytes) continue;
    let value: unknown;
    try {
      value = JSON.parse(await file.blob.text());
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const { isOpenotesProject } = await import("@haneoka/altair-plugin-haneoka/openotes");
    if (isOpenotesProject(value)) {
      const [{ importOpenotesSource }, { studioEnvironment }] = await Promise.all([
        import("./source-project-import"),
        import("./studio-host"),
      ]);
      const environment = studioEnvironment();
      const captured = await importOpenotesSource(
        value,
        environment.origin ?? location.origin,
        new AbortController().signal,
        project.files,
        environment.locale,
      );
      return normalizeImportedProject({ ...captured, directory: project.directory });
    }
    if (Array.isArray(record.Snippets)) {
      foreignPresentation = true;
      workspace = storyProjectToAuthoredWorkspace(importSekaiScenario(value).project);
      nativeImport = true;
      break;
    }
    if (isBestdoriCommunitySource(value)) {
      foreignPresentation = true;
      const [{ importCommunitySource }, { studioEnvironment }] = await Promise.all([
        import("./source-project-import"),
        import("./studio-host"),
      ]);
      const captured = await importCommunitySource(
        value,
        studioEnvironment().origin ?? location.origin,
        new AbortController().signal,
        studioEnvironment().locale,
      );
      return normalizeImportedProject({ ...captured, directory: project.directory });
    }
    if (record.Base && typeof record.Base === "object") {
      foreignPresentation = true;
      workspace = storyProjectToAuthoredWorkspace(importBestdoriScenario(value).project);
      nativeImport = true;
      break;
    }
    if (record.version === 2 && Array.isArray(record.scenes)) {
      workspace = storyProjectToAuthoredWorkspace(parseStoryProjectJson(value), webGalCommandToAuthoredNode);
      nativeImport = true;
      break;
    }
    if (record.format === "vega-project") {
      workspace = storyProjectToAuthoredWorkspace(
        restoreStoryProjectFromVegaProject(parseVegaProject(value)),
        webGalCommandToAuthoredNode,
      );
      nativeImport = true;
      break;
    }
    if (Array.isArray(record.commands) || Array.isArray(record._allData)) {
      workspace = storyProjectToAuthoredWorkspace(parseAdvStoryJson(value));
      nativeImport = true;
      break;
    }
  }
  if (!workspace) {
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const file of project.files.filter(
      (file) => /\.(?:txt|wg|webgal|wgcp)$/iu.test(file.path) || /(?:^|\/)animation\/.*\.json$/iu.test(file.path),
    )) {
      if (file.blob.size > WEBGAL_WORKSPACE_LIMITS.sceneBytes)
        throw new Error(tr("The imported source document is too large"));
      files.push({ path: file.path, bytes: new Uint8Array(await file.blob.arrayBuffer()) });
    }
    workspace = await importWebGalAuthoredWorkspace({ files, signal: new AbortController().signal });
  }
  const models = await convertWorkspaceModels(workspace, project.files);
  workspace = models.workspace;
  const config = workspace.project.extensions?.webgalConfig;
  const values = config && typeof config === "object" && !Array.isArray(config) ? config.values : undefined;
  const hasConfiguredTitle =
    values &&
    typeof values === "object" &&
    !Array.isArray(values) &&
    Object.entries(values).some(
      ([key, value]) => key.toLowerCase() === "game_name" && typeof value === "string" && value.trim(),
    );
  const native = {
    ...workspace,
    project: {
      ...workspace.project,
      title: hasConfiguredTitle ? workspace.project.title : project.name,
      ...(!nativeImport || foreignPresentation
        ? {
            runtime: {
              ...workspace.project.runtime,
              presentation: {
                mode: "our-notes",
                managedPlugins: NATIVE_RUNTIME_PLUGINS.filter(
                  (plugin) => !workspace.project.plugins.some((current) => current.id === plugin.id),
                ).map((plugin) => plugin.id),
              },
            },
          }
        : {}),
      plugins: [
        ...new Map(
          [...DEFAULT_STUDIO_PROJECT_PLUGINS, ...NATIVE_RUNTIME_PLUGINS, ...workspace.project.plugins].map((plugin) => [
            plugin.id,
            plugin,
          ]),
        ).values(),
      ],
    },
  };
  const retained = models.files.filter(
    (file) =>
      !/(?:^|\/)scene\/.*\.(?:txt|wg|webgal)$/iu.test(file.path) &&
      !["project.wgcp", NATIVE_PROJECT_PATH].includes(file.path),
  );
  return protectImportedIdentity(project.id, {
    id: native.project.id,
    name: native.project.title,
    updatedAt: Date.now(),
    files: [...workspaceFiles(nativePresentationWorkspace(native)), ...retained],
    directories: project.directories,
  });
}

async function protectImportedIdentity(originalId: string, imported: LibraryProject): Promise<LibraryProject> {
  if (originalId === imported.id || !(await projectLibrary.get(imported.id))) return imported;
  const id = crypto.randomUUID(),
    name = `${imported.name} (${tr("Imported copy")})`;
  const manifest = imported.files.find((file) => file.path === NATIVE_PROJECT_PATH)!;
  const source = await manifest.blob.text();
  const project = parseAltairProjectDocument(source);
  // Scene/node IDs are scoped to their project and keep all existing internal references.
  return {
    ...imported,
    directory: undefined,
    id,
    name,
    files: imported.files.map((file) =>
      file.path === NATIVE_PROJECT_PATH
        ? {
            ...file,
            blob: new Blob([serializeAltairDocument({ ...project, id, title: name }, source)], {
              type: manifest.blob.type || "application/yaml",
            }),
          }
        : file,
    ),
  };
}
export function readNativeWorkspace(documents: readonly { path: string; text: string }[]): AltairAuthoredWorkspace {
  const read = <T>(path: string, parse: (source: string) => T): T => {
    const doc = documents.find((doc) => doc.path === path);
    if (!doc) throw new Error(`${path}: ${tr("File is missing")}`);
    try {
      return parse(doc.text);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const project = read(NATIVE_PROJECT_PATH, parseAltairProjectDocument);
  const scenes = project.scenes.map((reference) => {
    const scene = read(reference.path, parseAltairSceneDocument);
    if (scene.id !== reference.id) throw new Error(`${reference.path}: ${tr("Scene id does not match the project")}`);
    return scene;
  });
  return resolveNativeScriptWorkspace({ project, scenes }, new Map(documents.map((doc) => [doc.path, doc.text])));
}
export interface EditorStatement {
  readonly id: string;
  readonly sceneId?: string;
  readonly node: AltairAuthoredNode;
  readonly line: number;
  readonly name: string;
  readonly kind: "command" | "dialogue" | "comment";
  readonly content: string;
  readonly raw: string;
  readonly arguments: readonly { name: string; value: string | true }[];
  readonly dialogue?: AltairAuthoredNode;
}
export function nativeDialogueNodes(node: AltairAuthoredNode): AltairAuthoredNode[] {
  if (node.type.plugin === "haneoka.altair-adv" && node.type.name === "Talk") return [node];
  const tracks = Array.isArray(node.arguments.tracks) ? node.arguments.tracks : [];
  const times = new Map(
    tracks.flatMap((track) =>
      track && typeof track === "object" && !Array.isArray(track)
        ? [[track.nodeId, Number(track.atSeconds ?? 0)] as const]
        : [],
    ),
  );
  return [...(node.children ?? [])]
    .sort((left, right) => (times.get(left.id) ?? 0) - (times.get(right.id) ?? 0))
    .flatMap(nativeDialogueNodes);
}
export function nativeStatementIsVisible(node: AltairAuthoredNode): boolean {
  if (node.extensions?.["haneoka.authoring.explicit"] || nativeDialogueNodes(node).length) return true;
  if (node.children?.length) return node.children.some(nativeStatementIsVisible);
  return /^(?:Stage|FadeIn|FadeOut|Still|Movie|Clip|Location|Subtitles|ChatWindow|ChatTalk|ChatStamp|ChatTyping|ChatRead|ChoiceSet|ChoiceShow|GoTo|Wait|end|jump|call|return|branch|setVariable|input|unlock|SetVariable|JumpScene|CallScene|ReturnScene|Branch|Input)$/u.test(
    node.type.name.replace(/^system\./u, ""),
  );
}
export function nativeNodeExcerpt(node: AltairAuthoredNode, locale: string): string {
  const dialogue = nativeDialogueNodes(node)[0];
  return readLocalizedText(dialogue?.arguments.text ?? node.arguments.text ?? node.arguments.targetName, locale);
}
export function nativeStatements(text: string): readonly EditorStatement[] {
  let scene: AltairSceneDocument;
  try {
    scene = parseAltairSceneDocument(text);
  } catch {
    return [];
  }
  const lines = authoredNodeLines(text);
  return scene.nodes.map((node) => {
    const dialogue = nativeDialogueNodes(node)[0];
    const descriptor = nativeCommands.find(
      (command) => command.name === node.type.name && node.type.plugin === "haneoka.altair-adv",
    );
    const perform = node.arguments.perform;
    const weather =
      node.type.plugin === "haneoka.altair-webgal" &&
      node.type.name === "effect.pixiPerform" &&
      perform &&
      typeof perform === "object" &&
      !Array.isArray(perform) &&
      typeof perform.action === "string"
        ? tr(webGalWeatherLabels[perform.action] ?? perform.action)
        : undefined;
    const primary =
      weather ??
      (descriptor?.primaryField
        ? node.arguments[descriptor.primaryField]
        : (node.arguments.text ?? node.arguments.content));
    const summary = (value: unknown): string =>
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.map(summary).filter(Boolean).join(" / ")
          : value == null
            ? ""
            : JSON.stringify(value);
    return {
      id: node.id,
      sceneId: scene.id,
      node,
      line: lines.get(node.id) ?? 1,
      name: nativeNodeLabel(node),
      kind: dialogue ? "dialogue" : node.type.name === "note" ? "comment" : "command",
      ...(dialogue ? { dialogue } : {}),
      content:
        node.type.plugin === "haneoka.altair" && node.type.name === "timeline"
          ? tr("{{count}} cues", { count: node.children?.length ?? 0 })
          : summary(primary) || nativeNodeLabel(node),
      raw: serializeAuthoredText(node),
      arguments: [],
    };
  });
}
export function updateNativeNode(
  text: string,
  id: string,
  update: (node: AltairAuthoredNode) => AltairAuthoredNode,
): string {
  const scene = parseAltairSceneDocument(text);
  let found = false;
  const visit = (node: AltairAuthoredNode): AltairAuthoredNode => {
    if (node.id === id) {
      found = true;
      return update(node);
    }
    return node.children ? { ...node, children: node.children.map(visit) } : node;
  };
  const nodes = scene.nodes.map(visit);
  if (!found) throw new Error(tr("The statement was deleted or moved"));
  return serializeAltairDocument({ ...scene, nodes }, text);
}

export function copyNativeNode(source: AltairAuthoredNode, sceneId: string): AltairAuthoredNode {
  return cloneAltairNodeGroup([source], sceneId, sceneId)[0]!;
}
