import { serializeAuthoredText, parseAuthoredText, type StoryProject, type StoryProjectPlugin } from "@haneoka/altair";
import { parseStoryProjectJson } from "@haneoka/altair-plugin-adv/project-json";
import type { AltairWebGalService, WebGalAuthoringWorkspaceFile } from "@haneoka/altair-plugin-webgal";
import type {
  AltairBrowserWorkspaceService,
  AltairBrowserWorkspaceSnapshot,
} from "@haneoka/altair-plugin-workspace-browser";
import type { StudioSourceDocument } from "./studio-workspace";

export type StudioProjectFile = WebGalAuthoringWorkspaceFile;

export interface StudioFolderWorkspace {
  readonly id: string;
  readonly name: string;
  readonly files: readonly StudioProjectFile[];
  readonly documents: readonly StudioSourceDocument[];
  readonly projectSnapshot?: StoryProject;
  readonly projectPlugins?: readonly StoryProjectPlugin[];
  readonly service: AltairBrowserWorkspaceService;
  readonly source: AltairWebGalService;
  readonly writable: boolean;
}

export interface StudioAssetBinding {
  readonly urls: ReadonlyMap<string, string>;
  release(): void;
}

export interface StudioObjectUrlEnvironment {
  createObjectURL(file: File): string;
  revokeObjectURL(url: string): void;
}

const browserObjectUrlEnvironment = (): StudioObjectUrlEnvironment => {
  if (typeof URL.createObjectURL !== "function" || typeof URL.revokeObjectURL !== "function") {
    throw new DOMException("Object URLs are unavailable", "NotSupportedError");
  }
  return {
    createObjectURL: (file) => URL.createObjectURL(file),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
};

const projectSnapshotForFiles = async (files: readonly StudioProjectFile[]): Promise<StoryProject | undefined> => {
  const entry = files.find(({ path }) => /^snapshot\.yaml$/iu.test(path));
  if (!entry) return undefined;
  try {
    return parseStoryProjectJson(parseAuthoredText(await entry.file.text()));
  } catch (error) {
    throw new TypeError(
      `${entry.path} is not a valid project snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const materializeFiles = async (
  service: AltairBrowserWorkspaceService,
  source: AltairWebGalService,
  snapshot: AltairBrowserWorkspaceSnapshot,
): Promise<readonly StudioProjectFile[]> =>
  Promise.all(
    snapshot.files.map(async ({ path }) => source.createAuthoringWorkspaceFile(path, await service.file(path))),
  );

/** Maps the browser-workspace plugin contract into Studio's view model. */
export const workspaceFromBrowserService = async (
  service: AltairBrowserWorkspaceService,
  source: AltairWebGalService,
  snapshot: AltairBrowserWorkspaceSnapshot = service.current,
): Promise<StudioFolderWorkspace> => {
  if (!snapshot.id) {
    throw new TypeError("Browser workspace has no active project");
  }
  const files = await materializeFiles(service, source, snapshot);
  const documents = (await Promise.all(files.map((file) => source.sourceDocumentFromWorkspaceFile(file)))).filter(
    (document): document is StudioSourceDocument => document !== undefined,
  );
  const projectSnapshot = await projectSnapshotForFiles(files);
  return {
    id: snapshot.id,
    name: snapshot.name || "Local project",
    files,
    documents,
    ...(projectSnapshot === undefined
      ? {}
      : {
          projectSnapshot,
          projectPlugins: projectSnapshot.plugins ?? [],
        }),
    service,
    source,
    writable: service.capabilities.writable,
  };
};

export const refreshFolderWorkspace = async (workspace: StudioFolderWorkspace): Promise<StudioFolderWorkspace> =>
  workspaceFromBrowserService(workspace.service, workspace.source, await workspace.service.refresh());

export const writeStudioDocument = async (
  workspace: StudioFolderWorkspace,
  document: StudioSourceDocument,
): Promise<boolean> => {
  const source = workspace.files.find((entry) => entry.path === document.sourcePath);
  if (!source || !workspace.writable) return false;
  await workspace.service.write(source.path, document.text);
  return true;
};

export const writeStudioProjectSnapshot = async (
  workspace: StudioFolderWorkspace,
  project: StoryProject,
): Promise<boolean> => {
  if (!workspace.writable) return false;
  await workspace.service.write("snapshot.yaml", serializeAuthoredText(project), { create: true });
  return true;
};

export const createStudioAssetBinding = (
  workspace: StudioFolderWorkspace,
  signal?: AbortSignal,
  environment: StudioObjectUrlEnvironment = browserObjectUrlEnvironment(),
): StudioAssetBinding => {
  const urls = new Map<string, string>();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const url of urls.values()) environment.revokeObjectURL(url);
  };
  try {
    for (const entry of workspace.files) {
      if (entry.kind === "scene") continue;
      signal?.throwIfAborted();
      urls.set(entry.path, environment.createObjectURL(entry.file));
    }
    signal?.throwIfAborted();
  } catch (error) {
    release();
    throw error;
  }
  return {
    urls,
    release,
  };
};

/**
 * Replaces runtime-only workspace references with the binding's object URLs.
 * The imported project and source documents remain untouched.
 */
export const hydrateStudioPreviewAssetUrls = <Value>(
  value: Value,
  workspace: StudioFolderWorkspace,
  urls: ReadonlyMap<string, string>,
): Value =>
  workspace.source.hydrateAssetUrls(
    value,
    workspace.files.map((file) => ({
      ...file,
      url: urls.get(file.path),
    })),
  );
