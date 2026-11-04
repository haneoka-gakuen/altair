import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair/documents";
import { RuntimeSettings } from "./RuntimeSettings";
import { tr, useStudioI18n, deviceLanguage, studioI18n } from "./i18n";
import { InterfaceLanguage } from "./InterfaceLanguage";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, Gamepad2, Import, Plus, Search, Star, X } from "@haneoka/altair-ui-react";
import { BrowserWorkspaceService } from "@haneoka/altair-plugin-workspace-browser";
import { projectLibrary, type LibraryProject } from "./library";
import { EditorSession } from "./session";
import { readProjectZip } from "./archive";
import { NATIVE_PROJECT_PATH, createNativeProject, normalizeImportedProject } from "./native-project";
import { nativeImportForFolder } from "./native-import";
import {
  installAltairStudioHost,
  type StudioProjectSnapshot,
  type StudioStorySelection,
  type StudioStoryPickerResult,
} from "@haneoka/altair/studio-host";
import {
  configureStudio,
  executeStudioAction,
  registerStudioActions,
  registerStudioIntent,
  registerStudioDownload,
  studioProjectSnapshot,
  studioState,
  studioIntent,
  type StudioEnvironment,
} from "./studio-host";
import altairMark from "../../../../docs/brand/favicon.svg?url";
import "./legacy.css";
import { ProjectLanguagePicker, resolveProjectLanguage, withProjectLanguageName } from "./project-language";
import { instantiateProjectTemplate, createWebGalExample } from "./project-template";
const Workspace = lazy(() => import("./Workspace").then((module) => ({ default: module.Workspace })));
export function EditorApp() {
  const { i18n } = useStudioI18n();
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("altair.library.favorites") || "[]");
    } catch {
      return [];
    }
  });
  const [sort, setSort] = useState("updated"),
    [libraryView, setLibraryView] = useState("grid"),
    [favoritesOnly, setFavoritesOnly] = useState(false);
  const [templatesOnly, setTemplatesOnly] = useState(false),
    [templateId, setTemplateId] = useState("");
  const [storyTemplate, setStoryTemplate] = useState<StudioStorySelection>();
  const storyPickerRequest = useRef<string | undefined>(undefined);
  const storySuggestedName = useRef<string | undefined>(undefined);
  const serverTemplate = ["haneoka", "bestdori", "sekai"].includes(templateId);
  const [management, setManagement] = useState<{
    action: "rename" | "delete";
    project: LibraryProject;
    text: string;
  }>();
  const [projectLocaleChoice, setProjectLocale] = useState<string>();
  const [customLanguageName, setCustomLanguageName] = useState("");
  const projectLocale = projectLocaleChoice ?? i18n.resolvedLanguage ?? deviceLanguage();
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
  const beginCreation = () => {
    setTemplateId("");
    setStoryTemplate(undefined);
    storySuggestedName.current = undefined;
    setName("");
    setProjectLocale(undefined);
    setCustomLanguageName("");
    setError("");
    setCreate(true);
  };
  const sourceImport = useRef<AbortController | undefined>(undefined);
  const hostStatus = useRef({ busy, error });
  hostStatus.current = { busy, error };
  const currentState = () => ({
    ...studioState(active.current),
    busy: hostStatus.current.busy || studioState(active.current).busy,
    error: hostStatus.current.error || studioState(active.current).error,
  });
  const studioBridge = useRef<ReturnType<typeof installAltairStudioHost> | undefined>(undefined);
  const reload = () =>
    projectLibrary
      .list()
      .then((items) => setProjects(items.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((error) => setError(String(error)));
  useEffect(() => {
    void reload()
      .then(async () => {
        if (window.parent !== window) return;
        const id = localStorage.getItem("altair.library.active");
        if (id) {
          const project = await projectLibrary.get(id);
          if (project) await open(project);
        }
      })
      .catch((error) => setError(String(error)));
    return () => {
      sourceImport.current?.abort();
      void active.current?.dispose();
      void workspace.current?.dispose();
    };
  }, []);
  const open = async (project: LibraryProject, service?: BrowserWorkspaceService) => {
    setBusy(true);
    setError("");
    const previous = active.current,
      previousWorkspace = workspace.current;
    let switched = false;
    try {
      const original = project;
      const storedRecovery = await projectLibrary.nativeImport(project.id);
      if (storedRecovery) project = storedRecovery.beforeProject;
      if (!service && project.directory) {
        service = new BrowserWorkspaceService();
        const snapshot = await service.connectDirectory(project.directory, {
          requestPermission: true,
          name: project.name,
        });
        project = {
          ...project,
          directories: snapshot.directories,
          files: await Promise.all(
            snapshot.files.map(async (file) => ({
              path: file.path,
              blob: await service!.file(file.path),
            })),
          ),
        };
      }
      const pending = service?.directory ? await nativeImportForFolder(service) : undefined;
      const sourceFiles = project.files;
      project = pending ? pending.beforeProject : await normalizeImportedProject(project);
      const converted = !pending && project.files !== sourceFiles;
      if (converted) {
        await service?.dispose();
        service = undefined;
      }
      if (service?.directory) project = { ...project, directory: service.directory };
      if (!pending && (converted || original.id !== project.id || service)) project = await projectLibrary.put(project);
      await previous?.dispose();
      switched = true;
      if (previousWorkspace !== service) await previousWorkspace?.dispose();
      workspace.current = service;
      const next = new EditorSession(project, service);
      await next.initialize();
      active.current = next;
      try {
        localStorage.setItem("altair.library.active", next.getSnapshot().id);
      } catch {}
      setSession(next);
      if (!pending && original.id !== project.id) await projectLibrary.remove(original.id);
      return next;
    } catch (error) {
      if (switched) {
        active.current = undefined;
        setSession(undefined);
      } else if (service !== previousWorkspace) await service?.dispose();
      setError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const newProject = async () => {
    const title = name.trim();
    if (!title) return;
    setBusy(true);
    setError("");
    try {
      const language = await resolveProjectLanguage(projectLocale, customLanguageName);
      let project = createNativeProject(title, language.tag);
      if (serverTemplate) {
        if (!storyTemplate || storyTemplate.source.provider !== templateId) return;
        const operation = new AbortController();
        sourceImport.current?.abort();
        sourceImport.current = operation;
        const { importPublicStory } = await import("./source-project-import");
        const imported = await importPublicStory(storyTemplate.source, storyTemplate.storyId, operation.signal);
        operation.signal.throwIfAborted();
        project = await instantiateProjectTemplate(imported, title, language);
      } else if (templateId === "webgal") {
        project = await instantiateProjectTemplate(await createWebGalExample(language.tag), title, language);
      } else {
        const template = projects.find((project) => `library:${project.id}` === templateId && project.template);
        if (template) project = await instantiateProjectTemplate(template, title, language);
      }
      if (language.name) {
        const manifest = project.files.find((file) => file.path === NATIVE_PROJECT_PATH)!;
        const source = await manifest.blob.text();
        const named = withProjectLanguageName(parseAltairProjectDocument(source), language);
        project = {
          ...project,
          files: project.files.map((file) =>
            file === manifest
              ? { ...file, blob: new Blob([serializeAltairDocument(named, source)], { type: file.blob.type }) }
              : file,
          ),
        };
      }
      await projectLibrary.put(project);
      setCreate(false);
      setName("");
      await open(project);
    } catch (error) {
      setError(serverTemplate ? tr("authoring.optionsFailed") : String(error));
    } finally {
      setBusy(false);
    }
  };
  const openFolder = async () => {
    const service = new BrowserWorkspaceService();
    setBusy(true);
    setError("");
    try {
      const snapshot = await service.pickDirectory({ pickerOptions: { mode: "readwrite" } });
      const files = await Promise.all(
        snapshot.files.map(async (file) => ({
          path: file.path,
          blob: await service.file(file.path),
        })),
      );
      const project = {
        directories: snapshot.directories,
        id: snapshot.id,
        name: snapshot.name,
        updatedAt: Date.now(),
        files,
      };
      await open(project, service);
    } catch (error) {
      await service.dispose();
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const favorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    setFavorites(next);
    try {
      localStorage.setItem("altair.library.favorites", JSON.stringify(next));
    } catch {}
  };
  const duplicate = async (project: LibraryProject) => {
    setBusy(true);
    try {
      const draft = await projectLibrary.draft(project.id),
        documents = new Map(draft?.documents.map((doc) => [doc.path, doc.text]) ?? []);
      const copy = await normalizeImportedProject({
        ...project,
        id: crypto.randomUUID(),
        directory: undefined,
        revision: undefined,
        files: project.files.map((file) =>
          documents.has(file.path)
            ? { ...file, blob: new Blob([documents.get(file.path)!], { type: file.blob.type }) }
            : file,
        ),
      });
      await projectLibrary.put(copy);
      await reload();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const template = async (project: LibraryProject) => {
    setBusy(true);
    try {
      await projectLibrary.commit({ ...project, template: !project.template }, project.revision);
      await reload();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const manage = async () => {
    if (!management) return;
    setBusy(true);
    try {
      if (management.action === "delete") {
        await projectLibrary.remove(management.project.id);
        await reload();
      } else {
        await open(management.project);
        const session = active.current,
          doc = session?.document(NATIVE_PROJECT_PATH);
        if (!session || !doc) throw new Error(tr("Project manifest is missing"));
        session.update(
          doc.path,
          serializeAltairDocument({ ...parseAltairProjectDocument(doc.text), title: management.text.trim() }, doc.text),
        );
        await session.save();
      }
      setManagement(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const home = async () => {
      localStorage.removeItem("altair.library.active");
      await active.current?.dispose();
      active.current = undefined;
      setSession(undefined);
      await reload();
    };
    const unregister = registerStudioActions({
      "select-story": (value) => {
        const result = value as StudioStoryPickerResult;
        if (result.requestId !== storyPickerRequest.current) return;
        storyPickerRequest.current = undefined;
        if (result.selection) {
          const previous = storySuggestedName.current;
          storySuggestedName.current = result.selection.title;
          setStoryTemplate(result.selection);
          setName((name) => (!name.trim() || name === previous ? result.selection!.title : name));
        }
        setCreate(true);
      },
      new: async (value) => {
        const input = value as { title?: string; locale?: string } | undefined;
        if (!input?.title) {
          await home();
          beginCreation();
          return studioState(active.current);
        }
        const project = createNativeProject(
          input?.title || tr("New story"),
          input?.locale || studioI18n.resolvedLanguage || "en",
        );
        await projectLibrary.put(project);
        await open(project);
        return studioState(active.current);
      },
      import: () => fileInput.current?.click(),
      "import-source": async (value) => {
        const request = value as {
          source: import("./public-resource-host").PublicResourceSource;
          storyId?: string;
          project?: import("@haneoka/altair/model").StoryProject;
        };
        sourceImport.current?.abort();
        const operation = new AbortController(),
          previous = active.current;
        sourceImport.current = operation;
        setBusy(true);
        setError("");
        try {
          await previous?.save();
          const { importPublicStory, captureSourceProject } = await import("./source-project-import");
          const project = request.project
            ? await captureSourceProject(
                request.project,
                request.source as import("./resource-manifest").PublicSourceScope,
                operation.signal,
              )
            : await importPublicStory(request.source, request.storyId!, operation.signal);
          operation.signal.throwIfAborted();
          if (active.current !== previous) throw new DOMException("Project changed", "AbortError");
          await projectLibrary.put(project);
          const opened = await open(project);
          if (!opened) throw new Error("invalid_project");
          return studioState(opened);
        } catch (error) {
          if (!operation.signal.aborted)
            console.error(
              "[Altair] story import failed",
              error instanceof Error ? error.stack || error.message : String(error),
            );
          throw error;
        } finally {
          if (sourceImport.current === operation) {
            sourceImport.current = undefined;
            setBusy(false);
          }
        }
      },
      folder: openFolder,
      library: home,
      "open-local": async (value) => {
        const id = String((value as { id: string }).id),
          project = await projectLibrary.get(id);
        if (!project) return null;
        const opened = await open(project);
        if (!opened) throw new Error("invalid_project");
        return studioState(opened);
      },
      open: async (value) => {
        const input = value as StudioProjectSnapshot;
        const opened = await open({
          id: crypto.randomUUID(),
          name: input.title,
          files: input.files,
          directories: input.directories,
          updatedAt: Date.now(),
        });
        if (!opened) throw new Error("invalid_project");
        const manifest = opened.document(NATIVE_PROJECT_PATH);
        if (manifest) {
          let project;
          try {
            project = parseAltairProjectDocument(manifest.text);
          } catch {}
          if (project && project.title !== input.title) {
            opened.update(manifest.path, serializeAltairDocument({ ...project, title: input.title }, manifest.text));
            await opened.compile();
          }
        }
        return studioState(opened);
      },
    });
    const bridge = installAltairStudioHost({
      state: currentState,
      request: async (request) => {
        if (request.action === "state") return currentState();
        if (request.action === "configure") {
          configureStudio(request.value as StudioEnvironment);
          return;
        }
        if (request.action === "snapshot") {
          if (!active.current) throw new Error("project_missing");
          return studioProjectSnapshot(active.current);
        }
        return executeStudioAction(request.action, request.value);
      },
    });
    studioBridge.current = bridge;
    const stopIntent = registerStudioIntent((action, value) => bridge.intent(action, value));
    const stopDownload = registerStudioDownload((value) => bridge.download(value));
    return () => {
      unregister();
      stopIntent();
      stopDownload();
      bridge.dispose();
      studioBridge.current = undefined;
    };
  }, []);
  useEffect(() => {
    studioBridge.current?.publish();
    const unsubscribe = session?.subscribe(() => studioBridge.current?.publish());
    return () => {
      unsubscribe?.();
    };
  }, [session, busy, error]);
  const importInput = (
    <input
      ref={fileInput}
      hidden
      type="file"
      accept=".zip,.wgcp,.json,.asset,.txt,.wg,.webgal"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setBusy(true);
        void file
          .slice(0, 4)
          .arrayBuffer()
          .then((bytes) =>
            new DataView(bytes).byteLength >= 4 && new DataView(bytes).getUint32(0, true) === 0x04034b50
              ? readProjectZip(file)
              : { files: [{ path: file.name, blob: file }], directories: [] },
          )
          .then(async ({ files, directories }) => {
            const project = {
              id: crypto.randomUUID(),
              name: file.name.replace(/\.(?:zip|wgcp|json|asset|txt|wg|webgal)$/iu, ""),
              updatedAt: Date.now(),
              files,
              directories,
            };
            await projectLibrary.put(project);
            await open(project);
          })
          .catch((error) => setError(String(error)))
          .finally(() => setBusy(false));
      }}
    />
  );
  if (session)
    return (
      <>
        <span hidden>{importInput}</span>
        <Suspense fallback={<div className="app-loading">{tr("Opening editor\u2026")}</div>}>
          <Workspace
            session={session}
            onHome={() => {
              localStorage.removeItem("altair.library.active");
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
      </>
    );
  return (
    <main className="project-home">
      {importInput}
      <aside className="home-sidebar">
        <a className="brand" href="#">
          <img className="brand-mark" src={altairMark} width={32} height={32} alt="" />
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
            <h1>{tr(templatesOnly ? "Project templates" : "My projects")}</h1>
          </div>
          <button className="primary-button" onClick={beginCreation} disabled={busy}>
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
          <button
            aria-pressed={favoritesOnly}
            title={tr("Favorites")}
            onClick={() => setFavoritesOnly((value) => !value)}
          >
            <Star size={16} />
          </button>
          <button aria-pressed={templatesOnly} onClick={() => setTemplatesOnly((value) => !value)}>
            {tr("Project templates")}
          </button>
          <select aria-label={tr("Sort projects")} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">{tr("Recently updated")}</option>
            <option value="name">{tr("Project name")}</option>
          </select>
          <select aria-label={tr("Project view")} value={libraryView} onChange={(e) => setLibraryView(e.target.value)}>
            <option value="grid">{tr("Grid")}</option>
            <option value="list">{tr("List")}</option>
            <option value="table">{tr("Table")}</option>
          </select>
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
            <button className="primary-button" onClick={beginCreation}>
              <Plus size={15} />
              {tr("New project")}
            </button>
          </div>
        ) : (
          <div className={`project-grid project-view-${libraryView}`}>
            {projects
              .filter(
                (project) =>
                  (!templatesOnly || project.template) &&
                  project.name.toLowerCase().includes(query.toLowerCase()) &&
                  (!favoritesOnly || favorites.includes(project.id)),
              )
              .sort((a, b) =>
                sort === "name" ? a.name.localeCompare(b.name, studioI18n.resolvedLanguage) : b.updatedAt - a.updatedAt,
              )
              .map((project) => (
                <article className="project-card" key={project.id}>
                  <button className="project-open" onClick={() => void open(project)} disabled={busy}>
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
                  <div className="project-card-actions">
                    <button
                      aria-pressed={favorites.includes(project.id)}
                      aria-label={tr("Favorite")}
                      disabled={busy}
                      onClick={() => favorite(project.id)}
                    >
                      <Star size={16} />
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setManagement({ action: "rename", project, text: project.name })}
                    >
                      {tr("Rename")}
                    </button>
                    <button disabled={busy} onClick={() => void duplicate(project)}>
                      {tr("Duplicate")}
                    </button>
                    <button disabled={busy} aria-pressed={!!project.template} onClick={() => void template(project)}>
                      {tr("Use as template")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setManagement({ action: "delete", project, text: project.name })}
                    >
                      {tr("Delete")}
                    </button>
                  </div>
                </article>
              ))}
          </div>
        )}
      </section>
      <Dialog.Root
        open={!!management}
        onOpenChange={(value) => {
          if (!value) setManagement(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>{tr(management?.action === "delete" ? "Delete project?" : "Rename project")}</Dialog.Title>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void manage();
              }}
            >
              {management?.action === "rename" ? (
                <input
                  aria-label={tr("Project name")}
                  value={management.text}
                  required
                  onChange={(event) => setManagement({ ...management, text: event.target.value })}
                />
              ) : (
                <p>{management?.project.name}</p>
              )}
              {error && (
                <div className="home-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <Dialog.Close asChild>
                  <button type="button" disabled={busy}>
                    {tr("Cancel")}
                  </button>
                </Dialog.Close>
                <button className="primary-button" disabled={busy}>
                  {tr(management?.action === "delete" ? "Delete" : "Rename")}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={create}
        onOpenChange={(open) => {
          if (!busy) setCreate(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content">
            <Dialog.Title>{tr("New project")}</Dialog.Title>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void newProject();
              }}
            >
              <label className="field">
                <span>{tr("Project templates")}</span>
                <select disabled={busy} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                  <option value="">{tr("Blank visual novel")}</option>
                  {window.parent !== window && (
                    <>
                      <option value="haneoka">{tr("Our Notes story")}</option>
                      <option value="bestdori">{tr("GBP story")}</option>
                      <option value="sekai">{tr("SEKAI story")}</option>
                    </>
                  )}
                  <option value="webgal">{tr("WebGAL example")}</option>
                  {projects.filter((project) => project.template).length > 0 && (
                    <optgroup label={tr("Saved templates")}>
                      {projects
                        .filter((project) => project.template)
                        .map((project) => (
                          <option key={project.id} value={`library:${project.id}`}>
                            {project.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              </label>
              {serverTemplate && (
                <button
                  type="button"
                  className="secondary-button project-template-story"
                  disabled={busy}
                  onClick={() => {
                    const requestId = crypto.randomUUID();
                    storyPickerRequest.current = requestId;
                    setCreate(false);
                    studioIntent("stories", { requestId, provider: templateId });
                  }}
                >
                  <Search size={20} />
                  {storyTemplate?.source.provider === templateId ? storyTemplate.title : tr("Choose story")}
                </button>
              )}
              {templateId === "webgal" && (
                <div className="field">
                  <span>{tr("WebGAL example")}</span>
                  <span>{tr("Dialogue and choices")}</span>
                </div>
              )}
              <label className="field">
                {tr("Project name")}
                <input
                  required
                  autoFocus
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={tr("Untitled story")}
                />
              </label>
              <ProjectLanguagePicker
                value={projectLocale}
                name={customLanguageName}
                onChange={setProjectLocale}
                onNameChange={setCustomLanguageName}
              />
              {error && (
                <div className="home-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <Dialog.Close asChild>
                  <button type="button" disabled={busy}>
                    {tr("Cancel")}
                  </button>
                </Dialog.Close>
                <button
                  className="primary-button"
                  disabled={
                    busy ||
                    !name.trim() ||
                    (projectLocale === "custom" && !customLanguageName.trim()) ||
                    (serverTemplate && storyTemplate?.source.provider !== templateId)
                  }
                >
                  {tr(busy ? "Opening project…" : "Create project")}
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
