import { tr } from "./i18n";
export interface ProjectFile {
  readonly path: string;
  readonly blob: Blob;
}
export interface LibraryProject {
  readonly id: string;
  readonly revision?: number;
  readonly name: string;
  readonly updatedAt: number;
  readonly files: readonly ProjectFile[];
  readonly directories?: readonly string[];
  readonly directory?: BrowserWorkspaceDirectoryHandle;
}
export interface ProjectRecoveryCopy {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly createdAt: number;
  readonly files: readonly ProjectFile[];
  readonly directories: readonly string[];
  readonly scenes: readonly { id: string; path: string }[];
}
async function commitProject(
  project: LibraryProject,
  expected?: number,
  check = false,
  recovery?: ProjectRecoveryCopy,
  removeRecovery?: string,
): Promise<LibraryProject> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["projects", "recovery"], "readwrite"),
      store = transaction.objectStore("projects");
    const read = store.get(project.id);
    let saved: LibraryProject;
    let failure: Error | undefined;
    read.onsuccess = () => {
      const current = read.result as LibraryProject | undefined;
      if (check && (current?.revision ?? 0) !== (expected ?? 0)) {
        failure = new Error(tr("The project changed in another window. Save again to check for conflicts."));
        transaction.abort();
        return;
      }
      saved = { ...project, revision: (current?.revision ?? 0) + 1 };
      store.put(saved);
      if (recovery) transaction.objectStore("recovery").put(recovery);
      if (removeRecovery) transaction.objectStore("recovery").delete(removeRecovery);
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Project save aborted"));
  });
}
export interface ProjectDraft {
  readonly projectId: string;
  readonly documents: readonly {
    path: string;
    baseline: string;
    text: string;
  }[];
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("altair-project-library", 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      database = undefined;
      reject(new Error(tr("Close other Altair windows to update project storage")));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("recovery"))
        db.createObjectStore("recovery", { keyPath: "id" }).createIndex("projectId", "projectId");
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
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
  }));
}
async function request<T>(
  table: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(table, mode),
      operation = run(transaction.objectStore(table));
    let value: T;
    operation.onsuccess = () => {
      value = operation.result;
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Storage transaction aborted"));
  });
}
export const projectLibrary = {
  list: () => request("projects", "readonly", (store) => store.getAll()) as Promise<LibraryProject[]>,
  get: (id: string) => request("projects", "readonly", (store) => store.get(id)) as Promise<LibraryProject | undefined>,
  put: (project: LibraryProject) => commitProject(project),
  commit: (project: LibraryProject, expected?: number, recovery?: ProjectRecoveryCopy, removeRecovery?: string) =>
    commitProject(project, expected, true, recovery, removeRecovery),
  remove: async (id: string): Promise<void> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["projects", "drafts", "recovery"], "readwrite");
      transaction.objectStore("projects").delete(id);
      transaction.objectStore("drafts").delete(id);
      const copies = transaction.objectStore("recovery").index("projectId").openKeyCursor(IDBKeyRange.only(id));
      copies.onsuccess = () => {
        if (!copies.result) return;
        transaction.objectStore("recovery").delete(copies.result.primaryKey);
        copies.result.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Project removal aborted"));
    });
  },
  draft: (id: string) => request("drafts", "readonly", (store) => store.get(id)) as Promise<ProjectDraft | undefined>,
  saveDraft: (draft: ProjectDraft) => request("drafts", "readwrite", (store) => store.put(draft)),
  recoveryCopies: (projectId: string) =>
    request("recovery", "readonly", (store) => store.index("projectId").getAll(projectId)) as Promise<
      ProjectRecoveryCopy[]
    >,
  recoveryCopy: (id: string) =>
    request("recovery", "readonly", (store) => store.get(id)) as Promise<ProjectRecoveryCopy | undefined>,
  saveRecoveryCopy: (copy: ProjectRecoveryCopy) => request("recovery", "readwrite", (store) => store.put(copy)),
  removeRecoveryCopy: (id: string) => request("recovery", "readwrite", (store) => store.delete(id)),
};
import type { BrowserWorkspaceDirectoryHandle } from "@haneoka/altair-plugin-workspace-browser";
