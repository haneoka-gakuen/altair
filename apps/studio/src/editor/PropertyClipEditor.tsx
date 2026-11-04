import { resizePropertyClip } from "./property-clip";
import { NumberInput } from "@haneoka/altair-ui-react";
import {
  parsePropertyAnimationClip,
  samplePropertyAnimation,
  type PropertyAnimationClip,
  type PropertyAnimationPoint,
} from "@haneoka/vega/renderer-kit";
import { Plus, Trash2 } from "lucide-react";
import type { JsonObject, JsonValue } from "@haneoka/altair";
import { tr } from "./i18n";

const easing = [
  "linear",
  "inSine",
  "outSine",
  "inOutSine",
  "inQuad",
  "outQuad",
  "inOutQuad",
  "inCubic",
  "outCubic",
  "inOutCubic",
  "inQuart",
  "outQuart",
  "inOutQuart",
  "inQuint",
  "outQuint",
  "inOutQuint",
  "inExpo",
  "outExpo",
  "inOutExpo",
  "inCirc",
  "outCirc",
  "inOutCirc",
  "inBack",
  "outBack",
  "inOutBack",
  "inElastic",
  "outElastic",
  "inOutElastic",
  "inBounce",
  "outBounce",
  "inOutBounce",
];
export function PropertyClipEditor({
  value,
  onChange,
}: {
  value: JsonValue | undefined;
  onChange(value: JsonObject): void;
}) {
  let clip: PropertyAnimationClip;
  try {
    clip = parsePropertyAnimationClip(value);
  } catch {
    return <span role="alert">{tr("Invalid animation curve")}</span>;
  }
  const changePoint = (trackIndex: number, pointIndex: number, patch: Partial<PropertyAnimationPoint>) => {
    const tracks = clip.tracks.map((track, index) =>
      index === trackIndex
        ? {
            ...track,
            points: track.points.map((point, index) => (index === pointIndex ? { ...point, ...patch } : point)),
          }
        : track,
    );
    onChange({ ...clip, tracks } as unknown as JsonObject);
  };
  return (
    <div className="property-curve-editor">
      <label className="field">
        <span>{tr("Duration (s)")}</span>
        <NumberInput
          min={0}
          step="any"
          value={clip.durationSeconds}
          onCommit={(seconds) => {
            if (seconds >= 0) onChange(resizePropertyClip(clip, seconds));
          }}
        />
      </label>
      {clip.tracks.map((track, trackIndex) => {
        const samples = Array.from({ length: 65 }, (_, index) => ({
          time: (clip.durationSeconds * index) / 64,
          value: samplePropertyAnimation({ ...clip, tracks: [track] }, (clip.durationSeconds * index) / 64)[
            track.channel
          ]!,
        }));
        const low = Math.min(...samples.map((p) => p.value)),
          high = Math.max(...samples.map((p) => p.value)),
          range = high - low || 1;
        const points = samples
          .map((point, index) => `${index * 8},${92 - ((point.value - low) / range) * 80}`)
          .join(" ");
        return (
          <details className="property-curve-track" open key={track.channel}>
            <summary>{tr("Parameter {{id}}", { id: track.channel })}</summary>
            <svg
              className="property-curve-chart"
              viewBox="0 0 512 104"
              role="img"
              aria-label={`${track.channel}: ${low} – ${high}`}
            >
              <polyline points={points} />
            </svg>
            <div className="property-curve-points">
              {track.points.map((point, index) => (
                <div className="property-curve-point" key={index}>
                  <label className="field">
                    <span>{tr("Time (s)")}</span>
                    <NumberInput
                      min={track.points[index - 1]?.timeSeconds ?? 0}
                      max={track.points[index + 1]?.timeSeconds ?? clip.durationSeconds}
                      step="any"
                      value={point.timeSeconds}
                      onCommit={(time) =>
                        changePoint(trackIndex, index, {
                          timeSeconds: Math.max(
                            track.points[index - 1]?.timeSeconds ?? 0,
                            Math.min(track.points[index + 1]?.timeSeconds ?? clip.durationSeconds, time),
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{tr("Value")}</span>
                    <NumberInput
                      step="any"
                      value={point.value}
                      onCommit={(value) => changePoint(trackIndex, index, { value })}
                    />
                  </label>
                  <label className="field">
                    <span>{tr("Easing")}</span>
                    <select
                      value={point.ease ?? "linear"}
                      onChange={(event) => changePoint(trackIndex, index, { ease: event.currentTarget.value })}
                    >
                      {easing.map((ease) => (
                        <option value={ease} key={ease}>
                          {ease}
                        </option>
                      ))}
                      {point.ease !== undefined && !easing.includes(String(point.ease)) && (
                        <option value={point.ease}>{point.ease}</option>
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="author-icon-button"
                    disabled={track.points.length === 1}
                    aria-label={tr("Remove keyframe")}
                    onClick={() =>
                      onChange({
                        ...clip,
                        tracks: clip.tracks.map((value, i) =>
                          i === trackIndex ? { ...value, points: value.points.filter((_, i) => i !== index) } : value,
                        ),
                      } as unknown as JsonObject)
                    }
                  >
                    <Trash2 aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="author-button"
              onClick={() =>
                onChange({
                  ...clip,
                  tracks: clip.tracks.map((value, index) =>
                    index === trackIndex
                      ? {
                          ...value,
                          points: [
                            ...value.points,
                            { timeSeconds: clip.durationSeconds, value: value.points.at(-1)!.value, ease: "linear" },
                          ],
                        }
                      : value,
                  ),
                } as unknown as JsonObject)
              }
            >
              <Plus aria-hidden />
              {tr("Add keyframe")}
            </button>
          </details>
        );
      })}
    </div>
  );
}
