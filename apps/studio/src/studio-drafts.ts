import type { AltairDraftSession } from "@haneoka/altair-plugin-drafts";

export interface StudioDraftDocument {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

/**
 * Rebase every pending scene after one or more source files are saved.
 *
 * All mutations are enqueued before the first await. Edits arriving while the
 * save is flushing are therefore ordered after the rebase and remain pending.
 */
export const rebaseStudioDrafts = async (
  session: AltairDraftSession,
  documents: readonly StudioDraftDocument[],
  baselines: ReadonlyMap<string, string>,
  projectSnapshot: string,
  projectRevision: number,
): Promise<void> => {
  if (session.disposed) return;
  const pending = documents.filter((document) => {
    const baseline = baselines.get(document.id);
    return baseline !== undefined && document.text !== baseline;
  });
  const mutations = [
    ...session.snapshot().scenes.map(({ sceneId }) => session.clearScene(sceneId)),
    ...pending.map((document) =>
      session.updateScene({
        sceneId: document.id,
        baseline: baselines.get(document.id) ?? "",
        value: document.text,
        projectSnapshot,
        projectRevision,
        context: { path: document.path },
      }),
    ),
  ];
  await Promise.all(mutations);
  await session.flush();
};
