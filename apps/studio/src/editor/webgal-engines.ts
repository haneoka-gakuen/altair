import { readProjectZip, type ProjectArchive } from "./archive";
import { projectDirectories, projectFilePath } from "./file-operations";
import { abortableOperation } from "./abortable-operation";

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
  readonly contentHash?: string;
  readonly sourceKind?: "zip" | "folder";
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
const digest = async (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
async function contentHash(contents: ProjectArchive, signal?: AbortSignal): Promise<string> {
  const rows: [string, number, string][] = [];
  for (const file of [...contents.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    signal?.throwIfAborted();
    rows.push([file.path, file.blob.size, await digest(await file.blob.arrayBuffer())]);
  }
  signal?.throwIfAborted();
  return digest(
    new TextEncoder().encode(
      JSON.stringify(["webgal-engine-files-v1", rows, projectDirectories(contents.files, contents.directories)]),
    ),
  );
}
/** Validate compiled web distributions; never evaluate engine JavaScript during installation. */
async function inspectContents(
  contents: ProjectArchive,
  hash: string,
  kind: "zip" | "folder",
  signal?: AbortSignal,
): Promise<WebGalEngine> {
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
  const filesHash = await contentHash(contents, signal);
  signal?.throwIfAborted();
  return {
    ...contents,
    key: webGalEngineKey(manifest.id, manifest.version),
    manifest,
    hash: kind === "folder" ? filesHash : hash,
    contentHash: filesHash,
    sourceKind: kind,
    installedAt: Date.now(),
    size,
  };
}
export async function inspectWebGalEngine(archive: Blob, signal?: AbortSignal): Promise<WebGalEngine> {
  if (archive.size > 256 * 1024 * 1024) throw new Error("The engine archive exceeds 256 MB");
  const contents = await readProjectZip(archive, signal, { maxBytes: 512 * 1024 * 1024 });
  signal?.throwIfAborted();
  return inspectContents(contents, await digest(await archive.arrayBuffer()), "zip", signal);
}
export async function inspectWebGalEngineFolder(contents: ProjectArchive, signal?: AbortSignal): Promise<WebGalEngine> {
  signal?.throwIfAborted();
  const captured = contents.files.map((file) => ({ path: file.path, blob: file.blob })),
    dirs = [...contents.directories],
    paths = new Set<string>();
  let total = 0;
  for (const file of captured) {
    projectFilePath(file.path);
    if (!(file.blob instanceof Blob) || paths.has(file.path))
      throw new Error("The engine folder contains duplicate or invalid files");
    paths.add(file.path);
    total += file.blob.size;
  }
  const directories = projectDirectories(captured, dirs);
  if (total > 512 * 1024 * 1024) throw new Error("The installed engine exceeds 512 MB");
  if (captured.length + directories.length > 20_000) throw new Error("The engine folder contains too many entries");
  const files = [];
  for (const file of captured) {
    signal?.throwIfAborted();
    const blob =
      file.blob instanceof File
        ? new Blob([await abortableOperation(() => file.blob.arrayBuffer(), [signal])], { type: file.blob.type })
        : file.blob;
    files.push({ path: file.path, blob });
  }
  signal?.throwIfAborted();
  return inspectContents({ files, directories }, "", "folder", signal);
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("altair-webgal-engines", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore("engines", { keyPath: "key" });
      request.result.createObjectStore("metadata", { keyPath: "key" });
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      blocked = true;
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
    return installEngine(await inspectWebGalEngine(archive, signal), signal);
  },
  async installFolder(contents: ProjectArchive, signal?: AbortSignal): Promise<WebGalEngineRef> {
    return installEngine(await inspectWebGalEngineFolder(contents, signal), signal);
  },
  async remove(ref: WebGalEngineRef): Promise<void> {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["engines", "metadata"], "readwrite");
      const key = webGalEngineKey(ref.id, ref.version);
      const data = tx.objectStore("engines").get(key),
        metadata = tx.objectStore("metadata").get(key);
      let failure: Error | undefined;
      metadata.onsuccess = () => {
        if ((data.result && data.result.hash !== ref.hash) || (metadata.result && metadata.result.hash !== ref.hash)) {
          failure = new Error("Engine changed while uninstalling. Refresh the list.");
          tx.abort();
          return;
        }
        tx.objectStore("engines").delete(key);
        tx.objectStore("metadata").delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Engine storage was interrupted"));
    });
  },
};

async function installEngine(engine: WebGalEngine, signal?: AbortSignal): Promise<WebGalEngineRef> {
  const db = await open();
  signal?.throwIfAborted();
  const previous = await new Promise<WebGalEngine | undefined>((resolve, reject) => {
    const tx = db.transaction("engines"),
      read = tx.objectStore("engines").get(engine.key);
    let value: WebGalEngine | undefined;
    read.onsuccess = () => {
      value = read.result;
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error("Engine storage was interrupted"));
  });
  const previousContentHash = previous ? await contentHash(previous, signal) : undefined;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["engines", "metadata"], "readwrite");
    let failure: unknown, ref: WebGalEngineRef;
    const abort = () => {
      try {
        tx.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const existingData = tx.objectStore("engines").get(engine.key),
      existingMeta = tx.objectStore("metadata").get(engine.key);
    existingMeta.onsuccess = () => {
      try {
        signal?.throwIfAborted();
        const stored = existingData.result as WebGalEngine | undefined,
          metadata = existingMeta.result as WebGalEngineMetadata | undefined;
        if (stored || metadata) {
          if (!stored || !metadata || stored.hash !== metadata.hash) throw new Error("Engine storage is incomplete");
          const equal =
            stored.hash === engine.hash ||
            (stored.hash === previous?.hash ? previousContentHash : stored.contentHash) === engine.contentHash;
          if (!equal) throw new Error("A different archive with this engine ID and version is already installed");
          ref = { id: stored.manifest.id, version: stored.manifest.version, hash: stored.hash };
          return;
        }
        const { files: _, directories: __, ...metadataValue } = engine;
        tx.objectStore("engines").add(engine);
        tx.objectStore("metadata").add(metadataValue);
        ref = { id: engine.manifest.id, version: engine.manifest.version, hash: engine.hash };
      } catch (error) {
        failure = error;
        abort();
      }
    };
    const clean = () => signal?.removeEventListener("abort", abort);
    tx.oncomplete = () => {
      clean();
      resolve(ref);
    };
    tx.onabort = () => {
      clean();
      reject(failure ?? signal?.reason ?? tx.error ?? new Error("Engine storage was interrupted"));
    };
    if (signal?.aborted) abort();
  });
}
