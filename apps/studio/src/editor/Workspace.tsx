import { WebGalEngineDialog } from "./WebGalEngineDialog";
import { PluginPanel } from "./PluginPanel";
import { tr, useStudioI18n } from "./i18n";
import { InterfaceLanguage } from "./InterfaceLanguage";
import { ProjectSettings } from "./ProjectSettings";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Code2,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  GanttChart,
  LayoutList,
  Library,
  Star,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { parseAltairSceneDocument } from "@haneoka/altair";
import { nativeStatements, nativeCommands, nativeScenePath, NATIVE_PROJECT_PATH } from "./native-project";
import { readLocalizedText } from "./localized-text";
import { sessionCommandLibrary, COMMAND_LIBRARY_PATH, insertLibraryCommand } from "./command-library";
import {
  altairCommandTypeKey,
  parseAltairProjectDocument,
  parseAuthoredText,
  type AltairAuthoredNode,
} from "@haneoka/altair";
import { Preview } from "./Preview";
import { NativeInspector } from "./NativeInspector";
import { type EditorSession } from "./session";
import { exportProjectZip } from "./archive";
import type { ProjectFile } from "./library";
import "./mobile-workspace.css";
import "./workspace-expressive.css";
import { FileTree } from "./FileTree";
import { FileActionsDialog } from "./FileActionsDialog";
import { FileRecoveryDialog } from "./FileRecoveryDialog";
import { ConflictResolutionDialog } from "./ConflictResolutionDialog";
const NativeImportRecoveryDialog = lazy(() =>
  import("./NativeImportRecoveryDialog").then((module) => ({ default: module.NativeImportRecoveryDialog })),
);
const PublicResourcePicker = lazy(() =>
  import("./PublicResourcePicker").then((module) => ({ default: module.PublicResourcePicker })),
);
const ProjectHistoryDialog = lazy(() =>
  import("./ProjectHistoryDialog").then((module) => ({ default: module.ProjectHistoryDialog })),
);
const CommandLibraryPanel = lazy(() =>
  import("./CommandLibraryPanel").then((module) => ({
    default: module.CommandLibraryPanel,
  })),
);
const SourceEditor = lazy(() => import("./SourceEditor"));
const TimelineEditor = lazy(() =>
  import("./TimelineEditor").then((module) => ({
    default: module.TimelineEditor,
  })),
);
export function Workspace({ session, onHome }: { session: EditorSession; onHome: () => void }) {
  const { i18n } = useStudioI18n();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const [mobilePage, setMobilePage] = useState("editor");
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const assetFileInput = useRef<HTMLInputElement>(null),
    assetFolderInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    doc = session.document();
  const [fileAction, setFileAction] = useState<{
    action: "move" | "copy" | "folder";
    source: string;
    target?: string;
  }>();
  const [fileClipboard, setFileClipboard] = useState<{ path: string; cut: boolean }>();
  const [recovery, setRecovery] = useState<{ source?: string }>();
  const [historyPath, setHistoryPath] = useState("");
  const [nativeRecoveryView, setNativeRecoveryView] = useState<"recovery" | "backups">();
  const [publicPicker, setPublicPicker] = useState(false);
  useEffect(() => {
    if (state.nativeImportRecovery) setNativeRecoveryView("recovery");
  }, [session, state.nativeImportRecovery?.id]);
  const [conflictTarget, setConflictTarget] = useState<{
    session: EditorSession;
    projectId: string;
    path: string;
    contextEpoch: number;
  }>();
  const docEditor = doc && session.editorFor(doc.path);
  const mode = state.view ?? "visual",
    setMode = (view: string) => session.setView(view);
  const workspacePanels = (session.editorHost?.contributionSelections("panel") ?? [])
    .filter(({ active, contribution }) => active && contribution.slot === "workspace")
    .map(({ owner, contribution }) => ({ ...contribution, selector: `${owner}:${contribution.id}` }));
  const workspacePanel = workspacePanels.find((panel) => mode === `panel:${panel.selector}`);
  useEffect(() => {
    if (mode.startsWith("panel:") && !workspacePanel) session.setView("visual");
  }, [session, mode, workspacePanel?.selector]);
  const [leftTab, setLeftTab] = useState("scenes"),
    [category, setCategory] = useState("dialogue"),
    [search, setSearch] = useState(""),
    [newFile, setNewFile] = useState(false),
    [newFileKind, setNewFileKind] = useState("scene"),
    [filename, setFilename] = useState(""),
    [issue, setIssue] = useState(""),
    [asset, setAsset] = useState(""),
    [importAssets, setImportAssets] = useState(false),
    [importingAssets, setImportingAssets] = useState(false),
    [assetFiles, setAssetFiles] = useState<readonly ProjectFile[]>([]),
    [assetImportError, setAssetImportError] = useState(""),
    [assetPack, setAssetPack] = useState(() => ({
      id: crypto.randomUUID(),
      version: "1.0.0",
      author: "",
      license: "",
      directory: "assets/shared",
    })),
    [showSettings, setShowSettings] = useState(false),
    [showLibrary, setShowLibrary] = useState(false);
  const manifestSource = session.document(NATIVE_PROJECT_PATH)?.text ?? "";
  const librarySource = session.document(COMMAND_LIBRARY_PATH)?.text;
  const authoringLocale = useMemo(() => {
    try {
      return parseAltairProjectDocument(manifestSource).locales[0] ?? "und";
    } catch {
      return "und";
    }
  }, [manifestSource]);
  const commandLibrary = useMemo(() => {
    try {
      return sessionCommandLibrary(session);
    } catch {
      return undefined;
    }
  }, [session, librarySource]);
  const favorites = new Set(commandLibrary?.favorites.map(altairCommandTypeKey));
  const insertCommand = (node: Parameters<EditorSession["insert"]>[0], line?: number) => {
    try {
      insertLibraryCommand(
        session,
        typeof node === "string" ? (parseAuthoredText(node) as unknown as AltairAuthoredNode) : node,
        line,
      );
    } catch (error) {
      setIssue(String(error));
    }
  };
  const compilationRevision = JSON.stringify([
    state.documents
      .filter(
        (document) =>
          document.path !== COMMAND_LIBRARY_PATH && session.editorFor(document.path)?.affectsPreview !== false,
      )
      .map((document) => [document.path, document.revision]),
    state.files
      .filter((file) => file.path !== COMMAND_LIBRARY_PATH && session.editorFor(file.path)?.affectsPreview !== false)
      .filter((file) => !state.documents.some((document) => document.path === file.path))
      .map((file) => [file.path, file.blob.size, (file.blob as File).lastModified ?? 0]),
  ]);
  const statements = useMemo(() => nativeStatements(doc?.text ?? ""), [doc?.text, i18n.language]);
  const selected = [...statements].reverse().find((statement) => statement.line <= state.line);
  const dirty = state.documents.some((document) => document.text !== document.baseline);
  useEffect(() => {
    const timer = setTimeout(() => void session.compile(), 180);
    return () => clearTimeout(timer);
  }, [session, compilationRevision]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void session.save().catch(() => {});
      }
      const target = event.target as HTMLElement;
      if (target.closest(".monaco-editor") || target.matches("input,textarea")) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? session.redo() : session.undo();
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || state.saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [session, dirty, state.saving]);
  const sceneFiles = state.documents.filter((file) => nativeScenePath(file.path));
  const resourceFiles = state.files.filter((file) => !sceneFiles.some((scene) => scene.path === file.path));
  const propertyFile = state.files.find(
    (file) => file.path === (asset || (doc && !nativeScenePath(doc.path) ? doc.path : "")),
  );
  const conflictDocument = asset ? session.document(asset) : doc;
  const fileTreeActions = {
    disabled: state.saving,
    canPaste: Boolean(fileClipboard),
    dirtyPaths: new Set(state.documents.filter((doc) => doc.text !== doc.baseline).map((doc) => doc.path)),
    onMove: (source: string) => setFileAction({ action: "move", source }),
    onCopy: (path: string) => setFileClipboard({ path, cut: false }),
    onCut: (path: string) => setFileClipboard({ path, cut: true }),
    onDuplicate: (source: string) => {
      const match = source.match(/^(.*?)(\.scene\.ya?ml|\.[^/.]+)?$/u)!;
      let target = `${match[1]}_copy${match[2] ?? ""}`,
        suffix = 2;
      while (state.files.some((file) => file.path === target) || state.directories.includes(target))
        target = `${match[1]}_copy${suffix++}${match[2] ?? ""}`;
      setFileAction({ action: "copy", source, target });
    },
    onPaste: (directory: string) => {
      if (!fileClipboard) return;
      const filename = fileClipboard.path.split("/").at(-1)!;
      setFileAction({
        action: fileClipboard.cut ? "move" : "copy",
        source: fileClipboard.path,
        target: directory ? `${directory}/${filename}` : filename,
      });
    },
    onNewDirectory: (directory: string) =>
      setFileAction({ action: "folder", source: directory, target: directory ? `${directory}/` : "" }),
    onDelete: (source: string) => setRecovery({ source }),
  };
  const enterHome = () => {
    if (state.saving) return;
    if (dirty) {
      setIssue(tr("Save your project before returning, or close this message to continue editing."));
      return;
    }
    onHome();
  };
  return (
    <main className="workspace" data-mobile-page={mobilePage}>
      {publicPicker && (
        <Suspense fallback={null}>
          <PublicResourcePicker
            key={`${state.id}:${state.contextEpoch ?? 0}`}
            session={session}
            onClose={() => setPublicPicker(false)}
          />
        </Suspense>
      )}
      {nativeRecoveryView && (
        <Suspense fallback={null}>
          <NativeImportRecoveryDialog
            key={`${state.id}:${state.contextEpoch ?? 0}:${nativeRecoveryView}`}
            session={session}
            backups={nativeRecoveryView === "backups"}
            onClose={() => setNativeRecoveryView(undefined)}
          />
        </Suspense>
      )}
      {state.nativeImportRecovery && (
        <section className="document-conflict-banner" role="status">
          <div>
            <strong>{tr("Unfinished native import")}</strong>
            <p>{tr("Review folder changes before continuing to edit.")}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={state.saving}
            onClick={() => setNativeRecoveryView("recovery")}
          >
            {tr("Recover unfinished import")}
          </button>
        </section>
      )}
      {conflictTarget?.session === session &&
        conflictTarget.projectId === state.id &&
        conflictTarget.contextEpoch === (state.contextEpoch ?? 0) && (
          <ConflictResolutionDialog
            key={`${conflictTarget.projectId}:${conflictTarget.path}:${conflictTarget.contextEpoch}`}
            session={session}
            path={conflictTarget.path}
            onClose={() => setConflictTarget(undefined)}
          />
        )}
      {historyPath && (
        <Suspense fallback={null}>
          <ProjectHistoryDialog session={session} path={historyPath} onClose={() => setHistoryPath("")} />
        </Suspense>
      )}
      {recovery && (
        <FileRecoveryDialog
          session={session}
          source={recovery.source}
          onClose={() => setRecovery(undefined)}
          onDeleted={(path) => {
            if (asset === path || asset.startsWith(`${path}/`)) setAsset("");
            if (fileClipboard?.path === path || fileClipboard?.path.startsWith(`${path}/`)) setFileClipboard(undefined);
          }}
        />
      )}
      {fileAction && (
        <FileActionsDialog
          key={`${fileAction.action}:${fileAction.source}:${fileAction.target ?? ""}`}
          session={session}
          source={fileAction.source}
          action={fileAction.action}
          initialTarget={fileAction.target}
          onClose={() => setFileAction(undefined)}
          onMoved={(paths) => {
            setAsset((current) => paths.get(current) ?? current);
            if (fileClipboard?.cut && fileAction.action === "move" && fileClipboard.path === fileAction.source)
              setFileClipboard(undefined);
          }}
        />
      )}
      {showLibrary && (
        <Suspense fallback={null}>
          <CommandLibraryPanel session={session} onClose={() => setShowLibrary(false)} />
        </Suspense>
      )}
      <header className="workspace-header">
        <button className="icon-button" aria-label={tr("Back to projects")} disabled={state.saving} onClick={enterHome}>
          <ArrowLeft size={19} />
        </button>
        <span className="project-symbol">A</span>
        <strong>{state.name}</strong>
        <button className="icon-button" aria-label={tr("Project settings")} onClick={() => setShowSettings(true)}>
          <Settings2 size={16} />
        </button>
        <DropdownMenu.Root dir={i18n.dir()}>
          <DropdownMenu.Trigger className="secondary-button" aria-label={tr("Project files")}>
            <Folder size={15} />
            {tr("File")}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="editor-file-menu" align="start" sideOffset={7}>
              <DropdownMenu.Item
                disabled={state.saving}
                onSelect={() => void session.save().catch((error) => setIssue(String(error)))}
              >
                {tr("Save")}
                <span>Ctrl S</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={state.saving}
                onSelect={() =>
                  void session.writeToFolder().catch((error) => {
                    if (!(error instanceof DOMException && error.name === "AbortError")) setIssue(String(error));
                  })
                }
              >
                {tr("Write to folder")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={state.saving || !state.localFolder}
                onSelect={() => void session.refreshLocalFiles().catch((error) => setIssue(String(error)))}
              >
                {tr("Refresh local files")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item disabled={!doc || state.saving} onSelect={() => setHistoryPath(state.active)}>
                {tr("Version history")}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={state.saving} onSelect={() => setNativeRecoveryView("backups")}>
                {tr("Native import backups")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => void exportProjectZip(session).catch((error) => setIssue(String(error)))}
              >
                {tr("Export project")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div className="header-spacer" />
        <InterfaceLanguage />
        <WebGalEngineDialog session={session} exportMode />
        <button className="secondary-button" aria-label={tr("Command library")} onClick={() => setShowLibrary(true)}>
          <Library size={15} />
          <span className="workspace-action-label">{tr("Command library")}</span>
        </button>
        <button disabled={!state.canUndo} title={tr("Undo")} aria-label={tr("Undo")} onClick={() => session.undo()}>
          <Undo2 size={16} />
        </button>
        <button disabled={!state.canRedo} title={tr("Redo")} aria-label={tr("Redo")} onClick={() => session.redo()}>
          <Redo2 size={16} />
        </button>
        <button
          className="secondary-button"
          onClick={() => void session.save().catch(() => {})}
          disabled={state.saving}
          aria-label={tr("Save")}
        >
          <Save size={15} />
          <span className="workspace-action-label">{state.saving ? tr("Saving") : tr("Save")}</span>
          {dirty && <span className="dirty-dot" />}
        </button>
        <button
          className="primary-button"
          aria-label={tr("Export project")}
          onClick={() => void exportProjectZip(session).catch((error) => setIssue(String(error)))}
        >
          <Download size={15} />
          <span className="workspace-action-label">{tr("Export project")}</span>
        </button>
      </header>
      <Group
        className="workspace-panels"
        orientation="horizontal"
        id="workspace-columns"
        defaultLayout={{ left: 30, editor: 46, inspector: 24 }}
        disabled={mobile}
      >
        <Panel
          id="left"
          className="workspace-files-page"
          minSize={mobile ? 0 : "260px"}
          defaultSize="30%"
          role={mobile ? "tabpanel" : undefined}
          aria-labelledby={mobile ? "mobile-files-tab" : undefined}
        >
          <Group orientation="vertical" id="workspace-left" defaultLayout={{ preview: 48, files: 52 }}>
            <Panel id="preview" minSize="190px">
              <Preview session={session} />
            </Panel>
            <Separator className="resize-handle horizontal" />
            <Panel id="files" minSize="180px">
              <Tabs.Root value={leftTab} onValueChange={setLeftTab} className="file-panel">
                <Tabs.List className="panel-tabs">
                  <Tabs.Trigger value="scenes">{tr("Scenes")}</Tabs.Trigger>
                  <Tabs.Trigger value="resources">{tr("Assets")}</Tabs.Trigger>
                  <button
                    aria-label={tr("New file")}
                    onClick={() => {
                      setNewFileKind(
                        leftTab === "resources"
                          ? (session.documentEditors().find((editor) => editor.create)?.id ?? "scene")
                          : "scene",
                      );
                      setNewFile(true);
                    }}
                  >
                    <FilePlus2 size={15} />
                  </button>
                </Tabs.List>
                <div className="file-search">
                  <Search size={14} />
                  <input
                    aria-label={tr("Search files")}
                    placeholder={tr("Search files\u2026")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="file-tree-toolbar">
                  <button
                    className="icon-button"
                    disabled={state.saving}
                    aria-label={tr("New folder")}
                    onClick={() => fileTreeActions.onNewDirectory(leftTab === "scenes" ? "scenes" : "")}
                  >
                    <FolderPlus size={16} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={state.saving}
                    aria-label={tr("Recovery copies")}
                    onClick={() => setRecovery({})}
                  >
                    <Undo2 size={16} />
                  </button>
                  {fileClipboard && (
                    <button
                      className="secondary-button"
                      disabled={state.saving}
                      onClick={() => fileTreeActions.onPaste(leftTab === "scenes" ? "scenes" : "")}
                      title={fileClipboard.path}
                    >
                      {tr("Paste into folder")}
                    </button>
                  )}
                  {fileClipboard && (
                    <button
                      className="icon-button"
                      aria-label={tr("Clear file clipboard")}
                      onClick={() => setFileClipboard(undefined)}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                <Tabs.Content value="scenes" className="file-list">
                  <FileTree
                    {...fileTreeActions}
                    directories={state.directories.filter((path) => path === "scenes" || path.startsWith("scenes/"))}
                    files={state.files.filter((file) => sceneFiles.some((scene) => scene.path === file.path))}
                    active={state.active}
                    query={search}
                    onOpen={(path) => {
                      session.activate(path);
                      setAsset("");
                      setMobilePage("editor");
                    }}
                  />
                </Tabs.Content>
                <Tabs.Content value="resources" className="file-list">
                  {session
                    .documentEditors()
                    .filter((editor) => editor.create)
                    .map((editor) => (
                      <button
                        key={editor.id}
                        className="resource-import"
                        onClick={() => {
                          setNewFileKind(editor.id);
                          setFilename("");
                          setNewFile(true);
                        }}
                      >
                        <Plus size={14} />
                        {tr("New {{kind}}", { kind: tr(editor.label) })}
                      </button>
                    ))}
                  <FileTree
                    {...fileTreeActions}
                    directories={state.directories.filter((path) => path !== "scenes" && !path.startsWith("scenes/"))}
                    files={resourceFiles}
                    active={asset || state.active}
                    query={search}
                    onOpen={(path) => {
                      if (session.document(path)) {
                        session.activate(path);
                        setMode(session.editorFor(path) ? "visual" : "source");
                        setAsset("");
                      } else setAsset(path);
                      setMobilePage("editor");
                    }}
                  />
                  <button className="resource-import" disabled={state.saving} onClick={() => setImportAssets(true)}>
                    <Plus size={14} />
                    {tr("Import assets")}
                  </button>
                  <button
                    type="button"
                    className="resource-import"
                    disabled={state.saving}
                    onClick={() => setPublicPicker(true)}
                  >
                    <Plus size={14} />
                    {tr("Online assets")}
                  </button>
                </Tabs.Content>
              </Tabs.Root>
            </Panel>
          </Group>
        </Panel>
        <Separator className="resize-handle" />
        <Panel
          id="editor"
          className="workspace-editor-page"
          minSize={mobile ? 0 : "260px"}
          defaultSize="46%"
          role={mobile ? "tabpanel" : undefined}
          aria-labelledby={mobile ? "mobile-editor-tab" : undefined}
        >
          <div className="editing-panel">
            <div className="document-strip">
              <div className="document-tabs" role="tablist" aria-label={tr("Open files")}>
                {state.tabs.map((path) => (
                  <div key={path} className={state.active === path ? "document-tab active" : "document-tab"}>
                    <button
                      role="tab"
                      aria-selected={state.active === path}
                      onClick={() => {
                        session.activate(path);
                        setAsset("");
                      }}
                    >
                      <FileText size={13} />
                      {path.split("/").at(-1)}
                      {session.document(path)?.text !== session.document(path)?.baseline && (
                        <span className="dirty-dot" />
                      )}
                    </button>
                    <button aria-label={tr("Close {{p0}}", { p0: path })} onClick={() => session.close(path)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <Tabs.Root
                value={mode}
                onValueChange={(value) => {
                  setMode(value);
                  setAsset("");
                }}
              >
                <Tabs.List className="mode-switch">
                  <Tabs.Trigger value="visual" title={tr("Visual editor")}>
                    <LayoutList size={15} />
                  </Tabs.Trigger>
                  <Tabs.Trigger value="source" title={tr("Source editor")}>
                    <Code2 size={15} />
                  </Tabs.Trigger>
                  {workspacePanels.map((panel) => (
                    <Tabs.Trigger
                      key={panel.selector}
                      value={`panel:${panel.selector}`}
                      title={tr(panel.name ?? panel.id)}
                    >
                      {tr(panel.name ?? panel.id)}
                    </Tabs.Trigger>
                  ))}
                  <Tabs.Trigger
                    value="timeline"
                    title={tr("Timeline")}
                    disabled={Boolean(doc && !nativeScenePath(doc.path))}
                  >
                    <GanttChart size={15} />
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>
            </div>
            {conflictDocument?.external !== undefined && (
              <div className="document-conflict-banner" role="status">
                <div>
                  <strong>{tr("File changed on disk")}</strong>
                  <p>{conflictDocument.path}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={state.saving}
                  onClick={() =>
                    setConflictTarget({
                      session,
                      projectId: state.id,
                      path: conflictDocument.path,
                      contextEpoch: state.contextEpoch ?? 0,
                    })
                  }
                >
                  {tr("Review conflict")}
                </button>
              </div>
            )}
            {asset ? (
              <div className="asset-preview">
                <h3>{asset}</h3>
                {/\.(?:png|jpe?g|gif|webp|svg)$/iu.test(asset) ? (
                  <img src={session.url(asset)} alt={asset} />
                ) : /\.(mp3|wav|ogg)$/iu.test(asset) ? (
                  <audio src={session.url(asset)} controls />
                ) : /\.(mp4|webm)$/iu.test(asset) ? (
                  <video src={session.url(asset)} controls />
                ) : (
                  <p>{tr("This asset can be referenced by a statement.")}</p>
                )}
              </div>
            ) : workspacePanel ? (
              <PluginPanel session={session} panelId={workspacePanel.selector} path={state.active} />
            ) : doc && docEditor?.panelId ? (
              <Suspense fallback={<div className="empty-panel">{tr("Opening editor…")}</div>}>
                {mode === "source" ? (
                  <SourceEditor session={session} document={doc} line={state.line} />
                ) : (
                  <PluginPanel session={session} panelId={docEditor.panelId} path={doc.path} />
                )}
              </Suspense>
            ) : doc && !nativeScenePath(doc.path) ? (
              <Suspense fallback={null}>
                <SourceEditor session={session} document={doc} line={state.line} />
              </Suspense>
            ) : mode === "timeline" ? (
              <Suspense fallback={<div className="empty-panel">{tr("Opening timeline…")}</div>}>
                <TimelineEditor session={session} />
              </Suspense>
            ) : (
              <div className="document-editor">
                {mode === "source" && doc ? (
                  <Suspense fallback={<div className="empty-panel">{tr("Opening source editor\u2026")}</div>}>
                    <SourceEditor session={session} document={doc} line={state.line} />
                  </Suspense>
                ) : (
                  <div className="sentence-list" role="list" aria-label={tr("Scene statements")}>
                    {statements.map((statement, ordinal) => {
                      const command = nativeCommands.find((command) => command.name === statement.node.type.name);
                      return (
                        <article
                          key={statement.id}
                          role="listitem"
                          tabIndex={0}
                          className={`sentence-card ${selected?.line === statement.line ? "selected" : ""} ${statement.kind === "comment" ? "comment" : ""}`}
                          onClick={() => session.select(statement.line)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") session.select(statement.line);
                          }}
                        >
                          <header>
                            <span className="sentence-line">{String(ordinal + 1).padStart(2, "0")}</span>
                            <span className={`command-kind ${command?.category === "dialogue" ? "performance" : ""}`}>
                              {command?.label ?? statement.name}
                            </span>
                            {statement.kind === "dialogue" && (
                              <strong>
                                {Array.isArray(statement.node.arguments.targetTextNames)
                                  ? statement.node.arguments.targetTextNames
                                      .map((value) => readLocalizedText(value, authoringLocale))
                                      .filter(Boolean)
                                      .join("・") ||
                                    readLocalizedText(statement.node.arguments.targetName, authoringLocale) ||
                                    tr("Narration")
                                  : readLocalizedText(statement.node.arguments.targetTextNames, authoringLocale) ||
                                    readLocalizedText(statement.node.arguments.targetName, authoringLocale) ||
                                    tr("Narration")}
                              </strong>
                            )}
                            <div className="sentence-actions">
                              <button
                                title={tr("Move up")}
                                aria-label={tr("Move statement up")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  session.move(statement, -1);
                                }}
                              >
                                <ArrowUp size={13} />
                              </button>
                              <button
                                title={tr("Move down")}
                                aria-label={tr("Move statement down")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  session.move(statement, 1);
                                }}
                              >
                                <ArrowDown size={13} />
                              </button>
                              <button
                                title={tr("Duplicate")}
                                aria-label={tr("Duplicate statement")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  session.insert(statement.raw, statement.line);
                                }}
                              >
                                <Copy size={13} />
                              </button>
                              <button
                                title={tr("Delete")}
                                aria-label={tr("Delete statement")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  session.remove(statement);
                                }}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </header>
                          <p>
                            {(statement.kind === "dialogue"
                              ? readLocalizedText(statement.node.arguments.text, authoringLocale)
                              : statement.content) ||
                              command?.label ||
                              statement.name}
                          </p>
                          {statement.arguments.length > 0 && (
                            <footer>
                              {statement.arguments.map((arg) => (
                                <span key={arg.name}>
                                  {arg.name}
                                  {arg.value !== true ? ` = ${arg.value}` : ""}
                                </span>
                              ))}
                            </footer>
                          )}
                        </article>
                      );
                    })}
                    <button
                      className="append-statement"
                      onClick={() =>
                        insertCommand(
                          nativeCommands.find((command) => command.name === "Talk")!.initial(),
                          statements.at(-1)?.line ?? 0,
                        )
                      }
                    >
                      <Plus size={15} />
                      {tr("Add statement")}
                    </button>
                  </div>
                )}
              </div>
            )}
            {mode !== "timeline" && doc && nativeScenePath(doc.path) && (
              <section className="command-panel">
                <div className="command-categories" role="tablist" aria-label={tr("Command categories")}>
                  <button
                    role="tab"
                    aria-selected={category === "favorites"}
                    className={category === "favorites" ? "active" : ""}
                    onClick={() => setCategory("favorites")}
                  >
                    <Star size={13} />
                    {tr("Favorites")}
                  </button>
                  {[
                    "dialogue",
                    "character",
                    "stage",
                    "camera",
                    "audio",
                    "transition",
                    "chat",
                    "flow",
                    "timing",
                    "media",
                    "system",
                  ].map((value) => (
                    <button
                      key={value}
                      role="tab"
                      aria-selected={category === value}
                      className={category === value ? "active" : ""}
                      onClick={() => setCategory(value)}
                    >
                      {
                        {
                          dialogue: tr("Dialogue"),
                          character: tr("Character"),
                          stage: tr("Stage"),
                          camera: tr("Camera"),
                          audio: tr("Audio"),
                          transition: tr("Transitions"),
                          chat: tr("Phone"),
                          flow: tr("Flow"),
                          timing: tr("Timing"),
                          media: tr("Media"),
                          system: tr("System"),
                        }[value]
                      }
                    </button>
                  ))}
                  <span>{tr("Insert after current statement")}</span>
                </div>
                <div className="command-buttons">
                  {category === "dialogue" && (
                    <button
                      onClick={() =>
                        insertCommand({
                          id: crypto.randomUUID(),
                          type: { plugin: "haneoka.altair", name: "dialogue" },
                          schemaVersion: 1,
                          arguments: { enabled: true },
                        })
                      }
                    >
                      <Plus size={13} />
                      {tr("Dialogue visibility")}
                    </button>
                  )}
                  {category === "favorites" &&
                    commandLibrary?.groups
                      .filter((group) => commandLibrary.favoriteGroups?.includes(group.id))
                      .map((group) => (
                        <button
                          key={group.id}
                          onClick={() => {
                            try {
                              session.insertGroup(group);
                            } catch (error) {
                              setIssue(String(error));
                            }
                          }}
                        >
                          {group.name}
                        </button>
                      ))}
                  {nativeCommands
                    .filter((command) =>
                      category === "favorites"
                        ? favorites.has(
                            altairCommandTypeKey({
                              plugin: "haneoka.altair-adv",
                              name: command.name,
                            }),
                          )
                        : command.category === category,
                    )
                    .map((command) => (
                      <button key={command.name} disabled={!doc} onClick={() => insertCommand(command.initial())}>
                        <Plus size={13} />
                        {command.label}
                      </button>
                    ))}
                </div>
              </section>
            )}
          </div>
        </Panel>
        <Separator className="resize-handle" />
        <Panel
          id="inspector"
          className="workspace-properties-page"
          minSize={mobile ? 0 : "200px"}
          defaultSize="24%"
          role={mobile ? "tabpanel" : undefined}
          aria-labelledby={mobile ? "mobile-properties-tab" : undefined}
        >
          {propertyFile ? (
            <section className="statement-inspector">
              <header className="panel-heading">
                <span>{propertyFile.path.split("/").at(-1)}</span>
              </header>
              <div className="inspector-body">
                <dl>
                  <div className="field">
                    <dt>{tr("File path")}</dt>
                    <dd>{propertyFile.path}</dd>
                  </div>
                  <div className="field">
                    <dt>{tr("File size")}</dt>
                    <dd>{tr("{{count}} bytes", { count: propertyFile.blob.size })}</dd>
                  </div>
                  <div className="field">
                    <dt>{tr("Media type")}</dt>
                    <dd>{propertyFile.blob.type || tr("Unknown")}</dd>
                  </div>
                </dl>
                {mobile && (
                  <button className="secondary-button" onClick={() => setMobilePage("editor")}>
                    {tr("Open in editor")}
                  </button>
                )}
              </div>
            </section>
          ) : (
            <NativeInspector
              statement={selected}
              session={session}
              onOpenTimeline={() => {
                setMode("timeline");
                setMobilePage("editor");
              }}
            />
          )}
        </Panel>
      </Group>
      <Tabs.Root value={mobilePage} onValueChange={setMobilePage} className="workspace-mobile-pages">
        <Tabs.List className="workspace-mobile-navigation panel-tabs" aria-label={tr("Workspace pages")}>
          <Tabs.Trigger id="mobile-files-tab" value="files" aria-controls="left">
            <Folder size={20} />
            {tr("Preview and files")}
          </Tabs.Trigger>
          <Tabs.Trigger id="mobile-editor-tab" value="editor" aria-controls="editor">
            <LayoutList size={20} />
            {tr("Editor")}
          </Tabs.Trigger>
          <Tabs.Trigger id="mobile-properties-tab" value="properties" aria-controls="inspector">
            <Settings2 size={20} />
            {tr("Properties")}
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <footer className="workspace-status">
        <span title={state.localFolder}>
          {state.localFolder ? `${tr("Local folder")} · ${state.localFolder}` : tr("Browser storage")}
        </span>
        <span>
          {state.error ||
            issue ||
            state.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ||
            tr("{{count}} files", { count: state.files.length })}
        </span>
        <span>
          {state.compiling
            ? tr("Compiling")
            : docEditor
              ? tr(docEditor.label)
              : doc && !nativeScenePath(doc.path)
                ? tr("Source document")
                : tr("{{count}} statements", { count: statements.length })}
        </span>
        <span>{tr("Line {{count}}", { count: state.line })}</span>
        <span>{dirty ? tr("Unsaved changes") : tr("Saved")}</span>
      </footer>
      <Dialog.Root
        open={importAssets}
        onOpenChange={(open) => {
          if (!importingAssets) setImportAssets(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>{tr("Import assets")}</Dialog.Title>
            <Dialog.Description>
              {tr("Keep folder references and record the asset author and license.")}
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setImportingAssets(true);
                setAssetImportError("");
                void session
                  .importSharedAssets({ ...assetPack, files: assetFiles }, assetPack.directory)
                  .then((paths) => {
                    setImportAssets(false);
                    setAssetFiles([]);
                    setAssetPack((pack) => ({ ...pack, id: crypto.randomUUID() }));
                    setLeftTab("resources");
                    setAsset(paths[0] ?? "");
                  })
                  .catch((error) => setAssetImportError(error instanceof Error ? tr(error.message) : String(error)))
                  .finally(() => setImportingAssets(false));
              }}
            >
              {[false, true].map((folder) => (
                <div key={String(folder)}>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={importingAssets}
                    onClick={() => (folder ? assetFolderInput : assetFileInput).current?.click()}
                  >
                    {folder ? <Folder size={15} /> : <Plus size={15} />}
                    {tr(folder ? "Choose asset folder" : "Choose asset files")}
                  </button>
                  <input
                    hidden
                    ref={folder ? assetFolderInput : assetFileInput}
                    type="file"
                    multiple
                    aria-label={tr(folder ? "Choose asset folder" : "Choose asset files")}
                    disabled={importingAssets}
                    {...(folder ? { webkitdirectory: "" } : {})}
                    onChange={(event) => {
                      setAssetFiles(
                        Array.from(event.target.files ?? [], (file) => ({
                          path: file.webkitRelativePath || file.name,
                          blob: file,
                        })),
                      );
                      setAssetImportError("");
                      event.target.value = "";
                    }}
                  />
                </div>
              ))}
              <p role="status">{tr("{{count}} files", { count: assetFiles.length })}</p>
              {(
                [
                  ["directory", "Project asset directory"],
                  ["version", "Asset pack version"],
                  ["author", "Asset author"],
                  ["license", "Asset license"],
                ] as const
              ).map(([field, label]) => (
                <label className="field" key={field}>
                  {tr(label)}
                  <input
                    required
                    disabled={importingAssets}
                    value={assetPack[field]}
                    onChange={(event) => {
                      const value = event.target.value;
                      setAssetPack((pack) => ({ ...pack, [field]: value }));
                    }}
                  />
                </label>
              ))}
              {assetImportError && (
                <p role="alert" className="home-error">
                  {assetImportError}
                </p>
              )}
              <div className="modal-actions">
                <Dialog.Close asChild>
                  <button type="button" disabled={importingAssets}>
                    {tr("Cancel")}
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={importingAssets || state.saving || !assetFiles.length}
                >
                  {tr(importingAssets ? "Saving" : "Import assets")}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={newFile} onOpenChange={setNewFile}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>
              {newFileKind === "scene"
                ? tr("New scene")
                : tr("New {{kind}}", {
                    kind: tr(
                      session.documentEditors().find((editor) => editor.id === newFileKind)?.label ?? "Document",
                    ),
                  })}
            </Dialog.Title>
            <Dialog.Description>
              {tr(newFileKind === "scene" ? "Add a new scene to your story." : "Create a document in your project.")}
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void (
                  newFileKind === "scene" ? session.addScene(filename) : session.createDocument(newFileKind, filename)
                )
                  .then(() => {
                    setNewFile(false);
                    setFilename("");
                  })
                  .catch((error) => setIssue(String(error)));
              }}
            >
              <label className="field">
                {tr(newFileKind === "scene" ? "Scene name" : "Document name")}
                <input
                  autoFocus
                  required
                  value={filename}
                  onChange={(event) => setFilename(event.target.value)}
                  placeholder={tr(newFileKind === "scene" ? "Chapter one" : "Document")}
                />
              </label>
              <div className="modal-actions">
                <Dialog.Close asChild>
                  <button type="button">{tr("Cancel")}</button>
                </Dialog.Close>
                <button className="primary-button">{tr("Create")}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={showSettings} onOpenChange={setShowSettings}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>{tr("Project settings")}</Dialog.Title>
            <Dialog.Description>{tr("Edit your game configuration and project details.")}</Dialog.Description>
            <ProjectSettings session={session} />
            {state.documents
              .filter((file) => file.path === NATIVE_PROJECT_PATH || /config\.txt$|project\.wgcp$/u.test(file.path))
              .map((file) => (
                <button
                  className="settings-link"
                  key={file.path}
                  onClick={() => {
                    session.activate(file.path);
                    setMode("source");
                    setShowSettings(false);
                  }}
                >
                  <FileText size={16} />
                  {file.path}
                </button>
              ))}
            <Dialog.Close className="modal-close" aria-label={tr("Close")}>
              <X size={16} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
