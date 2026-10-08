import type {
  AltairBrowserWorkspaceService,
  AltairBrowserWorkspaceFile,
} from "@haneoka/altair-plugin-workspace-browser";
import {
  projectLibrary,
  type LibraryProject,
  type NativeImportEntry,
  type NativeImportJournal,
  type ProjectFile,
} from "./library";
import { projectFilePath } from "./file-operations";
import { tr } from "./i18n";

export interface NativeImportWrite {
  readonly path: string;
  readonly after: Blob;
  /** Undefined means that this path must be absent. Text baselines preserve decoding semantics. */
  readonly expected?: Blob | string;
}
export interface NativeImportFileState {
  readonly path: string;
  readonly hash?: string;
  readonly blob?: Blob;
  readonly info?: AltairBrowserWorkspaceFile;
}
export interface NativeImportReview {
  readonly journal: NativeImportJournal;
  readonly files: readonly NativeImportFileState[];
  readonly changedPaths: readonly string[];
}
export class NativeImportFailure extends Error {
  constructor(
    cause: unknown,
    readonly pending?: NativeImportJournal,
    readonly restoredProject?: LibraryProject,
  ) {
    super(
      pending
        ? tr("Native import needs recovery. Review its files before continuing.")
        : cause instanceof Error
          ? cause.message
          : String(cause),
      { cause },
    );
    this.name = "NativeImportFailure";
  }
}
type IdentityDirectory = NonNullable<AltairBrowserWorkspaceService["directory"]> & {
  isSameEntry(other: NonNullable<AltairBrowserWorkspaceService["directory"]>): Promise<boolean>;
};
export function assertNativeImportHost(workspace: AltairBrowserWorkspaceService): void {
  const root = workspace.directory as IdentityDirectory | undefined;
  if (
    !root ||
    !workspace.capabilities.writable ||
    !workspace.exists ||
    !workspace.mkdir ||
    !workspace.remove ||
    typeof root.isSameEntry !== "function" ||
    !globalThis.navigator?.locks
  )
    throw new Error(tr("This folder host cannot perform recoverable imports."));
  try {
    if (typeof (structuredClone(root) as IdentityDirectory).isSameEntry !== "function")
      throw new Error("Directory identity cannot be persisted");
  } catch {
    throw new Error(tr("This folder host cannot perform recoverable imports."));
  }
}
export function withNativeImportLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks)
    return Promise.reject(new Error(tr("This folder host cannot perform recoverable imports.")));
  return navigator.locks.request(`altair-native-project:${projectId}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error(tr("Another Altair window is writing this project folder."));
    return run();
  });
}
export async function nativeImportForFolder(
  workspace: AltairBrowserWorkspaceService,
): Promise<NativeImportJournal | undefined> {
  const root = workspace.directory as IdentityDirectory | undefined;
  if (!root || typeof root.isSameEntry !== "function") return undefined;
  for (const journal of await projectLibrary.nativeImports())
    if (await root.isSameEntry(journal.directory)) return journal;
  return undefined;
}
async function hash(blob: Blob): Promise<string> {
  if (blob.size > 256 * 1024 * 1024) throw new RangeError("Native import member exceeds 256 MB");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function stateOf(workspace: AltairBrowserWorkspaceService, path: string): Promise<NativeImportFileState> {
  if (!workspace.match(path)) {
    if (await workspace.exists!(path))
      throw new Error(tr("An import file path is occupied by a folder: {{path}}", { path }));
    return Object.freeze({ path });
  }
  const file = await workspace.file(path);
  if (file.size > 256 * 1024 * 1024) throw new RangeError("Native import member exceeds 256 MB");
  const bytes = await file.arrayBuffer(),
    blob = new Blob([bytes], { type: file.type });
  return Object.freeze({
    path,
    blob,
    hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    info: {
      path,
      name: file.name,
      size: blob.size,
      type: blob.type,
      lastModified: file.lastModified,
    },
  });
}
function validateJournal(journal: NativeImportJournal): void {
  if (
    journal.schema !== "altair-native-import-v1" ||
    !journal.id ||
    journal.beforeProject.id !== journal.projectId ||
    journal.afterProject.id !== journal.projectId ||
    journal.entries.length > 20_000
  )
    throw new TypeError("Invalid native import journal");
  const paths = new Set<string>();
  for (const entry of journal.entries) {
    projectFilePath(entry.path);
    if (
      paths.has(entry.path) ||
      !(entry.after instanceof Blob) ||
      !/^[a-f\d]{64}$/u.test(entry.afterHash) ||
      (entry.before !== undefined &&
        (!(entry.before instanceof Blob) || !/^[a-f\d]{64}$/u.test(entry.beforeHash ?? "")))
    )
      throw new TypeError("Invalid native import journal entry");
    paths.add(entry.path);
  }
  for (const path of journal.newDirectories) projectFilePath(path);
}
async function sameFolder(workspace: AltairBrowserWorkspaceService, journal: NativeImportJournal): Promise<void> {
  assertNativeImportHost(workspace);
  validateJournal(journal);
  if (!(await (workspace.directory as IdentityDirectory).isSameEntry(journal.directory)))
    throw new Error(tr("Open the original folder to recover this import."));
  const planned = new Map(journal.afterProject.files.map((file) => [file.path, file.blob]));
  for (const entry of journal.entries) {
    if (
      (await hash(entry.after)) !== entry.afterHash ||
      (entry.before && (await hash(entry.before)) !== entry.beforeHash) ||
      !planned.has(entry.path) ||
      (await hash(planned.get(entry.path)!)) !== entry.afterHash
    )
      throw new TypeError("Native import journal bytes do not match its checksums");
  }
}
export async function prepareNativeImport(
  workspace: AltairBrowserWorkspaceService,
  beforeProject: LibraryProject,
  afterProject: LibraryProject,
  writes: readonly NativeImportWrite[],
  guard: () => void,
): Promise<NativeImportJournal> {
  assertNativeImportHost(workspace);
  guard();
  if ((await workspace.permission("readwrite", { request: true })) !== "granted")
    throw new DOMException("Workspace write permission was denied", "NotAllowedError");
  await workspace.refresh();
  guard();
  if (afterProject.files.reduce((sum, file) => sum + file.blob.size, 0) > 2 * 1024 ** 3)
    throw new RangeError("The project exceeds 2 GB");
  const entries: NativeImportEntry[] = [];
  for (const write of writes) {
    projectFilePath(write.path);
    guard();
    const current = await stateOf(workspace, write.path);
    guard();
    const matches =
      write.expected === undefined
        ? current.hash === undefined
        : typeof write.expected === "string"
          ? !!current.blob && (await current.blob.text()) === write.expected
          : !!current.hash && current.hash === (await hash(write.expected));
    guard();
    if (!matches) throw new Error(tr("The file changed before import: {{path}}", { path: write.path }));
    const afterHash = await hash(write.after);
    guard();
    entries.push({
      path: write.path,
      after: write.after,
      afterHash,
      ...(current.blob ? { before: current.blob, beforeHash: current.hash } : {}),
    });
  }
  const knownDirectories = new Set(workspace.current.directories ?? []);
  const owned = new Map<Blob, Blob>();
  const ownFiles = async (files: readonly ProjectFile[]): Promise<readonly ProjectFile[]> => {
    const result: ProjectFile[] = [];
    for (const file of files) {
      guard();
      let blob = owned.get(file.blob);
      if (!blob) {
        if (file.blob.size > 256 * 1024 * 1024) throw new RangeError("Native import member exceeds 256 MB");
        // Native File objects can become unreadable after the underlying file changes.
        blob =
          file.blob instanceof File ? new Blob([await file.blob.arrayBuffer()], { type: file.blob.type }) : file.blob;
        guard();
        owned.set(file.blob, blob);
      }
      result.push({ path: file.path, blob });
    }
    return result;
  };
  const beforeFiles = await ownFiles(beforeProject.files),
    afterFiles = await ownFiles(afterProject.files);
  const journal: NativeImportJournal = {
    schema: "altair-native-import-v1",
    id: crypto.randomUUID(),
    projectId: beforeProject.id,
    createdAt: Date.now(),
    beforeProject: { ...beforeProject, files: beforeFiles, directory: workspace.directory },
    afterProject: { ...afterProject, files: afterFiles, directory: workspace.directory },
    directory: workspace.directory!,
    entries: entries.sort((a, b) => Number(a.path === "project.yaml") - Number(b.path === "project.yaml")),
    newDirectories: (afterProject.directories ?? []).filter((path) => !knownDirectories.has(path)),
  };
  validateJournal(journal);
  return journal;
}
export async function reviewNativeImport(
  workspace: AltairBrowserWorkspaceService,
  journal: NativeImportJournal,
  guard: () => void,
): Promise<NativeImportReview> {
  await sameFolder(workspace, journal);
  await workspace.refresh();
  guard();
  const files: NativeImportFileState[] = [];
  for (const entry of journal.entries) {
    files.push(await stateOf(workspace, entry.path));
    guard();
  }
  const changedPaths = files
    .filter(
      (file, index) =>
        file.hash !== journal.entries[index]!.beforeHash && file.hash !== journal.entries[index]!.afterHash,
    )
    .map((file) => file.path);
  return Object.freeze({ journal, files: Object.freeze(files), changedPaths: Object.freeze(changedPaths) });
}
async function recheckReview(
  workspace: AltairBrowserWorkspaceService,
  review: NativeImportReview,
  guard: () => void,
): Promise<void> {
  const current = await projectLibrary.nativeImport(review.journal.projectId);
  if (!current || current.id !== review.journal.id)
    throw new Error(tr("The import recovery changed. Review it again."));
  await sameFolder(workspace, current);
  await workspace.refresh();
  guard();
  for (const reviewed of review.files) {
    const actual = await stateOf(workspace, reviewed.path);
    guard();
    if (actual.hash !== reviewed.hash) throw new Error(tr("The import recovery changed. Review it again."));
  }
}
async function removeEmptyDirectories(
  workspace: AltairBrowserWorkspaceService,
  journal: NativeImportJournal,
): Promise<void> {
  for (const path of [...journal.newDirectories].sort((a, b) => b.split("/").length - a.split("/").length)) {
    if (!(await workspace.exists!(path))) continue;
    await workspace.refresh();
    // The SDK checks hidden children too; a concurrently populated folder is retained.
    try {
      await workspace.remove!(path, { expected: { files: [], directories: [path] } });
    } catch (error) {
      if (!(error instanceof DOMException && ["InvalidStateError", "NotFoundError"].includes(error.name))) throw error;
    }
  }
}
async function restoreKnownFiles(
  workspace: AltairBrowserWorkspaceService,
  journal: NativeImportJournal,
): Promise<LibraryProject> {
  await sameFolder(workspace, journal);
  await workspace.refresh();
  for (const entry of [...journal.entries].reverse()) {
    if (!entry.started) continue;
    const current = await stateOf(workspace, entry.path);
    if (current.hash === entry.beforeHash) continue;
    if (current.hash !== entry.afterHash) throw new Error(tr("The import recovery changed. Review it again."));
    if (entry.before) await workspace.write(entry.path, entry.before, { create: true });
    else await workspace.remove!(entry.path, { expected: { files: [current.info!], directories: [] } });
  }
  await removeEmptyDirectories(workspace, journal);
  return projectLibrary.finishNativeImportRestore(journal.projectId, journal.id);
}
async function writePlan(
  workspace: AltairBrowserWorkspaceService,
  record: NativeImportJournal,
  guard: () => void,
): Promise<NativeImportJournal> {
  let journal = record;
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index]!;
    guard();
    await workspace.refresh();
    guard();
    const current = await stateOf(workspace, entry.path);
    guard();
    if (current.hash !== entry.beforeHash)
      throw new Error(tr("The file changed before import: {{path}}", { path: entry.path }));
    journal = await projectLibrary.updateNativeImport(journal.projectId, journal.id, (value) => ({
      ...value,
      entries: value.entries.map((item, i) => (i === index ? { ...item, started: true } : item)),
    }));
    guard();
    // Wait for the write to settle before rollback. Caller abort must not race a late close.
    await workspace.write(entry.path, entry.after, { create: true, exclusive: !entry.before });
    guard();
  }
  return journal;
}
async function verifyPlannedFiles(
  workspace: AltairBrowserWorkspaceService,
  journal: NativeImportJournal,
  guard: () => void,
): Promise<void> {
  await workspace.refresh();
  guard();
  for (const entry of journal.entries) {
    if ((await stateOf(workspace, entry.path)).hash !== entry.afterHash)
      throw new Error(tr("The import recovery changed. Review it again."));
    guard();
  }
}
export async function applyNativeImport(
  workspace: AltairBrowserWorkspaceService,
  journal: NativeImportJournal,
  guard: () => void,
  signal?: AbortSignal,
): Promise<LibraryProject> {
  let begun = false,
    record = journal;
  try {
    await sameFolder(workspace, journal);
    guard();
    await projectLibrary.beginNativeImport(journal, guard, signal);
    begun = true;
    record = await writePlan(workspace, journal, guard);
    await verifyPlannedFiles(workspace, record, guard);
    return await projectLibrary.commit(
      record.afterProject,
      record.beforeProject.revision,
      undefined,
      undefined,
      guard,
      signal,
      true,
      record.id,
    );
  } catch (error) {
    if (!begun) throw error;
    try {
      record = (await projectLibrary.nativeImport(journal.projectId)) ?? record;
    } catch {
      throw new NativeImportFailure(error, record);
    }
    try {
      const restored = await restoreKnownFiles(workspace, record);
      throw new NativeImportFailure(error, undefined, restored);
    } catch (recoveryError) {
      if (recoveryError instanceof NativeImportFailure) throw recoveryError;
      throw new NativeImportFailure(error, record);
    }
  }
}
export async function resolveNativeImport(
  workspace: AltairBrowserWorkspaceService,
  review: NativeImportReview,
  choice: "finish" | "restore",
  guard: () => void,
  signal?: AbortSignal,
): Promise<LibraryProject> {
  if (choice !== "finish" && choice !== "restore") throw new TypeError("Invalid native recovery choice");
  guard();
  if ((await workspace.permission("readwrite", { request: true })) !== "granted")
    throw new DOMException("Workspace write permission was denied", "NotAllowedError");
  guard();
  await recheckReview(workspace, review, guard);
  let journal = await projectLibrary.updateNativeImport(review.journal.projectId, review.journal.id, (value) => ({
    ...value,
    externalCopies: [
      ...(value.externalCopies ?? []),
      ...review.files
        .filter((file) => review.changedPaths.includes(file.path) && file.blob)
        .map((file) => ({ path: file.path, blob: file.blob! })),
    ],
  }));
  guard();
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index]!,
      before = review.files[index]!;
    guard();
    await workspace.refresh();
    guard();
    const current = await stateOf(workspace, entry.path);
    guard();
    if (current.hash !== before.hash) throw new Error(tr("The import recovery changed. Review it again."));
    const desired = choice === "finish" ? entry.after : entry.before,
      desiredHash = choice === "finish" ? entry.afterHash : entry.beforeHash;
    if (current.hash === desiredHash) continue;
    journal = await projectLibrary.updateNativeImport(journal.projectId, journal.id, (value) => ({
      ...value,
      entries: value.entries.map((item, i) => (i === index ? { ...item, started: true } : item)),
    }));
    guard();
    if (desired) await workspace.write(entry.path, desired, { create: true, exclusive: !current.blob });
    else if (current.info)
      await workspace.remove!(entry.path, { expected: { files: [current.info], directories: [] } });
    guard();
  }
  if (choice === "restore") {
    await removeEmptyDirectories(workspace, journal);
    guard();
    return projectLibrary.finishNativeImportRestore(journal.projectId, journal.id);
  }
  await verifyPlannedFiles(workspace, journal, guard);
  return projectLibrary.commit(
    journal.afterProject,
    journal.beforeProject.revision,
    undefined,
    undefined,
    guard,
    signal,
    true,
    journal.id,
  );
}
export function nativeImportBackupFiles(
  journal: NativeImportJournal,
  version: "before" | "after" | "external",
): readonly ProjectFile[] {
  if (version === "external")
    return (journal.externalCopies ?? []).map((file, index) => ({
      path: `${String(index).padStart(4, "0")}/${file.path}`,
      blob: file.blob,
    }));
  return version === "before" ? journal.beforeProject.files : journal.afterProject.files;
}
