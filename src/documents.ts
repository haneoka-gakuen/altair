import { parseAuthoredText, serializeAuthoredText } from "./text.js";
import { VEGA_SYSTEM_OPCODE, VEGA_COMMAND_GROUP_OPCODE } from "@haneoka/vega-protocol";
import {
  cloneStoryValue,
  type JsonObject,
  type StoryProject,
  type StoryProjectCommand,
  type StoryProjectPlugin,
} from "./model.js";

export const ALTAIR_PROJECT_FORMAT = "project" as const;
export const ALTAIR_SCENE_FORMAT = "scene" as const;
export interface AltairCommandType {
  readonly plugin: string;
  readonly name: string;
}
export interface AltairAuthoredNode {
  readonly id: string;
  readonly type: AltairCommandType;
  readonly schemaVersion: number;
  readonly arguments: JsonObject;
  readonly disabled?: boolean;
  readonly children?: readonly AltairAuthoredNode[];
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairSceneDocument {
  readonly format: typeof ALTAIR_SCENE_FORMAT;
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly AltairAuthoredNode[];
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairProjectDocument {
  readonly format: typeof ALTAIR_PROJECT_FORMAT;
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly locales: readonly string[];
  readonly entry: { readonly sceneId: string; readonly nodeId?: string };
  readonly scenes: readonly { readonly id: string; readonly path: string }[];
  readonly plugins: readonly StoryProjectPlugin[];
  readonly assets: JsonObject;
  readonly runtime: JsonObject;
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairAuthoredWorkspace {
  readonly project: AltairProjectDocument;
  readonly scenes: readonly AltairSceneDocument[];
}
export interface AltairDocumentCommand {
  readonly type: AltairCommandType;
  readonly schemaVersion: number;
  readonly runtimePlugins?: readonly StoryProjectPlugin[];
  readonly migrate?: (node: AltairAuthoredNode) => AltairAuthoredNode;
  readonly lower: (
    node: AltairAuthoredNode,
    context: {
      readonly project: AltairProjectDocument;
      readonly scene: AltairSceneDocument;
    },
  ) => readonly StoryProjectCommand[];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
};
const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
};
export function altairCommandTypeKey(type: AltairCommandType): string {
  return `${encodeURIComponent(nonempty(type.plugin, "Plugin id"))}:${encodeURIComponent(nonempty(type.name, "Command name"))}`;
}
export function parseAltairSceneDocument(value: unknown): AltairSceneDocument {
  const scene = object(typeof value === "string" ? parseAuthoredText(value) : value);
  if (scene.format !== ALTAIR_SCENE_FORMAT || scene.version !== 1) throw new TypeError("Unsupported scene format");
  nonempty(scene.id, "Scene id");
  nonempty(scene.name, "Scene name");
  if (!Array.isArray(scene.nodes)) throw new TypeError("Scene nodes must be an array");
  const ids = new Set<string>();
  const validate = (nodes: readonly unknown[], depth: number) => {
    if (depth > 64) throw new RangeError("Scene nesting exceeds 64 levels");
    for (const value of nodes) {
      const node = object(value);
      const id = nonempty(node.id, "Node id");
      if (ids.has(id)) throw new TypeError(`Duplicate node id: ${id}`);
      ids.add(id);
      const type = object(node.type);
      altairCommandTypeKey(type as unknown as AltairCommandType);
      if (!Number.isSafeInteger(node.schemaVersion) || Number(node.schemaVersion) < 1)
        throw new TypeError("Invalid command schema version");
      object(node.arguments);
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) throw new TypeError("Node children must be an array");
        validate(node.children, depth + 1);
      }
    }
  };
  validate(scene.nodes, 0);
  return cloneStoryValue(scene) as unknown as AltairSceneDocument;
}
export function parseAltairProjectDocument(value: unknown): AltairProjectDocument {
  const project = object(typeof value === "string" ? parseAuthoredText(value) : value);
  if (project.format !== ALTAIR_PROJECT_FORMAT || project.version !== 1)
    throw new TypeError("Unsupported project format");
  nonempty(project.id, "Project id");
  nonempty(project.title, "Project title");
  if (
    !Array.isArray(project.scenes) ||
    !Array.isArray(project.plugins) ||
    !Array.isArray(project.locales) ||
    project.locales.some((locale) => typeof locale !== "string")
  )
    throw new TypeError("Invalid project manifest");
  const localeIds = new Set<string>();
  for (const locale of project.locales as string[]) {
    let id: string;
    try {
      id = Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0]!;
    } catch {
      throw new TypeError(`Invalid project locale: ${locale}`);
    }
    if (!id || localeIds.has(id)) throw new TypeError(`Invalid or duplicate project locale: ${locale}`);
    localeIds.add(id);
  }
  const pluginIds = new Set<string>();
  for (const value of project.plugins) {
    const plugin = object(value),
      id = nonempty(plugin.id, "Plugin id");
    nonempty(plugin.version, "Plugin version");
    if (pluginIds.has(id)) throw new TypeError(`Duplicate plugin: ${id}`);
    pluginIds.add(id);
  }
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const item of project.scenes) {
    const scene = object(item),
      id = nonempty(scene.id, "Scene id"),
      path = nonempty(scene.path, "Scene path");
    if (
      path.startsWith("/") ||
      /^[a-z]:/iu.test(path) ||
      /[\u0000-\u001f]/u.test(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === ".." || part === ".") ||
      ids.has(id) ||
      paths.has(path)
    )
      throw new TypeError("Invalid or duplicate scene path/id");
    ids.add(id);
    paths.add(path);
  }
  const entry = object(project.entry);
  if (!ids.has(nonempty(entry.sceneId, "Entry scene"))) throw new TypeError("Entry scene is missing");
  object(project.assets);
  object(project.runtime);
  return cloneStoryValue(project) as unknown as AltairProjectDocument;
}
export const serializeAltairDocument = (value: AltairProjectDocument | AltairSceneDocument, source?: string): string =>
  serializeAuthoredText(
    value.format === ALTAIR_PROJECT_FORMAT ? parseAltairProjectDocument(value) : parseAltairSceneDocument(value),
    source,
  );

export class AltairDocumentRegistry {
  private readonly definitions = new Map<string, AltairDocumentCommand>();
  register(definition: AltairDocumentCommand): () => void {
    const key = altairCommandTypeKey(definition.type);
    if (this.definitions.has(key)) throw new Error(`Duplicate command definition: ${key}`);
    this.definitions.set(key, definition);
    return () => {
      if (this.definitions.get(key) === definition) this.definitions.delete(key);
    };
  }
  compile(workspace: AltairAuthoredWorkspace): StoryProject {
    const project = parseAltairProjectDocument(workspace.project),
      sceneById = new Map(workspace.scenes.map((scene) => [scene.id, parseAltairSceneDocument(scene)]));
    if (sceneById.size !== workspace.scenes.length) throw new Error("Duplicate scene document");
    const declaredPlugins = new Set(project.plugins.map((plugin) => plugin.id));
    const runtimePlugins = new Map(project.plugins.map((plugin) => [plugin.id, cloneStoryValue(plugin)]));
    const enabled = new Set(project.plugins.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id));
    const nodeKey = (sceneId: string, nodeId: string) =>
      `altair/${encodeURIComponent(sceneId)}/${encodeURIComponent(nodeId)}`;
    const targets = new Map<string, { sceneId: string; nodeId: string }>();
    const targetKey = (sceneId: string, nodeId: string) => {
      const token = `altair-target:${encodeURIComponent(sceneId)}:${encodeURIComponent(nodeId)}`;
      targets.set(token, { sceneId, nodeId });
      return token;
    };
    const lower = (node: AltairAuthoredNode, scene: AltairSceneDocument): StoryProjectCommand[] => {
      if (node.disabled) return [];
      if (node.type.plugin === "haneoka.altair" && node.schemaVersion !== 1)
        throw new Error(`Unsupported core node schema: ${node.schemaVersion}`);
      if (node.type.plugin === "haneoka.altair" && node.type.name === "timeline") {
        const { tracks, ...settings } = node.arguments;
        if (!Array.isArray(tracks)) throw new TypeError("Timeline tracks must be an array");
        const actions = tracks.flatMap((value) => {
          const track = object(value),
            child = node.children?.find((child) => child.id === track.nodeId);
          if (!child) throw new Error(`Timeline node is missing: ${String(track.nodeId)}`);
          const { nodeId: _, ...timing } = track;
          return lower(child, scene).map((command) => ({
            ...timing,
            command: { ...command.fields, command: command.command },
          }));
        });
        return [
          {
            id: node.id,
            command: VEGA_COMMAND_GROUP_OPCODE,
            fields: {
              ...((node.extensions?.fields as JsonObject) ?? {}),
              key: nodeKey(scene.id, node.id),
              commandGroup: { ...settings, actions: actions as JsonObject[] },
            },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "sequence")
        return (node.children ?? []).flatMap((child) => lower(child, scene));
      if (node.type.plugin === "haneoka.altair" && node.type.name === "note") return [];
      if (node.type.plugin === "haneoka.altair") {
        const control = (
          {
            jump: VEGA_SYSTEM_OPCODE.JumpScene,
            call: VEGA_SYSTEM_OPCODE.CallScene,
            return: VEGA_SYSTEM_OPCODE.ReturnScene,
            end: VEGA_SYSTEM_OPCODE.End,
            branch: VEGA_SYSTEM_OPCODE.Branch,
            setVariable: VEGA_SYSTEM_OPCODE.SetVariable,
            input: VEGA_SYSTEM_OPCODE.Input,
            unlock: VEGA_SYSTEM_OPCODE.Unlock,
            dialogue: VEGA_SYSTEM_OPCODE.SetDialogueVisibility,
          } as Record<string, number>
        )[node.type.name];
        if (control !== undefined) {
          const fields = cloneStoryValue(node.arguments);
          if (node.type.name === "jump" || node.type.name === "call") {
            const target = object(fields.target),
              sceneId = nonempty(target.sceneId, "Target scene");
            if (!sceneById.has(sceneId)) throw new Error(`Target scene is missing: ${sceneId}`);
            if (target.nodeId !== undefined) {
              const nodeId = nonempty(target.nodeId, "Target node"),
                targetScene = sceneById.get(sceneId)!;
              if (!targetScene.nodes.some((node) => node.id === nodeId && !node.disabled))
                throw new Error(`Target node is missing: ${sceneId}/${nodeId}`);
              fields.targetKey = targetKey(sceneId, nodeId);
            }
            delete fields.target;
            fields.sceneId = sceneId;
          }
          if (node.type.name === "branch")
            for (const [argument, prefix] of [
              ["then", "then"],
              ["else", "else"],
            ] as const) {
              const value = fields[argument];
              if (value === undefined) continue;
              const target = object(value),
                sceneId = nonempty(target.sceneId, "Branch scene");
              if (!sceneById.has(sceneId)) throw new Error(`Branch scene is missing: ${sceneId}`);
              if (target.nodeId !== undefined)
                fields[`${prefix}Key`] = targetKey(sceneId, nonempty(target.nodeId, "Branch node"));
              else fields[`${prefix}Scene`] = sceneId;
              delete fields[argument];
            }
          return [
            {
              id: node.id,
              command: control,
              fields: { ...fields, key: nodeKey(scene.id, node.id) },
              extensions: {
                altairNode: { sceneId: scene.id, nodeId: node.id },
              },
            },
          ];
        }
      }
      const key = altairCommandTypeKey(node.type),
        definition = this.definitions.get(key);
      if (!definition || !enabled.has(node.type.plugin)) throw new Error(`Command provider is unavailable: ${key}`);
      const migrated = node.schemaVersion === definition.schemaVersion ? node : definition.migrate?.(node);
      if (
        !migrated ||
        migrated.schemaVersion !== definition.schemaVersion ||
        migrated.id !== node.id ||
        altairCommandTypeKey(migrated.type) !== key
      )
        throw new Error(`Unsupported command schema: ${key}@${node.schemaVersion}`);
      for (const requirement of definition.runtimePlugins ?? []) {
        const existing = runtimePlugins.get(requirement.id);
        if (existing?.enabled === false)
          throw new Error(`Command ${key} requires disabled runtime plugin ${requirement.id}`);
        if (existing && existing.version !== requirement.version)
          throw new Error(
            `Command ${key} requires ${requirement.id}@${requirement.version}, but the project selects ${existing.version}`,
          );
        runtimePlugins.set(requirement.id, {
          ...cloneStoryValue(requirement),
          ...existing,
          required: true,
          ...(!declaredPlugins.has(requirement.id)
            ? { permissions: [...new Set([...(existing?.permissions ?? []), ...(requirement.permissions ?? [])])] }
            : {}),
        });
      }
      return definition.lower(migrated, { project, scene }).map((command, index) => ({
        ...command,
        fields: {
          ...command.fields,
          ...(command.fields.key === undefined
            ? {
                key: nodeKey(scene.id, node.id) + (index === 0 ? "" : `/${index}`),
              }
            : {}),
        },
        id: index === 0 ? node.id : `${node.id}/${index}`,
        extensions: {
          ...command.extensions,
          altairNode: {
            sceneId: scene.id,
            nodeId: node.id,
            type: key,
            schemaVersion: node.schemaVersion,
          },
        },
      }));
    };
    const compiled: StoryProject = {
      version: 2,
      meta: {
        title: project.title,
        ...(project.locales[0] ? { locale: project.locales[0] } : {}),
      },
      entrySceneId: project.entry.sceneId,
      scenes: project.scenes.map((reference) => {
        const scene = sceneById.get(reference.id);
        if (!scene) throw new Error(`Scene is missing: ${reference.id}`);
        return {
          id: scene.id,
          name: scene.name,
          commands: scene.nodes.flatMap((node) => lower(node, scene)),
          extensions: cloneStoryValue(scene.extensions ?? {}),
        };
      }),
      plugins: [...runtimePlugins.values()],
      assets: cloneStoryValue(project.assets),
      runtime: cloneStoryValue(project.runtime),
      storyFields: cloneStoryValue((project.extensions?.storyFields as JsonObject) ?? {}),
      extensions: {
        ...cloneStoryValue(project.extensions ?? {}),
        altairProjectId: project.id,
        altairProjectLocales: [...project.locales],
      },
    };
    const resolveTarget = (value: string): string => {
      const reference = targets.get(value);
      if (!reference) return value;
      const command = compiled.scenes
        .find((scene) => scene.id === reference.sceneId)
        ?.commands.find((command) => command.id === reference.nodeId);
      if (!command || typeof command.fields.key !== "string")
        throw new Error(`Target node is not executable: ${reference.sceneId}/${reference.nodeId}`);
      return `vega:command:${encodeURIComponent(reference.sceneId)}:${encodeURIComponent(command.fields.key)}`;
    };
    for (const scene of compiled.scenes)
      for (const command of scene.commands)
        for (const field of ["targetKey", "thenKey", "elseKey"]) {
          const value = command.fields[field];
          if (typeof value === "string") command.fields[field] = resolveTarget(value);
        }
    if (project.entry.nodeId) {
      const key = resolveTarget(targetKey(project.entry.sceneId, project.entry.nodeId));
      const scene = compiled.scenes.find((scene) => scene.id === project.entry.sceneId)!;
      scene.commands.unshift({
        id: `${project.id}/entry`,
        command: VEGA_SYSTEM_OPCODE.Branch,
        fields: { condition: "true", thenKey: key },
        extensions: {},
      });
    }
    return compiled;
  }
}
