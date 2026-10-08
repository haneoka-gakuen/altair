import type {
  ResourceBrowserFile,
  ResourceBrowserNode,
  ResourceBrowserPath,
  ResourceBrowserRequest,
} from "@haneoka/altair/resource-browser";
import type { EditorSession } from "./session";
import { preparePublicAssetImport, type LocalPublicAssetPlan, type PublicAssetByteReader } from "./public-asset-import";
import type { EditorPublicAsset, PublicSourceScope } from "./resource-manifest";
import type { PublicResourceConnection, PublicResourceSource, StudioPublicResourceHost } from "./public-resource-host";

export const PUBLIC_ASSET_INSERT_KINDS = Object.freeze([
  "background",
  "still",
  "frame",
  "stamp",
  "audio",
  "bgm",
  "se",
  "voice",
  "video",
  "model",
  "live2d",
  "spine",
  "effect",
  "post-effect",
]);
export interface PublicPickerSnapshot {
  readonly phase: "idle" | "connecting" | "browsing" | "selecting" | "prepared" | "importing" | "error";
  readonly scope?: PublicSourceScope;
  readonly path: ResourceBrowserPath;
  readonly nodes: readonly ResourceBrowserNode[];
  readonly roots: readonly ResourceBrowserNode[];
  readonly asset?: EditorPublicAsset;
  readonly selectedFileId?: string;
  readonly plan?: LocalPublicAssetPlan;
  readonly loadedMembers: number;
  readonly totalMembers: number;
  readonly importedPaths?: readonly string[];
  readonly error: string;
}
export interface PublicImportMetadata {
  readonly directory: string;
  readonly author: string;
  readonly license: string;
  readonly version: string;
}
/** One consumer owns source scope, selected bytes, cancellation and the final Session import. */
export class PublicResourcePickerController {
  private state: PublicPickerSnapshot = {
    phase: "idle",
    path: [],
    nodes: [],
    roots: [],
    loadedMembers: 0,
    totalMembers: 0,
    error: "",
  };
  private readonly listeners = new Set<() => void>();
  private operation?: AbortController;
  private generation = 0;
  private connection?: PublicResourceConnection;
  private selectedReader?: PublicAssetByteReader;
  private importTask?: Promise<void>;
  private disposed = false;
  private readonly sessionUnsubscribe: () => void;
  private context: string;
  constructor(
    readonly session: EditorSession,
    private readonly host: StudioPublicResourceHost,
  ) {
    const current = () => `${session.getSnapshot().id}:${session.getSnapshot().contextEpoch ?? 0}`;
    this.context = current();
    this.sessionUnsubscribe = session.subscribe(() => {
      if (current() === this.context) return;
      this.context = current();
      this.reset();
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<PublicPickerSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  private reset() {
    this.operation?.abort();
    this.generation++;
    this.connection?.dispose();
    this.connection = undefined;
    this.selectedReader = undefined;
    this.publish({
      phase: "idle",
      scope: undefined,
      path: [],
      nodes: [],
      roots: [],
      asset: undefined,
      selectedFileId: undefined,
      plan: undefined,
      loadedMembers: 0,
      totalMembers: 0,
      importedPaths: undefined,
      error: "",
    });
  }
  cancel() {
    this.operation?.abort(new DOMException("Public picker operation canceled", "AbortError"));
  }
  disconnect() {
    this.reset();
  }
  clearSelection() {
    this.cancel();
    this.generation++;
    this.selectedReader = undefined;
    this.publish({
      asset: undefined,
      selectedFileId: undefined,
      plan: undefined,
      loadedMembers: 0,
      totalMembers: 0,
      importedPaths: undefined,
      phase: this.connection ? "browsing" : "idle",
    });
  }
  private async start(
    phase: PublicPickerSnapshot["phase"],
  ): Promise<{ controller: AbortController; generation: number; context: string }> {
    if (this.disposed) throw new DOMException("Public picker is closed", "AbortError");
    const requestedContext = this.context;
    this.cancel();
    if (this.importTask) await this.importTask.catch(() => undefined);
    if (this.disposed || this.context !== requestedContext)
      throw new DOMException("Public picker context changed", "AbortError");
    const controller = new AbortController();
    this.operation = controller;
    const generation = ++this.generation;
    this.publish({ phase, error: "", importedPaths: undefined });
    return { controller, generation, context: this.context };
  }
  private active(task: { controller: AbortController; generation: number; context: string }) {
    task.controller.signal.throwIfAborted();
    if (this.disposed || task.generation !== this.generation || task.context !== this.context)
      throw new DOMException("Public picker context changed", "AbortError");
  }
  private failed(task: { controller: AbortController; generation: number; context: string }, error: unknown) {
    if (this.disposed || task.generation !== this.generation || task.context !== this.context) return;
    if (task.controller.signal.aborted) {
      this.publish({ phase: this.state.plan ? "prepared" : this.connection ? "browsing" : "idle" });
      return;
    }
    this.publish({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
  private request(signal: AbortSignal, preferredKind?: string): ResourceBrowserRequest {
    const usage = preferredKind && ["bgm", "se", "voice"].includes(preferredKind) ? preferredKind : "bgm";
    const kind =
      this.connection?.catalog.scope.provider === "haneoka"
        ? preferredKind === "model"
          ? "live2d"
          : ["bgm", "se", "voice"].includes(preferredKind ?? "")
            ? "audio"
            : preferredKind
        : preferredKind;
    return { acceptedKinds: PUBLIC_ASSET_INSERT_KINDS, preferredKind: kind, signal, context: { audioUsage: usage } };
  }
  async connect(source: PublicResourceSource): Promise<void> {
    const task = await this.start("connecting");
    this.connection?.dispose();
    this.connection = undefined;
    this.selectedReader = undefined;
    this.publish({
      scope: undefined,
      path: [],
      nodes: [],
      roots: [],
      asset: undefined,
      selectedFileId: undefined,
      plan: undefined,
      loadedMembers: 0,
      totalMembers: 0,
    });
    let connection: PublicResourceConnection | undefined;
    try {
      connection = await this.host.connect({ ...source }, task.controller.signal);
      this.active(task);
      this.connection = connection;
      const roots = connection.catalog.roots,
        nodes = await connection.catalog.list([], this.request(task.controller.signal));
      this.active(task);
      this.publish({
        phase: "browsing",
        scope: connection.catalog.scope,
        roots,
        nodes: nodes.length ? nodes : roots,
        path: [],
      });
    } catch (error) {
      if (connection) {
        if (this.connection === connection) this.connection = undefined;
        connection.dispose();
      }
      this.failed(task, error);
    }
  }
  async browse(path: ResourceBrowserPath): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const captured = Object.freeze([...path]),
      task = await this.start("browsing");
    this.selectedReader = undefined;
    this.publish({
      asset: undefined,
      selectedFileId: undefined,
      plan: undefined,
      loadedMembers: 0,
      totalMembers: 0,
      nodes: [],
      path: captured,
    });
    try {
      const nodes = captured.length
        ? await connection.catalog.list(captured, this.request(task.controller.signal))
        : connection.catalog.roots;
      this.active(task);
      if (this.connection !== connection) throw new DOMException("Source changed", "AbortError");
      this.publish({ nodes, phase: "browsing" });
    } catch (error) {
      this.failed(task, error);
    }
  }
  async select(file: ResourceBrowserFile, preferredKind?: string): Promise<void> {
    const connection = this.connection;
    if (!connection || !file.available || !file.acceptedKinds.some((kind) => PUBLIC_ASSET_INSERT_KINDS.includes(kind)))
      return;
    const task = await this.start("selecting");
    this.selectedReader = undefined;
    this.publish({ asset: undefined, selectedFileId: undefined, plan: undefined, loadedMembers: 0, totalMembers: 0 });
    try {
      const asset = await connection.catalog.select(file, this.request(task.controller.signal, preferredKind));
      this.active(task);
      if (asset.kind === "project") throw new Error("Story projects require their project importer");
      this.publish({
        asset,
        selectedFileId: file.id,
        totalMembers: new Set(asset.members.map((member) => member.source)).size,
      });
      const bytes = new Map<string, Uint8Array>();
      let loaded = 0;
      const reader: PublicAssetByteReader = {
        load: async (assetId, memberId, signal) => {
          signal?.throwIfAborted();
          if (assetId !== asset.id || !asset.members.some((member) => member.id === memberId))
            throw new Error("Resource was not selected");
          let value = bytes.get(memberId);
          if (!value) {
            value = await connection.catalog.load(assetId, memberId, signal);
            signal?.throwIfAborted();
            bytes.set(memberId, Uint8Array.from(value));
            loaded++;
            if (task.generation === this.generation) this.publish({ loadedMembers: loaded });
          }
          return Uint8Array.from(value);
        },
      };
      const plan = await preparePublicAssetImport({
        asset,
        reader,
        directory: "assets/public-preview",
        author: "Preview",
        license: "Preview only",
        version: "0.0.0",
        existing: [],
        signal: task.controller.signal,
      });
      this.active(task);
      this.selectedReader = reader;
      this.publish({ phase: "prepared", plan });
    } catch (error) {
      this.failed(task, error);
    }
  }
  importSelected(metadata: PublicImportMetadata): Promise<void> {
    if (this.importTask) return this.importTask;
    const asset = this.state.asset,
      reader = this.selectedReader;
    if (!asset || !reader || !this.state.plan) return Promise.reject(new Error("Select and prepare an asset first"));
    const settings = { ...metadata };
    const run = (async () => {
      const task = await this.start("importing");
      try {
        const paths = await this.session.importPublicAsset(asset, reader, {
          ...settings,
          signal: task.controller.signal,
        });
        this.active(task);
        this.publish({ phase: "prepared", importedPaths: Object.freeze([...paths]) });
      } catch (error) {
        this.failed(task, error);
      }
    })();
    this.importTask = run.finally(() => {
      this.importTask = undefined;
    });
    return this.importTask;
  }
  dispose() {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.generation++;
    this.sessionUnsubscribe();
    this.connection?.dispose();
    this.connection = undefined;
    this.selectedReader = undefined;
    this.listeners.clear();
  }
}
