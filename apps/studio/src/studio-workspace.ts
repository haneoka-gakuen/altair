import type { StoryDiagnostic, StoryProject } from "@haneoka/altair";

export interface StudioSourceDocument {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly sourcePath: string;
  readonly text: string;
}

export interface StudioWorkspaceImport {
  readonly project: StoryProject | null;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly errors: ReadonlyMap<string, string>;
}

export const updateStudioDocument = (
  documents: readonly StudioSourceDocument[],
  id: string,
  text: string,
): StudioSourceDocument[] => documents.map((document) => (document.id === id ? { ...document, text } : document));

export const moveStudioSourceLine = (source: string, fromLine: number, toLine: number): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const from = Math.max(0, Math.min(lines.length - 1, Math.round(fromLine) - 1));
  const to = Math.max(0, Math.min(lines.length - 1, Math.round(toLine) - 1));
  if (from === to) return source;
  const [moved] = lines.splice(from, 1);
  if (moved === undefined) return source;
  lines.splice(to, 0, moved);
  return lines.join(newline);
};

export const removeStudioSourceLine = (source: string, line: number): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (!lines.length) return source;
  const index = Math.max(0, Math.min(lines.length - 1, Math.round(line) - 1));
  lines.splice(index, 1);
  return lines.join(newline);
};

export const appendUniqueStudioDocuments = (
  current: readonly StudioSourceDocument[],
  incoming: readonly StudioSourceDocument[],
): StudioSourceDocument[] => {
  const next = [...current];
  for (const document of incoming) {
    const index = next.findIndex(({ id }) => id === document.id);
    if (index >= 0) next[index] = document;
    else next.push(document);
  }
  return next;
};
