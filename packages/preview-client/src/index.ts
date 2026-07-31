import {
  VEGA_PREVIEW_PROTOCOL,
  isVegaPreviewMessage,
  type VegaPreviewCapabilities,
  type VegaPreviewBreakpoint,
  type VegaPreviewCommand,
  type VegaPreviewEvent,
  type VegaPreviewIdentity,
  type VegaPreviewRequest,
  type VegaPreviewResponse,
  type VegaPreviewTransform,
  type VegaJsonValue,
} from "@haneoka/vega-protocol";

export type {
  VegaPreviewCapabilities,
  VegaPreviewBreakpoint,
  VegaPreviewCommand,
  VegaPreviewEvent,
  VegaPreviewIdentity,
  VegaPreviewResponse,
  VegaPreviewTransform,
  VegaJsonValue,
} from "@haneoka/vega-protocol";
export { VEGA_PREVIEW_PROTOCOL } from "@haneoka/vega-protocol";

export interface AltairPreviewClientOptions {
  readonly identity: VegaPreviewIdentity;
  readonly port: MessagePort;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
  /** Set false when the MessagePort lifecycle is owned by an outer broker. */
  readonly ownPort?: boolean;
  readonly onListenerError?: (error: unknown) => void;
}

export interface AltairPreviewRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly command: VegaPreviewCommand["name"];
  readonly revision: number;
  readonly resolve: (response: VegaPreviewResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort?: () => void;
}

interface ReadyWaiter {
  readonly resolve: (capabilities: VegaPreviewCapabilities) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort?: () => void;
}

export class AltairPreviewRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AltairPreviewRequestError";
    this.code = code;
  }
}

const sameIdentity = (left: VegaPreviewIdentity, right: VegaPreviewIdentity): boolean =>
  left.workspaceId === right.workspaceId &&
  left.projectId === right.projectId &&
  left.editorSessionId === right.editorSessionId &&
  left.runtimeInstanceId === right.runtimeInstanceId;

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : reason === undefined
        ? "Preview request aborted"
        : String(reason),
    { cause: reason },
  );
  error.name = "AbortError";
  return error;
};

const requestId = (): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required for preview requests");
  }
  return globalThis.crypto.randomUUID();
};

export class AltairPreviewClient {
  readonly identity: VegaPreviewIdentity;
  readonly port: MessagePort;
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly ownPort: boolean;
  private readonly onListenerError?: (error: unknown) => void;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: VegaPreviewEvent) => void>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private capabilitiesValue: VegaPreviewCapabilities | undefined;
  private revision = 0;
  private closed = false;

  constructor(options: AltairPreviewClientOptions) {
    this.identity = options.identity;
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.createRequestId = options.requestId ?? requestId;
    this.ownPort = options.ownPort !== false;
    this.onListenerError = options.onListenerError;
    this.port.addEventListener("message", this.onMessage);
    this.port.addEventListener("messageerror", this.onMessageError);
    this.port.start();
  }

  get capabilities(): VegaPreviewCapabilities | undefined {
    return this.capabilitiesValue;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(listener: (event: VegaPreviewEvent) => void): () => void {
    if (this.closed) throw new Error("Altair preview client is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilReady(options: AltairPreviewRequestOptions = {}): Promise<VegaPreviewCapabilities> {
    if (this.closed) return Promise.reject(new Error("Altair preview client is closed"));
    if (this.capabilitiesValue) return Promise.resolve(this.capabilitiesValue);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<VegaPreviewCapabilities>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          waiter.removeAbort?.();
          reject(new Error("Vega preview runtime did not become ready before the timeout"));
        }, options.timeoutMs ?? this.timeoutMs),
        ...(signal
          ? {
              removeAbort: (() => {
                const onAbort = () => {
                  this.readyWaiters.delete(waiter);
                  clearTimeout(waiter.timer);
                  reject(abortError(signal));
                };
                signal.addEventListener("abort", onAbort, { once: true });
                return () => signal.removeEventListener("abort", onAbort);
              })(),
            }
          : {}),
      };
      this.readyWaiters.add(waiter);
    });
  }

  async request(
    command: VegaPreviewCommand,
    options: AltairPreviewRequestOptions = {},
  ): Promise<VegaPreviewResponse> {
    if (this.closed) throw new Error("Altair preview client is closed");
    if (options.signal?.aborted) throw abortError(options.signal);
    if (this.capabilitiesValue && !this.capabilitiesValue.commands.includes(command.name)) {
      throw new AltairPreviewRequestError(
        "unsupported",
        `Vega preview runtime does not support ${command.name}`,
      );
    }
    const id = this.createRequestId();
    if (!id || this.pending.has(id)) throw new Error(`Preview request ID is empty or duplicated: ${id}`);
    const revision = ++this.revision;
    const request: VegaPreviewRequest = {
      protocol: VEGA_PREVIEW_PROTOCOL,
      kind: "request",
      identity: this.identity,
      requestId: id,
      revision,
      command,
    };
    const response = new Promise<VegaPreviewResponse>((resolve, reject) => {
      const pending: Pending = {
        command: command.name,
        revision,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          pending.removeAbort?.();
          reject(new Error(`Vega preview request timed out: ${command.name}`));
        }, options.timeoutMs ?? this.timeoutMs),
        ...(options.signal
          ? {
              removeAbort: (() => {
                const signal = options.signal;
                const onAbort = () => {
                  this.pending.delete(id);
                  clearTimeout(pending.timer);
                  reject(abortError(signal!));
                };
                signal!.addEventListener("abort", onAbort, { once: true });
                return () => signal!.removeEventListener("abort", onAbort);
              })(),
            }
          : {}),
      };
      this.pending.set(id, pending);
    });
    try {
      this.port.postMessage(request);
    } catch (error) {
      this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
    }
    return response;
  }

  async load(story: VegaJsonValue, commandIndex?: number, options: AltairPreviewRequestOptions = {}) {
    return this.request(
      {
        name: "runtime.load",
        story,
        ...(commandIndex === undefined ? {} : { commandIndex }),
      },
      options,
    );
  }

  async seek(commandIndex: number, options: AltairPreviewRequestOptions = {}) {
    if (!Number.isSafeInteger(commandIndex) || commandIndex < 0) {
      throw new RangeError("Preview command index must be a non-negative integer");
    }
    return this.request({ name: "runtime.seek", commandIndex }, options);
  }

  async syncScene(
    sceneId: string,
    sceneRevision: string,
    story: VegaJsonValue,
    commandIndex?: number,
    options: AltairPreviewRequestOptions = {},
  ) {
    if (!sceneId.trim()) throw new TypeError("Preview scene ID must not be empty");
    if (!sceneRevision.trim()) throw new TypeError("Preview scene revision must not be empty");
    if (
      commandIndex !== undefined &&
      (!Number.isSafeInteger(commandIndex) || commandIndex < 0)
    ) {
      throw new RangeError("Preview command index must be a non-negative integer");
    }
    return this.request(
      {
        name: "editor.sync-scene",
        sceneId,
        sceneRevision,
        story,
        ...(commandIndex === undefined ? {} : { commandIndex }),
      },
      options,
    );
  }

  async runScene(commandIndex = 0, options: AltairPreviewRequestOptions = {}) {
    if (!Number.isSafeInteger(commandIndex) || commandIndex < 0) {
      throw new RangeError("Preview command index must be a non-negative integer");
    }
    return this.request({ name: "editor.run-scene", commandIndex }, options);
  }

  async runFrom(commandIndex: number, options: AltairPreviewRequestOptions = {}) {
    if (!Number.isSafeInteger(commandIndex) || commandIndex < 0) {
      throw new RangeError("Preview command index must be a non-negative integer");
    }
    return this.request({ name: "editor.run-from", commandIndex }, options);
  }

  async runSnippet(
    commands: readonly VegaJsonValue[],
    label?: string,
    options: AltairPreviewRequestOptions = {},
  ) {
    return this.request(
      { name: "editor.run-snippet", commands, ...(label ? { label } : {}) },
      options,
    );
  }

  async setBreakpoints(
    breakpoints: readonly VegaPreviewBreakpoint[],
    options: AltairPreviewRequestOptions = {},
  ) {
    return this.request({ name: "debug.breakpoints.set", breakpoints }, options);
  }

  async inspectReferenceFrame(target: string, options: AltairPreviewRequestOptions = {}) {
    if (!target.trim()) throw new TypeError("Preview stage target must not be empty");
    return this.request({ name: "stage.reference-frame", target }, options);
  }

  async getStageTransform(target: string, options: AltairPreviewRequestOptions = {}) {
    if (!target.trim()) throw new TypeError("Preview stage target must not be empty");
    return this.request({ name: "stage.transform.get", target }, options);
  }

  async setStageTransform(
    target: string,
    transform: VegaPreviewTransform,
    phase: "preview" | "commit" = "commit",
    options: AltairPreviewRequestOptions = {},
  ) {
    if (!target.trim()) throw new TypeError("Preview stage target must not be empty");
    return this.request({ name: "stage.transform.set", target, transform, phase }, options);
  }

  close(reason = "Altair preview client closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener("message", this.onMessage);
    this.port.removeEventListener("messageerror", this.onMessageError);
    if (this.ownPort) this.port.close();
    const error = new Error(reason);
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.removeAbort?.();
      waiter.reject(error);
    }
    this.readyWaiters.clear();
    this.listeners.clear();
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (!isVegaPreviewMessage(event.data)) return;
    if (event.data.kind === "event") {
      if (!sameIdentity(event.data.identity, this.identity)) return;
      if (event.data.event === "runtime.ready") {
        this.capabilitiesValue = event.data.capabilities;
        for (const waiter of this.readyWaiters) {
          clearTimeout(waiter.timer);
          waiter.removeAbort?.();
          waiter.resolve(event.data.capabilities);
        }
        this.readyWaiters.clear();
      }
      for (const listener of this.listeners) {
        try {
          listener(event.data);
        } catch (error) {
          this.onListenerError?.(error);
        }
      }
      return;
    }
    if (event.data.kind !== "response") return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    if (event.data.revision !== pending.revision) {
      this.rejectPending(
        event.data.requestId,
        new AltairPreviewRequestError("protocol", `Revision mismatch for ${pending.command}`),
      );
      return;
    }
    this.pending.delete(event.data.requestId);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if (event.data.status === "rejected") {
      pending.reject(
        new AltairPreviewRequestError(
          event.data.error?.code || "rejected",
          event.data.error?.message || "Vega preview request rejected",
        ),
      );
    } else {
      pending.resolve(event.data);
    }
  };

  private readonly onMessageError = () =>
    this.close("Vega preview transport failed to deserialize a message");

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    pending.reject(error);
  }
}

export interface AltairPreviewBootstrap {
  readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
  readonly kind: "bootstrap";
  readonly token: string;
  readonly identity: VegaPreviewIdentity;
}

/**
 * Creates a private MessagePort transport. The caller must obtain `token`
 * from its trusted local broker and provide the exact runtime origin.
 */
export const bootstrapAltairPreview = (
  target: Window,
  targetOrigin: string,
  identity: VegaPreviewIdentity,
  token: string,
  options: Omit<AltairPreviewClientOptions, "identity" | "port"> = {},
): AltairPreviewClient => {
  if (!targetOrigin || targetOrigin === "*") throw new TypeError("Preview bootstrap requires an exact target origin");
  if (token.length < 24) throw new TypeError("Preview bootstrap token is too short");
  const channel = new MessageChannel();
  target.postMessage(
    { protocol: VEGA_PREVIEW_PROTOCOL, kind: "bootstrap", token, identity } satisfies AltairPreviewBootstrap,
    targetOrigin,
    [channel.port2],
  );
  return new AltairPreviewClient({ ...options, identity, port: channel.port1 });
};
