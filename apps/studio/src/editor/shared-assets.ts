import type { JsonObject } from "@haneoka/altair";
import { normalizeBrowserWorkspacePath } from "@haneoka/altair-plugin-workspace-browser";
import type { ProjectFile } from "./library";

export interface SharedAssetPack {
  readonly id: string;
  readonly version: string;
  readonly author: string;
  readonly license: string;
  readonly files: readonly ProjectFile[];
}

/** Keeps pack-relative references intact and refuses to overwrite project files. */
export function prepareSharedAssetImport(
  pack: SharedAssetPack,
  directory: string,
  existing: readonly ProjectFile[],
): { files: readonly ProjectFile[]; metadata: JsonObject } {
  for (const [field, value] of Object.entries({
    id: pack.id,
    version: pack.version,
    author: pack.author,
    license: pack.license,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`Asset pack ${field} is required`);
  }
  const relative = (path: string): string => {
    const normalized = normalizeBrowserWorkspacePath(path);
    if (normalized !== path || /[\u0000-\u001f\u007f]/u.test(path))
      throw new TypeError(`Invalid asset pack path: ${path}`);
    return normalized;
  };
  const target = relative(directory);
  if (!pack.files.length) throw new TypeError("Asset pack is empty");
  if (pack.files.length > 10000) throw new RangeError("Asset pack exceeds 10000 files");
  const paths = new Set(existing.map((file) => file.path));
  let bytes = 0;
  const files = pack.files.map((file) => {
    const path = `${target}/${relative(file.path)}`;
    if (paths.has(path)) throw new TypeError(`Asset path already exists: ${path}`);
    paths.add(path);
    bytes += file.blob.size;
    if (bytes > 2 * 1024 * 1024 * 1024) throw new RangeError("Asset pack exceeds 2 GB");
    return { path, blob: file.blob };
  });
  return {
    files,
    metadata: {
      id: pack.id,
      version: pack.version,
      author: pack.author,
      license: pack.license,
      directory: target,
      files: files.map((file) => file.path),
    },
  };
}
