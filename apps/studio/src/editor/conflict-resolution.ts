/** A reviewed conflict identifies both the local edit epoch and the observed external version. */
export interface ConflictDocument {
  readonly path: string;
  readonly revision: number;
  readonly text: string;
  readonly baseline: string;
  readonly external?: string;
}
export interface ConflictReview extends ConflictDocument {
  readonly projectId: string;
  readonly contextEpoch?: number;
  readonly external: string;
}
export function captureConflictReview(
  projectId: string,
  document: ConflictDocument | undefined,
  contextEpoch = 0,
): ConflictReview | undefined {
  if (!document || document.external === undefined) return undefined;
  return Object.freeze({
    projectId,
    contextEpoch,
    path: document.path,
    revision: document.revision,
    text: document.text,
    baseline: document.baseline,
    external: document.external,
  });
}
export function conflictReviewMatches(
  projectId: string,
  document: ConflictDocument | undefined,
  review: ConflictReview,
  contextEpoch = 0,
): boolean {
  return (
    review.projectId === projectId &&
    (review.contextEpoch ?? 0) === contextEpoch &&
    !!document &&
    document.path === review.path &&
    document.revision === review.revision &&
    document.text === review.text &&
    document.baseline === review.baseline &&
    document.external === review.external
  );
}
export function conflictReplacement(review: ConflictReview, choice: "disk" | "editor"): ConflictDocument {
  return {
    path: review.path,
    revision: review.revision + 1,
    text: choice === "disk" ? review.external : review.text,
    baseline: review.external,
  };
}
