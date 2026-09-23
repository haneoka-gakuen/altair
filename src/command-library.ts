import { parseAuthoredText, serializeAuthoredText } from "./text.js";
import { cloneStoryValue, type JsonObject, type StoryProjectPlugin } from "./model.js";
import {
  altairCommandTypeKey,
  parseAltairSceneDocument,
  type AltairAuthoredNode,
  type AltairCommandType,
} from "./documents.js";

export interface AltairCommandGroup {
  readonly id: string;
  readonly name: string;
  readonly sourceSceneId: string;
  readonly nodes: readonly AltairAuthoredNode[];
  readonly plugins: readonly StoryProjectPlugin[];
  readonly [key: string]: unknown;
}
export interface AltairCommandLibrary {
  readonly format: "commandLibrary";
  readonly version: 1;
  readonly groups: readonly AltairCommandGroup[];
  readonly favorites: readonly AltairCommandType[];
  readonly favoriteGroups?: readonly string[];
  readonly defaults?: readonly { readonly type: AltairCommandType; readonly groupId: string }[];
  readonly [key: string]: unknown;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("A non-empty name is required");
  return value;
};
export function parseAltairCommandLibrary(input: unknown): AltairCommandLibrary {
  const source = record(typeof input === "string" ? parseAuthoredText(input) : input);
  if (source.format !== "commandLibrary" || source.version !== 1)
    throw new TypeError("Unsupported command library format");
  if (!Array.isArray(source.groups) || !Array.isArray(source.favorites))
    throw new TypeError("Invalid command library entries");
  const ids = new Set<string>();
  const groups = source.groups.map((value) => {
    const entry = record(value),
      id = text(entry.id),
      name = text(entry.name),
      sourceSceneId = text(entry.sourceSceneId);
    if (ids.has(id)) throw new TypeError(`Duplicate group id: ${id}`);
    ids.add(id);
    const scene = parseAltairSceneDocument({
      format: "scene",
      version: 1,
      id: sourceSceneId,
      name,
      nodes: entry.nodes,
    });
    if (!Array.isArray(entry.plugins)) throw new TypeError(`Missing plugin requirements: ${name}`);
    const plugins = new Set<string>();
    for (const value of entry.plugins) {
      const plugin = record(value),
        id = text(plugin.id);
      text(plugin.version);
      if (plugins.has(id)) throw new TypeError(`Duplicate plugin: ${id}`);
      plugins.add(id);
    }
    return {
      ...entry,
      id,
      name,
      sourceSceneId,
      nodes: scene.nodes,
    } as unknown as AltairCommandGroup;
  });
  const types = new Set<string>();
  const favorites = source.favorites.map((value) => {
    const type = record(value) as unknown as AltairCommandType,
      key = altairCommandTypeKey(type);
    if (types.has(key)) throw new TypeError(`Duplicate favorite: ${key}`);
    types.add(key);
    return type;
  });
  const favoriteGroups = source.favoriteGroups ?? [];
  if (!Array.isArray(favoriteGroups) || favoriteGroups.some((id) => typeof id !== "string" || !ids.has(id)))
    throw new TypeError("Invalid favorite group reference");
  const defaultTypes = new Set<string>();
  if (source.defaults !== undefined && !Array.isArray(source.defaults)) throw new TypeError("Invalid command defaults");
  const defaults = ((source.defaults ?? []) as unknown[]).map((value) => {
    const entry = record(value),
      type = record(entry.type) as unknown as AltairCommandType;
    const key = altairCommandTypeKey(type),
      groupId = text(entry.groupId);
    if (defaultTypes.has(key) || !ids.has(groupId)) throw new TypeError(`Invalid command default: ${key}`);
    defaultTypes.add(key);
    return { ...entry, type, groupId };
  });
  return cloneStoryValue({
    ...source,
    format: "commandLibrary",
    version: 1,
    groups,
    favorites,
    favoriteGroups,
    defaults,
  }) as AltairCommandLibrary;
}

export function serializeAltairCommandLibrary(library: AltairCommandLibrary, source?: string): string {
  return serializeAuthoredText(parseAltairCommandLibrary(library), source);
}

export interface AltairNodeCloneContext {
  readonly ids: ReadonlyMap<string, string>;
  readonly sourceSceneId: string;
  readonly targetSceneId: string;
}
export function cloneAltairNodeGroup(
  source: readonly AltairAuthoredNode[],
  sourceSceneId: string,
  targetSceneId: string,
  rewriters: ReadonlyMap<string, (node: AltairAuthoredNode, context: AltairNodeCloneContext) => JsonObject> = new Map(),
): AltairAuthoredNode[] {
  const nodes = parseAltairSceneDocument({
    format: "scene",
    version: 1,
    id: sourceSceneId,
    name: "Group",
    nodes: source,
  }).nodes;
  const ids = new Map<string, string>();
  const collect = (node: AltairAuthoredNode) => {
    ids.set(node.id, crypto.randomUUID());
    node.children?.forEach(collect);
  };
  nodes.forEach(collect);
  const context = { ids, sourceSceneId, targetSceneId };
  const copy = (node: AltairAuthoredNode): AltairAuthoredNode => {
    const rewrite = rewriters.get(altairCommandTypeKey(node.type));
    if (node.children?.length && node.type.plugin !== "haneoka.altair" && !rewrite)
      throw new Error(`A clone handler is required for ${node.type.plugin}:${node.type.name}`);
    const args = rewrite ? rewrite(cloneStoryValue(node), context) : cloneStoryValue(node.arguments);
    if (!rewrite && node.type.plugin === "haneoka.altair") {
      if (Array.isArray(args.tracks))
        args.tracks = args.tracks.map((track) =>
          track && typeof track === "object" && !Array.isArray(track) && typeof track.nodeId === "string"
            ? { ...track, nodeId: ids.get(track.nodeId) ?? track.nodeId }
            : track,
        );
      for (const key of ["target", "then", "else"]) {
        const target = args[key];
        if (
          target &&
          typeof target === "object" &&
          !Array.isArray(target) &&
          target.sceneId === sourceSceneId &&
          typeof target.nodeId === "string" &&
          ids.has(target.nodeId)
        )
          args[key] = {
            ...target,
            sceneId: targetSceneId,
            nodeId: ids.get(target.nodeId)!,
          };
      }
    }
    return {
      ...cloneStoryValue(node),
      id: ids.get(node.id)!,
      arguments: args,
      ...(node.children ? { children: node.children.map(copy) } : {}),
    };
  };
  return nodes.map(copy);
}
