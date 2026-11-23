import { parseAltairProjectDocument, type AltairAuthoredNode, type JsonObject, type JsonValue } from "@haneoka/altair";
import { isAudioFile } from "../AudioClipWaveform";
import { tr } from "../i18n";
import type { ProjectFile } from "../library";
import { readLocalizedText } from "../localized-text";
import { nativeCommands, nativeScenePath } from "../native-project";
import type { EditorSession } from "../session";
import { COMMAND_LIBRARY_PATH } from "../command-library";

export type ProjectMediaCategory = "background" | "character" | "image" | "video" | "audio" | "effect";
export type ProjectMediaFilter = "all" | ProjectMediaCategory;
export type ProjectMediaInsertKind =
  | "background"
  | "character"
  | "imageClip"
  | "videoClip"
  | "still"
  | "frame"
  | "audioClip"
  | "bgm"
  | "se"
  | "voice"
  | "effect"
  | "postEffect"
  | "adjustment"
  | "mask"
  | "fadeIn"
  | "fadeOut"
  | "flash"
  | "shake";

export type MediaInsertOverride = "background" | "imageClip" | "bgm" | "se" | "audioClip";

export interface ProjectMediaItem {
  readonly id: string;
  readonly category: ProjectMediaCategory;
  readonly label: string;
  readonly subtitle: string;
  readonly path?: string;
  readonly resourceRef?: string;
  readonly thumbUrl?: string;
  readonly mediaKind?: "image" | "video" | "audio";
  readonly audioRole?: "Bgm" | "Se" | "Voice";
  readonly insertKind: ProjectMediaInsertKind;
  readonly file?: ProjectFile;
  readonly builtin?: boolean;
}

const IMAGE_RE = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/iu;
const VIDEO_RE = /\.(?:mp4|webm|mov|m4v|ogv)$/iu;
const BACKGROUND_PATH_RE = /(?:^|\/)(?:bg|background|backgrounds|stage|stages)\//iu;
const NON_MEDIA_TEXT_RE = /^(?:project\.ya?ml|command-library\.ya?ml)$/iu;

const asObject = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;

const isImageFile = (file: ProjectFile) => file.blob.type.startsWith("image/") || IMAGE_RE.test(file.path);
const isVideoFile = (file: ProjectFile) => file.blob.type.startsWith("video/") || VIDEO_RE.test(file.path);
const isSoundFile = (file: ProjectFile) => file.blob.type.startsWith("audio/") || isAudioFile(file.path);

function inferAudioRole(pathOrKey: string): "Bgm" | "Se" | "Voice" {
  if (/(?:^|[/._-])(?:bgm|music|ost)(?:$|[/._-])/iu.test(pathOrKey)) return "Bgm";
  if (/(?:^|[/._-])(?:voice|vocal|vo|speech)(?:$|[/._-])/iu.test(pathOrKey)) return "Voice";
  return "Se";
}

function collectEntryStrings(value: JsonValue | undefined, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEntryStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectEntryStrings(item, out);
  }
}

function fileDirectoryPrefix(path: string): string | undefined {
  const normalized = path.replace(/^\/+/u, "");
  const membersIndex = normalized.indexOf("/members/");
  if (membersIndex > 0) return `${normalized.slice(0, membersIndex + 1)}`;
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash + 1) : undefined;
}

function collectionEntries(collection: JsonValue | undefined): Array<[string, JsonObject]> {
  if (!collection) return [];
  if (Array.isArray(collection)) {
    return collection.flatMap((entry, index) => {
      const obj = asObject(entry);
      return obj ? [[String(obj.id ?? obj.resourceRef ?? index), obj] as [string, JsonObject]] : [];
    });
  }
  const obj = asObject(collection);
  if (!obj) return [];
  return Object.entries(obj).flatMap(([key, value]) => {
    const item = asObject(value);
    return item ? [[key, item] as [string, JsonObject]] : [];
  });
}

function findMatchingPath(entry: JsonObject, filesByPath: ReadonlyMap<string, ProjectFile>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = entry[key];
    if (typeof candidate === "string" && filesByPath.has(candidate)) return candidate;
  }
  const runtime = asObject(entry.runtime);
  if (runtime) {
    for (const key of keys) {
      const candidate = runtime[key];
      if (typeof candidate === "string" && filesByPath.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export function collectProjectMedia(
  session: EditorSession,
  files: readonly ProjectFile[],
  manifestText: string,
  locale: string,
): ProjectMediaItem[] {
  const items: ProjectMediaItem[] = [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const claimedPaths = new Set<string>();
  const modelDirectories = new Set<string>();

  if (manifestText.trim()) {
    try {
      const project = parseAltairProjectDocument(manifestText);
      const ledger = Array.isArray(project.extensions?.publicAssetImports) ? project.extensions.publicAssetImports : [];
      for (const entry of ledger) {
        const record = asObject(entry);
        if (!record) continue;
        const kind = String(record.kind ?? "");
        const dir = typeof record.directory === "string" ? record.directory.replace(/\/+$/u, "") : "";
        if (dir && (kind === "model" || kind === "spine" || kind === "live2d")) modelDirectories.add(`${dir}/`);
      }

      const specs: Array<{
        collection: JsonValue | undefined;
        category: ProjectMediaCategory;
        insertKind: ProjectMediaInsertKind;
        subtitle: string;
        mediaKind?: "image" | "video" | "audio";
        isModel?: boolean;
      }> = [
        { collection: project.assets.backgrounds, category: "background", insertKind: "background", subtitle: tr("Background"), mediaKind: "image" },
        { collection: project.assets.stages, category: "background", insertKind: "background", subtitle: tr("Stage"), mediaKind: "image" },
        { collection: project.assets.live2d, category: "character", insertKind: "character", subtitle: tr("Character model"), isModel: true },
        { collection: project.assets.models, category: "character", insertKind: "character", subtitle: tr("Character model"), isModel: true },
        { collection: project.assets.characters, category: "character", insertKind: "character", subtitle: tr("Character"), isModel: true },
        { collection: project.assets.stills, category: "image", insertKind: "still", subtitle: tr("Still"), mediaKind: "image" },
        { collection: project.assets.frames, category: "image", insertKind: "frame", subtitle: tr("Frame"), mediaKind: "image" },
        { collection: project.assets.videos, category: "video", insertKind: "videoClip", subtitle: tr("Video"), mediaKind: "video" },
        { collection: project.assets.sounds, category: "audio", insertKind: "audioClip", subtitle: tr("Audio"), mediaKind: "audio" },
        { collection: project.assets.audios, category: "audio", insertKind: "audioClip", subtitle: tr("Audio"), mediaKind: "audio" },
        { collection: project.assets.effects, category: "effect", insertKind: "effect", subtitle: tr("command.Effect") },
        { collection: project.runtime.postEffects as JsonValue | undefined, category: "effect", insertKind: "postEffect", subtitle: tr("command.PostEffect") },
      ];

      for (const spec of specs) {
        for (const [key, asset] of collectionEntries(spec.collection)) {
          const ref = String(asset.resourceRef ?? asset.live2dKey ?? asset.assetName ?? asset.id ?? key).trim();
          if (!ref) continue;
          const localizedName = readLocalizedText(asset.name ?? asset.label ?? asset.title, locale).trim();

          const primaryPath = findMatchingPath(asset, filesByPath, [
            "path",
            "file",
            "source",
            "playableUrl",
            "url",
            "image",
            "imageUrl",
            "sound",
            "model",
            "modelUrl",
            "moc",
            "mocUrl",
            "skeleton",
            "skeletonUrl",
          ]);
          const thumbPath = findMatchingPath(asset, filesByPath, [
            "thumbnailImage",
            "thumbnail",
            "faceImage",
            "image",
            "imageUrl",
            "url",
            "file",
            "path",
          ]);
          const file = primaryPath ? filesByPath.get(primaryPath) : undefined;
          const label = localizedName || String(asset.assetName ?? primaryPath ?? ref).split(/[/:]/u).at(-1) || ref;
          const allStrings: string[] = [];
          collectEntryStrings(asset, allStrings);
          for (const str of allStrings) {
            if (filesByPath.has(str)) {
              claimedPaths.add(str);
              if (spec.isModel) {
                const prefix = fileDirectoryPrefix(str);
                if (prefix) modelDirectories.add(prefix);
              }
            }
          }
          if (primaryPath) claimedPaths.add(primaryPath);

          const audioRole = spec.category === "audio" ? inferAudioRole(`${ref} ${primaryPath ?? ""} ${label}`) : undefined;
          const thumbUrl = thumbPath && filesByPath.get(thumbPath) && isImageFile(filesByPath.get(thumbPath)!)
            ? session.url(thumbPath)
            : undefined;

          items.push({
            id: `manifest:${spec.insertKind}:${ref}`,
            category: spec.category,
            label,
            subtitle: spec.subtitle,
            ...(primaryPath ? { path: primaryPath } : {}),
            resourceRef: ref,
            ...(thumbUrl ? { thumbUrl } : {}),
            ...(spec.mediaKind ? { mediaKind: spec.mediaKind } : {}),
            ...(audioRole ? { audioRole } : {}),
            insertKind: spec.insertKind,
            ...(file ? { file } : {}),
          });
        }
      }
    } catch {
      // Incomplete manifest remains tolerated; file-based project media still lists cleanly.
    }
  }

  for (const file of files) {
    if (
      NON_MEDIA_TEXT_RE.test(file.path) ||
      file.path === COMMAND_LIBRARY_PATH ||
      nativeScenePath(file.path) ||
      claimedPaths.has(file.path)
    ) {
      continue;
    }
    let inModelDir = false;
    for (const prefix of modelDirectories) {
      if (file.path.startsWith(prefix)) {
        inModelDir = true;
        break;
      }
    }
    if (inModelDir) continue;

    const filename = file.path.split("/").at(-1) || file.path;
    if (isImageFile(file)) {
      const category: ProjectMediaCategory = BACKGROUND_PATH_RE.test(file.path) ? "background" : "image";
      items.push({
        id: `file:${file.path}`,
        category,
        label: filename,
        subtitle: file.path,
        path: file.path,
        thumbUrl: session.url(file.path),
        mediaKind: "image",
        insertKind: "imageClip",
        file,
      });
    } else if (isVideoFile(file)) {
      items.push({
        id: `file:${file.path}`,
        category: "video",
        label: filename,
        subtitle: file.path,
        path: file.path,
        mediaKind: "video",
        insertKind: "videoClip",
        file,
      });
    } else if (isSoundFile(file)) {
      const audioRole = inferAudioRole(file.path);
      items.push({
        id: `file:${file.path}`,
        category: "audio",
        label: filename,
        subtitle: file.path,
        path: file.path,
        mediaKind: "audio",
        audioRole,
        insertKind: "audioClip",
        file,
      });
    }
  }

  const builtins: readonly ProjectMediaItem[] = [
    {
      id: "builtin:adjustment",
      category: "effect",
      label: tr("Adjustment layer"),
      subtitle: tr("All tracks below"),
      insertKind: "adjustment",
      builtin: true,
    },
    {
      id: "builtin:mask",
      category: "effect",
      label: tr("Layer mask"),
      subtitle: tr("Ellipse"),
      insertKind: "mask",
      builtin: true,
    },
    {
      id: "builtin:FadeIn",
      category: "effect",
      label: tr("command.FadeIn"),
      subtitle: tr("Transitions"),
      insertKind: "fadeIn",
      builtin: true,
    },
    {
      id: "builtin:FadeOut",
      category: "effect",
      label: tr("command.FadeOut"),
      subtitle: tr("Transitions"),
      insertKind: "fadeOut",
      builtin: true,
    },
    {
      id: "builtin:Flash",
      category: "effect",
      label: tr("command.Flash"),
      subtitle: tr("Effects"),
      insertKind: "flash",
      builtin: true,
    },
    {
      id: "builtin:Shake",
      category: "effect",
      label: tr("command.Shake"),
      subtitle: tr("Effects"),
      insertKind: "shake",
      builtin: true,
    },
  ];
  items.push(...builtins);

  return items;
}

function initialAdvNode(name: string, patch: JsonObject = {}): AltairAuthoredNode {
  const command = nativeCommands.find((entry) => entry.name === name);
  if (command) {
    const node = command.initial();
    return {
      ...node,
      id: crypto.randomUUID(),
      arguments: { ...node.arguments, ...patch },
    };
  }
  return {
    id: crypto.randomUUID(),
    type: { plugin: "haneoka.altair-adv", name },
    schemaVersion: 1,
    arguments: patch,
  };
}

export function buildMediaAuthoredNode(item: ProjectMediaItem, override?: MediaInsertOverride): AltairAuthoredNode {
  const ref = item.resourceRef ?? item.path ?? "";
  const sourcePath = item.path ?? item.resourceRef ?? "";

  if (override === "background") {
    if (item.resourceRef && item.insertKind === "background") {
      return initialAdvNode("Stage", { backgroundRef: item.resourceRef });
    }
    return {
      id: crypto.randomUUID(),
      type: { plugin: "haneoka.altair", name: "mediaClip" },
      schemaVersion: 1,
      arguments: {
        source: sourcePath,
        mediaKind: "image",
        durationSeconds: 5,
        offsetSeconds: 0,
        playbackRate: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        opacity: 1,
        fit: "cover",
        audioEnabled: true,
        volume: 1,
      },
    };
  }

  if (override === "imageClip") {
    return {
      id: crypto.randomUUID(),
      type: { plugin: "haneoka.altair", name: "mediaClip" },
      schemaVersion: 1,
      arguments: {
        source: sourcePath,
        mediaKind: "image",
        durationSeconds: 5,
        offsetSeconds: 0,
        playbackRate: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        opacity: 1,
        fit: "contain",
        audioEnabled: true,
        volume: 1,
      },
    };
  }

  if (override === "bgm" || override === "se" || override === "audioClip") {
    const category = override === "bgm" ? "Bgm" : override === "se" ? "Se" : (item.audioRole ?? "Se");
    if (!item.path && item.resourceRef) {
      return initialAdvNode(category === "Bgm" ? "Bgm" : "Se", category === "Bgm" ? { bgmRef: item.resourceRef } : { seRef: item.resourceRef });
    }
    return {
      id: crypto.randomUUID(),
      type: { plugin: "haneoka.altair", name: "audioClip" },
      schemaVersion: 1,
      arguments: {
        source: sourcePath,
        trackName: tr("Audio track"),
        category,
        offsetSeconds: 0,
        durationSeconds: 5,
        playbackRate: 1,
        volume: 1,
        trackVolume: 1,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loop: category === "Bgm",
        muted: false,
      },
    };
  }

  switch (item.insertKind) {
    case "background":
      return item.resourceRef
        ? initialAdvNode("Stage", { backgroundRef: item.resourceRef })
        : buildMediaAuthoredNode(item, "background");
    case "character":
      return initialAdvNode("Character", {
        live2dKey: ref,
        targetName: item.label || ref,
      });
    case "still":
      return item.resourceRef
        ? initialAdvNode("Still", { stillRef: item.resourceRef })
        : buildMediaAuthoredNode(item, "imageClip");
    case "frame":
      return item.resourceRef
        ? initialAdvNode("Frame", { frameRef: item.resourceRef })
        : buildMediaAuthoredNode(item, "imageClip");
    case "imageClip":
    case "videoClip":
      if (!item.path && item.resourceRef && item.insertKind === "videoClip") {
        return initialAdvNode("Movie", { videoRef: item.resourceRef });
      }
      return {
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name: "mediaClip" },
        schemaVersion: 1,
        arguments: {
          source: sourcePath,
          mediaKind: item.mediaKind === "video" || item.insertKind === "videoClip" ? "video" : "image",
          durationSeconds: 5,
          offsetSeconds: 0,
          playbackRate: 1,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
          fit: item.category === "background" ? "cover" : "contain",
          audioEnabled: true,
          volume: 1,
        },
      };
    case "audioClip":
      return buildMediaAuthoredNode(item, "audioClip");
    case "bgm":
      return initialAdvNode("Bgm", { bgmRef: ref });
    case "se":
      return initialAdvNode("Se", { seRef: ref });
    case "voice":
      return initialAdvNode("Voice", { voiceRefs: [ref] });
    case "effect":
      return initialAdvNode("Effect", { effectRef: ref });
    case "postEffect":
      return initialAdvNode("PostEffect", { postEffectRef: ref });
    case "adjustment":
    case "mask":
      return {
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name: "adjustment" },
        schemaVersion: 1,
        arguments: {
          durationSeconds: 2,
          target: "stage-main",
          x: 0.5,
          y: 0.5,
          width: 1,
          height: 1,
          feather: 0,
          rotationDegrees: 0,
          cornerRadius: 0,
          invert: false,
          exposure: 0,
          contrast: 1,
          saturation: 1,
          opacity: 1,
          mode: item.insertKind === "mask" ? "mask" : "adjustment",
          shape: item.insertKind === "mask" ? "ellipse" : "full",
          ...(item.insertKind === "adjustment" ? { scope: "below" } : {}),
        },
      };
    case "fadeIn":
      return initialAdvNode("FadeIn");
    case "fadeOut":
      return initialAdvNode("FadeOut");
    case "flash":
      return initialAdvNode("Flash");
    case "shake":
      return initialAdvNode("Shake");
  }
}

const REFERENCE_KEYS = [
  "source",
  "backgroundRef",
  "stillRef",
  "frameRef",
  "videoRef",
  "bgmRef",
  "seRef",
  "live2dKey",
  "effectRef",
  "postEffectRef",
  "maskSource",
] as const;

export function selectedNodeReferencedAssets(node: AltairAuthoredNode | undefined): ReadonlySet<string> {
  const refs = new Set<string>();
  const visit = (entry: AltairAuthoredNode | undefined) => {
    if (!entry) return;
    for (const key of REFERENCE_KEYS) {
      const value = entry.arguments[key];
      if (typeof value === "string" && value.trim()) refs.add(value.trim());
    }
    const voices = entry.arguments.voiceRefs;
    if (Array.isArray(voices)) {
      for (const value of voices) {
        if (typeof value === "string" && value.trim()) refs.add(value.trim());
      }
    }
    entry.children?.forEach(visit);
  };
  visit(node);
  return refs;
}

export function uniqueMediaImportPath(file: File, existingFiles: readonly ProjectFile[]): string {
  const rawName = (file.name || "media").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").replace(/^[. ]+|[. ]+$/gu, "");
  const cleanName = rawName || "media";
  const folder =
    file.type.startsWith("image/") || IMAGE_RE.test(cleanName)
      ? "assets/images"
      : file.type.startsWith("video/") || VIDEO_RE.test(cleanName)
        ? "assets/video"
        : file.type.startsWith("audio/") || isAudioFile(cleanName)
          ? "assets/audio"
          : "assets/media";

  const existing = new Set(existingFiles.map((entry) => entry.path));
  let candidate = `${folder}/${cleanName}`;
  if (!existing.has(candidate)) return candidate;

  const dot = cleanName.lastIndexOf(".");
  const stem = dot > 0 ? cleanName.slice(0, dot) : cleanName;
  const ext = dot > 0 ? cleanName.slice(dot) : "";
  let suffix = 2;
  while (existing.has(`${folder}/${stem}_${suffix}${ext}`)) suffix++;
  candidate = `${folder}/${stem}_${suffix}${ext}`;
  return candidate;
}

export function formatMediaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
