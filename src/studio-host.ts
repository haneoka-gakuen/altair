export const ALTAIR_STUDIO_PROTOCOL = "altair-studio-host-v2";
export interface StudioProjectFile {
  readonly path: string;
  readonly blob: Blob;
}
export interface StudioProjectSnapshot {
  readonly id: string;
  readonly title: string;
  readonly files: readonly StudioProjectFile[];
  readonly directories: readonly string[];
  readonly sourceVersion: string;
}
export interface StudioState {
  readonly projectId: string | null;
  readonly title: string;
  readonly sourceVersion: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly error: string;
  readonly storage?: "browser" | "folder";
  readonly storagePath?: string;
  readonly localSaved?: boolean;
  readonly fileCount?: number;
  readonly line?: number;
  readonly activePath?: string;
}
export interface StudioAssetSource {
  readonly provider: "haneoka" | "bestdori" | "sekai";
  readonly origin: string;
  readonly server: string;
  readonly releaseId?: string;
  readonly sourceId?: string;
}
export interface StudioAssetCatalogue {
  readonly layout: "grid" | "directory";
  readonly path: readonly string[];
  readonly selectedId: string;
  readonly nodes: readonly {
    id: string;
    type: "directory" | "file";
    path: readonly string[];
    name: string;
    title: string;
    image: string;
    presentation?: { readonly kind: "live2d" | "spine"; readonly data: Readonly<Record<string, unknown>> };
    displayKind: string;
    available: boolean;
  }[];
}
export type StudioAssetRequest =
  | {
      mode: "catalog";
      source: StudioAssetSource;
      category: string;
      layout?: "grid" | "directory";
      path?: readonly string[];
    }
  | { mode: "path"; path: string }
  | { mode: "select"; id: string }
  | { mode: "cancel" };
export type StudioAction =
  | "state"
  | "configure"
  | "snapshot"
  | "add-file"
  | "open-local"
  | "open"
  | "new"
  | "import"
  | "import-source"
  | "stories"
  | "folder"
  | "library"
  | "save"
  | "settings"
  | "export-project"
  | "export-game"
  | "undo"
  | "redo"
  | "assets";
export interface StudioDownload {
  readonly kind: "download";
  readonly name: string;
  readonly blob: Blob;
}
export interface StudioRequest {
  readonly action: StudioAction;
  readonly value?: unknown;
}
interface StudioMessage {
  readonly protocol: typeof ALTAIR_STUDIO_PROTOCOL;
  readonly type: "request" | "response" | "state" | "intent" | "download";
  readonly id?: string;
  readonly action?: StudioAction | "publish";
  readonly value?: unknown;
  readonly projectId?: string | null;
  readonly error?: string;
}

/** A same-origin editor session; the host owns the port and its pending operations. */
export class AltairStudioClient {
  private port: MessagePort | undefined;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(state: StudioState) => void>();
  private readonly intents = new Set<(action: StudioAction | "publish") => void>();
  private readonly downloads = new Set<(download: StudioDownload) => void>();
  private current: StudioState | undefined;
  private disposed = false;
  private readonly origin: string;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private readonly onReady = (event: MessageEvent) => {
    if (
      event.origin === this.origin &&
      event.source === this.frame.contentWindow &&
      event.data?.protocol === ALTAIR_STUDIO_PROTOCOL &&
      event.data.type === "ready" &&
      !this.current
    )
      this.connect();
  };
  constructor(private readonly frame: HTMLIFrameElement) {
    this.origin = new URL(frame.src, frame.ownerDocument.baseURI).origin;
    if (this.origin !== frame.ownerDocument.location.origin) throw new TypeError("The editor must use the host origin");
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => this.rejectReady(new Error("studio_unavailable")), 60000);
    void this.ready.catch(() => undefined);
    frame.ownerDocument.defaultView!.addEventListener("message", this.onReady);
    this.connect();
  }
  private connect(): void {
    if (this.disposed) return;
    this.port?.close();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent<StudioMessage>) => {
      const message = event.data;
      if (message?.protocol !== ALTAIR_STUDIO_PROTOCOL) return;
      if (message.type === "state") {
        this.current = message.value as StudioState;
        clearTimeout(this.readyTimer);
        this.resolveReady();
        for (const listener of this.listeners) listener(this.current);
      } else if (message.type === "intent" && message.action) {
        for (const listener of this.intents) listener(message.action);
      } else if (message.type === "download") {
        for (const listener of this.downloads) listener(message.value as StudioDownload);
      } else if (message.type === "response" && message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      }
    };
    this.port.start();
    this.frame.contentWindow?.postMessage(
      { protocol: ALTAIR_STUDIO_PROTOCOL, type: "connect", capabilities: ["downloads"] },
      this.origin,
      [channel.port2],
    );
  }
  subscribe(listener: (state: StudioState) => void): () => void {
    this.listeners.add(listener);
    if (this.current) listener(this.current);
    return () => this.listeners.delete(listener);
  }
  onIntent(listener: (action: StudioAction | "publish") => void): () => void {
    this.intents.add(listener);
    return () => this.intents.delete(listener);
  }
  onDownload(listener: (download: StudioDownload) => void): () => void {
    this.downloads.add(listener);
    return () => this.downloads.delete(listener);
  }
  async request<T>(
    action: StudioAction,
    value?: unknown,
    options: { readonly projectId?: string | null } = {},
  ): Promise<T> {
    await this.ready;
    if (this.disposed || !this.port) throw new Error("studio_closed");
    const id = crypto.randomUUID();
    const bound = ![
      "state",
      "configure",
      "new",
      "open",
      "open-local",
      "import",
      "import-source",
      "folder",
      "library",
    ].includes(action);
    const projectId = options.projectId === undefined ? (this.current?.projectId ?? null) : options.projectId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error("studio_timeout"));
        },
        ["import-source", "folder"].includes(action) ? 30 * 60 * 1000 : 120000,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.port!.postMessage({
        protocol: ALTAIR_STUDIO_PROTOCOL,
        type: "request",
        id,
        action,
        value,
        ...(bound ? { projectId } : {}),
      } satisfies StudioMessage);
    });
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(new Error("studio_closed"));
    this.frame.ownerDocument.defaultView!.removeEventListener("message", this.onReady);
    this.port?.close();
    this.port = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("studio_closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.intents.clear();
    this.downloads.clear();
  }
}

export function installAltairStudioHost(options: {
  readonly state: () => StudioState;
  readonly request: (request: StudioRequest) => unknown | Promise<unknown>;
  readonly window?: Window;
}): {
  publish(): void;
  intent(action: StudioAction | "publish"): void;
  download(value: StudioDownload): void;
  dispose(): void;
} {
  const view = options.window ?? window;
  let port: MessagePort | undefined,
    disposed = false;
  let previous = "";
  const send = (message: StudioMessage) => port?.postMessage(message);
  const publish = () => {
    const state = options.state(),
      next = JSON.stringify(state);
    if (next !== previous) {
      previous = next;
      send({ protocol: ALTAIR_STUDIO_PROTOCOL, type: "state", value: state });
    }
  };
  const connect = (event: MessageEvent) => {
    if (
      view.parent === view ||
      event.source !== view.parent ||
      event.origin !== view.location.origin ||
      event.data?.protocol !== ALTAIR_STUDIO_PROTOCOL ||
      event.data.type !== "connect" ||
      event.ports.length !== 1
    )
      return;
    port?.close();
    port = event.ports[0]!;
    previous = "";
    port.onmessage = (event: MessageEvent<StudioMessage>) => {
      const message = event.data;
      if (
        disposed ||
        message?.protocol !== ALTAIR_STUDIO_PROTOCOL ||
        message.type !== "request" ||
        typeof message.id !== "string" ||
        !message.action ||
        message.action === "publish"
      )
        return;
      const owner = port,
        id = message.id;
      void Promise.resolve()
        .then(() => {
          if (message.projectId !== undefined && message.projectId !== options.state().projectId)
            throw new Error("project_changed");
          if (
            options.state().busy &&
            ["new", "open", "open-local", "import", "import-source", "folder", "library"].includes(message.action!)
          )
            throw new Error("studio_busy");
          return options.request({ action: message.action as StudioAction, value: message.value });
        })
        .then((value) => {
          if (!disposed && owner === port) send({ protocol: ALTAIR_STUDIO_PROTOCOL, type: "response", id, value });
        })
        .catch((error) => {
          if (!disposed && owner === port)
            send({
              protocol: ALTAIR_STUDIO_PROTOCOL,
              type: "response",
              id,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    };
    port.start();
    view.document.documentElement.dataset.studioHosted = "true";
    view.document.documentElement.dataset.studioDownloads = String(
      event.data.capabilities?.includes("downloads") === true,
    );
    publish();
  };
  view.addEventListener("message", connect);
  if (view.parent !== view)
    view.parent.postMessage({ protocol: ALTAIR_STUDIO_PROTOCOL, type: "ready" }, view.location.origin);
  return {
    publish,
    intent: (action) => send({ protocol: ALTAIR_STUDIO_PROTOCOL, type: "intent", action }),
    download: (value) => send({ protocol: ALTAIR_STUDIO_PROTOCOL, type: "download", value }),
    dispose() {
      disposed = true;
      view.removeEventListener("message", connect);
      port?.close();
      port = undefined;
      delete view.document.documentElement.dataset.studioHosted;
      delete view.document.documentElement.dataset.studioDownloads;
    },
  };
}
