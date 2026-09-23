import type { VegaPlugin } from "@haneoka/vega/engine";
import { normalizeBrowserWorkspacePath } from "@haneoka/altair-plugin-workspace-browser";
import type { ProjectFile } from "./library";

interface ResourceFile {
  readonly path: string;
  readonly blob: Blob;
  readonly text?: string;
}
export class PreviewResources {
  private readonly scope: string;
  constructor(projectId: string = crypto.randomUUID()) {
    this.scope = Array.from(new TextEncoder().encode(projectId), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  private current: readonly ResourceFile[] = [];
  private currentFiles: ReadonlyMap<string, ResourceFile> = new Map();
  private readonly folded = new WeakMap<object, ReadonlyMap<string, ResourceFile | null>>();
  private urls: ReadonlyMap<string, string> = new Map();
  private readonly snapshots = new Map<string, ReadonlyMap<string, ResourceFile>>();
  private disposed = false;
  readonly plugin: VegaPlugin = {
    manifest: {
      id: "studio.resources",
      name: "Project resources",
      version: "0.1.0",
      apiVersion: 1,
      capabilities: ["resource"],
    },
    setup: (context) => {
      context.contribute("resource", {
        id: "project",
        schemes: ["project"],
        load: async (url, signal) => {
          signal.throwIfAborted();
          if (this.disposed) throw new Error("Project resources are closed");
          const files =
            this.snapshots.get(url.host) ?? (url.host.startsWith(`${this.scope}.v`) ? this.currentFiles : undefined);
          if (!files) throw new Error("Project resource scope is unavailable");
          const path = normalizeBrowserWorkspacePath(decodeURIComponent(url.pathname.replace(/^\//u, "")));
          let file = files.get(path);
          if (!file) {
            let index = this.folded.get(files);
            if (!index) {
              const values = new Map<string, ResourceFile | null>();
              for (const file of files.values()) {
                const key = file.path.toLocaleLowerCase("en-US");
                values.set(key, values.has(key) ? null : file);
              }
              this.folded.set(files, values);
              index = values;
            }
            file = index.get(path.toLocaleLowerCase("en-US")) ?? undefined;
          }
          if (!file) throw new Error(`Project file is missing or ambiguous: ${path}`);
          const bytes =
            file.text === undefined
              ? new Uint8Array(await file.blob.arrayBuffer())
              : new TextEncoder().encode(file.text);
          signal.throwIfAborted();
          return bytes;
        },
      });
    },
  };
  publish(
    files: readonly ProjectFile[],
    documents: readonly { readonly path: string; readonly text: string }[],
  ): ReadonlyMap<string, string> {
    if (this.disposed) throw new Error("Project resources are closed");
    const text = new Map(documents.map((doc) => [doc.path, doc.text]));
    const next = files.map((file) => ({ ...file, ...(text.has(file.path) ? { text: text.get(file.path)! } : {}) }));
    const equal =
      next.length === this.current.length &&
      next.every((file, index) => {
        const previous = this.current[index];
        if (!previous || previous.path !== file.path || previous.text !== file.text) return false;
        if (file.text !== undefined || previous.blob === file.blob) return true;
        return (
          file.blob instanceof File &&
          previous.blob instanceof File &&
          file.blob.size === previous.blob.size &&
          file.blob.lastModified === previous.blob.lastModified
        );
      });
    if (equal) return this.urls;
    const host = `${this.scope}.v${crypto.randomUUID()}`;
    this.current = next;
    this.currentFiles = new Map(next.map((file) => [file.path, file]));
    this.snapshots.set(host, this.currentFiles);
    this.urls = new Map(
      next.map((file) => [file.path, `project://${host}/${file.path.split("/").map(encodeURIComponent).join("/")}`]),
    );
    return this.urls;
  }
  dispose(): void {
    this.disposed = true;
    this.current = [];
    this.currentFiles = new Map();
    this.urls = new Map();
    this.snapshots.clear();
  }
}
