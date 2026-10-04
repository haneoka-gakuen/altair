import { readProjectZip, type ProjectArchive } from "./archive";

export interface WebGalEngineManifest {
  readonly schemaVersion: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly webgalVersion: string;
  readonly type: string;
  readonly license?: string;
}
export interface WebGalEngine extends ProjectArchive {
  readonly key: string;
  readonly manifest: WebGalEngineManifest;
  readonly hash: string;
  readonly installedAt: number;
  readonly size: number;
}
export interface WebGalEngineRef {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
}
export const WEBGAL_ENGINE_EXTENSION = "altair:webgalEngine";
export const webGalEngineLicense = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export function webGalEngineRef(value: unknown): WebGalEngineRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  return typeof ref.id === "string" &&
    typeof ref.version === "string" &&
    typeof ref.hash === "string" &&
    /^[a-f\d]{64}$/u.test(ref.hash)
    ? { id: ref.id, version: ref.version, hash: ref.hash }
    : undefined;
}
export const webGalEngineKey = (id: string, version: string) => JSON.stringify([id, version]);
/** Validate compiled web distributions; never evaluate archive JavaScript during installation. */
export async function inspectWebGalEngine(archive: Blob, signal?: AbortSignal): Promise<WebGalEngine> {
  if (archive.size > 256 * 1024 * 1024) throw new Error("The engine archive exceeds 256 MB");
  const contents = await readProjectZip(archive, signal, { maxBytes: 512 * 1024 * 1024 });
  const byPath = new Map(contents.files.map((file) => [file.path, file]));
  const descriptor = byPath.get("webgal-engine.json");
  if (!descriptor || descriptor.blob.size > 64 * 1024) throw new Error("Engine manifest is missing or too large");
  const data: unknown = JSON.parse(await descriptor.blob.text());
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid WebGAL engine manifest");
  const manifest = data as WebGalEngineManifest;
  if (manifest.license !== undefined && webGalEngineLicense(manifest.license) === undefined)
    throw new Error("Invalid WebGAL engine manifest");
  for (const field of ["schemaVersion", "id", "name", "version", "webgalVersion", "type"] as const)
    if (typeof manifest[field] !== "string" || !manifest[field].trim() || manifest[field].length > 256)
      throw new Error("Invalid WebGAL engine manifest");
  if (!/^1(?:\.\d+){0,2}$/u.test(manifest.schemaVersion)) throw new Error("Unsupported WebGAL engine manifest schema");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/iu.test(manifest.webgalVersion))
    throw new Error("Invalid WebGAL engine version");
  if (!byPath.has("index.html") || !byPath.has("game/config.txt") || !contents.directories.includes("game/template"))
    throw new Error("This archive is not a compiled WebGAL engine");
  const size = contents.files.reduce((total, file) => total + file.blob.size, 0);
  if (size > 512 * 1024 * 1024) throw new Error("The installed engine exceeds 512 MB");
  const html = byPath.get("index.html")!.blob;
  if (html.size > 1024 * 1024) throw new Error("Engine index is too large");
  const source = await html.text();
  const scripts = [...source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu)];
  if (
    !scripts.some(([, src]) => {
      if (!src || /^(?:[a-z]+:|\/\/)/iu.test(src)) return false;
      const path = new URL(src, "https://engine.invalid/").pathname.slice(1);
      return /\.js$/iu.test(path) && byPath.has(decodeURIComponent(path));
    })
  )
    throw new Error("This archive is not a compiled WebGAL engine");
  signal?.throwIfAborted();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await archive.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  signal?.throwIfAborted();
  return {
    ...contents,
    key: webGalEngineKey(manifest.id, manifest.version),
    manifest,
    hash,
    installedAt: Date.now(),
    size,
  };
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("altair-webgal-engines", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("engines", { keyPath: "key" });
      request.result.createObjectStore("metadata", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error("Engine storage is blocked"));
    };
  }));
}
export type WebGalEngineMetadata = Omit<WebGalEngine, "files" | "directories">;
export const webGalEngines = {
  async list(): Promise<WebGalEngineMetadata[]> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction("metadata").objectStore("metadata").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async get(ref: WebGalEngineRef): Promise<WebGalEngine> {
    const db = await open();
    const engine = await new Promise<WebGalEngine | undefined>((resolve, reject) => {
      const request = db.transaction("engines").objectStore("engines").get(webGalEngineKey(ref.id, ref.version));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!engine || engine.hash !== ref.hash) throw new Error("The project's WebGAL engine is not installed");
    return engine;
  },
  async install(archive: Blob, signal?: AbortSignal): Promise<WebGalEngineRef> {
    const engine = await inspectWebGalEngine(archive, signal),
      db = await open();
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["engines", "metadata"], "readwrite");
      const abort = () => tx.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const request = tx.objectStore("metadata").get(engine.key);
      let conflict = false;
      request.onsuccess = () => {
        if (request.result) {
          if (request.result.hash !== engine.hash) {
            conflict = true;
            tx.abort();
          }
          return;
        }
        const { files: _, directories: __, ...metadata } = engine;
        tx.objectStore("engines").add(engine);
        tx.objectStore("metadata").add(metadata);
      };
      tx.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        signal?.removeEventListener("abort", abort);
        reject(
          conflict
            ? new Error("A different archive with this engine ID and version is already installed")
            : (signal?.reason ?? tx.error ?? new Error("Engine storage was interrupted")),
        );
      };
      if (signal?.aborted) abort();
    });
    return { id: engine.manifest.id, version: engine.manifest.version, hash: engine.hash };
  },
  async remove(ref: WebGalEngineRef): Promise<void> {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["engines", "metadata"], "readwrite");
      const key = webGalEngineKey(ref.id, ref.version);
      tx.objectStore("engines").delete(key);
      tx.objectStore("metadata").delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Engine storage was interrupted"));
    });
  },
};
