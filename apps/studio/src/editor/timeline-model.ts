import { resizePropertyClip } from "./property-clip";
import type { AltairAuthoredNode, AltairCommandGroup, AltairSceneDocument, JsonObject } from "@haneoka/altair";
import {
  isTimedDialogue,
  isTimelineReference,
  resolveTimelineInstance,
  resolveTimelineReference,
  timelineInstanceWindow,
  projectMediaAppearanceWindow,
  projectClipAnimationWindow,
  resolveTimelineCues,
  rippleTimelineFollowing,
  timelineCommandBlocksFollowing,
  timelineCueDuration,
  timelineTrackState,
  type TimelineTrackState,
  type ResolvedTimelineCue,
  type TimelineAnchor,
  type TimelineTimingContext,
} from "@haneoka/altair/documents";
import { nativeCommands } from "./native-project";
import { MAX_STAGE_CLIP_VOLUME, parseVegaStageMediaClip, stageMediaAudioClip } from "@haneoka/vega-protocol";
import { tr } from "./i18n";

export type TimelineCue = ResolvedTimelineCue;
export type { TimelineAnchor, TimelineTimingContext };
export { timelineTrackState };

export function setTimelineTrackState(
  node: AltairAuthoredNode,
  id: string,
  patch: Partial<TimelineTrackState>,
): AltairAuthoredNode {
  const previous = node.arguments.trackStates;
  const states = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous } : {};
  const next = { ...timelineTrackState(node, id), ...patch };
  if (next.gain !== undefined && (!Number.isFinite(next.gain) || next.gain < 0 || next.gain > 1))
    throw Error(tr("Invalid cue timing"));
  if (!next.locked && !next.muted && !next.solo && next.gain === undefined) delete states[id];
  else
    states[id] = {
      locked: next.locked,
      muted: next.muted,
      solo: next.solo,
      ...(next.gain === undefined ? {} : { gain: next.gain }),
    };
  return { ...node, arguments: { ...node.arguments, trackStates: states } };
}

export interface TimelineLane {
  id: string;
  name: string;
}

export const automaticLane = (node: AltairAuthoredNode) =>
  String(
    node.arguments.trackName ||
      node.arguments.target ||
      node.arguments.targetName ||
      nativeCommands.find((command) => command.name === node.type.name)?.category ||
      tr("Stage"),
  );

export function cueLane(cue: TimelineCue, lanes: ReadonlyMap<string, string>) {
  const id = cue.track.laneId;
  const name = (typeof id === "string" ? lanes.get(id) : undefined) ??
    (cue.trackActor ? `${cue.trackActor} · ${tr(cue.trackName)}` : tr(cue.trackName));
  return { id: cue.trackId, name };
}

export function timelineLanes(node: AltairAuthoredNode): TimelineLane[] {
  const entries = node.arguments.lanes;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      seen.has(entry.id)
    )
      return [];
    seen.add(entry.id);
    return [{ id: entry.id, name: entry.name }];
  });
}

function withLanes(node: AltairAuthoredNode, lanes: readonly TimelineLane[]): AltairAuthoredNode {
  return { ...node, arguments: { ...node.arguments, lanes: lanes.map((lane) => ({ ...lane })) } };
}

export function addTimelineLane(node: AltairAuthoredNode, name: string): AltairAuthoredNode {
  return withLanes(node, [...timelineLanes(node), { id: crypto.randomUUID(), name: name.trim() }]);
}

export function renameTimelineLane(node: AltairAuthoredNode, id: string, name: string): AltairAuthoredNode {
  return withLanes(
    node,
    timelineLanes(node).map((lane) => (lane.id === id ? { id, name: name.trim() } : lane)),
  );
}

export function moveTimelineLane(node: AltairAuthoredNode, id: string, offset: -1 | 1): AltairAuthoredNode {
  const lanes = timelineLanes(node);
  const index = lanes.findIndex((lane) => lane.id === id);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= lanes.length) return node;
  if (timelineTrackState(node, `lane:${id}`).locked || timelineTrackState(node, `lane:${lanes[next]!.id}`).locked)
    throw Error(tr("This track is locked"));
  [lanes[index], lanes[next]] = [lanes[next]!, lanes[index]!];
  return withLanes(node, lanes);
}

export function removeTimelineLane(
  node: AltairAuthoredNode,
  id: string,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  if (timelineTrackState(node, `lane:${id}`).locked) throw Error(tr("This track is locked"));
  const updated = withLanes(
    node,
    timelineLanes(node).filter((lane) => lane.id !== id),
  );
  const members = new Set<string>();
  const tracks = timelineCues(node, context).map(({ node: child, track }) => {
    if (track.laneId !== id) return track;
    members.add(child.id);
    const { laneId: _, ...rest } = track;
    return rest;
  });
  const states = updated.arguments.trackStates;
  const trackStates = states && typeof states === "object" && !Array.isArray(states) ? { ...states } : {};
  delete trackStates[`lane:${id}`];
  const next = { ...updated, arguments: { ...updated.arguments, trackStates, tracks } };
  if (timelineCues(next, context).some((cue) => members.has(cue.node.id) && cue.trackLocked))
    throw Error(tr("This track is locked"));
  return next;
}

export function assignCueLane(
  node: AltairAuthoredNode,
  cueId: string,
  laneId: string | undefined,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  if (laneId && !timelineLanes(node).some((lane) => lane.id === laneId)) return node;
  const cues = timelineCues(node, context);
  const source = cues.find((cue) => cue.node.id === cueId);
  if (source?.trackLocked || (laneId && timelineTrackState(node, `lane:${laneId}`).locked))
    throw Error(tr("This track is locked"));
  const tracks = cues.map(({ node: child, track }) => {
    if (child.id !== cueId) return track;
    const { laneId: _, ...rest } = track;
    return laneId ? { ...rest, laneId } : rest;
  });
  const next = { ...node, arguments: { ...node.arguments, tracks } };
  if (timelineCues(next, context).some((cue) => cue.node.id === cueId && cue.trackLocked))
    throw Error(tr("This track is locked"));
  return next;
}

export function splitTimelineMediaAudio(
  group: AltairAuthoredNode,
  id: string,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  const cue = timelineCues(group, context).find((item) => item.node.id === id);
  if (!cue || cue.node.type.plugin !== "haneoka.altair" || cue.node.type.name !== "mediaClip") return group;
  if (cue.trackLocked) throw Error(tr("This track is locked"));
  const clip = parseVegaStageMediaClip(cue.node.arguments);
  if (clip.mediaKind !== "video" || !clip.audioEnabled) return group;
  const childId = crypto.randomUUID();
  const { clipId: _, gainAnimation: _gain, ...audio } = stageMediaAudioClip(clip, childId, "Video audio");
  const target = timelineTrackState(group, `audio:${audio.trackName}`);
  if (target.locked) throw Error(tr("This track is locked"));
  const volume = (clip.volume * (cue.trackGain ?? 1)) / (target.gain || 1);
  if (volume > MAX_STAGE_CLIP_VOLUME || (volume > 0 && target.gain === 0))
    throw Error(tr("The audio edit differs from its video clip"));
  const children = (group.children ?? []).map((node) =>
    node.id === id ? { ...node, arguments: { ...node.arguments, audioEnabled: false } } : node,
  );
  const child: AltairAuthoredNode = {
    id: childId,
    type: { plugin: "haneoka.altair", name: "audioClip" },
    schemaVersion: 1,
    arguments: {
      ...audio,
      volume,
      linkedMediaId: id,
      ...(cue.node.arguments.gainAnimation ? { gainAnimation: cue.node.arguments.gainAnimation } : {}),
    },
  };
  const anchorId = typeof cue.track.cueId === "string" ? cue.track.cueId : id;
  const tracks = group.arguments.tracks as JsonObject[];
  return {
    ...group,
    children: [...children, child],
    arguments: {
      ...group.arguments,
      tracks: [
        ...tracks,
        {
          nodeId: childId,
          atSeconds: cue.atSeconds,
          role: "lifetime",
          anchor: { nodeId: anchorId, point: "start", offsetSeconds: 0 },
        },
      ],
    },
  };
}

export function linkTimelineMediaAudio(
  group: AltairAuthoredNode,
  id: string,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  const cues = timelineCues(group, context);
  const video = cues.find(
    (cue) => cue.node.id === id && cue.node.type.plugin === "haneoka.altair" && cue.node.type.name === "mediaClip",
  );
  const audio = cues.find(
    (cue) =>
      cue.node.type.plugin === "haneoka.altair" &&
      cue.node.type.name === "audioClip" &&
      cue.node.arguments.linkedMediaId === id,
  );
  if (!video || !audio) return group;
  if (video.trackLocked || audio.trackLocked) throw Error(tr("This track is locked"));
  const clip = parseVegaStageMediaClip(video.node.arguments);
  const args = audio.node.arguments;
  const sourceWindow = args.sourceWindow;
  const matchesWindow =
    sourceWindow && typeof sourceWindow === "object" && !Array.isArray(sourceWindow)
      ? sourceWindow.offsetSeconds === clip.fadeWindow?.offsetSeconds &&
        sourceWindow.durationSeconds === clip.fadeWindow?.durationSeconds &&
        sourceWindow.playbackRate === clip.fadeWindow?.playbackRate
      : !clip.fadeWindow;
  if (
    args.source !== clip.source ||
    Math.abs(audio.atSeconds - video.atSeconds) > 0.0005 ||
    args.durationSeconds !== clip.durationSeconds ||
    args.offsetSeconds !== clip.offsetSeconds ||
    args.playbackRate !== clip.playbackRate ||
    Number(args.fadeInSeconds) !== (clip.fadeInSeconds ?? 0) ||
    Number(args.fadeOutSeconds) !== (clip.fadeOutSeconds ?? 0) ||
    Boolean(args.loop) !== Boolean(clip.loop) ||
    args.muted ||
    !matchesWindow ||
    args.category !== "Se"
  )
    throw Error(tr("The audio edit differs from its video clip"));
  const trimmed = removeCue(group, audio.node.id, context);
  const outputGain = Number(args.volume ?? 1) * Number(audio.trackGain ?? args.trackVolume ?? 1);
  const volume = outputGain / (video.trackGain || 1);
  if (volume > MAX_STAGE_CLIP_VOLUME || (volume > 0 && video.trackGain === 0))
    throw Error(tr("The audio edit differs from its video clip"));
  return {
    ...trimmed,
    children: trimmed.children?.map((node) => {
      if (node.id !== id) return node;
      const { gainAnimation: _, ...fields } = node.arguments;
      return {
        ...node,
        arguments: {
          ...fields,
          audioEnabled: true,
          volume,
          ...(args.gainAnimation ? { gainAnimation: args.gainAnimation } : {}),
        },
      };
    }),
  };
}

export const isTimeline = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "timeline";

export function durationField(node: AltairAuthoredNode): { key: string; scale: number } | undefined {
  if (isTimelineReference(node)) return { key: "sourceOutSeconds", scale: 1 };
  if (node.type.plugin === "haneoka.altair" && node.type.name === "propertyClip") return { key: "clip", scale: 1 };
  if (isTimedDialogue(node)) return node.arguments.noWait ? undefined : { key: "advanceAfterSeconds", scale: 1 };
  for (const key of ["durationSeconds", "durationMs", "duration", "fadeDuration", "transitionDuration"])
    if (Object.hasOwn(node.arguments, key)) return { key, scale: key === "durationMs" ? 1000 : 1 };
  const definition = nativeCommands.find(
    (command) => node.type.plugin === "haneoka.altair-adv" && command.name === node.type.name,
  );
  const key = definition?.fields.find((field) =>
    ["duration", "fadeDuration", "transitionDuration"].includes(field.key),
  )?.key;
  return key ? { key, scale: 1 } : undefined;
}

export const cueDuration = timelineCueDuration;

export type TimelinePlaybackPatch = Partial<
  Record<
    "sourceInSeconds" | "sourceOutSeconds" | "playbackRate" | "gain" | "loopDurationSeconds" | "loopOffsetSeconds",
    number | undefined
  > & {
    channels: "both" | "picture" | "audio" | undefined;
    composition: JsonObject | undefined;
  }
>;

function patchInstance(node: AltairAuthoredNode, patch: TimelinePlaybackPatch, context: TimelineTimingContext) {
  const args = { ...node.arguments };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value === undefined ||
      (key === "sourceInSeconds" && value === 0) ||
      (key === "playbackRate" && value === 1) ||
      (key === "gain" && value === 1) ||
      (key === "channels" && value === "both")
    )
      delete args[key];
    else args[key] = value;
  }
  const next = { ...node, arguments: args };
  resolveTimelineInstance(next, context);
  return next;
}

export function updateTimelineInstance(
  group: AltairAuthoredNode,
  id: string,
  patch: TimelinePlaybackPatch,
  context: TimelineTimingContext,
) {
  const cues = timelineCues(group, context);
  if (cues.some((cue) => cue.node.id === id && cue.trackLocked)) throw Error(tr("This track is locked"));
  const next = {
    ...group,
    children: group.children?.map((child) => (child.id === id ? patchInstance(child, patch, context) : child)),
  };
  return rippleTimelineFollowing(cues, next, id, context);
}
export const timelineCues = (node: AltairAuthoredNode, context?: TimelineTimingContext): TimelineCue[] =>
  isTimeline(node) ? resolveTimelineCues(node, context) : [];

const endOf = (cue: TimelineCue) => cue.atSeconds + cue.durationSeconds;

function linkedTrack(nodeId: string, targetId?: string): JsonObject {
  return {
    nodeId,
    atSeconds: 0,
    role: "lifetime",
    ...(targetId ? { followPrevious: true, anchor: { nodeId: targetId, point: "end", offsetSeconds: 0 } } : {}),
  };
}

export function createTimeline(
  children: readonly AltairAuthoredNode[] = [],
  sequential = false,
  id: string = crypto.randomUUID(),
): AltairAuthoredNode {
  let previous: string | undefined;
  const tracks = children.map((node) => {
    const track = linkedTrack(node.id, previous);
    if (sequential && timelineCommandBlocksFollowing(node)) previous = node.id;
    return sequential ? { ...track, followPrevious: true } : track;
  });
  return {
    id,
    type: { plugin: "haneoka.altair", name: "timeline" },
    schemaVersion: 1,
    arguments: {
      tracks,
      waitForPrevious: true,
      waitForCompletion: true,
      cancelOnManualAdvance: false,
      durationSeconds: 0,
      ...(sequential ? { inferredSequence: true } : {}),
    },
    children: [...children],
  };
}

export function timelineNavigationCommand(node: AltairAuthoredNode): boolean {
  const { plugin, name } = node.type;
  return (plugin === "haneoka.altair-adv" && ["GoTo", "ChoiceSet", "ChoiceShow"].includes(name)) ||
    (plugin === "haneoka.altair" && ["branch", "jump", "call", "return", "end", "input"].includes(name));
}

export function inferredSceneTimeline(scene: AltairSceneDocument): AltairAuthoredNode | undefined {
  const end = scene.nodes.at(-1);
  const children = end?.type.plugin === "haneoka.altair" && end.type.name === "end"
    ? scene.nodes.slice(0, -1)
    : scene.nodes;
  if (!children.length || (children.length === 1 && isTimeline(children[0]!)) ||
    children.some((node) => node.arguments.libraryOnly === true || timelineNavigationCommand(node)))
    return;
  const id = `studio-timeline-${scene.id}`;
  if (children.some((node) => node.id === id)) return;
  return createTimeline(children, true, id);
}

export function sceneTrackCues(group: AltairAuthoredNode, context: TimelineTimingContext) {
  const owners = new Map<string, { timeline: AltairAuthoredNode; start: number }>();
  const roots = resolveTimelineCues(group, context);
  const cues = roots.flatMap((root) => {
    const node = root.node;
    if (!isTimeline(node) || node.arguments.title ||
      (node.extensions?.["haneoka.authoring.explicit"] && node.children?.length !== 1))
      return [root];
    return resolveTimelineCues(node, context).map((cue) => {
      owners.set(cue.node.id, { timeline: node, start: root.atSeconds });
      return { ...cue, atSeconds: cue.atSeconds + root.atSeconds };
    });
  });
  return { roots, cues, owners };
}

export function appendTimelineCue(
  node: AltairAuthoredNode,
  child: AltairAuthoredNode,
  context?: TimelineTimingContext,
  afterId?: string,
): AltairAuthoredNode {
  const cues = timelineCues(node, context);
  const selected = cues.find((cue) => cue.node.id === afterId);
  const previous =
    selected ??
    cues
      .filter((cue) => cue.role === "lifetime" && timelineCommandBlocksFollowing(cue.node))
      .reduce<TimelineCue | undefined>((last, cue) => (!last || endOf(cue) >= endOf(last) ? cue : last), undefined);
  const start = previous ? endOf(previous) : 0;
  const duration = cueDuration(child, context);
  const selectedIndex = selected ? cues.indexOf(selected) : -1;
  const tracks = cues.map((cue, index) => {
    if (!selected || cue.node.id === selected.node.id || cue.trackLocked) return cue.track;
    if (
      timelineCommandBlocksFollowing(child) &&
      cue.track.followPrevious === true &&
      cue.anchor?.nodeId === selected.node.id
    )
      return { ...cue.track, anchor: { ...cue.anchor, nodeId: child.id } };
    if (
      !cue.anchor &&
      (node.arguments.rippleScope === "timeline" || cue.trackId === selected.trackId) &&
      cue.atSeconds + 0.0005 >= start &&
      (cue.atSeconds !== start || index > selectedIndex)
    )
      return { ...cue.track, atSeconds: cue.atSeconds + duration };
    return cue.track;
  });
  const index = selected ? cues.indexOf(selected) + 1 : tracks.length;
  const track = linkedTrack(child.id, previous?.node.id);
  tracks.splice(index, 0, node.arguments.inferredSequence === true ? { ...track, followPrevious: true } : track);
  const children = [...(node.children ?? [])];
  const childIndex = selected ? children.findIndex((entry) => entry.id === selected.node.id) + 1 : children.length;
  children.splice(childIndex, 0, child);
  const next = {
    ...node,
    children,
    arguments: { ...node.arguments, tracks },
  };
  if (timelineCues(next, context).some((cue) => cue.node.id === child.id && cue.trackLocked))
    throw Error(tr("This track is locked"));
  return next;
}

export function updateCue(
  node: AltairAuthoredNode,
  id: string,
  atSeconds: number,
  duration?: number,
  role?: "lifetime" | "event",
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  if (
    !Number.isFinite(atSeconds) ||
    atSeconds < 0 ||
    (duration !== undefined && (!Number.isFinite(duration) || duration < 0))
  )
    throw Error(tr("Invalid cue timing"));
  const cues = timelineCues(node, context);
  const moved = cues.find((cue) => cue.node.id === id);
  if (!moved) throw Error(tr("Timeline command is missing"));
  if (moved.trackLocked) throw Error(tr("This track is locked"));
  const children = node.children?.map((child) => {
    if (child.id !== id || duration === undefined || Math.abs(duration - moved.durationSeconds) < 0.0005) return child;
    const field = durationField(child);
    if (!field) return child;
    const leftEdge =
      Math.abs(atSeconds - moved.atSeconds) > 0.0005 && Math.abs(atSeconds + duration - endOf(moved)) < 0.001;
    const trimOffset = leftEdge ? atSeconds - moved.atSeconds : 0;
    const trimAppearance = (fields: JsonObject) =>
      projectMediaAppearanceWindow(fields, moved.durationSeconds, trimOffset, 1, duration);
    if (isTimelineReference(child)) {
      const source = resolveTimelineReference(child, context ?? {});
      if (!source) return child;
      const window = timelineInstanceWindow(child, cueDuration(source.node, context));
      const appearance = child.arguments.composition;
      const composition =
        appearance && typeof appearance === "object" && !Array.isArray(appearance)
          ? { composition: { ...appearance, ...trimAppearance(appearance) } }
          : {};
      if (window.loop) {
        const { period, offset } = window.loop;
        const loopOffsetSeconds = leftEdge
          ? (((offset + atSeconds - moved.atSeconds) % period) + period) % period
          : offset;
        return patchInstance(
          child,
          { loopDurationSeconds: duration, loopOffsetSeconds, ...composition },
          context ?? {},
        );
      }
      const patch = leftEdge
        ? { sourceInSeconds: Math.max(0, window.end - duration * window.rate) }
        : { sourceOutSeconds: Math.min(window.sourceSeconds, window.start + duration * window.rate) };
      return patchInstance(child, { ...patch, ...composition }, context ?? {});
    }
    if (child.type.plugin === "haneoka.altair" && child.type.name === "mediaClip") {
      const offsetSeconds =
        Number(child.arguments.offsetSeconds ?? 0) + trimOffset * Number(child.arguments.playbackRate ?? 1);
      if (offsetSeconds < -0.0005) throw Error(tr("Invalid cue timing"));
      return {
        ...child,
        arguments: {
          ...child.arguments,
          offsetSeconds: Math.max(0, offsetSeconds),
          durationSeconds: Math.max(0.001, duration),
          ...trimAppearance(child.arguments),
        },
      };
    }
    if (child.type.plugin === "haneoka.altair" && child.type.name === "audioClip") {
      const saved = child.arguments.sourceWindow;
      const window = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
      const playbackRate = Number(window.playbackRate ?? 1);
      const offsetSeconds = Number(window.offsetSeconds ?? 0) + trimOffset * playbackRate;
      if (offsetSeconds < -0.0005) throw Error(tr("Invalid cue timing"));
      return {
        ...child,
        arguments: {
          ...child.arguments,
          durationSeconds: Math.max(0.001, duration),
          sourceWindow: {
            durationSeconds: Number(window.durationSeconds ?? moved.durationSeconds),
            playbackRate,
            offsetSeconds: Math.max(0, offsetSeconds),
          },
          ...projectClipAnimationWindow(child.arguments, "gainAnimation", trimOffset, 1, duration),
        },
      };
    }
    const nativeDelay =
      child.type.plugin === "haneoka.altair-adv" && field.key !== "advanceAfterSeconds"
        ? Math.max(0, Number(child.arguments.delaySeconds ?? 0))
        : 0;
    const seconds =
      child.type.plugin === "haneoka.altair" && ["adjustment", "audioClip", "mediaClip"].includes(child.type.name)
        ? Math.max(0.001, duration)
        : Math.max(0, duration - nativeDelay);
    return {
      ...child,
      arguments: {
        ...child.arguments,
        [field.key]: field.key === "clip" ? resizePropertyClip(child.arguments.clip, seconds) : seconds * field.scale,
        ...(child.type.name === "adjustment" && child.arguments.scope === "below"
          ? trimAppearance(child.arguments)
          : {}),
      },
    };
  });
  const { anchor: _, followPrevious, ...independent } = moved.track;
  const offset = moved.anchor ? moved.anchor.offsetSeconds + atSeconds - moved.atSeconds : -1;
  const startChanged = Math.abs(atSeconds - moved.atSeconds) >= 0.0005;
  const track = {
    ...independent,
    atSeconds,
    ...(role ? { role } : {}),
    ...(moved.anchor && offset >= -0.0005
      ? {
          anchor: { ...moved.anchor, offsetSeconds: Math.max(0, offset) },
          ...(followPrevious === true && (node.arguments.inferredSequence !== true || !startChanged)
            ? { followPrevious }
            : {}),
        }
      : !startChanged && followPrevious === true
        ? { followPrevious }
        : {}),
  };
  const tracks = cues.map((cue) => (cue.node.id === id ? track : cue.track));
  return rippleTimelineFollowing(cues, { ...node, children, arguments: { ...node.arguments, tracks } }, id, context);
}

export function linkTimelineCue(
  node: AltairAuthoredNode,
  id: string,
  anchor: TimelineAnchor | undefined,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  if (anchor && (!Number.isFinite(anchor.offsetSeconds) || anchor.offsetSeconds < 0))
    throw Error(tr("Invalid cue timing"));
  const cues = timelineCues(node, context);
  const selected = cues.find((cue) => cue.node.id === id);
  if (!selected) throw Error(tr("Timeline command is missing"));
  if (selected.trackLocked) throw Error(tr("This track is locked"));
  const tracks = cues.map((cue) => {
    if (cue.node.id !== id) return cue.track;
    const { anchor: _, followPrevious: _follow, ...track } = cue.track;
    return { ...track, atSeconds: cue.atSeconds, ...(anchor ? { anchor: { ...anchor } } : {}) };
  });
  const next = { ...node, arguments: { ...node.arguments, tracks } };
  return rippleTimelineFollowing(cues, next, id, context);
}

export function clearCueDurationOverride(
  node: AltairAuthoredNode,
  id: string,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  const cues = timelineCues(node, context);
  const cue = cues.find(({ node: child }) => child.id === id);
  if (!cue || !isTimedDialogue(cue.node) || !Object.hasOwn(cue.node.arguments, "advanceAfterSeconds")) return node;
  if (cue.trackLocked) throw Error(tr("This track is locked"));
  const children = node.children?.map((child) => {
    if (child.id !== id) return child;
    const { advanceAfterSeconds: _, ...args } = child.arguments;
    return { ...child, arguments: args };
  });
  return rippleTimelineFollowing(cues, { ...node, children }, id, context);
}

export function removeCue(node: AltairAuthoredNode, id: string, context?: TimelineTimingContext): AltairAuthoredNode {
  const cues = timelineCues(node, context);
  const removed = cues.find((cue) => cue.node.id === id);
  if (!removed) return node;
  if (removed.trackLocked) throw Error(tr("This track is locked"));
  const remaining = cues.filter((cue) => cue.node.id !== id);
  const lostTargets = new Set([id, removed.track.cueId]);
  for (const item of remaining) {
    lostTargets.delete(item.node.id);
    lostTargets.delete(item.track.cueId);
  }
  if (remaining.some((cue) => cue.trackLocked && cue.anchor && lostTargets.has(cue.anchor.nodeId)))
    throw Error(tr("A locked track links to this cue"));
  return {
    ...node,
    children: node.children?.filter((child) => child.id !== id),
    arguments: {
      ...node.arguments,
      tracks: remaining.map((cue) => {
        if (!cue.anchor || !lostTargets.has(cue.anchor.nodeId)) return cue.track;
        const { anchor: _, followPrevious, ...track } = cue.track;
        if (followPrevious === true)
          return removed.anchor
            ? {
                ...track,
                followPrevious,
                anchor: {
                  ...removed.anchor,
                  offsetSeconds: removed.anchor.offsetSeconds + cue.anchor.offsetSeconds,
                },
              }
            : { ...track, atSeconds: removed.atSeconds + cue.anchor.offsetSeconds };
        return { ...track, atSeconds: cue.atSeconds };
      }),
    },
  };
}

function lanePeers(group: AltairAuthoredNode, cues: TimelineCue[], selected: TimelineCue) {
  const names = new Map(timelineLanes(group).map((lane) => [lane.id, lane.name]));
  const key = cueLane(selected, names).id;
  return cues.filter((cue) => cueLane(cue, names).id === key);
}

/** Only the gap immediately before the selection can be closed without overlapping an earlier clip. */
export function gapBeforeCue(group: AltairAuthoredNode, cues: TimelineCue[], selected: TimelineCue) {
  if (selected.anchor && selected.track.followPrevious !== true) return 0;
  const peers = lanePeers(group, cues, selected);
  const lastEnd = Math.max(0, ...peers.filter((cue) => cue.atSeconds < selected.atSeconds).map(endOf));
  return Math.max(0, Math.min(selected.atSeconds - lastEnd, selected.anchor?.offsetSeconds ?? Infinity));
}

/** Independent positions ripple up to the next explicitly anchored peer. Links move with their target. */
function shiftLane(
  group: AltairAuthoredNode,
  peers: TimelineCue[],
  selected: TimelineCue,
  start: number,
  amount: number,
  closeGap: boolean,
) {
  if (amount <= 0) return group;
  const boundary = Math.min(
    Infinity,
    ...peers
      .filter(
        (cue) =>
          cue.node.id !== selected.node.id && cue.atSeconds >= start && cue.anchor && cue.track.followPrevious !== true,
      )
      .map((cue) => cue.atSeconds),
  );
  const affected = new Map(
    peers
      .filter(
        (cue) =>
          cue.atSeconds >= start &&
          cue.atSeconds < boundary &&
          (!cue.anchor || (closeGap && cue.node.id === selected.node.id)),
      )
      .map((cue) => [cue.node.id, cue]),
  );
  const tracks = (group.arguments.tracks as JsonObject[]).map((track) => {
    const cue = affected.get(String(track.nodeId));
    if (!cue) return track;
    if (cue.anchor)
      return { ...track, anchor: { ...cue.anchor, offsetSeconds: Math.max(0, cue.anchor.offsetSeconds - amount) } };
    return { ...track, atSeconds: Math.max(0, cue.atSeconds - amount) };
  });
  return { ...group, arguments: { ...group.arguments, tracks } };
}

export function closeCueGap(group: AltairAuthoredNode, id: string, context?: TimelineTimingContext) {
  const cues = timelineCues(group, context);
  const selected = cues.find((cue) => cue.node.id === id);
  if (!selected) return group;
  if (selected.trackLocked) throw Error(tr("This track is locked"));
  return shiftLane(
    group,
    lanePeers(group, cues, selected),
    selected,
    selected.atSeconds,
    gapBeforeCue(group, cues, selected),
    true,
  );
}

export function rippleDeleteCue(group: AltairAuthoredNode, id: string, context?: TimelineTimingContext) {
  const cues = timelineCues(group, context);
  const selected = cues.find((cue) => cue.node.id === id);
  if (!selected) return group;
  const peers = lanePeers(group, cues, selected);
  const end = endOf(selected);
  const occupiedUntil = Math.max(
    selected.atSeconds,
    ...peers.filter((cue) => cue.node.id !== id && cue.atSeconds < end).map(endOf),
  );
  return shiftLane(removeCue(group, id, context), peers, selected, end, Math.max(0, end - occupiedUntil), false);
}

export async function importTimelineScript(source: string): Promise<AltairCommandGroup> {
  const { importWebGal, webGalCommandToAuthoredNode } = await import("@haneoka/altair-plugin-webgal");
  const imported = importWebGal(source, {
    sceneId: crypto.randomUUID(),
    title: tr("Imported timeline"),
  });
  const errors = imported.diagnostics.filter((item) => item.severity === "error");
  if (errors.length) throw Error(errors.map((item) => item.message).join("\n"));
  const nodes = imported.project.scenes[0]!.commands.map(webGalCommandToAuthoredNode);
  if (!nodes.length) throw Error(tr("No commands found"));
  const timeline = nodes.length === 1 && isTimeline(nodes[0]!) ? nodes[0]! : createTimeline(nodes, true);
  return {
    id: crypto.randomUUID(),
    name: tr("Imported timeline"),
    sourceSceneId: imported.project.scenes[0]!.id,
    nodes: [timeline],
    plugins: imported.project.plugins ?? [],
  };
}
