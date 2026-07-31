import { satisfies, valid, validRange } from "semver";
import type {
  AltairAdaptationRequest,
  AltairAdaptationResult,
  AltairAiProvider,
} from "./ai-protocol.js";
import type { StoryDiagnostic } from "./diagnostics.js";
import {
  assertStoryProjectProtocol,
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
} from "./model.js";
import {
  type AltairAssetProviderContribution,
  type AltairAssetRequest,
  type AltairCommandSchemaContribution,
  type AltairCompilerPassRequest,
  type AltairCompilerPipelineResult,
  type AltairContribution,
  type AltairContributionMap,
  type AltairContributionOptions,
  type AltairContributionSelection,
  type AltairDisposable,
  type AltairEditorActionRequest,
  type AltairFlowProviderContribution,
  type AltairFormatArtifact,
  type AltairFormatContribution,
  type AltairFormatExportRequest,
  type AltairFormatExportResult,
  type AltairFormatImportResult,
  type AltairFormatRequest,
  type AltairFormatSniffResult,
  type AltairFlowGraph,
  type AltairOperationContext,
  type AltairPanelContribution,
  type AltairPreviewProviderContribution,
  type AltairPreviewRequest,
  type AltairPreviewSession,
  type AltairResolvedAsset,
  type AltairServiceKey,
  type AltairValidatorContribution,
} from "./plugin-contributions.js";
import type {
  ResourceBrowserDirectory,
  ResourceBrowserProvider,
} from "./resource-browser.js";

export * from "./plugin-contributions.js";

/** Current API for typed contributions. API 1 remains supported. */
export const ALTAIR_PLUGIN_API_VERSION = 2;
export const ALTAIR_SUPPORTED_PLUGIN_API_VERSIONS = Object.freeze([1, 2] as const);

/** API 1 single-file codec retained for source compatibility. */
export interface AltairFormatCodec {
  readonly id: string;
  readonly extensions: readonly string[];
  sniff(input: Uint8Array): number;
  import(input: Uint8Array): Promise<StoryProject> | StoryProject;
  export(project: StoryProject): Promise<Uint8Array> | Uint8Array;
}

/** API 1 diagnostic rule retained for source compatibility. */
export interface AltairDiagnosticRule {
  readonly id: string;
  evaluate(
    project: StoryProject,
  ): readonly StoryDiagnostic[] | Promise<readonly StoryDiagnostic[]>;
}

export type AltairPluginCapability =
  | "format"
  | "ai"
  | "diagnostics"
  | "panel"
  | "assets"
  | "commands"
  | "editor"
  | "compiler"
  | "flow"
  | "preview"
  | "services";

interface AltairPluginManifestBase {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly AltairPluginCapability[];
}

export interface AltairPluginManifestV1 extends AltairPluginManifestBase {
  readonly apiVersion: 1;
}

export interface AltairPluginManifestV2 extends AltairPluginManifestBase {
  readonly apiVersion: 2;
}

export type AltairPluginManifest =
  | AltairPluginManifestV1
  | AltairPluginManifestV2;

/** Context exposed to existing API 1 plugins. */
export interface AltairPluginContext {
  readonly signal: AbortSignal;
  /** Immutable project-local configuration supplied by the host. */
  readonly configuration: Readonly<JsonObject>;
  /** Exact grants reviewed by the host for this activation. */
  readonly permissions: readonly string[];
  hasPermission(permission: string): boolean;
  registerFormat(codec: AltairFormatCodec): () => void;
  registerAiProvider(provider: AltairAiProvider): () => void;
  registerDiagnosticRule(rule: AltairDiagnosticRule): () => void;
}

/** Context exposed to API 2 plugins. Legacy registration helpers still work. */
export interface AltairPluginContextV2 extends AltairPluginContext {
  contribute<K extends keyof AltairContributionMap>(
    kind: K,
    contribution: AltairContributionMap[K],
    options?: AltairContributionOptions,
  ): () => void;
  provide<T>(key: AltairServiceKey<T>, value: T): () => void;
  service<T>(key: AltairServiceKey<T>): T | undefined;
  use<T extends AltairDisposable>(resource: T): T;
  defer(cleanup: () => void | Promise<void>): () => void;
}

export interface AltairPluginActivation {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface AltairPluginInstallOptions {
  readonly configuration?: JsonObject;
  readonly permissions?: readonly string[];
}

export interface AltairPluginV1 {
  readonly manifest: AltairPluginManifestV1;
  setup(
    context: AltairPluginContext,
  ):
    | void
    | (() => void | Promise<void>)
    | Promise<void | (() => void | Promise<void>)>;
}

export interface AltairPluginV2 {
  readonly manifest: AltairPluginManifestV2;
  setup(
    context: AltairPluginContextV2,
  ):
    | void
    | AltairPluginActivation
    | (() => void | Promise<void>)
    | Promise<
        void | AltairPluginActivation | (() => void | Promise<void>)
      >;
}

export type AltairPlugin = AltairPluginV1 | AltairPluginV2;

export function defineAltairPlugin<T extends AltairPluginV1>(plugin: T): T;
export function defineAltairPlugin<T extends AltairPluginV2>(plugin: T): T;
export function defineAltairPlugin<T extends AltairPlugin>(plugin: T): T {
  return plugin;
}

type Cleanup = () => void | Promise<void>;

interface Installed {
  readonly manifest: AltairPluginManifest;
  readonly controller: AbortController;
  readonly cleanups: Cleanup[];
  readonly activation?: AltairPluginActivation;
  readonly installOptions: NormalizedInstallOptions;
}

interface NormalizedInstallOptions {
  readonly configuration: Readonly<JsonObject>;
  readonly permissions: readonly string[];
  readonly permissionSet: ReadonlySet<string>;
}

interface InstallTransaction extends Installed {
  readonly registrations: StagedRegistration[];
  readonly stagedServices: Map<string, unknown>;
  readonly stagedContributionRegistries: Map<
    keyof AltairContributionMap,
    Map<string, RegisteredContribution<AltairContribution>>
  >;
}

interface StagedRegistration {
  commit(): void;
}

interface RegisteredContribution<T extends AltairContribution> {
  readonly owner: string;
  readonly value: T;
  readonly priority: number;
  readonly overrides: readonly string[];
  readonly singletonPort?: string;
}

interface RegisteredService {
  readonly owner: string;
  readonly value: unknown;
}

interface RegisteredLegacy<T> {
  readonly owner: string;
  readonly value: T;
}

export interface AltairPanelMountOptions {
  readonly project?: StoryProject;
  readonly selection?: JsonObject;
  readonly signal?: AbortSignal;
}

const CAPABILITY_BY_CONTRIBUTION: Readonly<
  Record<keyof AltairContributionMap, AltairPluginCapability>
> = Object.freeze({
  format: "format",
  ai: "ai",
  validator: "diagnostics",
  command: "commands",
  "editor-action": "editor",
  compiler: "compiler",
  flow: "flow",
  asset: "assets",
  "resource-browser": "assets",
  panel: "panel",
  preview: "preview",
});

/**
 * Transactional API 1/API 2 extension host.
 *
 * Installation and removal are serialized. Setup registrations remain staged
 * until activation succeeds, so readers never observe a half-installed
 * plugin. Every public registry view is a snapshot.
 */
export class AltairPluginHost {
  private readonly contributionRegistry = new Map<
    keyof AltairContributionMap,
    Map<string, RegisteredContribution<AltairContribution>>
  >();
  private readonly serviceRegistry = new Map<string, RegisteredService>();
  private readonly legacyFormats = new Map<
    string,
    RegisteredLegacy<AltairFormatCodec>
  >();
  private readonly legacyAiProviders = new Map<
    string,
    RegisteredLegacy<AltairAiProvider>
  >();
  private readonly legacyDiagnosticRules = new Map<
    string,
    RegisteredLegacy<AltairDiagnosticRule>
  >();
  private readonly installed = new Map<string, Installed>();
  private readonly scheduledInstalls = new Set<string>();
  private readonly hostController = new AbortController();
  private operationTail: Promise<void> = Promise.resolve();
  private acceptingOperations = true;
  private disposal: Promise<void> | null = null;

  get formats(): Map<string, AltairFormatCodec> {
    return this.legacySnapshot(this.legacyFormats);
  }

  get aiProviders(): Map<string, AltairAiProvider> {
    return this.legacySnapshot(this.legacyAiProviders);
  }

  get diagnosticRules(): Map<string, AltairDiagnosticRule> {
    return this.legacySnapshot(this.legacyDiagnosticRules);
  }

  get installedPluginIds(): readonly string[] {
    return Object.freeze([...this.installed.keys()]);
  }

  list(): readonly AltairPluginManifest[] {
    return Object.freeze(
      [...this.installed.values()].map(({ manifest }) => manifest),
    );
  }

  contributions<K extends keyof AltairContributionMap>(
    kind: K,
  ): readonly AltairContributionMap[K][] {
    return this.contributionSelections(kind)
      .filter(({ active }) => active)
      .map(({ contribution }) => contribution);
  }

  contributionSelections<K extends keyof AltairContributionMap>(
    kind: K,
  ): readonly AltairContributionSelection<AltairContributionMap[K]>[] {
    const registry = this.contributionRegistry.get(kind);
    if (!registry) return Object.freeze([]);
    const records = [...registry.values()].filter(({ owner }) =>
      this.installed.has(owner),
    );
    const winners = selectContributionWinners(records);
    return Object.freeze(
      records.map((entry) => {
        const winner = winners.get(entry);
        return Object.freeze({
          owner: entry.owner,
          kind,
          contribution: entry.value as AltairContributionMap[K],
          priority: entry.priority,
          overrides: entry.overrides,
          ...(entry.singletonPort === undefined
            ? {}
            : { singletonPort: entry.singletonPort }),
          active: winner === entry,
          ...(winner && winner !== entry
            ? { suppressedBy: qualifiedContributionId(winner) }
            : {}),
        });
      }),
    );
  }

  service<T>(key: AltairServiceKey<T>): T | undefined {
    requireServiceId(key);
    const service = this.serviceRegistry.get(key.id);
    return service && this.installed.has(service.owner)
      ? (service.value as T)
      : undefined;
  }

  commandSchema(
    selector: number | string,
  ): AltairCommandSchemaContribution | undefined {
    return this.commandSchemaSelection(selector)?.contribution;
  }

  async createCommand(
    selector: number | string,
    project: StoryProject,
    signal: AbortSignal = neverAbortedSignal(),
  ): Promise<StoryProjectCommand> {
    assertStoryProjectProtocol(project);
    const selection = this.commandSchemaSelection(selector);
    if (!selection) {
      throw new Error(`No active Altair command schema matches ${selector}`);
    }
    if (!selection.contribution.create) {
      throw new Error(
        `Altair command schema ${selection.owner}:${selection.contribution.id} cannot create commands`,
      );
    }
    const command = await this.withContribution(
      selection,
      signal,
      (contribution, context) =>
        contribution.create!(cloneStoryValue(project), context),
    );
    assertNewCommand(project, command);
    return cloneStoryValue(command);
  }

  private commandSchemaSelection(
    selector: number | string,
  ): ActiveSelection<"command"> | undefined {
    const schemas = this.orderedSelections("command");
    if (typeof selector === "number") {
      return schemas.find(({ contribution }) =>
        contribution.opcodes?.includes(selector),
      );
    }
    const normalized = selector.trim().toLowerCase();
    if (!normalized) return undefined;
    return schemas.find(
      ({ contribution, owner }) =>
        contribution.id === selector ||
        `${owner}:${contribution.id}` === selector ||
        contribution.sourceNames?.some(
          (name) => name.toLowerCase() === normalized,
        ),
    );
  }

  async runAi(
    providerId: string,
    request: AltairAdaptationRequest,
    signal: AbortSignal = neverAbortedSignal(),
  ): Promise<AltairAdaptationResult> {
    const selection = this.requireSelection("ai", providerId);
    const result = await this.withContribution(
      selection,
      signal,
      (provider, context) =>
        provider.adapt(cloneAdaptationRequest(request), context.signal),
    );
    return normalizeAdaptationResult(selection.contribution.id, result);
  }

  install(
    plugin: AltairPlugin,
    options: AltairPluginInstallOptions = {},
  ): Promise<void> {
    if (!this.acceptingOperations) {
      return Promise.reject(
        new ReferenceError("Altair plugin host is disposing"),
      );
    }
    let manifest: AltairPluginManifest;
    let installOptions: NormalizedInstallOptions;
    try {
      if (!plugin || typeof plugin !== "object") {
        throw new TypeError("Altair plugin must be an object");
      }
      manifest = snapshotManifest(plugin.manifest);
      installOptions = normalizeInstallOptions(options);
      if (typeof plugin.setup !== "function") {
        throw new TypeError(`Altair plugin ${manifest.id} has no setup method`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      this.installed.has(manifest.id) ||
      this.scheduledInstalls.has(manifest.id)
    ) {
      return Promise.reject(
        new Error(
          `Altair plugin already installed or installing: ${manifest.id}`,
        ),
      );
    }
    this.scheduledInstalls.add(manifest.id);
    const operation = this.enqueue(() =>
      this.installNow(plugin, manifest, installOptions),
    );
    void operation.then(
      () => this.scheduledInstalls.delete(manifest.id),
      () => this.scheduledInstalls.delete(manifest.id),
    );
    return operation;
  }

  remove(pluginId: string): Promise<void> {
    if (!this.acceptingOperations) {
      return Promise.reject(
        new ReferenceError("Altair plugin host is disposing"),
      );
    }
    return this.enqueue(() => this.removeNow(pluginId));
  }

  async sniffFormats(
    request: AltairFormatRequest,
  ): Promise<readonly AltairFormatSniffResult[]> {
    const normalized = normalizeFormatRequest(request);
    throwIfAborted(normalized.signal);
    const results = await Promise.all(
      this.orderedSelections("format").map(async (selection) => {
        const score = await this.withContribution(
          selection,
          normalized.signal,
          (contribution, context) =>
            contribution.sniff(
              { ...normalized, signal: context.signal },
              context,
            ),
        );
        if (
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1
        ) {
          throw new TypeError(
            `Altair format ${selection.owner}:${selection.contribution.id} returned an invalid sniff score`,
          );
        }
        return Object.freeze({
          id: selection.contribution.id,
          owner: selection.owner,
          score,
          priority: selection.priority,
        });
      }),
    );
    return Object.freeze(
      results
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.priority - left.priority ||
            stableText(
              `${left.owner}:${left.id}`,
              `${right.owner}:${right.id}`,
            ),
        ),
    );
  }

  async importFormat(
    request: AltairFormatRequest,
    formatId?: string,
  ): Promise<AltairFormatImportResult> {
    const normalized = normalizeFormatRequest(request);
    const selection = formatId
      ? this.requireSelection("format", formatId)
      : await this.detectFormatSelection(normalized);
    const result = await this.withContribution(
      selection,
      normalized.signal,
      (contribution, context) =>
        contribution.import(
          { ...normalized, signal: context.signal },
          context,
        ),
    );
    if (!result || typeof result.format !== "string" || !result.format.trim()) {
      throw new TypeError(
        `Altair format ${selection.owner}:${selection.contribution.id} returned no format id`,
      );
    }
    assertStoryProjectProtocol(result.project);
    requireDiagnostics(result.diagnostics, "format import");
    return Object.freeze({
      format: result.format,
      project: cloneStoryValue(result.project),
      diagnostics: Object.freeze(cloneStoryValue([...result.diagnostics])),
    });
  }

  async exportFormat(
    formatId: string,
    request: AltairFormatExportRequest,
  ): Promise<AltairFormatExportResult> {
    if (!request || typeof request !== "object") {
      throw new TypeError("Altair format export request must be an object");
    }
    assertStoryProjectProtocol(request.project);
    const normalized = normalizeFormatExportRequest(request);
    const selection = this.requireSelection("format", formatId);
    const result = await this.withContribution(
      selection,
      normalized.signal,
      (contribution, context) =>
        contribution.export(
          { ...normalized, signal: context.signal },
          context,
        ),
    );
    if (!result || typeof result !== "object") {
      throw new TypeError(
        `Altair format ${selection.owner}:${selection.contribution.id} returned an invalid export result`,
      );
    }
    requireDiagnostics(result.diagnostics, "format export");
    const artifacts = normalizeArtifacts(result.artifacts);
    return Object.freeze({
      artifacts,
      diagnostics: Object.freeze(cloneStoryValue([...result.diagnostics])),
    });
  }

  async runEditorAction(
    actionId: string,
    request: AltairEditorActionRequest,
  ): Promise<StoryProject> {
    assertStoryProjectProtocol(request.project);
    const selection = this.requireSelection("editor-action", actionId);
    const signal = request.signal ?? neverAbortedSignal();
    const project = await this.withContribution(
      selection,
      signal,
      (contribution, context) =>
        contribution.run(
          {
            ...request,
            project: cloneStoryValue(request.project),
            signal: context.signal,
          },
          context,
        ),
    );
    assertStoryProjectProtocol(project);
    return cloneStoryValue(project);
  }

  async runCompilerPasses(
    request: AltairCompilerPassRequest,
  ): Promise<AltairCompilerPipelineResult> {
    assertStoryProjectProtocol(request.project);
    const scene = request.project.scenes.find(
      ({ id }) => id === request.sceneId,
    );
    if (!scene) {
      throw new RangeError(`Unknown Altair scene: ${request.sceneId}`);
    }
    if (
      !Number.isSafeInteger(request.commandIndex) ||
      request.commandIndex < 0
    ) {
      throw new RangeError("Altair compiler command index must be non-negative");
    }
    assertCommandInProject(
      request.project,
      request.sceneId,
      request.commandIndex,
      request.command,
    );
    if (
      request.output !== undefined &&
      request.output !== null &&
      !isJsonObject(request.output)
    ) {
      throw new TypeError("Altair compiler output must be a JSON object or null");
    }
    const signal = request.signal ?? neverAbortedSignal();
    let command = cloneStoryValue(request.command);
    let output =
      request.output === undefined
        ? undefined
        : cloneStoryValue(request.output);
    const diagnostics: StoryDiagnostic[] = [];
    const passes = this.orderedSelections("compiler").sort(
      (left, right) =>
        (left.contribution.order ?? 0) -
          (right.contribution.order ?? 0) ||
        right.priority - left.priority ||
        stableText(
          `${left.owner}:${left.contribution.id}`,
          `${right.owner}:${right.contribution.id}`,
        ),
    );
    for (const selection of passes) {
      const result = await this.withContribution(
        selection,
        signal,
        (contribution, context) =>
          contribution.apply(
            {
              project: cloneStoryValue(request.project),
              sceneId: request.sceneId,
              commandIndex: request.commandIndex,
              command: cloneStoryValue(command),
              ...(output === undefined
                ? {}
                : { output: cloneStoryValue(output) }),
              signal: context.signal,
            },
            context,
          ),
      );
      if (!result) continue;
      if (result.command !== undefined) {
        command = cloneStoryValue(result.command);
        assertCommandInProject(
          request.project,
          request.sceneId,
          request.commandIndex,
          command,
        );
      }
      if (Object.hasOwn(result, "output")) {
        if (
          result.output !== null &&
          result.output !== undefined &&
          !isJsonObject(result.output)
        ) {
          throw new TypeError(
            `Altair compiler ${selection.owner}:${selection.contribution.id} returned a non-object output`,
          );
        }
        output =
          result.output === undefined
            ? undefined
            : cloneStoryValue(result.output);
      }
      if (result.diagnostics !== undefined) {
        requireDiagnostics(result.diagnostics, "compiler pass");
        diagnostics.push(...cloneStoryValue([...result.diagnostics]));
      }
    }
    return Object.freeze({
      command,
      ...(output === undefined ? {} : { output }),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  async evaluateDiagnostics(
    project: StoryProject,
    signal: AbortSignal = neverAbortedSignal(),
  ): Promise<readonly StoryDiagnostic[]> {
    assertStoryProjectProtocol(project);
    throwIfAborted(signal);
    const diagnostics: StoryDiagnostic[] = [];
    for (const selection of this.orderedSelections("validator")) {
      const values = await this.withContribution(
        selection,
        signal,
        (contribution, context) =>
          contribution.validate(cloneStoryValue(project), context),
      );
      requireDiagnostics(values, "validator");
      diagnostics.push(...cloneStoryValue([...values]));
    }
    return Object.freeze(diagnostics);
  }

  async buildFlow<T extends AltairFlowGraph = AltairFlowGraph>(
    providerId: string,
    project: StoryProject,
    signal: AbortSignal = neverAbortedSignal(),
  ): Promise<T> {
    assertStoryProjectProtocol(project);
    const selection = this.requireSelection("flow", providerId);
    const graph = await this.withContribution(
      selection,
      signal,
      (contribution, context) =>
        contribution.build(cloneStoryValue(project), context),
    );
    if (!isJsonValue(graph)) {
      throw new TypeError(
        `Altair flow provider ${selection.owner}:${selection.contribution.id} returned a non-JSON graph`,
      );
    }
    return cloneStoryValue(
      graph,
    ) as unknown as T;
  }

  async resolveAsset(
    request: AltairAssetRequest,
    providerId?: string,
  ): Promise<AltairResolvedAsset | undefined> {
    assertStoryProjectProtocol(request.project);
    if (typeof request.reference !== "string" || !request.reference.trim()) {
      throw new TypeError("Altair asset reference must not be empty");
    }
    if (request.kind !== undefined && !nonEmpty(request.kind)) {
      throw new TypeError("Altair asset kind must not be empty");
    }
    const signal = request.signal ?? neverAbortedSignal();
    const normalizedRequest = Object.freeze({
      project: cloneStoryValue(request.project),
      reference: request.reference.trim(),
      ...(request.kind === undefined ? {} : { kind: request.kind.trim() }),
      signal,
    });
    const candidates = providerId
      ? [this.requireSelection("asset", providerId)]
      : this.orderedSelections("asset");
    const supported: Array<{
      readonly selection: ActiveSelection<"asset">;
      readonly score: number;
    }> = [];
    for (const selection of candidates) {
      const value = selection.contribution.supports
        ? await this.withContribution(
            selection,
            signal,
            (contribution, context) =>
              contribution.supports!(
                { ...normalizedRequest, signal: context.signal },
                context,
              ),
          )
        : 1;
      const score =
        typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
      if (!Number.isFinite(score) || score < 0) {
        throw new TypeError(
          `Altair asset provider ${selection.owner}:${selection.contribution.id} returned an invalid support score`,
        );
      }
      if (score > 0) supported.push({ selection, score });
    }
    supported.sort(
      (left, right) =>
        right.score - left.score ||
        right.selection.priority - left.selection.priority ||
        stableText(
          `${left.selection.owner}:${left.selection.contribution.id}`,
          `${right.selection.owner}:${right.selection.contribution.id}`,
        ),
    );
    for (const { selection } of supported) {
      const resolved = await this.withContribution(
        selection,
        signal,
        (contribution, context) =>
          contribution.resolve(
            { ...normalizedRequest, signal: context.signal },
            context,
          ),
      );
      if (!resolved) continue;
      return normalizeResolvedAsset(resolved, selection);
    }
    return undefined;
  }

  async mountPanel(
    panelId: string,
    host: HTMLElement,
    options: AltairPanelMountOptions = {},
  ): Promise<{ dispose(): Promise<void> }> {
    if (!host || typeof host !== "object") {
      throw new TypeError("Altair panel host must be a DOM element");
    }
    const selection = this.requireSelection("panel", panelId);
    const local = new AbortController();
    const linked = linkAbortSignals([
      this.hostController.signal,
      this.ownerSignal(selection.owner),
      options.signal,
      local.signal,
    ]);
    try {
      throwIfAborted(linked.signal);
      const resource = await settleWithAbort(
        selection.contribution.mount(host, {
          signal: linked.signal,
          service: (key) =>
            this.serviceForOwner(selection.owner, key),
          ...(options.project === undefined
            ? {}
            : { project: cloneStoryValue(options.project) }),
          ...(options.selection === undefined
            ? {}
            : { selection: cloneStoryValue(options.selection) }),
        }),
        linked.signal,
      );
      return this.ownRuntimeResource(
        selection.owner,
        resource,
        local,
        linked.dispose,
      );
    } catch (error) {
      local.abort(error);
      linked.dispose();
      throw error;
    }
  }

  async createPreview(
    providerId: string,
    request: AltairPreviewRequest = {},
  ): Promise<AltairPreviewSession> {
    if (request.project !== undefined) {
      assertStoryProjectProtocol(request.project);
    }
    const selection = this.requireSelection("preview", providerId);
    const local = new AbortController();
    const linked = linkAbortSignals([
      this.hostController.signal,
      this.ownerSignal(selection.owner),
      request.signal,
      local.signal,
    ]);
    try {
      throwIfAborted(linked.signal);
      const session = await settleWithAbort(
        selection.contribution.create(
          {
            ...request,
            ...(request.project === undefined
              ? {}
              : { project: cloneStoryValue(request.project) }),
            signal: linked.signal,
          },
          {
            signal: linked.signal,
            service: (key) =>
              this.serviceForOwner(selection.owner, key),
          },
        ),
        linked.signal,
      );
      if (!session || typeof session.request !== "function") {
        throw new TypeError(
          `Altair preview provider ${selection.owner}:${selection.contribution.id} returned an invalid session`,
        );
      }
      if (session.capabilities !== undefined) {
        requireStringArray(
          session.capabilities,
          `Altair preview ${selection.owner}:${selection.contribution.id} capabilities`,
        );
      }
      const owned = this.ownRuntimeResource(
        selection.owner,
        session,
        local,
        linked.dispose,
      );
      return Object.freeze({
        ...(session.capabilities === undefined
          ? {}
          : { capabilities: Object.freeze([...session.capabilities]) }),
        request: async (
          command: JsonObject,
          options: { readonly signal?: AbortSignal } = {},
        ): Promise<JsonValue> => {
          if (!isJsonObject(command) || !isJsonValue(command)) {
            throw new TypeError(
              `Altair preview ${selection.owner}:${selection.contribution.id} request must be a JSON object`,
            );
          }
          const requestSignal = linkAbortSignals([
            linked.signal,
            options.signal,
          ]);
          try {
            throwIfAborted(requestSignal.signal);
            const response = await settleWithAbort(
              session.request(cloneStoryValue(command), {
                signal: requestSignal.signal,
              }),
              requestSignal.signal,
            );
            if (!isJsonValue(response)) {
              throw new TypeError(
                `Altair preview ${selection.owner}:${selection.contribution.id} returned a non-JSON value`,
              );
            }
            return cloneStoryValue(response);
          } finally {
            requestSignal.dispose();
          }
        },
        ...(session.onEvent
          ? {
              onEvent: (listener: (event: JsonValue) => void): (() => void) => {
                if (typeof listener !== "function") {
                  throw new TypeError("Altair preview listener must be a function");
                }
                let active = true;
                const remove = session.onEvent!((event) => {
                  if (!isJsonValue(event)) {
                    throw new TypeError(
                      `Altair preview ${selection.owner}:${selection.contribution.id} emitted a non-JSON value`,
                    );
                  }
                  listener(cloneStoryValue(event));
                });
                if (typeof remove !== "function") {
                  throw new TypeError(
                    `Altair preview ${selection.owner}:${selection.contribution.id} returned no event cleanup`,
                  );
                }
                return () => {
                  if (!active) return;
                  active = false;
                  remove();
                };
              },
            }
          : {}),
        dispose: owned.dispose,
      });
    } catch (error) {
      local.abort(error);
      linked.dispose();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.acceptingOperations = false;
    this.hostController.abort(
      new DOMException("Altair plugin host disposed", "AbortError"),
    );
    this.disposal = this.operationTail.then(async () => {
      const errors: unknown[] = [];
      while (this.installed.size) {
        const removable = [...this.installed.keys()].find(
          (pluginId) =>
            ![...this.installed.values()].some(({ manifest }) =>
              Object.hasOwn(manifest.dependencies ?? {}, pluginId),
            ),
        );
        if (!removable) {
          errors.push(
            new Error("Altair plugin dependency graph contains a cycle"),
          );
          break;
        }
        try {
          await this.removeNow(removable);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Failed to dispose the Altair plugin host",
        );
      }
    });
    this.operationTail = this.disposal.then(
      () => undefined,
      () => undefined,
    );
    return this.disposal;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async installNow(
    plugin: AltairPlugin,
    manifest: AltairPluginManifest,
    installOptions: NormalizedInstallOptions,
  ): Promise<void> {
    for (const [dependency, range] of Object.entries(
      manifest.dependencies ?? {},
    )) {
      const installedDependency = this.installed.get(dependency);
      if (!installedDependency) {
        throw new Error(`${manifest.id} requires ${dependency}`);
      }
      if (
        !satisfies(installedDependency.manifest.version, range, {
          includePrerelease: true,
        })
      ) {
        throw new Error(
          `${manifest.id} requires ${dependency}@${range}, found ${installedDependency.manifest.version}`,
        );
      }
    }
    const transaction: InstallTransaction = {
      manifest,
      controller: new AbortController(),
      cleanups: [],
      registrations: [],
      stagedServices: new Map(),
      stagedContributionRegistries: new Map(),
      installOptions,
    };
    transaction.cleanups.push(
      forwardAbort(this.hostController.signal, transaction.controller),
    );
    let activation: AltairPluginActivation | undefined;
    let started = false;
    try {
      throwIfAborted(transaction.controller.signal);
      const legacyContext = this.createLegacyContext(transaction);
      const setupResult =
        manifest.apiVersion === 1
          ? await (plugin as AltairPluginV1).setup(legacyContext)
          : await (plugin as AltairPluginV2).setup({
              ...legacyContext,
              contribute: (kind, contribution, options) => {
                this.requireCapability(
                  manifest,
                  CAPABILITY_BY_CONTRIBUTION[kind],
                );
                return this.stageContribution(
                  transaction,
                  kind,
                  contribution,
                  options,
                );
              },
              provide: (key, value) => {
                this.requireCapability(manifest, "services");
                return this.stageService(transaction, key, value);
              },
              service: (key) => {
                requireServiceId(key);
                return transaction.stagedServices.has(key.id)
                  ? (transaction.stagedServices.get(key.id) as never)
                  : this.serviceForManifest(manifest, key);
              },
              use: (resource) => {
                transaction.cleanups.push(toCleanup(resource));
                return resource;
              },
              defer: (cleanup) =>
                this.stageCleanup(transaction, cleanup),
            });
      if (typeof setupResult === "function") {
        transaction.cleanups.push(setupResult);
      } else if (setupResult) {
        activation = requireActivation(setupResult, manifest.id);
        if (activation.dispose) {
          transaction.cleanups.push(() => activation?.dispose?.());
        }
      }
      throwIfAborted(transaction.controller.signal);
      await activation?.start?.();
      started = true;
      throwIfAborted(transaction.controller.signal);
      for (const registration of transaction.registrations) {
        registration.commit();
      }
      this.installed.set(manifest.id, {
        manifest,
        controller: transaction.controller,
        cleanups: transaction.cleanups,
        installOptions,
        ...(activation ? { activation } : {}),
      });
    } catch (error) {
      transaction.controller.abort(error);
      const cleanupErrors: unknown[] = [];
      if (started) {
        try {
          await activation?.stop?.();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      await runCleanups(transaction.cleanups, cleanupErrors);
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Failed to install ${manifest.id}`,
        );
      }
      throw error;
    }
  }

  private createLegacyContext(
    transaction: InstallTransaction,
  ): AltairPluginContext {
    return {
      signal: transaction.controller.signal,
      configuration: transaction.installOptions.configuration,
      permissions: transaction.installOptions.permissions,
      hasPermission: (permission) =>
        transaction.installOptions.permissionSet.has(permission),
      registerFormat: (codec) => {
        this.requireCapability(transaction.manifest, "format");
        const snapshot = snapshotLegacyFormat(codec);
        const removeLegacy = this.stageLegacy(
          transaction,
          this.legacyFormats,
          snapshot.id,
          snapshot,
          "format",
        );
        const removeContribution = this.stageContribution(
          transaction,
          "format",
          legacyFormatContribution(snapshot),
          undefined,
        );
        return onceCleanup(async () => {
          await removeContribution();
          await removeLegacy();
        });
      },
      registerAiProvider: (provider) => {
        this.requireCapability(transaction.manifest, "ai");
        const snapshot = snapshotContribution(
          "ai",
          provider,
        ) as AltairAiProvider;
        const removeLegacy = this.stageLegacy(
          transaction,
          this.legacyAiProviders,
          snapshot.id,
          snapshot,
          "AI provider",
        );
        const removeContribution = this.stageContribution(
          transaction,
          "ai",
          snapshot,
          undefined,
        );
        return onceCleanup(async () => {
          await removeContribution();
          await removeLegacy();
        });
      },
      registerDiagnosticRule: (rule) => {
        this.requireCapability(transaction.manifest, "diagnostics");
        const snapshot = snapshotLegacyDiagnosticRule(rule);
        const removeLegacy = this.stageLegacy(
          transaction,
          this.legacyDiagnosticRules,
          snapshot.id,
          snapshot,
          "diagnostic rule",
        );
        const removeContribution = this.stageContribution(
          transaction,
          "validator",
          legacyValidatorContribution(snapshot),
          undefined,
        );
        return onceCleanup(async () => {
          await removeContribution();
          await removeLegacy();
        });
      },
    };
  }

  private async removeNow(pluginId: string): Promise<void> {
    const installed = this.installed.get(pluginId);
    if (!installed) return;
    const dependants = [...this.installed.values()]
      .filter(({ manifest }) =>
        Object.hasOwn(manifest.dependencies ?? {}, pluginId),
      )
      .map(({ manifest }) => manifest.id);
    if (dependants.length) {
      throw new Error(
        `${pluginId} is required by ${dependants.join(", ")}`,
      );
    }
    this.installed.delete(pluginId);
    installed.controller.abort(
      new DOMException(`Altair plugin removed: ${pluginId}`, "AbortError"),
    );
    const errors: unknown[] = [];
    try {
      await installed.activation?.stop?.();
    } catch (error) {
      errors.push(error);
    }
    await runCleanups(installed.cleanups, errors);
    if (errors.length) {
      throw new AggregateError(errors, `Failed to remove ${pluginId}`);
    }
  }

  private requireCapability(
    manifest: AltairPluginManifest,
    capability: AltairPluginCapability,
  ): void {
    if (!manifest.capabilities?.includes(capability)) {
      throw new Error(
        `${manifest.id} must declare the '${capability}' capability before registering it`,
      );
    }
  }

  private stageContribution<K extends keyof AltairContributionMap>(
    transaction: InstallTransaction,
    kind: K,
    contribution: AltairContributionMap[K],
    options: AltairContributionOptions | undefined,
  ): () => void {
    const value = snapshotContribution(kind, contribution);
    const registryKey = contributionRegistryKey(
      transaction.manifest.id,
      value.id,
    );
    const registry =
      this.contributionRegistry.get(kind) ??
      transaction.stagedContributionRegistries.get(kind) ??
      new Map<string, RegisteredContribution<AltairContribution>>();
    transaction.stagedContributionRegistries.set(kind, registry);
    if (
      registry.has(registryKey) ||
      transaction.registrations.some(
        (registration) =>
          registration instanceof StagedContributionRegistration &&
          registration.kind === kind &&
          registration.id === value.id &&
          registration.active,
      )
    ) {
      throw new Error(
        `Altair ${kind} contribution already registered: ${value.id}`,
      );
    }
    const normalized = normalizeContributionOptions(
      transaction.manifest.id,
      kind,
      options,
    );
    const entry = Object.freeze({
      owner: transaction.manifest.id,
      value: value as AltairContribution,
      ...normalized,
    });
    const registration = new StagedContributionRegistration(
      kind,
      value.id,
      registryKey,
      entry,
      registry,
      this.contributionRegistry,
    );
    transaction.registrations.push(registration);
    const remove = onceCleanup(() => registration.remove());
    transaction.cleanups.push(remove);
    return remove;
  }

  private stageService<T>(
    transaction: InstallTransaction,
    key: AltairServiceKey<T>,
    value: T,
  ): () => void {
    requireServiceId(key);
    if (
      this.serviceRegistry.has(key.id) ||
      transaction.stagedServices.has(key.id)
    ) {
      throw new Error(`Altair service already provided: ${key.id}`);
    }
    transaction.stagedServices.set(key.id, value);
    const registration = new StagedMapRegistration(
      key.id,
      { owner: transaction.manifest.id, value },
      this.serviceRegistry,
      () => transaction.stagedServices.delete(key.id),
    );
    transaction.registrations.push(registration);
    const remove = onceCleanup(() => registration.remove());
    transaction.cleanups.push(remove);
    return remove;
  }

  private stageLegacy<T>(
    transaction: InstallTransaction,
    map: Map<string, RegisteredLegacy<T>>,
    id: string,
    value: T,
    label: string,
  ): () => void {
    if (
      map.has(id) ||
      transaction.registrations.some(
        (registration) =>
          registration instanceof StagedMapRegistration &&
          registration.map === map &&
          registration.id === id &&
          registration.active,
      )
    ) {
      throw new Error(`Altair ${label} already registered: ${id}`);
    }
    const registration = new StagedMapRegistration(
      id,
      { owner: transaction.manifest.id, value },
      map,
    );
    transaction.registrations.push(registration);
    const remove = onceCleanup(() => registration.remove());
    transaction.cleanups.push(remove);
    return remove;
  }

  private stageCleanup(
    transaction: InstallTransaction,
    cleanup: Cleanup,
  ): () => void {
    if (typeof cleanup !== "function") {
      throw new TypeError("Altair plugin cleanup must be a function");
    }
    const owned = onceCleanup(cleanup);
    transaction.cleanups.push(owned);
    return () => {
      const index = transaction.cleanups.lastIndexOf(owned);
      if (index >= 0) transaction.cleanups.splice(index, 1);
    };
  }

  private legacySnapshot<T>(
    registry: Map<string, RegisteredLegacy<T>>,
  ): Map<string, T> {
    return new Map(
      [...registry.entries()]
        .filter(([, { owner }]) => this.installed.has(owner))
        .map(([id, { value }]) => [id, value]),
    );
  }

  private orderedSelections<K extends keyof AltairContributionMap>(
    kind: K,
  ): ActiveSelection<K>[] {
    return this.contributionSelections(kind)
      .filter(
        (
          selection,
        ): selection is AltairContributionSelection<
          AltairContributionMap[K]
        > & { readonly active: true } => selection.active,
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          stableText(
            `${left.owner}:${left.contribution.id}`,
            `${right.owner}:${right.contribution.id}`,
          ),
      );
  }

  private requireSelection<K extends keyof AltairContributionMap>(
    kind: K,
    selector: string,
  ): ActiveSelection<K> {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new TypeError(`Altair ${kind} selector must not be empty`);
    }
    const selected = this.orderedSelections(kind).find(
      ({ owner, contribution }) =>
        contribution.id === selector ||
        `${owner}:${contribution.id}` === selector,
    );
    if (!selected) {
      throw new Error(`Altair ${kind} contribution is not active: ${selector}`);
    }
    return selected;
  }

  private async detectFormatSelection(
    request: ReturnType<typeof normalizeFormatRequest>,
  ): Promise<ActiveSelection<"format">> {
    const matches = await this.sniffFormats(request);
    const match = matches[0];
    if (!match) {
      throw new Error("No Altair format contribution recognized the input");
    }
    return this.requireSelection("format", `${match.owner}:${match.id}`);
  }

  private async withContribution<
    K extends keyof AltairContributionMap,
    T,
  >(
    selection: ActiveSelection<K>,
    callerSignal: AbortSignal,
    run: (
      contribution: AltairContributionMap[K],
      context: AltairOperationContext,
    ) => T | Promise<T>,
  ): Promise<T> {
    const linked = linkAbortSignals([
      this.hostController.signal,
      this.ownerSignal(selection.owner),
      callerSignal,
    ]);
    try {
      throwIfAborted(linked.signal);
      return await settleWithAbort(
        Promise.resolve(
          run(selection.contribution, {
            signal: linked.signal,
            service: (key) =>
              this.serviceForOwner(selection.owner, key),
          }),
        ),
        linked.signal,
      );
    } finally {
      linked.dispose();
    }
  }

  /**
   * Contributions only see services they own or services supplied by an
   * explicitly declared plugin dependency. The application-facing service()
   * method remains unrestricted so the host can consume public plugin APIs.
   */
  private serviceForOwner<T>(
    owner: string,
    key: AltairServiceKey<T>,
  ): T | undefined {
    const manifest = this.installed.get(owner)?.manifest;
    return manifest
      ? this.serviceForManifest(manifest, key)
      : undefined;
  }

  private serviceForManifest<T>(
    manifest: AltairPluginManifest,
    key: AltairServiceKey<T>,
  ): T | undefined {
    requireServiceId(key);
    const service = this.serviceRegistry.get(key.id);
    if (
      !service ||
      !this.installed.has(service.owner) ||
      (service.owner !== manifest.id &&
        !Object.hasOwn(
          manifest.dependencies ?? {},
          service.owner,
        ))
    ) {
      return undefined;
    }
    return service.value as T;
  }

  private ownerSignal(owner: string): AbortSignal {
    const installed = this.installed.get(owner);
    if (!installed) {
      const controller = new AbortController();
      controller.abort(
        new DOMException(`Altair plugin is not active: ${owner}`, "AbortError"),
      );
      return controller.signal;
    }
    return installed.controller.signal;
  }

  private ownRuntimeResource(
    owner: string,
    resource: AltairDisposable,
    local: AbortController,
    unlink: () => void,
  ): { dispose(): Promise<void> } {
    const installed = this.installed.get(owner);
    if (!installed) {
      local.abort(
        new DOMException(`Altair plugin is not active: ${owner}`, "AbortError"),
      );
      unlink();
      throw new ReferenceError(`Altair plugin is not active: ${owner}`);
    }
    const disposeResource = toCleanup(resource);
    let removeOwnedCleanup = () => undefined;
    const dispose = onceCleanup(async () => {
      local.abort(
        new DOMException("Altair contributed resource disposed", "AbortError"),
      );
      unlink();
      removeOwnedCleanup();
      await disposeResource();
    });
    installed.cleanups.push(dispose);
    removeOwnedCleanup = () => {
      const index = installed.cleanups.lastIndexOf(dispose);
      if (index >= 0) installed.cleanups.splice(index, 1);
    };
    return { dispose: async () => void (await dispose()) };
  }
}

type ActiveSelection<K extends keyof AltairContributionMap> =
  AltairContributionSelection<AltairContributionMap[K]> & {
    readonly active: true;
  };

class StagedMapRegistration<K, V> implements StagedRegistration {
  active = true;
  private committed = false;

  constructor(
    readonly id: K,
    private readonly value: V,
    readonly map: Map<K, V>,
    private readonly onRemove?: () => void,
  ) {}

  commit(): void {
    if (!this.active) return;
    if (this.map.has(this.id)) {
      throw new Error(`Altair staged registration collided: ${String(this.id)}`);
    }
    this.map.set(this.id, this.value);
    this.committed = true;
  }

  remove(): void {
    if (!this.active) return;
    this.active = false;
    this.onRemove?.();
    if (this.committed && this.map.get(this.id) === this.value) {
      this.map.delete(this.id);
    }
  }
}

class StagedContributionRegistration implements StagedRegistration {
  active = true;
  private committed = false;

  constructor(
    readonly kind: keyof AltairContributionMap,
    readonly id: string,
    private readonly registryKey: string,
    private readonly value: RegisteredContribution<AltairContribution>,
    private readonly registry: Map<
      string,
      RegisteredContribution<AltairContribution>
    >,
    private readonly registries: Map<
      keyof AltairContributionMap,
      Map<string, RegisteredContribution<AltairContribution>>
    >,
  ) {}

  commit(): void {
    if (!this.active) return;
    if (this.registry.has(this.registryKey)) {
      throw new Error(
        `Altair ${this.kind} contribution collided during commit: ${this.id}`,
      );
    }
    this.registry.set(this.registryKey, this.value);
    this.registries.set(this.kind, this.registry);
    this.committed = true;
  }

  remove(): void {
    if (!this.active) return;
    this.active = false;
    if (
      this.committed &&
      this.registry.get(this.registryKey) === this.value
    ) {
      this.registry.delete(this.registryKey);
      if (!this.registry.size) this.registries.delete(this.kind);
    }
  }
}

const INSTALL_CONFIGURATION_MAX_DEPTH = 128;
const INSTALL_CONFIGURATION_MAX_NODES = 100_000;
const INSTALL_PERMISSION =
  /^[a-z0-9][a-z0-9._*-]*(?::[a-z0-9._*-]+)*$/u;
const DANGEROUS_CONFIGURATION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const snapshotInstallJson = (
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  state: { nodes: number },
  depth: number,
): JsonValue => {
  state.nodes += 1;
  if (state.nodes > INSTALL_CONFIGURATION_MAX_NODES) {
    throw new RangeError("Altair plugin configuration is too large");
  }
  if (depth > INSTALL_CONFIGURATION_MAX_DEPTH) {
    throw new RangeError(
      "Altair plugin configuration is too deeply nested",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite JSON number`);
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path} must be JSON-compatible`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} must not contain a cycle`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError(
          `${path} must not contain sparse array values`,
        );
      }
      return Object.freeze(
        value.map((item, index) =>
          snapshotInstallJson(
            item,
            `${path}[${index}]`,
            seen,
            state,
            depth + 1,
          ),
        ),
      ) as unknown as JsonValue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }
    const output: JsonObject = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_CONFIGURATION_KEYS.has(key)) {
        throw new TypeError(`${path}.${key} is not allowed`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be a data property`);
      }
      output[key] = snapshotInstallJson(
        descriptor.value,
        `${path}.${key}`,
        seen,
        state,
        depth + 1,
      );
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
};

const normalizeInstallOptions = (
  options: AltairPluginInstallOptions,
): NormalizedInstallOptions => {
  if (!options || typeof options !== "object") {
    throw new TypeError("Altair plugin install options must be an object");
  }
  const configuration = snapshotInstallJson(
    options.configuration ?? {},
    "$.configuration",
    new WeakSet(),
    { nodes: 0 },
    0,
  );
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    throw new TypeError("Altair plugin configuration must be an object");
  }
  if (
    options.permissions !== undefined &&
    !Array.isArray(options.permissions)
  ) {
    throw new TypeError("Altair plugin permissions must be an array");
  }
  const permissions = Object.freeze(
    [...(options.permissions ?? [])].map((permission) => {
      if (
        typeof permission !== "string" ||
        permission.length > 128 ||
        !INSTALL_PERMISSION.test(permission)
      ) {
        throw new TypeError(
          `Invalid Altair plugin permission: ${String(permission)}`,
        );
      }
      return permission;
    }),
  );
  if (permissions.length > 128) {
    throw new RangeError("Altair plugin permission list is too large");
  }
  if (new Set(permissions).size !== permissions.length) {
    throw new TypeError(
      "Altair plugin permissions contain a duplicate",
    );
  }
  return Object.freeze({
    configuration: configuration as Readonly<JsonObject>,
    permissions,
    permissionSet: new Set(permissions),
  });
};

const snapshotManifest = (
  candidate: AltairPluginManifest,
): AltairPluginManifest => {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("Altair plugin manifest must be an object");
  }
  const apiVersion = (candidate as { readonly apiVersion?: unknown }).apiVersion;
  if (apiVersion !== 1 && apiVersion !== ALTAIR_PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported Altair plugin API: ${String(apiVersion)}`,
    );
  }
  if (!PLUGIN_ID.test(candidate.id)) {
    throw new TypeError(`Invalid Altair plugin ID: ${candidate.id}`);
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new TypeError(`${candidate.id} has no name`);
  }
  if (!valid(candidate.version)) {
    throw new TypeError(`${candidate.id} has an invalid semantic version`);
  }
  if (
    candidate.description !== undefined &&
    typeof candidate.description !== "string"
  ) {
    throw new TypeError(`${candidate.id} has an invalid description`);
  }
  const capabilities = candidate.capabilities ?? [];
  if (
    capabilities.some((capability) => !PLUGIN_CAPABILITIES.has(capability))
  ) {
    throw new TypeError(`${candidate.id} declares an unknown capability`);
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError(
      `${candidate.id} declares a capability more than once`,
    );
  }
  const dependencies: Record<string, string> = {};
  for (const [dependency, range] of Object.entries(
    candidate.dependencies ?? {},
  ).sort(([left], [right]) => stableText(left, right))) {
    if (!PLUGIN_ID.test(dependency) || dependency === candidate.id) {
      throw new TypeError(
        `${candidate.id} has an invalid dependency ${dependency}`,
      );
    }
    if (typeof range !== "string" || !validRange(range)) {
      throw new TypeError(
        `${candidate.id} has an invalid dependency range for ${dependency}`,
      );
    }
    dependencies[dependency] = range;
  }
  return Object.freeze({
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    apiVersion: candidate.apiVersion,
    ...(candidate.description === undefined
      ? {}
      : { description: candidate.description }),
    ...(Object.keys(dependencies).length
      ? { dependencies: Object.freeze(dependencies) }
      : {}),
    ...(capabilities.length
      ? { capabilities: Object.freeze([...capabilities]) }
      : {}),
  }) as AltairPluginManifest;
};

const snapshotLegacyFormat = (
  codec: AltairFormatCodec,
): AltairFormatCodec => {
  if (!codec || typeof codec !== "object" || !nonEmpty(codec.id)) {
    throw new TypeError("Altair format codec must have an id");
  }
  requireStringArray(codec.extensions, `Altair format ${codec.id} extensions`);
  for (const method of ["sniff", "import", "export"] as const) {
    if (typeof codec[method] !== "function") {
      throw new TypeError(`Altair format ${codec.id} has no ${method} method`);
    }
  }
  return Object.freeze({
    ...codec,
    id: codec.id.trim(),
    extensions: Object.freeze([...codec.extensions]),
  });
};

const snapshotLegacyDiagnosticRule = (
  rule: AltairDiagnosticRule,
): AltairDiagnosticRule => {
  if (!rule || typeof rule !== "object" || !nonEmpty(rule.id)) {
    throw new TypeError("Altair diagnostic rule must have an id");
  }
  if (typeof rule.evaluate !== "function") {
    throw new TypeError(`Altair diagnostic rule ${rule.id} has no evaluator`);
  }
  return Object.freeze({ ...rule, id: rule.id.trim() });
};

const snapshotContribution = <K extends keyof AltairContributionMap>(
  kind: K,
  candidate: AltairContributionMap[K],
): AltairContributionMap[K] => {
  if (!candidate || typeof candidate !== "object" || !nonEmpty(candidate.id)) {
    throw new TypeError(`Altair ${kind} contribution must have an id`);
  }
  if (
    candidate.name !== undefined &&
    (typeof candidate.name !== "string" || !candidate.name.trim())
  ) {
    throw new TypeError(`Altair ${kind} contribution has an invalid name`);
  }
  const base = {
    ...candidate,
    id: candidate.id.trim(),
    ...(candidate.name === undefined ? {} : { name: candidate.name.trim() }),
  };
  switch (kind) {
    case "format": {
      const value = candidate as AltairFormatContribution;
      requireStringArray(
        value.extensions,
        `Altair format ${value.id} extensions`,
      );
      if (value.mediaTypes !== undefined) {
        requireStringArray(
          value.mediaTypes,
          `Altair format ${value.id} mediaTypes`,
        );
      }
      requireMethods(value, kind, ["sniff", "import", "export"]);
      return Object.freeze({
        ...base,
        extensions: Object.freeze([...value.extensions]),
        ...(value.mediaTypes === undefined
          ? {}
          : { mediaTypes: Object.freeze([...value.mediaTypes]) }),
      }) as unknown as AltairContributionMap[K];
    }
    case "ai": {
      const value = candidate as AltairAiProvider;
      if (!nonEmpty(value.name)) {
        throw new TypeError(`Altair AI provider ${value.id} has no name`);
      }
      requireMethods(value, kind, ["adapt"]);
      break;
    }
    case "validator":
      requireMethods(candidate, kind, ["validate"]);
      break;
    case "command": {
      const value = candidate as AltairCommandSchemaContribution;
      if (
        value.opcodes !== undefined &&
        (!Array.isArray(value.opcodes) ||
          value.opcodes.some(
            (opcode) => !Number.isSafeInteger(opcode) || opcode < 0,
          ) ||
          new Set(value.opcodes).size !== value.opcodes.length)
      ) {
        throw new TypeError(
          `Altair command schema ${value.id} has an invalid opcode`,
        );
      }
      if (value.sourceNames !== undefined) {
        requireStringArray(
          value.sourceNames,
          `Altair command schema ${value.id} sourceNames`,
        );
      }
      if (value.fields !== undefined) {
        requireCommandFields(value.fields, value.id);
      }
      if (value.category !== undefined && !nonEmpty(value.category)) {
        throw new TypeError(
          `Altair command schema ${value.id} has an invalid category`,
        );
      }
      if (
        value.metadata !== undefined &&
        (!isJsonObject(value.metadata) || !isJsonValue(value.metadata))
      ) {
        throw new TypeError(
          `Altair command schema ${value.id} has invalid metadata`,
        );
      }
      if (value.create !== undefined && typeof value.create !== "function") {
        throw new TypeError(
          `Altair command schema ${value.id} has an invalid create method`,
        );
      }
      return Object.freeze({
        ...base,
        ...(value.opcodes === undefined
          ? {}
          : { opcodes: Object.freeze([...value.opcodes]) }),
        ...(value.sourceNames === undefined
          ? {}
          : { sourceNames: Object.freeze([...value.sourceNames]) }),
        ...(value.metadata === undefined
          ? {}
          : { metadata: cloneStoryValue(value.metadata) }),
        ...(value.fields === undefined
          ? {}
          : {
              fields: Object.freeze(
                value.fields.map((field) =>
                  Object.freeze({
                    ...field,
                    ...(field.options === undefined
                      ? {}
                      : {
                          options: Object.freeze(
                            field.options.map((option) =>
                              Object.freeze({
                                ...option,
                                value: cloneStoryValue(option.value),
                              }),
                            ),
                          ),
                        }),
                    ...(field.metadata === undefined
                      ? {}
                      : { metadata: cloneStoryValue(field.metadata) }),
                  }),
                ),
              ),
            }),
      }) as unknown as AltairContributionMap[K];
    }
    case "editor-action":
      if (
        !nonEmpty(
          (candidate as AltairContributionMap["editor-action"]).label,
        )
      ) {
        throw new TypeError(
          `Altair editor action ${candidate.id} has no label`,
        );
      }
      if (
        (candidate as AltairContributionMap["editor-action"]).location !==
          undefined &&
        !nonEmpty(
          (candidate as AltairContributionMap["editor-action"]).location,
        )
      ) {
        throw new TypeError(
          `Altair editor action ${candidate.id} has an invalid location`,
        );
      }
      requireMethods(candidate, kind, ["run"]);
      break;
    case "compiler": {
      const value = candidate as AltairContributionMap["compiler"];
      if (
        value.order !== undefined &&
        !Number.isSafeInteger(value.order)
      ) {
        throw new TypeError(
          `Altair compiler pass ${value.id} has an invalid order`,
        );
      }
      requireMethods(candidate, kind, ["apply"]);
      break;
    }
    case "flow":
      requireMethods(candidate, kind, ["build"]);
      break;
    case "asset": {
      const value = candidate as AltairAssetProviderContribution;
      if (
        value.supports !== undefined &&
        typeof value.supports !== "function"
      ) {
        throw new TypeError(
          `Altair asset provider ${value.id} has an invalid supports method`,
        );
      }
      requireMethods(candidate, kind, ["resolve"]);
      break;
    }
    case "resource-browser": {
      const value = candidate as ResourceBrowserProvider;
      if (!nonEmpty(value.name)) {
        throw new TypeError(
          `Altair resource browser ${value.id} has no name`,
        );
      }
      if (!Array.isArray(value.roots) || value.roots.length === 0) {
        throw new TypeError(
          `Altair resource browser ${value.id} has no roots`,
        );
      }
      const rootIds = new Set<string>();
      const roots = value.roots.map((root: ResourceBrowserDirectory) => {
        if (
          !root ||
          typeof root !== "object" ||
          root.type !== "directory" ||
          !nonEmpty(root.id) ||
          !nonEmpty(root.name) ||
          !Array.isArray(root.path) ||
          root.path.length === 0 ||
          root.path.some((segment: string) => !nonEmpty(segment))
        ) {
          throw new TypeError(
            `Altair resource browser ${value.id} has an invalid root`,
          );
        }
        const rootId = root.id.trim();
        if (rootIds.has(rootId)) {
          throw new TypeError(
            `Altair resource browser ${value.id} duplicates root ${rootId}`,
          );
        }
        rootIds.add(rootId);
        return Object.freeze({
          ...root,
          id: rootId,
          name: root.name.trim(),
          path: Object.freeze([...root.path]),
        }) satisfies ResourceBrowserDirectory;
      });
      requireMethods(value, kind, [
        "preferredPath",
        "list",
        "open",
      ]);
      for (const method of ["refresh", "dispose"] as const) {
        if (
          value[method] !== undefined &&
          typeof value[method] !== "function"
        ) {
          throw new TypeError(
            `Altair resource browser ${value.id} has an invalid ${method} method`,
          );
        }
      }
      return Object.freeze({
        ...base,
        roots: Object.freeze(roots),
      }) as unknown as AltairContributionMap[K];
    }
    case "panel": {
      const value = candidate as AltairPanelContribution;
      if (!nonEmpty(value.slot)) {
        throw new TypeError(`Altair panel ${value.id} has no slot`);
      }
      requireMethods(candidate, kind, ["mount"]);
      break;
    }
    case "preview":
      requireMethods(candidate, kind, ["create"]);
      break;
  }
  return Object.freeze(base) as AltairContributionMap[K];
};

const legacyFormatContribution = (
  codec: AltairFormatCodec,
): AltairFormatContribution => ({
  id: codec.id,
  extensions: codec.extensions,
  sniff: ({ files, entryPath }) =>
    codec.sniff(entryFile(files, entryPath).bytes),
  async import({ files, entryPath }) {
    return {
      format: codec.id,
      project: await codec.import(entryFile(files, entryPath).bytes),
      diagnostics: [],
    };
  },
  async export({ project, entryPath }) {
    return {
      artifacts: [
        {
          path:
            entryPath ??
            `export${codec.extensions[0]?.startsWith(".") ? codec.extensions[0] : ".bin"}`,
          bytes: await codec.export(project),
        },
      ],
      diagnostics: [],
    };
  },
});

const legacyValidatorContribution = (
  rule: AltairDiagnosticRule,
): AltairValidatorContribution => ({
  id: rule.id,
  validate: (project) => rule.evaluate(project),
});

const normalizeContributionOptions = (
  owner: string,
  kind: keyof AltairContributionMap,
  options: AltairContributionOptions | undefined,
): Pick<
  RegisteredContribution<AltairContribution>,
  "priority" | "overrides" | "singletonPort"
> => {
  if (options !== undefined && (!options || typeof options !== "object")) {
    throw new TypeError(
      `Plugin ${owner} supplied invalid ${kind} contribution options`,
    );
  }
  const priority = options?.priority ?? 0;
  if (!Number.isSafeInteger(priority)) {
    throw new TypeError(
      `Plugin ${owner} supplied a non-integer ${kind} contribution priority`,
    );
  }
  const rawOverrides =
    typeof options?.override === "string"
      ? [options.override]
      : options?.override ?? [];
  if (
    !Array.isArray(rawOverrides) ||
    rawOverrides.some(
      (selector) => typeof selector !== "string" || !selector.trim(),
    )
  ) {
    throw new TypeError(
      `Plugin ${owner} supplied invalid ${kind} contribution overrides`,
    );
  }
  if (
    options?.singletonPort !== undefined &&
    !nonEmpty(options.singletonPort)
  ) {
    throw new TypeError(
      `Plugin ${owner} supplied an invalid ${kind} singleton port`,
    );
  }
  return {
    priority,
    overrides: Object.freeze(
      [...new Set(rawOverrides.map((selector) => selector.trim()))].sort(
        stableText,
      ),
    ),
    ...(options?.singletonPort === undefined
      ? {}
      : { singletonPort: options.singletonPort.trim() }),
  };
};

const selectContributionWinners = (
  records: readonly RegisteredContribution<AltairContribution>[],
): ReadonlyMap<
  RegisteredContribution<AltairContribution>,
  RegisteredContribution<AltairContribution>
> => {
  const parent = new Map(records.map((record) => [record, record] as const));
  const find = (
    record: RegisteredContribution<AltairContribution>,
  ): RegisteredContribution<AltairContribution> => {
    const current = parent.get(record)!;
    if (current === record) return record;
    const root = find(current);
    parent.set(record, root);
    return root;
  };
  const union = (
    left: RegisteredContribution<AltairContribution>,
    right: RegisteredContribution<AltairContribution>,
  ): void => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const first =
      stableText(qualifiedContributionId(a), qualifiedContributionId(b)) <= 0
        ? a
        : b;
    parent.set(a === first ? b : a, first);
  };
  const singletonOwners = new Map<
    string,
    RegisteredContribution<AltairContribution>
  >();
  for (const record of records) {
    if (!record.singletonPort) continue;
    const existing = singletonOwners.get(record.singletonPort);
    if (existing) union(existing, record);
    else singletonOwners.set(record.singletonPort, record);
  }
  for (const record of records) {
    for (const selector of record.overrides) {
      for (const target of records) {
        if (
          record !== target &&
          (selector === target.value.id ||
            selector === qualifiedContributionId(target))
        ) {
          union(record, target);
        }
      }
    }
  }
  const groups = new Map<
    RegisteredContribution<AltairContribution>,
    RegisteredContribution<AltairContribution>[]
  >();
  for (const record of records) {
    const root = find(record);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  }
  const winners = new Map<
    RegisteredContribution<AltairContribution>,
    RegisteredContribution<AltairContribution>
  >();
  for (const group of groups.values()) {
    const winner = group.reduce(preferredContribution);
    for (const record of group) winners.set(record, winner);
  }
  return winners;
};

const preferredContribution = (
  left: RegisteredContribution<AltairContribution>,
  right: RegisteredContribution<AltairContribution>,
): RegisteredContribution<AltairContribution> => {
  if (left.priority !== right.priority) {
    return left.priority > right.priority ? left : right;
  }
  const leftOverrides = contributionOverrides(left, right);
  const rightOverrides = contributionOverrides(right, left);
  if (leftOverrides !== rightOverrides) {
    return leftOverrides ? left : right;
  }
  return stableText(
    qualifiedContributionId(left),
    qualifiedContributionId(right),
  ) <= 0
    ? left
    : right;
};

const contributionOverrides = (
  candidate: RegisteredContribution<AltairContribution>,
  target: RegisteredContribution<AltairContribution>,
): boolean =>
  candidate.overrides.includes(target.value.id) ||
  candidate.overrides.includes(qualifiedContributionId(target));

const qualifiedContributionId = (
  contribution: RegisteredContribution<AltairContribution>,
): string => `${contribution.owner}:${contribution.value.id}`;

const contributionRegistryKey = (owner: string, id: string): string =>
  `${owner}\0${id}`;

const normalizeFormatRequest = (
  request: AltairFormatRequest,
): AltairFormatRequest & { readonly signal: AbortSignal } => {
  if (!request || typeof request !== "object") {
    throw new TypeError("Altair format request must be an object");
  }
  const files = normalizeSourceFiles(request.files);
  const entryPath = request.entryPath?.trim();
  if (entryPath && !files.some(({ path }) => path === entryPath)) {
    throw new RangeError(
      `Altair format entry is not present in files: ${entryPath}`,
    );
  }
  return Object.freeze({
    files,
    ...(entryPath ? { entryPath } : {}),
    ...(request.options === undefined
      ? {}
      : { options: cloneStoryValue(request.options) }),
    signal: request.signal ?? neverAbortedSignal(),
  });
};

const normalizeFormatExportRequest = (
  request: AltairFormatExportRequest,
): AltairFormatExportRequest & { readonly signal: AbortSignal } =>
  Object.freeze({
    project: cloneStoryValue(request.project),
    ...(nonEmpty(request.entryPath)
      ? { entryPath: request.entryPath!.trim() }
      : {}),
    ...(request.options === undefined
      ? {}
      : { options: cloneStoryValue(request.options) }),
    signal: request.signal ?? neverAbortedSignal(),
  });

const normalizeSourceFiles = (
  files: readonly import("./plugin-contributions.js").AltairSourceFile[],
): readonly import("./plugin-contributions.js").AltairSourceFile[] => {
  if (!Array.isArray(files) || !files.length) {
    throw new TypeError("Altair format request needs at least one file");
  }
  const paths = new Set<string>();
  return Object.freeze(
    files.map((file) => {
      if (!file || typeof file !== "object" || !nonEmpty(file.path)) {
        throw new TypeError("Altair source file path must not be empty");
      }
      const path = file.path.replace(/\\/g, "/").trim();
      if (paths.has(path)) {
        throw new Error(`Altair source file path is duplicated: ${path}`);
      }
      paths.add(path);
      if (!(file.bytes instanceof Uint8Array)) {
        throw new TypeError(`Altair source file ${path} has invalid bytes`);
      }
      if (
        file.mediaType !== undefined &&
        !nonEmpty(file.mediaType)
      ) {
        throw new TypeError(
          `Altair source file ${path} has an invalid media type`,
        );
      }
      return Object.freeze({
        path,
        bytes: file.bytes,
        ...(file.mediaType === undefined
          ? {}
          : { mediaType: file.mediaType.trim() }),
      });
    }),
  );
};

const entryFile = (
  files: readonly import("./plugin-contributions.js").AltairSourceFile[],
  entryPath?: string,
): import("./plugin-contributions.js").AltairSourceFile => {
  const file = entryPath
    ? files.find(({ path }) => path === entryPath)
    : files[0];
  if (!file) throw new RangeError(`Altair format entry does not exist`);
  return file;
};

const normalizeArtifacts = (
  artifacts: readonly AltairFormatArtifact[],
): readonly AltairFormatArtifact[] => {
  if (!Array.isArray(artifacts) || !artifacts.length) {
    throw new TypeError("Altair format export returned no artifacts");
  }
  const paths = new Set<string>();
  return Object.freeze(
    artifacts.map((artifact) => {
      if (!artifact || typeof artifact !== "object" || !nonEmpty(artifact.path)) {
        throw new TypeError("Altair format artifact path must not be empty");
      }
      const path = artifact.path.replace(/\\/g, "/").trim();
      if (paths.has(path)) {
        throw new Error(`Altair format artifact path is duplicated: ${path}`);
      }
      paths.add(path);
      if (!(artifact.bytes instanceof Uint8Array)) {
        throw new TypeError(`Altair format artifact ${path} has invalid bytes`);
      }
      return Object.freeze({
        path,
        bytes: artifact.bytes,
        ...(artifact.mediaType === undefined
          ? {}
          : { mediaType: artifact.mediaType }),
      });
    }),
  );
};

const normalizeResolvedAsset = (
  asset: AltairResolvedAsset,
  selection: ActiveSelection<"asset">,
): AltairResolvedAsset => {
  if (!asset || typeof asset !== "object" || !nonEmpty(asset.id)) {
    throw new TypeError(
      `Altair asset provider ${selection.owner}:${selection.contribution.id} returned an invalid asset`,
    );
  }
  if (
    asset.source === undefined &&
    !(asset.bytes instanceof Uint8Array)
  ) {
    throw new TypeError(
      `Altair asset ${asset.id} must provide source or bytes`,
    );
  }
  if (asset.source !== undefined && !nonEmpty(asset.source)) {
    throw new TypeError(`Altair asset ${asset.id} has an invalid source`);
  }
  if (asset.mediaType !== undefined && !nonEmpty(asset.mediaType)) {
    throw new TypeError(`Altair asset ${asset.id} has an invalid media type`);
  }
  if (
    asset.metadata !== undefined &&
    (!isJsonObject(asset.metadata) || !isJsonValue(asset.metadata))
  ) {
    throw new TypeError(`Altair asset ${asset.id} has invalid metadata`);
  }
  return Object.freeze({
    id: asset.id.trim(),
    ...(asset.source === undefined ? {} : { source: asset.source.trim() }),
    ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
    ...(asset.mediaType === undefined
      ? {}
      : { mediaType: asset.mediaType.trim() }),
    ...(asset.metadata === undefined
      ? {}
      : { metadata: cloneStoryValue(asset.metadata) }),
  });
};

const assertCommandInProject = (
  project: StoryProject,
  sceneId: string,
  commandIndex: number,
  command: StoryProjectCommand,
): void => {
  const candidate = cloneStoryValue(project);
  const scene = candidate.scenes.find(({ id }) => id === sceneId);
  if (!scene || commandIndex >= scene.commands.length) {
    throw new RangeError(
      `Altair compiler command index ${commandIndex} does not exist in ${sceneId}`,
    );
  }
  scene.commands[commandIndex] = cloneStoryValue(command);
  assertStoryProjectProtocol(candidate);
};

const assertNewCommand = (
  project: StoryProject,
  command: StoryProjectCommand,
): void => {
  const candidate = cloneStoryValue(project);
  const scene =
    candidate.scenes.find(({ id }) => id === candidate.entrySceneId) ??
    candidate.scenes[0];
  if (!scene) throw new Error("Altair project has no scene");
  scene.commands.push(cloneStoryValue(command));
  assertStoryProjectProtocol(candidate);
};

const cloneAdaptationRequest = (
  request: AltairAdaptationRequest,
): AltairAdaptationRequest => {
  if (!request || typeof request !== "object" || typeof request.source !== "string") {
    throw new TypeError("Altair adaptation request must contain source text");
  }
  for (const key of ["title", "locale", "instructions"] as const) {
    if (request[key] !== undefined && typeof request[key] !== "string") {
      throw new TypeError(`Altair adaptation request ${key} must be a string`);
    }
  }
  if (request.existingProject !== undefined) {
    assertStoryProjectProtocol(request.existingProject);
  }
  return Object.freeze({
    source: request.source,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.locale === undefined ? {} : { locale: request.locale }),
    ...(request.instructions === undefined
      ? {}
      : { instructions: request.instructions }),
    ...(request.existingProject === undefined
      ? {}
      : { existingProject: cloneStoryValue(request.existingProject) }),
  });
};

const normalizeAdaptationResult = (
  providerId: string,
  result: AltairAdaptationResult,
): AltairAdaptationResult => {
  if (!result || typeof result !== "object") {
    throw new TypeError(`AI provider '${providerId}' returned no result`);
  }
  assertStoryProjectProtocol(result.project);
  requireDiagnostics(result.diagnostics, `AI provider '${providerId}'`);
  const provenance = result.provenance;
  if (
    !provenance ||
    typeof provenance !== "object" ||
    provenance.provider !== providerId ||
    typeof provenance.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.generatedAt)) ||
    typeof provenance.reviewed !== "boolean" ||
    (provenance.model !== undefined && typeof provenance.model !== "string") ||
    (provenance.sourceHash !== undefined &&
      typeof provenance.sourceHash !== "string")
  ) {
    throw new TypeError(
      `AI provider '${providerId}' returned invalid provenance`,
    );
  }
  return Object.freeze({
    project: cloneStoryValue(result.project),
    diagnostics: Object.freeze(cloneStoryValue([...result.diagnostics])),
    provenance: Object.freeze(cloneStoryValue(provenance)),
  });
};

const requireDiagnostics = (
  diagnostics: readonly StoryDiagnostic[],
  source: string,
): void => {
  if (!Array.isArray(diagnostics)) {
    throw new TypeError(`Altair ${source} diagnostics must be an array`);
  }
  for (const diagnostic of diagnostics) {
    if (
      !diagnostic ||
      typeof diagnostic !== "object" ||
      !nonEmpty(diagnostic.code) ||
      !nonEmpty(diagnostic.message) ||
      !nonEmpty(diagnostic.path) ||
      !["info", "warning", "error"].includes(diagnostic.severity)
    ) {
      throw new TypeError(`Altair ${source} returned an invalid diagnostic`);
    }
  }
};

const requireMethods = (
  value: object,
  kind: string,
  methods: readonly string[],
): void => {
  for (const method of methods) {
    if (
      typeof (value as unknown as Record<string, unknown>)[method] !==
      "function"
    ) {
      throw new TypeError(
        `Altair ${kind} contribution has no ${method} method`,
      );
    }
  }
};

const requireStringArray = (
  value: readonly string[],
  label: string,
): void => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !nonEmpty(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} must be unique non-empty strings`);
  }
};

const requireCommandFields = (
  fields: readonly import("./plugin-contributions.js").AltairCommandFieldSchema[],
  schemaId: string,
): void => {
  if (!Array.isArray(fields)) {
    throw new TypeError(
      `Altair command schema ${schemaId} fields must be an array`,
    );
  }
  const keys = new Set<string>();
  for (const field of fields) {
    if (
      !field ||
      typeof field !== "object" ||
      !nonEmpty(field.key) ||
      !nonEmpty(field.label) ||
      !nonEmpty(field.kind)
    ) {
      throw new TypeError(
        `Altair command schema ${schemaId} has an invalid field`,
      );
    }
    const key = field.key.trim();
    if (keys.has(key)) {
      throw new TypeError(
        `Altair command schema ${schemaId} repeats field ${key}`,
      );
    }
    keys.add(key);
    if (field.resourceKind !== undefined && !nonEmpty(field.resourceKind)) {
      throw new TypeError(
        `Altair command schema ${schemaId} field ${key} has an invalid resource kind`,
      );
    }
    if (
      field.metadata !== undefined &&
      (!isJsonObject(field.metadata) || !isJsonValue(field.metadata))
    ) {
      throw new TypeError(
        `Altair command schema ${schemaId} field ${key} has invalid metadata`,
      );
    }
    if (field.options === undefined) continue;
    if (!Array.isArray(field.options)) {
      throw new TypeError(
        `Altair command schema ${schemaId} field ${key} options must be an array`,
      );
    }
    for (const option of field.options) {
      if (
        !option ||
        typeof option !== "object" ||
        !nonEmpty(option.label) ||
        !isJsonValue(option.value)
      ) {
        throw new TypeError(
          `Altair command schema ${schemaId} field ${key} has an invalid option`,
        );
      }
    }
  }
};

const requireServiceId = (key: AltairServiceKey<unknown>): void => {
  if (!key || typeof key !== "object" || !nonEmpty(key.id)) {
    throw new TypeError("Altair service key must not be empty");
  }
};

const requireActivation = (
  value: unknown,
  pluginId: string,
): AltairPluginActivation => {
  if (!value || typeof value !== "object") {
    throw new TypeError(
      `Altair plugin ${pluginId} returned an invalid activation`,
    );
  }
  for (const method of ["start", "stop", "dispose"] as const) {
    if (
      method in value &&
      typeof (value as Record<string, unknown>)[method] !== "function"
    ) {
      throw new TypeError(
        `Altair plugin ${pluginId} activation has an invalid ${method} method`,
      );
    }
  }
  return value as AltairPluginActivation;
};

const toCleanup = (resource: AltairDisposable): Cleanup => {
  if (typeof resource === "function") return resource;
  if (!resource || typeof resource !== "object") {
    throw new TypeError("Altair disposable must be a function or object");
  }
  if ("dispose" in resource && typeof resource.dispose === "function") {
    return () => resource.dispose();
  }
  if ("destroy" in resource && typeof resource.destroy === "function") {
    return () => resource.destroy();
  }
  if ("close" in resource && typeof resource.close === "function") {
    return () => resource.close();
  }
  throw new TypeError("Altair disposable has no cleanup method");
};

const onceCleanup = (cleanup: Cleanup): Cleanup => {
  let operation: Promise<void> | null = null;
  return () => {
    if (!operation) {
      operation = Promise.resolve().then(cleanup).then(() => undefined);
    }
    return operation;
  };
};

const runCleanups = async (
  cleanups: Cleanup[],
  errors: unknown[],
): Promise<void> => {
  const values = cleanups.splice(0).reverse();
  for (const cleanup of values) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
};

const neverAbortedSignal = (): AbortSignal =>
  new AbortController().signal;

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException("The Altair operation was aborted", "AbortError");

const settleWithAbort = <T>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const linkAbortSignals = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      dispose();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) {
        controller.abort(abortReason(signal));
      }
      dispose();
    };
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, dispose };
};

const forwardAbort = (
  source: AbortSignal,
  target: AbortController,
): Cleanup => {
  if (source.aborted) {
    target.abort(abortReason(source));
    return () => undefined;
  }
  const forward = () => target.abort(abortReason(source));
  source.addEventListener("abort", forward, { once: true });
  return () => source.removeEventListener("abort", forward);
};

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isJsonValue = (
  value: unknown,
  seen = new Set<object>(),
): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const validValue = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return validValue;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());

const stableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const PLUGIN_ID = /^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/i;
const PLUGIN_CAPABILITIES = new Set<AltairPluginCapability>([
  "format",
  "ai",
  "diagnostics",
  "panel",
  "assets",
  "commands",
  "editor",
  "compiler",
  "flow",
  "preview",
  "services",
]);
