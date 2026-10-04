import { BrowserWorkspaceService, type AltairBrowserWorkspaceService } from "@haneoka/altair-plugin-workspace-browser";
import { projectFilePath } from "./file-operations";

export type HistoryKind =
  | "manual-save"
  | "manual-snapshot"
  | "auto-save"
  | "before-save"
  | "before-restore"
  | "restore"
  | "system-refactor";
export interface HistoryPolicy {
  enabled: boolean;
  maxVersions: number;
  maxDays: number;
}
export interface HistoryEntry {
  readonly version: 1;
  readonly projectId: string;
  readonly id: string;
  readonly path: string;
  readonly originalPath: string;
  readonly createdAt: number;
  readonly kind: HistoryKind;
  readonly hash: string;
  readonly size: number;
}
export const DEFAULT_HISTORY_POLICY: Readonly<HistoryPolicy> = Object.freeze({
  enabled: true,
  maxVersions: 50,
  maxDays: 30,
});
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const AUTO_INTERVAL_MS = 5 * 60 * 1000;
const kinds = new Set<HistoryKind>([
  "manual-save",
  "manual-snapshot",
  "auto-save",
  "before-save",
  "before-restore",
  "restore",
  "system-refactor",
]);
const hashText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};
function policyValue(value: unknown): HistoryPolicy {
  const v = value as HistoryPolicy;
  if (
    !v ||
    typeof v.enabled !== "boolean" ||
    !Number.isInteger(v.maxVersions) ||
    v.maxVersions < 1 ||
    v.maxVersions > 1000 ||
    !Number.isInteger(v.maxDays) ||
    v.maxDays < 1 ||
    v.maxDays > 3650
  )
    throw new TypeError("Invalid history settings");
  return { enabled: v.enabled, maxVersions: v.maxVersions, maxDays: v.maxDays };
}
function entryValue(value: unknown, projectId: string): HistoryEntry {
  const v = value as HistoryEntry;
  if (
    !v ||
    v.version !== 1 ||
    v.projectId !== projectId ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(v.id) ||
    !kinds.has(v.kind) ||
    !/^[a-f\d]{64}$/u.test(v.hash) ||
    !Number.isFinite(v.createdAt) ||
    !Number.isInteger(v.size) ||
    v.size < 0 ||
    v.size > MAX_TEXT_BYTES
  )
    throw new TypeError("History metadata is damaged");
  projectFilePath(v.path);
  projectFilePath(v.originalPath);
  return v;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("altair-document-history", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: ["projectId", "id"] }).createIndex("projectId", "projectId");
      db.createObjectStore("contents", { keyPath: ["projectId", "id"] });
      db.createObjectStore("settings", { keyPath: "projectId" });
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
  }));
}
async function databaseRequest<T>(table: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, "readonly"),
      operation = run(tx.objectStore(table));
    let value: T;
    operation.onsuccess = () => {
      value = operation.result;
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("History storage aborted"));
  });
}
interface HistoryBackend {
  autoWritable(): Promise<boolean>;
  list(): Promise<HistoryEntry[]>;
  text(id: string): Promise<string>;
  put(entry: HistoryEntry, text: string): Promise<void>;
  remove(entries: readonly HistoryEntry[]): Promise<void>;
  move(paths: ReadonlyMap<string, string>): Promise<void>;
  dispose(): void;
}
class BrowserHistory implements HistoryBackend {
  constructor(private projectId: string) {}
  async autoWritable() {
    return true;
  }
  async list() {
    return (await databaseRequest("entries", (store) => store.index("projectId").getAll(this.projectId))).map(
      (v: unknown) => entryValue(v, this.projectId),
    );
  }
  async text(id: string) {
    const value = await databaseRequest("contents", (store) => store.get([this.projectId, id]));
    if (!value || typeof value.text !== "string") throw new Error("History content is missing");
    return value.text;
  }
  async put(entry: HistoryEntry, text: string) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["entries", "contents"], "readwrite");
      tx.objectStore("entries").add(entry);
      tx.objectStore("contents").add({ projectId: this.projectId, id: entry.id, text });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("History storage aborted"));
    });
  }
  async remove(entries: readonly HistoryEntry[]) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["entries", "contents"], "readwrite");
      for (const entry of entries) {
        const key = [this.projectId, entry.id];
        tx.objectStore("entries").delete(key);
        tx.objectStore("contents").delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("History storage aborted"));
    });
  }
  async move(paths: ReadonlyMap<string, string>) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite"),
        cursor = tx.objectStore("entries").index("projectId").openCursor(this.projectId);
      let failure: unknown;
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        try {
          const entry = entryValue(row.value, this.projectId),
            path = paths.get(entry.path);
          if (path) row.update({ ...entry, path });
          row.continue();
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("History storage aborted"));
    });
  }
  dispose() {}
}
class FolderHistory implements HistoryBackend {
  private store?: BrowserWorkspaceService;
  private readonly folderKey: Promise<string>;
  private readonly root: AltairBrowserWorkspaceService["directory"];
  private readonly unsubscribe: () => void;
  private changed = false;
  async autoWritable() {
    return !this.changed && (await this.source.permission("readwrite", { request: false })) === "granted";
  }
  constructor(
    private projectId: string,
    private source: AltairBrowserWorkspaceService,
  ) {
    this.folderKey = hashText(projectId);
    this.root = source.directory;
    this.unsubscribe = source.subscribe(() => {
      if (source.directory !== this.root) {
        this.changed = true;
        this.store?.dispose();
      }
    });
  }
  private async workspace(create = false): Promise<BrowserWorkspaceService | undefined> {
    if (this.changed || this.source.directory !== this.root)
      throw new DOMException("Project folder changed", "AbortError");
    if (this.store) {
      await this.store.refresh();
      return this.store;
    }
    const root = this.source.directory;
    if (!root?.getDirectoryHandle) throw new Error("Folder history is unavailable");
    if (create && (await this.source.permission("readwrite", { request: true })) !== "granted")
      throw new Error("Folder history is unavailable");
    try {
      const base = await root.getDirectoryHandle(".altair-history", { create });
      const directory = await base.getDirectoryHandle!(await this.folderKey, { create });
      if (this.source.directory !== root) throw new DOMException("Project folder changed", "AbortError");
      const store = new BrowserWorkspaceService({
        includeHidden: true,
        ignoredDirectoryNames: [],
        maxFiles: 15_000,
        maxTotalBytes: MAX_PROJECT_BYTES * 2,
      });
      try {
        await store.connectDirectory(directory);
        if (this.changed || this.source.directory !== root)
          throw new DOMException("Project folder changed", "AbortError");
        this.store = store;
        return store;
      } catch (error) {
        store.dispose();
        throw error;
      }
    } catch (error) {
      if (!create && error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
  }
  async list() {
    const store = await this.workspace();
    if (!store) return [];
    const entries: HistoryEntry[] = [];
    for (const file of store.current.files.filter(
      (file) => file.path.startsWith("versions/") && file.path.endsWith(".json"),
    )) {
      if (entries.length >= MAX_ENTRIES) throw new Error("History storage exceeds its limit");
      if (file.size > 16_384) throw new TypeError("History metadata is damaged");
      const entry = entryValue(JSON.parse(await (await store.file(file.path)).text()), this.projectId);
      if (file.path !== `versions/${entry.id}.json`) throw new TypeError("History metadata is damaged");
      entries.push(entry);
    }
    return entries;
  }
  async text(id: string) {
    const store = await this.workspace();
    if (!store) throw new Error("History content is missing");
    return (await store.file(`contents/${id}.txt`)).text();
  }
  async put(entry: HistoryEntry, text: string) {
    const store = (await this.workspace(true))!;
    await store.write(`contents/${entry.id}.txt`, text, { create: true, exclusive: true });
    await store.write(`versions/${entry.id}.json`, JSON.stringify(entry), { create: true, exclusive: true });
  }
  async remove(entries: readonly HistoryEntry[]) {
    const store = await this.workspace();
    if (!store) return;
    for (const entry of entries) {
      if (store.match(`versions/${entry.id}.json`)) await store.remove!(`versions/${entry.id}.json`);
      if (store.match(`contents/${entry.id}.txt`)) await store.remove!(`contents/${entry.id}.txt`);
    }
  }
  async move(paths: ReadonlyMap<string, string>) {
    const entries = await this.list(),
      store = await this.workspace();
    if (!store) return;
    for (const entry of entries) {
      const path = paths.get(entry.path);
      if (path) await store.write(`versions/${entry.id}.json`, JSON.stringify({ ...entry, path }), { create: true });
    }
  }
  dispose() {
    this.unsubscribe();
    this.store?.dispose();
  }
}

/** Durable text versions are independent of the editor's in-memory undo stack. */
export class ProjectHistory {
  private task: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private backend: HistoryBackend;
  private folder: boolean;
  private readonly autoCheckedAt = new Map<string, number>();
  get location(): "folder" | "browser" {
    return this.folder ? "folder" : "browser";
  }
  constructor(
    readonly projectId: string,
    source?: AltairBrowserWorkspaceService,
  ) {
    this.folder = Boolean(source?.directory);
    this.backend = source?.directory ? new FolderHistory(projectId, source) : new BrowserHistory(projectId);
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("History is closed"));
    const task = this.task.catch(() => undefined).then(operation);
    this.task = task;
    return task;
  }
  async policy(): Promise<HistoryPolicy> {
    const settings = await databaseRequest("settings", (store) => store.get(this.projectId));
    return settings ? policyValue(settings.policy) : { ...DEFAULT_HISTORY_POLICY };
  }
  async setPolicy(value: HistoryPolicy): Promise<void> {
    const policy = policyValue(value),
      db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ projectId: this.projectId, policy });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("History storage aborted"));
    });
    await this.run(async () => this.prune(await this.backend.list(), policy));
  }
  list(path: string): Promise<readonly HistoryEntry[]> {
    path = projectFilePath(path);
    return this.run(async () => {
      const policy = await this.policy(),
        cutoff = Date.now() - policy.maxDays * 86_400_000;
      return (await this.backend.list())
        .filter((entry) => entry.path === path && entry.createdAt >= cutoff)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, policy.maxVersions);
    });
  }
  read(id: string, path: string): Promise<string> {
    return this.run(async () => {
      const entry = (await this.backend.list()).find(
        (entry) => entry.id === id && entry.path === projectFilePath(path),
      );
      if (!entry) throw new Error("History content is missing");
      const text = await this.backend.text(entry.id);
      if (new TextEncoder().encode(text).byteLength !== entry.size || (await hashText(text)) !== entry.hash)
        throw new Error("History content is damaged");
      return text;
    });
  }
  capture(path: string, text: string, kind: HistoryKind, force = false): Promise<HistoryEntry | undefined> {
    path = projectFilePath(path);
    return this.run(async () => {
      if (kind === "auto-save") {
        const last = this.autoCheckedAt.get(path) ?? 0;
        if (Date.now() - last < AUTO_INTERVAL_MS) return undefined;
        this.autoCheckedAt.set(path, Date.now());
        if (!(await this.backend.autoWritable())) return undefined;
      }
      const policy = await this.policy();
      if (!policy.enabled && !force) return undefined;
      const size = new TextEncoder().encode(text).byteLength;
      if (size > MAX_TEXT_BYTES) throw new Error("History source is too large");
      const entries = await this.backend.list(),
        hash = await hashText(text),
        now = Date.now();
      const latest = entries
        .filter((entry) => entry.path === path)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
      if (!force && latest?.hash === hash) {
        const existing = await this.backend.text(latest.id);
        if (new TextEncoder().encode(existing).byteLength !== latest.size || (await hashText(existing)) !== hash)
          throw new Error("History content is damaged");
        return undefined;
      }
      if (!force && kind === "auto-save" && latest && now - latest.createdAt < AUTO_INTERVAL_MS) return undefined;
      const entry: HistoryEntry = {
        version: 1,
        projectId: this.projectId,
        id: crypto.randomUUID(),
        path,
        originalPath: path,
        createdAt: Math.max(now, (latest?.createdAt ?? 0) + 1),
        kind,
        hash,
        size,
      };
      await this.backend.put(entry, text);
      // Retention is applied only after the new content and metadata are durable.
      await this.prune([...entries, entry], policy);
      return entry;
    });
  }
  move(paths: ReadonlyMap<string, string>): Promise<void> {
    for (const [from, to] of paths) {
      projectFilePath(from);
      projectFilePath(to);
    }
    return this.run(() => this.backend.move(paths));
  }
  attachFolder(source: AltairBrowserWorkspaceService): Promise<void> {
    return this.run(async () => {
      const next = new FolderHistory(this.projectId, source);
      try {
        for (const entry of await this.backend.list()) {
          const text = await this.backend.text(entry.id);
          if ((await hashText(text)) !== entry.hash) throw new Error("History content is damaged");
          await next.put(entry, text);
        }
      } catch (error) {
        next.dispose();
        throw error;
      }
      this.backend.dispose();
      this.backend = next;
      this.folder = true;
    });
  }
  private async prune(entries: readonly HistoryEntry[], policy: HistoryPolicy): Promise<void> {
    const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
      counts = new Map<string, number>(),
      remove: HistoryEntry[] = [];
    let bytes = 0,
      kept = 0;
    for (const entry of sorted) {
      const count = counts.get(entry.path) ?? 0;
      if (
        entry.createdAt < Date.now() - policy.maxDays * 86_400_000 ||
        count >= policy.maxVersions ||
        bytes + entry.size > MAX_PROJECT_BYTES ||
        kept >= MAX_ENTRIES
      )
        remove.push(entry);
      else {
        counts.set(entry.path, count + 1);
        bytes += entry.size;
        kept++;
      }
    }
    if (remove.length) await this.backend.remove(remove);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.task.catch(() => undefined);
    this.backend.dispose();
  }
}
