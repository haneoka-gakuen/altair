import {
  AltairPreviewClient,
  bootstrapAltairPreview,
  type VegaJsonValue,
  type VegaPreviewBreakpoint,
  type VegaPreviewEvent,
  type VegaPreviewIdentity,
  type VegaPreviewTransform,
} from "@haneoka/altair-preview-client";
import type { AltairPreviewSession, JsonObject } from "@haneoka/altair";

export interface AltairStudioEmbeddedPreviewConfig {
  /**
   * URL of a Vega-owned runtime document. Altair never imports the renderer
   * into its React tree; communication is exclusively over the preview port.
   */
  readonly runtimeUrl: string;
  readonly targetOrigin: string;
  /** One-use capability issued by the trusted local preview broker. */
  readonly token: string;
  readonly identity: VegaPreviewIdentity;
}

declare global {
  interface Window {
    /**
     * Desktop/local-daemon shells may inject this before Studio starts.
     * Browser builds deliberately ship without a preview token.
     */
    __ALTAIR_VEGA_PREVIEW__?: AltairStudioEmbeddedPreviewConfig;
  }
}

export const resolveStudioPreviewConfig = (
  config: AltairStudioEmbeddedPreviewConfig | undefined,
  studioUrl: string,
): AltairStudioEmbeddedPreviewConfig | undefined => {
  if (!config) return undefined;
  const studio = new URL(studioUrl);
  const runtimeUrl = new URL(config.runtimeUrl, studio);
  if (runtimeUrl.origin === studio.origin) {
    throw new Error("Vega preview runtime must use a dedicated origin");
  }
  if (runtimeUrl.origin !== config.targetOrigin) {
    throw new Error("Configured Vega runtime URL does not match its exact targetOrigin");
  }
  if (config.token.length < 24) throw new Error("Configured Vega preview token is too short");
  return { ...config, runtimeUrl: runtimeUrl.href };
};

export const studioPreviewConfig = (): AltairStudioEmbeddedPreviewConfig | undefined =>
  resolveStudioPreviewConfig(window.__ALTAIR_VEGA_PREVIEW__, window.location.href);

export class StudioPreviewBridge {
  private client: AltairPreviewClient | undefined;
  private session: AltairPreviewSession | undefined;

  async connect(target: Window, config: AltairStudioEmbeddedPreviewConfig): Promise<void> {
    this.close();
    const client = bootstrapAltairPreview(target, config.targetOrigin, config.identity, config.token, {
      timeoutMs: 8_000,
    });
    await this.adoptClient(client);
  }

  /**
   * Attach a brokered MessagePort directly. Studio uses this for its bundled
   * Vega runtime while desktop shells can retain the authenticated iframe path.
   */
  async connectPort(port: MessagePort, identity: VegaPreviewIdentity): Promise<void> {
    this.close();
    const client = new AltairPreviewClient({
      identity,
      port,
      timeoutMs: 8_000,
    });
    await this.adoptClient(client);
  }

  /** Adopt a preview provider session contributed through Altair API 2. */
  connectSession(session: AltairPreviewSession): void {
    if (!session || typeof session.request !== "function") {
      throw new TypeError("Altair preview session is invalid");
    }
    this.close();
    this.session = session;
  }

  private async adoptClient(client: AltairPreviewClient): Promise<void> {
    this.client = client;
    try {
      await client.waitUntilReady({ timeoutMs: 8_000 });
    } catch (error) {
      client.close();
      if (this.client === client) this.client = undefined;
      throw error;
    }
  }

  get connected(): boolean {
    return Boolean(this.session || (this.client?.capabilities && !this.client.isClosed));
  }

  onEvent(listener: (event: VegaPreviewEvent) => void): () => void {
    if (this.session) {
      return this.session.onEvent?.((event) => listener(event as unknown as VegaPreviewEvent)) ?? (() => undefined);
    }
    return this.requireClient().onEvent(listener);
  }

  async load(story: VegaJsonValue, commandIndex: number, signal?: AbortSignal): Promise<void> {
    const response = await this.request({ name: "runtime.load", story, commandIndex }, signal);
    if (response.status === "superseded") throw new Error("Preview load was superseded by a newer revision");
  }

  async syncScene(
    sceneId: string,
    sceneRevision: string,
    story: VegaJsonValue,
    commandIndex: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.request(
      {
        name: "editor.sync-scene",
        sceneId,
        sceneRevision,
        story,
        commandIndex,
      },
      signal,
    );
    return response.status === "executed";
  }

  async seek(commandIndex: number, signal?: AbortSignal): Promise<void> {
    const response = await this.request({ name: "runtime.seek", commandIndex }, signal);
    if (response.status === "superseded") return;
  }

  async snapshot(signal?: AbortSignal): Promise<VegaJsonValue | undefined> {
    const response = await this.request({ name: "runtime.snapshot" }, signal);
    return response.status === "executed" ? response.result : undefined;
  }

  async play(signal?: AbortSignal): Promise<void> {
    await this.request({ name: "runtime.play" }, signal);
  }

  async pause(signal?: AbortSignal): Promise<void> {
    await this.request({ name: "runtime.pause" }, signal);
  }

  async runScene(commandIndex = 0, signal?: AbortSignal): Promise<void> {
    await this.request({ name: "editor.run-scene", commandIndex }, signal);
  }

  async runFrom(commandIndex: number, signal?: AbortSignal): Promise<void> {
    await this.request({ name: "editor.run-from", commandIndex }, signal);
  }

  async runSnippet(commands: readonly VegaJsonValue[], label?: string, signal?: AbortSignal): Promise<void> {
    await this.request({ name: "editor.run-snippet", commands, ...(label ? { label } : {}) }, signal);
  }

  async continue(signal?: AbortSignal): Promise<void> {
    await this.request({ name: "debug.continue" }, signal);
  }

  async step(signal?: AbortSignal): Promise<void> {
    await this.request({ name: "debug.step" }, signal);
  }

  async setBreakpoints(breakpoints: readonly VegaPreviewBreakpoint[], signal?: AbortSignal): Promise<void> {
    await this.request({ name: "debug.breakpoints.set", breakpoints }, signal);
  }

  async variables(signal?: AbortSignal): Promise<VegaJsonValue | undefined> {
    const response = await this.request({ name: "debug.variables" }, signal);
    return response.status === "executed" ? response.result : undefined;
  }

  async stageSnapshot(signal?: AbortSignal): Promise<VegaJsonValue | undefined> {
    const response = await this.request({ name: "stage.snapshot" }, signal);
    return response.status === "executed" ? response.result : undefined;
  }

  async referenceFrame(target: string, signal?: AbortSignal): Promise<VegaJsonValue | undefined> {
    const response = await this.request({ name: "stage.reference-frame", target }, signal);
    return response.status === "executed" ? response.result : undefined;
  }

  async stageTransform(target: string, signal?: AbortSignal): Promise<VegaJsonValue | undefined> {
    const response = await this.request({ name: "stage.transform.get", target }, signal);
    return response.status === "executed" ? response.result : undefined;
  }

  async setStageTransform(
    target: string,
    transform: VegaJsonValue,
    commit: boolean,
    signal?: AbortSignal,
  ): Promise<VegaJsonValue | undefined> {
    const response = await this.request(
      {
        name: "stage.transform.set",
        target,
        transform: parseStudioPreviewTransform(transform),
        phase: commit ? "commit" : "preview",
      },
      signal,
    );
    return response.status === "executed" ? response.result : undefined;
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    const session = this.session;
    this.session = undefined;
    void Promise.resolve(session?.dispose()).catch(() => undefined);
  }

  private request(
    command: Parameters<AltairPreviewClient["request"]>[0],
    signal?: AbortSignal,
  ): ReturnType<AltairPreviewClient["request"]> {
    if (this.session) {
      return this.session
        .request(command as unknown as JsonObject, signal ? { signal } : {})
        .then((response) => response as unknown as Awaited<ReturnType<AltairPreviewClient["request"]>>);
    }
    return this.requireClient().request(command, signal ? { signal } : {});
  }

  private requireClient(): AltairPreviewClient {
    if (!this.client?.capabilities || this.client.isClosed) {
      throw new Error("Vega preview runtime is not connected");
    }
    return this.client;
  }
}

const record = (value: VegaJsonValue): Record<string, VegaJsonValue> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, VegaJsonValue>) : undefined;

const finite = (value: VegaJsonValue | undefined, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
};

const point = (
  value: VegaJsonValue | undefined,
  path: string,
): { readonly x: number; readonly y: number } | undefined => {
  if (value === undefined) return undefined;
  const parsed = record(value);
  if (!parsed) throw new TypeError(`${path} must be an object`);
  return { x: finite(parsed.x, `${path}.x`), y: finite(parsed.y, `${path}.y`) };
};

export const parseStudioPreviewTransform = (value: VegaJsonValue): VegaPreviewTransform => {
  const parsed = record(value);
  if (!parsed) throw new TypeError("Stage transform must be an object");
  const position = point(parsed.position, "transform.position");
  const scale = point(parsed.scale, "transform.scale");
  const rotationDegrees =
    parsed.rotationDegrees === undefined ? undefined : finite(parsed.rotationDegrees, "transform.rotationDegrees");
  const opacity = parsed.opacity === undefined ? undefined : finite(parsed.opacity, "transform.opacity");
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    throw new RangeError("transform.opacity must be between 0 and 1");
  }
  return {
    ...(position ? { position } : {}),
    ...(scale ? { scale } : {}),
    ...(rotationDegrees === undefined ? {} : { rotationDegrees }),
    ...(opacity === undefined ? {} : { opacity }),
  };
};
