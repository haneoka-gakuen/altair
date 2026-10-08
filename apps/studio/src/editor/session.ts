import { tr } from "./i18n";
import { PreviewResources } from "./PreviewResources";
import { COMMAND_LIBRARY_PATH } from "./command-library";
import { validateAuthoredDocument } from "./validation";
import type { StoryProject, StoryDiagnostic, AltairPluginHost, AltairEditorWorkspace } from "@haneoka/altair";
import { createAltairHistoryService, type AltairHistory } from "@haneoka/altair-plugin-history";
import { createWebGalAuthoringWorkspaceFile, hydrateWebGalWorkspaceAssetUrls } from "@haneoka/altair-plugin-webgal";
import {
  parseAuthoredText,
  parseAltairSceneDocument,
  parseAltairProjectDocument,
  serializeAltairDocument,
  serializeAuthoredText,
  cloneAltairNodeGroup,
  type AltairCommandGroup,
  type AltairAuthoredNode,
  type JsonValue,
} from "@haneoka/altair";
import {
  readNativeWorkspace,
  copyNativeNode,
  nativeStatements,
  nativeScenePath,
  updateNativeNode,
  newNativeScene,
  NATIVE_PROJECT_PATH,
  type EditorStatement,
} from "./native-project";
import type { CompileVegaPreviewStoryResult } from "@haneoka/altair-plugin-vega-preview";
import {
  BrowserWorkspaceService,
  normalizeBrowserWorkspacePath,
  type AltairBrowserWorkspaceService,
  type AltairBrowserWorkspaceSnapshot,
  type BrowserWorkspaceDirectoryHandle,
} from "@haneoka/altair-plugin-workspace-browser";
import { STUDIO_PLUGIN_CATALOG, STUDIO_PLUGIN_ENVIRONMENT } from "../studio-plugin-catalog";
import {
  createStudioAuthoringPluginPlan,
  loadStudioAuthoringPlugins,
  studioAuthoringPluginBroker,
  type LoadedStudioAuthoringPlugins,
} from "../authoring-plugins";
import { projectLibrary, type LibraryProject, type ProjectFile, type ProjectRecoveryCopy } from "./library";
import { prepareSharedAssetImport, type SharedAssetPack } from "./shared-assets";
import { ProjectHistory } from "./project-history";
import { preparePublicAssetImport, type PublicAssetByteReader } from "./public-asset-import";
import { assertLocalPublicAssetAvailable, registerLocalPublicAsset } from "./public-asset-project";
import type { EditorPublicAsset } from "./resource-manifest";
import { abortableOperation } from "./abortable-operation";
import {
  assertNativeImportHost,
  prepareNativeImport,
  applyNativeImport,
  NativeImportFailure,
  nativeImportForFolder,
  reviewNativeImport,
  resolveNativeImport,
  withNativeImportLock,
  type NativeImportReview,
  type NativeImportWrite,
} from "./native-import";
import {
  captureConflictReview,
  conflictReviewMatches,
  conflictReplacement,
  type ConflictReview,
} from "./conflict-resolution";
import {
  planProjectPathMove,
  planProjectPathCopy,
  projectDirectories,
  projectFilePath,
  type ProjectPathMove,
} from "./file-operations";
export interface EditorDocument {
  readonly path: string;
  readonly text: string;
  readonly baseline: string;
  readonly external?: string;
  readonly revision: number;
}
export interface EditorSnapshot {
  readonly id: string;
  readonly name: string;
  readonly documents: readonly EditorDocument[];
  readonly files: readonly ProjectFile[];
  readonly directories: readonly string[];
  readonly tabs: readonly string[];
  readonly active: string;
  readonly line: number;
  readonly view?: string;
  readonly selectedNodeId?: string;
  readonly project?: StoryProject;
  readonly compilation?: CompileVegaPreviewStoryResult;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly compiling: boolean;
  readonly saving: boolean;
  readonly error: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly localFolder?: string;
  readonly contextEpoch?: number;
  readonly nativeImportRecovery?: { readonly id: string; readonly fileCount: number };
}
const isScene = nativeScenePath;
const isText = (path: string) =>
  /\.(?:txt|wg|webgal|json|jsonl|ndjson|wgcp|css|html|js|yaml|yml|atlas|mtn|exp)$/iu.test(path);
export class EditorSession {
  private state: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly histories = createAltairHistoryService();
  private readonly history = new Map<string, AltairHistory<string>>();
  private readonly urls = new Map<string, string>();
  private readonly previewResources: PreviewResources;
  readonly projectHistory: ProjectHistory;
  get resourcePlugin() {
    return this.previewResources.plugin;
  }
  private generation = 0;
  private disposed = false;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private persistence: Promise<unknown> = Promise.resolve();
  private compilation: AbortController | undefined;
  private readonly conflictLifetime = new AbortController();
  get lifetimeSignal(): AbortSignal {
    return this.conflictLifetime.signal;
  }
  private contextIdentity = "";
  private contextEpoch = 0;
  private contextLifetime = new AbortController();
  private importOperation: AbortController | undefined;
  private saveTask: Promise<void> | undefined;
  private folderTask: Promise<void> | undefined;
  private pathTask: Promise<unknown> | undefined;
  private localWatch?: { dispose(): void | Promise<void> };
  private localUnsubscribe?: () => void;
  private localRefresh?: Promise<void>;
  private readonly pendingFiles = new Set<string>();
  private readonly retiredUrls = new Set<string>();
  private authoringKey = "";
  private authoring: Promise<LoadedStudioAuthoringPlugins> | undefined;
  private authoringController = new AbortController();
  editorHost: AltairPluginHost | undefined;
  private previewSourceIndex = 0;
  private libraryRevision: number | undefined;
  readonly editorWorkspace: AltairEditorWorkspace = Object.freeze({
    getSnapshot: () => this.getSnapshot(),
    subscribe: (listener: () => void) => this.subscribe(listener),
    document: (path?: string) => this.document(path),
    update: (path: string, text: string) => this.update(path, text),
    activate: (path: string, line?: number) => this.activate(path, line),
    select: (line: number) => this.select(line),
    setView: (view: string) => this.setView(view),
    editArgument: (id: string, key: string, value: JsonValue, path?: string) => this.editArgument(id, key, value, path),
    resolveConflict: (path: string, source: "disk" | "editor") => this.resolveConflict(path, source),
    addFile: (path: string, blob: Blob, options?: { open?: boolean }) => this.addFile(path, blob, options),
    save: () => this.save(),
    translate: tr,
  });
  documentEditors() {
    return this.editorHost?.contributions("document-editor") ?? [];
  }
  editorFor(path: string) {
    return this.documentEditors().find((editor) => editor.matches(path));
  }
  validateDocument(path: string, text: string) {
    validateAuthoredDocument(path, text);
    this.editorFor(path)?.validate?.({ path, text });
  }
  async createDocument(editorId: string, name: string) {
    const editor = this.documentEditors().find((editor) => editor.id === editorId);
    if (!editor?.create) throw new Error(tr("Document editor is unavailable"));
    const document = editor.create(name);
    editor.validate?.(document);
    await this.addFile(document.path, new Blob([document.text], { type: "text/plain" }));
  }
  constructor(
    project: LibraryProject,
    private workspace?: AltairBrowserWorkspaceService,
    private readonly options: { readonly ephemeral?: boolean } = {},
  ) {
    this.previewResources = new PreviewResources(project.id);
    this.projectHistory = new ProjectHistory(project.id, workspace);
    this.libraryRevision = project.revision;
    this.state = {
      id: project.id,
      name: project.name,
      files: project.files,
      directories: projectDirectories(
        project.files,
        workspace?.directory ? workspace.current.directories : project.directories,
      ),
      documents: [],
      tabs: [],
      active: "",
      line: 1,
      diagnostics: [],
      compiling: false,
      saving: false,
      error: "",
      canUndo: false,
      canRedo: false,
      localFolder: workspace?.directory?.name,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<EditorSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async initialize(): Promise<void> {
    const pending = this.options.ephemeral ? undefined : await projectLibrary.nativeImport(this.state.id);
    if (pending) {
      if (!this.workspace?.directory || (await nativeImportForFolder(this.workspace))?.id !== pending.id)
        throw new Error(tr("Open the original folder to recover this import."));
      this.libraryRevision = pending.beforeProject.revision;
      this.publish({
        files: pending.beforeProject.files,
        directories: projectDirectories(pending.beforeProject.files, pending.beforeProject.directories),
        nativeImportRecovery: { id: pending.id, fileCount: pending.entries.length },
      });
    }
    if (!this.options.ephemeral) this.libraryRevision ??= (await projectLibrary.get(this.state.id))?.revision;
    const documents = await Promise.all(
      this.state.files
        .filter((file) => isText(file.path))
        .map(async (file) => {
          const text = await file.blob.text();
          return { path: file.path, text, baseline: text, revision: 0 };
        }),
    );
    if (this.disposed || this.conflictLifetime.signal.aborted) return;
    const draft = this.options.ephemeral ? undefined : await projectLibrary.draft(this.state.id);
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i]!,
        saved = draft?.documents.find((entry) => entry.path === doc.path);
      if (saved && saved.text !== doc.text) {
        documents[i] = {
          ...doc,
          text: saved.text,
          ...(saved.baseline !== doc.text ? { external: doc.text } : {}),
          revision: 1,
        };
      }
    }
    const active =
      documents.find((doc) => /(?:^|\/)start\.(?:txt|wg|webgal)$/iu.test(doc.path))?.path ??
      documents.find((doc) => isScene(doc.path))?.path ??
      documents[0]?.path ??
      "";
    for (const doc of documents) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
    const first = nativeStatements(documents.find((doc) => doc.path === active)?.text ?? "")[0];
    this.publish({
      documents,
      active,
      tabs: active ? [active] : [],
      line: first?.line ?? 1,
      selectedNodeId: first?.id,
    });
    this.startLocalWatch();
    await this.compile();
  }
  document(path = this.state.active) {
    return this.state.documents.find((doc) => doc.path === path);
  }
  statements() {
    return nativeStatements(this.document()?.text ?? "");
  }
  activate(path: string, line = 1) {
    if (!this.document(path)) return;
    this.publish({
      active: path,
      line,
      tabs: this.state.tabs.includes(path) ? this.state.tabs : [...this.state.tabs, path],
    });
    this.syncHistory();
    void this.compile();
  }
  setView(view: string) {
    this.publish({ view });
  }
  select(line: number) {
    this.publish({
      line,
      selectedNodeId: [...this.statements()].reverse().find((statement) => statement.line <= line)?.id,
    });
  }
  close(path: string) {
    const tabs = this.state.tabs.filter((tab) => tab !== path);
    this.publish({
      tabs,
      active: this.state.active === path ? (tabs.at(-1) ?? "") : this.state.active,
    });
    this.syncHistory();
  }
  private syncHistory() {
    const history = this.history.get(this.state.active);
    this.publish({
      canUndo: !this.state.nativeImportRecovery && (history?.canUndo ?? false),
      canRedo: !this.state.nativeImportRecovery && (history?.canRedo ?? false),
    });
  }
  update(path: string, text: string, merge = false) {
    if (this.state.nativeImportRecovery) {
      this.publish({ error: tr("Review the unfinished native import before saving this project.") });
      return;
    }
    const doc = this.document(path);
    if (!doc || doc.text === text) return;
    const history = this.history.get(path)!;
    history.replace(text, merge ? { mergeKey: "typing" } : {});
    this.applyText(path, text);
    this.syncHistory();
  }
  endGesture() {
    this.history.get(this.state.active)?.endMerge();
  }
  private applyText(path: string, text: string) {
    this.importOperation?.abort(new DOMException("Project edited during import", "AbortError"));
    const line =
      path === this.state.active
        ? nativeStatements(text).find((node) => node.id === this.state.selectedNodeId)?.line
        : undefined;
    this.publish({
      ...(line ? { line } : {}),
      documents: this.state.documents.map((doc) =>
        doc.path === path ? { ...doc, text, revision: doc.revision + 1 } : doc,
      ),
      error: "",
    });
    this.scheduleDraft();
  }
  undo() {
    if (this.state.nativeImportRecovery) return;
    const history = this.history.get(this.state.active);
    if (history?.canUndo) {
      this.applyText(this.state.active, history.undo());
      this.syncHistory();
    }
  }
  redo() {
    if (this.state.nativeImportRecovery) return;
    const history = this.history.get(this.state.active);
    if (history?.canRedo) {
      this.applyText(this.state.active, history.redo());
      this.syncHistory();
    }
  }
  editArgument(id: string, key: string, value: JsonValue, path = this.state.active) {
    const document = this.document(path);
    if (!document) return;
    this.update(
      path,
      updateNativeNode(document.text, id, (node) => ({
        ...node,
        arguments: { ...node.arguments, [key]: value },
      })),
    );
  }
  editNode(id: string, update: (node: AltairAuthoredNode) => AltairAuthoredNode) {
    const doc = this.document();
    if (doc) this.update(doc.path, updateNativeNode(doc.text, id, update));
  }
  insert(value: AltairAuthoredNode | string, afterLine = this.state.line) {
    const doc = this.document();
    if (!doc) return;
    const scene = parseAltairSceneDocument(doc.text),
      statement = [...this.statements()].reverse().find((node) => node.line <= afterLine),
      index = scene.nodes.findIndex((node) => node.id === statement?.id);
    const node = typeof value === "string" ? (parseAuthoredText(value) as unknown as AltairAuthoredNode) : value;
    let inserted: AltairAuthoredNode;
    try {
      inserted = copyNativeNode(node, scene.id);
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const nodes = [...scene.nodes];
    nodes.splice(index + 1, 0, inserted);
    const text = serializeAltairDocument({ ...scene, nodes }, doc.text);
    this.update(doc.path, text);
    this.select(nativeStatements(text).find((node) => node.id === inserted.id)!.line);
  }
  insertGroup(group: AltairCommandGroup, afterLine = this.state.line): void {
    const doc = this.document(),
      manifest = this.document(NATIVE_PROJECT_PATH);
    if (!doc || !isScene(doc.path) || !manifest) throw new Error(tr("Open a target scene first"));
    const scene = parseAltairSceneDocument(doc.text),
      project = parseAltairProjectDocument(manifest.text);
    const plugins = [...project.plugins];
    for (const required of group.plugins) {
      const existing = plugins.find((plugin) => plugin.id === required.id);
      if (existing && existing.version !== required.version)
        throw new Error(
          tr("Plugin versions differ: {{p0}} ({{p1}} / {{p2}})", {
            p0: required.id,
            p1: existing.version,
            p2: required.version,
          }),
        );
      if (!existing) plugins.push(required);
    }
    const inserted = cloneAltairNodeGroup(group.nodes, group.sourceSceneId, scene.id);
    const statement = [...this.statements()].reverse().find((node) => node.line <= afterLine);
    const index = scene.nodes.findIndex((node) => node.id === statement?.id);
    const nodes = [...scene.nodes];
    nodes.splice(index + 1, 0, ...inserted);
    if (plugins.length !== project.plugins.length)
      this.update(manifest.path, serializeAltairDocument({ ...project, plugins }, manifest.text));
    const text = serializeAltairDocument({ ...scene, nodes }, doc.text);
    this.update(doc.path, text);
    this.select(nativeStatements(text).find((node) => node.id === inserted[0]?.id)?.line ?? afterLine);
  }
  remove(statement: EditorStatement) {
    const doc = this.document();
    if (!doc) return;
    const scene = parseAltairSceneDocument(doc.text);
    this.update(
      doc.path,
      serializeAltairDocument(
        {
          ...scene,
          nodes: scene.nodes.filter((node) => node.id !== statement.id),
        },
        doc.text,
      ),
    );
  }
  move(statement: EditorStatement, direction: -1 | 1) {
    const doc = this.document();
    if (!doc) return;
    const scene = parseAltairSceneDocument(doc.text),
      nodes = [...scene.nodes],
      index = nodes.findIndex((node) => node.id === statement.id);
    if (index < 0 || !nodes[index + direction]) return;
    [nodes[index], nodes[index + direction]] = [nodes[index + direction]!, nodes[index]!];
    const text = serializeAltairDocument({ ...scene, nodes }, doc.text);
    this.update(doc.path, text);
    this.select(nativeStatements(text).find((node) => node.id === statement.id)!.line);
  }
  async addScene(name: string) {
    const scene = newNativeScene(name),
      manifest = this.document(NATIVE_PROJECT_PATH);
    const base = name.trim();
    if (
      !base ||
      /[\\/:*?"<>|\u0000-\u001f]/u.test(base) ||
      /[. ]$/u.test(base) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base)
    )
      throw new Error(tr("Invalid scene file name"));
    let path = `scenes/${base}.scene.yaml`,
      suffix = 2;
    while (this.state.files.some((file) => file.path === path)) path = `scenes/${base}_${suffix++}.scene.yaml`;
    if (!manifest) throw new Error(tr("Project manifest is missing"));
    const project = parseAltairProjectDocument(manifest.text);
    this.update(
      manifest.path,
      serializeAltairDocument(
        {
          ...project,
          scenes: [...project.scenes, { id: scene.id, path }],
        },
        manifest.text,
      ),
    );
    await this.addFile(path, new Blob([serializeAltairDocument(scene)], { type: "application/yaml" }));
  }
  async addFile(
    path: string,
    blob: Blob,
    options: {
      open?: boolean;
    } = {},
  ): Promise<void> {
    if (this.pathTask) throw new Error(tr("Saving"));
    if (this.state.nativeImportRecovery)
      throw new Error(tr("Review the unfinished native import before saving this project."));
    path = normalizeBrowserWorkspacePath(path);
    if (this.state.files.some((file) => file.path === path))
      throw new Error(tr("A file with this name already exists"));
    const text = isText(path) ? await blob.text() : undefined;
    if (this.state.files.some((file) => file.path === path))
      throw new Error(tr("A file with this name already exists"));
    const files = [...this.state.files, { path, blob }];
    let documents = this.state.documents;
    if (text !== undefined) {
      const doc = { path, text, baseline: "", revision: 1 };
      documents = [...documents, doc];
      this.history.set(path, this.histories.create(path, text));
    }
    this.pendingFiles.add(path);
    this.publish({ files, documents, directories: projectDirectories(files, this.state.directories) });
    this.scheduleDraft();
    if (isText(path) && options.open !== false) this.activate(path);
    await this.save();
  }
  async importSharedAssets(pack: SharedAssetPack, directory: string): Promise<readonly string[]> {
    if (await projectLibrary.nativeImport(this.state.id))
      throw new Error(tr("Review the unfinished native import before saving this project."));
    if (this.state.saving) throw new Error(tr("Saving"));
    const manifest = this.document(NATIVE_PROJECT_PATH);
    if (!manifest) throw new Error(tr("Project manifest is missing"));
    const revision = this.state;
    const imported = prepareSharedAssetImport(pack, directory, this.state.files);
    const documents = await Promise.all(
      imported.files
        .filter((file) => isText(file.path))
        .map(async (file) => {
          const text = await file.blob.text();
          this.validateDocument(file.path, text);
          return { path: file.path, text, baseline: "", revision: 1 };
        }),
    );
    if (this.disposed || this.state.files !== revision.files || this.state.documents !== revision.documents)
      throw new Error(tr("The project changed during import"));
    const project = parseAltairProjectDocument(manifest.text);
    const previous = project.extensions?.sharedAssetPacks;
    if (previous !== undefined && !Array.isArray(previous)) throw new TypeError("Invalid shared asset pack list");
    const text = serializeAltairDocument(
      {
        ...project,
        extensions: { ...project.extensions, sharedAssetPacks: [...(previous ?? []), imported.metadata] },
      },
      manifest.text,
    );
    this.update(manifest.path, text);
    for (const doc of documents) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
    for (const file of imported.files) this.pendingFiles.add(file.path);
    this.publish({
      files: [...this.state.files, ...imported.files],
      documents: [...this.state.documents, ...documents],
      directories: projectDirectories([...this.state.files, ...imported.files], this.state.directories),
    });
    await this.save();
    for (const file of imported.files) this.pendingFiles.delete(file.path);
    await this.compile();
    return imported.files.map((file) => file.path);
  }
  /** Move a path and reconcile the authoring documents in its active storage. */
  private runPathTask<T>(run: () => Promise<T>, recovery = false): Promise<T> {
    if (this.options.ephemeral) return Promise.reject(new Error("Preview sessions cannot save project files"));
    if (this.disposed || this.state.saving || this.pathTask) return Promise.reject(new Error(tr("Saving")));
    const protectedRun = async () => {
      if (!recovery && (await projectLibrary.nativeImport(this.state.id)))
        throw new Error(tr("Review the unfinished native import before saving this project."));
      return run();
    };
    const task = Promise.resolve()
      .then(() =>
        this.workspace?.directory && globalThis.navigator?.locks
          ? withNativeImportLock(this.state.id, protectedRun)
          : protectedRun(),
      )
      .finally(() => {
        this.pathTask = undefined;
      });
    this.pathTask = task;
    return task;
  }
  moveProjectPath(source: string, target: string): Promise<ProjectPathMove> {
    return this.runPathTask(() => this.moveProjectPathNow(source, target));
  }
  private async moveProjectPathNow(source: string, target: string): Promise<ProjectPathMove> {
    const native = this.workspace?.directory ? this.workspace : undefined;
    if (native && !native.rename) throw new Error(tr("Native folder path operations require the folder service"));
    if (this.disposed || this.state.saving) throw new Error(tr("Saving"));
    await this.saveNow();
    const before = this.state;
    const plan = planProjectPathMove(before.files, before.documents, source, target, before.directories);
    const current = await projectLibrary.get(before.id);
    if (!current || current.revision !== this.libraryRevision)
      throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
    this.publish({ saving: true, error: "" });
    try {
      if (native) await native.rename!(source, target);
      else {
        const saved = await projectLibrary.commit(
          { ...current, files: plan.files, directories: plan.directories, updatedAt: Date.now() },
          current.revision,
        );
        this.libraryRevision = saved.revision;
      }
      const live = this.state;
      const next =
        live.files === before.files && live.documents === before.documents
          ? plan
          : planProjectPathMove(live.files, live.documents, source, target, live.directories);
      const baseline = new Map(
        native
          ? before.documents.map((doc) => [plan.paths.get(doc.path) ?? doc.path, doc.text])
          : plan.documents.map((doc) => [doc.path, doc.text]),
      );
      const documents = next.documents.map((doc) => ({
        ...doc,
        baseline: baseline.get(doc.path) ?? "",
        revision:
          (before.documents.find((old) => (next.paths.get(old.path) ?? old.path) === doc.path)?.revision ?? 0) + 1,
      }));
      for (const doc of documents) {
        const old = [...next.paths].find(([, path]) => path === doc.path)?.[0] ?? doc.path;
        const history = this.history.get(old);
        if (history) {
          this.history.delete(old);
          if (old !== doc.path || before.documents.find((previous) => previous.path === old)?.text !== doc.text)
            history.reset(doc.text);
          this.history.set(doc.path, history);
        } else this.history.set(doc.path, this.histories.create(doc.path, doc.text));
      }
      for (const [path, url] of this.urls)
        if (next.paths.has(path)) {
          this.retiredUrls.add(url);
          this.urls.delete(path);
        }
      this.publish({
        files: next.files,
        directories: next.directories,
        documents,
        active: next.paths.get(live.active) ?? live.active,
        tabs: live.tabs.map((path) => next.paths.get(path) ?? path),
      });
      this.syncHistory();
      await this.projectHistory.move(next.paths);
      await this.persistDraft();
      if (native) await this.saveNow();
      await this.compile();
      return next;
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.publish({ saving: false });
    }
  }
  createProjectDirectory(path: string): Promise<void> {
    return this.runPathTask(() => this.createProjectDirectoryNow(path));
  }
  private async createProjectDirectoryNow(path: string): Promise<void> {
    path = projectFilePath(path);
    if (this.disposed || this.state.saving) throw new Error(tr("Saving"));
    await this.saveNow();
    if (this.state.files.some((file) => file.path === path) || this.state.directories.includes(path))
      throw new Error(tr("A file with this name already exists"));
    const directories = projectDirectories(this.state.files, [...this.state.directories, path]);
    const current = await projectLibrary.get(this.state.id);
    if (!current || current.revision !== this.libraryRevision)
      throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
    this.publish({ saving: true });
    try {
      if (this.workspace?.directory) {
        if (!this.workspace.mkdir) throw new Error(tr("Native folder path operations require the folder service"));
        await this.workspace.mkdir(path);
      }
      const saved = await projectLibrary.commit({ ...current, directories, updatedAt: Date.now() }, current.revision);
      this.libraryRevision = saved.revision;
      this.publish({ directories });
    } finally {
      this.publish({ saving: false });
    }
  }
  copyProjectPath(source: string, target: string): Promise<void> {
    return this.runPathTask(() => this.copyProjectPathNow(source, target));
  }
  private async copyProjectPathNow(source: string, target: string): Promise<void> {
    if (this.disposed || this.state.saving) throw new Error(tr("Saving"));
    await this.saveNow();
    const before = this.state;
    const plan = planProjectPathCopy(before.files, before.documents, source, target, before.directories);
    const manifest = this.document(NATIVE_PROJECT_PATH);
    if (!manifest) throw new Error(tr("Project manifest is missing"));
    const project = parseAltairProjectDocument(manifest.text);
    const sourceTexts = new Map(
      before.documents
        .filter((doc) => doc.path === source || doc.path.startsWith(`${source}/`))
        .map((doc) => [target + doc.path.slice(source.length), doc.text]),
    );
    const documents = await Promise.all(
      plan.files
        .filter((file) => isText(file.path))
        .map(async (file) => {
          const text = await file.blob.text();
          this.validateDocument(file.path, text);
          return {
            path: file.path,
            text,
            baseline: this.workspace?.directory ? (sourceTexts.get(file.path) ?? "") : "",
            revision: 1,
          };
        }),
    );
    if (this.disposed || this.state.files !== before.files || this.state.documents !== before.documents)
      throw new Error(tr("The project changed during import"));
    const files = [...before.files, ...plan.files];
    const directories = projectDirectories(files, [...before.directories, ...plan.directories]);
    this.publish({ saving: true });
    try {
      if (this.workspace?.directory) {
        if (!this.workspace.copy) throw new Error(tr("Native folder path operations require the folder service"));
        await this.workspace.copy(source, target);
      }
      if (this.disposed || this.state.files !== before.files || this.state.documents !== before.documents)
        throw new Error(tr("The project changed during import"));
      if (plan.scenes.length)
        this.update(
          manifest.path,
          serializeAltairDocument({ ...project, scenes: [...project.scenes, ...plan.scenes] }, manifest.text),
        );
      for (const doc of documents) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
      if (!this.workspace?.directory) for (const file of plan.files) this.pendingFiles.add(file.path);
      this.publish({ files, directories, documents: [...this.state.documents, ...documents] });
      await this.saveNow();
      await this.compile();
    } finally {
      this.publish({ saving: false });
    }
  }
  deleteProjectPath(path: string): Promise<void> {
    return this.runPathTask(() => this.deleteProjectPathNow(path));
  }
  private async deleteProjectPathNow(path: string): Promise<void> {
    path = projectFilePath(path);
    if (path === NATIVE_PROJECT_PATH) throw new Error(tr("The project manifest path is fixed"));
    await this.saveNow();
    const before = this.state;
    const contains = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
    const files = before.files.filter((file) => contains(file.path));
    const directories = before.directories.filter(contains);
    if (!files.length && !directories.length) throw new Error(tr("File is missing"));
    const manifest = this.document(NATIVE_PROJECT_PATH)!;
    const project = parseAltairProjectDocument(manifest.text);
    const scenes = project.scenes.filter((scene) => contains(scene.path));
    if (scenes.some((scene) => scene.id === project.entry.sceneId))
      throw new Error(tr("Change the entry scene before deleting it"));
    const remainingFiles = before.files.filter((file) => !contains(file.path));
    const remainingDirectories = before.directories.filter((directory) => !contains(directory));
    const manifestText = scenes.length
      ? serializeAltairDocument(
          { ...project, scenes: project.scenes.filter((scene) => !contains(scene.path)) },
          manifest.text,
        )
      : manifest.text;
    const nextFiles = remainingFiles.map((file) =>
      file.path === manifest.path ? { ...file, blob: new Blob([manifestText], { type: file.blob.type }) } : file,
    );
    const current = await projectLibrary.get(before.id);
    if (!current || current.revision !== this.libraryRevision)
      throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
    this.publish({ saving: true });
    try {
      // Copy disk-backed File objects into owned Blobs before their source is removed.
      const recoveryFiles: ProjectFile[] = [];
      for (const file of files)
        recoveryFiles.push({
          path: file.path,
          blob: new Blob([await file.blob.arrayBuffer()], { type: file.blob.type }),
        });
      const recovery: ProjectRecoveryCopy = {
        id: crypto.randomUUID(),
        projectId: before.id,
        path,
        createdAt: Date.now(),
        files: recoveryFiles,
        directories,
        scenes,
      };
      if (this.state.documents !== before.documents || this.state.files !== before.files)
        throw new Error(tr("The project changed during import"));
      if (this.workspace?.directory) {
        if (!this.workspace.remove) throw new Error(tr("Native folder path operations require the folder service"));
        const expectedFiles = this.workspace.current.files.filter((file) => contains(file.path));
        await projectLibrary.saveRecoveryCopy(recovery);
        if (this.state.documents !== before.documents || this.state.files !== before.files)
          throw new Error(tr("The project changed during import"));
        await this.workspace.remove(path, {
          recursive: directories.length > 0,
          expected: {
            files: expectedFiles,
            directories,
          },
        });
      } else {
        const saved = await projectLibrary.commit(
          { ...current, files: nextFiles, directories: remainingDirectories, updatedAt: Date.now() },
          current.revision,
          recovery,
        );
        this.libraryRevision = saved.revision;
      }
      // Preserve edits made while the storage operation was in flight in the recovery copy.
      const liveRemoved = this.state.documents.filter(
        (doc) => contains(doc.path) && doc.text !== before.documents.find((old) => old.path === doc.path)?.text,
      );
      if (liveRemoved.length) {
        const texts = new Map(liveRemoved.map((doc) => [doc.path, doc.text]));
        await projectLibrary.saveRecoveryCopy({
          ...recovery,
          files: recovery.files.map((file) =>
            texts.has(file.path)
              ? { ...file, blob: new Blob([texts.get(file.path)!], { type: file.blob.type }) }
              : file,
          ),
        });
      }
      const documents = this.state.documents
        .filter((doc) => !contains(doc.path))
        .map((doc) =>
          doc.path === manifest.path
            ? {
                ...doc,
                text: manifestText,
                baseline: this.workspace?.directory ? doc.baseline : manifestText,
                revision: doc.revision + 1,
              }
            : doc,
        );
      const tabs = this.state.tabs.filter((tab) => !contains(tab));
      for (const file of files) {
        this.pendingFiles.delete(file.path);
        this.history.delete(file.path);
        const url = this.urls.get(file.path);
        if (url) {
          this.retiredUrls.add(url);
          this.urls.delete(file.path);
        }
      }
      this.publish({
        files: nextFiles,
        directories: remainingDirectories,
        documents,
        tabs,
        active: contains(this.state.active)
          ? (tabs.at(-1) ?? documents.find((doc) => isScene(doc.path))?.path ?? "")
          : this.state.active,
      });
      this.history.get(manifest.path)?.reset(manifestText);
      this.syncHistory();
      await this.persistDraft();
      if (this.workspace?.directory) await this.saveNow();
      await this.compile();
    } finally {
      this.publish({ saving: false });
    }
  }
  restoreProjectPath(recoveryId: string): Promise<void> {
    return this.runPathTask(() => this.restoreProjectPathNow(recoveryId));
  }
  restoreHistory(path: string, entryId: string, revision: number): Promise<void> {
    return this.runPathTask(async () => {
      const current = this.document(path);
      if (!current || current.revision !== revision)
        throw new Error(tr("The document changed while comparing history"));
      if (current.external !== undefined)
        throw new Error(tr("Resolve the external change first: {{p0}}", { p0: path }));
      const text = await this.projectHistory.read(entryId, path);
      this.validateDocuments(this.state.documents.map((doc) => (doc.path === path ? { ...doc, text } : doc)));
      await this.projectHistory.capture(path, current.text, "before-restore", true);
      if (this.document(path)?.revision !== revision)
        throw new Error(tr("The document changed while comparing history"));
      this.update(path, text);
      await this.saveNow();
      await this.projectHistory.capture(path, text, "restore", true);
      this.activate(path, nativeStatements(text)[0]?.line ?? 1);
      await this.compile();
    });
  }
  private async restoreProjectPathNow(recoveryId: string): Promise<void> {
    await this.saveNow();
    const copy = await projectLibrary.recoveryCopy(recoveryId);
    if (!copy || copy.projectId !== this.state.id) throw new Error(tr("File is missing"));
    const before = this.state;
    if (
      before.files.some(
        (file) =>
          file.path === copy.path || file.path.startsWith(`${copy.path}/`) || copy.path.startsWith(`${file.path}/`),
      ) ||
      before.directories.includes(copy.path)
    )
      throw new Error(tr("A file with this name already exists"));
    const files = [...before.files, ...copy.files];
    const directories = projectDirectories(files, [...before.directories, ...copy.directories]);
    const manifest = this.document(NATIVE_PROJECT_PATH)!;
    const project = parseAltairProjectDocument(manifest.text);
    if (
      copy.scenes.some((scene) =>
        project.scenes.some((existing) => existing.id === scene.id || existing.path === scene.path),
      )
    )
      throw new Error(tr("A file with this name already exists"));
    const text = copy.scenes.length
      ? serializeAltairDocument({ ...project, scenes: [...project.scenes, ...copy.scenes] }, manifest.text)
      : manifest.text;
    const restoredDocs = await Promise.all(
      copy.files
        .filter((file) => isText(file.path))
        .map(async (file) => {
          const text = await file.blob.text();
          this.validateDocument(file.path, text);
          return { path: file.path, text, baseline: text, revision: 0 };
        }),
    );
    const current = await projectLibrary.get(before.id);
    if (!current || current.revision !== this.libraryRevision)
      throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
    this.publish({ saving: true });
    try {
      if (this.state.files !== before.files || this.state.documents !== before.documents)
        throw new Error(tr("The project changed during import"));
      if (this.workspace?.directory) {
        if (!this.workspace.exists || !this.workspace.mkdir)
          throw new Error(tr("Native folder path operations require the folder service"));
        if (await this.workspace.exists(copy.path)) throw new Error(tr("A file with this name already exists"));
        for (const directory of copy.directories) await this.workspace.mkdir(directory);
        for (const file of copy.files)
          await this.workspace.write(file.path, file.blob, { create: true, exclusive: true });
      }
      const nextFiles = files.map((file) =>
        file.path === manifest.path ? { ...file, blob: new Blob([text], { type: file.blob.type }) } : file,
      );
      const saved = await projectLibrary.commit(
        { ...current, files: nextFiles, directories, updatedAt: Date.now() },
        current.revision,
        undefined,
        this.workspace?.directory ? undefined : copy.id,
      );
      this.libraryRevision = saved.revision;
      for (const doc of restoredDocs) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
      this.publish({
        files: nextFiles,
        directories,
        documents: [
          ...this.state.documents.map((doc) =>
            doc.path === manifest.path
              ? { ...doc, text, baseline: this.workspace?.directory ? doc.baseline : text, revision: doc.revision + 1 }
              : doc,
          ),
          ...restoredDocs,
        ],
      });
      this.history.get(manifest.path)?.reset(text);
      await this.persistDraft();
      if (this.workspace?.directory) await this.saveNow();
      await this.compile();
      if (this.workspace?.directory) await projectLibrary.removeRecoveryCopy(copy.id);
    } finally {
      this.publish({ saving: false });
    }
  }
  private startLocalWatch(): void {
    if (this.state.nativeImportRecovery) return;
    this.localUnsubscribe?.();
    void this.localWatch?.dispose();
    if (!this.workspace?.directory) return;
    const workspace = this.workspace;
    this.localUnsubscribe = workspace.subscribe((event) => {
      if (event.type === "error") {
        this.publish({ error: String(event.error) });
        return;
      }
      if (event.type === "refresh" && !this.state.saving && !this.localRefresh)
        void this.syncLocalFiles(workspace, event.snapshot).catch((error) => this.publish({ error: String(error) }));
    });
    this.localWatch = workspace.watch({ intervalMs: 1200 });
  }
  async refreshLocalFiles(): Promise<void> {
    if (this.state.nativeImportRecovery)
      throw new Error(tr("Review the unfinished native import before saving this project."));
    if (!this.workspace?.directory) return;
    if (this.saveTask) await this.saveTask;
    const workspace = this.workspace;
    const snapshot = await workspace.refresh();
    await this.syncLocalFiles(workspace, snapshot);
    for (const url of this.urls.values()) this.retiredUrls.add(url);
    this.urls.clear();
    await this.compile();
  }
  private syncLocalFiles(
    workspace: AltairBrowserWorkspaceService,
    snapshot: AltairBrowserWorkspaceSnapshot,
    whileSaving = false,
  ): Promise<void> {
    if (this.localRefresh) return this.localRefresh;
    this.localRefresh = (async () => {
      const remote = await Promise.all(
        snapshot.files.map(async (file) => ({
          path: file.path,
          blob: await workspace.file(file.path),
        })),
      );
      const texts = new Map(
        await Promise.all(
          remote.filter((file) => isText(file.path)).map(async (file) => [file.path, await file.blob.text()] as const),
        ),
      );
      if (this.disposed || this.workspace !== workspace || (!whileSaving && this.state.saving)) return;
      const documents: EditorDocument[] = [];
      for (const current of this.state.documents) {
        const disk = texts.get(current.path);
        texts.delete(current.path);
        if (disk === undefined) {
          if (current.text !== current.baseline || this.pendingFiles.has(current.path))
            documents.push({
              ...current,
              external: this.pendingFiles.has(current.path) ? undefined : "",
            });
          continue;
        }
        if (disk === current.baseline) {
          documents.push(current);
          continue;
        }
        if (current.text !== current.baseline && current.text !== disk) {
          documents.push({ ...current, external: disk });
          continue;
        }
        this.history.get(current.path)?.reset(disk);
        documents.push({
          ...current,
          text: disk,
          baseline: disk,
          external: undefined,
          revision: current.revision + 1,
        });
      }
      for (const [path, text] of texts) {
        documents.push({ path, text, baseline: text, revision: 0 });
        this.history.set(path, this.histories.create(path, text));
      }
      const fileMap = new Map<string, ProjectFile>(remote.map((file) => [file.path, file]));
      for (const file of this.state.files)
        if (
          this.pendingFiles.has(file.path) ||
          (!fileMap.has(file.path) && documents.some((doc) => doc.path === file.path))
        )
          fileMap.set(file.path, file);
      const files: ProjectFile[] = [...fileMap.values()];
      for (const [path, url] of this.urls) {
        const previous = this.state.files.find((file) => file.path === path)?.blob as File | undefined;
        const next = files.find((file) => file.path === path)?.blob as File | undefined;
        if (!next || previous?.size !== next.size || previous?.lastModified !== next.lastModified) {
          this.retiredUrls.add(url);
          this.urls.delete(path);
        }
      }
      const tabs = this.state.tabs.filter((path) => documents.some((doc) => doc.path === path));
      const active = documents.some((doc) => doc.path === this.state.active)
        ? this.state.active
        : (tabs.at(-1) ?? documents[0]?.path ?? "");
      const statements = nativeStatements(documents.find((doc) => doc.path === active)?.text ?? "");
      const selected =
        statements.find((node) => node.id === this.state.selectedNodeId) ??
        statements.find((node) => node.line >= this.state.line) ??
        statements[0];
      this.publish({
        files,
        directories: projectDirectories(files, snapshot.directories),
        documents,
        tabs,
        active,
        line: selected?.line ?? 1,
        selectedNodeId: selected?.id,
      });
      this.syncHistory();
      this.scheduleDraft();
    })().finally(() => {
      this.localRefresh = undefined;
    });
    return this.localRefresh;
  }
  writeToFolder(directory?: BrowserWorkspaceDirectoryHandle): Promise<void> {
    if (this.options.ephemeral) return Promise.reject(new Error("Preview sessions cannot save project files"));
    if (this.folderTask) return this.folderTask;
    if (this.state.saving) return Promise.reject(new Error(tr("Saving")));
    try {
      this.validateDocuments();
    } catch (error) {
      return Promise.reject(error);
    }
    const workspace = new BrowserWorkspaceService();
    const selection = directory
      ? workspace.connectDirectory(directory, { requestPermission: true })
      : workspace.pickDirectory({ pickerOptions: { mode: "readwrite" } });
    this.publish({ saving: true, error: "" });
    this.folderTask = (async () => {
      try {
        const snapshot = await selection;
        if (!workspace.directory || !workspace.capabilities.writable)
          throw new Error(tr("Directory writing is unavailable in this browser"));
        if (snapshot.files.length) throw new Error(tr("The folder must be empty"));
        const current = await projectLibrary.get(this.state.id);
        const documents = this.state.documents;
        const files = this.state.files.map((file) => ({
          path: file.path,
          blob: this.document(file.path)
            ? new Blob([this.document(file.path)!.text], {
                type: file.blob.type || "text/plain",
              })
            : file.blob,
        }));
        for (const file of [...files].sort(
          (a, b) => Number(a.path === NATIVE_PROJECT_PATH) - Number(b.path === NATIVE_PROJECT_PATH),
        ))
          await workspace.write(file.path, file.blob, { create: true });
        for (const path of this.state.directories) {
          if (!workspace.mkdir) throw new Error(tr("Native folder path operations require the folder service"));
          await workspace.mkdir(path);
        }
        const savedProject = await projectLibrary.commit(
          {
            id: this.state.id,
            name: this.state.name,
            updatedAt: Date.now(),
            files,
            directories: this.state.directories,
            directory: workspace.directory,
          },
          current?.revision,
        );
        this.libraryRevision = savedProject.revision;
        await this.projectHistory.attachFolder(workspace);
        this.localUnsubscribe?.();
        await this.localWatch?.dispose();
        await this.workspace?.dispose();
        this.workspace = workspace;
        const copiedPaths = new Set(files.map((file) => file.path));
        for (const path of copiedPaths) this.pendingFiles.delete(path);
        this.publish({
          files: [...files, ...this.state.files.filter((file) => !copiedPaths.has(file.path))],
          documents: this.state.documents.map((document) => ({
            ...document,
            baseline: documents.find((old) => old.path === document.path)?.text ?? document.baseline,
            external: undefined,
          })),
          localFolder: workspace.directory.name,
        });
        this.startLocalWatch();
        await this.persistDraft();
      } catch (error) {
        if (this.workspace !== workspace) await workspace.dispose();
        if (!(error instanceof DOMException && error.name === "AbortError"))
          this.publish({
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      } finally {
        this.folderTask = undefined;
        this.publish({ saving: false });
      }
    })();
    return this.folderTask;
  }
  private scheduleDraft() {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      void this.persistDraft().catch((error) => this.publish({ error: String(error) }));
    }, 250);
  }
  private persistDraft() {
    if (this.options.ephemeral) return Promise.resolve();
    const draft = {
      projectId: this.state.id,
      documents: this.state.documents
        .filter((doc) => doc.text !== doc.baseline)
        .map(({ path, text, baseline }) => ({ path, text, baseline })),
    };
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        await projectLibrary.saveDraft(draft);
        for (const doc of draft.documents) {
          try {
            await this.projectHistory.capture(doc.path, doc.text, "auto-save");
          } catch (error) {
            this.publish({ error: tr("History warning: {{error}}", { error: String(error) }) });
          }
        }
      });
    return this.persistence;
  }
  async compile(): Promise<void> {
    if (this.disposed || this.conflictLifetime.signal.aborted) return;
    const active = this.document();
    if (!active) return;
    this.compilation?.abort();
    const controller = (this.compilation = new AbortController()),
      generation = ++this.generation;
    this.publish({ compiling: true });
    try {
      const authored = readNativeWorkspace(this.state.documents);
      const broker = studioAuthoringPluginBroker(),
        plan = createStudioAuthoringPluginPlan(
          authored.project.plugins,
          STUDIO_PLUGIN_CATALOG,
          STUDIO_PLUGIN_ENVIRONMENT,
          Boolean(broker),
        );
      if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        throw new Error(plan.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
      if (!this.authoring || this.authoringKey !== plan.key) {
        const previous = this.authoring;
        this.authoringController.abort();
        this.authoringController = new AbortController();
        this.authoringKey = plan.key;
        this.authoring = loadStudioAuthoringPlugins(plan, broker, this.authoringController.signal);
        void previous?.then((plugins) => plugins.dispose()).catch(() => undefined);
      }
      const authoring = await this.authoring;
      controller.signal.throwIfAborted();
      this.editorHost = authoring.host;
      const result = { project: authoring.host.compileDocuments(authored) };
      const { compileAltairVegaPreviewStory } = await import("@haneoka/altair-plugin-vega-preview");
      let previewProject = result.project;
      let sceneId: string;
      let previewSourceIndex = 0;
      if (isScene(active.path)) sceneId = parseAltairSceneDocument(active.text).id;
      else {
        const editor = this.editorFor(active.path);
        editor?.validate?.(active);
        const preview = editor
          ? await authoring.host.previewDocument(editor.id, active, result.project, controller.signal)
          : undefined;
        if (!preview) {
          this.publish({ project: result.project, compiling: false, compilation: undefined, error: "" });
          return;
        }
        controller.signal.throwIfAborted();
        sceneId = preview.scene.id;
        previewSourceIndex = Math.max(
          0,
          preview.scene.commands.findIndex((command) => command.id === preview.commandId),
        );
        previewProject = { ...result.project, scenes: [...result.project.scenes, preview.scene] };
      }
      const compilation = await compileAltairVegaPreviewStory({
        project: previewProject,
        sceneId,
        signal: controller.signal,
      });
      if (this.disposed || generation !== this.generation) return;
      this.previewSourceIndex = previewSourceIndex;
      const resourceFiles = this.state.files.filter(
        (file) =>
          !isScene(file.path) &&
          ![NATIVE_PROJECT_PATH, COMMAND_LIBRARY_PATH].includes(file.path) &&
          this.editorFor(file.path)?.affectsPreview !== false,
      );
      const resourceUrls = this.previewResources.publish(resourceFiles, this.state.documents);
      const resources = resourceFiles.map((file) =>
        createWebGalAuthoringWorkspaceFile(
          file.path,
          new File([file.blob], file.path.split("/").at(-1)!),
          resourceUrls.get(file.path)!,
        ),
      );
      this.publish({
        project: result.project,
        name: result.project.meta.title || this.state.name,
        compilation: {
          ...compilation,
          story: hydrateWebGalWorkspaceAssetUrls(compilation.story, resources),
        },
        diagnostics: compilation.diagnostics,
        compiling: false,
        error: "",
      });
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      this.publish({
        compiling: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  runtimeIndex(line = this.state.line): number {
    const { project, compilation } = this.state;
    if (!isScene(this.state.active))
      return (
        compilation?.commandMappings.find(
          (mapping) =>
            mapping.sceneId === compilation.sceneId && mapping.sourceCommandIndex === this.previewSourceIndex,
        )?.commandIndex ?? 0
      );
    if (!project || !compilation) return 0;
    const scene = project.scenes.find((scene) => scene.id === compilation.sceneId);
    const node = [...this.statements()].reverse().find((statement) => statement.line <= line);
    const authored = scene?.commands.findIndex((command) => command.id === node?.id) ?? -1;
    return (
      compilation.commandMappings.find(
        (mapping) => mapping.sceneId === compilation.sceneId && mapping.sourceCommandIndex === authored,
      )?.commandIndex ?? 0
    );
  }
  url(path: string): string | undefined {
    let url = this.urls.get(path);
    const file = this.state.files.find((file) => file.path === path);
    if (!url && file) {
      url = URL.createObjectURL(file.blob);
      this.urls.set(path, url);
    }
    return url;
  }
  validateDocuments(documents = this.state.documents): void {
    for (const doc of documents) {
      try {
        this.validateDocument(doc.path, doc.text);
      } catch (error) {
        throw new Error(`${doc.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    readNativeWorkspace(documents);
  }
  save(): Promise<void> {
    if (this.options.ephemeral) return Promise.reject(new Error("Preview sessions cannot save project files"));
    if (this.pathTask) return this.pathTask.then(() => this.save());
    if (this.folderTask) return this.folderTask.then(() => this.save());
    if (this.saveTask) return this.saveTask.then(() => this.save());
    this.saveTask = (
      this.workspace?.directory && globalThis.navigator?.locks
        ? withNativeImportLock(this.state.id, () => this.saveNow())
        : this.saveNow()
    ).finally(() => {
      this.saveTask = undefined;
    });
    return this.saveTask;
  }
  private async saveNow(): Promise<void> {
    this.publish({ saving: true, error: "" });
    let documents = this.state.documents;
    const saved = new Map<string, string>();
    try {
      if (await projectLibrary.nativeImport(this.state.id))
        throw new Error(tr("Review the unfinished native import before saving this project."));
      if (this.localRefresh) await this.localRefresh;
      if (this.workspace?.directory) await this.syncLocalFiles(this.workspace, await this.workspace.refresh(), true);
      documents = this.state.documents;
      this.validateDocuments(documents);
      if (this.workspace?.capabilities.writable) {
        for (const path of this.pendingFiles) {
          if (documents.some((document) => document.path === path)) continue;
          const file = this.state.files.find((file) => file.path === path);
          if (!file) continue;
          if (this.workspace.match(path)) throw new Error(tr("A file with this name already exists"));
          await this.workspace.write(path, file.blob, { create: true });
          this.pendingFiles.delete(path);
        }
      }
      const current = await projectLibrary.get(this.state.id);
      const currentFiles = new Map(current?.files.map((file) => [file.path, file]) ?? []);
      if (
        !this.workspace?.directory &&
        current &&
        current.revision !== this.libraryRevision &&
        this.state.files.some((file) => !currentFiles.has(file.path) && !this.pendingFiles.has(file.path))
      )
        throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
      for (const doc of documents) {
        if (doc.external !== undefined)
          throw new Error(tr("Resolve the external change first: {{p0}}", { p0: doc.path }));
        if (doc.text === doc.baseline) continue;
        if (!this.workspace?.capabilities.writable) {
          const file = currentFiles.get(doc.path);
          if (file) {
            const external = await file.blob.text();
            if (external !== doc.baseline && external !== doc.text) {
              this.publish({
                documents: this.state.documents.map((item) => (item.path === doc.path ? { ...item, external } : item)),
              });
              throw new Error(tr("File changed in another window: {{p0}}", { p0: doc.path }));
            }
          }
        }
        if (currentFiles.has(doc.path) && !this.pendingFiles.has(doc.path))
          await this.projectHistory.capture(doc.path, doc.baseline, "before-save");
        if (this.workspace?.capabilities.writable) {
          const known = this.workspace.match(doc.path);
          if (known) {
            const external = await (await this.workspace.file(doc.path)).text();
            if (external !== doc.baseline && external !== doc.text) {
              this.publish({
                documents: this.state.documents.map((current) =>
                  current.path === doc.path ? { ...current, external } : current,
                ),
              });
              throw new Error(tr("File changed on disk: {{p0}}", { p0: doc.path }));
            }
          }
          await this.workspace.write(doc.path, doc.text, { create: true });
        }
        saved.set(doc.path, doc.text);
        this.pendingFiles.delete(doc.path);
      }
      const merged = this.workspace?.directory
        ? new Map(this.state.files.map((file) => [file.path, file]))
        : new Map(currentFiles);
      for (const file of this.state.files)
        if (!merged.has(file.path) || saved.has(file.path)) merged.set(file.path, file);
      const files = [...merged.values()].map((file) =>
        saved.has(file.path)
          ? {
              path: file.path,
              blob: new Blob([saved.get(file.path)!], {
                type: file.blob.type || "text/plain",
              }),
            }
          : file,
      );
      const refreshed = await Promise.all(
        files
          .filter((file) => isText(file.path))
          .map(async (file) => {
            const text = await file.blob.text(),
              local = this.document(file.path);
            if (local?.text !== local?.baseline && !saved.has(file.path)) return local!;
            if (local && saved.has(file.path))
              return {
                ...local,
                baseline: saved.get(file.path)!,
                external: undefined,
              };
            if (local && local.text === text) return local;
            return {
              path: file.path,
              text,
              baseline: text,
              revision: (local?.revision ?? 0) + 1,
            };
          }),
      );
      const beforeCommit = new Map(this.state.documents.map((document) => [document.path, document]));
      const savedProject = await projectLibrary.commit(
        {
          id: this.state.id,
          name: this.state.name,
          updatedAt: Date.now(),
          files,
          directories: projectDirectories(
            files,
            this.workspace?.directory
              ? this.state.directories
              : [...this.state.directories, ...(current?.directories ?? [])],
          ),
          ...(this.workspace?.directory
            ? { directory: this.workspace.directory }
            : current?.directory
              ? { directory: current.directory }
              : {}),
        },
        current?.revision,
      );
      this.libraryRevision = savedProject.revision;
      for (const file of files) this.pendingFiles.delete(file.path);
      const reconciled = new Map(refreshed.map((document) => [document.path, document]));
      for (const live of this.state.documents) {
        if (live === beforeCommit.get(live.path) && reconciled.has(live.path)) continue;
        const stored = reconciled.get(live.path);
        reconciled.set(live.path, stored ? { ...live, baseline: stored.baseline } : live);
      }
      for (const doc of reconciled.values()) {
        const previous = this.document(doc.path);
        if (!this.history.has(doc.path)) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
        else if (previous?.text === previous?.baseline && previous?.text !== doc.text)
          this.history.get(doc.path)!.reset(doc.text);
      }
      this.publish({
        files: [...files, ...this.state.files.filter((file) => !merged.has(file.path))],
        directories: savedProject.directories ?? this.state.directories,
        documents: [...reconciled.values()],
      });
      await this.persistDraft();
      const savedVersions = saved.size
        ? saved
        : new Map(this.document() ? [[this.state.active, this.document()!.baseline]] : []);
      for (const [path, text] of savedVersions) {
        try {
          await this.projectHistory.capture(path, text, "manual-save");
        } catch (error) {
          this.publish({ error: tr("History warning: {{error}}", { error: String(error) }) });
        }
      }
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.publish({ saving: false });
    }
  }
  /** The host calls this when the authenticated identity/permission scope changes. */
  setContextIdentity(identity: string): void {
    if (identity === this.contextIdentity) return;
    this.contextIdentity = identity;
    this.contextEpoch++;
    this.contextLifetime.abort(new DOMException("Account context changed", "AbortError"));
    this.contextLifetime = new AbortController();
    this.importOperation?.abort(new DOMException("Account context changed", "AbortError"));
    this.publish({ contextEpoch: this.contextEpoch });
  }
  importPublicAsset(
    asset: EditorPublicAsset,
    reader: PublicAssetByteReader,
    options: { directory: string; author: string; license: string; version: string; signal?: AbortSignal },
  ): Promise<readonly string[]> {
    const selected = structuredClone(asset),
      settings = { ...options },
      requestedEpoch = this.contextEpoch;
    return this.runPathTask(async () => {
      settings.signal?.throwIfAborted();
      if (requestedEpoch !== this.contextEpoch) throw new DOMException("Account context changed", "AbortError");
      const workspace = this.workspace,
        native = Boolean(workspace?.directory),
        root = workspace?.directory;
      if (native) assertNativeImportHost(workspace!);
      const controller = new AbortController(),
        forward = () => controller.abort(settings.signal?.reason);
      this.importOperation = controller;
      settings.signal?.addEventListener("abort", forward, { once: true });
      this.publish({ saving: true, error: "" });
      try {
        if (settings.signal?.aborted) forward();
        const lifetime = () => {
          controller.signal.throwIfAborted();
          this.conflictLifetime.signal.throwIfAborted();
          if (
            this.contextEpoch !== requestedEpoch ||
            this.workspace !== workspace ||
            workspace?.directory !== root ||
            this.disposed
          )
            throw new DOMException("Editor context changed", "AbortError");
        };
        lifetime();
        if (native) {
          if ((await workspace!.permission("readwrite", { request: true })) !== "granted")
            throw new DOMException("Workspace write permission was denied", "NotAllowedError");
          lifetime();
          if (this.localRefresh) await this.localRefresh;
          await this.syncLocalFiles(workspace!, await workspace!.refresh(), true);
          lifetime();
        }
        const captured = this.state,
          manifest = this.document(NATIVE_PROJECT_PATH);
        if (!manifest) throw new Error(tr("Project manifest is missing"));
        assertLocalPublicAssetAvailable(manifest.text, selected);
        if (captured.documents.some((doc) => doc.external !== undefined))
          throw new Error(tr("Resolve external changes before importing assets"));
        const unchanged = () => {
          lifetime();
          if (
            this.state.id !== captured.id ||
            this.state.documents !== captured.documents ||
            this.state.files !== captured.files ||
            this.state.directories !== captured.directories
          )
            throw new Error(tr("The project changed during import"));
        };
        if (this.draftTimer) clearTimeout(this.draftTimer);
        this.draftTimer = undefined;
        await abortableOperation(() => this.persistence.catch(() => undefined), [controller.signal]);
        unchanged();
        const plan = await preparePublicAssetImport({
          asset: selected,
          reader,
          ...settings,
          existing: captured.files,
          directories: captured.directories,
          signal: controller.signal,
        });
        unchanged();
        const text = registerLocalPublicAsset(manifest.text, selected, plan);
        const documents = captured.documents.map((doc) => ({
          ...doc,
          baseline: doc.text,
          ...(doc.path === manifest.path ? { text, baseline: text, revision: doc.revision + 1 } : {}),
        }));
        for (const file of plan.files) {
          if (!isText(file.path)) continue;
          const content = await file.blob.text();
          this.validateDocument(file.path, content);
          documents.push({ path: file.path, text: content, baseline: content, revision: 0 });
        }
        unchanged();
        this.validateDocuments(documents);
        const texts = new Map(documents.map((doc) => [doc.path, doc.text]));
        const files = [...captured.files, ...plan.files].map((file) =>
          texts.has(file.path)
            ? { ...file, blob: new Blob([texts.get(file.path)!], { type: file.blob.type || "text/plain" }) }
            : file,
        );
        const directories = projectDirectories(files, captured.directories);
        const afterProject: LibraryProject = {
          id: captured.id,
          name: captured.name,
          updatedAt: Date.now(),
          files,
          directories,
        };
        let saved: LibraryProject;
        if (native) {
          const current = await projectLibrary.get(captured.id);
          unchanged();
          if (!current || current.revision !== this.libraryRevision)
            throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
          const newPaths = new Set(plan.files.map((file) => file.path));
          const writes: NativeImportWrite[] = files
            .filter(
              (file) =>
                newPaths.has(file.path) ||
                this.pendingFiles.has(file.path) ||
                captured.documents.some(
                  (doc) => doc.path === file.path && (doc.text !== doc.baseline || doc.path === manifest.path),
                ),
            )
            .map((file) => ({
              path: file.path,
              after: file.blob,
              ...(!newPaths.has(file.path) && !this.pendingFiles.has(file.path)
                ? { expected: captured.documents.find((doc) => doc.path === file.path)!.baseline }
                : {}),
            }))
            .sort((a, b) => Number(!newPaths.has(a.path)) - Number(!newPaths.has(b.path)));
          const journal = await prepareNativeImport(
            workspace!,
            { ...current, files: captured.files, directories: captured.directories },
            afterProject,
            writes,
            unchanged,
          );
          saved = await applyNativeImport(workspace!, journal, unchanged, controller.signal);
        } else {
          saved = await projectLibrary.commit(
            afterProject,
            this.libraryRevision,
            undefined,
            undefined,
            unchanged,
            controller.signal,
            true,
          );
        }
        this.libraryRevision = saved.revision;
        for (const doc of documents) {
          if (!this.history.has(doc.path)) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
          else if (doc.path === manifest.path) this.history.get(doc.path)!.replace(doc.text);
        }
        for (const file of files) this.pendingFiles.delete(file.path);
        this.publish({ files: saved.files, documents, directories });
        this.syncHistory();
        await abortableOperation(() => this.compile(), [this.conflictLifetime.signal, controller.signal]).catch(
          (error) => {
            if (!this.conflictLifetime.signal.aborted && !controller.signal.aborted) throw error;
          },
        );
        return plan.files.map((file) => file.path);
      } catch (error) {
        if (error instanceof NativeImportFailure) {
          if (error.restoredProject) this.libraryRevision = error.restoredProject.revision;
          if (error.pending) {
            this.localUnsubscribe?.();
            this.localUnsubscribe = undefined;
            await this.localWatch?.dispose();
            this.localWatch = undefined;
            this.publish({ nativeImportRecovery: { id: error.pending.id, fileCount: error.pending.entries.length } });
            this.syncHistory();
          }
        }
        if (!controller.signal.aborted && !this.disposed)
          this.publish({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        settings.signal?.removeEventListener("abort", forward);
        if (this.importOperation === controller) this.importOperation = undefined;
        this.publish({ saving: false });
        this.scheduleDraft();
      }
    });
  }
  private readonly nativeReviews = new WeakMap<
    NativeImportReview,
    {
      epoch: number;
      workspace: AltairBrowserWorkspaceService;
      root: BrowserWorkspaceDirectoryHandle;
      documents: readonly EditorDocument[];
    }
  >();
  async reviewNativeImport(signal?: AbortSignal): Promise<NativeImportReview> {
    const workspace = this.workspace,
      epoch = this.contextEpoch,
      documents = this.state.documents,
      root = workspace?.directory;
    if (!workspace?.directory) throw new Error(tr("Open the original folder to recover this import."));
    if (this.state.saving || this.pathTask) throw new Error(tr("Saving"));
    const guard = () => {
      signal?.throwIfAborted();
      this.conflictLifetime.signal.throwIfAborted();
      if (
        this.workspace !== workspace ||
        workspace.directory !== root ||
        this.contextEpoch !== epoch ||
        this.state.documents !== documents
      )
        throw new Error(tr("The import recovery changed. Review it again."));
    };
    const journal = await projectLibrary.nativeImport(this.state.id);
    guard();
    if (!journal) throw new Error(tr("The import recovery changed. Review it again."));
    const review = await abortableOperation(
      () => reviewNativeImport(workspace, journal, guard),
      [signal, this.conflictLifetime.signal, this.contextLifetime.signal],
    );
    guard();
    this.nativeReviews.set(review, { epoch, workspace, root: root!, documents });
    return review;
  }
  resolveNativeImport(review: NativeImportReview, choice: "finish" | "restore", signal?: AbortSignal): Promise<void> {
    return this.runPathTask(async () => {
      const captured = this.nativeReviews.get(review);
      if (!captured) throw new Error(tr("The import recovery changed. Review it again."));
      const guard = () => {
        signal?.throwIfAborted();
        this.conflictLifetime.signal.throwIfAborted();
        if (
          this.workspace !== captured.workspace ||
          captured.workspace.directory !== captured.root ||
          this.contextEpoch !== captured.epoch ||
          this.state.documents !== captured.documents ||
          this.state.nativeImportRecovery?.id !== review.journal.id
        )
          throw new Error(tr("The import recovery changed. Review it again."));
      };
      guard();
      this.publish({ saving: true, error: "" });
      try {
        const saved = await resolveNativeImport(captured.workspace, review, choice, guard, signal);
        this.libraryRevision = saved.revision;
        const documents = await Promise.all(
          saved.files
            .filter((file) => isText(file.path))
            .map(async (file) => {
              const baseline = await file.blob.text(),
                old = this.document(file.path),
                text = choice === "restore" && old && old.text !== old.baseline ? old.text : baseline;
              return { path: file.path, text, baseline, revision: (old?.revision ?? 0) + 1 };
            }),
        );
        for (const doc of documents) {
          if (!this.history.has(doc.path)) this.history.set(doc.path, this.histories.create(doc.path, doc.text));
          else if (this.document(doc.path)?.text !== doc.text) this.history.get(doc.path)!.replace(doc.text);
        }
        const tabs = this.state.tabs.filter((path) => documents.some((doc) => doc.path === path));
        this.publish({
          files: saved.files,
          directories: saved.directories ?? [],
          documents,
          tabs,
          active: documents.some((doc) => doc.path === this.state.active)
            ? this.state.active
            : (tabs.at(-1) ?? documents[0]?.path ?? ""),
          nativeImportRecovery: undefined,
          error: "",
        });
        this.syncHistory();
        this.scheduleDraft();
        this.startLocalWatch();
        await abortableOperation(() => this.compile(), [signal, this.conflictLifetime.signal]).catch((error) => {
          if (!signal?.aborted && !this.conflictLifetime.signal.aborted) throw error;
        });
      } catch (error) {
        if (!signal?.aborted && !this.conflictLifetime.signal.aborted && this.contextEpoch === captured.epoch)
          this.publish({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        this.publish({ saving: false });
      }
    }, true);
  }
  conflictReview(path: string): ConflictReview | undefined {
    return captureConflictReview(this.state.id, this.document(path), this.contextEpoch);
  }
  resolveReviewedConflict(review: ConflictReview, choice: "disk" | "editor", signal?: AbortSignal): Promise<void> {
    return this.runPathTask(async () => {
      if (choice !== "disk" && choice !== "editor") throw new TypeError("Invalid conflict resolution choice");
      const workspace = this.workspace,
        root = workspace?.directory,
        contextSignal = this.contextLifetime?.signal;
      const unchanged = () => {
        signal?.throwIfAborted();
        contextSignal?.throwIfAborted();
        this.conflictLifetime.signal.throwIfAborted();
        if (
          this.disposed ||
          this.workspace !== workspace ||
          workspace?.directory !== root ||
          !conflictReviewMatches(this.state.id, this.document(review.path), review, this.contextEpoch)
        )
          throw new Error(tr("The conflict changed while reviewing. Review it again."));
      };
      const readExternal = async (): Promise<{ text: string; missing: boolean }> => {
        if (workspace?.directory) {
          try {
            return { text: await (await workspace.file(review.path)).text(), missing: false };
          } catch (error) {
            if (error instanceof DOMException && error.name === "NotFoundError") return { text: "", missing: true };
            throw error;
          }
        }
        const project = await projectLibrary.get(this.state.id);
        if (!project) throw new Error(tr("The project is no longer available"));
        const file = project.files.find((file) => file.path === review.path);
        return file ? { text: await file.blob.text(), missing: false } : { text: "", missing: true };
      };
      const verifyExternal = async () => {
        const external = await abortableOperation(readExternal, [signal, contextSignal, this.conflictLifetime.signal]);
        unchanged();
        if (external.text !== review.external) {
          this.publish({
            documents: this.state.documents.map((document) =>
              document.path === review.path ? { ...document, external: external.text } : document,
            ),
          });
          throw new Error(tr("The file changed again outside the editor. Review it again."));
        }
        return external;
      };
      unchanged();
      if (choice === "disk") this.validateDocument(review.path, review.external);
      this.publish({ saving: true, error: "" });
      try {
        const first = await verifyExternal();
        if (choice === "disk" && first.missing)
          throw new Error(tr("The file was removed outside the editor. Keep the editor version to recreate it."));
        // Back up only the side about to be overwritten: retention max1 must still protect it.
        await abortableOperation(
          () =>
            this.projectHistory.capture(
              review.path,
              choice === "disk" ? review.text : review.external,
              choice === "disk" ? "before-restore" : "before-save",
              true,
            ),
          [signal, contextSignal, this.conflictLifetime.signal],
        );
        unchanged();
        const current = await verifyExternal();
        unchanged();
        if (choice === "disk" && current.missing)
          throw new Error(tr("The file was removed outside the editor. Keep the editor version to recreate it."));
        if (choice === "editor" && current.missing) this.pendingFiles.add(review.path);
        const replacement = conflictReplacement(review, choice);
        this.publish({
          documents: this.state.documents.map((document) =>
            document.path === review.path ? { ...document, ...replacement, external: undefined } : document,
          ),
          error: "",
        });
        if (choice === "disk") this.history.get(review.path)?.reset(review.external);
        this.syncHistory();
        this.scheduleDraft();
        await this.compile();
      } catch (error) {
        if (!signal?.aborted && !contextSignal?.aborted && !this.conflictLifetime.signal.aborted)
          this.publish({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        this.publish({ saving: false });
      }
    });
  }
  /** Existing plugin workspace API remains void; its errors stay visible in the session. */
  resolveConflict(path: string, choice: "disk" | "editor") {
    const review = this.conflictReview(path);
    if (!review) return;
    void this.resolveReviewedConflict(review, choice).catch((error) => {
      if (!this.disposed && !this.conflictLifetime.signal.aborted && (review.contextEpoch ?? 0) === this.contextEpoch)
        this.publish({ error: error instanceof Error ? error.message : String(error) });
    });
  }
  async dispose() {
    if (this.disposed) return;
    this.conflictLifetime.abort(new DOMException("Editor closed", "AbortError"));
    this.importOperation?.abort(new DOMException("Editor closed", "AbortError"));
    this.compilation?.abort();
    this.authoringController.abort();
    await this.pathTask?.catch(() => undefined);
    await this.folderTask?.catch(() => undefined);
    await this.saveTask?.catch(() => undefined);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    await this.persistDraft();
    await this.projectHistory.dispose();
    this.disposed = true;
    this.localUnsubscribe?.();
    await this.localWatch?.dispose();
    await this.workspace?.dispose();
    this.authoringController.abort();
    await this.authoring?.then((plugins) => plugins.dispose()).catch(() => undefined);
    this.histories.dispose();
    this.previewResources.dispose();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    for (const url of this.retiredUrls) URL.revokeObjectURL(url);
    this.retiredUrls.clear();
    this.listeners.clear();
  }
}
