import type { ResourceBrowserFile, ResourceBrowserInsert } from "@haneoka/altair/resource-browser";
import type { JsonObject } from "@haneoka/altair";
import { assertAltairJsonSnapshot } from "@haneoka/altair-plugin-history";

export type PublicAssetKind =
  | "model"
  | "spine"
  | "background"
  | "still"
  | "frame"
  | "stamp"
  | "audio"
  | "effect"
  | "post-effect"
  | "video"
  | "project";
export type PublicAssetFormat = "cubism2" | "cubism3" | "spine" | "image" | "audio" | "video" | "data";
export interface PublicSourceScope {
  readonly provider: "haneoka" | "bestdori";
  readonly origin: string;
  readonly server: string;
  readonly releaseId?: string;
  readonly sourceId?: string;
}
export interface PublicAssetMember {
  readonly id: string;
  readonly role:
    | "model"
    | "moc"
    | "texture"
    | "motion"
    | "expression"
    | "physics"
    | "pose"
    | "skeleton"
    | "atlas"
    | "image"
    | "audio"
    | "video"
    | "data";
  readonly source: string;
}
export interface EditorPublicAsset {
  readonly schema: "altair-public-asset-v1";
  readonly id: string;
  readonly key: string;
  readonly kind: PublicAssetKind;
  readonly format: PublicAssetFormat;
  readonly name: string;
  readonly scope: PublicSourceScope;
  readonly capturedAt: number;
  readonly members: readonly PublicAssetMember[];
  readonly capabilities: readonly (
    | "transform"
    | "motion"
    | "expression"
    | "parameters"
    | "audio"
    | "visual"
    | "effect"
    | "import-project"
  )[];
  readonly usage?: "bgm" | "se" | "voice";
  readonly value: JsonObject;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function validatePublicScope(scope: PublicSourceScope): PublicSourceScope {
  const origin = new URL(scope.origin);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    !/^[a-z\d-]{1,40}$/u.test(scope.server)
  )
    throw new TypeError("Invalid public resource scope");
  if (
    scope.provider === "haneoka" &&
    (!/^r-[a-f\d]{20}$/u.test(scope.releaseId ?? "") || !/^[a-zA-Z\d._-]{1,256}$/u.test(scope.sourceId ?? ""))
  )
    throw new TypeError("Haneoka browsing requires an explicit immutable release and source");
  if (scope.provider !== "haneoka" && scope.provider !== "bestdori") throw new TypeError("Unsupported public provider");
  if (scope.provider === "bestdori" && !["jp", "en", "tw", "cn", "kr"].includes(scope.server))
    throw new TypeError("Invalid Bestdori server");
  return Object.freeze({ ...scope, origin: origin.origin });
}
export function publicAssetSource(value: string, scope: PublicSourceScope): string {
  if (/([\\\u0000-\u001f])/u.test(value) || value.split("/").some((part) => part === "." || part === ".."))
    throw new TypeError("Invalid public asset path");
  let source = value;
  if (scope.provider === "haneoka") {
    if (/^(?:Assets|Packages)\//u.test(source)) source = `/assets/${scope.releaseId}/${source}`;
    else if (/^(?:live2d|spine|cri|unity|unity-json|note-se|sonolus)\//u.test(source))
      source = `/runtime/${scope.releaseId}/${source}`;
  }
  const url = new URL(source, scope.origin);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("Invalid public asset source");
  if (scope.provider === "haneoka" && url.origin === scope.origin) {
    const parts = url.pathname.split("/");
    if (["assets", "runtime", "objects"].includes(parts[1] ?? "") && parts[2] === scope.server)
      parts[2] = scope.releaseId!;
    if (["assets", "runtime", "objects"].includes(parts[1] ?? "") && parts[2] !== scope.releaseId)
      throw new TypeError("Asset does not belong to the selected release");
    url.pathname = parts.join("/");
  }
  return url.href;
}
/** Persist only public normalized DTOs; provider-owned handles never enter the manifest. */
export function publicAssetManifest(
  scopeValue: PublicSourceScope,
  file: ResourceBrowserFile,
  insert: ResourceBrowserInsert,
): EditorPublicAsset {
  assertAltairJsonSnapshot(insert.value);
  const scope = validatePublicScope(scopeValue),
    value = structuredClone(record(insert.value)),
    runtime = record(value.runtime);
  const kind = insert.kind === "live2d" ? "model" : (insert.kind as PublicAssetKind);
  if (
    ![
      "model",
      "spine",
      "background",
      "still",
      "frame",
      "stamp",
      "audio",
      "effect",
      "post-effect",
      "video",
      "project",
    ].includes(kind)
  )
    throw new TypeError("Unsupported asset insert kind");
  const members: PublicAssetMember[] = [];
  const add = (role: PublicAssetMember["role"], raw: unknown, label?: string) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const source = publicAssetSource(raw, scope),
      id = label ?? `${role}:${members.filter((m) => m.role === role).length}`;
    if (!members.some((m) => m.role === role && m.source === source)) members.push(Object.freeze({ id, role, source }));
  };
  let format: PublicAssetFormat =
    kind === "audio"
      ? "audio"
      : kind === "video"
        ? "video"
        : ["background", "still", "frame", "stamp"].includes(kind)
          ? "image"
          : "data";
  if (kind === "model" || kind === "spine") {
    const declared = String(runtime.format ?? value.format ?? "");
    const model = runtime.model ?? value.modelUrl;
    const moc = runtime.moc ?? value.mocUrl;
    format =
      kind === "spine" || declared === "spine"
        ? "spine"
        : declared === "cubism2" || (typeof moc === "string" && /\.moc(?:[?#]|$)/iu.test(moc))
          ? "cubism2"
          : declared === "cubism3" ||
              declared === "cubism4" ||
              (typeof model === "string" && /(?:model3\.json|\.moc3)(?:[?#]|$)/iu.test(model))
            ? "cubism3"
            : "data";
    if (format === "data") throw new TypeError("Model runtime format is unavailable");
    add("model", model);
    add("moc", moc);
    add("physics", runtime.physics ?? value.physicsUrl);
    add("pose", runtime.pose ?? value.poseUrl);
    if (format === "spine") {
      add("skeleton", runtime.skeleton ?? value.skeletonUrl ?? model);
      add("atlas", runtime.atlas ?? value.atlasUrl);
    }
    for (const [index, item] of (Array.isArray(runtime.textures) ? runtime.textures : []).entries())
      add("texture", typeof item === "string" ? item : record(item).url, `texture:${index}`);
    for (const role of ["motion", "expression"] as const) {
      const list = runtime[`${role}s`] ?? value[`${role}s`];
      const rows = Array.isArray(list)
        ? list
        : Object.values(record(list)).flatMap((value) => (Array.isArray(value) ? value : [value]));
      for (const [index, item] of rows.entries())
        add(
          role,
          typeof item === "string" ? item : (record(item).runtime ?? record(item).url ?? record(item).file),
          `${role}:${index}:${String(record(item).name ?? "")}`,
        );
    }
    if (
      format === "spine"
        ? !members.some((m) => m.role === "skeleton")
        : !members.some((m) => m.role === "model" || m.role === "moc")
    )
      throw new TypeError("Model resource is missing");
  } else if (kind === "audio") add("audio", value.playableUrl ?? value.url);
  else if (kind === "video") add("video", value.playableUrl ?? value.url);
  else if (kind !== "project")
    add(format === "image" ? "image" : "data", value.url ?? value.texture ?? value.image ?? value.source);
  if (kind !== "project" && !["effect", "post-effect"].includes(kind) && !members.length)
    throw new TypeError("Asset resource is missing");
  if (!members.length && !Object.keys(value).length) throw new TypeError("Asset data is missing");
  const usage = insert.usage;
  if (kind === "audio" && usage !== "bgm" && usage !== "se" && usage !== "voice")
    throw new TypeError("Audio usage is missing");
  const capabilities: EditorPublicAsset["capabilities"][number][] =
    kind === "project"
      ? ["import-project"]
      : kind === "audio"
        ? ["audio"]
        : ["effect", "post-effect"].includes(kind)
          ? ["effect"]
          : ["visual", "transform"];
  if (members.some((m) => m.role === "motion")) capabilities.push("motion");
  if (members.some((m) => m.role === "expression")) capabilities.push("expression");
  if (format === "cubism2" || format === "cubism3") capabilities.push("parameters");
  return Object.freeze({
    schema: "altair-public-asset-v1",
    id: [
      scope.provider,
      scope.origin,
      scope.server,
      scope.releaseId ?? "upstream",
      scope.sourceId ?? "",
      kind,
      insert.key,
    ]
      .map(encodeURIComponent)
      .join(":"),
    key: insert.key,
    kind,
    format,
    name: file.name,
    scope,
    capturedAt: Date.now(),
    members: Object.freeze(members),
    capabilities: Object.freeze(capabilities),
    ...(usage ? { usage: usage as "bgm" | "se" | "voice" } : {}),
    value: freezePublicValue(kind === "project" ? value : normalizePublicValue(value, scope)) as JsonObject,
  });
}

function freezePublicValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezePublicValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Normalize loader URLs while retaining provenance paths and empty texture slots. */
function normalizePublicValue(value: Record<string, unknown>, scope: PublicSourceScope): Record<string, unknown> {
  const fields = new Set([
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
    "thumbnailImage",
    "faceImage",
  ]);
  const visit = (item: unknown, field: string): unknown => {
    if (typeof item === "string")
      return item &&
        fields.has(field) &&
        /^(?:https?:\/\/|\/(?:assets|runtime|objects)\/|(?:Assets|Packages|live2d|spine|cri|unity|unity-json|note-se|sonolus)\/)/u.test(
          item,
        )
        ? publicAssetSource(item, scope)
        : item;
    if (Array.isArray(item)) return item.map((child) => visit(child, field));
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, key)]));
    return item;
  };
  return visit(value, "") as Record<string, unknown>;
}
