import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Boxes, Download, FolderOpen, Trash2, Upload, X } from "lucide-react";
import { BrowserWorkspaceService } from "@haneoka/altair-plugin-workspace-browser";
import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair";
import { NATIVE_PROJECT_PATH } from "./native-project";
import { projectLibrary } from "./library";
import type { EditorSession } from "./session";
import { tr, useStudioI18n } from "./i18n";
import {
  webGalEngines,
  webGalEngineRef,
  webGalEngineLicense,
  WEBGAL_ENGINE_EXTENSION,
  type WebGalEngineMetadata,
} from "./webgal-engines";
import { prepareWebGalGame, createWebGalGameZip, downloadWebGalGame, type WebGalGamePlan } from "./webgal-export";
import { RuntimeSettings } from "./RuntimeSettings";
import { readWebGalEngineFolder } from "./webgal-engine-folder";
import "./webgal-engine.css";

export function WebGalEngineDialog({ session, exportMode = false }: { session: EditorSession; exportMode?: boolean }) {
  useStudioI18n();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [open, setOpen] = useState(false),
    [engines, setEngines] = useState<WebGalEngineMetadata[]>([]),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [plan, setPlan] = useState<WebGalGamePlan>(),
    [allowUnsupported, setAllowUnsupported] = useState(false),
    [locale, setLocale] = useState("");
  const task = useRef<AbortController | undefined>(undefined);
  const activeOperation = useRef(false);
  const manifestText = session.document(NATIVE_PROJECT_PATH)?.text ?? "";
  const project = useMemo(() => {
    try {
      return parseAltairProjectDocument(manifestText);
    } catch {
      return undefined;
    }
  }, [manifestText]);
  const selected = webGalEngineRef(project?.extensions?.[WEBGAL_ENGINE_EXTENSION]);
  useEffect(() => {
    setPlan(undefined);
    setAllowUnsupported(false);
  }, [state.documents, state.files, state.directories, locale]);
  useEffect(() => {
    task.current?.abort();
    task.current = undefined;
    activeOperation.current = false;
    setBusy(false);
    if (!open) return;
    const controller = new AbortController();
    task.current = controller;
    setLocale(project?.locales[0] ?? "und");
    setIssue("");
    setPlan(undefined);
    void webGalEngines
      .list()
      .then((items) => {
        if (!controller.signal.aborted) setEngines(items);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setIssue(String(error));
      });
    return () => {
      task.current?.abort();
      task.current = undefined;
    };
  }, [open, session, state.id, state.contextEpoch]);
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (activeOperation.current) return;
    activeOperation.current = true;
    task.current?.abort();
    const controller = new AbortController();
    task.current = controller;
    setBusy(true);
    setIssue("");
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setIssue(error instanceof Error ? tr(error.message) : String(error));
    } finally {
      if (task.current === controller) {
        task.current = undefined;
        activeOperation.current = false;
        setBusy(false);
      }
    }
  };
  const bind = (engine: WebGalEngineMetadata) => {
    const doc = session.document(NATIVE_PROJECT_PATH);
    if (!doc) throw new Error(tr("Project manifest is missing"));
    const current = parseAltairProjectDocument(doc.text);
    session.update(
      doc.path,
      serializeAltairDocument(
        {
          ...current,
          extensions: {
            ...current.extensions,
            [WEBGAL_ENGINE_EXTENSION]: { id: engine.manifest.id, version: engine.manifest.version, hash: engine.hash },
          },
        },
        doc.text,
      ),
    );
    setPlan(undefined);
  };
  const unsupported =
    plan?.diagnostics.filter((item) => item.fidelity === "unsupported" || item.fidelity === "preserved-only") ?? [];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          task.current?.abort();
          task.current = undefined;
          activeOperation.current = false;
          setBusy(false);
        }
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          className="secondary-button"
          disabled={state.saving}
          aria-label={tr(exportMode ? "Export WebGAL game" : "WebGAL engines")}
        >
          {exportMode ? <Download size={15} /> : <Boxes size={15} />}
          <span className={exportMode ? "workspace-action-label" : undefined}>
            {tr(exportMode ? "Export WebGAL game" : "WebGAL engines")}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content webgal-engine-dialog">
          <Dialog.Title>{tr(exportMode ? "Export WebGAL game" : "WebGAL engines")}</Dialog.Title>
          <Dialog.Description>
            {tr("Install a compiled WebGAL web ZIP or folder, then select an exact engine version for this project.")}
          </Dialog.Description>
          <div className="webgal-engine-actions">
            <RuntimeSettings />
            <label className="secondary-button runtime-import">
              <Upload size={15} />
              {tr("Install engine ZIP")}
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                aria-label={tr("Install engine ZIP")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file)
                    void run(async (signal) => {
                      await webGalEngines.install(file, signal);
                      const items = await webGalEngines.list();
                      signal.throwIfAborted();
                      setEngines(items);
                    });
                }}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const workspace = new BrowserWorkspaceService({
                    maxFiles: 20_000,
                    maxTotalBytes: 512 * 1024 * 1024,
                    includeHidden: true,
                    ignoredDirectoryNames: [],
                  });
                  try {
                    await workspace.pickDirectory({ signal, pickerOptions: { mode: "read" } });
                    const contents = await readWebGalEngineFolder(workspace, signal);
                    await webGalEngines.installFolder(contents, signal);
                    const items = await webGalEngines.list();
                    signal.throwIfAborted();
                    setEngines(items);
                  } finally {
                    await workspace.dispose();
                  }
                })
              }
            >
              <FolderOpen size={15} />
              {tr("Install engine folder")}
            </button>
            <a
              className="secondary-button"
              href="https://github.com/OpenWebGAL/WebGAL/releases"
              target="_blank"
              rel="noreferrer"
            >
              {tr("Official WebGAL releases")}
            </a>
          </div>
          {!engines.length && <p>{tr("No WebGAL engine is installed on this device.")}</p>}
          <ul className="webgal-engine-list" aria-label={tr("Installed WebGAL engines")}>
            {engines.map((engine) => {
              const license = webGalEngineLicense(engine.manifest.license);
              const active =
                selected?.id === engine.manifest.id &&
                selected.version === engine.manifest.version &&
                selected.hash === engine.hash;
              return (
                <li key={engine.key}>
                  <div>
                    <strong>
                      {engine.manifest.name} · {engine.manifest.version}
                    </strong>
                    <small>
                      {tr("WebGAL {{version}} · {{size}} MB", {
                        version: engine.manifest.webgalVersion,
                        size: (engine.size / 1048576).toFixed(1),
                      })}
                    </small>
                    {license && <small>{license}</small>}
                  </div>
                  <button
                    className={active ? "primary-button" : "secondary-button"}
                    disabled={busy || active || !project}
                    onClick={() => {
                      try {
                        bind(engine);
                      } catch (error) {
                        setIssue(String(error));
                      }
                    }}
                  >
                    {tr(active ? "Selected" : "Use engine")}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`${tr("Uninstall engine")} · ${engine.manifest.name} ${engine.manifest.version}`}
                    disabled={busy || active}
                    onClick={() =>
                      void run(async (signal) => {
                        const projects = await projectLibrary.list();
                        for (const item of projects) {
                          const file = item.files.find((file) => file.path === NATIVE_PROJECT_PATH);
                          if (!file) continue;
                          if (file.blob.size > 16 * 1024 * 1024) throw new Error(tr("Project manifest is too large"));
                          const manifest = parseAltairProjectDocument(await file.blob.text());
                          const ref = webGalEngineRef(manifest.extensions?.[WEBGAL_ENGINE_EXTENSION]);
                          if (ref?.id === engine.manifest.id && ref.version === engine.manifest.version)
                            throw new Error(tr("Engine is used by project: {{name}}", { name: item.name }));
                        }
                        signal.throwIfAborted();
                        await webGalEngines.remove({
                          id: engine.manifest.id,
                          version: engine.manifest.version,
                          hash: engine.hash,
                        });
                        const items = await webGalEngines.list();
                        signal.throwIfAborted();
                        setEngines(items);
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          {selected &&
            !engines.some(
              (engine) =>
                engine.hash === selected.hash &&
                engine.manifest.id === selected.id &&
                engine.manifest.version === selected.version,
            ) && <p role="alert">{tr("The project's WebGAL engine is not installed")}</p>}
          <label className="field">
            <span>{tr("Export language")}</span>
            <select value={locale} disabled={busy} onChange={(event) => setLocale(event.target.value)}>
              {project?.locales.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={busy || !selected}
            onClick={() =>
              void run(async (signal) => {
                if (!selected) return;
                const engine = await webGalEngines.get(selected);
                signal.throwIfAborted();
                const captured = session.getSnapshot();
                const result = await prepareWebGalGame(session, engine, locale, signal);
                signal.throwIfAborted();
                const current = session.getSnapshot();
                if (
                  current.documents !== captured.documents ||
                  current.files !== captured.files ||
                  current.directories !== captured.directories
                )
                  throw new Error(tr("Project changed while preparing export. Prepare it again."));
                setPlan(result);
              })
            }
          >
            {tr(busy ? "Working…" : "Prepare WebGAL export")}
          </button>
          {plan && (
            <section className="webgal-export-review" aria-label={tr("Export review")}>
              <p>
                {tr("{{count}} files · engine {{version}}", { count: plan.files.length, version: plan.engine.version })}
              </p>
              <p>{tr("Extract the ZIP and serve its folder over HTTP to run the game.")}</p>
              <ul className="webgal-export-diagnostics">
                {plan.diagnostics
                  .filter((item) => item.fidelity !== "exact")
                  .map((item, index) => (
                    <li key={index}>
                      <strong>{item.code}</strong>
                      <span>{item.message}</span>
                      <code>{item.path}</code>
                    </li>
                  ))}
              </ul>
              {!!unsupported.length && (
                <label className="webgal-export-consent">
                  <input
                    type="checkbox"
                    checked={allowUnsupported}
                    onChange={(event) => setAllowUnsupported(event.target.checked)}
                  />
                  {tr("Export with {{count}} unsupported or preserved commands", { count: unsupported.length })}
                </label>
              )}
              <button
                className="primary-button"
                disabled={busy || (!!unsupported.length && !allowUnsupported)}
                onClick={() =>
                  void run(async (signal) => {
                    const blob = await createWebGalGameZip(plan, signal);
                    signal.throwIfAborted();
                    downloadWebGalGame(blob, state.name);
                  })
                }
              >
                <Download size={15} />
                {tr("Download WebGAL game")}
              </button>
            </section>
          )}
          {issue && (
            <p className="home-error" role="alert">
              {issue}
            </p>
          )}
          <Dialog.Close className="modal-close" aria-label={tr("Close")}>
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
