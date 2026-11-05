import { downloadStudioFile } from "./studio-host";
import { createWorkspaceZip } from "@haneoka/altair-plugin-workspace-browser/archive";
import { tr } from "./i18n";
import { strFromU8 } from "fflate";
import type { EditorSession } from "./session";
import type { ProjectFile } from "./library";
import { projectDirectories, projectFilePath } from "./file-operations";
import { authoringProjectFiles } from "./authoring-project";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export interface ProjectArchive {
  readonly files: readonly ProjectFile[];
  readonly directories: readonly string[];
}
export const compressibleArchivePaths = (files: readonly Pick<ProjectFile, "path">[]): Set<string> =>
  new Set(
    files
      .filter((file) => /\.(?:txt|jsonl?|ya?ml|wmdl|html|css|[cm]?js|svg|wasm|ttf|otf|eot)$/iu.test(file.path))
      .map((file) => file.path),
  );

/** Stream input files into ZIP output chunks, avoiding a second full byte array of every asset. */
export async function createProjectZip(session: EditorSession, signal?: AbortSignal): Promise<Blob> {
  const state = session.getSnapshot();
  const files = await authoringProjectFiles(state.files, state.documents);
  return createFilesZip(
    files,
    state.directories,
    signal,
    new Set([...compressibleArchivePaths(files), ...state.documents.map((doc) => doc.path)]),
  );
}

export async function createFilesZip(
  files: readonly ProjectFile[],
  folders: readonly string[] = [],
  signal?: AbortSignal,
  compress: ReadonlySet<string> = compressibleArchivePaths(files),
): Promise<Blob> {
  try {
    return await createWorkspaceZip(files, folders, signal, compress);
  } catch (error) {
    if (error instanceof Error) throw new Error(tr(error.message), { cause: error });
    throw error;
  }
}

export async function exportProjectZip(session: EditorSession): Promise<void> {
  const blob = await createProjectZip(session);
  downloadStudioFile(blob, session.getSnapshot().name.replace(/[\\/:*?"<>|]/gu, "_") + ".zip");
}

/** Validate every ZIP entry and enforce limits using bytes actually produced by decompression. */
export async function readProjectZip(
  file: Blob,
  signal?: AbortSignal,
  limits?: { maxBytes: number },
): Promise<ProjectArchive> {
  const maxBytes = limits?.maxBytes ?? MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARCHIVE_BYTES)
    throw new RangeError("Invalid archive byte limit");
  // ZIP headers and directory records are additional to the decoded project budget.
  if (file.size > maxBytes + 128 * 1024 * 1024) throw new Error(tr("The archive exceeds its decoded byte limit"));
  signal?.throwIfAborted();
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65_557)).arrayBuffer());
  let expectedCount: number | undefined;
  let directoryOffset = 0,
    directorySize = 0;
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (
      tail.getUint32(offset, true) !== 0x06054b50 ||
      offset + 22 + tail.getUint16(offset + 20, true) !== tail.byteLength
    )
      continue;
    if (tail.getUint16(offset + 4, true) || tail.getUint16(offset + 6, true))
      throw new Error(tr("Split archives are unsupported"));
    expectedCount = tail.getUint16(offset + 10, true);
    directorySize = tail.getUint32(offset + 12, true);
    directoryOffset = tail.getUint32(offset + 16, true);
    if (
      expectedCount !== tail.getUint16(offset + 8, true) ||
      tail.getUint32(offset + 16, true) + tail.getUint32(offset + 12, true) > file.size - tail.byteLength + offset
    )
      throw new Error(tr("The archive is incomplete"));
    break;
  }
  if (expectedCount === undefined || !expectedCount) throw new Error(tr("The archive is incomplete"));
  if (expectedCount > MAX_ARCHIVE_ENTRIES) throw new Error(tr("The archive contains too many entries"));
  if (directorySize > 64 * 1024 * 1024) throw new Error(tr("The archive metadata is too large"));
  signal?.throwIfAborted();
  const metadata = new DataView(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const entries = new Map<
    string,
    { crc: number; size: number; compressed: number; method: number; flags: number; offset: number }
  >();
  const declaredPaths = new Set<string>();
  let declaredBytes = 0;
  for (let offset = 0; offset < metadata.byteLength;) {
    if (offset + 46 > metadata.byteLength || metadata.getUint32(offset, true) !== 0x02014b50)
      throw new Error(tr("The archive is incomplete"));
    const flags = metadata.getUint16(offset + 8, true),
      size = metadata.getUint32(offset + 24, true);
    if (flags & 1) throw new Error(tr("Encrypted archives are unsupported"));
    const nameLength = metadata.getUint16(offset + 28, true);
    const next =
      offset + 46 + nameLength + metadata.getUint16(offset + 30, true) + metadata.getUint16(offset + 32, true);
    if (next > metadata.byteLength || metadata.getUint16(offset + 34, true))
      throw new Error(tr("The archive is incomplete"));
    const name = strFromU8(new Uint8Array(metadata.buffer, offset + 46, nameLength), !(flags & 2048));
    const path = projectFilePath(name.endsWith("/") ? name.slice(0, -1) : name);
    if (declaredPaths.has(path)) throw new Error(tr("The archive contains duplicate paths"));
    declaredPaths.add(path);
    const mode = metadata.getUint32(offset + 38, true) >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new Error(tr("Archive symbolic links are unsupported"));
    declaredBytes += size;
    if (declaredBytes > maxBytes) throw new Error(tr("The archive exceeds its decoded byte limit"));
    entries.set(name, {
      crc: metadata.getUint32(offset + 16, true),
      size,
      compressed: metadata.getUint32(offset + 20, true),
      method: metadata.getUint16(offset + 10, true),
      flags,
      offset: metadata.getUint32(offset + 42, true),
    });
    offset = next;
  }
  if (entries.size !== expectedCount) throw new Error(tr("The archive is incomplete"));
  const files: ProjectFile[] = [],
    directories: string[] = [];
  let total = 0;
  for (const [name, entry] of entries) {
    signal?.throwIfAborted();
    const damaged = () => new Error(tr("Damaged archive file: {{path}}", { path: name }));
    if (entry.offset + 30 > directoryOffset) throw new Error(tr("The archive is incomplete"));
    const header = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (
      header.byteLength !== 30 ||
      header.getUint32(0, true) !== 0x04034b50 ||
      header.getUint16(6, true) !== entry.flags ||
      header.getUint16(8, true) !== entry.method
    )
      throw damaged();
    const nameLength = header.getUint16(26, true),
      start = entry.offset + 30 + nameLength + header.getUint16(28, true);
    if (start + entry.compressed > directoryOffset) throw new Error(tr("The archive is incomplete"));
    const localName = strFromU8(
      new Uint8Array(await file.slice(entry.offset + 30, entry.offset + 30 + nameLength).arrayBuffer()),
      !(entry.flags & 2048),
    );
    if (localName !== name) throw new Error(tr("The archive contains an invalid path"));
    if (
      !(entry.flags & 8) &&
      (header.getUint32(14, true) !== entry.crc ||
        header.getUint32(18, true) !== entry.compressed ||
        header.getUint32(22, true) !== entry.size)
    )
      throw damaged();
    if (entry.method !== 0 && entry.method !== 8) throw new Error(tr("Unsupported archive compression"));
    if (entry.method === 0 && entry.compressed !== entry.size) throw damaged();
    const directory = name.endsWith("/"),
      path = projectFilePath(directory ? name.slice(0, -1) : name),
      chunks: BlobPart[] = [],
      source = file.slice(start, start + entry.compressed).stream();
    const reader = (
      entry.method === 8 ? source.pipeThrough(new DecompressionStream("deflate-raw")) : source
    ).getReader();
    let crc = 0xffffffff,
      size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read().catch((error: unknown) => {
          signal?.throwIfAborted();
          throw new Error(tr("Damaged archive file: {{path}}", { path: name }), { cause: error });
        });
        if (done) break;
        size += value.byteLength;
        total += value.byteLength;
        if (size > entry.size) throw damaged();
        if (total > maxBytes) throw new Error(tr("The archive exceeds its decoded byte limit"));
        if (directory && value.byteLength) throw new Error(tr("The archive contains an invalid path"));
        for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
        if (!directory) chunks.push(new Blob([value as Uint8Array<ArrayBuffer>]));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (size !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) throw damaged();
    if (directory) directories.push(path);
    else files.push({ path, blob: new Blob(chunks) });
  }
  projectDirectories(files, directories);
  const paths = [...files.map((file) => file.path), ...directories];
  const root = paths[0]?.split("/")[0];
  // Keep WebGAL's semantic game/ root when removing a packaging folder.
  const prefix =
    root &&
    root !== "game" &&
    paths.every((path) => path === root || path.startsWith(`${root}/`)) &&
    files.every((file) => file.path.startsWith(`${root}/`))
      ? root.length + 1
      : 0;
  return {
    files: files.map((file) => ({ ...file, path: file.path.slice(prefix) })),
    directories: projectDirectories(
      [],
      directories.filter((path) => !prefix || path.length >= prefix).map((path) => path.slice(prefix)),
    ),
  };
}

/** Existing consumers may continue using the files-only import API. */
export async function importProjectZip(file: File): Promise<readonly ProjectFile[]> {
  return (await readProjectZip(file)).files;
}
