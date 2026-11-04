import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeft, ChevronRight, FileImage, Folder, Music, Video, RefreshCw, X } from "lucide-react";
import type { ResourceBrowserFile } from "@haneoka/altair/resource-browser";
import type { EditorSession } from "./session";
import {
  PublicResourcePickerController,
  PUBLIC_ASSET_INSERT_KINDS,
  type PublicImportMetadata,
} from "./public-resource-controller";
import type { StudioPublicResourceHost, PublicResourceSource } from "./public-resource-host";
import { tr, useStudioI18n } from "./i18n";
import "./public-resource-picker.css";
import { studioPublicResourceHost } from "./public-resource-bootstrap";
import { studioEnvironment } from "./studio-host";
import { publicResourceRequestUrl } from "./public-resource-host";
const PublicAssetPreview = lazy(() => import("./PublicAssetPreview").then((m) => ({ default: m.PublicAssetPreview })));
export function PublicResourcePicker({
  session,
  host,
  controller: providedController,
  initialKind = "model",
  onBrowse,
  onClose,
}: {
  session: EditorSession;
  host?: StudioPublicResourceHost;
  controller?: PublicResourcePickerController;
  initialKind?: string;
  onBrowse?: () => void;
  onClose(): void;
}) {
  useStudioI18n();
  const controller = useMemo(
    () => providedController ?? new PublicResourcePickerController(session, host ?? studioPublicResourceHost),
    [session, host, providedController],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    project = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [source, setSource] = useState<PublicResourceSource>({
      provider: controller.getSnapshot().scope?.provider ?? "haneoka",
      origin: controller.getSnapshot().scope?.origin ?? studioEnvironment().origin ?? "https://haneoka.org",
      server: controller.getSnapshot().scope?.server ?? studioEnvironment().server ?? "intl",
    }),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(providedController ? "selected" : "browse"),
    [manualPath, setManualPath] = useState(""),
    [kind, setKind] = useState(initialKind);
  const [originDraft, setOriginDraft] = useState(source.origin);
  const [metadata, setMetadata] = useState<PublicImportMetadata>({
      directory: "assets/public/" + crypto.randomUUID(),
      author: "",
      license: "",
      version: "1.0.0",
    }),
    [issue, setIssue] = useState("");
  const [focusReturn] = useState(() =>
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
    ),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!providedController) controller.dispose();
    };
  }, [controller, providedController]);
  const working = ["connecting", "listing", "selecting", "importing"].includes(state.phase),
    busy = state.phase === "importing";
  const nodes = state.nodes.filter(
    (node) =>
      !query.trim() ||
      `${node.name} ${node.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const close = () => {
    controller.cancel();
    onClose();
  };
  const connect = () => {
    setIssue("");
    if (originDraft.trim() !== source.origin) {
      setSource((current) => ({ ...current, origin: originDraft.trim() }));
      return;
    }
    void controller.connect(source, kind).then(() => {
      if (mounted.current && controller.getSnapshot().scope) setPage("browse");
    });
  };
  useEffect(() => {
    if (providedController) return;
    setQuery("");
    setIssue("");
    void controller.connect(source, kind).then(() => {
      if (mounted.current && controller.getSnapshot().scope) setPage("browse");
    });
  }, [controller, providedController, source.provider, source.server, source.origin, kind]);
  const openPath = () => {
    setIssue("");
    void controller.openPath(manualPath, kind).then(() => {
      if (!mounted.current) return;
      setPage(controller.getSnapshot().asset ? "selected" : "browse");
    });
  };
  const select = (file: ResourceBrowserFile) => {
    setMetadata((current) => ({ ...current, directory: "assets/public/" + crypto.randomUUID() }));
    void controller.select(file, kind).then(() => {
      if (mounted.current && controller.getSnapshot().asset) setPage("selected");
    });
  };
  const storyProject = state.asset?.kind === "project";
  const importReady = storyProject || Boolean(state.plan && metadata.author.trim() && metadata.license.trim() && metadata.version.trim() && metadata.directory.trim());
  const importAsset = () => {
    if (!importReady || busy || project.saving) return;
    setIssue("");
    void controller.importSelected(metadata).catch((error) => {
      if (mounted.current) setIssue(String(error));
    });
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content public-resource-picker"
          data-mobile-page={page}
          data-layout={state.layout}
          data-selection-only={Boolean(providedController)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (focusReturn?.isConnected) focusReturn.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <header className="public-resource-picker__header">
            {page === "selected" && (
              <button
                className="icon-button"
                aria-label={tr("Browse")}
                onClick={() => (onBrowse ? onBrowse() : setPage("browse"))}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <div>
              <Dialog.Title>{tr("Import from server")}</Dialog.Title>
              <Dialog.Description className="public-resource-picker__count">
                {working ? tr("Loading assets") : tr("{{count}} assets", { count: nodes.length })}
              </Dialog.Description>
            </div>
            <button type="button" className="icon-button" aria-label={tr("Close")} onClick={close}>
              <X size={20} />
            </button>
          </header>
          <Tabs.Root value={page} onValueChange={setPage}>
            <Tabs.List className="public-resource-picker__pages" aria-label={tr("Asset picker pages")}>
              <Tabs.Trigger id="public-source-tab" value="source" aria-controls="public-source-page">
                {tr("Categories")}
              </Tabs.Trigger>
              <Tabs.Trigger id="public-browse-tab" value="browse" aria-controls="public-browse-page">
                {tr("Browse")}
              </Tabs.Trigger>
              <Tabs.Trigger
                id="public-selected-tab"
                value="selected"
                aria-controls="public-selected-page"
                disabled={!state.asset}
              >
                {tr("Selected asset")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
          <div className="public-resource-picker__body">
            <section
              id="public-source-page"
              className="public-resource-picker__source"
              aria-labelledby="public-source-tab"
            >
              <h3>{tr("Public source")}</h3>
              <label className="field">
                <span>{tr("Provider")}</span>
                <select
                  value={source.provider}
                  disabled={busy}
                  onChange={(event) => {
                    controller.disconnect();
                    setSource((current) => ({
                      ...current,
                      provider: event.target.value as PublicResourceSource["provider"],
                      server: event.target.value === "haneoka" ? "intl" : "jp",
                    }));
                  }}
                >
                  <option value="haneoka">Haneoka</option>
                  <option value="bestdori">Bestdori</option>
                </select>
              </label>
              <label className="field">
                <span>{tr("Server or region")}</span>
                <select
                  value={source.server}
                  disabled={busy}
                  onChange={(event) => {
                    controller.disconnect();
                    setSource((current) => ({ ...current, server: event.target.value }));
                  }}
                >
                  {(source.provider === "haneoka" ? ["jp", "intl"] : ["jp", "en", "tw", "cn", "kr"]).map((server) => (
                    <option key={server} value={server}>
                      {tr(`server.${server}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{tr("Asset use")}</span>
                <select
                  value={kind}
                  disabled={busy}
                  onChange={(event) => {
                    setKind(event.target.value);
                  }}
                >
                  {[
                    "model",
                    "spine",
                    "background",
                    "still",
                    "frame",
                    "video",
                    "bgm",
                    "se",
                    "voice",
                    "effect",
                    "post-effect",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value === "model" ? "Live2D" : tr(value)}
                    </option>
                  ))}
                </select>
              </label>
              <details className="public-resource-picker__advanced">
                <summary>{tr("Connection and path")}</summary>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={working}
                  onClick={() => {
                    void controller.showLayout(state.layout === "grid" ? "directory" : "grid", kind).then(() => {
                      if (mounted.current) setPage("browse");
                    });
                  }}
                >
                  {tr(state.layout === "grid" ? "Browse folders" : "Asset grid")}
                </button>
                <label className="field">
                  <span>{tr("Public catalog origin")}</span>
                  <input
                    type="url"
                    value={originDraft}
                    disabled={busy}
                    onChange={(event) => setOriginDraft(event.target.value)}
                  />
                </label>
                <button type="button" className="secondary-button" disabled={busy} onClick={connect}>
                  <RefreshCw size={16} />
                  {tr("Connect source")}
                </button>
                <label className="field">
                  <span>{tr("Catalog path")}</span>
                  <input
                    value={manualPath}
                    disabled={busy}
                    onChange={(event) => setManualPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        openPath();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={working || !state.scope}
                  onClick={openPath}
                >
                  {tr("Open path")}
                </button>
                {state.scope && (
                  <dl>
                    <dt>{tr("Selected source")}</dt>
                    <dd>
                      {state.scope.provider} / {state.scope.server}
                    </dd>
                    {state.scope.releaseId && (
                      <>
                        <dt>{tr("Immutable release")}</dt>
                        <dd>{state.scope.releaseId}</dd>
                        <dt>{tr("Source ID")}</dt>
                        <dd>{state.scope.sourceId}</dd>
                      </>
                    )}
                  </dl>
                )}
              </details>
            </section>
            <section
              id="public-browse-page"
              className="public-resource-picker__browser"
              aria-labelledby="public-browse-tab"
            >
              <nav
                hidden={state.layout === "grid"}
                className="public-resource-picker__breadcrumbs"
                aria-label={tr("Catalog path")}
              >
                <button type="button" disabled={busy || !state.scope} onClick={() => void controller.browse([])}>
                  {tr("Root")}
                </button>
                {state.path.map((segment, index) => (
                  <span key={index}>
                    <ChevronRight size={12} />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void controller.browse(state.path.slice(0, index + 1))}
                    >
                      {segment}
                    </button>
                  </span>
                ))}
              </nav>
              <label className="field">
                <span>{tr("Search assets")}</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <span className="public-resource-picker__count">{tr("{{count}} assets", { count: nodes.length })}</span>
              <ul className="public-resource-picker__entries" aria-label={tr("Catalog entries")}>
                {nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      className="public-resource-picker__entry"
                      aria-pressed={node.type === "file" && state.selectedFileId === node.id}
                      disabled={
                        busy ||
                        (node.type === "file" &&
                          (!node.available ||
                            !node.acceptedKinds.some((value) => PUBLIC_ASSET_INSERT_KINDS.includes(value))))
                      }
                      onClick={() => (node.type === "directory" ? void controller.browse(node.path) : select(node))}
                    >
                      <span className="public-resource-picker__thumbnail">
                        {node.type === "directory" ? (
                          <Folder size={32} />
                        ) : node.displayKind === "audio" ? (
                          <Music size={32} />
                        ) : node.displayKind === "video" ? (
                          <Video size={32} />
                        ) : (
                          <FileImage size={32} />
                        )}
                        {node.type === "file" && node.previewUrl && state.scope && (
                          <img
                            loading="lazy"
                            alt=""
                            src={publicResourceRequestUrl(
                              new URL(node.previewUrl, state.scope.origin).href,
                              state.scope,
                            )}
                            onError={(event) => {
                              event.currentTarget.hidden = true;
                            }}
                          />
                        )}
                      </span>
                      <span>
                        <strong>{node.description || node.name}</strong>
                        {node.description && <small>{node.name}</small>}
                        {node.type === "file" && node.detail && <small>{node.detail}</small>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!nodes.length && !working && (
                <p>{tr(state.scope ? "No matching assets" : "Connect a source to browse assets")}</p>
              )}
            </section>
            <aside
              id="public-selected-page"
              className="public-resource-picker__selected"
              aria-labelledby="public-selected-tab"
            >
              <div className="public-resource-picker__preview">
                {storyProject ? <strong>{state.asset!.name}</strong> : state.asset && state.plan ? (
                  <Suspense fallback={<p role="status">{tr("Loading preview")}</p>}>
                    <PublicAssetPreview asset={state.asset} plan={state.plan} />
                  </Suspense>
                ) : (
                  <p>{tr("Select an asset to preview")}</p>
                )}
              </div>
              {state.asset && (
                <details className="public-resource-picker__dependencies">
                  <summary>{tr("{{count}} dependencies", { count: state.asset.members.length })}</summary>
                  <ul>
                    {state.asset.members.map((member) => (
                      <li key={member.id}>
                        <strong>{member.role}</strong>
                        <code>{member.source}</code>
                        {state.plan &&
                          (state.plan.metadata.members as any[])?.find((row) => row.memberId === member.id)
                            ?.originalSha256 && (
                            <small>
                              SHA-256{" "}
                              {
                                (state.plan.metadata.members as any[]).find((row) => row.memberId === member.id)
                                  .originalSha256
                              }
                            </small>
                          )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!storyProject && <section className="public-resource-picker__metadata">
                <h3>{tr("Local import")}</h3>
                {(["author", "license"] as const).map((field) => (
                  <label className="field" key={field}>
                    <span>{tr(field === "author" ? "Author" : "License")}</span>
                    <input
                      value={metadata[field]}
                      disabled={busy}
                      onChange={(event) => setMetadata((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
                <details className="public-resource-picker__advanced">
                  <summary>{tr("Import options")}</summary>
                  {(["directory", "version"] as const).map((field) => (
                    <label className="field" key={field}>
                      <span>{tr(field === "directory" ? "Import directory" : "Version")}</span>
                      <input
                        value={metadata[field]}
                        disabled={busy}
                        onChange={(event) => setMetadata((current) => ({ ...current, [field]: event.target.value }))}
                      />
                    </label>
                  ))}
                </details>
              </section>}
            </aside>
          </div>
          <footer className="public-resource-picker__actions">
            <p role={state.error || issue ? "alert" : "status"}>
              {state.error || issue
                ? tr(state.error || issue)
                : state.importedPaths
                  ? tr("Imported {{count}} local files", { count: state.importedPaths.length })
                  : working
                    ? state.phase === "importing"
                      ? tr("Importing assets")
                      : state.phase === "listing" || state.phase === "connecting"
                        ? tr("Loading assets")
                        : tr("Loading {{done}} of {{total}} files", {
                            done: state.loadedMembers,
                            total: state.totalMembers,
                          })
                    : state.plan
                      ? tr("Ready to import a local copy")
                      : tr("Select an asset")}
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => (working ? controller.cancel() : close())}
            >
              {tr(working ? "Cancel operation" : "Cancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!importReady || working || project.saving}
              onClick={importAsset}
            >
              {tr(storyProject ? "Open project" : "Import selected asset")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
