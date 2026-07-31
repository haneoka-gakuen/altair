import {
  assertStoryProjectProtocol,
  cloneStoryValue,
  type AltairCommandSchemaContribution,
  type JsonObject,
  type JsonValue,
  type StoryDiagnostic,
  type StoryProject,
  type StoryProjectPlugin,
} from "@haneoka/altair";
import type { AltairDraftSession } from "@haneoka/altair-plugin-drafts";
import type {
  StoryFlowGraph,
  StoryFlowNode,
} from "@haneoka/altair-plugin-flow";
import type { AltairPluginCatalog } from "@haneoka/altair-plugin-marketplace";
import type {
  CompileVegaPreviewStoryResult,
  CompileVegaProjectResult,
} from "@haneoka/altair-plugin-vega-preview";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createStudioAuthoringPluginPlan,
  loadStudioAuthoringPlugins,
  reconcileStudioAuthoringPlugins,
  studioAuthoringPluginBroker,
  type LoadedStudioAuthoringPlugins,
} from "./authoring-plugins";
import {
  studioAdvServiceKey,
  studioBrowserWorkspaceServiceKey,
  studioDraftServiceKey,
  studioHistoryServiceKey,
  studioMarketplaceServiceKey,
  studioVegaPreviewServiceKey,
  studioWebGalServiceKey,
} from "./authoring-service-keys";
import { CommandInsertDialog } from "./CommandInsertDialog";
import {
  DebugPanel,
  type DebugBreakpoint,
  type RuntimeLogEntry,
  type StageInspection,
} from "./DebugPanel";
import {
  clampDebugDockHeight,
  DebugDock,
  DEFAULT_DEBUG_DOCK_HEIGHT,
} from "./DebugDock";
import { FlowView } from "./FlowView";
import { VisualSentenceCard } from "./VisualSentenceCard";
import { StudioPreviewBridge, studioPreviewConfig } from "./preview-bridge";
import { ResourceExplorer } from "./ResourceExplorer";
import { SceneTabs } from "./SceneTabs";
import { StudioIcon } from "./StudioIcon";
import {
  StudioPreviewPanel,
  type StudioPreviewStatus,
} from "./StudioPreviewPanel";
import {
  createProjectLocalization,
  LanguageSettingsPanel,
  projectLocaleDisplayName,
  readProjectLocalization,
  StudioI18nProvider,
  useStudioI18n,
  writeProjectLocalization,
} from "./i18n";
import { commandIndexForSourceLine } from "./source-position";
import {
  createStudioAssetBinding,
  hydrateStudioPreviewAssetUrls,
  refreshFolderWorkspace,
  workspaceFromBrowserService,
  writeStudioDocument,
  writeStudioProjectSnapshot,
  type StudioFolderWorkspace,
} from "./folder-workspace";
import {
  appendUniqueStudioDocuments,
  updateStudioDocument,
  type StudioSourceDocument,
  type StudioWorkspaceImport,
} from "./studio-workspace";
import {
  commandSchemaFor,
  insertProjectCommand,
  moveProjectCommand,
  removeProjectCommand,
  replaceProjectCommand,
  visualResourceCandidates,
} from "./visual-authoring";
import { rebaseStudioDrafts } from "./studio-drafts";
import {
  createStudioPreviewPluginPlan,
  loadStudioPreviewPlugins,
  studioPreviewPluginHost,
} from "./preview-plugins";
import {
  parseStudioThemePreference,
  resolveStudioTheme,
  STUDIO_THEME_STORAGE_KEY,
  type StudioThemePreference,
} from "./theme";
import {
  DEFAULT_STUDIO_PROJECT_PLUGINS,
  STUDIO_PLUGIN_CATALOG,
  STUDIO_PLUGIN_ENVIRONMENT,
} from "./studio-plugin-catalog";
import "./studio.css";

type Mode = "source" | "visual" | "flow";
const EMPTY_ASSET_URLS: ReadonlyMap<string, string> = new Map();
interface StudioAssetUrlState {
  readonly workspace: StudioFolderWorkspace | null;
  readonly urls: ReadonlyMap<string, string>;
}
const Editor = lazy(() => import("@monaco-editor/react"));

const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;

const revisionForText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const documentHistoryName = (id: string): string =>
  `studio.document.${revisionForText(id)}.${id.slice(0, 80)}`;

const draftBaselineSnapshot = (
  baselines: ReadonlyMap<string, string>,
): string =>
  JSON.stringify(
    [...baselines]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, text]) => ({ id, text })),
  );

const draftBaselineRevision = (snapshot: string): number =>
  Number.parseInt(revisionForText(snapshot).slice("fnv1a-".length), 16);

const queueStudioDocumentWrite = (
  queues: Map<string, Promise<void>>,
  workspace: StudioFolderWorkspace,
  document: StudioSourceDocument,
): Promise<void> => {
  const key = `${workspace.id}\0${document.path}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const written = await writeStudioDocument(workspace, document);
      if (!written) {
        throw new Error(
          `The source file is unavailable or the project is read only.`,
        );
      }
    });
  queues.set(key, write);
  return write.finally(() => {
    if (queues.get(key) === write) queues.delete(key);
  });
};

const runtimeCommandIndexForLine = (
  project: StoryProject,
  compilation: CompileVegaPreviewStoryResult,
  sceneId: string,
  line: number,
): number | undefined => {
  const mappings = compilation.commandMappings.filter(
    (mapping) => mapping.sceneId === sceneId,
  );
  if (!mappings.length) return undefined;
  return commandIndexForSourceLine(
    project,
    sceneId,
    mappings.map(({ sourceCommandIndex }) => sourceCommandIndex),
    line,
    mappings.map(({ commandIndex }) => commandIndex),
  );
};

const runtimeBreakpoints = (
  project: StoryProject | null,
  compilation: CompileVegaPreviewStoryResult | null,
  breakpoints: readonly DebugBreakpoint[],
) => {
  if (!project || !compilation) return [];
  return breakpoints.flatMap((breakpoint) => {
    const commandIndex = runtimeCommandIndexForLine(
      project,
      compilation,
      breakpoint.sceneId,
      breakpoint.line,
    );
    return commandIndex === undefined ? [] : [{ commandIndex }];
  });
};

declare global {
  interface Window {
    __ALTAIR_STUDIO_ROOT__?: Root;
  }
}

interface StudioProps {
  readonly initialAuthoringPlugins: LoadedStudioAuthoringPlugins;
  readonly initialAuthoringPluginKey: string;
}

function Studio({
  initialAuthoringPlugins,
  initialAuthoringPluginKey,
}: StudioProps) {
  const { locale: uiLocale, t } = useStudioI18n();
  const initialDocuments = useMemo(
    () =>
      initialAuthoringPlugins.host
        .service(studioWebGalServiceKey)
        ?.createStarterDocuments() ?? [],
    [initialAuthoringPlugins],
  );
  const [themePreference, setThemePreference] = useState<StudioThemePreference>(() => {
    try {
      return parseStudioThemePreference(window.localStorage.getItem(STUDIO_THEME_STORAGE_KEY));
    } catch {
      return "light";
    }
  });
  const [devicePrefersDark, setDevicePrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const [documents, setDocuments] =
    useState<readonly StudioSourceDocument[]>(initialDocuments);
  const [canonicalProject, setCanonicalProject] =
    useState<StoryProject | null>(null);
  const [projectPlugins, setProjectPlugins] = useState<
    readonly StoryProjectPlugin[]
  >(DEFAULT_STUDIO_PROJECT_PLUGINS);
  const [remotePluginCatalogs, setRemotePluginCatalogs] = useState<
    readonly AltairPluginCatalog[]
  >([]);
  const [folderWorkspace, setFolderWorkspace] = useState<StudioFolderWorkspace | null>(null);
  const [assetUrlState, setAssetUrlState] = useState<StudioAssetUrlState>({
    workspace: null,
    urls: EMPTY_ASSET_URLS,
  });
  const assetUrls =
    assetUrlState.workspace === folderWorkspace
      ? assetUrlState.urls
      : EMPTY_ASSET_URLS;
  const assetUrlsReady =
    folderWorkspace === null ||
    assetUrlState.workspace === folderWorkspace;
  const [dirtyDocumentIds, setDirtyDocumentIds] = useState<readonly string[]>([]);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [mode, setMode] = useState<Mode>("visual");
  const [debugOpen, setDebugOpen] = useState(false);
  const [languageSettingsOpen, setLanguageSettingsOpen] = useState(false);
  const [debugDockHeight, setDebugDockHeight] = useState(
    DEFAULT_DEBUG_DOCK_HEIGHT,
  );
  const [debugViewportHeight, setDebugViewportHeight] = useState(
    () => (typeof window === "undefined" ? 900 : window.innerHeight),
  );
  const [commandInsertIndex, setCommandInsertIndex] = useState<number | null>(
    null,
  );
  const [selectedVisualCommandId, setSelectedVisualCommandId] = useState("");
  const [live, setLive] = useState(true);
  const [cursorLines, setCursorLines] = useState<Record<string, number>>(
    () =>
      Object.fromEntries(
        initialDocuments.map(({ id }) => [id, 1]),
      ),
  );
  const [selectedScene, setSelectedScene] = useState(
    initialDocuments[0]?.id ?? "",
  );
  const [openSceneIds, setOpenSceneIds] = useState<readonly string[]>(
    () => initialDocuments.map(({ id }) => id),
  );
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [previewStatus, setPreviewStatus] = useState<StudioPreviewStatus>("connecting");
  const [previewError, setPreviewError] = useState("");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<JsonValue | null>(null);
  const [runtimeSnapshotError, setRuntimeSnapshotError] = useState("");
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [executionState, setExecutionState] = useState("ready");
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState("");
  const [breakpoints, setBreakpoints] = useState<readonly DebugBreakpoint[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<readonly RuntimeLogEntry[]>([]);
  const [stageInspection, setStageInspection] = useState<StageInspection>({
    target: "stage",
    referenceFrame: null,
    transform: null,
    busy: false,
    error: "",
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runtimeMountRef = useRef<HTMLDivElement>(null);
  const builtinPreviewDisposalTailRef =
    useRef<Promise<void>>(Promise.resolve());
  const brokeredPluginLoadRef = useRef<AbortController | undefined>(undefined);
  const bridgeRef = useRef(new StudioPreviewBridge());
  const loadedStoryRef = useRef("");
  const removeRuntimeListenerRef = useRef<(() => void) | undefined>(undefined);
  const logSequenceRef = useRef(0);
  const runtimeLineMapRef = useRef<
    ReadonlyMap<number, { readonly sceneId: string; readonly line: number }>
  >(new Map());
  const projectRef = useRef<StoryProject | null>(null);
  const canonicalProjectRef = useRef<StoryProject | null>(null);
  const canonicalExportRevisionRef = useRef(0);
  const canonicalExportTimerRef = useRef<number | undefined>(undefined);
  const canonicalExportTailRef = useRef<Promise<void>>(Promise.resolve());
  const documentsRef = useRef<readonly StudioSourceDocument[]>(documents);
  const folderWorkspaceRef = useRef<StudioFolderWorkspace | null>(
    folderWorkspace,
  );
  const documentWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const workspaceGenerationRef = useRef(0);
  const workspaceSwitchPendingRef = useRef(false);
  const workspaceBusyCountRef = useRef(0);
  const flushBeforeWorkspaceReplacementRef = useRef<
    () => Promise<boolean>
  >(async () => true);
  const historyMergeTimersRef =
    useRef(new Map<string, number>());
  const savedDocumentTextRef = useRef(
    new Map(
      initialDocuments.map(({ id, text }) => [id, text] as const),
    ),
  );
  const draftBaselineSnapshotRef = useRef(
    draftBaselineSnapshot(savedDocumentTextRef.current),
  );
  const draftBaselineRevisionRef = useRef(
    draftBaselineRevision(draftBaselineSnapshotRef.current),
  );
  const draftSessionRef = useRef<AltairDraftSession | undefined>(
    undefined,
  );
  const previewCompilationRef = useRef<CompileVegaPreviewStoryResult | null>(null);
  const previewPluginHost = useMemo(studioPreviewPluginHost, []);
  const authoringPluginBroker = useMemo(studioAuthoringPluginBroker, []);
  const [authoringPlugins, setAuthoringPlugins] = useState(() => ({
    key: initialAuthoringPluginKey,
    loaded: initialAuthoringPlugins,
  }));
  const authoringPluginsRef = useRef(authoringPlugins);
  const resolvedTheme = resolveStudioTheme(themePreference, devicePrefersDark);

  useEffect(() => {
    authoringPluginsRef.current = authoringPlugins;
  }, [authoringPlugins]);
  useEffect(() => {
    if (!debugOpen) return;
    const fitDebugDock = (): void => {
      const viewportHeight = window.innerHeight;
      setDebugViewportHeight(viewportHeight);
      setDebugDockHeight((height) =>
        clampDebugDockHeight(height, viewportHeight),
      );
    };
    fitDebugDock();
    window.addEventListener("resize", fitDebugDock);
    return () => window.removeEventListener("resize", fitDebugDock);
  }, [debugOpen]);
  useEffect(() => {
    canonicalProjectRef.current = canonicalProject;
  }, [canonicalProject]);
  documentsRef.current = documents;
  folderWorkspaceRef.current = folderWorkspace;

  useEffect(
    () => () => {
      void authoringPluginsRef.current.loaded.dispose().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!folderWorkspace) {
      setAssetUrlState({
        workspace: null,
        urls: EMPTY_ASSET_URLS,
      });
      return;
    }
    if (!folderWorkspace.files.length) {
      setAssetUrlState({
        workspace: folderWorkspace,
        urls: EMPTY_ASSET_URLS,
      });
      return;
    }
    const controller = new AbortController();
    let binding: ReturnType<typeof createStudioAssetBinding> | undefined;
    try {
      binding = createStudioAssetBinding(
        folderWorkspace,
        controller.signal,
      );
      setAssetUrlState({
        workspace: folderWorkspace,
        urls: binding.urls,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setAssetUrlState({
          workspace: null,
          urls: EMPTY_ASSET_URLS,
        });
        setRuntimeSnapshotError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return () => {
      controller.abort();
      binding?.release();
    };
  }, [folderWorkspace]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setDevicePrefersDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themePreference;
    document.documentElement.style.colorScheme = resolvedTheme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedTheme === "dark" ? "#0f0f0f" : "#ffffff");
    try {
      window.localStorage.setItem(STUDIO_THEME_STORAGE_KEY, themePreference);
    } catch {
      // Storage can be disabled without disabling theme selection.
    }
  }, [resolvedTheme, themePreference]);

  const pushLog = useCallback(
    (level: RuntimeLogEntry["level"], message: string, source: RuntimeLogEntry["source"]) => {
      const id = `${source}-${++logSequenceRef.current}`;
      setRuntimeLogs((entries) => [...entries.slice(-199), { id, level, message, source }]);
    },
    [],
  );

  const beginWorkspaceWork = useCallback((): void => {
    workspaceBusyCountRef.current += 1;
    setWorkspaceBusy(true);
  }, []);

  const endWorkspaceWork = useCallback((): void => {
    workspaceBusyCountRef.current = Math.max(
      0,
      workspaceBusyCountRef.current - 1,
    );
    setWorkspaceBusy(workspaceBusyCountRef.current > 0);
  }, []);

  const previewConfiguration = useMemo(() => {
    try {
      return { config: studioPreviewConfig(), error: "" };
    } catch (error) {
      return { config: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const [workspace, setWorkspace] = useState<StudioWorkspaceImport>({
    project: null,
    diagnostics: [],
    errors: new Map(),
  });
  useEffect(() => {
    const host = authoringPlugins.loaded.host;
    const sourceService = host.service(studioWebGalServiceKey);
    if (!sourceService) {
      setWorkspace({
        project: null,
        diagnostics: [],
        errors: new Map(
          documents.map(({ id }) => [
            id,
            "The source authoring plugin is disabled.",
          ]),
        ),
      });
      return;
    }
    const controller = new AbortController();
    void sourceService
      .importSourceDocuments(host, documents, {
        title: sourceService.profile.defaultProjectTitle,
        signal: controller.signal,
      })
      .then(
        (imported) => {
          if (controller.signal.aborted) return;
          setWorkspace({
            project: imported.project,
            diagnostics: imported.diagnostics,
            errors: imported.errors,
          });
        },
        (error) => {
          if (controller.signal.aborted) return;
          setWorkspace({
            project: null,
            diagnostics: [],
            errors: new Map([
              [
                "workspace",
                error instanceof Error ? error.message : String(error),
              ],
            ]),
          });
        },
      );
    return () =>
      controller.abort(
        new DOMException("Workspace import superseded", "AbortError"),
      );
  }, [authoringPlugins, documents]);
  const project = useMemo(
    () => {
      const base = canonicalProject ?? workspace.project;
      if (!base) return null;
      const snapshot =
        canonicalProject === null
          ? folderWorkspace?.projectSnapshot
          : undefined;
      return {
        ...base,
        meta: snapshot
          ? { ...base.meta, ...snapshot.meta }
          : base.meta,
        assets: snapshot
          ? { ...snapshot.assets, ...base.assets }
          : base.assets,
        runtime: snapshot
          ? { ...base.runtime, ...snapshot.runtime }
          : base.runtime,
        storyFields: snapshot
          ? { ...base.storyFields, ...snapshot.storyFields }
          : base.storyFields,
        extensions: snapshot
          ? { ...base.extensions, ...snapshot.extensions }
          : base.extensions,
        plugins: [...projectPlugins],
      };
    },
    [
      canonicalProject,
      folderWorkspace?.projectSnapshot,
      projectPlugins,
      workspace.project,
    ],
  );
  const projectLocalization = useMemo(
    () =>
      project
        ? readProjectLocalization(project)
        : createProjectLocalization(),
    [project],
  );
  const visualLocales = useMemo(
    () =>
      projectLocalization.languages.map(({ locale, fonts }) => ({
        key: locale,
        label: projectLocaleDisplayName(locale, uiLocale),
        fonts,
      })),
    [projectLocalization, uiLocale],
  );
  const pluginCatalog = useMemo(
    () => {
      const marketplace = authoringPlugins.loaded.host.service(
        studioMarketplaceServiceKey,
      );
      return marketplace
        ? marketplace.mergeCatalogs([
            STUDIO_PLUGIN_CATALOG,
            ...remotePluginCatalogs,
          ])
        : STUDIO_PLUGIN_CATALOG;
    },
    [authoringPlugins, remotePluginCatalogs],
  );
  const authoringPluginPlan = useMemo(
    () =>
      createStudioAuthoringPluginPlan(
        projectPlugins,
        pluginCatalog,
        STUDIO_PLUGIN_ENVIRONMENT,
        authoringPluginBroker !== undefined,
      ),
    [authoringPluginBroker, pluginCatalog, projectPlugins],
  );
  useEffect(() => {
    if (authoringPluginPlan.key === authoringPluginsRef.current.key) return;
    if (
      authoringPluginPlan.diagnostics.some(
        ({ severity }) => severity === "error",
      )
    ) {
      pushLog(
        "error",
        authoringPluginPlan.diagnostics
          .filter(({ severity }) => severity === "error")
          .map(({ message }) => message)
          .join("; "),
        "studio",
      );
    }
    const controller = new AbortController();
    void reconcileStudioAuthoringPlugins(
      authoringPluginsRef.current.loaded,
      authoringPluginPlan,
      authoringPluginBroker,
      controller.signal,
    )
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        setAuthoringPlugins({
          key: authoringPluginPlan.key,
          loaded,
        });
        pushLog(
          "info",
          `Activated ${loaded.loaded.length} authoring extension${
            loaded.loaded.length === 1 ? "" : "s"
          }.`,
          "studio",
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          pushLog(
            "error",
            error instanceof Error ? error.message : String(error),
            "studio",
          );
        }
      });
    return () => controller.abort();
  }, [
    authoringPluginBroker,
    authoringPluginPlan,
    pushLog,
  ]);
  useEffect(() => {
    const service = authoringPlugins.loaded.host.service(
      studioHistoryServiceKey,
    );
    if (!service) return;
    const activeNames = new Set(
      documents.map(({ id }) => documentHistoryName(id)),
    );
    for (const name of service.names()) {
      if (
        name.startsWith("studio.document.") &&
        !activeNames.has(name)
      ) {
        service.close(name);
      }
    }
    for (const document of documents) {
      const name = documentHistoryName(document.id);
      const history = service.get<string>(name);
      if (!history) {
        service.create(name, document.text, { capacity: 200 });
      } else if (
        !dirtyDocumentIds.includes(document.id) &&
        history.value !== document.text
      ) {
        history.reset(document.text);
      }
    }
    setHistoryRevision((revision) => revision + 1);
  }, [authoringPlugins, dirtyDocumentIds, documents]);

  useEffect(
    () => () => {
      for (const timer of historyMergeTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      historyMergeTimersRef.current.clear();
      if (canonicalExportTimerRef.current !== undefined) {
        window.clearTimeout(canonicalExportTimerRef.current);
      }
    },
    [],
  );
  const addRemotePluginCatalog = useCallback(
    (catalog: AltairPluginCatalog): void => {
      setRemotePluginCatalogs((current) => [
        ...current.filter(({ id }) => id !== catalog.id),
        catalog,
      ]);
    },
    [],
  );
  const previewPluginDestination = previewConfiguration.config
    ? "brokered"
    : "bundled";
  const previewPluginPlan = useMemo(
    () =>
      project
        ? createStudioPreviewPluginPlan(
            project,
            pluginCatalog,
            STUDIO_PLUGIN_ENVIRONMENT,
            previewPluginDestination,
            previewPluginHost !== undefined,
          )
        : null,
    [
      pluginCatalog,
      previewPluginDestination,
      previewPluginHost,
      project,
    ],
  );
  const previewAuthoringAvailable =
    authoringPlugins.loaded.host.service(
      studioVegaPreviewServiceKey,
    ) !== undefined;
  const previewPluginBlocked =
    previewPluginPlan?.diagnostics.some(
      ({ severity }) => severity === "error",
    ) === true || !previewAuthoringAvailable;
  const updateProjectPlugins = useCallback(
    async (plugins: readonly StoryProjectPlugin[]): Promise<void> => {
      const nextPlugins = plugins.map((plugin) => ({ ...plugin }));
      if (folderWorkspace?.writable && workspace.project) {
        try {
          await writeStudioProjectSnapshot(folderWorkspace, {
            ...workspace.project,
            plugins: nextPlugins,
          });
          pushLog(
            "info",
            "Saved project extension state to altair.project.json.",
            "studio",
          );
        } catch (error) {
          pushLog(
            "error",
            error instanceof Error ? error.message : String(error),
            "studio",
          );
          throw error;
        }
      }
      setProjectPlugins(nextPlugins);
    },
    [folderWorkspace, pushLog, workspace.project],
  );
  const projectValidation = useMemo(
    () => {
      if (!project) return null;
      try {
        assertStoryProjectProtocol(project);
        return {
          valid: true,
          errors: [] as readonly StoryDiagnostic[],
          warnings: [] as readonly StoryDiagnostic[],
        };
      } catch (error) {
        return {
          valid: false,
          errors: [
            {
              severity: "error",
              code: "project.protocol",
              path: "$",
              message: error instanceof Error ? error.message : String(error),
            },
          ] satisfies readonly StoryDiagnostic[],
          warnings: [] as readonly StoryDiagnostic[],
        };
      }
    },
    [project],
  );
  const [authoringDiagnostics, setAuthoringDiagnostics] = useState<
    readonly StoryDiagnostic[]
  >([]);
  const [flowGraph, setFlowGraph] = useState<StoryFlowGraph | null>(null);
  useEffect(() => {
    if (!project || !projectValidation?.valid) {
      setAuthoringDiagnostics([]);
      setFlowGraph(null);
      return;
    }
    const controller = new AbortController();
    const host = authoringPlugins.loaded.host;
    void host
      .evaluateDiagnostics(project, controller.signal)
      .then((values) => {
        if (!controller.signal.aborted) setAuthoringDiagnostics(values);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          pushLog(
            "error",
            error instanceof Error ? error.message : String(error),
            "studio",
          );
        }
      });
    const provider = host.contributions("flow")[0];
    if (!provider) {
      setFlowGraph(null);
    } else {
      void host
        .buildFlow<StoryFlowGraph>(provider.id, project, controller.signal)
        .then((graph) => {
          if (!controller.signal.aborted) setFlowGraph(graph);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setFlowGraph(null);
            pushLog(
              "error",
              error instanceof Error ? error.message : String(error),
              "studio",
            );
          }
        });
    }
    return () => controller.abort();
  }, [authoringPlugins, project, projectValidation?.valid, pushLog]);

  const activeDocument =
    documents.find(({ id }) => id === selectedScene) ??
    documents[0] ??
    initialDocuments[0]!;
  const sourceAuthoring = authoringPlugins.loaded.host.service(
    studioWebGalServiceKey,
  );
  const activeHistory = useMemo(
    () =>
      authoringPlugins.loaded.host
        .service(studioHistoryServiceKey)
        ?.get<string>(documentHistoryName(activeDocument.id)),
    [activeDocument.id, authoringPlugins, historyRevision],
  );
  const source = activeDocument.text;
  const cursorLine = cursorLines[selectedScene] ?? 1;
  const sourceLineCount = Math.max(1, source.split(/\r?\n/).length);
  const setCursorLine = (line: number): void => {
    setCursorLines((lines) => ({
      ...lines,
      [selectedScene]: Math.max(1, Math.min(sourceLineCount, Math.round(line))),
    }));
  };

  const openScene = useCallback((sceneId: string) => {
    setOpenSceneIds((sceneIds) =>
      sceneIds.includes(sceneId) ? sceneIds : [...sceneIds, sceneId],
    );
    setSelectedScene(sceneId);
  }, []);

  const resetDraftBaselines = useCallback(
    (nextDocuments: readonly StudioSourceDocument[]): void => {
      savedDocumentTextRef.current = new Map(
        nextDocuments.map(({ id, text }) => [id, text] as const),
      );
      draftBaselineSnapshotRef.current = draftBaselineSnapshot(
        savedDocumentTextRef.current,
      );
      draftBaselineRevisionRef.current = draftBaselineRevision(
        draftBaselineSnapshotRef.current,
      );
    },
    [],
  );

  const adoptFolderWorkspace = useCallback(
    (workspace: StudioFolderWorkspace): void => {
      const nextDocuments = workspace.documents.length
        ? workspace.documents
        : initialDocuments;
      const entry =
        nextDocuments.find(({ id }) => /(?:^|\/)start$/i.test(id)) ??
        nextDocuments[0];
      workspaceGenerationRef.current += 1;
      resetDraftBaselines(nextDocuments);
      canonicalExportRevisionRef.current += 1;
      if (canonicalExportTimerRef.current !== undefined) {
        window.clearTimeout(canonicalExportTimerRef.current);
        canonicalExportTimerRef.current = undefined;
      }
      canonicalProjectRef.current = null;
      folderWorkspaceRef.current = workspace;
      documentsRef.current = nextDocuments;
      setCanonicalProject(null);
      setFolderWorkspace(workspace);
      setDocuments(nextDocuments);
      setProjectPlugins(
        workspace.projectPlugins ?? DEFAULT_STUDIO_PROJECT_PLUGINS,
      );
      setDirtyDocumentIds([]);
      setCommandInsertIndex(null);
      setSelectedVisualCommandId("");
      if (entry) {
        setSelectedScene(entry.id);
        setOpenSceneIds([entry.id]);
        setCursorLines({ [entry.id]: 1 });
      }
      pushLog(
        "info",
        `Opened ${workspace.name}: ${workspace.documents.length} scene${workspace.documents.length === 1 ? "" : "s"}, ${workspace.files.length} files.`,
        "studio",
      );
    },
    [initialDocuments, pushLog, resetDraftBaselines],
  );

  useEffect(() => {
    const service = authoringPlugins.loaded.host.service(
      studioDraftServiceKey,
    );
    if (!service) {
      draftSessionRef.current = undefined;
      return;
    }
    const workspaceIdentity =
      folderWorkspace?.id ?? "sample-project";
    const name = `studio.${revisionForText(workspaceIdentity)}`;
    let cancelled = false;
    let session: AltairDraftSession | undefined;
    void (async () => {
      session =
        service.get(name) ??
        (await service.open(name));
      if (cancelled) {
        await service.close(name);
        return;
      }
      draftSessionRef.current = session;
      const status = session.status({
        snapshot: draftBaselineSnapshotRef.current,
        revision: draftBaselineRevisionRef.current,
        nextSceneIds: documentsRef.current.map(({ id }) => id),
      });
      if (status.conflict) {
        pushLog(
          "warning",
          `A saved draft was retained because the project changed (${status.conflict}).`,
          "studio",
        );
        return;
      }
      const recovered = new Map<string, string>();
      for (const record of session.snapshot().scenes) {
        const baseline = savedDocumentTextRef.current.get(
          record.sceneId,
        );
        if (baseline === undefined) continue;
        const result = await session.reconcileScene(
          record.sceneId,
          baseline,
        );
        if (result.pending && result.value !== baseline) {
          recovered.set(record.sceneId, result.value);
        }
      }
      if (!recovered.size || cancelled) return;
      const historyService =
        authoringPlugins.loaded.host.service(
          studioHistoryServiceKey,
        );
      for (const [id, text] of recovered) {
        const history =
          historyService?.get<string>(documentHistoryName(id)) ??
          historyService?.create(
            documentHistoryName(id),
            savedDocumentTextRef.current.get(id) ?? "",
            { capacity: 200 },
          );
        history?.replace(text, { mergeKey: "draft-recovery" });
        history?.endMerge();
      }
      const recoveredDocuments = documentsRef.current.map(
        (document) => ({
          ...document,
          text: recovered.get(document.id) ?? document.text,
        }),
      );
      documentsRef.current = recoveredDocuments;
      setDocuments(recoveredDocuments);
      setDirtyDocumentIds((current) => [
        ...new Set([...current, ...recovered.keys()]),
      ]);
      setHistoryRevision((revision) => revision + 1);
      pushLog(
        "info",
        `Recovered ${recovered.size} unsaved scene draft${
          recovered.size === 1 ? "" : "s"
        }.`,
        "studio",
      );
    })().catch((error) => {
      if (!cancelled) {
        pushLog(
          "error",
          error instanceof Error ? error.message : String(error),
          "studio",
        );
      }
    });
    return () => {
      cancelled = true;
      if (draftSessionRef.current === session) {
        draftSessionRef.current = undefined;
      }
      void service.close(name).catch(() => undefined);
    };
  }, [authoringPlugins, folderWorkspace?.id, pushLog]);

  const openProjectFolder = useCallback(async (): Promise<void> => {
    if (workspaceSwitchPendingRef.current) return;
    const host = authoringPluginsRef.current.loaded.host;
    const service = host.service(
      studioBrowserWorkspaceServiceKey,
    );
    const source = host.service(studioWebGalServiceKey);
    if (!service || !source) {
      pushLog(
        "error",
        "Enable the browser workspace and source authoring extensions to open a project.",
        "studio",
      );
      return;
    }
    workspaceSwitchPendingRef.current = true;
    beginWorkspaceWork();
    try {
      if (!(await flushBeforeWorkspaceReplacementRef.current())) return;
      const snapshot = await service.pickDirectory({
        pickerOptions: {
          id: "altair-project",
          mode: "readwrite",
        },
      });
      adoptFolderWorkspace(
        await workspaceFromBrowserService(service, source, snapshot),
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        pushLog("error", error instanceof Error ? error.message : String(error), "studio");
      }
    } finally {
      workspaceSwitchPendingRef.current = false;
      endWorkspaceWork();
    }
  }, [
    adoptFolderWorkspace,
    beginWorkspaceWork,
    endWorkspaceWork,
    pushLog,
  ]);

  const openSceneFiles = useCallback(
    async (): Promise<void> => {
      if (workspaceSwitchPendingRef.current) return;
      const host = authoringPluginsRef.current.loaded.host;
      const service = host.service(
        studioBrowserWorkspaceServiceKey,
      );
      const source = host.service(studioWebGalServiceKey);
      if (!service || !source) {
        pushLog(
          "error",
          "Enable the browser workspace and source authoring extensions to import scenes.",
          "studio",
        );
        return;
      }
      workspaceSwitchPendingRef.current = true;
      beginWorkspaceWork();
      try {
        if (!(await flushBeforeWorkspaceReplacementRef.current())) return;
        const snapshot = await service.pickFiles({
          pickerOptions: {
            multiple: true,
            types: [
              {
                description: source.profile.scenePickerDescription,
                accept: {
                  [source.profile.sceneMediaType]: [
                    ...source.profile.sceneExtensions,
                  ],
                },
              },
            ],
          },
        });
        adoptFolderWorkspace(
          await workspaceFromBrowserService(service, source, snapshot),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          pushLog(
            "error",
            error instanceof Error ? error.message : String(error),
            "studio",
          );
        }
      } finally {
        workspaceSwitchPendingRef.current = false;
        endWorkspaceWork();
      }
    },
    [
      adoptFolderWorkspace,
      beginWorkspaceWork,
      endWorkspaceWork,
      pushLog,
    ],
  );

  const refreshProjectFolder = useCallback(async (): Promise<void> => {
    if (workspaceSwitchPendingRef.current || !folderWorkspace) return;
    workspaceSwitchPendingRef.current = true;
    beginWorkspaceWork();
    try {
      if (!(await flushBeforeWorkspaceReplacementRef.current())) return;
      const currentWorkspace = folderWorkspaceRef.current;
      if (!currentWorkspace) return;
      adoptFolderWorkspace(
        await refreshFolderWorkspace(currentWorkspace),
      );
    } catch (error) {
      pushLog("error", error instanceof Error ? error.message : String(error), "studio");
    } finally {
      workspaceSwitchPendingRef.current = false;
      endWorkspaceWork();
    }
  }, [
    adoptFolderWorkspace,
    beginWorkspaceWork,
    endWorkspaceWork,
    folderWorkspace,
    pushLog,
  ]);

  const saveDocuments = useCallback(
    async (
      ids: readonly string[] = dirtyDocumentIds,
    ): Promise<boolean> => {
      const workspaceAtStart = folderWorkspaceRef.current;
      const generationAtStart = workspaceGenerationRef.current;
      const targets = documentsRef.current.filter(({ id }) =>
        ids.includes(id),
      );
      if (!targets.length) return true;
      beginWorkspaceWork();
      try {
        let savedTargets = targets;
        if (workspaceAtStart?.writable) {
          const results = await Promise.allSettled(
            targets.map((document) =>
              queueStudioDocumentWrite(
                documentWriteQueuesRef.current,
                workspaceAtStart,
                document,
              ),
            ),
          );
          savedTargets = targets.filter(
            (_document, index) => results[index]?.status === "fulfilled",
          );
          for (const [index, result] of results.entries()) {
            if (result.status === "rejected") {
              const document = targets[index]!;
              pushLog(
                "error",
                `Could not save ${document.path}: ${
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason)
                }`,
                "studio",
              );
            }
          }
        }
        if (
          generationAtStart !== workspaceGenerationRef.current ||
          folderWorkspaceRef.current !== workspaceAtStart
        ) {
          return false;
        }
        if (!savedTargets.length) return false;

        for (const { id, text } of savedTargets) {
          savedDocumentTextRef.current.set(id, text);
        }
        const nextBaselineSnapshot = draftBaselineSnapshot(
          savedDocumentTextRef.current,
        );
        const nextBaselineRevision = draftBaselineRevision(
          nextBaselineSnapshot,
        );
        draftBaselineSnapshotRef.current = nextBaselineSnapshot;
        draftBaselineRevisionRef.current = nextBaselineRevision;

        const draftSession = draftSessionRef.current;
        if (draftSession && !draftSession.disposed) {
          await rebaseStudioDrafts(
            draftSession,
            documentsRef.current,
            savedDocumentTextRef.current,
            nextBaselineSnapshot,
            nextBaselineRevision,
          );
        }
        if (
          generationAtStart !== workspaceGenerationRef.current ||
          folderWorkspaceRef.current !== workspaceAtStart
        ) {
          return false;
        }

        setDirtyDocumentIds((current) =>
          current.filter((id) => {
            const document = documentsRef.current.find(
              (candidate) => candidate.id === id,
            );
            const baseline = savedDocumentTextRef.current.get(id);
            return (
              document === undefined ||
              baseline === undefined ||
              document.text !== baseline
            );
          }),
        );
        if (!workspaceAtStart?.writable) {
          pushLog(
            "info",
            `Saved ${savedTargets.length} scene${
              savedTargets.length === 1 ? "" : "s"
            } in this browser session.`,
            "studio",
          );
        }
        return savedTargets.length === targets.length;
      } catch (error) {
        pushLog("error", error instanceof Error ? error.message : String(error), "studio");
        return false;
      } finally {
        endWorkspaceWork();
      }
    },
    [
      beginWorkspaceWork,
      dirtyDocumentIds,
      endWorkspaceWork,
      pushLog,
    ],
  );

  const updateDocumentText = useCallback((
    id: string,
    text: string,
    options: {
      readonly mergeKey?: string;
      readonly preserveCanonicalProject?: boolean;
    } = {},
  ): void => {
    if (!options.preserveCanonicalProject) {
      canonicalProjectRef.current = null;
      setCanonicalProject(null);
      canonicalExportRevisionRef.current += 1;
      if (canonicalExportTimerRef.current !== undefined) {
        window.clearTimeout(canonicalExportTimerRef.current);
        canonicalExportTimerRef.current = undefined;
      }
    }
    const service =
      authoringPluginsRef.current.loaded.host.service(
        studioHistoryServiceKey,
      );
    if (service) {
      const name = documentHistoryName(id);
      const current =
        documentsRef.current.find((document) => document.id === id)
          ?.text ?? "";
      const history =
        service.get<string>(name) ??
        service.create(name, current, { capacity: 200 });
      history.replace(text, {
        mergeKey: options.mergeKey ?? `typing:${id}`,
      });
      const previousTimer = historyMergeTimersRef.current.get(id);
      if (previousTimer !== undefined) {
        window.clearTimeout(previousTimer);
      }
      historyMergeTimersRef.current.set(
        id,
        window.setTimeout(() => {
          historyMergeTimersRef.current.delete(id);
          if (!history.disposed) history.endMerge();
        }, 700),
      );
      setHistoryRevision((revision) => revision + 1);
    }
    const draftSession = draftSessionRef.current;
    const baseline = savedDocumentTextRef.current.get(id);
    if (draftSession && baseline !== undefined) {
      const path =
        documentsRef.current.find((document) => document.id === id)
          ?.path ?? id;
      void draftSession
        .updateScene({
          sceneId: id,
          baseline,
          value: text,
          projectSnapshot: draftBaselineSnapshotRef.current,
          projectRevision: draftBaselineRevisionRef.current,
          context: { path },
        })
        .catch((error) =>
          pushLog(
            "error",
            error instanceof Error ? error.message : String(error),
            "studio",
          ),
        );
    }
    const nextDocuments = updateStudioDocument(
      documentsRef.current,
      id,
      text,
    );
    documentsRef.current = nextDocuments;
    setDocuments(nextDocuments);
    setDirtyDocumentIds((current) =>
      current.includes(id) ? current : [...current, id],
    );
  }, [pushLog]);

  const runCanonicalSourceExport = useCallback(
    (
      nextProject: StoryProject,
      revision: number,
    ): Promise<boolean> => {
      const task = canonicalExportTailRef.current
        .catch(() => undefined)
        .then(async (): Promise<boolean> => {
          if (revision !== canonicalExportRevisionRef.current) return true;
          const host = authoringPluginsRef.current.loaded.host;
          const sourceService = host.service(studioWebGalServiceKey);
          if (!sourceService) {
            if (revision === canonicalExportRevisionRef.current) {
              pushLog(
                "error",
                "Visual edits are preserved. Enable the active source extension to write them back.",
                "studio",
              );
            }
            return false;
          }
          const entryDocument =
            documentsRef.current.find(
              ({ id }) => id === nextProject.entrySceneId,
            ) ?? documentsRef.current[0];
          try {
            const exported = await sourceService.exportSourceDocuments(
              host,
              nextProject,
              {
                ...(entryDocument
                  ? { entryPath: entryDocument.sourcePath }
                  : {}),
              },
            );
            if (revision !== canonicalExportRevisionRef.current) return true;
            const currentById = new Map(
              documentsRef.current.map((document) => [
                document.id,
                document,
              ]),
            );
            for (const document of exported.documents) {
              if (
                currentById.get(document.id)?.text === document.text
              ) {
                continue;
              }
              updateDocumentText(document.id, document.text, {
                mergeKey: `visual:${document.id}`,
                preserveCanonicalProject: true,
              });
            }
            return true;
          } catch (error) {
            if (revision === canonicalExportRevisionRef.current) {
              pushLog(
                "error",
                `Visual edits are preserved but could not be written back: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                "studio",
              );
            }
            return false;
          }
        });
      canonicalExportTailRef.current = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    [pushLog, updateDocumentText],
  );

  const scheduleCanonicalSourceExport = useCallback(
    (nextProject: StoryProject): void => {
      const revision = ++canonicalExportRevisionRef.current;
      if (canonicalExportTimerRef.current !== undefined) {
        window.clearTimeout(canonicalExportTimerRef.current);
      }
      canonicalExportTimerRef.current = window.setTimeout(() => {
        canonicalExportTimerRef.current = undefined;
        void runCanonicalSourceExport(nextProject, revision);
      }, 120);
    },
    [runCanonicalSourceExport],
  );

  const flushCanonicalSourceExport = useCallback(
    async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (canonicalExportTimerRef.current !== undefined) {
          window.clearTimeout(canonicalExportTimerRef.current);
          canonicalExportTimerRef.current = undefined;
        }
        const pending = canonicalProjectRef.current;
        if (!pending) {
          await canonicalExportTailRef.current.catch(() => undefined);
          if (
            !canonicalProjectRef.current &&
            canonicalExportTimerRef.current === undefined
          ) {
            return true;
          }
          continue;
        }
        const revision = ++canonicalExportRevisionRef.current;
        const exported = await runCanonicalSourceExport(
          pending,
          revision,
        );
        if (!exported) return false;
        if (
          revision === canonicalExportRevisionRef.current &&
          canonicalExportTimerRef.current === undefined
        ) {
          return true;
        }
      }
      pushLog(
        "error",
        "Could not switch projects while visual edits were still changing.",
        "studio",
      );
      return false;
    },
    [pushLog, runCanonicalSourceExport],
  );

  flushBeforeWorkspaceReplacementRef.current =
    async (): Promise<boolean> => {
      const generationAtStart = workspaceGenerationRef.current;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!(await flushCanonicalSourceExport())) return false;
        if (generationAtStart !== workspaceGenerationRef.current) {
          return false;
        }
        await Promise.allSettled([
          ...documentWriteQueuesRef.current.values(),
        ]);
        const dirtyIds = documentsRef.current
          .filter(
            ({ id, text }) =>
              savedDocumentTextRef.current.get(id) !== text,
          )
          .map(({ id }) => id);
        if (!dirtyIds.length) return true;
        const currentWorkspace = folderWorkspaceRef.current;
        if (!currentWorkspace?.writable) {
          const discard = window.confirm(
            "This in-memory project has unsaved changes. Discard them and continue?",
          );
          if (!discard) {
            pushLog(
              "warning",
              "Project switch cancelled; unsaved changes were kept.",
              "studio",
            );
          }
          return discard;
        }
        const saved = await saveDocuments(dirtyIds);
        if (
          !saved ||
          generationAtStart !== workspaceGenerationRef.current ||
          folderWorkspaceRef.current !== currentWorkspace
        ) {
          return false;
        }
      }
      pushLog(
        "error",
        "Could not switch projects while source edits were still changing.",
        "studio",
      );
      return false;
    };

  useEffect(() => {
    const pending = canonicalProjectRef.current;
    if (
      pending &&
      authoringPlugins.loaded.host.service(studioWebGalServiceKey)
    ) {
      scheduleCanonicalSourceExport(pending);
    }
  }, [authoringPlugins.key, scheduleCanonicalSourceExport]);

  const updateCanonicalProject = useCallback(
    (operation: (project: StoryProject) => StoryProject): void => {
      const base = canonicalProjectRef.current ?? projectRef.current;
      if (!base) return;
      const host = authoringPluginsRef.current.loaded.host;
      if (!host.service(studioWebGalServiceKey)) {
        pushLog(
          "error",
          "Enable the active source extension to edit this project visually.",
          "studio",
        );
        return;
      }
      const next = operation(cloneStoryValue(base));
      canonicalProjectRef.current = next;
      setCanonicalProject(next);
      scheduleCanonicalSourceExport(next);
    },
    [pushLog, scheduleCanonicalSourceExport],
  );

  const insertVisualCommand = useCallback(
    async (
      schema: AltairCommandSchemaContribution,
      index: number,
    ): Promise<void> => {
      const host = authoringPluginsRef.current.loaded.host;
      const base = canonicalProjectRef.current ?? projectRef.current;
      if (!base) return;
      try {
        const command = await host.createCommand(
          schema.id,
          base,
          new AbortController().signal,
        );
        updateCanonicalProject((current) =>
          insertProjectCommand(current, selectedScene, index, command),
        );
        setSelectedVisualCommandId(command.id);
        setCommandInsertIndex(null);
      } catch (error) {
        pushLog(
          "error",
          error instanceof Error ? error.message : String(error),
          "studio",
        );
      }
    },
    [pushLog, selectedScene, updateCanonicalProject],
  );

  const restoreDocumentHistory = useCallback(
    (direction: "undo" | "redo"): void => {
      const service =
        authoringPluginsRef.current.loaded.host.service(
          studioHistoryServiceKey,
        );
      const document =
        documentsRef.current.find(({ id }) => id === selectedScene) ??
        documentsRef.current[0];
      if (!service || !document) return;
      const history = service.get<string>(
        documentHistoryName(document.id),
      );
      if (!history) return;
      history.endMerge();
      const text =
        direction === "undo" ? history.undo() : history.redo();
      canonicalProjectRef.current = null;
      setCanonicalProject(null);
      canonicalExportRevisionRef.current += 1;
      const nextDocuments = updateStudioDocument(
        documentsRef.current,
        document.id,
        text,
      );
      documentsRef.current = nextDocuments;
      setDocuments(nextDocuments);
      setDirtyDocumentIds((current) =>
        current.includes(document.id)
          ? current
          : [...current, document.id],
      );
      setHistoryRevision((revision) => revision + 1);
    },
    [selectedScene],
  );

  useEffect(() => {
    if (!folderWorkspace?.writable || !dirtyDocumentIds.length) return;
    const timer = window.setTimeout(() => {
      void saveDocuments();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [dirtyDocumentIds, folderWorkspace?.writable, saveDocuments]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveDocuments();
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [saveDocuments]);

  const closeScene = (sceneId: string): void => {
    setOpenSceneIds((sceneIds) => {
      if (sceneIds.length <= 1) return sceneIds;
      const index = sceneIds.indexOf(sceneId);
      const remaining = sceneIds.filter((id) => id !== sceneId);
      if (selectedScene === sceneId) {
        setSelectedScene(remaining[Math.max(0, index - 1)] ?? remaining[0]!);
      }
      return remaining;
    });
  };

  useEffect(() => {
    if (project?.scenes.some((scene) => scene.id === selectedScene)) return;
    const next = project?.entrySceneId ?? documents[0]?.id;
    if (next) openScene(next);
  }, [documents, openScene, project, selectedScene]);

  useEffect(() => {
    if (!project) return;
    const valid = new Set(project.scenes.map(({ id }) => id));
    setOpenSceneIds((sceneIds) => {
      const filtered = sceneIds.filter((id) => valid.has(id));
      return filtered.length ? filtered : [project.entrySceneId];
    });
  }, [project]);

  useEffect(() => {
    if (!flowGraph) {
      setSelectedFlowNodeId("");
      return;
    }
    if (flowGraph.nodes.some(({ id }) => id === selectedFlowNodeId)) return;
    setSelectedFlowNodeId(flowGraph.entryNodeId);
  }, [flowGraph, selectedFlowNodeId]);

  const [previewCompilation, setPreviewCompilation] =
    useState<CompileVegaPreviewStoryResult | null>(null);
  const [vegaCompilation, setVegaCompilation] =
    useState<CompileVegaProjectResult | null>(null);
  const [compileServiceError, setCompileServiceError] = useState("");
  useEffect(() => {
    const service = authoringPlugins.loaded.host.service(
      studioVegaPreviewServiceKey,
    );
    if (!project || !service) {
      setPreviewCompilation(null);
      setVegaCompilation(null);
      setCompileServiceError("");
      return;
    }
    const controller = new AbortController();
    setCompileServiceError("");
    void Promise.all([
      service.compilePreviewStory({
        project,
        sceneId: selectedScene,
        signal: controller.signal,
      }),
      service.compileProject({
        project,
        options: {
          ...(previewConfiguration.config
            ? {
                projectId:
                  previewConfiguration.config.identity.projectId,
              }
            : {}),
        },
        signal: controller.signal,
      }),
    ])
      .then(([preview, compiled]) => {
        if (controller.signal.aborted) return;
        setPreviewCompilation(preview);
        setVegaCompilation(compiled);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPreviewCompilation(null);
        setVegaCompilation(null);
        setCompileServiceError(
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => controller.abort();
  }, [
    authoringPlugins,
    previewConfiguration.config,
    project,
    selectedScene,
  ]);
  const previewStory = useMemo(
    () => {
      if (!previewCompilation) return null;
      if (!folderWorkspace) return previewCompilation.story;
      if (!assetUrlsReady) return null;
      return hydrateStudioPreviewAssetUrls(
        previewCompilation.story,
        folderWorkspace,
        assetUrls,
      );
    },
    [
      assetUrls,
      assetUrlsReady,
      folderWorkspace,
      previewCompilation,
    ],
  );
  const importErrors: StoryDiagnostic[] = [...workspace.errors].map(([sceneId, message]) => ({
    severity: "error",
    code: "studio.source.import",
    path: `$.sources[${JSON.stringify(sceneId)}]`,
    message,
  }));
  const pluginValidationAvailable =
    authoringPlugins.loaded.host.contributions("validator").length > 0;
  const diagnostics = project
    ? [
        ...workspace.diagnostics,
        ...importErrors,
        ...(pluginValidationAvailable
          ? authoringDiagnostics
          : [
              ...(projectValidation?.errors ?? []),
              ...(projectValidation?.warnings ?? []),
            ]),
        ...(flowGraph?.diagnostics ?? []),
        ...(previewCompilation?.diagnostics ?? []),
        ...(vegaCompilation?.diagnostics ?? []),
        ...(compileServiceError
          ? [
              {
                severity: "error" as const,
                code: "studio.authoring.preview-compiler",
                path: "$.plugins",
                message: compileServiceError,
              },
            ]
          : []),
        ...authoringPluginPlan.diagnostics,
        ...(previewPluginPlan?.diagnostics ?? []),
      ]
    : importErrors;
  const commandIndex =
    project && previewCompilation
      ? commandIndexForSourceLine(
          project,
          selectedScene,
          previewCompilation.commandSourceIndexes,
          cursorLine,
          previewCompilation.commandIndexes,
        )
      : 0;
  const selectedCommandMapping = previewCompilation?.commandMappings.find(
    (mapping) => mapping.commandIndex === commandIndex,
  );
  const selectedSourceCommandIndex =
    selectedCommandMapping?.sourceCommandIndex ?? 0;
  const previewStoryObject = object(previewStory);
  const previewCommands = Array.isArray(previewStoryObject?.commands)
    ? previewStoryObject.commands.flatMap((value) => {
        const command = object(value);
        return command ? [command] : [];
      })
    : [];
  const command = previewCommands[commandIndex];
  const previewStoryJson = previewStory ? JSON.stringify(previewStory) : "";
  const previewStoryKey = previewStory ? `${selectedScene}:${previewStoryJson}` : "";
  const previewSceneRevision = revisionForText(previewStoryKey);
  const selectedSceneValue = project?.scenes.find(({ id }) => id === selectedScene);
  const visualCommands = selectedSceneValue?.commands ?? [];
  const visualCommandSchemas = useMemo(
    () => authoringPlugins.loaded.host.contributions("command"),
    [authoringPlugins],
  );
  const visualAssetReferences = useMemo(
    () =>
      sourceAuthoring?.workspaceAssetReferences(
        folderWorkspace?.files ?? [],
      ) ?? [],
    [folderWorkspace, sourceAuthoring],
  );
  const visualResources = useMemo(
    () =>
      visualResourceCandidates(
        folderWorkspace?.files ?? [],
        visualAssetReferences,
      ),
    [folderWorkspace, visualAssetReferences],
  );
  const advService = authoringPlugins.loaded.host.service(
    studioAdvServiceKey,
  );
  const currentBreakpoint = breakpoints.find(
    (item) => item.sceneId === selectedScene && item.line === cursorLine,
  );
  projectRef.current = project;
  previewCompilationRef.current = previewCompilation;
  runtimeLineMapRef.current = new Map(
    previewCompilation?.commandMappings.map((mapping) => {
      const scene = project?.scenes.find(({ id }) => id === mapping.sceneId);
      const line =
        scene?.commands[mapping.sourceCommandIndex]?.source?.line ??
        mapping.sourceCommandIndex + 1;
      return [mapping.commandIndex, { sceneId: mapping.sceneId, line }];
    }) ?? [],
  );

  useEffect(() => {
    if (
      selectedVisualCommandId &&
      visualCommands.some(({ id }) => id === selectedVisualCommandId)
    ) {
      return;
    }
    setSelectedVisualCommandId(
      visualCommands[selectedSourceCommandIndex]?.id ??
        visualCommands[0]?.id ??
        "",
    );
  }, [
    selectedSourceCommandIndex,
    selectedVisualCommandId,
    visualCommands,
  ]);

  const attachRuntimeListener = useCallback(
    (message: string): void => {
      removeRuntimeListenerRef.current?.();
      removeRuntimeListenerRef.current = bridgeRef.current.onEvent((event) => {
        if (event.event === "runtime.state") {
          setRuntimeSnapshot(event.snapshot);
          const execution = object(object(event.snapshot)?.execution);
          if (execution?.finished === true) setExecutionState("finished");
          else if (execution?.paused === true) setExecutionState("paused");
          else if (execution?.playing === true) setExecutionState("running");
          else setExecutionState("ready");
        } else if (event.event === "runtime.diagnostic") {
          pushLog(event.level, `${event.code}: ${event.message}`, "runtime");
        } else if (event.event === "runtime.stopped") {
          setExecutionState(event.reason === "end" ? "finished" : "paused");
          const position = runtimeLineMapRef.current.get(event.commandIndex);
          if (position) {
            setOpenSceneIds((sceneIds) =>
              sceneIds.includes(position.sceneId)
                ? sceneIds
                : [...sceneIds, position.sceneId],
            );
            setSelectedScene(position.sceneId);
            setCursorLines((lines) => ({
              ...lines,
              [position.sceneId]: position.line,
            }));
          }
          const runtimeScene = position?.sceneId ?? event.sceneId;
          pushLog(
            "info",
            `Runtime stopped at ${runtimeScene} command ${event.commandIndex + 1} (${event.reason}).`,
            "runtime",
          );
        }
      });
      setPreviewStatus("connected");
      setExecutionState("ready");
      pushLog("info", message, "studio");
    },
    [pushLog],
  );

  useEffect(
    () => () => {
      removeRuntimeListenerRef.current?.();
      bridgeRef.current.close();
      brokeredPluginLoadRef.current?.abort(
        new DOMException("Studio disposed", "AbortError"),
      );
    },
    [],
  );

  const builtinIdentity = useMemo(
    () => ({
      workspaceId: "altair-studio",
      projectId: vegaCompilation?.project.id ?? "studio-project",
      editorSessionId: "browser-studio",
      runtimeInstanceId: `studio-runtime-${runtimeRevision}-${
        previewPluginPlan?.key ?? "no-project"
      }`,
    }),
    [previewPluginPlan?.key, runtimeRevision, vegaCompilation?.project.id],
  );

  useEffect(() => {
    if (previewConfiguration.config) return;
    const mount = runtimeMountRef.current;
    if (!mount || !previewPluginPlan) return;
    const host = authoringPlugins.loaded.host;
    const service = host.service(studioVegaPreviewServiceKey);
    if (!service) {
      setPreviewStatus("error");
      setPreviewError(
        "Enable the Vega preview authoring extension.",
      );
      return;
    }
    let cancelled = false;
    let session:
      | Awaited<ReturnType<typeof host.createPreview>>
      | undefined;
    let mountRegistration: { dispose(): void } | undefined;
    let profileRegistration: { dispose(): void } | undefined;
    const controller = new AbortController();
    const mountId = `studio-mount-${runtimeRevision}`;
    const profileId = `studio-profile-${runtimeRevision}-${
      previewPluginPlan.key
    }`;
    setPreviewStatus("connecting");
    setPreviewError("");
    setRuntimeSnapshot(null);
    setRuntimeSnapshotError("");
    loadedStoryRef.current = "";
    removeRuntimeListenerRef.current?.();
    bridgeRef.current.close();

    const previousDisposal = builtinPreviewDisposalTailRef.current;
    const setupTask = (async () => {
      try {
        await previousDisposal.catch(() => undefined);
        if (cancelled || controller.signal.aborted) return;
        const loadedPlugins = await loadStudioPreviewPlugins(
          previewPluginPlan,
          "bundled",
          builtinIdentity,
          previewPluginHost,
          controller.signal,
        );
        if (cancelled) return;
        mountRegistration = service.registerMount(mountId, mount);
        profileRegistration = service.registerRuntimeProfile(
          profileId,
          {
            officialPlugins: loadedPlugins.officialPlugins,
            plugins: loadedPlugins.plugins,
            ...(previewPluginPlan.theme === undefined
              ? {}
              : { theme: previewPluginPlan.theme }),
          },
        );
        session = await host.createPreview("vega", {
          identity: builtinIdentity,
          options: {
            mountId,
            runtimeProfileId: profileId,
            autoSync: false,
          },
          signal: controller.signal,
        });
        if (cancelled) {
          await session.dispose();
          return;
        }
        bridgeRef.current.connectSession(session);
        if (cancelled) return;
        attachRuntimeListener(
          "Connected through the Vega preview extension.",
        );
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setPreviewStatus("error");
        setPreviewError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort(new DOMException("Preview superseded", "AbortError"));
      removeRuntimeListenerRef.current?.();
      removeRuntimeListenerRef.current = undefined;
      bridgeRef.current.close();
      builtinPreviewDisposalTailRef.current = previousDisposal
        .catch(() => undefined)
        .then(() => setupTask)
        .catch(() => undefined)
        .then(async () => {
          await Promise.resolve(session?.dispose()).catch(() => undefined);
          profileRegistration?.dispose();
          mountRegistration?.dispose();
        });
    };
  }, [
    attachRuntimeListener,
    authoringPlugins,
    builtinIdentity,
    previewConfiguration.config,
    previewPluginHost,
    previewPluginPlan?.key,
    runtimeRevision,
  ]);

  useEffect(() => {
    if (
      !live ||
      previewPluginBlocked ||
      previewStatus !== "connected" ||
      !previewCompilation ||
      !previewStory ||
      !previewStoryKey
    ) {
      return;
    }
    const controller = new AbortController();
    const update = async () => {
      try {
        if (loadedStoryRef.current !== previewStoryKey) {
          const synced = await bridgeRef.current.syncScene(
            selectedScene,
            previewSceneRevision,
            previewStory,
            commandIndex,
            controller.signal,
          );
          if (!synced) return;
          loadedStoryRef.current = previewStoryKey;
        } else {
          await bridgeRef.current.seek(commandIndex, controller.signal);
        }
        await bridgeRef.current.setBreakpoints(
          runtimeBreakpoints(project, previewCompilation, breakpoints),
          controller.signal,
        );
        setPreviewError("");
        try {
          const snapshot = await bridgeRef.current.stageSnapshot(controller.signal);
          if (snapshot !== undefined) setRuntimeSnapshot(snapshot);
          setRuntimeSnapshotError("");
        } catch (error) {
          if (!controller.signal.aborted) {
            setRuntimeSnapshotError(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreviewStatus("error");
        setPreviewError(error instanceof Error ? error.message : String(error));
      }
    };
    void update();
    return () => controller.abort();
  }, [
    commandIndex,
    breakpoints,
    live,
    previewPluginBlocked,
    previewCompilation,
    previewSceneRevision,
    previewStatus,
    previewStory,
    previewStoryKey,
    project,
    selectedScene,
  ]);

  const connectRuntime = async () => {
    const config = previewConfiguration.config;
    const target = iframeRef.current?.contentWindow;
    if (!config || !target || !previewPluginPlan) return;
    brokeredPluginLoadRef.current?.abort(
      new DOMException("Preview connection superseded", "AbortError"),
    );
    const controller = new AbortController();
    brokeredPluginLoadRef.current = controller;
    setPreviewStatus("connecting");
    setPreviewError("");
    setRuntimeSnapshot(null);
    setRuntimeSnapshotError("");
    loadedStoryRef.current = "";
    removeRuntimeListenerRef.current?.();
    try {
      await loadStudioPreviewPlugins(
        previewPluginPlan,
        "brokered",
        config.identity,
        previewPluginHost,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      await bridgeRef.current.connect(target, config);
      if (controller.signal.aborted) {
        bridgeRef.current.close();
        return;
      }
      attachRuntimeListener("Connected to the authenticated Vega preview runtime.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setPreviewStatus("error");
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      if (brokeredPluginLoadRef.current === controller) {
        brokeredPluginLoadRef.current = undefined;
      }
    }
  };

  const importProse = async (): Promise<void> => {
    const prose = window.prompt("Paste a novel or fan-fiction excerpt");
    if (!prose) return;
    const host = authoringPluginsRef.current.loaded.host;
    const source = host.service(studioWebGalServiceKey);
    if (
      !host.contributions("ai").some(({ id }) => id === "altair.deterministic") ||
      !source
    ) {
      pushLog(
        "error",
        "Enable the prose and source authoring extensions to adapt prose.",
        "studio",
      );
      return;
    }
    try {
      const draft = await host.runAi("altair.deterministic", {
        source: prose,
        title: "Adapted draft",
      });
      const exported = await source.exportSourceDocuments(
        host,
        draft.project,
        {
          entryPath: `adapted/main${source.profile.sceneExtensions[0]}`,
        },
      );
      const adapted = exported.documents[0];
      if (!adapted) {
        throw new Error(
          `${source.profile.displayName} produced no source document.`,
        );
      }
      canonicalProjectRef.current = null;
      setCanonicalProject(null);
      canonicalExportRevisionRef.current += 1;
      if (canonicalExportTimerRef.current !== undefined) {
        window.clearTimeout(canonicalExportTimerRef.current);
        canonicalExportTimerRef.current = undefined;
      }
      const nextDocuments = appendUniqueStudioDocuments(
        documentsRef.current,
        [adapted],
      );
      documentsRef.current = nextDocuments;
      setDocuments(nextDocuments);
      openScene(adapted.id);
      pushLog(
        "info",
        "Created a deterministic prose adaptation source.",
        "studio",
      );
    } catch (error) {
      pushLog(
        "error",
        error instanceof Error ? error.message : String(error),
        "studio",
      );
    }
  };

  const exportProject = () => {
    if (!vegaCompilation) return;
    downloadJson(
      vegaCompilation.project,
      `${project?.meta.title || "story"}.vega.json`,
    );
  };

  const refreshRuntime = () => {
    brokeredPluginLoadRef.current?.abort(
      new DOMException("Preview refreshed", "AbortError"),
    );
    brokeredPluginLoadRef.current = undefined;
    removeRuntimeListenerRef.current?.();
    removeRuntimeListenerRef.current = undefined;
    bridgeRef.current.close();
    loadedStoryRef.current = "";
    setRuntimeSnapshot(null);
    setRuntimeSnapshotError("");
    setExecutionState("ready");
    setPreviewStatus("connecting");
    setRuntimeRevision((revision) => revision + 1);
  };

  const refreshSnapshot = async () => {
    if (previewStatus !== "connected") return;
    setRuntimeBusy(true);
    setRuntimeSnapshotError("");
    try {
      const snapshot = await bridgeRef.current.stageSnapshot();
      const variables = await bridgeRef.current.variables();
      if (snapshot !== undefined) {
        const snapshotObject = object(snapshot);
        setRuntimeSnapshot(
          snapshotObject && variables !== undefined
            ? { ...snapshotObject, variables }
            : snapshot,
        );
      }
    } catch (error) {
      setRuntimeSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const runtimeAction = async (
    label: string,
    action: (bridge: StudioPreviewBridge) => Promise<void>,
  ): Promise<void> => {
    if (previewStatus !== "connected") return;
    setRuntimeBusy(true);
    try {
      await action(bridgeRef.current);
      pushLog("info", label, "studio");
      await refreshSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeSnapshotError(message);
      pushLog("error", message, "studio");
    } finally {
      setRuntimeBusy(false);
    }
  };

  const runScene = () =>
    runtimeAction("Ran the active scene from its first command.", async (bridge) => {
      if (!previewCompilation || !previewStory) return;
      if (loadedStoryRef.current !== previewStoryKey) {
        const synced = await bridge.syncScene(
          selectedScene,
          previewSceneRevision,
          previewStory,
          0,
        );
        if (!synced) return;
        loadedStoryRef.current = previewStoryKey;
      }
      await bridge.runScene(0);
      setExecutionState("running");
    });

  const runFromCursor = (fromIndex = commandIndex) =>
    runtimeAction(`Ran from command ${fromIndex + 1}.`, async (bridge) => {
      if (!previewCompilation || !previewStory) return;
      if (loadedStoryRef.current !== previewStoryKey) {
        const synced = await bridge.syncScene(
          selectedScene,
          previewSceneRevision,
          previewStory,
          fromIndex,
        );
        if (!synced) return;
        loadedStoryRef.current = previewStoryKey;
      }
      await bridge.runFrom(fromIndex);
      setExecutionState("running");
    });

  const runCurrentSnippet = () =>
    runtimeAction(`Executed command ${commandIndex + 1} as a preview snippet.`, async (bridge) => {
      const snippet = previewCommands[commandIndex];
      if (!snippet) return;
      await bridge.runSnippet([snippet], `${selectedScene}:${commandIndex}`);
    });

  const pauseRuntime = () =>
    runtimeAction("Paused runtime execution.", async (bridge) => {
      await bridge.pause();
      setExecutionState("paused");
    });

  const continueRuntime = () =>
    runtimeAction("Continued runtime execution.", async (bridge) => {
      await bridge.continue();
      setExecutionState("running");
    });

  const stepRuntime = () =>
    runtimeAction("Advanced one deterministic command.", async (bridge) => {
      await bridge.step();
      setExecutionState("paused");
    });

  const toggleCurrentBreakpoint = (): void => {
    const breakpoint: DebugBreakpoint = {
      sceneId: selectedScene,
      sceneName: selectedSceneValue?.name ?? selectedScene,
      line: cursorLine,
      commandIndex,
    };
    setBreakpoints((items) =>
      items.some(
        (item) =>
          item.sceneId === breakpoint.sceneId &&
          item.line === breakpoint.line,
      )
        ? items.filter(
            (item) =>
              item.sceneId !== breakpoint.sceneId ||
              item.line !== breakpoint.line,
          )
        : [...items, breakpoint],
    );
  };

  const removeBreakpoint = (breakpoint: DebugBreakpoint): void => {
    setBreakpoints((items) =>
      items.filter(
        (item) =>
          item.sceneId !== breakpoint.sceneId ||
          item.line !== breakpoint.line,
      ),
    );
  };

  const inspectStage = async (target: string): Promise<void> => {
    setStageInspection((value) => ({ ...value, target, busy: true, error: "" }));
    try {
      const referenceFrame = await bridgeRef.current.referenceFrame(target);
      const transformResult = await bridgeRef.current.stageTransform(target);
      const transformObject = object(transformResult);
      const transform = transformObject?.transform ?? null;
      const status = transformObject?.status;
      const reason = transformObject?.reason;
      setStageInspection({
        target,
        referenceFrame: referenceFrame ?? null,
        transform,
        busy: false,
        error:
          status && status !== "ready"
            ? typeof reason === "string"
              ? reason
              : `Stage target ${target} is ${status}`
            : "",
      });
    } catch (error) {
      setStageInspection((value) => ({
        ...value,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const setStageTransform = async (
    target: string,
    transform: JsonObject,
    commit: boolean,
  ): Promise<void> => {
    setStageInspection((value) => ({ ...value, target, transform, busy: true, error: "" }));
    try {
      const result = await bridgeRef.current.setStageTransform(target, transform, commit);
      const resultObject = object(result);
      setStageInspection((value) => ({
        ...value,
        transform: resultObject?.transform ?? value.transform,
        busy: false,
        error:
          resultObject?.status && resultObject.status !== "ready"
            ? String(resultObject.reason ?? `Stage target ${target} is ${resultObject.status}`)
            : "",
      }));
      pushLog("info", `${commit ? "Committed" : "Previewed"} transform for ${target}.`, "studio");
    } catch (error) {
      setStageInspection((value) => ({
        ...value,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const selectFlowNode = (node: StoryFlowNode) => {
    setSelectedFlowNodeId(node.id);
    if (node.sceneId && project?.scenes.some(({ id }) => id === node.sceneId)) {
      openScene(node.sceneId);
    }
    if (node.sourceLine !== undefined) {
      setCursorLines((lines) => ({
        ...lines,
        [node.sceneId ?? selectedScene]: node.sourceLine!,
      }));
    }
  };

  return (
    <main
      className={debugOpen ? "studio-shell debug-open" : "studio-shell"}
      style={
        {
          "--debug-dock-height": debugOpen
            ? `${debugDockHeight}px`
            : "0px",
        } as CSSProperties
      }
    >
      <a className="skip-link" href="#authoring-heading">
        Skip to story authoring
      </a>
      <header className="topbar">
        <div className="brand">
          <img
            alt=""
            aria-hidden="true"
            className="brand-mark"
            src="/favicon.svg"
          />
          <strong>Altair</strong>
        </div>
        <div className="titlebar-title" title={activeDocument.path}>
          {activeDocument.path}
        </div>
        <nav aria-label="Project actions">
          <label
            className="theme-switcher"
            title={t("colorTheme")}
          >
            <span className="sr-only">{t("colorTheme")}</span>
            <StudioIcon name="palette" />
            <select
              aria-label={t("colorTheme")}
              onChange={(event) =>
                setThemePreference(event.target.value as StudioThemePreference)
              }
              value={themePreference}
            >
              <option value="light">{t("light")}</option>
              <option value="system">{t("system")}</option>
              <option value="dark">{t("dark")}</option>
            </select>
          </label>
          <button
            aria-label={t("openProject")}
            disabled={workspaceBusy}
            onClick={() => void openProjectFolder()}
            title={t("openProject")}
          >
            <StudioIcon name="folder-open" />
          </button>
          <button
            aria-label={t("undo")}
            className="icon-button"
            disabled={!activeHistory?.canUndo}
            onClick={() => restoreDocumentHistory("undo")}
            title={t("undo")}
          >
            <StudioIcon name="undo" />
          </button>
          <button
            aria-label={t("redo")}
            className="icon-button"
            disabled={!activeHistory?.canRedo}
            onClick={() => restoreDocumentHistory("redo")}
            title={t("redo")}
          >
            <StudioIcon name="redo" />
          </button>
          <button
            aria-label={t("save")}
            className="icon-button"
            disabled={
              workspaceBusy ||
              !dirtyDocumentIds.length
            }
            onClick={() => void saveDocuments()}
            title={t("save")}
          >
            <StudioIcon name="save" />
          </button>
          <button
            aria-expanded={languageSettingsOpen}
            aria-label={t("languages")}
            className="icon-button"
            disabled={!project}
            onClick={() => setLanguageSettingsOpen(true)}
            title={t("languages")}
          >
            <StudioIcon name="languages" />
          </button>
          <button
            aria-label={t("importScenes")}
            className="icon-button"
            disabled={workspaceBusy}
            onClick={() => void openSceneFiles()}
            title={t("importScenes")}
          >
            <StudioIcon name="file-add" />
          </button>
          <button
            aria-label={t("adaptProse")}
            className="icon-button"
            onClick={() => void importProse()}
            title={t("adaptProse")}
          >
            <StudioIcon name="sparkles" />
          </button>
          <button
            aria-expanded={debugOpen}
            aria-label={debugOpen ? t("closeDebugger") : t("openDebugger")}
            className="icon-button"
            onClick={() => setDebugOpen((open) => !open)}
            title={debugOpen ? t("closeDebugger") : t("openDebugger")}
          >
            <StudioIcon name={debugOpen ? "panel-close" : "panel-open"} />
          </button>
          <button
            aria-label={t("exportProject")}
            className="icon-button"
            disabled={!vegaCompilation}
            onClick={exportProject}
            title={t("exportProject")}
          >
            <StudioIcon name="download" />
          </button>
        </nav>
      </header>

      <ResourceExplorer
        assetUrls={assetUrls}
        busy={workspaceBusy}
        documents={documents}
        files={folderWorkspace?.files ?? []}
        marketplace={authoringPlugins.loaded.host.service(
          studioMarketplaceServiceKey,
        )}
        onImport={() => void openProjectFolder()}
        onOpenScene={openScene}
        onPluginCatalogAdd={addRemotePluginCatalog}
        onPluginsChange={updateProjectPlugins}
        onRefresh={() => void refreshProjectFolder()}
        project={project}
        pluginCatalog={pluginCatalog}
        selectedSceneId={selectedScene}
      />

      <section aria-labelledby="authoring-heading" className="authoring">
        <h1 className="sr-only" id="authoring-heading" tabIndex={-1}>Story authoring</h1>
        <div className="editor-tabs-bar">
          <SceneTabs
            documents={documents}
            onClose={closeScene}
            onOpen={openScene}
            openSceneIds={openSceneIds}
            project={project}
            selectedSceneId={selectedScene}
          />
          <div className="panel-tabs">
            <div aria-label="Authoring view" className="authoring-modes" role="group">
              <button
                aria-label={t("visual")}
                aria-pressed={mode === "visual"}
                className={mode === "visual" ? "selected" : ""}
                onClick={() => setMode("visual")}
                title={t("visual")}
              >
                <StudioIcon name="panels" />
                <span>{t("visual")}</span>
              </button>
              <button
                aria-label={t("flow")}
                aria-pressed={mode === "flow"}
                className={mode === "flow" ? "selected" : ""}
                onClick={() => setMode("flow")}
                title={t("flow")}
              >
                <StudioIcon name="workflow" />
                <span>{t("flow")}</span>
              </button>
              <button
                aria-label={t("webgalSourceEditor")}
                aria-pressed={mode === "source"}
                className={mode === "source" ? "selected" : ""}
                onClick={() => setMode("source")}
                title={t("webgalSourceEditor")}
              >
                <StudioIcon name="code" />
                <span>{t("webgal")}</span>
              </button>
            </div>
            {mode === "visual" && (
              <button
                aria-label={t("insertCommand")}
                disabled={!project}
                onClick={() => setCommandInsertIndex(visualCommands.length)}
                title={t("insertCommand")}
              >
                <StudioIcon name="insert" />
              </button>
            )}
            <button
              aria-label={
                live ? t("disableLivePreview") : t("enableLivePreview")
              }
              aria-pressed={live}
              className={live ? "live-enabled" : ""}
              onClick={() => setLive((enabled) => !enabled)}
              title={
                live ? t("disableLivePreview") : t("enableLivePreview")
              }
            >
              <StudioIcon name="radio" />
            </button>
            <button
              aria-label={t("setBreakpoint")}
              aria-pressed={Boolean(currentBreakpoint)}
              className={currentBreakpoint ? "breakpoint-set" : ""}
              onClick={toggleCurrentBreakpoint}
              title={t("setBreakpoint")}
            >
              <StudioIcon name="breakpoint" />
            </button>
            <button
              aria-label={t("runCursor")}
              disabled={previewStatus !== "connected" || runtimeBusy}
              onClick={() => void runFromCursor()}
              title={t("runCursor")}
            >
              <StudioIcon name="play" />
            </button>
          </div>
        </div>
        <div className="authoring-content">
          {mode === "source" ? (
            <Suspense
              fallback={
                <div className="tree-empty">Loading WebGAL editor…</div>
              }
            >
              <Editor
              beforeMount={(monaco) => {
                monaco.editor.defineTheme("altair-dark", {
                  base: "vs-dark",
                  inherit: true,
                  rules: [
                    { token: "comment", foreground: "737373" },
                    { token: "string", foreground: "93c5fd" },
                  ],
                  colors: {
                    "editor.background": "#0f0f0f",
                    "editorLineNumber.foreground": "#525252",
                    "editorCursor.foreground": "#3b82f6",
                    "editor.selectionBackground": "#1e3a5f",
                  },
                });
                monaco.editor.defineTheme("altair-light", {
                  base: "vs",
                  inherit: true,
                  rules: [
                    { token: "comment", foreground: "737373" },
                    { token: "string", foreground: "1d4ed8" },
                  ],
                  colors: {
                    "editor.background": "#ffffff",
                    "editorLineNumber.foreground": "#a3a3a3",
                    "editorCursor.foreground": "#2563eb",
                    "editor.selectionBackground": "#dbeafe",
                  },
                });
              }}
              height="100%"
              language="plaintext"
              onChange={(value) => updateDocumentText(activeDocument.id, value ?? "")}
              onMount={(editor) => {
                editor.setPosition({ column: 1, lineNumber: cursorLine });
                editor.revealLineInCenterIfOutsideViewport(cursorLine);
                return editor.onDidChangeCursorPosition(({ position }) =>
                  setCursorLine(position.lineNumber),
                );
              }}
              options={{
                accessibilitySupport: "on",
                ariaLabel:
                  sourceAuthoring?.sourceEditorLabel(
                    activeDocument.path,
                  ) ?? `${activeDocument.path} WebGAL source editor`,
                fontSize: 13,
                glyphMargin: true,
                minimap: { enabled: false },
                padding: { top: 14 },
                wordWrap: "on",
              }}
              path={activeDocument.path}
              theme={resolvedTheme === "dark" ? "altair-dark" : "altair-light"}
              value={source}
            />
            </Suspense>
          ) : mode === "visual" ? (
            <div className="cards">
              {!projectLocalization.defaultLocale ? (
                <section className="project-language-required">
                  <StudioIcon name="languages" />
                  <div>
                    <strong>{t("chooseProjectLanguage")}</strong>
                    <p>{t("chooseProjectLanguageHint")}</p>
                  </div>
                  <button onClick={() => setLanguageSettingsOpen(true)}>
                    {t("setProjectLanguages")}
                  </button>
                </section>
              ) : (
                <>
                  {visualCommands.map((item, index) => {
                    const line = item.source?.line ?? index + 1;
                    const visualCommandIndex =
                      previewCompilation?.commandMappings.find(
                        (mapping) =>
                          mapping.sceneId === selectedScene &&
                          mapping.sourceCommandIndex === index,
                      )?.commandIndex ?? 0;
                    const schema = commandSchemaFor(
                      item,
                      visualCommandSchemas,
                    );
                    return (
                      <VisualSentenceCard
                        active={item.id === selectedVisualCommandId}
                        advService={advService}
                        canRun={
                          previewStatus === "connected" && !runtimeBusy
                        }
                        command={item}
                        index={index}
                        key={item.id}
                        locale={projectLocalization.defaultLocale ?? ""}
                        locales={visualLocales}
                        onChange={(nextCommand) =>
                          updateCanonicalProject((current) =>
                            replaceProjectCommand(
                              current,
                              selectedScene,
                              item.id,
                              nextCommand,
                            ),
                          )
                        }
                        onDropAt={(sourceIndex, targetIndex) => {
                          if (
                            sourceIndex < 0 ||
                            sourceIndex >= visualCommands.length
                          ) {
                            return;
                          }
                          const targetLine =
                            visualCommands[targetIndex]?.source?.line ??
                            targetIndex + 1;
                          updateCanonicalProject((current) =>
                            moveProjectCommand(
                              current,
                              selectedScene,
                              sourceIndex,
                              targetIndex,
                            ),
                          );
                          setCursorLine(targetLine);
                        }}
                        onInsertBefore={() => setCommandInsertIndex(index)}
                        onRemove={() => {
                          updateCanonicalProject((current) =>
                            removeProjectCommand(
                              current,
                              selectedScene,
                              item.id,
                            ),
                          );
                          const nextSelection =
                            visualCommands[index + 1] ??
                            visualCommands[index - 1];
                          setSelectedVisualCommandId(
                            nextSelection?.id ?? "",
                          );
                        }}
                        onRun={() => {
                          setSelectedVisualCommandId(item.id);
                          setCursorLine(line);
                          void runFromCursor(visualCommandIndex);
                        }}
                        onSelect={() => {
                          setSelectedVisualCommandId(item.id);
                          setCursorLine(line);
                        }}
                        resourceCandidates={visualResources}
                        schema={schema}
                      />
                    );
                  })}
                  <button
                    className="command-insert-end"
                    disabled={!project}
                    onClick={() => setCommandInsertIndex(visualCommands.length)}
                  >
                    <StudioIcon name="insert" />
                    <span>{t("insertCommand")}</span>
                  </button>
                </>
              )}
            </div>
          ) : flowGraph ? (
            <FlowView
              graph={flowGraph}
              onSelectNode={selectFlowNode}
              onSelectScene={openScene}
              selectedNodeId={selectedFlowNodeId}
              selectedSceneId={selectedScene}
            />
          ) : (
            <div className="authoring-empty" role="status">
              {authoringPlugins.loaded.host.contributions("flow").length
                ? "Fix project validation errors to build the control-flow graph."
                : "Enable a flow extension to inspect the control-flow graph."}
            </div>
          )}
        </div>
      </section>

      <StudioPreviewPanel
        configuration={previewConfiguration.config}
        cursorLine={cursorLine}
        diagnostics={diagnostics}
        iframeRef={iframeRef}
        onConnect={() => void connectRuntime()}
        onCursorLine={setCursorLine}
        onPause={() => void pauseRuntime()}
        onRefreshRuntime={refreshRuntime}
        onRunCursor={() => void runFromCursor()}
        onRunScene={() => void runScene()}
        onRunSnippet={() => void runCurrentSnippet()}
        onStep={() => void stepRuntime()}
        pluginLockKey={previewPluginPlan?.key ?? "no-project"}
        previewError={previewError}
        runtimeMountRef={runtimeMountRef}
        runtimeBusy={runtimeBusy}
        runtimeRevision={runtimeRevision}
        sceneName={selectedSceneValue?.name ?? selectedScene}
        sourceLineCount={sourceLineCount}
        status={previewStatus}
      />

      {debugOpen ? (
        <DebugDock
          height={debugDockHeight}
          onHeightChange={setDebugDockHeight}
          viewportHeight={debugViewportHeight}
        >
          <DebugPanel
            breakpoints={breakpoints}
            busy={runtimeBusy}
            connected={previewStatus === "connected"}
            error={runtimeSnapshotError}
            executionState={executionState}
            logs={runtimeLogs}
            onClearLogs={() => setRuntimeLogs([])}
            onContinue={() => void continueRuntime()}
            onInspectStage={(target) => void inspectStage(target)}
            onPause={() => void pauseRuntime()}
            onRefresh={() => void refreshSnapshot()}
            onRemoveBreakpoint={removeBreakpoint}
            onSetTransform={(target, transform, commit) =>
              void setStageTransform(target, transform, commit)
            }
            onStep={() => void stepRuntime()}
            snapshot={runtimeSnapshot}
            stage={stageInspection}
          />
        </DebugDock>
      ) : null}
      {commandInsertIndex !== null ? (
        <CommandInsertDialog
          beforeLabel={
            commandInsertIndex < visualCommands.length
              ? `Before ${
                  commandSchemaFor(
                    visualCommands[commandInsertIndex]!,
                    visualCommandSchemas,
                  )?.name ??
                  visualCommands[commandInsertIndex]?.source?.command ??
                  "selected command"
                }`
              : "At the end of the scene"
          }
          onCancel={() => setCommandInsertIndex(null)}
          onSelect={(schema) =>
            void insertVisualCommand(schema, commandInsertIndex)
          }
          schemas={visualCommandSchemas}
        />
      ) : null}
      {languageSettingsOpen ? (
        <div
          className="language-settings-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              setLanguageSettingsOpen(false);
            }
          }}
        >
          <LanguageSettingsPanel
            disabled={!project}
            onChange={(settings) =>
              updateCanonicalProject((current) =>
                writeProjectLocalization(current, settings),
              )
            }
            onClose={() => setLanguageSettingsOpen(false)}
            settings={projectLocalization}
          />
        </div>
      ) : null}
    </main>
  );
}

function downloadJson(value: unknown, filename: string) {
  const safeFilename = filename.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-");
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.download = safeFilename;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

const studioRoot = window.__ALTAIR_STUDIO_ROOT__ ?? createRoot(document.getElementById("root")!);
window.__ALTAIR_STUDIO_ROOT__ = studioRoot;

const bootstrapStudio = async (): Promise<void> => {
  const broker = studioAuthoringPluginBroker();
  const plan = createStudioAuthoringPluginPlan(
    DEFAULT_STUDIO_PROJECT_PLUGINS,
    STUDIO_PLUGIN_CATALOG,
    STUDIO_PLUGIN_ENVIRONMENT,
    broker !== undefined,
  );
  const loaded = await loadStudioAuthoringPlugins(
    plan,
    broker,
    new AbortController().signal,
  );
  studioRoot.render(
    <StudioI18nProvider>
      <Studio
        initialAuthoringPluginKey={plan.key}
        initialAuthoringPlugins={loaded}
      />
    </StudioI18nProvider>,
  );
};

void bootstrapStudio().catch((error) => {
  studioRoot.render(
    <main className="studio-bootstrap-error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </main>,
  );
});
