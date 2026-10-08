import { cloneStoryValue, type JsonObject, type JsonValue } from "@haneoka/altair/model";

export type AnimationTransformField = "x" | "y" | "scaleX" | "scaleY" | "rotation" | "alpha";
export interface AnimationFramesChange {
  readonly frames: JsonObject[];
  readonly selectedIndex: number | undefined;
}
export interface AnimationFrameTime {
  readonly index: number;
  readonly durationMs: number;
  readonly endMs: number;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Owned copies retain source properties, including absent channels and custom easing tokens. */
export function readAnimationFrames(value: JsonValue): JsonObject[] {
  if (!Array.isArray(value) || value.some(frame => !isObject(frame)))
    throw new TypeError("Animation must contain an array of keyframes");
  return cloneStoryValue(value as JsonObject[]);
}

function frameIndex(frames: readonly JsonObject[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= frames.length)
    throw new RangeError("Animation frame index is out of range");
}

export function insertAnimationFrame(
  frames: readonly JsonObject[],
  afterIndex?: number,
  frame: JsonObject = { duration: 0 },
): AnimationFramesChange {
  if (afterIndex !== undefined && afterIndex !== -1) frameIndex(frames, afterIndex);
  const index = afterIndex === undefined || afterIndex === -1 ? frames.length : afterIndex + 1;
  const next = readAnimationFrames([...frames]);
  next.splice(index, 0, readAnimationFrames([frame])[0]!);
  return { frames: next, selectedIndex: index };
}

export function duplicateAnimationFrame(frames: readonly JsonObject[], index: number): AnimationFramesChange {
  frameIndex(frames, index);
  return insertAnimationFrame(frames, index, frames[index]!);
}

export function deleteAnimationFrame(frames: readonly JsonObject[], index: number): AnimationFramesChange {
  frameIndex(frames, index);
  const next = readAnimationFrames([...frames]);
  next.splice(index, 1);
  return { frames: next, selectedIndex: next.length ? Math.min(index, next.length - 1) : undefined };
}

/** `toIndex` is the final array position; selection follows the moved frame. */
export function moveAnimationFrame(
  frames: readonly JsonObject[],
  fromIndex: number,
  toIndex: number,
): AnimationFramesChange {
  frameIndex(frames, fromIndex);
  frameIndex(frames, toIndex);
  const next = readAnimationFrames([...frames]);
  const [frame] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, frame!);
  return { frames: next, selectedIndex: toIndex };
}

function mergeFramePatch(frame: JsonObject, patch: JsonObject): JsonObject {
  return Object.fromEntries([...new Set([...Object.keys(frame), ...Object.keys(patch)])].map(key => {
    if (!Object.hasOwn(patch, key)) return [key, cloneStoryValue(frame[key]!)];
    const old = frame[key], value = patch[key]!;
    return [key, isObject(old) && isObject(value) ? mergeFramePatch(old, value) : cloneStoryValue(value)];
  }));
}

/** Object patches merge nested source properties; arrays and scalar values replace explicitly. */
export function patchAnimationFrame(
  frames: readonly JsonObject[],
  index: number,
  patch: JsonObject,
): AnimationFramesChange {
  frameIndex(frames, index);
  if (!isObject(patch)) throw new TypeError("Animation frame patch must be an object");
  const next = readAnimationFrames([...frames]);
  next[index] = mergeFramePatch(next[index]!, patch);
  return { frames: next, selectedIndex: index };
}

export function normalizeAnimationDurationInput(value: string): number | undefined {
  const duration = Number(value.trim());
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function setAnimationFrameDuration(
  frames: readonly JsonObject[],
  index: number,
  durationMs: number,
): AnimationFramesChange {
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RangeError("Animation duration must be a finite nonnegative number of milliseconds");
  return patchAnimationFrame(frames, index, { duration: durationMs });
}

export function normalizeAnimationEaseInput(value: string): string | undefined {
  return value.trim() || undefined;
}

export function setAnimationFrameEase(
  frames: readonly JsonObject[],
  index: number,
  ease: string | undefined,
): AnimationFramesChange {
  frameIndex(frames, index);
  const next = readAnimationFrames([...frames]);
  next[index] = { ...next[index]! };
  const value = ease === undefined ? undefined : normalizeAnimationEaseInput(ease);
  if (value === undefined) delete next[index]!.ease;
  else next[index]!.ease = value;
  return { frames: next, selectedIndex: index };
}

function transformPath(field: AnimationTransformField): readonly [string, string?] {
  switch (field) {
    case "x": case "y": return ["position", field];
    case "scaleX": return ["scale", "x"];
    case "scaleY": return ["scale", "y"];
    case "rotation": case "alpha": return [field];
    default: throw new RangeError("Unsupported animation transform field");
  }
}

/** Position uses pixels; displayed rotation uses degrees. Missing values remain inherited. */
export function animationFrameTransformValue(frame: JsonObject, field: AnimationTransformField): number | undefined {
  const [key, axis] = transformPath(field), pair = frame[key];
  const raw = axis ? isObject(pair) ? pair[axis] : undefined : pair;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const value = field === "rotation" ? raw * (180 / Math.PI) : raw;
  if (!Number.isFinite(value)) throw new RangeError("Animation rotation cannot be displayed in degrees");
  return value;
}

/** Undefined clears only the chosen authored channel; other axes and filter properties survive. */
export function setAnimationFrameTransform(
  frames: readonly JsonObject[],
  index: number,
  field: AnimationTransformField,
  value: number | undefined,
): AnimationFramesChange {
  frameIndex(frames, index);
  const [key, axis] = transformPath(field);
  if (value !== undefined) {
    if (!Number.isFinite(value)) throw new RangeError("Animation transform values must be finite");
    const authored = field === "rotation" ? value * (Math.PI / 180) : value;
    return patchAnimationFrame(frames, index, axis ? { [key]: { [axis]: authored } } : { [key]: authored });
  }
  const next = readAnimationFrames([...frames]), frame = { ...next[index]! };
  next[index] = frame;
  if (!axis) delete frame[key];
  else if (isObject(frame[key])) {
    const pair = { ...frame[key] };
    delete pair[axis];
    if (Object.keys(pair).length) frame[key] = pair;
    else delete frame[key];
  }
  return { frames: next, selectedIndex: index };
}

/** Matches the runtime's millisecond duration coercion without normalizing authored frame data. */
export function animationFramesTimeline(frames: readonly JsonObject[]): AnimationFrameTime[] {
  let endMs = 0;
  return frames.map((frame, index) => {
    const raw = Number(frame.duration), durationMs = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    endMs += durationMs;
    if (!Number.isFinite(endMs)) throw new RangeError("Animation timeline duration is too large");
    return { index, durationMs, endMs };
  });
}
