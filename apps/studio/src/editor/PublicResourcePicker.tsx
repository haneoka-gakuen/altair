import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { ChevronRight, FileImage, Folder, RefreshCw, X } from "lucide-react";
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
const PublicAssetPreview = lazy(() => import("./PublicAssetPreview").then((m) => ({ default: m.PublicAssetPreview })));
export function PublicResourcePicker({
  session,
  host,
  onClose,
}: {
  session: EditorSession;
  host?: StudioPublicResourceHost;
  onClose(): void;
}) {
  useStudioI18n();
  const controller = useMemo(
    () => new PublicResourcePickerController(session, host ?? studioPublicResourceHost),
    [session, host],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    project = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [source, setSource] = useState<PublicResourceSource>({
      provider: "haneoka",
      origin: "https://haneoka.org",
      server: "intl",
    }),
    [query, setQuery] = useState(""),
    [page, setPage] = useState("source"),
    [kind, setKind] = useState("model");
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
      controller.dispose();
    };
  }, [controller]);
  const working = ["connecting", "selecting", "importing"].includes(state.phase),
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
    void controller.connect(source).then(() => {
      if (mounted.current && controller.getSnapshot().scope) setPage("browse");
    });
  };
  const select = (file: ResourceBrowserFile) => {
    setMetadata((current) => ({ ...current, directory: "assets/public/" + crypto.randomUUID() }));
    void controller.select(file, kind).then(() => {
      if (mounted.current && controller.getSnapshot().asset) setPage("selected");
    });
  };
  const importAsset = () => {
    if (
      !state.plan ||
      busy ||
      project.saving ||
      !metadata.author.trim() ||
      !metadata.license.trim() ||
      !metadata.version.trim() ||
      !metadata.directory.trim()
    )
      return;
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
            <div>
              <Dialog.Title>{tr("Online assets")}</Dialog.Title>
              <Dialog.Description>
                {tr("Choose a public source, review its files, then import a local copy.")}
              </Dialog.Description>
            </div>
            <button type="button" className="icon-button" aria-label={tr("Close")} onClick={close}>
              <X size={20} />
            </button>
          </header>
          <Tabs.Root value={page} onValueChange={setPage}>
            <Tabs.List className="public-resource-picker__pages" aria-label={tr("Asset picker pages")}>
              <Tabs.Trigger id="public-source-tab" value="source" aria-controls="public-source-page">
                {tr("Source")}
              </Tabs.Trigger>
              <Tabs.Trigger id="public-browse-tab" value="browse" aria-controls="public-browse-page">
                {tr("Browse")}
              </Tabs.Trigger>
              <Tabs.Trigger id="public-selected-tab" value="selected" aria-controls="public-selected-page">
                {tr("Selected asset")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
          {(state.error || issue) && (
            <div className="public-resource-picker__notice" role="alert">
              {tr(state.error || issue)}
            </div>
          )}
          {state.importedPaths && (
            <div className="public-resource-picker__notice" role="status">
              {tr("Imported {{count}} local files", { count: state.importedPaths.length })}
            </div>
          )}
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
                      {server}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{tr("Public catalog origin")}</span>
                <input
                  type="url"
                  value={source.origin}
                  disabled={busy}
                  onChange={(event) => {
                    controller.disconnect();
                    setSource((current) => ({ ...current, origin: event.target.value }));
                  }}
                />
              </label>
              <button type="button" className="secondary-button" disabled={busy} onClick={connect}>
                <RefreshCw size={16} />
                {tr("Connect source")}
              </button>
              <label className="field">
                <span>{tr("Asset use")}</span>
                <select
                  value={kind}
                  disabled={busy}
                  onChange={(event) => {
                    controller.clearSelection();
                    setKind(event.target.value);
                  }}
                >
                  {[
                    "model",
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
                      {tr(value)}
                    </option>
                  ))}
                </select>
              </label>
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
            </section>
            <section
              id="public-browse-page"
              className="public-resource-picker__browser"
              aria-labelledby="public-browse-tab"
            >
              <nav className="public-resource-picker__breadcrumbs" aria-label={tr("Catalog path")}>
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
                      {node.type === "directory" ? <Folder size={18} /> : <FileImage size={18} />}
                      <span>
                        <strong>{node.name}</strong>
                        {node.description && <small>{node.description}</small>}
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
                {state.asset && state.plan ? (
                  <Suspense fallback={<p role="status">{tr("Loading preview")}</p>}>
                    <PublicAssetPreview asset={state.asset} plan={state.plan} />
                  </Suspense>
                ) : (
                  <p>{tr("Select an asset to preview")}</p>
                )}
              </div>
              {state.asset && (
                <section className="public-resource-picker__dependencies">
                  <h3>{state.asset.name}</h3>
                  <p>{tr("{{count}} dependencies", { count: state.asset.members.length })}</p>
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
                </section>
              )}
              <section className="public-resource-picker__metadata">
                <h3>{tr("Local import")}</h3>
                {(["directory", "author", "license", "version"] as const).map((field) => (
                  <label className="field" key={field}>
                    <span>
                      {tr(
                        field === "directory"
                          ? "Import directory"
                          : field === "author"
                            ? "Author"
                            : field === "license"
                              ? "License"
                              : "Version",
                      )}
                    </span>
                    <input
                      value={metadata[field]}
                      disabled={busy}
                      onChange={(event) => setMetadata((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
              </section>
            </aside>
          </div>
          <footer className="public-resource-picker__actions">
            <p role="status">
              {working
                ? state.phase === "importing"
                  ? tr("Importing assets")
                  : tr("Loading {{done}} of {{total}} files", { done: state.loadedMembers, total: state.totalMembers })
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
              disabled={
                !state.plan ||
                working ||
                project.saving ||
                !metadata.author.trim() ||
                !metadata.license.trim() ||
                !metadata.version.trim() ||
                !metadata.directory.trim()
              }
              onClick={importAsset}
            >
              {tr("Import selected asset")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
