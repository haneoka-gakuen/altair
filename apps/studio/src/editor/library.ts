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
  readonly directory?: BrowserWorkspaceDirectoryHandle;
}
async function commitProject(project: LibraryProject, expected?: number, check = false): Promise<LibraryProject> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("projects", "readwrite"),
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
    const request = indexedDB.open("altair-project-library", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("drafts", { keyPath: "projectId" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
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
  commit: (project: LibraryProject, expected?: number) => commitProject(project, expected, true),
  remove: (id: string) => request("projects", "readwrite", (store) => store.delete(id)),
  draft: (id: string) => request("drafts", "readonly", (store) => store.get(id)) as Promise<ProjectDraft | undefined>,
  saveDraft: (draft: ProjectDraft) => request("drafts", "readwrite", (store) => store.put(draft)),
};
import type { BrowserWorkspaceDirectoryHandle } from "@haneoka/altair-plugin-workspace-browser";
