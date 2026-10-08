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
export interface NativeImportEntry {
  readonly path: string;
  readonly before?: Blob;
  readonly beforeHash?: string;
  readonly after: Blob;
  readonly afterHash: string;
  readonly started?: boolean;
}
export interface NativeImportJournal {
  readonly schema: "altair-native-import-v1";
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly beforeProject: LibraryProject;
  readonly afterProject: LibraryProject;
  readonly directory: BrowserWorkspaceDirectoryHandle;
  readonly entries: readonly NativeImportEntry[];
  readonly newDirectories: readonly string[];
  readonly externalCopies?: readonly ProjectFile[];
  readonly result?: "committed" | "restored";
}
async function commitProject(
  project: LibraryProject,
  expected?: number,
  check = false,
  recovery?: ProjectRecoveryCopy,
  removeRecovery?: string,
  guard?: () => void,
  signal?: AbortSignal,
  clearDraft = false,
  nativeImportId?: string,
): Promise<LibraryProject> {
  const db = await open();
  signal?.throwIfAborted();
  guard?.();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
        ["projects", "recovery", "nativeImports", "nativeImportBackups", ...(clearDraft ? ["drafts"] : [])],
        "readwrite",
      ),
      store = transaction.objectStore("projects");
    const journalRead = transaction.objectStore("nativeImports").get(project.id);
    let saved: LibraryProject;
    let failure: Error | undefined;
    const abort = () => {
      try {
        transaction.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    journalRead.onsuccess = () => {
      const journal = journalRead.result as NativeImportJournal | undefined;
      if ((journal && journal.id !== nativeImportId) || (nativeImportId && !journal)) {
        failure = new Error(tr("Review the unfinished native import before saving this project."));
        abort();
        return;
      }
      const read = store.get(project.id);
      read.onsuccess = () => {
        try {
          signal?.throwIfAborted();
          guard?.();
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
          if (clearDraft) transaction.objectStore("drafts").delete(project.id);
          if (journal) {
            transaction.objectStore("nativeImportBackups").put({ ...journal, result: "committed" });
            transaction.objectStore("nativeImports").delete(project.id);
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          abort();
        }
      };
    };
    const clean = () => signal?.removeEventListener("abort", abort);
    transaction.oncomplete = () => {
      clean();
      resolve(saved);
    };
    transaction.onerror = () => {
      // Aborted requests can report an error before the transaction has an error value.
      // Settle on abort, after IndexedDB has rolled back every store in the transaction.
      failure ??= transaction.error ?? undefined;
    };
    transaction.onabort = () => {
      clean();
      reject(failure ?? signal?.reason ?? transaction.error ?? new Error("Project save aborted"));
    };
    if (signal?.aborted) abort();
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
    const request = indexedDB.open("altair-project-library", 3);
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
      if (!db.objectStoreNames.contains("nativeImports"))
        db.createObjectStore("nativeImports", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("nativeImportBackups"))
        db.createObjectStore("nativeImportBackups", { keyPath: "id" }).createIndex("projectId", "projectId");
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
async function editNativeJournal<T>(
  projectId: string,
  edit: (context: {
    project?: LibraryProject;
    journal?: NativeImportJournal;
    projects: IDBObjectStore;
    active: IDBObjectStore;
    backups: IDBObjectStore;
  }) => T,
  signal?: AbortSignal,
): Promise<T> {
  const db = await open();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "nativeImports", "nativeImportBackups"], "readwrite"),
      active = tx.objectStore("nativeImports");
    let value: T, failure: unknown;
    const abort = () => {
      try {
        tx.abort();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const journalRead = active.get(projectId);
    journalRead.onsuccess = () => {
      const projectRead = tx.objectStore("projects").get(projectId);
      projectRead.onsuccess = () => {
        try {
          signal?.throwIfAborted();
          value = edit({
            project: projectRead.result,
            journal: journalRead.result,
            projects: tx.objectStore("projects"),
            active,
            backups: tx.objectStore("nativeImportBackups"),
          });
        } catch (error) {
          failure = error;
          abort();
        }
      };
    };
    const clean = () => signal?.removeEventListener("abort", abort);
    tx.oncomplete = () => {
      clean();
      resolve(value);
    };
    tx.onabort = () => {
      clean();
      reject(failure ?? signal?.reason ?? tx.error ?? new Error("Native import journal interrupted"));
    };
  });
}
export const projectLibrary = {
  list: () => request("projects", "readonly", (store) => store.getAll()) as Promise<LibraryProject[]>,
  get: (id: string) => request("projects", "readonly", (store) => store.get(id)) as Promise<LibraryProject | undefined>,
  put: (project: LibraryProject) => commitProject(project),
  commit: (
    project: LibraryProject,
    expected?: number,
    recovery?: ProjectRecoveryCopy,
    removeRecovery?: string,
    guard?: () => void,
    signal?: AbortSignal,
    clearDraft = false,
    nativeImportId?: string,
  ) => commitProject(project, expected, true, recovery, removeRecovery, guard, signal, clearDraft, nativeImportId),
  nativeImports: () =>
    request("nativeImports", "readonly", (store) => store.getAll()) as Promise<NativeImportJournal[]>,
  nativeImport: (projectId: string) =>
    request("nativeImports", "readonly", (store) => store.get(projectId)) as Promise<NativeImportJournal | undefined>,
  beginNativeImport: (journal: NativeImportJournal, guard: () => void, signal?: AbortSignal) =>
    editNativeJournal(
      journal.projectId,
      ({ project, journal: pending, active }) => {
        guard();
        if (pending) throw new Error(tr("Review the unfinished native import before saving this project."));
        if (!project || project.revision !== journal.beforeProject.revision)
          throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
        active.add(journal);
      },
      signal,
    ),
  updateNativeImport: (projectId: string, id: string, update: (journal: NativeImportJournal) => NativeImportJournal) =>
    editNativeJournal(projectId, ({ journal, active }) => {
      if (!journal || journal.id !== id) throw new Error("Native import journal changed");
      const next = update(journal);
      if (next.id !== id || next.projectId !== projectId) throw new Error("Native import journal identity changed");
      active.put(next);
      return next;
    }),
  finishNativeImportRestore: (projectId: string, id: string) =>
    editNativeJournal(projectId, ({ journal, project, projects, active, backups }) => {
      if (!journal || journal.id !== id) throw new Error("Native import journal changed");
      if (project?.revision !== journal.beforeProject.revision)
        throw new Error(tr("The project changed in another window. Save again to check for conflicts."));
      backups.put({ ...journal, result: "restored" });
      const restored = { ...journal.beforeProject, revision: (project?.revision ?? 0) + 1, updatedAt: Date.now() };
      projects.put(restored);
      active.delete(projectId);
      return restored;
    }),
  nativeImportBackups: (projectId: string) =>
    request("nativeImportBackups", "readonly", (store) => store.index("projectId").getAll(projectId)) as Promise<
      NativeImportJournal[]
    >,
  remove: async (id: string): Promise<void> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        ["projects", "drafts", "recovery", "nativeImports", "nativeImportBackups"],
        "readwrite",
      );
      const pending = transaction.objectStore("nativeImports").get(id);
      let failure: Error | undefined;
      pending.onsuccess = () => {
        if (pending.result) {
          failure = new Error(tr("Review the unfinished native import before saving this project."));
          transaction.abort();
        }
      };
      transaction.objectStore("projects").delete(id);
      transaction.objectStore("drafts").delete(id);
      const copies = transaction.objectStore("recovery").index("projectId").openKeyCursor(IDBKeyRange.only(id));
      copies.onsuccess = () => {
        if (!copies.result) return;
        transaction.objectStore("recovery").delete(copies.result.primaryKey);
        copies.result.continue();
      };
      const nativeCopies = transaction
        .objectStore("nativeImportBackups")
        .index("projectId")
        .openKeyCursor(IDBKeyRange.only(id));
      nativeCopies.onsuccess = () => {
        if (!nativeCopies.result) return;
        transaction.objectStore("nativeImportBackups").delete(nativeCopies.result.primaryKey);
        nativeCopies.result.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Project removal aborted"));
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
