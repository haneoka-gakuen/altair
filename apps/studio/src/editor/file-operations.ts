import {
  parseAuthoredText,
  serializeAuthoredText,
  parseAltairSceneDocument,
  serializeAltairDocument,
  cloneAltairNodeGroup,
  type JsonValue,
  type AltairAuthoredNode,
} from "@haneoka/altair";
import { normalizeBrowserWorkspacePath } from "@haneoka/altair-plugin-workspace-browser";
import type { ProjectFile } from "./library";

const resourceFields = new Set([
  "path",
  "source",
  "sourcePath",
  "url",
  "src",
  "texture",
  "textures",
  "model",
  "modelUrl",
  "imageUrl",
  "playableUrl",
  "videoUrl",
  "atlas",
  "skeleton",
  "moc",
  "physics",
  "pose",
  "userData",
  "motionSync",
  "backgroundRef",
  "stillRef",
  "frameRef",
  "bgmRef",
  "seRef",
  "voiceRefs",
  "videoRef",
  "live2dKey",
  "files",
  "directories",
  "directory",
  "Moc",
  "Textures",
  "Physics",
  "Pose",
  "UserData",
  "File",
]);

export function projectFilePath(path: string): string {
  const normalized = normalizeBrowserWorkspacePath(path);
  if (normalized !== path || /[\u0000-\u001f\u007f]/u.test(path)) throw new TypeError(`Invalid project path: ${path}`);
  return normalized;
}

function resolveRelative(document: string, reference: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(reference)) return undefined;
  const parts = document.split("/").slice(0, -1);
  for (const part of reference.split("/")) {
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function relativePath(document: string, reference: string): string {
  const directory = document.split("/").slice(0, -1),
    target = reference.split("/");
  let same = 0;
  while (same < directory.length && directory[same] === target[same]) same++;
  return [...directory.slice(same).map(() => ".."), ...target.slice(same)].join("/");
}

export interface ProjectPathMove {
  readonly files: readonly ProjectFile[];
  readonly documents: readonly { path: string; text: string }[];
  readonly paths: ReadonlyMap<string, string>;
  readonly changedReferences: readonly string[];
  readonly warnings: readonly string[];
  readonly directories: readonly string[];
}

/** Include implicit parents so empty and populated directories share one path model. */
export function projectDirectories(files: readonly ProjectFile[], directories: readonly string[] = []): string[] {
  const result = new Set<string>();
  for (const path of [...directories, ...files.map((file) => file.path.split("/").slice(0, -1).join("/"))]) {
    if (!path) continue;
    projectFilePath(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) result.add(parts.slice(0, i).join("/"));
  }
  for (const file of files) if (result.has(file.path)) throw new TypeError(`Project path already exists: ${file.path}`);
  return [...result].sort();
}

/** Prepares a move and rewrites known resource fields in authored YAML and JSON. */
export function planProjectPathMove(
  files: readonly ProjectFile[],
  documents: readonly { path: string; text: string }[],
  source: string,
  target: string,
  directories: readonly string[] = [],
): ProjectPathMove {
  source = projectFilePath(source);
  target = projectFilePath(target);
  if (source === "project.yaml" || target === "project.yaml") throw new TypeError("The project manifest path is fixed");
  if (/\.scene\.ya?ml$/iu.test(source) && !/\.scene\.ya?ml$/iu.test(target))
    throw new TypeError("Scene files must end in .scene.yaml or .scene.yml");
  if (source === target || target.startsWith(`${source}/`)) throw new TypeError("Move target is inside its source");
  const paths = new Map(
    files
      .filter((file) => file.path === source || file.path.startsWith(`${source}/`))
      .map((file) => [file.path, target + file.path.slice(source.length)]),
  );
  const folders = projectDirectories(files, directories);
  const sourceIsDirectory = folders.includes(source);
  if (!paths.size && !sourceIsDirectory) throw new TypeError(`Project path is missing: ${source}`);
  if (files.some((file) => file.path === target) || folders.includes(target))
    throw new TypeError(`Project path already exists: ${target}`);
  if (files.some((file) => target.startsWith(`${file.path}/`)))
    throw new TypeError(`Project path already exists: ${target}`);
  const occupied = files.filter((file) => !paths.has(file.path)).map((file) => file.path);
  for (const destination of paths.values()) {
    if (
      occupied.some(
        (path) => path === destination || path.startsWith(`${destination}/`) || destination.startsWith(`${path}/`),
      )
    )
      throw new TypeError(`Project path already exists: ${destination}`);
  }
  const movePath = (path: string): string =>
    paths.get(path) ?? (path === source || path.startsWith(`${source}/`) ? target + path.slice(source.length) : path);
  const changedReferences = new Set<string>(),
    warnings: string[] = [];
  const rewritten = documents.map((document) => {
    const nextPath = movePath(document.path);
    const yaml = /\.ya?ml$/iu.test(document.path),
      json = /\.json$/iu.test(document.path);
    if (!yaml && !json) {
      if (/\.(?:js|css|html|atlas)$/iu.test(document.path)) warnings.push(document.path);
      return { path: nextPath, text: document.text };
    }
    const relative = /(?:\.model3?\.json$|\.model\.ya?ml$|(?:^|\/)model\.ya?ml$)/iu.test(document.path);
    const value: JsonValue = yaml ? parseAuthoredText(document.text) : JSON.parse(document.text);
    let changed = false;
    const visit = (value: JsonValue, field = "", projectRoot = !relative): JsonValue => {
      if (typeof value === "string" && resourceFields.has(field)) {
        // Project/scene references use the project root; model files use their own directory.
        const root = projectRoot ? value : resolveRelative(document.path, value);
        if (!root) return value;
        const moved = movePath(root);
        if (moved === root && nextPath === document.path) return value;
        const next = projectRoot ? moved : relativePath(nextPath, moved);
        if (next !== value) {
          changed = true;
          changedReferences.add(document.path);
        }
        return next;
      }
      if (Array.isArray(value)) return value.map((item) => visit(item, field, projectRoot));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            visit(
              item,
              key,
              projectRoot ||
                (value.options &&
                  typeof value.options === "object" &&
                  !Array.isArray(value.options) &&
                  value.options.projectRoot === true) ||
                false,
            ),
          ]),
        );
      return value;
    };
    const next = visit(value);
    return {
      path: nextPath,
      text: changed
        ? yaml
          ? serializeAuthoredText(next, document.text)
          : JSON.stringify(next, null, 2) + "\n"
        : document.text,
    };
  });
  const texts = new Map(rewritten.map((document) => [document.path, document.text]));
  return {
    files: files.map((file) => {
      const path = movePath(file.path),
        text = texts.get(path);
      return {
        path,
        blob: text === undefined ? file.blob : new Blob([text], { type: file.blob.type || "text/plain" }),
      };
    }),
    documents: rewritten,
    paths,
    changedReferences: [...changedReferences],
    warnings,
    directories: projectDirectories(
      files.map((file) => ({ ...file, path: movePath(file.path) })),
      folders.map(movePath),
    ),
  };
}

export interface ProjectPathCopy {
  readonly files: readonly ProjectFile[];
  readonly directories: readonly string[];
  readonly scenes: readonly { id: string; path: string }[];
  readonly warnings: readonly string[];
}

export function planProjectPathCopy(
  files: readonly ProjectFile[],
  documents: readonly { path: string; text: string }[],
  source: string,
  target: string,
  directories: readonly string[] = [],
): ProjectPathCopy {
  const moved = planProjectPathMove(files, documents, source, target, directories);
  const copiedPaths = new Set(moved.paths.values());
  const scenes: { id: string; path: string }[] = [];
  const texts = new Map(moved.documents.map((doc) => [doc.path, doc.text]));
  const sceneCopies = new Map<
    string,
    {
      scene: ReturnType<typeof parseAltairSceneDocument>;
      id: string;
      nodes: AltairAuthoredNode[];
      ids: Map<string, string>;
    }
  >();
  for (const file of moved.files.filter((file) => copiedPaths.has(file.path) && /\.scene\.ya?ml$/iu.test(file.path))) {
    const scene = parseAltairSceneDocument(texts.get(file.path)!);
    const id = crypto.randomUUID(),
      nodes = cloneAltairNodeGroup(scene.nodes, scene.id, id),
      ids = new Map<string, string>();
    const collect = (before: readonly AltairAuthoredNode[], after: readonly AltairAuthoredNode[]) =>
      before.forEach((node, index) => {
        ids.set(node.id, after[index]!.id);
        if (node.children) collect(node.children, after[index]!.children ?? []);
      });
    collect(scene.nodes, nodes);
    sceneCopies.set(scene.id, { scene, id, nodes, ids });
    scenes.push({ id, path: file.path });
  }
  const rewriteTargets = (node: AltairAuthoredNode): AltairAuthoredNode => {
    const args = { ...node.arguments };
    if (node.type.plugin === "haneoka.altair")
      for (const key of ["target", "then", "else"]) {
        const target = args[key];
        if (!target || typeof target !== "object" || Array.isArray(target) || typeof target.sceneId !== "string")
          continue;
        const copied = sceneCopies.get(target.sceneId);
        if (copied)
          args[key] = {
            ...target,
            sceneId: copied.id,
            ...(typeof target.nodeId === "string" ? { nodeId: copied.ids.get(target.nodeId) ?? target.nodeId } : {}),
          };
      }
    return { ...node, arguments: args, ...(node.children ? { children: node.children.map(rewriteTargets) } : {}) };
  };
  const copied = moved.files
    .filter((file) => copiedPaths.has(file.path))
    .map((file) => {
      if (!/\.scene\.ya?ml$/iu.test(file.path)) return file;
      const original = texts.get(file.path)!,
        scene = parseAltairSceneDocument(original),
        copy = sceneCopies.get(scene.id)!;
      return {
        path: file.path,
        blob: new Blob(
          [serializeAltairDocument({ ...copy.scene, id: copy.id, nodes: copy.nodes.map(rewriteTargets) }, original)],
          { type: file.blob.type },
        ),
      };
    });
  return {
    files: copied,
    directories: moved.directories.filter((path) => path === target || path.startsWith(`${target}/`)),
    scenes,
    warnings: moved.warnings,
  };
}
