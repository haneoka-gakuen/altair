import type {
  ResourceBrowserProvider,
  ResourceBrowserRequest,
  ResourceBrowserFile,
  ResourceBrowserPath,
} from "@haneoka/altair/resource-browser";
import type { StoryResourceResolver } from "@haneoka/vega/renderer-kit";
import { PublicResourceCatalog } from "./resource-catalog";
import { validatePublicScope, type PublicSourceScope } from "./resource-manifest";
import { readPublicResponse } from "./public-response";

/** Factories are public source plugins supplied by the host; no platform registry is created here. */
export type BestdoriAssetNode = number | { readonly [name: string]: BestdoriAssetNode };
export interface BestdoriAssetIndex {
  readonly server: string;
  readonly tree: Readonly<Record<string, BestdoriAssetNode>>;
}
export interface BestdoriAssetBundle {
  readonly server: string;
  readonly path: string;
  readonly files: readonly string[];
}
export interface PublicResourceFactories {
  haneoka(adapter: {
    fetchCatalog(request: {
      release: string;
      resource: string;
      kind: string;
      view?: string;
      signal: AbortSignal;
    }): Promise<unknown>;
    fetchAsset(request: { release: string; path: string; signal: AbortSignal }): Promise<unknown>;
  }): ResourceBrowserProvider;
  bestdori(options: {
    server: "jp" | "en" | "tw" | "cn" | "kr";
    adapter: {
      fetchIndex(request: { server: string; signal: AbortSignal }): Promise<BestdoriAssetIndex>;
      fetchBundle(request: {
        server: string;
        path: readonly string[];
        signal: AbortSignal;
      }): Promise<BestdoriAssetBundle>;
      resolveRawUrl(path: string, server: string): string;
      fetchLive2d(request: {
        server: string;
        costumeId: string;
        signal: AbortSignal;
      }): Promise<Readonly<Record<string, unknown>> | undefined>;
    };
  }): ResourceBrowserProvider;
}
export type PublicCatalogTransport = (url: string, signal: AbortSignal) => Promise<unknown>;
export async function fetchPublicCatalogJson(url: string, signal: AbortSignal): Promise<unknown> {
  const bytes = await readPublicResponse(url, {
    label: "Public catalog",
    maxBytes: 16 * 1024 * 1024,
    signals: [signal],
    json: true,
  });
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder().decode(bytes));
}

function catalogUrl(scope: PublicSourceScope, path: readonly string[]): string {
  const url = new URL(
    `/api/v1/servers/${encodeURIComponent(scope.server)}/${path.map(encodeURIComponent).join("/")}`,
    scope.origin,
  );
  url.searchParams.set("release", scope.releaseId!);
  return url.href;
}
function safeSegments(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f]/u.test(part)))
    throw new TypeError("Invalid public catalog path");
  return parts;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function createHaneokaPublicResourceCatalog(options: {
  scope: PublicSourceScope;
  factory: PublicResourceFactories["haneoka"];
  resources: StoryResourceResolver;
  transport?: PublicCatalogTransport;
}): PublicResourceCatalog {
  const scope = validatePublicScope(options.scope);
  if (scope.provider !== "haneoka") throw new TypeError("Expected Haneoka source");
  const transport = options.transport ?? fetchPublicCatalogJson;
  const provider = options.factory({
    fetchCatalog: (request) => {
      if (request.release !== scope.releaseId) throw new Error("Catalog release changed");
      const parts = safeSegments(request.resource);
      if (request.view) parts.push("views", ...safeSegments(request.view));
      return transport(catalogUrl(scope, parts), request.signal);
    },
    fetchAsset: (request) => {
      if (request.release !== scope.releaseId) throw new Error("Catalog release changed");
      const endpoint = new URL(
        `/assets/${scope.server}/${safeSegments(request.path).map(encodeURIComponent).join("/")}`,
        scope.origin,
      );
      endpoint.searchParams.set("release", scope.releaseId!);
      return transport(endpoint.href, request.signal);
    },
  });
  return new PublicResourceCatalog(provider, scope, options.resources);
}
export function createBestdoriPublicResourceCatalog(options: {
  scope: PublicSourceScope;
  factory: PublicResourceFactories["bestdori"];
  resources: StoryResourceResolver;
  transport?: PublicCatalogTransport;
}): PublicResourceCatalog {
  const scope = validatePublicScope(options.scope);
  if (scope.provider !== "bestdori") throw new TypeError("Expected Bestdori source");
  const transport = options.transport ?? fetchPublicCatalogJson;
  const url = (parts: readonly string[]) =>
    new URL(`/api/v1/garupa/bestdori/${scope.server}/${parts.map(encodeURIComponent).join("/")}`, scope.origin).href;
  const check = (server: string) => {
    if (server !== scope.server) throw new Error("Bestdori server changed");
  };
  const provider = options.factory({
    server: scope.server as "jp" | "en" | "tw" | "cn" | "kr",
    adapter: {
      fetchIndex: async (request) => {
        check(request.server);
        const body = object(await transport(url(["editor-assets"]), request.signal));
        if (body.server !== scope.server || !body.tree || typeof body.tree !== "object" || Array.isArray(body.tree))
          throw new TypeError("Invalid Bestdori asset index");
        const pending: unknown[] = [body.tree];
        let count = 0;
        while (pending.length) {
          if (++count > 200_000) throw new TypeError("Bestdori asset index is too large");
          const node = pending.pop();
          if (typeof node === "number" && Number.isSafeInteger(node) && node >= 0) continue;
          if (!node || typeof node !== "object" || Array.isArray(node))
            throw new TypeError("Invalid Bestdori asset index");
          for (const [key, child] of Object.entries(node)) {
            if (safeSegments(key).length !== 1) throw new TypeError("Invalid Bestdori asset index");
            pending.push(child);
          }
        }
        return body as unknown as BestdoriAssetIndex;
      },
      fetchBundle: async (request) => {
        check(request.server);
        request.path.forEach(safeSegments);
        const body = object(await transport(url(["editor-assets", ...request.path]), request.signal));
        if (
          body.server !== scope.server ||
          typeof body.path !== "string" ||
          !Array.isArray(body.files) ||
          body.files.length > 20_000 ||
          body.files.some((file) => typeof file !== "string" || safeSegments(file).length !== 1)
        )
          throw new TypeError("Invalid Bestdori asset bundle");
        return body as unknown as BestdoriAssetBundle;
      },
      resolveRawUrl: (path, server) => {
        check(server);
        return url(["raw", ...safeSegments(path.replace(/^\//u, ""))]);
      },
      fetchLive2d: async (request) => {
        check(request.server);
        const endpoint = new URL(url(["live2d"]));
        endpoint.searchParams.set("id", request.costumeId);
        endpoint.searchParams.set("server", scope.server);
        const body = object(await transport(endpoint.href, request.signal));
        return object(body.items)[request.costumeId] as Readonly<Record<string, unknown>> | undefined;
      },
    },
  });
  return new PublicResourceCatalog(provider, scope, options.resources);
}
/** No roots or network: publishing and browsing shared community packs remain on hold. */
export const COMMUNITY_RESOURCE_PUBLICATION_HOLD = Object.freeze({
  status: "publication-hold" as const,
  provider: Object.freeze({
    id: "community.assets.hold",
    name: "Community shared assets",
    roots: Object.freeze([]),
    preferredPath: (_request: ResourceBrowserRequest) => Object.freeze([]),
    list: (_path: ResourceBrowserPath, _request: ResourceBrowserRequest) => Object.freeze([]),
    open: (_file: ResourceBrowserFile, _request: ResourceBrowserRequest) => undefined,
  } satisfies ResourceBrowserProvider),
});

/** Resolve the compact identity once, then keep all browsing pinned to that release. */
export async function resolveHaneokaPublicScope(options: {
  origin: string;
  server: string;
  signal: AbortSignal;
  transport?: PublicCatalogTransport;
}): Promise<PublicSourceScope> {
  if (!/^[a-z\d-]{1,40}$/u.test(options.server)) throw new TypeError("Invalid public resource server");
  const endpoint = new URL(`/api/v1/servers/${options.server}/release?projection=identity`, options.origin);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new TypeError("Invalid public resource origin");
  const value = object(await (options.transport ?? fetchPublicCatalogJson)(endpoint.href, options.signal));
  options.signal.throwIfAborted();
  if (
    value.schema !== "haneoka-resource-release-identity-v1" ||
    value.server !== options.server ||
    typeof value.releaseId !== "string" ||
    typeof value.sourceId !== "string"
  )
    throw new TypeError("Invalid public release identity");
  return validatePublicScope({
    provider: "haneoka",
    origin: endpoint.origin,
    server: options.server,
    releaseId: value.releaseId,
    sourceId: value.sourceId,
  });
}
