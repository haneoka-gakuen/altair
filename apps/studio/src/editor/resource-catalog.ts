import type {
  ResourceBrowserFile,
  ResourceBrowserNode,
  ResourceBrowserPath,
  ResourceBrowserProvider,
  ResourceBrowserRequest,
} from "@haneoka/altair/resource-browser";
import type { StoryResourceResolver } from "@haneoka/vega/renderer-kit";
import {
  publicAssetManifest,
  validatePublicScope,
  type EditorPublicAsset,
  type PublicSourceScope,
} from "./resource-manifest";

/** One editor-owned catalog scope. Host resources and provider registration remain caller-owned. */
export class PublicResourceCatalog {
  readonly scope: PublicSourceScope;
  private readonly requests = new Set<AbortController>();
  private readonly releases = new Set<() => void>();
  private readonly selected = new Map<string, EditorPublicAsset>();
  private disposed = false;
  constructor(
    readonly provider: ResourceBrowserProvider,
    scope: PublicSourceScope,
    private readonly resources: StoryResourceResolver,
  ) {
    this.scope = validatePublicScope(scope);
  }
  get roots() {
    return this.provider.roots;
  }
  private context(request: ResourceBrowserRequest): ResourceBrowserRequest {
    return {
      ...request,
      context:
        this.scope.provider === "haneoka"
          ? {
              ...request.context,
              release: this.scope.releaseId,
              releaseServer: this.scope.server,
              sourceId: this.scope.sourceId,
            }
          : { ...request.context, bestdoriServer: this.scope.server },
    };
  }
  preferredPath(request: ResourceBrowserRequest): ResourceBrowserPath {
    if (this.disposed) throw new DOMException("Catalog is closed", "AbortError");
    return this.provider.preferredPath(this.context(request));
  }
  list(path: ResourceBrowserPath, request: ResourceBrowserRequest): Promise<readonly ResourceBrowserNode[]> {
    return this.run(request.signal, (signal) =>
      Promise.resolve(this.provider.list(path, this.context({ ...request, signal }))),
    );
  }
  select(file: ResourceBrowserFile, request: ResourceBrowserRequest): Promise<EditorPublicAsset> {
    if (!file.available) return Promise.reject(new Error("Asset is unavailable"));
    return this.run(request.signal, async (signal) => {
      const insert = await this.provider.open(file, this.context({ ...request, signal }));
      if (!insert) throw new Error("Asset cannot be inserted here");
      signal.throwIfAborted();
      const asset = publicAssetManifest(this.scope, file, insert);
      this.selected.set(asset.id, asset);
      return asset;
    });
  }
  load(assetId: string, memberId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const source = this.member(assetId, memberId);
    return this.run(signal, async (request) => {
      const bytes = await this.resources.load(source, request);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024 * 1024)
        throw new TypeError("Invalid asset bytes");
      return Uint8Array.from(bytes);
    });
  }
  retain(assetId: string, memberId: string, signal?: AbortSignal): Promise<{ release(): void }> {
    const source = this.member(assetId, memberId);
    return this.run(
      signal,
      (request) => this.resources.retain(source, request),
      (late) => late.release(),
    ).then((lease) => ({ release: this.ownRelease(() => lease.release(), signal) }));
  }
  renderable(assetId: string, memberId: string, signal?: AbortSignal): Promise<{ url: string; release(): void }> {
    const source = this.member(assetId, memberId);
    return this.run(
      signal,
      (request) => this.resources.resolveRenderable(source, request),
      (late) => late.release(),
    ).then((lease) => ({ url: lease.url, release: this.ownRelease(() => lease.release(), signal) }));
  }
  manifest(): readonly EditorPublicAsset[] {
    return Object.freeze([...this.selected.values()]);
  }
  private member(assetId: string, memberId: string): string {
    if (this.disposed) throw new DOMException("Catalog is closed", "AbortError");
    const member = this.selected.get(assetId)?.members.find((m) => m.id === memberId);
    if (!member || !this.resources.canLoad(member.source))
      throw new Error("Resource was not selected or cannot be loaded");
    return member.source;
  }
  private ownRelease(hostRelease: () => void, signal?: AbortSignal): () => void {
    if (this.disposed || signal?.aborted) {
      hostRelease();
      throw signal?.reason ?? new DOMException("Catalog is closed", "AbortError");
    }
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      this.releases.delete(release);
      hostRelease();
    };
    this.releases.add(release);
    return release;
  }
  private run<T>(
    signal: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<T>,
    discard?: (value: T) => void,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new DOMException("Catalog is closed", "AbortError"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const controller = new AbortController();
    this.requests.add(controller);
    return new Promise((resolve, reject) => {
      let done = false;
      const forward = () => controller.abort(signal?.reason);
      const finish = (callback: () => void) => {
        if (done) return;
        done = true;
        this.requests.delete(controller);
        signal?.removeEventListener("abort", forward);
        controller.signal.removeEventListener("abort", cancel);
        callback();
      };
      const cancel = () => finish(() => reject(controller.signal.reason));
      controller.signal.addEventListener("abort", cancel, { once: true });
      signal?.addEventListener("abort", forward, { once: true });
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return read(controller.signal);
        })
        .then(
          (value) => {
            if (done) {
              try {
                discard?.(value);
              } catch (error) {
                console.error("[Altair] late public asset release failed", error);
              }
              return;
            }
            finish(() => resolve(value));
          },
          (error) => finish(() => reject(error)),
        );
      if (signal?.aborted) forward();
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests) request.abort(new DOMException("Catalog is closed", "AbortError"));
    const errors: unknown[] = [];
    for (const release of [...this.releases])
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    this.selected.clear();
    if (errors.length) throw new AggregateError(errors, "Catalog release failed");
  }
}
