import { parseAuthoredText, serializeAuthoredText } from "./text.js";
import {
  createTimelineTimingContext,
  isTimelineReference,
  nativeTimelineAsset,
  timelineAssetWithShakeSeeds,
  nativeTimelineCueDispatchesImmediately,
  resolveTimelineCues,
  timelinePlaybackNode,
  timelineCueDuration,
  timelineInstanceWindow,
  resolveTimelineReference,
  resolveTimelineInstance,
  type TimelineAnchor,
} from "./timeline.js";
import {
  VEGA_SYSTEM_OPCODE,
  VEGA_ADV_OPCODE,
  VEGA_COMMAND_GROUP_OPCODE,
  VEGA_CORE_AUDIO_CLIP,
  VEGA_CORE_ADJUSTMENT,
  VEGA_CORE_MEDIA_CLIP,
  VEGA_CORE_COMPOSITION,
  VEGA_CORE_PROPERTY_CLIP,
  MAX_STAGE_CLIP_VOLUME,
  parsePropertyAnimationClip,
  parseVegaBackdropAdjustment,
  parseStageClipGainAnimation,
  parseVegaStageAdjustment,
  parseVegaStageMediaClip,
  parseVegaStageComposition,
} from "@haneoka/vega-protocol";
import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
  type StoryProjectPlugin,
} from "./model.js";

export const ALTAIR_PROJECT_FORMAT = "project" as const;
export const ALTAIR_SCENE_FORMAT = "scene" as const;
export interface AltairCommandType {
  readonly plugin: string;
  readonly name: string;
}
export interface AltairAuthoredNode {
  readonly id: string;
  readonly type: AltairCommandType;
  readonly schemaVersion: number;
  readonly arguments: JsonObject;
  readonly disabled?: boolean;
  readonly children?: readonly AltairAuthoredNode[];
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairSceneDocument {
  readonly format: typeof ALTAIR_SCENE_FORMAT;
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly AltairAuthoredNode[];
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairProjectDocument {
  readonly format: typeof ALTAIR_PROJECT_FORMAT;
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly locales: readonly string[];
  readonly entry: { readonly sceneId: string; readonly nodeId?: string };
  readonly scenes: readonly { readonly id: string; readonly path: string }[];
  readonly plugins: readonly StoryProjectPlugin[];
  readonly assets: JsonObject;
  readonly runtime: JsonObject;
  readonly extensions?: JsonObject;
  readonly [key: string]: unknown;
}
export interface AltairAuthoredWorkspace {
  readonly project: AltairProjectDocument;
  readonly scenes: readonly AltairSceneDocument[];
}
export interface AltairDocumentCommand {
  readonly type: AltairCommandType;
  readonly schemaVersion: number;
  readonly runtimePlugins?: readonly StoryProjectPlugin[];
  readonly migrate?: (node: AltairAuthoredNode) => AltairAuthoredNode;
  readonly lower: (
    node: AltairAuthoredNode,
    context: {
      readonly project: AltairProjectDocument;
      readonly scene: AltairSceneDocument;
    },
  ) => readonly StoryProjectCommand[];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
};
const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
};

const serialFlowCommands = new Set<number>([
  VEGA_ADV_OPCODE.ChoiceSet,
  VEGA_ADV_OPCODE.ChoiceShow,
  VEGA_ADV_OPCODE.GoTo,
  VEGA_SYSTEM_OPCODE.JumpScene,
  VEGA_SYSTEM_OPCODE.CallScene,
  VEGA_SYSTEM_OPCODE.ReturnScene,
  VEGA_SYSTEM_OPCODE.Branch,
  VEGA_SYSTEM_OPCODE.End,
  VEGA_SYSTEM_OPCODE.Input,
]);

function bindTimelineInstance(
  group: JsonObject,
  instanceKey: string,
  bindings: JsonObject,
  separator: string,
): JsonObject {
  const mapTarget = (value: string): string => {
    const bound = bindings[value];
    if (typeof bound === "string" && bound.trim()) return bound.trim();
    for (const prefix of ["character:", "filter:"]) {
      if (!value.startsWith(prefix)) continue;
      const target = bindings[value.slice(prefix.length)];
      if (typeof target === "string" && target.trim()) return `${prefix}${target.trim()}`;
    }
    return value;
  };
  const mapTargetNames = (value: string): string => {
    let names = value;
    for (const split of new Set([separator, "・", ",", "，", "、"])) {
      if (split) names = names.replaceAll(split, "\u0000");
    }
    return names
      .split("\u0000")
      .map((name) => mapTarget(name.trim()))
      .join(separator);
  };
  const mapFields = (command: JsonObject, key: string): JsonObject => {
    const fields: JsonObject = { ...command, key, commandId: key };
    const targetName = fields.targetName;
    if (typeof targetName === "string") fields.targetName = mapTargetNames(targetName);
    for (const name of ["target", "lipSyncTarget", "lookTarget"]) {
      const value = fields[name];
      if (typeof value === "string") fields[name] = mapTarget(value);
    }
    for (const name of ["focusTargets", "lipSyncTargets"]) {
      const value = fields[name];
      if (Array.isArray(value))
        fields[name] = value.map((target) => (typeof target === "string" ? mapTarget(target) : target));
    }
    const targets = fields.targets;
    if (Array.isArray(targets))
      fields.targets = targets.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.target !== "string")
          return entry;
        return { ...entry, target: mapTarget(entry.target) };
      });
    if (fields.command === VEGA_CORE_AUDIO_CLIP) fields.clipId = key;
    if (fields.command === VEGA_COMMAND_GROUP_OPCODE) fields.commandGroup = mapGroup(fields.commandGroup, key);
    return fields;
  };
  const mapGroup = (value: JsonValue | undefined, parent: string): JsonObject => {
    const group = object(value) as JsonObject;
    const actions = group.actions as JsonObject[];
    return {
      ...group,
      waitForPrevious: false,
      waitForCompletion: true,
      actions: actions.map((action, index) => {
        const command = object(action.command) as JsonObject;
        const part = typeof command.commandId === "string" ? encodeURIComponent(command.commandId) : String(index);
        return { ...action, command: mapFields(command, `${parent}/${part}`) };
      }),
    };
  };
  return mapGroup(group, instanceKey);
}

function mixTimelineCommand(command: StoryProjectCommand, gain: number | undefined): JsonObject {
  const fields = command.fields;
  if (gain === undefined) return fields;
  if (command.command === VEGA_CORE_AUDIO_CLIP) return { ...fields, trackVolume: gain };
  const amplify = (value: JsonValue | undefined): JsonValue => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null;
    const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? value.volume : 1;
    return { ...value, volume: volume * gain };
  };
  if (command.command === VEGA_ADV_OPCODE.Bgm && fields.bgm) return { ...fields, bgm: amplify(fields.bgm) };
  if (command.command === VEGA_ADV_OPCODE.Se && fields.se) return { ...fields, se: amplify(fields.se) };
  if (
    (command.command === VEGA_ADV_OPCODE.Voice ||
      command.command === VEGA_ADV_OPCODE.Talk ||
      command.command === VEGA_ADV_OPCODE.ChatTalk) &&
    Array.isArray(fields.voices)
  )
    return { ...fields, voices: fields.voices.map(amplify) };
  return fields;
}
export function altairCommandTypeKey(type: AltairCommandType): string {
  return `${encodeURIComponent(nonempty(type.plugin, "Plugin id"))}:${encodeURIComponent(nonempty(type.name, "Command name"))}`;
}
export function parseAltairSceneDocument(value: unknown): AltairSceneDocument {
  const scene = object(typeof value === "string" ? parseAuthoredText(value) : value);
  if (scene.format !== ALTAIR_SCENE_FORMAT || scene.version !== 1) throw new TypeError("Unsupported scene format");
  nonempty(scene.id, "Scene id");
  nonempty(scene.name, "Scene name");
  if (!Array.isArray(scene.nodes)) throw new TypeError("Scene nodes must be an array");
  const ids = new Set<string>();
  const validate = (nodes: readonly unknown[], depth: number) => {
    if (depth > 64) throw new RangeError("Scene nesting exceeds 64 levels");
    for (const value of nodes) {
      const node = object(value);
      const id = nonempty(node.id, "Node id");
      if (ids.has(id)) throw new TypeError(`Duplicate node id: ${id}`);
      ids.add(id);
      const type = object(node.type);
      altairCommandTypeKey(type as unknown as AltairCommandType);
      if (!Number.isSafeInteger(node.schemaVersion) || Number(node.schemaVersion) < 1)
        throw new TypeError("Invalid command schema version");
      object(node.arguments);
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) throw new TypeError("Node children must be an array");
        validate(node.children, depth + 1);
      }
    }
  };
  validate(scene.nodes, 0);
  return cloneStoryValue(scene) as unknown as AltairSceneDocument;
}
export function parseAltairProjectDocument(value: unknown): AltairProjectDocument {
  const project = object(typeof value === "string" ? parseAuthoredText(value) : value);
  if (project.format !== ALTAIR_PROJECT_FORMAT || project.version !== 1)
    throw new TypeError("Unsupported project format");
  nonempty(project.id, "Project id");
  nonempty(project.title, "Project title");
  if (
    !Array.isArray(project.scenes) ||
    !Array.isArray(project.plugins) ||
    !Array.isArray(project.locales) ||
    project.locales.some((locale) => typeof locale !== "string")
  )
    throw new TypeError("Invalid project manifest");
  const localeIds = new Set<string>();
  for (const locale of project.locales as string[]) {
    let id: string;
    try {
      id = Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0]!;
    } catch {
      throw new TypeError(`Invalid project locale: ${locale}`);
    }
    if (!id || localeIds.has(id)) throw new TypeError(`Invalid or duplicate project locale: ${locale}`);
    localeIds.add(id);
  }
  const pluginIds = new Set<string>();
  for (const value of project.plugins) {
    const plugin = object(value),
      id = nonempty(plugin.id, "Plugin id");
    nonempty(plugin.version, "Plugin version");
    if (pluginIds.has(id)) throw new TypeError(`Duplicate plugin: ${id}`);
    pluginIds.add(id);
  }
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const item of project.scenes) {
    const scene = object(item),
      id = nonempty(scene.id, "Scene id"),
      path = nonempty(scene.path, "Scene path");
    if (
      path.startsWith("/") ||
      /^[a-z]:/iu.test(path) ||
      /[\u0000-\u001f]/u.test(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === ".." || part === ".") ||
      ids.has(id) ||
      paths.has(path)
    )
      throw new TypeError("Invalid or duplicate scene path/id");
    ids.add(id);
    paths.add(path);
  }
  const entry = object(project.entry);
  if (!ids.has(nonempty(entry.sceneId, "Entry scene"))) throw new TypeError("Entry scene is missing");
  object(project.assets);
  object(project.runtime);
  return cloneStoryValue(project) as unknown as AltairProjectDocument;
}
export const serializeAltairDocument = (value: AltairProjectDocument | AltairSceneDocument, source?: string): string =>
  serializeAuthoredText(
    value.format === ALTAIR_PROJECT_FORMAT ? parseAltairProjectDocument(value) : parseAltairSceneDocument(value),
    source,
  );

export class AltairDocumentRegistry {
  private readonly definitions = new Map<string, AltairDocumentCommand>();
  register(definition: AltairDocumentCommand): () => void {
    const key = altairCommandTypeKey(definition.type);
    if (this.definitions.has(key)) throw new Error(`Duplicate command definition: ${key}`);
    this.definitions.set(key, definition);
    return () => {
      if (this.definitions.get(key) === definition) this.definitions.delete(key);
    };
  }
  compile(workspace: AltairAuthoredWorkspace): StoryProject {
    return this.compileWorkspace(workspace, false);
  }
  /** Script projection retains unfinished nodes; executable builds use compile(). */
  compileDraft(workspace: AltairAuthoredWorkspace): StoryProject {
    return this.compileWorkspace(workspace, true);
  }
  private compileWorkspace(workspace: AltairAuthoredWorkspace, draft: boolean): StoryProject {
    const project = parseAltairProjectDocument(workspace.project),
      sceneById = new Map(workspace.scenes.map((scene) => [scene.id, parseAltairSceneDocument(scene)]));
    if (sceneById.size !== workspace.scenes.length) throw new Error("Duplicate scene document");
    const timing = createTimelineTimingContext({ project, scenes: [...sceneById.values()] });
    const activeReferences = new Set<AltairAuthoredNode>();
    const declaredPlugins = new Set(project.plugins.map((plugin) => plugin.id));
    const runtimePlugins = new Map(project.plugins.map((plugin) => [plugin.id, cloneStoryValue(plugin)]));
    const enabled = new Set(project.plugins.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id));
    const nodeKey = (sceneId: string, nodeId: string) =>
      `altair/${encodeURIComponent(sceneId)}/${encodeURIComponent(nodeId)}`;
    const targets = new Map<string, { sceneId: string; nodeId: string }>();
    const targetKey = (sceneId: string, nodeId: string) => {
      const token = `altair-target:${encodeURIComponent(sceneId)}:${encodeURIComponent(nodeId)}`;
      targets.set(token, { sceneId, nodeId });
      return token;
    };
    const lower = (
      node: AltairAuthoredNode,
      scene: AltairSceneDocument,
      renderOrder?: number,
    ): StoryProjectCommand[] => {
      try {
        return lowerNode(node, scene, renderOrder);
      } catch (error) {
        if (!draft) throw error;
        return [
          {
            id: node.id,
            command: "haneoka.altair-authoring:incomplete@1",
            fields: { key: nodeKey(scene.id, node.id) },
            extensions: {
              altairDraftError: error instanceof Error ? error.message : String(error),
              altairNode: { sceneId: scene.id, nodeId: node.id },
            },
          },
        ];
      }
    };
    const lowerNode = (
      node: AltairAuthoredNode,
      scene: AltairSceneDocument,
      renderOrder?: number,
    ): StoryProjectCommand[] => {
      if (node.disabled) return [];
      if (node.type.plugin === "haneoka.altair" && node.schemaVersion !== 1)
        throw new Error(`Unsupported core node schema: ${node.schemaVersion}`);
      if (isTimelineReference(node)) {
        const reference = resolveTimelineReference(node, timing);
        if (!reference) throw new Error(`Missing reusable timeline for ${node.id}`);
        if (activeReferences.has(reference.node)) throw new Error("Circular timeline reference");
        const bindings = node.arguments.bindings === undefined ? {} : (object(node.arguments.bindings) as JsonObject);
        for (const [name, value] of Object.entries(bindings)) nonempty(value, `Timeline binding ${name}`);
        const key = nodeKey(scene.id, node.id);
        const separator =
          typeof project.runtime.targetNameSplitKey === "string" && project.runtime.targetNameSplitKey
            ? project.runtime.targetNameSplitKey
            : "・";
        const instanceGroup = (instance: AltairAuthoredNode, instanceKey: string) => {
          activeReferences.add(reference.node);
          try {
            const definition = lowerNode(resolveTimelineInstance(instance, timing)!.node, reference.scene)[0]!;
            return bindTimelineInstance(definition.fields.commandGroup as JsonObject, instanceKey, bindings, separator);
          } finally {
            activeReferences.delete(reference.node);
          }
        };
        const channels = node.arguments.channels ?? "both";
        const withChannels = (channels: "audio" | "both") => ({ ...node, arguments: { ...node.arguments, channels } });
        let commandGroup: JsonObject;
        if (node.arguments.composition !== undefined && channels !== "audio") {
          const window = timelineInstanceWindow(node, timelineCueDuration(reference.node, timing));
          if (window.duration === 0) return [];
          const durationSeconds = window.duration;
          const appearance = object(node.arguments.composition) as JsonObject;
          const { start, end, rate, loop } = window;
          const placement = {
            ...appearance,
            durationSeconds,
            offsetSeconds: start + (loop ? (loop.offset % loop.period) * rate : 0),
            playbackRate: rate,
            ...(loop ? { sourceLoop: { start, end } } : {}),
            order: renderOrder ?? appearance.order ?? 0,
            compositeWithActors: true,
          };
          parseVegaStageComposition(placement);
          const {
            sourceInSeconds: _sourceIn,
            sourceOutSeconds: _sourceOut,
            playbackRate: _rate,
            loopDurationSeconds: _loopDuration,
            loopOffsetSeconds: _loopOffset,
            ...pictureArguments
          } = node.arguments;
          const pictureKey = `${key}/picture`;
          const audioKey = `${key}/audio`;
          const actions: JsonObject[] = [
            {
              atSeconds: 0,
              role: "lifetime",
              command: {
                ...placement,
                key: pictureKey,
                command: VEGA_CORE_COMPOSITION,
                commandGroup: instanceGroup(
                  { ...node, arguments: { ...pictureArguments, channels: "both" } },
                  pictureKey,
                ),
              },
            },
          ];
          if (channels === "both")
            actions.push({
              atSeconds: 0,
              role: "lifetime",
              command: {
                command: VEGA_COMMAND_GROUP_OPCODE,
                key: audioKey,
                commandGroup: instanceGroup(withChannels("audio"), audioKey),
              },
            });
          commandGroup = { durationSeconds, actions, waitForCompletion: true, cancelOnManualAdvance: false };
        } else commandGroup = instanceGroup(node, key);
        return [
          {
            id: node.id,
            command: VEGA_COMMAND_GROUP_OPCODE,
            fields: { key, commandGroup },
            extensions: { altairNode: { sceneId: scene.id, nodeId: node.id } },
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "propertyClip") {
        const fields = cloneStoryValue(node.arguments);
        nonempty(fields.target, "Property animation target");
        parsePropertyAnimationClip(fields.clip);
        return [
          {
            id: node.id,
            command: VEGA_CORE_PROPERTY_CLIP,
            fields: { ...fields, key: nodeKey(scene.id, node.id) },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "adjustment") {
        if (node.arguments.scope === "below") {
          const fields = { ...node.arguments, order: renderOrder ?? node.arguments.order ?? 0 };
          parseVegaBackdropAdjustment(fields);
          return [
            {
              id: node.id,
              command: VEGA_CORE_ADJUSTMENT,
              fields: { ...fields, key: nodeKey(scene.id, node.id) },
              extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
            },
          ];
        }
        const { maskSource, ...settings } = parseVegaStageAdjustment(node.arguments);
        return [
          {
            id: node.id,
            command: VEGA_CORE_ADJUSTMENT,
            fields: { ...settings, ...(maskSource ? { source: maskSource } : {}), key: nodeKey(scene.id, node.id) },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "mediaClip") {
        const { visualAnimation, gainAnimation, ...fields } = parseVegaStageMediaClip(node.arguments);
        return [
          {
            id: node.id,
            command: VEGA_CORE_MEDIA_CLIP,
            fields: {
              ...fields,
              ...(visualAnimation ? { visualAnimation: cloneStoryValue(node.arguments.visualAnimation!) } : {}),
              ...(gainAnimation ? { gainAnimation: cloneStoryValue(node.arguments.gainAnimation!) } : {}),
              key: nodeKey(scene.id, node.id),
              ...(typeof node.arguments.trackName === "string" ? { trackName: node.arguments.trackName } : {}),
            },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "audioClip") {
        const fields = cloneStoryValue(node.arguments);
        parseStageClipGainAnimation(fields.gainAnimation);
        nonempty(fields.source, "Audio source");
        nonempty(fields.trackName, "Audio track");
        if (!["Bgm", "Se", "Voice"].includes(String(fields.category))) throw new Error("Invalid audio category");
        if (fields.sourceKind !== undefined && fields.sourceKind !== "audio" && fields.sourceKind !== "video")
          throw new Error("Invalid audio source kind");
        for (const key of [
          "offsetSeconds",
          "durationSeconds",
          "playbackRate",
          "volume",
          "trackVolume",
          "fadeInSeconds",
          "fadeOutSeconds",
        ]) {
          const value = fields[key];
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            (["durationSeconds", "playbackRate"].includes(key) && value === 0) ||
            (key === "volume" && value > MAX_STAGE_CLIP_VOLUME) ||
            (key === "trackVolume" && value > 1)
          )
            throw new Error(`Invalid audio field: ${key}`);
        }
        return [
          {
            id: node.id,
            command: VEGA_CORE_AUDIO_CLIP,
            fields: { ...fields, clipId: node.id, key: nodeKey(scene.id, node.id) },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "timeline") {
        const { tracks: _tracks, ...settings } = node.arguments;
        const cues = resolveTimelineCues(node, timing);
        const order = new Map<string, number>();
        if (Array.isArray(settings.lanes))
          for (const lane of settings.lanes) {
            if (lane && typeof lane === "object" && !Array.isArray(lane) && typeof lane.id === "string")
              order.set(`lane:${lane.id}`, order.size);
          }
        for (const cue of cues) if (!order.has(cue.trackId)) order.set(cue.trackId, order.size);
        const lowered = cues.map((cue) => ({
          cue,
          id: typeof cue.track.cueId === "string" ? cue.track.cueId : cue.node.id,
          commands: lower(timelinePlaybackNode(cue), scene, order.size - order.get(cue.trackId)!),
        }));
        const byNode = new Map(lowered.map((item) => [item.cue.node.id, item]));
        const available = new Set(lowered.filter((item) => item.commands.length).map((item) => item.id));
        const activeAnchor = (anchor: TimelineAnchor | undefined): TimelineAnchor | undefined => {
          if (!anchor) return;
          const target = byNode.get(anchor.nodeId);
          const id = target?.id ?? anchor.nodeId;
          if (available.has(id)) return { ...anchor, nodeId: id };
          const previous = activeAnchor(target?.cue.anchor);
          return previous ? { ...previous, offsetSeconds: previous.offsetSeconds + anchor.offsetSeconds } : undefined;
        };
        const anchors = lowered.map(({ cue }) => activeAnchor(cue.anchor));
        const referenced = new Set(anchors.flatMap((anchor) => (anchor ? [anchor.nodeId] : [])));
        const endReferences = new Set(anchors.flatMap((anchor) => (anchor?.point === "end" ? [anchor.nodeId] : [])));
        const composeActors = lowered.some(
          ({ cue, commands }) =>
            !cue.playbackMuted &&
            ((isTimelineReference(cue.node) &&
              cue.node.arguments.composition !== undefined &&
              cue.node.arguments.channels !== "audio") ||
              commands.some(
                (command) =>
                  (command.command === VEGA_CORE_MEDIA_CLIP && command.fields.compositeWithActors === true) ||
                  (command.command === VEGA_CORE_ADJUSTMENT && command.fields.scope === "below"),
              )),
        );
        const actions = lowered.flatMap(({ cue, id, commands }, index) => {
          const {
            nodeId: _,
            anchor: _anchor,
            cueId: _cueId,
            minimumEndSeconds: _minimumEnd,
            suppressed: _suppressed,
            instanceGain: _instanceGain,
            ...timing
          } = cue.track;
          const anchor = anchors[index];
          return commands.map((command) => {
            if (typeof command.command === "number" && serialFlowCommands.has(command.command))
              throw new Error(`Branching command ${cue.node.type.name} must run at a scene command boundary`);
            const fields =
              command.command === VEGA_CORE_MEDIA_CLIP
                ? {
                    ...command.fields,
                    order: order.size - order.get(cue.trackId)!,
                    ...(cue.playbackAudioMuted ? { audioEnabled: false } : {}),
                    ...(cue.trackGain !== undefined ? { volume: Number(command.fields.volume) * cue.trackGain } : {}),
                  }
                : {
                    ...mixTimelineCommand(command, cue.trackGain),
                    ...(cue.playbackAudioMuted && !cue.playbackMuted ? { timelineAudioMuted: true } : {}),
                    ...(command.command === VEGA_ADV_OPCODE.CameraShake
                      ? { timelineShakeSeed: command.fields.timelineShakeSeed ?? cue.node.id }
                      : {}),
                    ...(command.command === VEGA_ADV_OPCODE.In &&
                    (cue.node.arguments.timelineCompositionFromTrack === true ||
                      (composeActors && command.fields.characterRenderOrder === undefined))
                      ? { characterRenderOrder: order.get(cue.trackId)! - order.size }
                      : {}),
                  };
            return {
              ...timing,
              atSeconds: cue.atSeconds,
              ...(cue.playbackMuted ? { suppressed: true } : {}),
              ...((cue.playbackMuted || (endReferences.has(id) && nativeTimelineCueDispatchesImmediately(cue.node))) &&
              cue.durationSeconds > 0
                ? { minimumEndSeconds: cue.durationSeconds }
                : {}),
              ...(anchor || referenced.has(id) || typeof cue.track.cueId === "string" ? { cueId: id } : {}),
              ...(anchor ? { anchor: { ...anchor } } : {}),
              command: { ...fields, command: command.command, commandId: command.id },
            };
          });
        });
        return [
          {
            id: node.id,
            command: VEGA_COMMAND_GROUP_OPCODE,
            fields: {
              ...((node.extensions?.fields as JsonObject) ?? {}),
              key: nodeKey(scene.id, node.id),
              commandGroup: { ...settings, actions: actions as JsonObject[] },
            },
            extensions: (node.extensions?.commandExtensions as JsonObject) ?? {},
          },
        ];
      }
      if (node.type.plugin === "haneoka.altair" && node.type.name === "sequence")
        return (node.children ?? []).flatMap((child) => lower(child, scene));
      if (node.type.plugin === "haneoka.altair" && node.type.name === "note") return [];
      if (node.type.plugin === "haneoka.altair") {
        const control = (
          {
            jump: VEGA_SYSTEM_OPCODE.JumpScene,
            call: VEGA_SYSTEM_OPCODE.CallScene,
            return: VEGA_SYSTEM_OPCODE.ReturnScene,
            end: VEGA_SYSTEM_OPCODE.End,
            branch: VEGA_SYSTEM_OPCODE.Branch,
            setVariable: VEGA_SYSTEM_OPCODE.SetVariable,
            input: VEGA_SYSTEM_OPCODE.Input,
            unlock: VEGA_SYSTEM_OPCODE.Unlock,
            dialogue: VEGA_SYSTEM_OPCODE.SetDialogueVisibility,
          } as Record<string, number>
        )[node.type.name];
        if (control !== undefined) {
          const fields = cloneStoryValue(node.arguments);
          if (node.type.name === "jump" || node.type.name === "call") {
            const target = object(fields.target),
              sceneId = nonempty(target.sceneId, "Target scene");
            if (!sceneById.has(sceneId)) throw new Error(`Target scene is missing: ${sceneId}`);
            if (target.nodeId !== undefined) {
              const nodeId = nonempty(target.nodeId, "Target node"),
                targetScene = sceneById.get(sceneId)!;
              if (!targetScene.nodes.some((node) => node.id === nodeId && !node.disabled))
                throw new Error(`Target node is missing: ${sceneId}/${nodeId}`);
              fields.targetKey = targetKey(sceneId, nodeId);
            }
            delete fields.target;
            fields.sceneId = sceneId;
          }
          if (node.type.name === "branch")
            for (const [argument, prefix] of [
              ["then", "then"],
              ["else", "else"],
            ] as const) {
              const value = fields[argument];
              if (value === undefined) continue;
              const target = object(value),
                sceneId = nonempty(target.sceneId, "Branch scene");
              if (!sceneById.has(sceneId)) throw new Error(`Branch scene is missing: ${sceneId}`);
              if (target.nodeId !== undefined)
                fields[`${prefix}Key`] = targetKey(sceneId, nonempty(target.nodeId, "Branch node"));
              else fields[`${prefix}Scene`] = sceneId;
              delete fields[argument];
            }
          return [
            {
              id: node.id,
              command: control,
              fields: { ...fields, key: nodeKey(scene.id, node.id) },
              extensions: {
                altairNode: { sceneId: scene.id, nodeId: node.id },
              },
            },
          ];
        }
      }
      const key = altairCommandTypeKey(node.type),
        definition = this.definitions.get(key);
      if (!definition || !enabled.has(node.type.plugin)) throw new Error(`Command provider is unavailable: ${key}`);
      const migrated = node.schemaVersion === definition.schemaVersion ? node : definition.migrate?.(node);
      if (
        !migrated ||
        migrated.schemaVersion !== definition.schemaVersion ||
        migrated.id !== node.id ||
        altairCommandTypeKey(migrated.type) !== key
      )
        throw new Error(`Unsupported command schema: ${key}@${node.schemaVersion}`);
      for (const requirement of definition.runtimePlugins ?? []) {
        const existing = runtimePlugins.get(requirement.id);
        if (existing?.enabled === false)
          throw new Error(`Command ${key} requires disabled runtime plugin ${requirement.id}`);
        if (existing && existing.version !== requirement.version)
          throw new Error(
            `Command ${key} requires ${requirement.id}@${requirement.version}, but the project selects ${existing.version}`,
          );
        runtimePlugins.set(requirement.id, {
          ...cloneStoryValue(requirement),
          ...existing,
          required: true,
          ...(!declaredPlugins.has(requirement.id)
            ? { permissions: [...new Set([...(existing?.permissions ?? []), ...(requirement.permissions ?? [])])] }
            : {}),
        });
      }
      const timelineAsset =
        migrated.type.plugin === "haneoka.altair-adv" && migrated.type.name === "Timeline"
          ? nativeTimelineAsset(migrated, timing)
          : undefined;
      return definition.lower(migrated, { project, scene }).map((command, index) => ({
        ...command,
        fields: {
          ...command.fields,
          ...(timelineAsset && command.command === VEGA_ADV_OPCODE.Timeline
            ? { timeline: timelineAssetWithShakeSeeds(timelineAsset, node.id) }
            : {}),
          ...(command.fields.key === undefined
            ? {
                key: nodeKey(scene.id, node.id) + (index === 0 ? "" : `/${index}`),
              }
            : {}),
        },
        id: index === 0 ? node.id : `${node.id}/${index}`,
        extensions: {
          ...command.extensions,
          altairNode: {
            sceneId: scene.id,
            nodeId: node.id,
            type: key,
            schemaVersion: node.schemaVersion,
          },
        },
      }));
    };
    const compiled: StoryProject = {
      version: 2,
      meta: {
        ...(project.extensions?.storyMeta &&
        typeof project.extensions.storyMeta === "object" &&
        !Array.isArray(project.extensions.storyMeta)
          ? cloneStoryValue(project.extensions.storyMeta)
          : {}),
        title: project.title,
        ...(project.locales[0] ? { locale: project.locales[0] } : {}),
      },
      entrySceneId: project.entry.sceneId,
      scenes: project.scenes.map((reference) => {
        const scene = sceneById.get(reference.id);
        if (!scene) throw new Error(`Scene is missing: ${reference.id}`);
        return {
          id: scene.id,
          name: scene.name,
          commands: scene.nodes.flatMap((node) =>
            node.type.plugin === "haneoka.altair" &&
            node.type.name === "timeline" &&
            node.arguments.libraryOnly === true
              ? []
              : lower(node, scene),
          ),
          extensions: cloneStoryValue(scene.extensions ?? {}),
        };
      }),
      plugins: [...runtimePlugins.values()],
      assets: cloneStoryValue(project.assets),
      runtime: cloneStoryValue(project.runtime),
      storyFields: cloneStoryValue((project.extensions?.storyFields as JsonObject) ?? {}),
      extensions: {
        ...cloneStoryValue(project.extensions ?? {}),
        altairProjectId: project.id,
        altairProjectLocales: [...project.locales],
      },
    };
    const resolveTarget = (value: string): string => {
      const reference = targets.get(value);
      if (!reference) return value;
      const command = compiled.scenes
        .find((scene) => scene.id === reference.sceneId)
        ?.commands.find((command) => command.id === reference.nodeId);
      if (draft && (!command || typeof command.fields.key !== "string")) return value;
      if (!command || typeof command.fields.key !== "string")
        throw new Error(`Target node is not executable: ${reference.sceneId}/${reference.nodeId}`);
      return `vega:command:${encodeURIComponent(reference.sceneId)}:${encodeURIComponent(command.fields.key)}`;
    };
    for (const scene of compiled.scenes)
      for (const command of scene.commands)
        for (const field of ["targetKey", "thenKey", "elseKey"]) {
          const value = command.fields[field];
          if (typeof value === "string") command.fields[field] = resolveTarget(value);
        }
    if (project.entry.nodeId) {
      const key = resolveTarget(targetKey(project.entry.sceneId, project.entry.nodeId));
      const scene = compiled.scenes.find((scene) => scene.id === project.entry.sceneId)!;
      scene.commands.unshift({
        id: `${project.id}/entry`,
        command: VEGA_SYSTEM_OPCODE.Branch,
        fields: { condition: "true", thenKey: key },
        extensions: {},
      });
    }
    return compiled;
  }
}
