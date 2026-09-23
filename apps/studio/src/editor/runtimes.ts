export const RUNTIME_LIBRARIES = [
  { id: "cubism", label: "Cubism 3 / 4 / 5", globalName: "Live2DCubismCore" },
  { id: "cubism2", label: "Cubism 2", globalName: "Live2D" },
] as const;
export type RuntimeLibraryId = (typeof RUNTIME_LIBRARIES)[number]["id"];
export interface RuntimeLibrary {
  id: RuntimeLibraryId;
  name: string;
  blob: Blob;
  updatedAt: number;
  revision: string;
}
let database: Promise<IDBDatabase> | undefined;
const urls = new Map<RuntimeLibraryId, { revision: string; url: string }>();
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("studioRuntimes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("libraries", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("libraries", mode),
      request = run(tx.objectStore("libraries"));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? Error("Runtime storage was interrupted"));
  });
}
export const runtimeLibraries = {
  list: () => operation("readonly", (store) => store.getAll()) as Promise<RuntimeLibrary[]>,
  async install(id: RuntimeLibraryId, file: File): Promise<void> {
    if (file.size > 16 * 1024 * 1024) throw new Error("The runtime file exceeds 16 MB");
    const source = await file.text(),
      definition = RUNTIME_LIBRARIES.find((library) => library.id === id)!;
    if (!source.includes(definition.globalName)) throw new Error("This file does not contain the selected runtime");
    await operation("readwrite", (store) =>
      store.put({
        id,
        name: file.name,
        blob: new Blob([source], { type: "text/javascript" }),
        updatedAt: Date.now(),
        revision: crypto.randomUUID(),
      } satisfies RuntimeLibrary),
    );
  },
  remove: (id: RuntimeLibraryId) => operation("readwrite", (store) => store.delete(id)),
  async sources(): Promise<{ cubismCoreUrl?: string; cubism2CoreUrl?: string }> {
    const stored = await this.list(),
      result = { cubismCoreUrl: "/Core/live2dcubismcore.js", cubism2CoreUrl: "/Core/live2d.min.js" };
    for (const [id, entry] of urls)
      if (!stored.some((library) => library.id === id)) {
        URL.revokeObjectURL(entry.url);
        urls.delete(id);
      }
    for (const item of stored) {
      let entry = urls.get(item.id);
      if (!entry || entry.revision !== item.revision) {
        if (entry) URL.revokeObjectURL(entry.url);
        entry = { revision: item.revision, url: URL.createObjectURL(item.blob) };
        urls.set(item.id, entry);
      }
      result[item.id === "cubism" ? "cubismCoreUrl" : "cubism2CoreUrl"] = entry.url;
    }
    return result;
  },
};
