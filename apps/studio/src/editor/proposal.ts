import type { AnogoBindings } from "./ai/anogo";
export interface DocumentChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}
export interface EditorProposal {
  readonly id: string;
  readonly origin: "ai" | "storyboard" | "prose";
  readonly title: string;
  readonly createdAt: string;
  readonly baselines?: readonly { path: string; text: string }[];
  readonly changes: readonly DocumentChange[];
  readonly issues?: readonly string[];
  readonly detail?: string;
  readonly previewLocale?: string;
  readonly data?: unknown;
}

export interface EditorAiDraft {
  anogo?: { source: string; parsed: string; bindings?: AnogoBindings; placement: "after" | "end" | "replace" };
  prompt: string;
  response: string;
  task: "edit" | "director" | "translate" | "vision";
  scope: "selection" | "scene" | "project";
  targetLocale: string;
}
