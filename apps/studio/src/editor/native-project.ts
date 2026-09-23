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
} from "@haneoka/altair-plugin-adv";
import {
  registerWebGalDocumentCommands,
  importWebGalAuthoredWorkspace,
  webGalCommandToAuthoredNode,
} from "@haneoka/altair-plugin-webgal";
import { DEFAULT_STUDIO_PROJECT_PLUGINS } from "../studio-plugin-catalog";
import type { LibraryProject, ProjectFile } from "./library";
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
  const core: Record<string, string> = {
    timeline: "Timeline",
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
    "effect.setTransform": "Transform",
    "effect.setTempAnimation": "Animation",
    "effect.setAnimation": "Animation",
    "effect.setFilter": "Visual filters",
    "effect.pixiPerform": "Visual effect",
    "effect.pixiInit": "Clear WebGAL weather",
  };
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
    runtime: {},
  };
  return {
    id,
    name: title,
    updatedAt: Date.now(),
    files: workspaceFiles({ project, scenes: [scene] }),
  };
}
export async function normalizeImportedProject(project: LibraryProject): Promise<LibraryProject> {
  const manifest = project.files.find((file) => file.path === NATIVE_PROJECT_PATH);
  if (manifest) {
    const parsed = parseAltairProjectDocument(await manifest.blob.text());
    for (const reference of parsed.scenes) {
      const file = project.files.find((file) => file.path === reference.path);
      if (!file) throw new Error(`${reference.path}: ${tr("Scene is missing")}`);
      const scene = parseAltairSceneDocument(await file.blob.text());
      if (scene.id !== reference.id) throw new Error(`${reference.path}: ${tr("Scene id does not match the project")}`);
    }
    return { ...project, id: parsed.id, name: parsed.title };
  }
  const files = await Promise.all(
    project.files.map(async (file) => ({
      path: file.path,
      bytes: new Uint8Array(await file.blob.arrayBuffer()),
    })),
  );
  let workspace: AltairAuthoredWorkspace | undefined;
  let nativeImport = false;
  for (const file of files.filter((file) => file.path.endsWith(".json"))) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(file.bytes));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.commands) || Array.isArray(record._allData)) {
      workspace = storyProjectToAuthoredWorkspace(parseAdvStoryJson(value));
      nativeImport = true;
      break;
    }
  }
  workspace ??= await importWebGalAuthoredWorkspace({
    files,
    signal: new AbortController().signal,
  });
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
      plugins: [
        ...new Map(
          [
            ...DEFAULT_STUDIO_PROJECT_PLUGINS,
            ...(nativeImport ? NATIVE_RUNTIME_PLUGINS : [NATIVE_RUNTIME_PLUGINS[0]!, NATIVE_RUNTIME_PLUGINS[1]!]),
            ...workspace.project.plugins,
          ].map((plugin) => [plugin.id, plugin]),
        ).values(),
      ],
    },
  };
  const retained = models.files.filter(
    (file) =>
      !/(?:^|\/)scene\/.*\.(?:txt|wg|webgal)$/iu.test(file.path) &&
      !["project.wgcp", NATIVE_PROJECT_PATH].includes(file.path),
  );
  return {
    id: native.project.id,
    name: native.project.title,
    updatedAt: Date.now(),
    files: [...workspaceFiles(native), ...retained],
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
  return { project, scenes };
}
export interface EditorStatement {
  readonly id: string;
  readonly node: AltairAuthoredNode;
  readonly line: number;
  readonly name: string;
  readonly kind: "command" | "dialogue" | "comment";
  readonly content: string;
  readonly raw: string;
  readonly arguments: readonly { name: string; value: string | true }[];
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
      node,
      line: lines.get(node.id) ?? 1,
      name: nativeNodeLabel(node),
      kind: node.type.name === "Talk" ? "dialogue" : node.type.name === "note" ? "comment" : "command",
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
