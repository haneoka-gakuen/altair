import type { JsonObject, JsonValue } from "@haneoka/altair";
import { assertAltairJsonSnapshot } from "@haneoka/altair-plugin-history";
import type { ProjectFile } from "./library";
import { projectDirectories, projectFilePath } from "./file-operations";
import { publicAssetSource, validatePublicScope, type EditorPublicAsset } from "./resource-manifest";
import { abortableOperation } from "./abortable-operation";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
export interface PublicAssetByteReader {
  load(assetId: string, memberId: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface LocalPublicAssetPlan {
  readonly schema: "altair-local-public-asset-v1";
  readonly sourceAssetId: string;
  readonly directory: string;
  readonly files: readonly ProjectFile[];
  readonly value: JsonObject;
  readonly metadata: JsonObject;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function relativeTo(document: string, target: string): string {
  const from = document.split("/").slice(0, -1),
    to = target.split("/");
  let common = 0;
  while (from[common] && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}
function basename(source: string): string {
  const name = decodeURIComponent(new URL(source).pathname.split("/").at(-1) ?? "");
  if (!name || name.includes("/") || name.includes("\\")) throw new TypeError("Invalid asset filename");
  projectFilePath(name);
  return name;
}
/** Plans one selected asset graph. Caller owns IO and commits the complete result to its project. */
export async function preparePublicAssetImport(options: {
  asset: EditorPublicAsset;
  reader: PublicAssetByteReader;
  directory: string;
  author: string;
  license: string;
  version: string;
  existing: readonly ProjectFile[];
  directories?: readonly string[];
  signal?: AbortSignal;
  maxBytes?: number;
}): Promise<LocalPublicAssetPlan> {
  const { signal } = options;
  const asset = structuredClone(options.asset),
    author = options.author,
    license = options.license,
    version = options.version;
  signal?.throwIfAborted();
  const scope = validatePublicScope(asset.scope);
  if (asset.schema !== "altair-public-asset-v1" || !asset.id || asset.kind === "project")
    throw new TypeError("Expected one selected public asset; story projects require their format importer");
  assertAltairJsonSnapshot(asset.value);
  for (const [key, value] of Object.entries({
    author,
    license,
    version,
  }))
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`Asset ${key} is required`);
  const directory = projectFilePath(options.directory),
    maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES)
    throw new RangeError("Invalid import byte limit");
  if (!Array.isArray(asset.members) || asset.members.length > 10_000) throw new RangeError("Too many asset members");
  const memberIds = new Set<string>(),
    sources = new Map<string, { memberId: string; role: string; path: string }>();
  for (const member of asset.members) {
    if (!member.id || memberIds.has(member.id)) throw new TypeError("Duplicate asset member ID");
    memberIds.add(member.id);
    const source = publicAssetSource(member.source, scope);
    if (!sources.has(source))
      sources.set(source, {
        memberId: member.id,
        role: member.role,
        path: `members/${String(sources.size).padStart(4, "0")}/${basename(source)}`,
      });
  }
  const occupied = new Set([
    ...options.existing.map((file) => projectFilePath(file.path)),
    ...projectDirectories(options.existing, options.directories),
  ]);
  for (const entry of sources.values()) {
    const target = `${directory}/${entry.path}`;
    if (occupied.has(target) || options.existing.some((file) => target.startsWith(`${file.path}/`)))
      throw new Error(`Asset path already exists: ${target}`);
  }
  const localSource = (source: string, base?: string): string => {
    const resolved = publicAssetSource(base ? new URL(source, base).href : source, scope);
    const member = sources.get(resolved);
    if (!member) throw new Error(`Asset dependency was not selected: ${resolved}`);
    return member.path;
  };
  const loaderFields = new Set([
    "url",
    "playableUrl",
    "model",
    "modelUrl",
    "moc",
    "mocUrl",
    "physics",
    "physicsUrl",
    "pose",
    "poseUrl",
    "atlas",
    "atlasUrl",
    "skeleton",
    "skeletonUrl",
    "image",
    "imageUrl",
    "texture",
    "textures",
    "runtime",
    "file",
    "sound",
  ]);
  const metadataFields = new Set(["provenance", "sourceMetadata", "scope"]);
  const sourceIsPrimary =
    asset.kind !== "model" &&
    asset.kind !== "spine" &&
    asset.value.url === undefined &&
    asset.value.texture === undefined &&
    asset.value.image === undefined &&
    asset.value.playableUrl === undefined;
  const labels = new Set(["name", "label", "id", "key", "group", "type", "format"]);
  const rewriteValue = (value: JsonValue, field = "", collection = false, metadata = false): JsonValue => {
    if (typeof value === "string") {
      if (
        metadata ||
        !value ||
        (!loaderFields.has(field) && !(field === "source" && sourceIsPrimary) && !(collection && !labels.has(field)))
      )
        return value;
      const entry = sources.get(publicAssetSource(value, scope));
      if (!entry) throw new Error(`Asset loader reference was not selected: ${value}`);
      return `${directory}/${entry.path}`;
    }
    if (Array.isArray(value)) return value.map((child) => rewriteValue(child, field, collection, metadata));
    if (value && typeof value === "object") {
      const row = Object.keys(value).some((key) => loaderFields.has(key));
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          rewriteValue(
            child,
            key,
            (collection && !row) || ["motions", "expressions", "textures"].includes(key),
            metadata || metadataFields.has(key),
          ),
        ]),
      );
    }
    return value;
  };
  const value = rewriteValue(structuredClone(asset.value)) as JsonObject;
  const rewriteModel = (data: Record<string, unknown>, source: string, path: string): void => {
    const rewrite = (raw: unknown): unknown => {
      if (typeof raw !== "string") throw new TypeError("Invalid model dependency");
      return raw ? relativeTo(path, localSource(raw, source)) : raw;
    };
    if (asset.format === "cubism3") {
      const references = record(data.FileReferences);
      if (typeof references.Moc !== "string" || !Array.isArray(references.Textures))
        throw new TypeError("Invalid Cubism 3 model references");
      for (const key of ["Moc", "Physics", "Pose", "UserData", "DisplayInfo", "MotionSync"])
        if (references[key] !== undefined) references[key] = rewrite(references[key]);
      references.Textures = references.Textures.map(rewrite);
      for (const list of [references.Expressions, ...Object.values(record(references.Motions))]) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) throw new TypeError("Invalid model motion or expression list");
        for (const item of list) {
          const entry = record(item);
          entry.File = rewrite(entry.File);
          if (entry.Sound !== undefined) entry.Sound = rewrite(entry.Sound);
        }
      }
    } else if (asset.format === "cubism2") {
      if (typeof data.model !== "string" || !Array.isArray(data.textures))
        throw new TypeError("Invalid Cubism 2 model references");
      for (const key of ["model", "physics", "pose"]) if (data[key] !== undefined) data[key] = rewrite(data[key]);
      data.textures = data.textures.map(rewrite);
      for (const list of [data.expressions, ...Object.values(record(data.motions))]) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) throw new TypeError("Invalid model motion or expression list");
        for (const item of list) {
          const entry = record(item);
          entry.file = rewrite(entry.file);
          if (entry.sound !== undefined) entry.sound = rewrite(entry.sound);
        }
      }
    }
  };
  const files: ProjectFile[] = [],
    provenance: JsonObject[] = [];
  let totalBytes = 0,
    importedBytes = 0;
  for (const [source, entry] of sources) {
    signal?.throwIfAborted();
    const returned = await abortableOperation(() => options.reader.load(asset.id, entry.memberId, signal), [signal]);
    signal?.throwIfAborted();
    if (!(returned instanceof Uint8Array) || returned.byteLength > MAX_MEMBER_BYTES)
      throw new RangeError("Invalid asset member byte length");
    totalBytes += returned.byteLength;
    if (totalBytes > maxBytes) throw new RangeError("Public asset import exceeds its byte limit");
    const bytes = Uint8Array.from(returned);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    signal?.throwIfAborted();
    let blob = new Blob([bytes]);
    if (
      entry.role === "model" &&
      /\.json$/iu.test(new URL(source).pathname) &&
      ["cubism2", "cubism3"].includes(asset.format)
    ) {
      if (bytes.byteLength > MAX_TEXT_BYTES) throw new RangeError("Model JSON exceeds its byte limit");
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertAltairJsonSnapshot(data);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Invalid model JSON");
      rewriteModel(data as Record<string, unknown>, source, entry.path);
      blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    } else if (entry.role === "atlas" && asset.format === "spine") {
      if (bytes.byteLength > MAX_TEXT_BYTES) throw new RangeError("Spine atlas exceeds its byte limit");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ending = text.includes("\r\n") ? "\r\n" : "\n";
      const lines = text.split(/\r\n|\r|\n/u);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (
          line.trim() &&
          !line.includes(":") &&
          (index === 0 || !lines[index - 1]!.trim()) &&
          /^(?:size|format|filter|repeat|pma|scale)\s*:/u.test(lines[index + 1]?.trim() ?? "")
        )
          lines[index] = relativeTo(entry.path, localSource(line.trim(), source));
      }
      blob = new Blob([lines.join(ending)], { type: "text/plain" });
    }
    importedBytes += blob.size;
    if (importedBytes > maxBytes) throw new RangeError("Public asset import exceeds its materialized byte limit");
    files.push(Object.freeze({ path: `${directory}/${entry.path}`, blob }));
    provenance.push({
      memberId: entry.memberId,
      source,
      path: `${directory}/${entry.path}`,
      originalSha256: hash,
      originalBytes: bytes.byteLength,
      importedBytes: blob.size,
    });
  }
  signal?.throwIfAborted();
  if (asset.kind === "model" || asset.kind === "spine")
    value.runtime = { ...record(value.runtime), format: asset.format } as JsonObject;
  return Object.freeze({
    schema: "altair-local-public-asset-v1",
    sourceAssetId: asset.id,
    directory,
    files: Object.freeze(files),
    value,
    metadata: {
      id: asset.id,
      version,
      author,
      license,
      directory,
      source: {
        provider: scope.provider,
        origin: scope.origin,
        server: scope.server,
        ...(scope.releaseId ? { releaseId: scope.releaseId } : {}),
        ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
      },
      key: asset.key,
      kind: asset.kind,
      format: asset.format,
      capturedAt: asset.capturedAt,
      members: provenance,
    },
  });
}
