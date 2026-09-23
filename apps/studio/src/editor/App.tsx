import { RuntimeSettings } from "./RuntimeSettings";
import { tr, useStudioI18n, deviceLanguage, canonicalLanguage, studioI18n } from "./i18n";
import { InterfaceLanguage } from "./InterfaceLanguage";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Boxes, FolderOpen, Gamepad2, Import, Plus, Search, Settings, Star, X } from "lucide-react";
import { BrowserWorkspaceService } from "@haneoka/altair-plugin-workspace-browser";
import { projectLibrary, type LibraryProject } from "./library";
import { EditorSession } from "./session";
import { importProjectZip } from "./archive";
import { createNativeProject, normalizeImportedProject } from "./native-project";
import "./editor.css";
const Workspace = lazy(() => import("./Workspace").then((module) => ({ default: module.Workspace })));
export function EditorApp() {
  useStudioI18n();
  const [projectLocale, setProjectLocale] = useState(deviceLanguage);
  const [projects, setProjects] = useState<readonly LibraryProject[]>([]),
    [session, setSession] = useState<EditorSession>(),
    [query, setQuery] = useState(""),
    [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null),
    workspace = useRef<BrowserWorkspaceService | undefined>(undefined),
    active = useRef<EditorSession | undefined>(undefined);
  const reload = () =>
    projectLibrary
      .list()
      .then((items) => setProjects(items.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((error) => setError(String(error)));
  useEffect(() => {
    void reload();
    return () => {
      void active.current?.dispose();
      void workspace.current?.dispose();
    };
  }, []);
  const open = async (project: LibraryProject, service?: BrowserWorkspaceService) => {
    setBusy(true);
    setError("");
    try {
      await active.current?.dispose();
      if (workspace.current !== service) await workspace.current?.dispose();
      workspace.current = service;
      const original = project;
      if (!service && project.directory) {
        service = new BrowserWorkspaceService();
        const snapshot = await service.connectDirectory(project.directory, {
          requestPermission: true,
          name: project.name,
        });
        project = {
          ...project,
          files: await Promise.all(
            snapshot.files.map(async (file) => ({
              path: file.path,
              blob: await service!.file(file.path),
            })),
          ),
        };
        workspace.current = service;
      }
      const sourceFiles = project.files;
      project = await normalizeImportedProject(project);
      const converted = project.files !== sourceFiles;
      if (converted) {
        await service?.dispose();
        service = undefined;
        workspace.current = undefined;
      }
      if (service?.directory) project = { ...project, directory: service.directory };
      if (converted || original.id !== project.id || service) project = await projectLibrary.put(project);
      if (original.id !== project.id) {
        await projectLibrary.remove(original.id);
      }
      const next = new EditorSession(project, service);
      await next.initialize();
      active.current = next;
      setSession(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const newProject = async () => {
    const title = name.trim();
    if (!title) return;
    setBusy(true);
    try {
      const project = createNativeProject(title, canonicalLanguage(projectLocale));
      await projectLibrary.put(project);
      setCreate(false);
      setName("");
      await open(project);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const openFolder = async () => {
    const service = new BrowserWorkspaceService();
    setBusy(true);
    setError("");
    try {
      const snapshot = await service.pickDirectory();
      const files = await Promise.all(
        snapshot.files.map(async (file) => ({
          path: file.path,
          blob: await service.file(file.path),
        })),
      );
      const project = {
        id: snapshot.id,
        name: snapshot.name,
        updatedAt: Date.now(),
        files,
      };
      await projectLibrary.put(project);
      await open(project, service);
    } catch (error) {
      await service.dispose();
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (session)
    return (
      <Suspense fallback={<div className="app-loading">{tr("Opening editor\u2026")}</div>}>
        <Workspace
          session={session}
          onHome={() => {
            void session
              .dispose()
              .then(() => {
                setSession(undefined);
                active.current = undefined;
                void reload();
              })
              .catch((error) => setError(String(error)));
          }}
        />
      </Suspense>
    );
  return (
    <main className="project-home">
      <aside className="home-sidebar">
        <a className="brand" href="#">
          <span className="brand-mark">A</span>
          <strong>Altair</strong>
        </a>
        <div className="home-nav">
          <button className="active">
            <Gamepad2 size={18} />
            {tr("My projects")}
            <span>{projects.length}</span>
          </button>
          <button onClick={() => void openFolder()} disabled={busy}>
            <FolderOpen size={18} />
            {tr("Open project folder")}
          </button>
          <button onClick={() => fileInput.current?.click()} disabled={busy}>
            <Import size={18} />
            {tr("Import project")}
          </button>
        </div>
        <div className="sidebar-bottom">
          <InterfaceLanguage />
          <RuntimeSettings />
          <span>{tr("Visual Novel Studio")}</span>
          <span className="version">0.1.0</span>
        </div>
      </aside>
      <section className="home-content">
        <header>
          <div>
            <h1>{tr("My projects")}</h1>
            <p>{tr("Continue creating, or start a new story.")}</p>
          </div>
          <button className="primary-button" onClick={() => setCreate(true)} disabled={busy}>
            <Plus size={16} />
            {tr("New project")}
          </button>
        </header>
        <div className="home-search">
          <Search size={16} />
          <input
            aria-label={tr("Search projects")}
            placeholder={tr("Search projects\u2026")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span>{tr("{{count}} projects", { count: projects.length })}</span>
        </div>
        {error && (
          <div className="home-error" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <div role="status" className="home-loading">
            {tr("Opening project\u2026")}
          </div>
        )}
        {projects.length === 0 ? (
          <div className="home-empty">
            <FolderOpen size={44} strokeWidth={1} />
            <h2>{tr("Start creating your story")}</h2>
            <p>{tr("Create an Altair project or import an existing one.")}</p>
            <button className="primary-button" onClick={() => setCreate(true)}>
              <Plus size={15} />
              {tr("New project")}
            </button>
          </div>
        ) : (
          <div className="project-grid">
            {projects
              .filter((project) => project.name.toLowerCase().includes(query.toLowerCase()))
              .map((project) => (
                <button className="project-card" key={project.id} onClick={() => void open(project)} disabled={busy}>
                  <div className="project-cover">
                    <span>{project.name[0]}</span>
                  </div>
                  <div className="project-meta">
                    <strong>{project.name}</strong>
                    <small>
                      {new Date(project.updatedAt).toLocaleString(studioI18n.resolvedLanguage)} ·{" "}
                      {tr("{{count}} files", { count: project.files.length })}
                    </small>
                  </div>
                </button>
              ))}
          </div>
        )}
      </section>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".zip"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          void importProjectZip(file)
            .then(async (files) => {
              const project = {
                id: crypto.randomUUID(),
                name: file.name.replace(/\.zip$/iu, ""),
                updatedAt: Date.now(),
                files,
              };
              await projectLibrary.put(project);
              await open(project);
            })
            .catch((error) => setError(String(error)))
            .finally(() => setBusy(false));
        }}
      />
      <Dialog.Root open={create} onOpenChange={setCreate}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>{tr("New project")}</Dialog.Title>
            <Dialog.Description>{tr("Give your story a name.")}</Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void newProject();
              }}
            >
              <label className="field">
                {tr("Project name")}
                <input
                  required
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={tr("Untitled story")}
                />
              </label>
              <label className="field">
                {tr("Project language")}
                <input value={projectLocale} required onChange={(event) => setProjectLocale(event.target.value)} />
              </label>
              <div className="project-template">
                <Boxes size={24} />
                <div>
                  <strong>{tr("Blank visual novel")}</strong>
                  <p>{tr("Scenes, assets and plugin configuration")}</p>
                </div>
              </div>
              <div className="modal-actions">
                <Dialog.Close asChild>
                  <button type="button">{tr("Cancel")}</button>
                </Dialog.Close>
                <button className="primary-button" disabled={busy || !name.trim()}>
                  {tr("Create project")}
                </button>
              </div>
            </form>
            <Dialog.Close className="modal-close" aria-label={tr("Close")}>
              <X size={17} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
