/// <reference lib="dom" />

import type { JsonValue, StoryProject, StoryScene } from "./model.js";
import type { AltairContribution, AltairOperationContext } from "./plugin-contributions.js";
import type { AltairAuthoredNode } from "./documents.js";

export interface AltairEditorDocument {
  readonly path: string;
  readonly text: string;
  readonly baseline: string;
  readonly revision: number;
  readonly external?: string | undefined;
}

export interface AltairEditorFile {
  readonly path: string;
  readonly blob: Blob;
}

export interface AltairEditorSnapshot {
  readonly active: string;
  readonly documents: readonly AltairEditorDocument[];
  readonly files: readonly AltairEditorFile[];
  readonly project?: StoryProject | undefined;
  readonly line: number;
  readonly view?: string;
}

export interface AltairEditorWorkspace {
  getSnapshot(): AltairEditorSnapshot;
  subscribe(listener: () => void): () => void;
  document(path?: string): AltairEditorDocument | undefined;
  update(path: string, text: string): void;
  activate(path: string, line?: number): void;
  select(line: number): void;
  setView(view: string): void;
  editArgument(nodeId: string, key: string, value: JsonValue, path?: string): void;
  resolveConflict(path: string, source: "disk" | "editor"): void;
  addFile(path: string, blob: Blob, options?: { open?: boolean }): Promise<void>;
  save(): Promise<void>;
  translate(key: string, values?: Record<string, unknown>): string;
}

export interface AltairDocumentEditorContribution extends AltairContribution {
  readonly label: string;
  readonly panelId?: string;
  readonly affectsPreview?: boolean;
  matches(path: string): boolean;
  create?(name: string): { readonly path: string; readonly text: string };
  validate?(document: Pick<AltairEditorDocument, "path" | "text">): void;
  preview?(
    document: Pick<AltairEditorDocument, "path" | "text">,
    project: StoryProject,
    context: AltairOperationContext,
  ): AltairDocumentPreview | Promise<AltairDocumentPreview>;
}

export interface AltairDocumentPreview {
  readonly scene: StoryScene;
  readonly commandId?: string;
}

export interface AltairPropertyEditorContribution extends AltairContribution {
  readonly panelId: string;
  matches(node: AltairAuthoredNode, field: string): boolean;
}
