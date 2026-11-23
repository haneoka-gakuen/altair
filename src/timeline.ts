import {
  ADV_DIALOGUE_TIMING,
  advAutoPlayReadDelaySeconds,
  autoPlayIntervalSeconds,
  formatVegaSubRip,
  VEGA_ADV_OPCODE,
  parseVegaStageMediaClip,
  stageMediaAudioClip,
  type VegaSubtitleCue,
} from "@haneoka/vega-protocol";
import type { AltairAuthoredNode, AltairAuthoredWorkspace, AltairSceneDocument } from "./documents.js";
import type { JsonObject, JsonValue } from "./model.js";

export interface TimelineTimingContext {
  runtime?: JsonObject;
  assets?: JsonObject;
  locale?: string | undefined;
  timelines?: ReadonlyMap<string, TimelineSource>;
  activeTimelines?: ReadonlySet<AltairAuthoredNode>;
}

interface TimelineSource {
  scene: AltairSceneDocument;
  node: AltairAuthoredNode;
}

const timelineKey = (sceneId: string, nodeId: string) => JSON.stringify([sceneId, nodeId]);
const isTimeline = (node: AltairAuthoredNode) => node.type.plugin === "haneoka.altair" && node.type.name === "timeline";
const nativeNames = new Map<number, string>(Object.entries(VEGA_ADV_OPCODE).map(([name, opcode]) => [opcode, name]));

export const isTimelineReference = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "timelineRef";

export function createTimelineTimingContext(workspace: AltairAuthoredWorkspace): TimelineTimingContext {
  const { project, scenes } = workspace;
  const timelines = new Map<string, TimelineSource>();
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      if (isTimeline(node) && !node.disabled) timelines.set(timelineKey(scene.id, node.id), { scene, node });
    }
  }
  return { runtime: project.runtime, assets: project.assets, locale: project.locales[0], timelines };
}

export function listReusableTimelines(workspace: AltairAuthoredWorkspace) {
  return [...createTimelineTimingContext(workspace).timelines!.values()].map(({ scene, node }, index) => ({
    sceneId: scene.id,
    nodeId: node.id,
    sceneName: scene.name,
    name:
      typeof node.arguments.title === "string" && node.arguments.title.trim()
        ? node.arguments.title.trim()
        : `${scene.name} · ${index + 1}`,
  }));
}

export function resolveTimelineReference(
  node: AltairAuthoredNode,
  context: TimelineTimingContext,
): TimelineSource | undefined {
  if (!isTimelineReference(node)) return;
  const source = record(node.arguments.timeline);
  if (typeof source?.sceneId !== "string" || typeof source.nodeId !== "string") return;
  return context.timelines?.get(timelineKey(source.sceneId, source.nodeId));
}

export interface TimelineAnchor {
  nodeId: string;
  point: "start" | "end";
  offsetSeconds: number;
}

export interface ResolvedTimelineCue {
  node: AltairAuthoredNode;
  trackId: string;
  trackName: string;
  trackLocked: boolean;
  playbackMuted: boolean;
  playbackAudioMuted: boolean;
  audioOnly: boolean;
  trackGain?: number;
  atSeconds: number;
  role: "lifetime" | "event";
  durationSeconds: number;
  track: JsonObject;
  anchor?: TimelineAnchor;
  estimated?: boolean;
}

export interface TimelineTrackState {
  locked: boolean;
  muted: boolean;
  solo: boolean;
  gain?: number;
}

export function timelineTrackState(node: AltairAuthoredNode, id: string): TimelineTrackState {
  const state = record(record(node.arguments.trackStates)?.[id]);
  const gain = state?.gain;
  return {
    locked: state?.locked === true,
    muted: state?.muted === true,
    solo: state?.solo === true,
    ...(typeof gain === "number" && Number.isFinite(gain) && gain >= 0 && gain <= 1 ? { gain } : {}),
  };
}

function trackIdentity(node: AltairAuthoredNode, track: JsonObject, lanes: ReadonlyMap<string, string>) {
  const { plugin, name } = node.type;
  const args = node.arguments;
  const audioOnly =
    (plugin === "haneoka.altair" && (name === "audioClip" || (name === "timelineRef" && args.channels === "audio"))) ||
    (plugin === "haneoka.altair-adv" && ["Bgm", "Se", "Voice"].includes(name));
  const lane = typeof track.laneId === "string" ? lanes.get(track.laneId) : undefined;
  if (lane !== undefined) return { trackId: `lane:${track.laneId}`, trackName: lane, audioOnly };
  const named = [args.trackName, args.target, args.targetName].find(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
  const trackName = audioOnly
    ? plugin === "haneoka.altair"
      ? named || "Audio"
      : name
    : ["Focus", "Pan", "PanV2", "Tilt", "Pedestal", "Track", "Zoom", "CameraShake"].includes(name) ||
        named === "scene-camera"
      ? "Camera"
      : named ||
        (isTimedDialogue(node)
          ? "Dialogue"
          : name === "Delay" || name === "Wait"
            ? "Timing"
            : name === "Movie" || name === "Clip" || name === "mediaClip"
              ? "Video"
              : name === "Stage"
                ? "Background"
                : "Stage");
  return { trackId: `${audioOnly ? "audio" : "auto"}:${trackName}`, trackName, audioOnly };
}

const record = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

const seconds = (value: JsonValue | undefined, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

export function isTimedDialogue(node: AltairAuthoredNode): boolean {
  return node.type.plugin === "haneoka.altair-adv" && (node.type.name === "Talk" || node.type.name === "ChatTalk");
}

/** Native motion dispatch and detached effects do not advance the manuscript cursor by their media duration. */
const nativeDispatchOnly = new Set([
  "Motion",
  "MotionLoop",
  "Expression",
  "EyeBlink",
  "Pause",
  "Resume",
  "Se",
  "Effect",
  "PostEffect",
  "Subtitles",
]);

export function nativeTimelineCueDispatchesImmediately(node: AltairAuthoredNode): boolean {
  return node.type.plugin === "haneoka.altair-adv" && nativeDispatchOnly.has(node.type.name);
}

export function timelineCommandBlocksFollowing(node: AltairAuthoredNode): boolean {
  if (node.disabled) return false;
  if (node.type.plugin === "haneoka.altair-adv") {
    if (node.type.name === "Wait" || node.type.name === "Delay") return true;
    if (nativeTimelineCueDispatchesImmediately(node)) return false;
  }
  const original = record(node.extensions?.fields);
  return !(node.arguments.noWait ?? original?.noWait) && !(node.arguments.parallel ?? original?.parallel);
}

function localizedText(text: JsonValue | undefined, locale?: string): string {
  if (typeof text === "string") return text;
  const byLocale = record(text);
  const selected = locale && byLocale?.[locale];
  if (typeof selected === "string" && selected) return selected;
  const candidates = Array.isArray(text) ? text : Object.values(byLocale ?? {});
  return candidates.find((value): value is string => typeof value === "string" && Boolean(value)) ?? "";
}

function audioSeconds(value: JsonValue | undefined): number {
  const audio = record(value);
  if (!audio) return 0;
  return (
    seconds(audio.durationMs) / 1000 ||
    seconds(audio.durationSeconds ?? audio.durationSec) ||
    (seconds(audio.sampleRate) ? seconds(audio.totalSamples) / seconds(audio.sampleRate) : 0)
  );
}

function voiceAssetSeconds(assets: JsonObject | undefined, reference: string): number {
  for (const kind of ["voices", "sounds", "audio"]) {
    const entries = assets?.[kind];
    const direct = record(entries)?.[reference];
    if (direct) return audioSeconds(direct);
    if (!Array.isArray(entries)) continue;
    const matching = entries.find((entry) => {
      const sound = record(entry);
      return (
        sound &&
        [
          sound.id,
          sound.soundId,
          sound.resourceRef,
          sound.playableUrl,
          sound.path,
          `${sound.cueSheetName}/${sound.cueName}`,
        ].some((key) => (typeof key === "string" || typeof key === "number") && String(key) === reference)
      );
    });
    if (matching) return audioSeconds(matching);
  }
  return 0;
}

function estimatedDialogueSeconds(node: AltairAuthoredNode, context: TimelineTimingContext): number {
  const args = node.arguments;
  const fields = record(node.extensions?.fields);
  const presentation = record(args.talkPresentation ?? fields?.talkPresentation);
  const reveal = record(presentation?.textReveal);
  const text = localizedText(args.text ?? fields?.text, context.locale);
  const visible = [...text.replace(/<[^>]*(?:>|$)/gu, "")].length;
  const revealUnits = reveal?.unit === "utf16-code-unit" ? text.length : visible;
  const rate = seconds(reveal?.unitsPerSecond);
  const revealSeconds =
    node.type.name === "Talk" ? revealUnits * (rate ? 1 / rate : ADV_DIALOGUE_TIMING.revealSecondsPerUnit) : 0;
  const voiceRefs = Array.isArray(args.voiceRefs) ? args.voiceRefs : [];
  const assets = context.assets;
  const voices = args.voices ?? fields?.voices;
  const voiceSeconds = Math.max(
    0,
    ...(Array.isArray(voices) ? voices.map(audioSeconds) : []),
    ...voiceRefs.map((ref) =>
      typeof ref === "string" || typeof ref === "number" ? voiceAssetSeconds(assets, String(ref)) : 0,
    ),
  );
  const runtime = context.runtime;
  const readSeconds = advAutoPlayReadDelaySeconds(
    seconds(runtime?.minTalkDisplayTime, ADV_DIALOGUE_TIMING.minimumReadSeconds),
    presentation?.autoAdvanceAfterTextReveal
      ? 0
      : visible * seconds(runtime?.waitTalkTextUnitTime, ADV_DIALOGUE_TIMING.readSecondsPerUnit),
    voiceSeconds ? Math.max(0, voiceSeconds + seconds(runtime?.waitAfterVoiceTime) - revealSeconds) : 0,
    autoPlayIntervalSeconds(undefined),
  );
  return Math.round((readSeconds + revealSeconds) * 1000) / 1000;
}

export function timelineCueDuration(node: AltairAuthoredNode, context: TimelineTimingContext = {}): number {
  const args = node.arguments;
  const original = record(node.extensions?.fields);
  if (node.disabled) return 0;
  if (isTimedDialogue(node)) {
    if (args.noWait ?? original?.noWait) return 0;
    const fixed = seconds(args.advanceAfterSeconds ?? original?.advanceAfterSeconds, -1);
    return fixed >= 0 ? fixed : estimatedDialogueSeconds(node, context);
  }
  if (node.type.plugin === "haneoka.altair-adv" && node.type.name === "Voice") {
    const refs = Array.isArray(args.voiceRefs) ? args.voiceRefs : [];
    const voices = args.voices ?? original?.voices;
    return Math.max(
      0,
      ...(Array.isArray(voices) ? voices.map(audioSeconds) : []),
      ...refs.map((ref) =>
        typeof ref === "string" || typeof ref === "number" ? voiceAssetSeconds(context.assets, String(ref)) : 0,
      ),
    );
  }
  if (node.type.plugin === "haneoka.altair-adv" && node.type.name === "Movie") {
    const duration = audioSeconds(args.video ?? original?.video ?? args.movie ?? original?.movie);
    if (duration > 0) return duration;
  }
  if (
    node.type.plugin === "haneoka.altair-adv" &&
    node.type.name === "Se" &&
    !seconds(args.duration ?? original?.duration)
  ) {
    const ref = args.seRef;
    const duration =
      audioSeconds(args.se ?? original?.se) ||
      (typeof ref === "string" || typeof ref === "number" ? voiceAssetSeconds(context.assets, String(ref)) : 0);
    if (duration > 0) return duration + seconds(args.delaySeconds ?? original?.delaySeconds);
  }
  if (isTimelineReference(node)) {
    const source = resolveTimelineReference(node, context);
    return source ? timelineInstanceWindow(node, timelineCueDuration(source.node, context)).duration : 0;
  }
  if (node.type.plugin === "haneoka.altair-adv" && node.type.name === "Wait") {
    return seconds(context.runtime?.waitCommandLingeringTimeOnAutoPlay, 2);
  }
  if (
    node.type.plugin === "haneoka.altair-adv" &&
    node.type.name === "Flash" &&
    args.duration === undefined &&
    original?.duration === undefined
  ) {
    return 0.3;
  }
  if (node.type.plugin === "haneoka.altair") {
    if (node.type.name === "timeline") {
      return Math.max(seconds(args.durationSeconds), ...resolveTimelineCues(node, context).map(cueEnd));
    }
    if (node.type.name === "propertyClip") return seconds(record(args.clip)?.durationSeconds);
  }
  if (node.type.plugin === "haneoka.altair-adv" && node.type.name === "Timeline") {
    const asset = nativeTimelineAsset(node, context);
    if (asset) return nativeTimelineDuration(asset);
  }
  if (
    node.type.plugin === "haneoka.altair-adv" &&
    ["Still", "Frame", "PostEffect", "CameraShake"].includes(node.type.name)
  ) {
    const key = node.type.name === "Still" ? "transitionDuration" : "fadeDuration";
    const raw = Array.isArray(original?.params) ? original.params[0] : undefined;
    const duration = seconds(Number(args[key] ?? original?.[key] ?? raw));
    if (duration > 0) return duration + seconds(args.delaySeconds ?? original?.delaySeconds);
  }
  for (const key of ["durationSeconds", "durationMs", "duration", "fadeDuration", "transitionDuration"]) {
    const value = args[key] ?? original?.[key];
    if (value !== undefined) {
      const duration = seconds(Number(value)) / (key === "durationMs" ? 1000 : 1);
      return duration + seconds(args.delaySeconds ?? original?.delaySeconds);
    }
  }
  return 0;
}

const cueEnd = (cue: ResolvedTimelineCue) => cue.atSeconds + cue.durationSeconds;

export function timelineInstanceWindow(instance: AltairAuthoredNode, sourceSeconds: number) {
  const {
    sourceInSeconds = 0,
    sourceOutSeconds,
    playbackRate = 1,
    loopDurationSeconds,
    loopOffsetSeconds = 0,
  } = instance.arguments;
  if (
    typeof sourceInSeconds !== "number" ||
    !Number.isFinite(sourceInSeconds) ||
    sourceInSeconds < 0 ||
    (sourceOutSeconds !== undefined &&
      (typeof sourceOutSeconds !== "number" ||
        !Number.isFinite(sourceOutSeconds) ||
        sourceOutSeconds < sourceInSeconds)) ||
    typeof playbackRate !== "number" ||
    !Number.isFinite(playbackRate) ||
    playbackRate <= 0 ||
    (loopDurationSeconds !== undefined &&
      (typeof loopDurationSeconds !== "number" || !Number.isFinite(loopDurationSeconds) || loopDurationSeconds < 0)) ||
    typeof loopOffsetSeconds !== "number" ||
    !Number.isFinite(loopOffsetSeconds) ||
    loopOffsetSeconds < 0
  )
    throw new RangeError(`Invalid instance playback window: ${instance.id}`);
  const start = Math.min(sourceSeconds, sourceInSeconds);
  const end = Math.min(sourceSeconds, sourceOutSeconds ?? sourceSeconds);
  const period = (end - start) / playbackRate;
  if (!Number.isFinite(period)) throw new RangeError(`Invalid instance playback window: ${instance.id}`);
  if (loopDurationSeconds !== undefined && period <= 0) throw new RangeError("Cannot loop an empty timeline");
  return {
    start,
    end,
    rate: playbackRate,
    duration: loopDurationSeconds ?? period,
    sourceSeconds,
    ...(loopDurationSeconds === undefined ? {} : { loop: { period, offset: loopOffsetSeconds } }),
  };
}

type InstanceWindow = ReturnType<typeof timelineInstanceWindow>;

export function nativeTimelineAsset(node: AltairAuthoredNode, context: TimelineTimingContext): JsonObject | undefined {
  const fields = record(node.extensions?.fields);
  const direct = record(node.arguments.timeline ?? fields?.timeline);
  if (Array.isArray(direct?.signals)) return direct;
  const assets = context.assets?.timelines;
  const name = node.arguments.targetAssetName ?? fields?.targetAssetName;
  if (typeof name !== "string" || !name) return;
  const entry = record(
    record(assets)?.[name] ??
      (Array.isArray(assets)
        ? assets.find((value) => [record(value)?.assetName, record(value)?.assetAddress].includes(name))
        : undefined),
  );
  return Array.isArray(entry?.signals) ? entry : undefined;
}

function nativeTimelineDuration(asset: JsonObject): number {
  return seconds(asset.duration, -1) >= 0
    ? Number(asset.duration)
    : Math.max(0, ...(asset.signals as JsonValue[]).map((signal) => seconds(record(signal)?.time)));
}

export function timelineAssetWithShakeSeeds(asset: JsonObject, id: string): JsonObject {
  const identity = asset.assetAddress || asset.assetName || id;
  return {
    ...asset,
    signals: (asset.signals as JsonValue[]).map((value, index) => {
      const signal = record(value);
      const episode = record(signal?.episode);
      if (Number(episode?.command) !== VEGA_ADV_OPCODE.CameraShake || episode?.timelineShakeSeed) return value;
      return { ...signal, episode: { ...episode, timelineShakeSeed: `${identity}/${index}` } };
    }),
  };
}

function nativeTimelineSource(node: AltairAuthoredNode, asset: JsonObject): AltairAuthoredNode {
  const children: AltairAuthoredNode[] = [];
  const tracks: JsonObject[] = [];
  const durationSeconds = nativeTimelineDuration(asset);
  for (const [index, value] of (timelineAssetWithShakeSeeds(asset, node.id).signals as JsonValue[]).entries()) {
    const signal = record(value);
    const episode = record(signal?.episode);
    const opcode = Number(episode?.command);
    const name = nativeNames.get(opcode);
    const atSeconds = seconds(signal?.time);
    if (!episode || episode.ignoreData || opcode === VEGA_ADV_OPCODE.Timeline || atSeconds > durationSeconds) continue;
    if (!name) throw new Error(`Unsupported native timeline signal ${String(episode.command)}`);
    const { command: _command, commandId: _id, ...fields } = episode;
    const id = `${node.id}/signal/${index}`;
    children.push({
      id,
      type: { plugin: "haneoka.altair-adv", name },
      schemaVersion: 1,
      arguments: {},
      extensions: { fields },
    });
    tracks.push({ nodeId: id, atSeconds, role: "lifetime" });
  }
  return {
    id: node.id,
    type: { plugin: "haneoka.altair", name: "timeline" },
    schemaVersion: 1,
    arguments: { tracks, durationSeconds, waitForCompletion: node.arguments.noWait !== true },
    children,
  };
}

// These native scene actions finish in a persistent pose and can replay that pose at the cut-in.
const nativePoseCommands = new Set([
  "In",
  "Out",
  "Focus",
  "Pan",
  "PanV2",
  "Zoom",
  "Angle",
  "Pedestal",
  "Look",
  "LookTarget",
  "Forward",
  "Back",
  "Role",
  "DoF",
  "Alpha",
  "FadeIn",
  "FadeOut",
  "Tilt",
  "Track",
  "Brightness",
  "MoveToLeft",
  "MoveToRight",
  "MoveToUp",
  "MoveToDown",
  "MoveToForward",
  "MoveToBack",
  "MoveToDirection",
  "Location",
  "Stage",
  "Still",
  "Frame",
  "PostEffect",
  "SoundVolume",
  "Shake",
  "Flash",
]);

const nativePersistentCommands = new Set([
  "Character",
  "Costume",
  "StageEnv",
  "Expression",
  "MotionLoop",
  "EyeBlink",
  "Pause",
  "Resume",
  "RimLight",
  "TalkWindow",
  "CancelDelay",
  "ForceAuto",
]);

const nativeChatPointCommands = new Set(["ChatWindow", "ChatRead", "ChatStamp", "ChatTyping"]);

const replacingNativeChannels: Record<string, string> = {
  FadeOut: "cover",
  FadeIn: "cover",
  Pan: "pan",
  PanV2: "panV2",
  Tilt: "tilt",
  Track: "track",
  Pedestal: "pedestal",
  Zoom: "zoom",
  Role: "roll",
  Focus: "focus",
  Angle: "angle",
  Look: "gaze",
  LookTarget: "gaze",
  Alpha: "alpha",
  In: "visibility",
  Out: "visibility",
  MoveToLeft: "position",
  MoveToRight: "position",
  MoveToUp: "position",
  MoveToDown: "position",
  MoveToForward: "position",
  MoveToBack: "position",
  MoveToDirection: "position",
  Location: "position",
};

function nativeReplacementKey(node: AltairAuthoredNode): string | undefined {
  if (node.type.plugin !== "haneoka.altair-adv") return;
  const channel = replacingNativeChannels[node.type.name];
  if (!channel) return;
  if (["cover", "pan", "panV2", "tilt", "track", "pedestal", "zoom", "roll", "focus"].includes(channel)) return channel;
  const fields = record(node.extensions?.fields);
  const subject = node.arguments.targetName ?? fields?.targetName ?? node.arguments.targets ?? fields?.targets;
  const position = node.arguments.positionType ?? fields?.positionType;
  const layers = node.arguments.canvasLayers ?? fields?.canvasLayers;
  return JSON.stringify([channel, subject || position || 5, layers]);
}

function projectFadeWindow(fields: JsonObject, originalDuration: number, offset: number, rate: number): JsonObject {
  if (!fields.fadeInSeconds && !fields.fadeOutSeconds) return {};
  const previous = record(fields.fadeWindow);
  const playbackRate = Number(previous?.playbackRate ?? 1);
  return {
    fadeWindow: {
      durationSeconds: Number(previous?.durationSeconds ?? originalDuration),
      offsetSeconds: Math.max(0, Number(previous?.offsetSeconds ?? 0) + offset * playbackRate),
      playbackRate: playbackRate * rate,
    },
  };
}

export function projectMediaAppearanceWindow(
  fields: JsonObject,
  originalDuration: number,
  offset: number,
  rate: number,
  duration: number,
): JsonObject {
  return {
    ...projectFadeWindow(fields, originalDuration, offset, rate),
    ...projectClipAnimationWindow(fields, "visualAnimation", offset, rate, duration),
    ...projectClipAnimationWindow(fields, "gainAnimation", offset, rate, duration),
  };
}

export function projectClipAnimationWindow(
  fields: JsonObject,
  key: "visualAnimation" | "gainAnimation",
  offset: number,
  rate: number,
  duration: number,
): JsonObject {
  const animation = record(fields[key]);
  if (!animation) return {};
  const previous = record(animation.sourceWindow);
  const sourceDuration = Number(previous?.durationSeconds ?? animation.durationSeconds);
  const previousRate = Number(previous?.playbackRate ?? 1);
  const playbackRate = previousRate * rate;
  const offsetSeconds = Math.max(
    0,
    Math.min(sourceDuration, Number(previous?.offsetSeconds ?? 0) + offset * previousRate),
  );
  return {
    [key]: {
      ...animation,
      durationSeconds: Math.min(duration, (sourceDuration - offsetSeconds) / playbackRate),
      sourceWindow: { durationSeconds: sourceDuration, offsetSeconds, playbackRate },
    },
  };
}

function transformWindowCue(
  cue: ResolvedTimelineCue,
  into: number,
  until: number,
  rate: number,
  before: boolean,
  context: TimelineTimingContext,
  elapsedBefore: number,
  remainingInInstance: number,
  interrupted: boolean,
): AltairAuthoredNode | undefined {
  const node = cue.node,
    args = node.arguments,
    original = record(node.extensions?.fields) ?? {};
  const duration = Math.max(0, (until - into) / rate);
  const unsupported = () => {
    throw new Error(`Cannot seek or retime ${node.type.name} (${node.id}) inside this timeline window`);
  };
  if (isTimelineReference(node)) {
    const composition = record(args.composition);
    if (composition && (before || duration === 0)) return;
    const source = resolveTimelineReference(node, context);
    if (!source) return;
    const inner = timelineInstanceWindow(node, timelineCueDuration(source.node, context));
    const appearance: JsonObject = composition
      ? {
          composition: {
            ...composition,
            ...projectMediaAppearanceWindow(composition, inner.duration, into, rate, duration),
          },
        }
      : {};
    if (inner.loop)
      return {
        ...node,
        arguments: {
          ...args,
          ...appearance,
          playbackRate: inner.rate * rate,
          loopDurationSeconds: duration,
          loopOffsetSeconds: (inner.loop.offset + into) / rate,
        },
      };
    return {
      ...node,
      arguments: {
        ...args,
        ...appearance,
        sourceInSeconds: inner.start + into * inner.rate,
        sourceOutSeconds: inner.start + until * inner.rate,
        playbackRate: inner.rate * rate,
      },
    };
  }
  if (isTimeline(node))
    return projectTimelineWindow(
      node,
      { start: into, end: until, rate, duration, sourceSeconds: cue.durationSeconds },
      context,
    );
  if (node.type.plugin === "haneoka.altair") {
    if (node.type.name === "mediaClip") {
      if (before) return;
      const speed = Number(args.playbackRate ?? 1);
      return {
        ...node,
        arguments: {
          ...args,
          durationSeconds: duration,
          offsetSeconds: Number(args.offsetSeconds ?? 0) + into * speed,
          playbackRate: speed * rate,
          ...projectMediaAppearanceWindow(args, cue.durationSeconds, into, rate, duration),
        },
      };
    }
    if (node.type.name === "propertyClip" || node.type.name === "audioClip") {
      if (before && (node.type.name === "audioClip" || args.keep === false)) return;
      const clip = node.type.name === "propertyClip" ? record(args.clip) : args;
      if (!clip) return unsupported();
      const previous = record(clip.sourceWindow);
      const previousRate = Number(previous?.playbackRate ?? 1);
      const sourceWindow = {
        durationSeconds: Number(previous?.durationSeconds ?? clip.durationSeconds),
        offsetSeconds: Number(previous?.offsetSeconds ?? 0) + into * previousRate,
        playbackRate: rate * previousRate,
      };
      if (node.type.name === "propertyClip")
        return { ...node, arguments: { ...args, clip: { ...clip, sourceWindow, durationSeconds: duration } } };
      return {
        ...node,
        arguments: {
          ...args,
          sourceWindow,
          durationSeconds: duration,
          playbackRate: Number(args.playbackRate ?? 1) * rate,
          ...projectClipAnimationWindow(args, "gainAnimation", into, rate, duration),
        },
      };
    }
    if (node.type.name === "adjustment")
      return before
        ? undefined
        : {
            ...node,
            arguments: {
              ...args,
              durationSeconds: duration,
              ...projectMediaAppearanceWindow(args, cue.durationSeconds, into, rate, duration),
            },
          };
    if (node.type.name === "note") return;
    return unsupported();
  }
  if (node.type.plugin !== "haneoka.altair-adv") return unsupported();
  if (node.type.name === "Timeline") {
    const asset = nativeTimelineAsset(node, context);
    if (!asset) return unsupported();
    const start = before ? into + 1e-9 : into;
    return projectTimelineWindow(
      nativeTimelineSource(node, asset),
      {
        start,
        end: before ? start : until,
        rate,
        duration,
        sourceSeconds: nativeTimelineDuration(asset),
      },
      context,
    );
  }
  if (node.type.name === "Wait" || node.type.name === "Delay") {
    return before ? undefined : { ...node, type: { ...node.type, name: "Delay" }, arguments: { duration } };
  }
  if (isTimedDialogue(node)) {
    const presentation = record(args.talkPresentation ?? original.talkPresentation) ?? {};
    const reveal = record(presentation.textReveal) ?? {};
    const units = Number(reveal.unitsPerSecond) || 1 / ADV_DIALOGUE_TIMING.revealSecondsPerUnit;
    const next = {
      ...presentation,
      textReveal: {
        ...reveal,
        unitsPerSecond: units * rate,
        initialUnits: before ? Number.MAX_SAFE_INTEGER : Number(reveal.initialUnits ?? 0) + into * units,
      },
    };
    return {
      ...node,
      arguments: {
        ...args,
        advanceAfterSeconds: duration,
        talkPresentation: next,
        ...(before ? { noWait: true } : {}),
      },
      extensions: {
        ...node.extensions,
        fields: {
          ...original,
          talkPresentation: next,
          ...(before
            ? { timelineAudioMuted: true }
            : { timelineSourceWindow: { offsetSeconds: into, durationSeconds: duration, playbackRate: rate } }),
        },
      },
    };
  }
  if (node.type.name === "Subtitles") {
    return {
      ...node,
      arguments: { ...args, ...(before ? { noWait: true } : {}) },
      extensions: {
        ...node.extensions,
        fields: {
          ...original,
          timelineSourceWindow: { offsetSeconds: into, durationSeconds: duration, playbackRate: rate },
        },
      },
    };
  }
  if (node.type.name === "CameraShake") {
    return {
      ...node,
      extensions: {
        ...node.extensions,
        fields: {
          ...original,
          timelineSourceWindow: {
            offsetSeconds: before ? elapsedBefore : into,
            durationSeconds: duration,
            playbackRate: rate,
          },
        },
      },
    };
  }
  if (node.type.name === "Motion" || node.type.name === "Effect") {
    const wait = seconds(args.motionWait ?? original.motionWait);
    const elapsed = before ? elapsedBefore : into;
    if (node.type.name === "Motion" && (wait - elapsed) / rate >= remainingInInstance) return;
    const timelineSourceWindow = {
      offsetSeconds: Math.max(0, elapsed - wait),
      durationSeconds: duration,
      playbackRate: rate,
    };
    return {
      ...node,
      arguments: {
        ...args,
        ...(node.type.name === "Motion" ? { motionWait: Math.max(0, wait - elapsed) / rate } : {}),
      },
      extensions: { ...node.extensions, fields: { ...original, timelineSourceWindow } },
    };
  }
  if (["Voice", "Se", "Bgm", "Movie", "Clip"].includes(node.type.name)) {
    if (before && node.type.name !== "Bgm") return;
    if (node.type.name === "Bgm" && before && seconds(args.duration ?? original.duration) > 0) {
      const { bgm: _sound, ...field } = original;
      return {
        ...node,
        arguments: { ...args, bgmRef: "", fadeIn: 0, stopFade: 0, duration: 0 },
        extensions: { ...node.extensions, fields: field },
      };
    }
    const delay = node.type.name === "Se" ? seconds(args.delaySeconds ?? original.delaySeconds) : 0;
    if (!before && until <= delay && delay > 0) return;
    const activeDuration = Math.max(0, (until - Math.max(into, delay)) / rate);
    const timelineSourceWindow = {
      offsetSeconds: before ? elapsedBefore : Math.max(0, into - delay),
      durationSeconds: node.type.name === "Bgm" && cue.durationSeconds === 0 ? remainingInInstance : activeDuration,
      playbackRate: rate,
    };
    return {
      ...node,
      arguments: {
        ...args,
        ...(before ? {} : { duration: activeDuration }),
        ...(delay ? { delaySeconds: Math.max(0, delay - into) / rate } : {}),
      },
      extensions: { ...node.extensions, fields: { ...original, timelineSourceWindow } },
    };
  }
  if (nativePoseCommands.has(node.type.name)) {
    if (before && ["Shake", "Flash"].includes(node.type.name)) return;
    const delay = Math.min(cue.durationSeconds, seconds(args.delaySeconds ?? original.delaySeconds));
    if (interrupted && into < delay) return;
    if (!before && until < delay) return;
    const span = cue.durationSeconds - delay;
    const from = span > 0 ? Math.max(0, Math.min(1, (into - delay) / span)) : 0;
    const to = span > 0 ? Math.max(from, Math.min(1, (until - delay) / span)) : 1;
    const phaseSeconds = ((to - from) * span) / rate;
    const fields: JsonObject = {
      ...args,
      duration: before ? -1 : phaseSeconds || -1,
      delaySeconds: before ? 0 : Math.max(0, delay - into) / rate,
      ...(before ? { noWait: false } : {}),
    };
    if (node.type.name === "PostEffect" || node.type.name === "Frame" || args.fadeDuration !== undefined)
      fields.fadeDuration = before ? 0 : phaseSeconds;
    if (node.type.name === "Still" || args.transitionDuration !== undefined)
      fields.transitionDuration = before ? 0 : phaseSeconds;
    return {
      ...node,
      arguments: fields,
      extensions: {
        ...node.extensions,
        fields: {
          ...original,
          ...(before ? { timelineReplayImmediate: true } : {}),
          ...(before && node.type.name === "Out" && !interrupted ? { nativeTimelineSpan: { from: 0, to: 1 } } : {}),
          ...((!before || interrupted) && span > 0
            ? { nativeTimelineSpan: { from, to, sourceDurationSeconds: span } }
            : {}),
          ...(node.type.name === "Frame"
            ? {
                timelineSourceWindow: {
                  offsetSeconds: Math.max(0, (before ? elapsedBefore : into) - delay),
                  durationSeconds: phaseSeconds,
                  playbackRate: rate,
                },
              }
            : {}),
        },
      },
    };
  }
  if (nativePersistentCommands.has(node.type.name)) {
    const delay = seconds(args.delaySeconds ?? original.delaySeconds);
    if (delay > into && (before ? delay > elapsedBefore : delay >= until && until > 0)) return;
    return {
      ...node,
      arguments: { ...args, duration: -1, delaySeconds: before ? 0 : Math.max(0, delay - into) / rate },
      extensions: {
        ...node.extensions,
        fields: {
          ...original,
          timelineSourceWindow: {
            offsetSeconds: Math.max(0, (before ? elapsedBefore : into) - delay),
            durationSeconds: remainingInInstance,
            playbackRate: rate,
          },
        },
      },
    };
  }
  if (nativeChatPointCommands.has(node.type.name) && (before || cue.durationSeconds === 0)) {
    if (!before) return node;
    return {
      ...node,
      arguments: { ...args, noWait: true },
      extensions: {
        ...node.extensions,
        fields: { ...original, timelineReplayImmediate: true, timelineAudioMuted: true },
      },
    };
  }
  if (!before && into === 0 && until === cue.durationSeconds && rate === 1 && cue.durationSeconds > 0) return node;
  return unsupported();
}

function projectTimelineWindow(
  source: AltairAuthoredNode,
  window: InstanceWindow,
  context: TimelineTimingContext,
): AltairAuthoredNode {
  const children: AltairAuthoredNode[] = [];
  const tracks: JsonObject[] = [];
  const sourceCues = resolveTimelineCues(source, context).sort((a, b) => a.atSeconds - b.atSeconds);
  const clipEnds = new Map<string, number>();
  const clipStops = new Set<string>();
  const shakeReplacements = new Map<string, number>();
  const poseReplacements = new Map<string, number>();
  const previousByChannel = new Map<string, ResolvedTimelineCue>();
  let previousShake: ResolvedTimelineCue | undefined;
  let nativeClip: ResolvedTimelineCue | undefined;
  for (const cue of sourceCues) {
    if (!cue.node.disabled && !cue.playbackMuted && cue.atSeconds < window.start) {
      const channel = nativeReplacementKey(cue.node);
      if (channel) {
        const previous = previousByChannel.get(channel);
        const fields = record(cue.node.extensions?.fields);
        const startsAt = cue.atSeconds + seconds(cue.node.arguments.delaySeconds ?? fields?.delaySeconds);
        if (previous && startsAt < window.start && startsAt < cueEnd(previous))
          poseReplacements.set(previous.node.id, startsAt);
        previousByChannel.set(channel, cue);
      }
    }
    if (
      !cue.node.disabled &&
      !cue.playbackMuted &&
      cue.node.type.plugin === "haneoka.altair-adv" &&
      cue.node.type.name === "CameraShake"
    ) {
      if (previousShake && cue.atSeconds < window.start - 1e-9)
        shakeReplacements.set(previousShake.node.id, cue.atSeconds);
      previousShake = cue;
    }
    if (
      cue.node.disabled ||
      cue.playbackMuted ||
      cue.node.type.plugin !== "haneoka.altair-adv" ||
      cue.node.type.name !== "Clip"
    )
      continue;
    if (nativeClip) {
      clipEnds.set(nativeClip.node.id, cue.atSeconds);
      clipStops.add(cue.node.id);
      nativeClip = undefined;
    } else {
      const fields = record(cue.node.extensions?.fields);
      if (cue.node.arguments.videoRef || cue.node.arguments.videoId || fields?.video || fields?.clip || fields?.videoId)
        nativeClip = cue;
    }
  }
  if (nativeClip) clipEnds.set(nativeClip.node.id, window.sourceSeconds);
  let prefix: string | undefined;
  for (const entry of sourceCues) {
    if (entry.node.disabled || entry.atSeconds >= window.end || clipStops.has(entry.node.id)) continue;
    const clipEnd = clipEnds.get(entry.node.id);
    const cue = clipEnd === undefined ? entry : { ...entry, durationSeconds: Math.max(0, clipEnd - entry.atSeconds) };
    const end = cueEnd(cue);
    const poseReplacedAt = poseReplacements.get(cue.node.id);
    const replacedAt = shakeReplacements.get(cue.node.id) ?? poseReplacedAt;
    const before = (end <= window.start + 1e-9 || replacedAt !== undefined) && cue.atSeconds < window.start;
    const into = before
      ? poseReplacedAt === undefined
        ? cue.durationSeconds
        : poseReplacedAt - cue.atSeconds
      : Math.max(0, window.start - cue.atSeconds);
    const until = before ? into : Math.min(cue.durationSeconds, window.end - cue.atSeconds);
    const child = transformWindowCue(
      cue,
      into,
      until,
      window.rate,
      before,
      context,
      (replacedAt ?? window.start) - cue.atSeconds,
      (window.end - Math.max(cue.atSeconds, window.start)) / window.rate,
      poseReplacedAt !== undefined,
    );
    if (!child) continue;
    children.push(child);
    const { anchor, followPrevious, cueId, minimumEndSeconds, ...track } = cue.track;
    const atSeconds = Math.max(0, cue.atSeconds - window.start) / window.rate;
    tracks.push({
      ...track,
      atSeconds,
      ...(before ? { role: "lifetime" } : {}),
      ...(prefix ? { anchor: { nodeId: prefix, point: "end", offsetSeconds: atSeconds } } : {}),
    });
    if (before) prefix = child.id;
  }
  return {
    ...source,
    children,
    arguments: { ...source.arguments, tracks, inferredSequence: false, durationSeconds: window.duration },
  };
}

export type TimelineChannels = "both" | "picture" | "audio";

function instanceMix(args: JsonObject) {
  const channels = args.channels ?? "both",
    gain = args.gain ?? 1;
  if (channels !== "both" && channels !== "picture" && channels !== "audio")
    throw new TypeError("Invalid timeline channels");
  if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1)
    throw new RangeError("Invalid timeline gain");
  return { channels, gain } as const;
}

function mediaAudioArguments(
  clip: ReturnType<typeof parseVegaStageMediaClip>,
  id: string,
  name: string,
  gain?: JsonValue,
): JsonObject {
  const { sourceWindow, gainAnimation: _gainAnimation, ...sound } = stageMediaAudioClip(clip, id, name);
  return {
    ...sound,
    ...(sourceWindow ? { sourceWindow: { ...sourceWindow } } : {}),
    ...(gain ? { gainAnimation: gain } : {}),
  };
}

function nativeVideoSource(node: AltairAuthoredNode, context: TimelineTimingContext): string {
  const args = node.arguments,
    fields = record(node.extensions?.fields);
  const direct = (value: JsonValue | undefined) => {
    const entry = record(value);
    return typeof value === "string"
      ? value
      : [entry?.playableUrl, entry?.url, entry?.src, entry?.source].find(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
  };
  const supplied = direct(args.video ?? args.movie ?? args.clip ?? fields?.video ?? fields?.movie ?? fields?.clip);
  if (supplied) return supplied;
  const ref = args.videoRef ?? args.clipRef ?? args.videoId ?? fields?.videoId;
  if (typeof ref !== "string" && typeof ref !== "number") return "";
  for (const kind of ["videos", "movies", "clips"]) {
    const list = context.assets?.[kind],
      dict = record(list);
    const match =
      dict?.[String(ref)] ??
      (Array.isArray(list)
        ? list.find((v) => {
            const e = record(v);
            return e && [e.id, e.videoId, e.assetName, e.resourceRef].some((k) => String(k) === String(ref));
          })
        : undefined);
    const url = direct(match);
    if (url) return url;
  }
  return typeof ref === "string" ? ref : "";
}

function projectTimelineChannels(
  group: AltairAuthoredNode,
  channels: TimelineChannels,
  gain: number,
  context: TimelineTimingContext,
): AltairAuthoredNode {
  const source = resolveTimelineCues(group, context),
    children: AltairAuthoredNode[] = [],
    tracks: JsonObject[] = [];
  const duration = Math.max(seconds(group.arguments.durationSeconds), ...source.map(cueEnd));
  const clipStarts = source
    .filter((cue) => cue.node.type.plugin === "haneoka.altair-adv" && cue.node.type.name === "Clip")
    .sort((a, b) => a.atSeconds - b.atSeconds);
  for (const cue of source) {
    if (
      channels !== "both" &&
      (cue.node.disabled || cue.playbackMuted || (channels === "audio" && cue.playbackAudioMuted))
    )
      continue;
    const original = cue.node,
      args = original.arguments,
      { plugin, name } = original.type;
    let child = original,
      leafGain = gain;
    if (isTimelineReference(original)) {
      const prior = instanceMix(args);
      if (channels !== "both" && prior.channels !== "both" && channels !== prior.channels) continue;
      child = {
        ...original,
        arguments: { ...args, channels: channels === "both" ? prior.channels : channels, gain: prior.gain * gain },
      };
      leafGain = 1;
    } else if (isTimeline(original)) {
      child = projectTimelineChannels(original, channels, gain, context);
      leafGain = 1;
    } else if (plugin === "haneoka.altair" && name === "mediaClip") {
      if (channels === "picture") child = { ...original, arguments: { ...args, audioEnabled: false } };
      else if (channels === "audio") {
        if (args.mediaKind !== "video" || args.audioEnabled === false) continue;
        child = {
          ...original,
          type: { plugin: "haneoka.altair", name: "audioClip" },
          arguments: mediaAudioArguments(parseVegaStageMediaClip(args), original.id, cue.trackName, args.gainAnimation),
        };
      }
    } else if (channels === "picture") {
      if (cue.audioOnly) continue;
      if (plugin === "haneoka.altair-adv")
        child = {
          ...original,
          extensions: {
            ...original.extensions,
            fields: { ...record(original.extensions?.fields), timelineAudioMuted: true },
          },
        };
    } else if (channels === "audio" && !cue.audioOnly) {
      if (plugin !== "haneoka.altair-adv") continue;
      if (name === "Talk" || name === "ChatTalk") {
        const fields = record(original.extensions?.fields);
        if (
          !(Array.isArray(args.voiceRefs) && args.voiceRefs.length) &&
          !(Array.isArray(fields?.voices) && fields.voices.length) &&
          !(Array.isArray(args.voices) && args.voices.length)
        )
          continue;
        child = { ...original, type: { ...original.type, name: "Voice" }, arguments: { ...args, noWait: true } };
      } else if (name === "Timeline") {
        const asset = nativeTimelineAsset(original, context);
        if (!asset) continue;
        child = projectTimelineChannels(nativeTimelineSource(original, asset), channels, gain, context);
        leafGain = 1;
      } else if (name === "Movie" || name === "Clip") {
        const url = nativeVideoSource(original, context);
        if (!url) continue;
        const window =
          record(record(original.extensions?.fields)?.timelineSourceWindow) ?? record(args.timelineSourceWindow);
        const next = clipStarts.find((other) => other.atSeconds > cue.atSeconds);
        const length =
          cue.durationSeconds ||
          Math.max(0, (name === "Clip" ? (next?.atSeconds ?? duration) : duration) - cue.atSeconds);
        if (!length) continue;
        const clip = parseVegaStageMediaClip({
          source: url,
          mediaKind: "video",
          durationSeconds: length,
          offsetSeconds: seconds(window?.offsetSeconds),
          playbackRate: seconds(window?.playbackRate, 1),
        });
        child = {
          ...original,
          type: { plugin: "haneoka.altair", name: "audioClip" },
          arguments: mediaAudioArguments(clip, original.id, cue.trackName),
        };
      } else continue;
    }
    children.push(child);
    const { anchor, followPrevious, cueId, minimumEndSeconds, ...timing } = cue.track;
    tracks.push({
      ...(channels === "both" ? cue.track : { ...timing, atSeconds: cue.atSeconds }),
      nodeId: child.id,
      ...(leafGain !== 1 ? { instanceGain: seconds(timing.instanceGain, 1) * leafGain } : {}),
    });
  }
  return {
    ...group,
    children,
    arguments: {
      ...group.arguments,
      tracks,
      ...(channels === "both" ? {} : { inferredSequence: false, durationSeconds: duration }),
    },
  };
}

/** Apply the enclosing lane's audio policy without changing the stored instance controls. */
export function timelinePlaybackNode(cue: ResolvedTimelineCue): AltairAuthoredNode {
  const node = cue.node;
  if (!isTimelineReference(node) || (!cue.playbackAudioMuted && cue.trackGain === undefined)) return node;
  const mix = instanceMix(node.arguments);
  return {
    ...node,
    arguments: {
      ...node.arguments,
      channels: cue.playbackAudioMuted && mix.channels !== "audio" ? "picture" : mix.channels,
      gain: mix.gain * (cue.trackGain ?? 1),
    },
  };
}

export function resolveTimelineInstance(instance: AltairAuthoredNode, context: TimelineTimingContext) {
  const source = resolveTimelineReference(instance, context);
  if (!source) return;
  const window = timelineInstanceWindow(instance, timelineCueDuration(source.node, context));
  const { channels, gain } = instanceMix(instance.arguments);
  const complete = !window.loop && window.start === 0 && window.end === window.sourceSeconds && window.rate === 1;
  if (complete && channels === "both" && gain === 1) return source;
  const original = channels === "audio" ? projectTimelineChannels(source.node, channels, gain, context) : source.node;
  const node = window.loop
    ? projectTimelineLoop(original, window, window.loop, context)
    : complete
      ? original
      : projectTimelineWindow(original, window, context);
  return {
    ...source,
    node:
      channels === "audio" || (channels === "both" && gain === 1)
        ? node
        : projectTimelineChannels(node, channels, gain, context),
  };
}

function projectTimelineLoop(
  source: AltairAuthoredNode,
  window: InstanceWindow,
  loop: { period: number; offset: number },
  context: TimelineTimingContext,
): AltairAuthoredNode {
  const children: AltairAuthoredNode[] = [];
  const tracks: JsonObject[] = [];
  let time = 0;
  let phase = loop.offset % loop.period;
  if (loop.period - phase < 1e-9 || phase < 1e-9) phase = 0;
  if (window.duration === 0) {
    const point = loop.offset > 0 && phase === 0 ? window.end : window.start + phase * window.rate;
    return projectTimelineWindow(source, { ...window, start: point, end: point }, context);
  }
  while (time < window.duration - 1e-9) {
    const duration = Math.min(loop.period - phase, window.duration - time);
    const start = window.start + phase * window.rate;
    const end = Math.min(window.end, start + duration * window.rate);
    const slice =
      start === 0 && end === window.sourceSeconds && window.rate === 1
        ? source
        : projectTimelineWindow(source, { ...window, start, end, duration }, context);
    const id = `${source.id}/loop/${children.length}`;
    children.push({ ...slice, id, arguments: { ...slice.arguments, waitForCompletion: true } });
    tracks.push({ nodeId: id, role: "lifetime", atSeconds: time });
    time += duration;
    phase = 0;
  }
  return {
    ...source,
    children,
    arguments: {
      tracks,
      durationSeconds: window.duration,
      waitForCompletion: true,
      waitForPrevious: source.arguments.waitForPrevious ?? false,
      cancelOnManualAdvance: source.arguments.cancelOnManualAdvance ?? false,
    },
  };
}

export function timelineSubRip(
  cues: readonly ResolvedTimelineCue[],
  context: TimelineTimingContext = {},
  laneId?: string,
): string {
  const subtitles: VegaSubtitleCue[] = [];
  const collect = (entries: readonly ResolvedTimelineCue[], offset: number, track?: string) => {
    for (const cue of entries) {
      if (cue.node.disabled || cue.playbackMuted || (track && cue.track.laneId !== track)) continue;
      const start = offset + cue.atSeconds;
      const timeline = isTimeline(cue.node) ? cue.node : resolveTimelineInstance(cue.node, context)?.node;
      if (timeline) {
        collect(resolveTimelineCues(timeline, context), start);
      } else if (
        isTimedDialogue(cue.node) ||
        (cue.node.type.plugin === "haneoka.altair-adv" && cue.node.type.name === "Subtitles")
      ) {
        subtitles.push({
          text: localizedText(cue.node.arguments.text, context.locale),
          start,
          end: start + cue.durationSeconds,
        });
      }
    }
  };
  collect(cues, 0, laneId);
  return formatVegaSubRip(subtitles);
}

/** Resolves authored positions and links for both the workbench and the compiler. */
export function resolveTimelineCues(
  node: AltairAuthoredNode,
  context: TimelineTimingContext = {},
): ResolvedTimelineCue[] {
  if (!Array.isArray(node.arguments.tracks)) throw new TypeError("Timeline tracks must be an array");
  if (context.activeTimelines?.has(node)) throw new Error("Circular timeline reference");
  const childContext = { ...context, activeTimelines: new Set([...(context.activeTimelines ?? []), node]) };
  const children = new Map(node.children?.map((child) => [child.id, child]));
  const byId = new Map<string, ResolvedTimelineCue>();
  const byGroup = new Map<string, ResolvedTimelineCue[]>();
  const lanes = new Map<string, string>();
  if (Array.isArray(node.arguments.lanes))
    for (const entry of node.arguments.lanes) {
      const lane = record(entry);
      if (typeof lane?.id === "string" && typeof lane.name === "string" && !lanes.has(lane.id))
        lanes.set(lane.id, lane.name);
    }
  let previous: string | undefined;
  const cues = node.arguments.tracks.map((value): ResolvedTimelineCue => {
    const track = record(value);
    if (!track || typeof track.nodeId !== "string") throw new TypeError("Invalid timeline cue");
    const child = children.get(track.nodeId);
    if (!child || byId.has(child.id)) throw new Error("Invalid timeline node reference");
    const stored = record(track.anchor);
    const inferred = node.arguments.inferredSequence === true && track.followPrevious === true;
    const link = inferred
      ? previous && { nodeId: previous, point: "end", offsetSeconds: stored?.offsetSeconds }
      : stored;
    const anchor: TimelineAnchor | undefined =
      link && typeof link.nodeId === "string" && (link.point === "start" || link.point === "end")
        ? { nodeId: link.nodeId, point: link.point, offsetSeconds: seconds(link.offsetSeconds) }
        : undefined;
    const atSeconds = Number(track.atSeconds ?? 0);
    if (!Number.isFinite(atSeconds) || atSeconds < 0) throw new TypeError("Invalid cue start time");
    const identity = trackIdentity(child, track, lanes);
    const mix = timelineTrackState(node, identity.trackId);
    const cue: ResolvedTimelineCue = {
      node: child,
      ...identity,
      trackLocked: mix.locked,
      playbackMuted: mix.muted,
      playbackAudioMuted: mix.muted,
      ...(typeof track.instanceGain === "number"
        ? {
            trackGain:
              (mix.gain ??
                (child.type.plugin === "haneoka.altair" && child.type.name === "audioClip"
                  ? seconds(child.arguments.trackVolume, 1)
                  : 1)) * track.instanceGain,
          }
        : mix.gain !== undefined
          ? { trackGain: mix.gain }
          : {}),
      atSeconds,
      role: track.role === "event" ? "event" : "lifetime",
      durationSeconds: timelineCueDuration(child, childContext),
      track,
      ...(anchor ? { anchor } : {}),
      ...(isTimedDialogue(child) && !child.arguments.noWait && seconds(child.arguments.advanceAfterSeconds, -1) < 0
        ? { estimated: true }
        : {}),
    };
    byId.set(child.id, cue);
    if (cue.role === "lifetime" && timelineCommandBlocksFollowing(child)) previous = child.id;
    if (typeof track.cueId === "string") {
      const members = byGroup.get(track.cueId);
      if (members) members.push(cue);
      else byGroup.set(track.cueId, [cue]);
    }
    return cue;
  });
  const mediaAudio = (cue: ResolvedTimelineCue) =>
    (isTimelineReference(cue.node) && (cue.node.arguments.channels ?? "both") === "both") ||
    (cue.node.type.plugin === "haneoka.altair" &&
      cue.node.type.name === "mediaClip" &&
      cue.node.arguments.mediaKind === "video" &&
      cue.node.arguments.audioEnabled !== false);
  const solo = new Set(
    cues
      .filter(
        (cue) => (cue.audioOnly || mediaAudio(cue)) && !cue.node.disabled && timelineTrackState(node, cue.trackId).solo,
      )
      .map((cue) => cue.trackId),
  );
  if (solo.size)
    for (const cue of cues) {
      if (solo.has(cue.trackId)) continue;
      if (cue.audioOnly) cue.playbackMuted = true;
      cue.playbackAudioMuted = true;
    }
  const visiting = new Set<ResolvedTimelineCue>(),
    resolved = new Set<ResolvedTimelineCue>();
  const resolve = (cue: ResolvedTimelineCue) => {
    if (resolved.has(cue)) return;
    if (visiting.has(cue)) throw new Error("Circular timeline link");
    visiting.add(cue);
    if (cue.anchor) {
      const target = byId.get(cue.anchor.nodeId);
      const group = byGroup.get(cue.anchor.nodeId) ?? (target ? [target] : []);
      if (!group.length) throw new Error("Missing linked timeline cue");
      group.forEach(resolve);
      const boundary =
        cue.anchor.point === "end" ? Math.max(...group.map(cueEnd)) : Math.min(...group.map((item) => item.atSeconds));
      cue.atSeconds = boundary + cue.anchor.offsetSeconds;
    }
    visiting.delete(cue);
    resolved.add(cue);
  };
  cues.forEach(resolve);
  return cues;
}

export function rippleTimelineFollowing(
  original: readonly ResolvedTimelineCue[],
  next: AltairAuthoredNode,
  id: string,
  context?: TimelineTimingContext,
): AltairAuthoredNode {
  const previousIndex = original.findIndex((cue) => cue.node.id === id);
  const previous = original[previousIndex]!;
  const adjusted = resolveTimelineCues(next, context);
  const updatedById = new Map(adjusted.map((cue) => [cue.node.id, cue]));
  const delta = cueEnd(updatedById.get(id)!) - cueEnd(previous);
  if (Math.abs(delta) < 0.0005) return next;
  const tracks = original.map((cue, index) => {
    const updated = updatedById.get(cue.node.id)!;
    if (
      cue.node.id === id ||
      cue.trackLocked ||
      (next.arguments.rippleScope !== "timeline" && cue.trackId !== previous.trackId) ||
      updated.anchor ||
      cue.atSeconds + 0.0005 < cueEnd(previous) ||
      (previous.durationSeconds === 0 && cue.atSeconds === previous.atSeconds && index < previousIndex)
    )
      return updated.track;
    return { ...updated.track, atSeconds: Math.max(0, cue.atSeconds + delta) };
  });
  return { ...next, arguments: { ...next.arguments, tracks } };
}
