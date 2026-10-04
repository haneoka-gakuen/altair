import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryDiagnostic,
  type StorySourceLocation,
} from "@haneoka/altair";
import { VEGA_SYSTEM_OPCODE } from "@haneoka/vega-protocol";
import {
  exportWebGalWorkspace,
  importWebGal,
  parseWebGalScene,
  editWebGalStatement,
} from "@haneoka/altair-plugin-webgal";
import { createFilesZip } from "./archive";
import { projectDirectories, projectFilePath } from "./file-operations";
import type { ProjectFile } from "./library";
import { NATIVE_PROJECT_PATH, nativeScenePath, readNativeWorkspace } from "./native-project";
import { tr } from "./i18n";
import { COMMAND_LIBRARY_PATH } from "./command-library";
import type { EditorSession } from "./session";
import { type WebGalEngine } from "./webgal-engines";

const object = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const escape = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(":", "\\:")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "");
const sourceOf = (value: JsonValue | undefined): string | undefined => {
  const resource = object(value),
    runtime = object(resource.runtime);
  return [resource.playableUrl, resource.url, resource.source, resource.texture, runtime.model, runtime.imageUrl].find(
    (source): source is string => typeof source === "string" && !!source,
  );
};
export interface WebGalGamePlan {
  readonly files: readonly ProjectFile[];
  readonly directories: readonly string[];
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly engine: { id: string; version: string; hash: string };
}
/** Build from a captured document snapshot; no live preview URLs enter the export. */
export function planWebGalGame(options: {
  project: StoryProject;
  files: readonly ProjectFile[];
  documents: readonly { path: string; text: string }[];
  directories?: readonly string[];
  engine: WebGalEngine;
  locale: string;
  locales?: readonly string[];
  signal?: AbortSignal;
}): WebGalGamePlan {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const project = cloneStoryValue(options.project),
    diagnostics: StoryDiagnostic[] = [];
  // Authored lowering keeps scene baselines and source IDs. Recover each original
  // command's source metadata so unknown arguments and opaque commands survive export.
  for (const scene of project.scenes) {
    signal.throwIfAborted();
    const baseline = object(scene.extensions.webgal);
    if (typeof baseline.originalText !== "string" || !Array.isArray(baseline.originalCommandIds)) continue;
    const original = importWebGal(baseline.originalText, { sceneId: scene.id }).project.scenes[0];
    if (!original || original.commands.length !== baseline.originalCommandIds.length) {
      diagnostics.push({
        severity: "warning",
        code: "webgal.source.baselineMismatch",
        path: scene.id,
        fidelity: "preserved-only",
        message: tr(
          "The original WebGAL source no longer matches its command IDs. Review custom commands before exporting.",
        ),
      });
      continue;
    }
    const sources = new Map<string, StorySourceLocation>();
    baseline.originalCommandIds.forEach((id, index) => {
      const source = original.commands[index]?.source;
      if (typeof id === "string" && source) sources.set(id, source);
    });
    for (const command of scene.commands) {
      const source = sources.get(command.id);
      if (source && !command.source && command.extensions.webgalOriginalFields) command.source = source;
    }
  }

  const documents = new Map(options.documents.map((doc) => [doc.path, doc.text]));
  const projectFiles = options.files.filter(
    (file) =>
      !nativeScenePath(file.path) && ![NATIVE_PROJECT_PATH, COMMAND_LIBRARY_PATH, "project.wgcp"].includes(file.path),
  );
  const allPaths = new Set([...projectFiles, ...options.engine.files].map((file) => file.path));
  const reference = (source: string, category: string): string => {
    if (!source || source === "none") return source;
    if (/^https?:\/\//iu.test(source)) {
      diagnostics.push({
        severity: "info",
        code: "webgal.resource.remote",
        path: source,
        message: "The exported game keeps this online resource URL",
      });
      return source;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(source)) throw new Error(`Non-portable resource URL: ${source}`);
    // Direct project paths and imported WebGAL filenames use different bases.
    const direct = source.replace(/^\.\//u, "");
    let path = allPaths.has(direct) ? direct : `game/${category}/${direct}`;
    const resolved = new URL(path, "https://export.invalid/");
    path = decodeURIComponent(resolved.pathname.slice(1));
    if (!allPaths.has(path)) throw new Error(`WebGAL resource is missing: ${source}`);
    const base = ["game", category],
      target = path.split("/");
    let shared = 0;
    while (base[shared] && base[shared] === target[shared]) shared++;
    return [...base.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
  };
  const scenePaths = new Map<string, string>();
  const originalMappings = object(project.extensions["altair:workspace"]).sourcePaths;
  for (const scene of project.scenes) {
    const mapping = Array.isArray(originalMappings)
      ? originalMappings.map(object).find((item) => item.id === scene.id)
      : undefined;
    const old = typeof mapping?.path === "string" ? mapping.path : undefined;
    const path =
      old && /(?:^|\/)scene\//u.test(old)
        ? `game/scene/${old.slice(old.indexOf("scene/") + 6)}`
        : `game/scene/scene-${scenePaths.size + 1}.txt`;
    projectFilePath(path);
    if ([...scenePaths.values()].includes(path)) throw new Error(`Duplicate WebGAL scene path: ${path}`);
    scenePaths.set(scene.id, path);
  }
  project.extensions["altair:workspace"] = {
    ...object(project.extensions["altair:workspace"]),
    sourcePaths: [...scenePaths].map(([id, path]) => ({ id, path })),
  };
  const controls = new Set<string>();
  const localized = (value: JsonValue | undefined): JsonValue | undefined => {
    if (Array.isArray(value)) {
      const index = options.locales?.indexOf(options.locale) ?? 0;
      return value[Math.max(0, index)] ?? value.find((item) => typeof item === "string" && item.trim());
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const text = value[options.locale];
      return text ?? Object.values(value).find((item) => typeof item === "string") ?? value;
    }
    return value;
  };
  for (const [sceneIndex, scene] of project.scenes.entries()) {
    for (const [commandIndex, command] of scene.commands.entries()) {
      signal.throwIfAborted();
      const fields = command.fields;
      const bindings = [
        ["backgroundRef", "background", "background"],
        ["bgmRef", "bgm", "bgm"],
        ["seRef", "se", "vocal"],
        ["stillRef", "still", "figure"],
        ["frameRef", "frame", "figure"],
        ["videoRef", "video", "video"],
        ["live2dKey", "characterModel", "figure"],
      ] as const;
      for (const [key, resolved, category] of bindings) {
        const source = sourceOf(fields[resolved]) ?? (typeof fields[key] === "string" ? fields[key] : undefined);
        if (source) fields[key] = reference(source, category);
      }
      for (const key of ["figureRef", ...(!fields.live2dKey && !fields.figureRef ? ["characterKey"] : [])])
        if (typeof fields[key] === "string") fields[key] = reference(fields[key], "figure");
      if (Array.isArray(fields.voices) || Array.isArray(fields.voiceRefs)) {
        const voices = Array.isArray(fields.voices) ? fields.voices : [],
          refs = Array.isArray(fields.voiceRefs) ? fields.voiceRefs : [];
        fields.voiceRefs = Array.from({ length: Math.max(voices.length, refs.length) }, (_, index) => {
          const source = sourceOf(voices[index]) ?? refs[index];
          return typeof source === "string" ? reference(source, "vocal") : "";
        });
      }
      fields.text = localized(fields.text) ?? "";
      if (Array.isArray(fields.targetTextNames))
        fields.targetTextNames = fields.targetTextNames.map((value) => localized(value) ?? "");
      if (Array.isArray(fields.choices))
        fields.choices = fields.choices.map((value) => {
          const choice = object(value);
          return { ...choice, text: localized(choice.text) ?? "" };
        });
      let raw: string | undefined;
      const key = typeof fields.key === "string" ? fields.key : "";
      if (command.command === VEGA_SYSTEM_OPCODE.JumpScene || command.command === VEGA_SYSTEM_OPCODE.CallScene) {
        const path = typeof fields.sceneId === "string" ? scenePaths.get(fields.sceneId) : undefined;
        if (!path) throw new Error(`WebGAL scene target is missing: ${String(fields.sceneId)}`);
        if (!fields.targetKey)
          raw = `${command.command === VEGA_SYSTEM_OPCODE.JumpScene ? "changeScene" : "callScene"}:${escape(path.slice(11))};`;
      } else if (command.command === VEGA_SYSTEM_OPCODE.ReturnScene)
        raw = `jumpLabel:__altair_return_${encodeURIComponent(scene.id)};`;
      else if (command.command === VEGA_SYSTEM_OPCODE.End)
        raw = fields.returnIfCalled === true ? `jumpLabel:__altair_return_${encodeURIComponent(scene.id)};` : "end;";
      if (raw && fields.condition !== undefined && fields.condition !== null && typeof fields.condition === "object")
        raw = undefined;
      if (raw) {
        const desired = parseWebGalScene(raw).statements[0]!;
        const original = command.source?.raw ? parseWebGalScene(command.source.raw).statements[0] : undefined;
        const inherited = original && original.name.toLowerCase() === desired.name.toLowerCase();
        const base = inherited ? command.source!.raw! : raw;
        const statement = inherited ? original! : desired;
        const oldWhen = inherited
          ? statement.arguments.find((argument) => argument.name.toLowerCase() === "when")?.value
          : undefined;
        const when = fields.condition == null ? undefined : String(fields.condition);
        raw = editWebGalStatement(base, statement, {
          content: desired.content,
          ...(oldWhen !== when ? { arguments: { when } } : {}),
        });
      }
      if (raw) {
        command.source = { format: "webgal", raw: `${key ? `label:${escape(key)} -next;\n` : ""}${raw}` };
        command.extensions.webgalOpaque = true;
        controls.add(`${sceneIndex}:${commandIndex}`);
      }
    }
  }
  const exported = exportWebGalWorkspace({
    project,
    signal,
    options: {
      losslessMetadata: false,
      preserveUnchangedSource: false,
      preserveCraftProject: false,
    },
  });
  diagnostics.push(
    ...exported.diagnostics.map((diagnostic) => {
      const position = diagnostic.path?.match(/\.scenes\[(\d+)\]\.commands\[(\d+)\]/u);
      if (position && controls.has(`${position[1]}:${position[2]}`))
        return {
          ...diagnostic,
          severity: "info" as const,
          code: "webgal.export.control",
          fidelity: "exact" as const,
          message: "Scene control exported to WebGAL",
        };
      return diagnostic;
    }),
  );
  const output = new Map(
    options.engine.files.filter((file) => !file.path.startsWith("game/scene/")).map((file) => [file.path, file]),
  );
  for (const file of projectFiles) {
    // Selected engine owns executable files. The project owns its game directory and extra assets.
    if (output.has(file.path) && !file.path.startsWith("game/")) {
      if (
        ["index.html", "webgal-engine.json", "manifest.json", "service-worker.js", "sw.js"].includes(file.path) ||
        /^(?:lib|icons)\//u.test(file.path) ||
        /^assets\/.*\.(?:js|css|map)$/iu.test(file.path)
      )
        continue;
      throw new Error(`Engine file conflicts with project file: ${file.path}`);
    }
    output.set(file.path, {
      ...file,
      blob: documents.has(file.path) ? new Blob([documents.get(file.path)!]) : file.blob,
    });
  }
  for (const artifact of exported.artifacts)
    output.set(artifact.path, {
      path: artifact.path,
      blob: new Blob([
        new TextDecoder().decode(artifact.bytes),
        `\nlabel:__altair_return_${encodeURIComponent([...scenePaths].find(([, path]) => path === artifact.path)![0])};\n`,
      ]),
    });
  const entry = scenePaths.get(project.entrySceneId)!;
  if (entry !== "game/scene/start.txt") {
    if (scenePaths.size && [...scenePaths.values()].includes("game/scene/start.txt"))
      throw new Error("The WebGAL start scene conflicts with the selected entry scene");
    output.set("game/scene/start.txt", {
      path: "game/scene/start.txt",
      blob: new Blob([`changeScene:${escape(entry.slice(11))};\n`]),
    });
  }
  const files = [...output.values()];
  const directories = projectDirectories(
    files,
    [...options.engine.directories, ...(options.directories ?? [])].filter((path) => !path.startsWith("scenes/")),
  );
  return {
    files,
    directories,
    diagnostics,
    engine: { id: options.engine.manifest.id, version: options.engine.manifest.version, hash: options.engine.hash },
  };
}
export async function prepareWebGalGame(
  session: EditorSession,
  engine: WebGalEngine,
  locale: string,
  signal?: AbortSignal,
): Promise<WebGalGamePlan> {
  await session.compile();
  signal?.throwIfAborted();
  session.validateDocuments();
  const state = session.getSnapshot(),
    host = session.editorHost;
  if (!host) throw new Error("Authoring plugins are unavailable");
  const workspace = readNativeWorkspace(state.documents);
  const project = host.compileDocuments(workspace);
  const plan = planWebGalGame({
    project,
    files: state.files,
    documents: state.documents,
    directories: state.directories,
    engine,
    locale,
    locales: workspace.project.locales,
    signal,
  });
  const files = await Promise.all(
    plan.files.map(async (file) => {
      if (file.path !== "game/config.txt") return file;
      let text = await file.blob.text();
      if (!state.files.some((entry) => entry.path === "game/config.txt") || /^\s*Game_key\s*:\s*;/imu.test(text)) {
        const key = `Game_key:altair-${state.id};`;
        text = /^\s*Game_key\s*:/imu.test(text)
          ? text.replace(/^\s*Game_key\s*:.*?;/imu, () => key)
          : `${key}\n${text}`;
      }
      const title = `Game_name:${escape(project.meta.title)};`;
      return {
        ...file,
        blob: new Blob([
          /^\s*Game_name\s*:/imu.test(text)
            ? text.replace(/^\s*Game_name\s*:.*?;/imu, () => title)
            : `${title}\n${text}`,
        ]),
      };
    }),
  );
  signal?.throwIfAborted();
  const { runtimeLibraries } = await import("./runtimes");
  const libraries = await runtimeLibraries.list();
  const diagnostics = [...plan.diagnostics];
  for (const [id, path] of [
    ["cubism", "lib/live2dcubismcore.min.js"],
    ["cubism2", "lib/live2d.min.js"],
  ] as const) {
    if (files.some((file) => file.path === path)) continue;
    const library = libraries.find((item) => item.id === id);
    if (library) files.push({ path, blob: library.blob });
    else {
      const needed = project.scenes.some((scene) =>
        scene.commands.some((command) => {
          const runtime = object(object(command.fields.characterModel).runtime);
          const model = typeof runtime.model === "string" ? runtime.model : "";
          return id === "cubism"
            ? ["cubism3", "cubism4", "cubism5"].includes(String(runtime.format)) ||
                /model3\.json(?:[?#]|$)/iu.test(model)
            : runtime.format === "cubism2" || /\.model\.json(?:[?#]|$)/iu.test(model);
        }),
      );
      diagnostics.push({
        severity: needed ? "warning" : "info",
        code: "webgal.runtime.missing",
        path,
        ...(needed ? { fidelity: "unsupported" as const } : {}),
        message: `${id === "cubism" ? "Cubism 3/4/5" : "Cubism 2"}: install the model runtime on this device to include it in the exported game`,
      });
    }
  }
  signal?.throwIfAborted();
  return { ...plan, files, directories: projectDirectories(files, plan.directories), diagnostics };
}
export async function createWebGalGameZip(plan: WebGalGamePlan, signal?: AbortSignal): Promise<Blob> {
  return createFilesZip(
    plan.files,
    plan.directories,
    signal,
    new Set(plan.files.filter((file) => /\.(txt|json|html|css|js)$/iu.test(file.path)).map((file) => file.path)),
  );
}
export function downloadWebGalGame(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]/gu, "_")}-webgal.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
