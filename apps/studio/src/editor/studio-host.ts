import {
  type StudioAction,
  type StudioState,
  type StudioProjectSnapshot,
  type StudioDownload,
} from "@haneoka/altair/studio-host";
import type { EditorSession } from "./session";
import { projectFilePath } from "./file-operations";
import { selectInterfaceLanguage } from "./i18n";
import { authoringProjectFiles } from "./authoring-project";

const handlers = new Map<StudioAction, (value?: unknown) => unknown | Promise<unknown>>();
let intent: ((action: StudioAction | "publish") => void) | undefined;
let download: ((value: StudioDownload) => void) | undefined;
let environment: StudioEnvironment = {};
export interface StudioEnvironment {
  readonly locale?: string;
  readonly theme?: "light" | "dark";
  readonly tokens?: Readonly<Record<string, string>>;
  readonly fontFamily?: string;
  readonly fontStylesheets?: readonly string[];
  readonly origin?: string;
  readonly server?: string;
  readonly runtimeSources?: { cubismCoreUrl?: string; cubism2CoreUrl?: string; motionSyncCoreUrl?: string };
}
export const studioEnvironment = () => environment;
export function configureStudio(value: StudioEnvironment): void {
  environment = { ...environment, ...value };
  if (value.locale) selectInterfaceLanguage(value.locale);
  if (value.theme) document.documentElement.dataset.theme = value.theme;
  for (const [name, token] of Object.entries(value.tokens ?? {}))
    if (name.startsWith("--md-sys-") || name.startsWith("--md-ref-typeface-")) document.documentElement.style.setProperty(name, token);
  if (value.fontFamily) document.documentElement.style.setProperty("--app-font", value.fontFamily);
  if (value.fontStylesheets) {
    const sources = new Set(value.fontStylesheets.map((source) => new URL(source, document.baseURI).href));
    for (const link of document.querySelectorAll<HTMLLinkElement>("link[data-studio-host-font]"))
      if (!sources.has(link.href)) link.remove();
    for (const source of sources) {
      if (new URL(source).origin !== location.origin) continue;
      if ([...document.querySelectorAll<HTMLLinkElement>("link[data-studio-host-font]")].some((link) => link.href === source)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = source;
      link.dataset.studioHostFont = "";
      document.head.append(link);
    }
  }
}
export function registerStudioActions(
  actions: Partial<Record<StudioAction, (value?: unknown) => unknown | Promise<unknown>>>,
): () => void {
  for (const [name, action] of Object.entries(actions)) handlers.set(name as StudioAction, action!);
  return () => {
    for (const [name, action] of Object.entries(actions))
      if (handlers.get(name as StudioAction) === action) handlers.delete(name as StudioAction);
  };
}
export async function executeStudioAction(action: StudioAction, value?: unknown): Promise<unknown> {
  const run = handlers.get(action);
  if (!run) throw new Error("studio_not_ready");
  return run(value);
}
export function registerStudioIntent(send: (action: StudioAction | "publish") => void): () => void {
  intent = send;
  return () => {
    if (intent === send) intent = undefined;
  };
}
export function studioIntent(action: StudioAction | "publish"): boolean {
  if (!intent || document.documentElement.dataset.studioHosted !== "true") return false;
  intent(action);
  return true;
}
export function registerStudioDownload(send: (value: StudioDownload) => void): () => void {
  download = send;
  return () => {
    if (download === send) download = undefined;
  };
}
export function downloadStudioFile(blob: Blob, name: string): void {
  if (download && document.documentElement.dataset.studioDownloads === "true") {
    download({ kind: "download", blob, name });
    return;
  }
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function studioState(session?: EditorSession): StudioState {
  if (!session)
    return {
      projectId: null,
      title: "Altair",
      sourceVersion: "",
      dirty: false,
      busy: false,
      canUndo: false,
      canRedo: false,
      error: "",
    };
  const state = session.getSnapshot();
  return {
    projectId: state.id,
    title: state.project?.meta.title ?? state.name,
    sourceVersion: `${state.id}:${state.contentVersion}`,
    dirty: state.documents.some((document) => document.text !== document.baseline),
    busy: state.compiling || state.saving,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    error: state.error,
    storage: state.localFolder ? "folder" : "browser",
    storagePath: state.localFolder,
    localSaved: state.localFolder
      ? !state.saving && !state.documents.some((document) => document.text !== document.baseline)
      : !session.draftPending,
    fileCount: state.files.length,
    line: state.line,
    activePath: state.active,
  };
}
export async function studioProjectSnapshot(session: EditorSession): Promise<StudioProjectSnapshot> {
  await session.settleSourceWrites();
  session.lifetimeSignal.throwIfAborted();
  const state = session.getSnapshot();
  const documents = new Map(state.documents.map((document) => [document.path, document]));
  return {
    id: state.id,
    title: state.project?.meta.title || state.name || "Altair",
    sourceVersion: studioState(session).sourceVersion,
    directories: [...state.directories],
    files: await authoringProjectFiles(state.files, [...documents.values()]),
  };
}
