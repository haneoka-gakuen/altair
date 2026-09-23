import { isVegaCommandType } from "@haneoka/vega-protocol";
import type { VegaProjectPlugin } from "@haneoka/vega-protocol";

/** Current canonical, plugin-extensible project envelope. */
export const STORY_PROJECT_VERSION = 2 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Opaque source format identifier owned by the importing plugin. */
export type StorySourceFormat = string;

export interface StorySourceLocation {
  format: StorySourceFormat;
  raw?: string;
  line?: number;
  command?: string;
  arguments?: JsonObject;
}

/**
 * The numeric opcode is deliberately separate from `fields`. `fields` is an
 * open JSON object so new player fields and localized arrays survive edits and
 * project saves without changing the canonical project version.
 */
export interface StoryProjectCommand {
  id: string;
  command: number | string | null;
  fields: JsonObject;
  source?: StorySourceLocation;
  extensions: JsonObject;
}

export interface StoryScene {
  id: string;
  name: string;
  commands: StoryProjectCommand[];
  /** Scene-specific authoring data that is not part of the compiled AdvStory. */
  extensions: JsonObject;
}

export interface StoryProjectMeta {
  [key: string]: JsonValue | undefined;
  title: string;
  description?: string;
  locale?: string;
  tags?: string[];
  provenance?: JsonObject;
  extra?: JsonObject;
}

/**
 * Project-owned plugin state. The shared fields intentionally match
 * `VegaProjectPlugin`; `enabled` is an Altair authoring concern and is omitted
 * when a disabled plugin is compiled for Vega.
 */
export interface StoryProjectPlugin extends VegaProjectPlugin {
  readonly enabled?: boolean;
}

export interface StoryProject {
  version: typeof STORY_PROJECT_VERSION;
  meta: StoryProjectMeta;
  entrySceneId: string;
  scenes: StoryScene[];
  /** Project asset state retained losslessly as JSON. */
  assets: JsonObject;
  /** Runtime configuration retained losslessly as JSON. */
  runtime: JsonObject;
  /** Unknown source-document fields retained by an importing plugin. */
  storyFields: JsonObject;
  /**
   * Exact plugin versions and project-local configuration.
   *
   * Optional for compatibility with existing version 2 projects. New projects
   * always include the array.
   */
  plugins?: StoryProjectPlugin[];
  /** Editor/adapter data. External formats must not silently discard this. */
  extensions: JsonObject;
}

const safeIdPart = (value: string | number): string =>
  String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

/** Stable ID for the same imported source and source position. */
export const importedStoryId = (format: string, ...parts: Array<string | number>): string =>
  [safeIdPart(format), ...parts.map(safeIdPart)].join("-");

/** ID for a newly authored scene or command. */
export const createStoryId = (prefix = "item"): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required to create story IDs");
  }
  return `${safeIdPart(prefix)}-${globalThis.crypto.randomUUID()}`;
};

export const cloneStoryValue = <T>(value: T): T => {
  const clone = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone;
  if (clone) {
    try {
      return clone(value);
    } catch {
      // Vue exposes objects stored in `ref()` as proxies. They are still valid
      // JSON authoring data, but the platform structured clone algorithm
      // rejects the proxy wrapper. Fall through to the property-wise clone so
      // IndexedDB autosave always receives plain data.
    }
  }
  if (Array.isArray(value)) return value.map((item) => cloneStoryValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneStoryValue(item)]),
    ) as T;
  }
  return value;
};

const isJsonValue = (value: unknown, active = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || active.has(value)) return false;
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, active))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, active));
  active.delete(value);
  return valid;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);

/**
 * Validate only the canonical StoryProject envelope.
 *
 * Command semantics, resource references, source formats, and runtime fields
 * are intentionally outside this assertion and belong to installed plugins.
 */
export function assertStoryProjectProtocol(value: unknown): asserts value is StoryProject {
  if (!isJsonObject(value)) {
    throw new TypeError("Altair story project must be a JSON object");
  }
  if (value.version !== STORY_PROJECT_VERSION) {
    throw new TypeError(`Altair story project version must be ${STORY_PROJECT_VERSION}`);
  }
  if (!isJsonObject(value.meta) || typeof value.meta.title !== "string") {
    throw new TypeError("Altair story project metadata is invalid");
  }
  if (
    typeof value.entrySceneId !== "string" ||
    !value.entrySceneId.trim() ||
    !Array.isArray(value.scenes) ||
    value.scenes.length === 0
  ) {
    throw new TypeError("Altair story project scene envelope is invalid");
  }
  const sceneIds = new Set<string>();
  const objectIds = new Set<string>();
  for (const scene of value.scenes) {
    if (
      !isJsonObject(scene) ||
      typeof scene.id !== "string" ||
      !scene.id.trim() ||
      typeof scene.name !== "string" ||
      !Array.isArray(scene.commands) ||
      !isJsonObject(scene.extensions)
    ) {
      throw new TypeError("Altair story project contains an invalid scene");
    }
    if (sceneIds.has(scene.id)) {
      throw new TypeError(`Altair story project duplicates scene '${scene.id}'`);
    }
    sceneIds.add(scene.id);
    objectIds.add(scene.id);
    for (const command of scene.commands) {
      if (
        !isJsonObject(command) ||
        typeof command.id !== "string" ||
        !command.id.trim() ||
        (command.command !== null &&
          !isVegaCommandType(command.command) &&
          (typeof command.command !== "number" || !Number.isSafeInteger(command.command) || command.command < 0)) ||
        !isJsonObject(command.fields) ||
        !isJsonObject(command.extensions)
      ) {
        throw new TypeError(`Altair story project scene '${scene.id}' contains an invalid command`);
      }
      if (objectIds.has(command.id)) {
        throw new TypeError(`Altair story project duplicates object '${command.id}'`);
      }
      objectIds.add(command.id);
    }
  }
  if (!sceneIds.has(value.entrySceneId)) {
    throw new TypeError(`Altair story project entry scene '${value.entrySceneId}' does not exist`);
  }
  for (const key of ["assets", "runtime", "storyFields", "extensions"] as const) {
    if (!isJsonObject(value[key])) {
      throw new TypeError(`Altair story project ${key} must be a JSON object`);
    }
  }
  if (
    value.plugins !== undefined &&
    (!Array.isArray(value.plugins) ||
      value.plugins.some(
        (plugin) =>
          !isJsonObject(plugin) ||
          typeof plugin.id !== "string" ||
          !plugin.id.trim() ||
          typeof plugin.version !== "string" ||
          !plugin.version.trim(),
      ))
  ) {
    throw new TypeError("Altair story project plugin metadata is invalid");
  }
}

const createStoryProjectMeta = (meta: Partial<StoryProjectMeta>): StoryProjectMeta => ({
  ...Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, cloneStoryValue(value)]),
  ),
  title: meta.title ?? "",
});

export const createEmptyStoryProject = (meta: Partial<StoryProjectMeta> = {}): StoryProject => ({
  version: STORY_PROJECT_VERSION,
  meta: createStoryProjectMeta(meta),
  entrySceneId: "scene-main",
  scenes: [{ id: "scene-main", name: "Main", commands: [], extensions: {} }],
  assets: {},
  runtime: {},
  storyFields: {},
  plugins: [],
  extensions: {},
});

export const findStoryScene = (project: StoryProject, sceneId = project.entrySceneId): StoryScene | undefined =>
  project.scenes.find((scene) => scene.id === sceneId);
