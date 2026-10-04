import { tr } from "./i18n";
import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, strFromU8, type UnzipFile } from "fflate";
import type { EditorSession } from "./session";
import type { ProjectFile } from "./library";
import { projectDirectories, projectFilePath } from "./file-operations";

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

/** Stream input files into ZIP output chunks, avoiding a second full byte array of every asset. */
export async function createProjectZip(session: EditorSession, signal?: AbortSignal): Promise<Blob> {
  session.validateDocuments();
  const state = session.getSnapshot();
  const files = state.files.map((file) => ({
    path: projectFilePath(file.path),
    blob: session.document(file.path)
      ? new Blob([session.document(file.path)!.text], { type: "text/plain" })
      : file.blob,
  }));
  return createFilesZip(files, state.directories, signal, new Set(state.documents.map((doc) => doc.path)));
}

/** Shared streamed ZIP writer for native projects and engine-backed games. */
export async function createFilesZip(
  files: readonly ProjectFile[],
  folders: readonly string[] = [],
  signal?: AbortSignal,
  compress: ReadonlySet<string> = new Set(),
): Promise<Blob> {
  const paths = new Set<string>();
  for (const file of files) {
    projectFilePath(file.path);
    if (paths.has(file.path)) throw new Error(tr("The archive contains duplicate paths"));
    paths.add(file.path);
  }
  const directories = projectDirectories(files, folders);
  if (files.length + directories.length > MAX_ARCHIVE_ENTRIES)
    throw new Error(tr("The archive contains too many entries"));
  if (files.reduce((size, file) => size + file.blob.size, 0) > MAX_ARCHIVE_BYTES)
    throw new Error(tr("The project exceeds 2 GB"));
  const chunks: BlobPart[] = [];
  let failure: Error | undefined;
  let finished = false;
  const archive = new Zip((error, data, final) => {
    if (error) failure = error;
    else chunks.push(new Blob([data as Uint8Array<ArrayBuffer>]));
    finished ||= final;
  });
  try {
    for (const path of directories) {
      signal?.throwIfAborted();
      const entry = new ZipPassThrough(`${path}/`);
      archive.add(entry);
      entry.push(new Uint8Array(), true);
    }
    for (const file of files) {
      signal?.throwIfAborted();
      const entry = compress.has(file.path) ? new ZipDeflate(file.path, { level: 6 }) : new ZipPassThrough(file.path);
      archive.add(entry);
      const reader = file.blob.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          signal?.throwIfAborted();
          if (done) {
            entry.push(new Uint8Array(), true);
            break;
          }
          entry.push(value);
          if (failure) throw failure;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    archive.end();
    if (failure) throw failure;
    if (!finished) throw new Error(tr("The archive is incomplete"));
    return new Blob(chunks, { type: "application/zip" });
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

export async function exportProjectZip(session: EditorSession): Promise<void> {
  const blob = await createProjectZip(session);
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = session.getSnapshot().name.replace(/[\\/:*?"<>|]/gu, "_") + ".zip";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
  const entries = new Map<string, { crc: number; size: number }>();
  const declaredPaths = new Set<string>();
  let declaredBytes = 0;
  for (let offset = 0; offset < metadata.byteLength; ) {
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
    entries.set(name, { crc: metadata.getUint32(offset + 16, true), size });
    offset = next;
  }
  if (entries.size !== expectedCount) throw new Error(tr("The archive is incomplete"));
  const files: ProjectFile[] = [],
    directories: string[] = [],
    paths = new Set<string>(),
    active = new Set<UnzipFile>();
  let total = 0,
    count = 0,
    failure: unknown;
  const archive = new Unzip((entry) => {
    try {
      if (++count > MAX_ARCHIVE_ENTRIES) throw new Error(tr("The archive contains too many entries"));
      const directory = entry.name.endsWith("/");
      const expected = entries.get(entry.name);
      if (!expected) throw new Error(tr("The archive is incomplete"));
      const path = projectFilePath(directory ? entry.name.slice(0, -1) : entry.name);
      if (paths.has(path)) throw new Error(tr("The archive contains duplicate paths"));
      paths.add(path);
      if (entry.originalSize !== undefined && entry.originalSize > maxBytes)
        throw new Error(tr("The archive exceeds its decoded byte limit"));
      const chunks: BlobPart[] = [];
      let crc = 0xffffffff,
        size = 0;
      active.add(entry);
      entry.ondata = (error, data, final) => {
        if (error) {
          failure = error;
          return;
        }
        total += data.byteLength;
        size += data.byteLength;
        if (size > expected.size) {
          failure = new Error(tr("The archive contains a damaged file"));
          entry.terminate();
          return;
        }
        if (total > maxBytes) {
          failure = new Error(tr("The archive exceeds its decoded byte limit"));
          entry.terminate();
          return;
        }
        for (const value of data) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255]!;
        if (directory && data.byteLength) {
          failure = new Error(tr("The archive contains an invalid path"));
          entry.terminate();
          return;
        }
        if (!directory) chunks.push(new Blob([data as Uint8Array<ArrayBuffer>]));
        if (final) {
          if (size !== expected.size || (crc ^ 0xffffffff) >>> 0 !== expected.crc) {
            failure = new Error(tr("The archive contains a damaged file"));
            return;
          }
          active.delete(entry);
          if (directory) directories.push(path);
          else files.push({ path, blob: new Blob(chunks) });
        }
      };
      entry.start();
    } catch (error) {
      failure = error;
      entry.terminate();
    }
  });
  archive.register(UnzipInflate);
  const reader = file.stream().getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        archive.push(new Uint8Array(), true);
        break;
      }
      archive.push(value);
      if (failure) throw failure;
    }
    if (failure) throw failure;
    if (active.size || count !== expectedCount) throw new Error(tr("The archive is incomplete"));
    projectDirectories(files, directories);
    const paths = [...files.map((file) => file.path), ...directories];
    const root = paths[0]?.split("/")[0];
    // A packaging folder may have its own ZIP directory entry; retain WebGAL's semantic game/ root.
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
  } catch (error) {
    for (const entry of active) entry.terminate();
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Existing consumers may continue using the files-only import API. */
export async function importProjectZip(file: File): Promise<readonly ProjectFile[]> {
  return (await readProjectZip(file)).files;
}
