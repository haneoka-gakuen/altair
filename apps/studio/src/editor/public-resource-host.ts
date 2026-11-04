import type { StoryResourceResolver } from "@haneoka/vega/renderer-kit";
import { haneokaResourceRequestUrl } from "@haneoka/altair-plugin-haneoka/public-resource-url";
import { storyResourceContentType } from "@haneoka/vega/plugin";
import { readPublicResponse } from "./public-response";
import { validatePublicScope, type PublicSourceScope } from "./resource-manifest";
import {
  createBestdoriPublicResourceCatalog,
  createHaneokaPublicResourceCatalog,
  resolveHaneokaPublicScope,
  type PublicCatalogTransport,
  type PublicResourceFactories,
} from "./public-resource-providers";
import type { PublicResourceCatalog } from "./resource-catalog";

export interface PublicResourceSource {
  readonly provider: "haneoka" | "bestdori" | "sekai";
  readonly origin: string;
  readonly server: string;
  readonly releaseId?: string;
  readonly sourceId?: string;
}
export interface PublicResourceConnection {
  readonly catalog: PublicResourceCatalog;
  dispose(): void;
}
export interface StudioPublicResourceHost {
  connect(source: PublicResourceSource, signal: AbortSignal): Promise<PublicResourceConnection>;
}
/** Logical release-pinned member IDs stay unchanged; only the public HTTP request uses server+query. */
export function publicResourceRequestUrl(source: string, scopeValue: PublicSourceScope): string {
  const scope = validatePublicScope(scopeValue),
    url = new URL(source);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("Invalid public resource URL");
  if (scope.provider === "haneoka") return haneokaResourceRequestUrl(source, { ...scope, releaseId: scope.releaseId! });
  if (
    scope.provider === "bestdori" &&
    url.origin === "https://bestdori.com" &&
    /^\/api\/upload\/file\/[a-f\d]{40}$/u.test(url.pathname) &&
    !url.search
  )
    return new URL(`/api/v1/garupa/bestdori/${scope.server}/raw${url.pathname}`, scope.origin).href;
  return url.href;
}
class PublicHttpResources implements StoryResourceResolver {
  private readonly lifetime = new AbortController();
  private readonly cache = new Map<string, { bytes: Uint8Array; url?: string; refs: number }>();
  private totalBytes = 0;
  constructor(private readonly scope: PublicSourceScope) {}
  canLoad(source: string): boolean {
    try {
      publicResourceRequestUrl(source, this.scope);
      return !this.lifetime.signal.aborted;
    } catch {
      return false;
    }
  }
  async load(source: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const cached = this.cache.get(source);
    if (cached) return Uint8Array.from(cached.bytes);
    const bytes = await readPublicResponse(publicResourceRequestUrl(source, this.scope), {
      label: "Public resource",
      maxBytes: 256 * 1024 * 1024,
      signals: [signal, this.lifetime.signal],
    });
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.totalBytes + bytes.byteLength > 2 * 1024 ** 3) throw new Error("Public selection exceeds its byte limit");
    if (!this.cache.has(source)) {
      this.cache.set(source, { bytes, refs: 0 });
      this.totalBytes += bytes.byteLength;
    }
    return Uint8Array.from(this.cache.get(source)!.bytes);
  }

  async retain(source: string, signal?: AbortSignal): Promise<{ release(): void }> {
    await this.load(source, signal);
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const entry = this.cache.get(source)!;
    entry.refs++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (!entry.refs && entry.url) {
          URL.revokeObjectURL(entry.url);
          entry.url = undefined;
        }
      },
    };
  }
  async resolveRenderable(source: string, signal?: AbortSignal): Promise<{ url: string; release(): void }> {
    const lease = await this.retain(source, signal),
      entry = this.cache.get(source)!;
    try {
      signal?.throwIfAborted();
      entry.url ??= URL.createObjectURL(
        new Blob([entry.bytes as Uint8Array<ArrayBuffer>], { type: storyResourceContentType(source, entry.bytes) }),
      );
      return { url: entry.url, release: lease.release };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  dispose(): void {
    this.lifetime.abort(new DOMException("Public source closed", "AbortError"));
    for (const value of this.cache.values())
      if (value.url) {
        URL.revokeObjectURL(value.url);
        value.url = undefined;
      }
    this.cache.clear();
    this.totalBytes = 0;
  }
}
export function createStudioPublicResourceHost(options: {
  factories: PublicResourceFactories;
  transport?: PublicCatalogTransport;
  createResources?: (scope: PublicSourceScope) => StoryResourceResolver & { dispose?(): void };
}): StudioPublicResourceHost {
  return {
    async connect(source, signal) {
      const scope =
        source.provider === "haneoka" && !source.releaseId
          ? await resolveHaneokaPublicScope({ ...source, signal, transport: options.transport })
          : validatePublicScope(source);
      signal.throwIfAborted();
      if (scope.provider === "sekai") throw new TypeError("This source provides story projects");
      const resources = options.createResources?.(scope) ?? new PublicHttpResources(scope);
      try {
        const catalog =
          scope.provider === "haneoka"
            ? createHaneokaPublicResourceCatalog({
                scope,
                factory: options.factories.haneoka,
                resources,
                transport: options.transport,
              })
            : createBestdoriPublicResourceCatalog({
                scope,
                factory: options.factories.bestdori,
                resources,
                transport: options.transport,
              });
        let disposed = false;
        return {
          catalog,
          dispose() {
            if (disposed) return;
            disposed = true;
            try {
              catalog.dispose();
            } finally {
              resources.dispose?.();
            }
          },
        };
      } catch (error) {
        resources.dispose?.();
        throw error;
      }
    },
  };
}
