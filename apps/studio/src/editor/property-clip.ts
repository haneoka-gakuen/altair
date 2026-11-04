import { parsePropertyAnimationClip } from "@haneoka/vega-protocol";
import type { JsonObject } from "@haneoka/altair";

export function resizePropertyClip(value: unknown, seconds: number): JsonObject {
  const clip = parsePropertyAnimationClip(value),
    ratio = clip.durationSeconds ? seconds / clip.durationSeconds : 0;
  return {
    ...clip,
    durationSeconds: seconds,
    tracks: clip.tracks.map((track) => ({
      ...track,
      points: track.points.map((point) => ({ ...point, timeSeconds: point.timeSeconds * ratio })),
    })),
  } as unknown as JsonObject;
}
