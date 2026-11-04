import { compileVegaProjectWithDiagnostics } from "@haneoka/altair-plugin-vega-preview/projection";
import { unsupportedVegaFullPresetPlugins } from "@haneoka/vega-preset-full/capabilities";
import { prepareStoryPackage, mapStoryProjectResources } from "@haneoka/altair-plugin-vega-preview/packaging";
import { createFilesZip } from "./archive";
import { runtimeLibraries } from "./runtimes";
import type { EditorSession } from "./session";
import type { ProjectFile } from "./library";
import { tr } from "./i18n";
import { downloadStudioFile } from "./studio-host";
export async function exportVegaGame(session: EditorSession, signal: AbortSignal): Promise<void> {
  await session.compile();
  signal.throwIfAborted();
  const state = session.getSnapshot();
  if (!state.project || state.error) throw new Error(state.error || tr("Project is not ready"));
  const result = compileVegaProjectWithDiagnostics(state.project, { preserveAuthoringSource: false });
  if (result.diagnostics.some((d) => d.severity === "error")) throw new Error(tr("Check the project before exporting"));
  const unavailable = unsupportedVegaFullPresetPlugins(result.project);
  if (unavailable.length) throw new Error(`${tr("Unsupported runtime plugins")}: ${unavailable.join(", ")}`);
  const files = state.files.map((file) => ({
    ...file,
    blob:
      session.document(file.path) && session.document(file.path)!.text !== session.document(file.path)!.baseline
        ? new Blob([session.document(file.path)!.text], { type: "text/plain" })
        : file.blob,
  }));
  const prepared = await prepareStoryPackage(result.project, files);
  if (prepared.issues.length)
    throw new Error(`${tr("Missing resources")}: ${prepared.issues.map((i) => i.source).join(", ")}`);
  const resources = new Set(prepared.resources),
    project = mapStoryProjectResources(
      prepared.project,
      (source) => (resources.has(source.replace(/^\.\//u, "")) ? `game/${source.replace(/^\.\//u, "")}` : source),
      "game/",
    );
  const manifestUrl = new URL("player-bundle.json", document.baseURI),
    response = await fetch(manifestUrl, { signal });
  if (!response.ok) throw new Error(tr("Vega player bundle is missing"));
  const bundle = (await response.json()) as { version: number; entry: string; files: string[] };
  if (
    bundle.version !== 1 ||
    !bundle.files.includes(bundle.entry) ||
    bundle.files.some(
      (path) => path.startsWith("/") || path.split("/").some((part) => !part || part === ".." || part === "."),
    )
  )
    throw new Error(tr("Vega player bundle is invalid"));
  const output: ProjectFile[] = files
    .filter((file) => resources.has(file.path))
    .map((file) => ({ path: `game/${file.path}`, blob: file.blob }));
  for (const path of bundle.files) {
    signal.throwIfAborted();
    const resource = await fetch(new URL(`player/${path}`, manifestUrl), { signal });
    if (!resource.ok) throw new Error(`${tr("File is missing")}: ${path}`);
    let blob = await resource.blob();
    if (path.endsWith(".gz")) {
      const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (header[0] !== 0x1f || header[1] !== 0x8b)
        blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    }
    output.push({ path: path === bundle.entry ? "index.html" : path, blob });
  }
  const runtime = await runtimeLibraries.sources(),
    runtimePaths: Record<string, string> = {};
  const requiredRuntimes = new Set<string>();
  for (const path of prepared.resources) {
    if (/\.moc3$/iu.test(path)) requiredRuntimes.add("cubismCoreUrl");
    if (/\.moc$/iu.test(path)) requiredRuntimes.add("cubism2CoreUrl");
    if (/\.motionsync3?\.json$/iu.test(path)) requiredRuntimes.add("motionSyncCoreUrl");
  }
  if (requiredRuntimes.has("cubismCoreUrl") && runtime.motionSyncCoreUrl) requiredRuntimes.add("motionSyncCoreUrl");
  for (const key of requiredRuntimes) {
    const url = runtime[key as keyof typeof runtime];
    if (!url) throw new Error(tr("Model runtime is missing"));
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(tr("Model runtime is missing"));
    const path = `engine/${key}.js`;
    output.push({ path, blob: await res.blob() });
    runtimePaths[key] = path;
  }
  output.push(
    { path: "engine/runtime.json", blob: new Blob([JSON.stringify(runtimePaths)], { type: "application/json" }) },
    { path: "project.json", blob: new Blob([JSON.stringify(project)], { type: "application/json" }) },
  );
  const blob = await createFilesZip(output, [], signal);
  downloadStudioFile(blob, `${state.name.replace(/[\\/:*?"<>|]/gu, "_")}-game.zip`);
}
