import { assertStoryProjectProtocol, type JsonObject, type StoryProject } from "@haneoka/altair/model";
import { importBestdoriCommunityStory, parseBestdoriCommunitySource } from "@haneoka/altair-plugin-bestdori";
import { importAdvStoryJson } from "@haneoka/altair-plugin-adv";
import { storyProjectToAuthoredWorkspace } from "@haneoka/altair-plugin-adv/documents";
import { webGalCommandToAuthoredNode } from "@haneoka/altair-plugin-webgal";
import {
  directAssetField,
  directAssetLocation,
  storyResourceMetadataField,
  storyResourceDirectoryField,
  compileVegaProjectWithDiagnostics,
  canonicalizeNativeStage,
} from "@haneoka/altair-plugin-vega-preview/projection";
import { prepareStoryPackage } from "@haneoka/altair-plugin-vega-preview/packaging";
import { workspaceFiles, NATIVE_RUNTIME_PLUGINS } from "./native-project";
import { projectFilePath } from "./file-operations";
import { publicAssetSource, validatePublicScope, type PublicSourceScope } from "./resource-manifest";
import { publicResourceRequestUrl, type PublicResourceSource } from "./public-resource-host";
import { studioPublicResourceHost } from "./public-resource-bootstrap";
import { readPublicResponse } from "./public-response";
import type { LibraryProject, ProjectFile } from "./library";

function relativePath(from: string, to: string): string {
  const left = from.split("/").slice(0, -1),
    right = to.split("/");
  let same = 0;
  while (left[same] && left[same] === right[same]) same++;
  return [...left.slice(same).map(() => ".."), ...right.slice(same)].join("/");
}

/** Capture the resource graph before the project becomes a local editable document. */
export async function captureSourceProject(
  input: StoryProject,
  scope: PublicSourceScope,
  signal: AbortSignal,
  sourceFiles: ReadonlyMap<string, Blob> = new Map(),
  missingFiles: ReadonlySet<string> = new Set(),
): Promise<LibraryProject> {
  assertStoryProjectProtocol(input);
  input = canonicalizeNativeStage(input);
  const aliases = compileVegaProjectWithDiagnostics(input).project.assets;
  const sources = new Map<string, string>(),
    paths = new Map<string, string>(),
    origins = new Map<string, number>();
  const files: ProjectFile[] = [],
    members: JsonObject[] = [];
  let totalBytes = 0;
  const locate = (raw: string, parent?: string, directory = false): string => {
    if (!parent && missingFiles.has(raw)) return projectFilePath(raw);
    const relative = parent ? new URL(raw, parent) : undefined;
    const localPath = relative?.protocol === "altair-project:" ? decodeURIComponent(relative.pathname.slice(1)) : raw;
    const source =
      sourceFiles.has(localPath) || (directory && parent?.startsWith("altair-project:"))
        ? new URL(localPath.split("/").map(encodeURIComponent).join("/"), "altair-project://root/").href
        : parent?.startsWith("altair-project:")
          ? (() => {
              throw new Error(`Missing resource: ${localPath}`);
            })()
          : publicAssetSource(relative?.href ?? aliases?.[raw]?.source ?? raw, scope);
    const known = sources.get(source);
    if (known) return known;
    const url = new URL(source);
    if (!origins.has(url.origin)) origins.set(url.origin, origins.size);
    const original = projectFilePath(
      `assets/imported/${origins.get(url.origin)}/${decodeURIComponent(url.pathname.slice(1))}`,
    );
    let path = original;
    for (let suffix = 1; paths.has(path) && paths.get(path) !== source; suffix++) {
      const dot = original.lastIndexOf(".");
      path =
        dot > original.lastIndexOf("/")
          ? `${original.slice(0, dot)}-${suffix}${original.slice(dot)}`
          : `${original}-${suffix}`;
    }
    if (!directory) sources.set(source, path);
    paths.set(path, source);
    return path;
  };
  const visit = (value: unknown, resource = false, parent?: string, documentPath?: string): unknown => {
    if (typeof value === "string") {
      if (!resource || !value || value === "none" || !directAssetLocation(value)) return value;
      const local = locate(value, parent);
      return documentPath ? relativePath(documentPath, local) : local;
    }
    if (Array.isArray(value)) return value.map((child) => visit(child, resource, parent, documentPath));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        storyResourceMetadataField(key)
          ? child
          : storyResourceDirectoryField(key)
            ? directory(child, parent)
            : visit(
                child,
                resource ||
                  directAssetField(key) ||
                  (key.toLowerCase() === "runtime" && typeof child === "string") ||
                  /^(?:sound|displayinfo)$/iu.test(key),
                parent,
                documentPath,
              ),
      ]),
    );
  };
  const directory = (value: unknown, parent?: string): unknown => {
    if (typeof value === "string" && value) return locate(value, parent, true);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, directory(child, parent)]));
    return value;
  };
  const project: StoryProject = {
    ...structuredClone(input),
    assets: visit(input.assets) as JsonObject,
    runtime: visit(input.runtime) as JsonObject,
    storyFields: visit(input.storyFields) as JsonObject,
    scenes: input.scenes.map((scene) => ({
      ...structuredClone(scene),
      commands: scene.commands.map((command) => ({
        ...structuredClone(command),
        fields: visit(command.fields) as JsonObject,
        extensions: {
          ...structuredClone(command.extensions),
          ...(command.extensions.advCodec &&
          typeof command.extensions.advCodec === "object" &&
          !Array.isArray(command.extensions.advCodec)
            ? {
                advCodec: {
                  ...command.extensions.advCodec,
                  fields: visit(command.extensions.advCodec.fields) as JsonObject,
                },
              }
            : {}),
        },
      })),
    })),
  };
  const loaded = new Set<string>(),
    lifetime = new AbortController();
  const transferSignal = AbortSignal.any([signal, lifetime.signal]);
  const download = async ([source, path]: [string, string]) => {
    try {
      transferSignal.throwIfAborted();
      if (loaded.size >= 20_000) throw new RangeError("Story resource count exceeds its limit");
      const local =
        new URL(source).protocol === "altair-project:"
          ? sourceFiles.get(decodeURIComponent(new URL(source).pathname.slice(1)))
          : undefined;
      const bytes = local
        ? new Uint8Array(await local.arrayBuffer())
        : await readPublicResponse(publicResourceRequestUrl(source, scope), {
            label: "Story resource",
            maxBytes: 256 * 1024 ** 2,
            signals: [transferSignal],
          });
      totalBytes += bytes.byteLength;
      if (totalBytes > 2 * 1024 ** 3) throw new RangeError("Story resources exceed their byte limit");
      let blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
      if (/\.(?:json|wmdl)$/iu.test(new URL(source).pathname)) {
        if (bytes.byteLength > 16 * 1024 ** 2) throw new RangeError("Story resource document is too large");
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        blob = new Blob([JSON.stringify(visit(value, false, source, path))], { type: "application/json" });
      } else if (/\.jsonl$/iu.test(new URL(source).pathname)) {
        const lines = new TextDecoder().decode(bytes).split(/\r?\n/u);
        blob = new Blob([
          lines
            .map((line) => (line.trim() ? JSON.stringify(visit(JSON.parse(line), false, source, path)) : line))
            .join("\n"),
        ]);
      } else if (/\.atlas(?:\.txt)?$/iu.test(new URL(source).pathname)) {
        let page = true;
        const lines = new TextDecoder()
          .decode(bytes)
          .split(/\r?\n/u)
          .map((line) => {
            if (!line.trim()) {
              page = true;
              return line;
            }
            if (!page) return line;
            page = false;
            return relativePath(path, locate(line.trim(), source));
          });
        blob = new Blob([lines.join("\n")], { type: "text/plain" });
      }
      const originalSha256 = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      members.push({ source, path, originalSha256, originalBytes: bytes.byteLength, importedBytes: blob.size });
      files.push({ path, blob });
      loaded.add(source);
    } catch (error) {
      lifetime.abort(error);
      throw error;
    }
  };
  for (;;) {
    const pending = [...sources].filter(([source]) => !loaded.has(source));
    if (!pending.length) break;
    for (let offset = 0; offset < pending.length; offset += 4) {
      const outcomes = await Promise.allSettled(pending.slice(offset, offset + 4).map(download));
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  members.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const compiled = compileVegaProjectWithDiagnostics(project);
  const prepared = await prepareStoryPackage(compiled.project, files);
  const unresolved = prepared.issues.filter((issue) => !missingFiles.has(issue.source));
  if (unresolved.length) throw new Error(`Missing resources: ${unresolved.map((issue) => issue.source).join(", ")}`);
  project.extensions.publicAssetImports = [
    ...(Array.isArray(project.extensions.publicAssetImports) ? project.extensions.publicAssetImports : []),
    {
      id: crypto.randomUUID(),
      source: { ...scope },
      members: members.filter((member) => /^https?:\/\//u.test(String(member.source))),
    },
  ];
  const workspace = storyProjectToAuthoredWorkspace(project, webGalCommandToAuthoredNode);
  const id = crypto.randomUUID();
  return {
    id,
    name: project.meta.title,
    updatedAt: Date.now(),
    files: [
      ...workspaceFiles({
        ...workspace,
        project: {
          ...workspace.project,
          id,
          plugins: [
            ...workspace.project.plugins,
            ...NATIVE_RUNTIME_PLUGINS.filter(
              (plugin) => !workspace.project.plugins.some((existing) => existing.id === plugin.id),
            ),
          ],
        },
      }),
      ...files,
    ],
  };
}

export async function importCommunitySource(
  input: unknown,
  origin: string,
  signal: AbortSignal,
  locale?: string,
): Promise<LibraryProject> {
  const parsed = parseBestdoriCommunitySource(input);
  const region = ["jp", "en", "tw", "cn", "kr"][parsed.source.server ?? 0]!;
  const scope = validatePublicScope({ provider: "bestdori", origin, server: region });
  const base = new URL(`/api/v1/garupa/bestdori/${region}/`, scope.origin);
  const project = importBestdoriCommunityStory(input, {
    ...(locale ? { locale } : {}),
    proxify: (path) =>
      /^https?:\/\//u.test(path) ? path : new URL(`raw${path.startsWith("/") ? path : `/${path}`}`, base).href,
  }).project;
  const assets = Array.isArray(project.assets.live2d) ? project.assets.live2d : [];
  const hydrated: JsonObject[] = [];
  for (let offset = 0; offset < assets.length; offset += 64) {
    const batch = assets.slice(offset, offset + 64).map((value) => value as JsonObject),
      url = new URL("live2d", base);
    const keys = batch.map((value) => String(value.id ?? value.live2dKey).replace(/^bestdori:live2d:/u, ""));
    for (const key of keys) url.searchParams.append("id", key);
    const response = JSON.parse(
      new TextDecoder().decode(
        await readPublicResponse(url.href, {
          label: "Model source",
          maxBytes: 16 * 1024 ** 2,
          json: true,
          signals: [signal],
        }),
      ),
    ) as JsonObject;
    const items = response.items as JsonObject;
    batch.forEach((value, index) => {
      const model = items?.[keys[index]!];
      if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`Missing model: ${keys[index]}`);
      hydrated.push({ ...value, ...model, id: value.id ?? value.live2dKey!, live2dKey: value.live2dKey ?? value.id! });
    });
  }
  project.assets.live2d = hydrated;
  project.runtime.presentation = { mode: "our-notes" };
  project.extensions.archiveSource = {
    provider: "bestdori",
    kind: "community",
    snapshot: parsed.source as unknown as JsonObject,
    metadata: parsed.metadata as JsonObject,
  };
  return captureSourceProject(project, scope, signal);
}

export async function importOpenotesSource(
  input: unknown,
  origin: string,
  signal: AbortSignal,
  files: readonly ProjectFile[],
  locale = "zh-CN",
): Promise<LibraryProject> {
  const [
    { createHaneokaResourceBrowser },
    { parseOpenotesProject, openotesReferences, importOpenotesProject, OPENOTES_SOURCE },
    { resolveHaneokaPublicScope, fetchPublicCatalogJson },
  ] = await Promise.all([
    import("@haneoka/altair-plugin-haneoka"),
    import("@haneoka/altair-plugin-haneoka/openotes"),
    import("./public-resource-providers"),
  ]);
  const source = parseOpenotesProject(input),
    refs = openotesReferences(source);
  const scope = await resolveHaneokaPublicScope({ origin, server: "jp", signal });
  const browser = createHaneokaResourceBrowser({
    fetchCatalog: ({ resource, view, signal }) => {
      const path = resource + (view ? `/views/${view}` : "");
      const url = new URL(`/api/v1/servers/${scope.server}/${path}`, scope.origin);
      url.searchParams.set("release", scope.releaseId!);
      return fetchPublicCatalogJson(url.href, signal);
    },
  });
  const models = new Map<string, JsonObject>(),
    backgrounds = new Map<string, JsonObject>(),
    audio = new Map<string, JsonObject>();
  const sourceFiles = new Map(files.map((file) => [file.path, file.blob]));
  for (const key of refs.models) {
    const resolved = await browser.resolveInsert({
      release: scope.releaseId!,
      descriptor: { kind: "live2d", key },
      signal,
    });
    if (!resolved) throw new Error(`Missing model: ${key}`);
    models.set(key, resolved.value as JsonObject);
  }
  const catalogUrl = new URL(`/api/v1/servers/${scope.server}/story-assets/views/backgrounds`, scope.origin);
  catalogUrl.searchParams.set("release", scope.releaseId!);
  const visualCatalog = (await fetchPublicCatalogJson(catalogUrl.href, signal)) as JsonObject;
  const backgroundEntries = Object.values(
    visualCatalog.backgrounds && typeof visualCatalog.backgrounds === "object"
      ? visualCatalog.backgrounds
      : visualCatalog,
  );
  for (const assetId of refs.backgrounds) {
    const match = backgroundEntries.find(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        [value.assetId, value.assetName, value.stageRef, value.resourceRef].includes(assetId),
    ) as JsonObject | undefined;
    const key = typeof match?.assetId === "string" ? match.assetId : assetId;
    const resolved = await browser.resolveInsert({
      release: scope.releaseId!,
      descriptor: { kind: "visual", visualKind: "background", assetId: key },
      signal,
    });
    if (!resolved) throw new Error(`Missing background: ${assetId}`);
    backgrounds.set(assetId, resolved.value as JsonObject);
  }
  const missing = new Set<string>();
  for (const key of refs.audio) {
    projectFilePath(key);
    audio.set(key, { resourceRef: key, playableUrl: key });
    if (!sourceFiles.has(key)) missing.add(key);
  }
  const project = importOpenotesProject(
    source,
    { models, backgrounds, audio },
    { locale, releaseServer: scope.server },
  );
  const provenance = project.extensions[OPENOTES_SOURCE] as JsonObject;
  provenance.missingFiles = [...missing];
  project.extensions["haneoka.authoring.missingFiles"] = [...missing];
  return captureSourceProject(project, scope, signal, sourceFiles, missing);
}

async function importProviderStory(
  source: PublicResourceSource,
  storyId: string,
  signal: AbortSignal,
): Promise<LibraryProject> {
  const scope = validatePublicScope(source);
  const base = new URL(
    source.provider === "sekai" ? `/api/v1/sekai/${source.server}/` : `/api/v1/garupa/bestdori/${source.server}/`,
    source.origin,
  );
  const json = async (url: URL) =>
    JSON.parse(
      new TextDecoder().decode(
        await readPublicResponse(url.href, {
          label: "Story source",
          maxBytes: 16 * 1024 ** 2,
          json: true,
          signals: [signal],
        }),
      ),
    ) as JsonObject;
  const story = await json(new URL(`stories/${encodeURIComponent(storyId)}`, base));
  const assets = story.assets as JsonObject;
  const keys = [
    ...new Set(
      (Array.isArray(assets?.live2d) ? assets.live2d : []).flatMap((value) => {
        const key = value && typeof value === "object" && !Array.isArray(value) ? value.live2dKey : undefined;
        return typeof key === "string" && key ? [key] : [];
      }),
    ),
  ];
  const models: JsonObject[] = [];
  for (let start = 0; start < keys.length; start += 64) {
    const url = new URL("live2d", base),
      batch = keys.slice(start, start + 64);
    for (const key of batch) url.searchParams.append("id", key);
    if (typeof story.sourceServer === "string") url.searchParams.set("server", story.sourceServer);
    const body = await json(url),
      entries = body.items as JsonObject;
    for (const key of batch) {
      const entry = entries?.[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Missing model: ${key}`);
      models.push({ id: key, live2dKey: key, ...entry });
    }
  }
  const project = importAdvStoryJson({ ...story, assets: { ...assets, live2d: models } }, { title: storyId }).project;
  project.meta.provenance = {
    ...project.meta.provenance,
    format: source.provider === "sekai" ? "sekai-scenario" : "bestdori-scenario",
    storyId,
    server: source.server,
  };
  project.runtime.presentation = { mode: "our-notes" };
  project.extensions.archiveSource = {
    provider: source.provider,
    source: new URL(`stories/${encodeURIComponent(storyId)}`, base).href,
    snapshot: story,
  };
  return captureSourceProject(project, scope, signal);
}

export async function importPublicStory(
  source: PublicResourceSource,
  storyId: string,
  signal: AbortSignal,
): Promise<LibraryProject> {
  if (source.provider !== "haneoka") return importProviderStory(source, storyId, signal);
  const connection = await studioPublicResourceHost.connect(source, signal);
  try {
    const request = {
      acceptedKinds: ["project"],
      preferredKind: "project",
      signal,
      context: { catalogView: "grid", recursive: true },
    };
    const path = connection.catalog.preferredPath(request);
    const nodes = await connection.catalog.list(path, request);
    const file = nodes.find(
      (node) => node.type === "file" && node.id === `haneoka:story:${encodeURIComponent(storyId)}`,
    );
    if (!file || file.type !== "file") throw new Error("Story was not found");
    const asset = await connection.catalog.select(file, request);
    if (asset.kind !== "project") throw new Error("Expected a story project");
    return captureSourceProject(asset.value as unknown as StoryProject, connection.catalog.scope, signal);
  } finally {
    connection.dispose();
  }
}
