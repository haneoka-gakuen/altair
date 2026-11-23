import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DockPanel, TimelineInspectorHost, TimelineToolbarHost, TimelineWorkspaceContext } from "./authoring/DockPanel";
import { presentationTargets } from "@haneoka/altair-plugin-vega-preview/projection";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createTimelineTimingContext,
  cloneAltairNodeGroup,
  isTimelineReference,
  listReusableTimelines,
  resolveTimelineReference,
  timelineCueDuration,
  timelineInstanceWindow,
  timelineSubRip,
} from "@haneoka/altair/documents";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Plus,
  Import,
  Layers,
  Maximize,
  Settings2,
  Star,
  NumberInput,
  StructuredTextInput,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "@haneoka/altair-ui-react";
import { DataSet } from "vis-data";
import { Timeline, type DataItem, type TimelineOptions } from "vis-timeline/peer";
import "./timeline-vendor.css";
import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  serializeAuthoredText,
  type AltairAuthoredNode,
  type JsonObject,
  type JsonValue,
} from "@haneoka/altair";
import { CommandDataFields, NativeInspector } from "./NativeInspector";
import { decodeStoryVideoAudio } from "@haneoka/vega/audio";
import { MAX_STAGE_CLIP_VOLUME } from "@haneoka/vega-protocol";
import {
  ClipGainFields,
  MediaAppearanceFields,
  MediaPlacementFields,
  TimelineCompositionFields,
} from "./MediaAppearanceFields";
import { AudioMixExport, isAudioClip, isMediaClip } from "./AudioMixExport";
import { audioWaveformPath } from "./audio-waveform";
import { isAudioFile } from "./AudioClipWaveform";
import type { ProjectFile } from "./library";
import {
  NATIVE_PROJECT_PATH,
  nativeCommands,
  nativeStatementIsVisible,
  nativeNodeExcerpt,
  nativeNodeLabel,
  nativeStatements,
  readNativeWorkspace,
  type EditorStatement,
} from "./native-project";
import type { EditorSession } from "./session";
import {
  addTimelineLane,
  cueLane,
  closeCueGap,
  gapBeforeCue,
  rippleDeleteCue,
  appendTimelineCue,
  assignCueLane,
  clearCueDurationOverride,
  createTimeline,
  durationField,
  importTimelineScript,
  inferredSceneTimeline,
  sceneTrackCues,
  isTimeline,
  linkTimelineCue,
  moveTimelineLane,
  removeCue,
  removeTimelineLane,
  renameTimelineLane,
  timelineCues,
  timelineLanes,
  timelineTrackState,
  setTimelineTrackState,
  splitTimelineMediaAudio,
  linkTimelineMediaAudio,
  updateCue,
  updateTimelineInstance,
  type TimelineCue,
  type TimelineTimingContext,
} from "./timeline-model";
import { tr, useStudioI18n } from "./i18n";
import { downloadStudioFile } from "./studio-host";

type TimelineSource = ReturnType<typeof listReusableTimelines>[number];
const sourceKey = (source: { sceneId: string; nodeId: string }) => JSON.stringify([source.sceneId, source.nodeId]);
const referenceKey = (node: AltairAuthoredNode) => {
  const source = node.arguments.timeline;
  return source && typeof source === "object" && !Array.isArray(source)
    ? JSON.stringify([source.sceneId, source.nodeId])
    : "";
};
const sourceName = (source: TimelineSource) => source.sceneName + " / " + source.name;
const isAdjustment = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "adjustment";
const adjustmentDefaults = {
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
};
const adjustmentFields = [
  { key: "x", label: "Center X", max: 1, percent: true, region: true },
  { key: "y", label: "Center Y", max: 1, percent: true, region: true },
  { key: "width", label: "Region width", min: 0.001, max: 1, percent: true, region: true },
  { key: "height", label: "Region height", min: 0.001, max: 1, percent: true, region: true },
  { key: "feather", label: "Edge feather", max: 1, percent: true, region: true },
  { key: "rotationDegrees", label: "Mask rotation (°)", min: -360, max: 360, region: true },
  { key: "cornerRadius", label: "Corner radius", max: 1, percent: true, rectangle: true },
  { key: "exposure", label: "Exposure (EV)", max: 4, min: -4, color: true },
  { key: "contrast", label: "Contrast", max: 3, color: true },
  { key: "saturation", label: "Saturation", max: 3, color: true },
  { key: "opacity", label: "Opacity", max: 1, percent: true },
] satisfies {
  key: keyof typeof adjustmentDefaults;
  label: string;
  max: number;
  min?: number;
  percent?: boolean;
  region?: boolean;
  rectangle?: boolean;
  color?: boolean;
}[];

type MediaKind = "image" | "video";
function mediaFileKind(file: ProjectFile): MediaKind | undefined {
  if (file.blob.type.startsWith("video/") || /\.(?:mp4|webm|mov|m4v|ogv)$/iu.test(file.path)) return "video";
  if (file.blob.type.startsWith("image/") || /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(file.path))
    return "image";
  return undefined;
}
function MediaFields({
  node,
  files,
  linked,
  update,
  split,
  reconnect,
}: {
  node: AltairAuthoredNode;
  files: readonly ProjectFile[];
  linked: boolean;
  update(patch: Record<string, JsonValue>): void;
  split(): void;
  reconnect(): void;
}) {
  const args = node.arguments,
    source = String(args.source ?? ""),
    kind = args.mediaKind === "video" ? "video" : "image";
  const timedMedia = kind === "video" || /\.(?:gif|apng)(?:[?#]|$)/iu.test(source);
  const list = useId();
  return (
    <div className="timeline-timing">
      <label>
        {tr("Media kind")}
        <select
          value={kind}
          disabled={linked}
          onChange={(event) => {
            const mediaKind = event.target.value as MediaKind;
            update({ mediaKind, source: files.find((file) => mediaFileKind(file) === mediaKind)?.path ?? source });
          }}
        >
          <option value="image">{tr("Image clip")}</option>
          <option value="video">{tr("Video clip")}</option>
        </select>
      </label>
      <label style={{ gridColumn: "1 / -1" }}>
        {tr("Media source")}
        <input
          key={source}
          list={list}
          defaultValue={source}
          disabled={linked}
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            if (value && value !== source) update({ source: value });
            else event.currentTarget.value = source;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <datalist id={list}>
          {files
            .filter((file) => mediaFileKind(file) === kind)
            .map((file) => (
              <option key={file.path} value={file.path} />
            ))}
        </datalist>
      </label>
      <MediaPlacementFields appearance={args} update={update} />
      <label>
        {tr("Composite with actors")}
        <input
          type="checkbox"
          checked={args.compositeWithActors === true}
          onChange={(event) => update({ compositeWithActors: event.target.checked })}
        />
      </label>
      {timedMedia && (
        <>
          <label>
            {tr("Source in (s)")}
            <NumberInput
              min="0"
              step="0.001"
              value={Number(args.offsetSeconds ?? 0)}
              onCommit={(value) => {
                if (value >= 0) update({ offsetSeconds: value });
              }}
            />
          </label>
          <label>
            {tr("Playback rate")}
            <NumberInput
              min="0.0625"
              max="16"
              step="0.01"
              value={Number(args.playbackRate ?? 1)}
              onCommit={(value) => {
                if (value >= 0.0625 && value <= 16) update({ playbackRate: value });
              }}
            />
          </label>
          <label>
            {tr("Loop")}
            <input
              type="checkbox"
              checked={args.loop === true}
              onChange={(event) => update({ loop: event.target.checked })}
            />
          </label>
        </>
      )}
      {kind === "video" && (
        <>
          <label>
            {tr("Video audio")}
            <input
              type="checkbox"
              checked={args.audioEnabled !== false}
              disabled={linked}
              onChange={(event) => update({ audioEnabled: event.target.checked })}
            />
          </label>
          <label>
            {tr("Volume")}
            <NumberInput
              min="0"
              max={MAX_STAGE_CLIP_VOLUME}
              step="0.05"
              disabled={linked || args.audioEnabled === false}
              value={Number(args.volume ?? 1)}
              onCommit={(value) => {
                if (value >= 0 && value <= MAX_STAGE_CLIP_VOLUME) update({ volume: value });
              }}
            />
          </label>
          {!linked && args.audioEnabled !== false && (
            <ClipGainFields args={args} update={(gainAnimation) => update({ gainAnimation })} />
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={!linked && args.audioEnabled === false}
            onClick={linked ? reconnect : split}
          >
            {tr(linked ? "Reconnect video audio" : "Separate video audio")}
          </button>
        </>
      )}
      <MediaAppearanceFields args={args} update={update} />
    </div>
  );
}

function AdjustmentFields({
  node,
  roots,
  files,
  update,
}: {
  node: AltairAuthoredNode;
  roots: readonly AltairAuthoredNode[];
  files: readonly ProjectFile[];
  update(key: string, value: JsonValue | undefined): void;
}) {
  const targetsId = useId();
  const actorTargets = useMemo(() => {
    const actors = new Set<string>();
    const visit = (entry: AltairAuthoredNode) => {
      const fields = entry.extensions?.fields;
      for (const target of presentationTargets(entry.arguments)) actors.add(target);
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        for (const target of presentationTargets(fields)) actors.add(target);
      }
      if (isTimelineReference(entry)) {
        const bindings = entry.arguments.bindings;
        if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
          for (const actor of Object.values(bindings)) if (typeof actor === "string" && actor) actors.add(actor);
        }
      }
      entry.children?.forEach(visit);
    };
    roots.forEach(visit);
    actors.delete("stage-main");
    actors.delete("bg-main");
    return [...actors];
  }, [roots]);
  const args = node.arguments;
  const target = typeof args.target === "string" ? args.target : adjustmentDefaults.target;
  const mode = args.mode === "mask" ? "mask" : "adjustment";
  const below = args.scope === "below";
  const scopeControl = (
    <label>
      {tr("Adjustment scope")}
      <select value={below ? "below" : "target"} onChange={(event) => update("scope", event.target.value)}>
        <option value="target">{tr("Target")}</option>
        <option value="below">{tr("All tracks below")}</option>
      </select>
    </label>
  );
  if (below) {
    const patch = (fields: JsonObject) => {
      for (const [key, value] of Object.entries(fields)) update(key, value);
    };
    return (
      <div className="timeline-timing">
        {scopeControl}
        <MediaPlacementFields appearance={args} update={patch} fullFrame />
        <MediaAppearanceFields args={args} update={patch} />
      </div>
    );
  }
  const shape = typeof args.shape === "string" ? args.shape : "full";
  const maskSource = typeof args.maskSource === "string" ? args.maskSource : "";
  const images = files.filter(
    (file) => file.blob.type.startsWith("image/") || /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(file.path),
  );
  return (
    <div className="timeline-timing">
      {scopeControl}
      <label>
        {tr("Target")}
        <input
          list={targetsId}
          key={target}
          defaultValue={target}
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            event.currentTarget.value = value || target;
            if (value && value !== target) update("target", value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <datalist id={targetsId}>
          <option value="stage-main">{tr("Stage")}</option>
          <option value="bg-main">{tr("Background")}</option>
          {actorTargets.map((actor) => (
            <option key={actor} value={actor} />
          ))}
        </datalist>
      </label>
      <label>
        {tr("Layer mode")}
        <select value={mode} onChange={(event) => update("mode", event.target.value)}>
          <option value="adjustment">{tr("Adjustment layer")}</option>
          <option value="mask">{tr("Layer mask")}</option>
        </select>
      </label>
      <label>
        {tr("Mask shape")}
        <select value={shape} onChange={(event) => update("shape", event.target.value)}>
          <option value="full">{tr("Full frame")}</option>
          <option value="rectangle">{tr("Rectangle")}</option>
          <option value="ellipse">{tr("Ellipse")}</option>
        </select>
      </label>
      <label>
        {tr("Invert mask")}
        <input
          type="checkbox"
          checked={args.invert === true}
          onChange={(event) => update("invert", event.target.checked)}
        />
      </label>
      <label style={{ gridColumn: "1 / -1" }}>
        {tr("Mask image")}
        <select value={maskSource} onChange={(event) => update("maskSource", event.target.value || undefined)}>
          <option value="">{tr("None")}</option>
          {maskSource && !images.some((file) => file.path === maskSource) && (
            <option value={maskSource}>{maskSource}</option>
          )}
          {images.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
            </option>
          ))}
        </select>
      </label>
      {maskSource && (
        <label>
          {tr("Mask channel")}
          <select
            value={args.maskChannel === "luma" ? "luma" : "alpha"}
            onChange={(event) => update("maskChannel", event.target.value)}
          >
            <option value="alpha">{tr("Alpha channel")}</option>
            <option value="luma">{tr("Luminance")}</option>
          </select>
        </label>
      )}
      {adjustmentFields
        .filter(
          (field) =>
            (!field.region || shape !== "full") &&
            (!field.rectangle || shape === "rectangle") &&
            (!field.color || mode === "adjustment"),
        )
        .map((field) => {
          const scale = field.percent ? 100 : 1;
          const min = field.min ?? 0;
          const value = Number(args[field.key] ?? adjustmentDefaults[field.key]);
          return (
            <label key={field.key}>
              {tr(field.label)}
              {field.percent ? " (%)" : ""}
              <NumberInput
                min={min * scale}
                max={field.max * scale}
                step={field.percent ? 0.1 : 0.01}
                value={Number((value * scale).toFixed(4))}
                onCommit={(next) => {
                  if (next >= min * scale && next <= field.max * scale) update(field.key, next / scale);
                }}
              />
            </label>
          );
        })}
    </div>
  );
}
const escapedContent = (text: string) => {
  const element = document.createElement("span");
  element.textContent = text;
  return element.innerHTML;
};
const cueContent = (label: string, path?: string): HTMLElement => {
  const container = document.createElement("div");
  container.textContent = label;
  if (path) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 600 80");
    svg.setAttribute("height", "28");
    svg.setAttribute("width", "100%");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    line.setAttribute("d", path);
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "3");
    svg.append(line);
    container.append(svg);
  }
  return container;
};

interface TimelineMarker {
  id: string;
  timeSeconds: number;
  note: string;
}

function timelineMarkers(node: AltairAuthoredNode | undefined): TimelineMarker[] {
  const saved = node?.arguments.markers;
  if (!Array.isArray(saved)) return [];
  const ids = new Set<string>();
  return saved
    .flatMap((marker) => {
      if (
        !marker ||
        typeof marker !== "object" ||
        Array.isArray(marker) ||
        typeof marker.id !== "string" ||
        typeof marker.timeSeconds !== "number" ||
        !Number.isFinite(marker.timeSeconds) ||
        marker.timeSeconds < 0 ||
        ids.has(marker.id)
      )
        return [];
      ids.add(marker.id);
      return [
        { id: marker.id, timeSeconds: marker.timeSeconds, note: typeof marker.note === "string" ? marker.note : "" },
      ];
    })
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
}

function CueChart({
  cues,
  nameOf,
  lanes,
  selected,
  onSelect,
  onMove,
  fit,
  locale,
  files,
  markers,
  markerFocus,
  onMarkerMove,
  playhead,
  onScrub,
  onZoomApi,
  onCueContextMenu,
}: {
  cues: readonly TimelineCue[];
  nameOf(node: AltairAuthoredNode): string;
  lanes: ReadonlyMap<string, string>;
  selected: string;
  onSelect: (id: string) => void;
  onMove: (id: string, start: number, duration?: number) => void;
  fit: number;
  locale: string;
  files: readonly ProjectFile[];
  markers: readonly TimelineMarker[];
  markerFocus?: { timeSeconds: number };
  onMarkerMove(id: string, seconds: number): void;
  playhead?: number;
  onScrub(seconds: number): void;
  onZoomApi?: (api: { zoomIn(): void; zoomOut(): void } | null) => void;
  onCueContextMenu?: (id: string, point: { x: number; y: number }) => void;
}) {
  const [waveforms, setWaveforms] = useState<ReadonlyMap<string, string>>(new Map());
  const waveformContent = useRef<ReadonlyMap<string, string>>(new Map());
  const decoded = useRef(new Map<Blob, Promise<AudioBuffer | undefined>>());
  useEffect(() => {
    let active = true;
    const clips = cues.filter(
      (cue) =>
        isAudioClip(cue.node) ||
        (isMediaClip(cue.node) &&
          cue.node.arguments.mediaKind === "video" &&
          cue.node.arguments.audioEnabled !== false),
    );
    if (!clips.length) {
      setWaveforms(new Map());
      return;
    }
    void (async () => {
      const paths = await Promise.all(
        clips.map(async (cue) => {
          const file = files.find((file) => file.path === cue.node.arguments.source);
          if (!file) return [cue.node.id, ""] as const;
          let buffer = decoded.current.get(file.blob);
          if (!buffer) {
            buffer = (async () => {
              const context = new OfflineAudioContext(2, 1, 48000);
              const bytes = await file.blob.arrayBuffer();
              return isMediaClip(cue.node) || cue.node.arguments.sourceKind === "video"
                ? decodeStoryVideoAudio(new Uint8Array(bytes), context)
                : context.decodeAudioData(bytes);
            })();
            decoded.current.set(file.blob, buffer);
            if (decoded.current.size > 8) decoded.current.delete(decoded.current.keys().next().value!);
          }
          const sound = await buffer;
          return [cue.node.id, sound ? audioWaveformPath(sound, cue.node.arguments) : ""] as const;
        }),
      );
      if (active) setWaveforms(new Map(paths));
    })().catch(() => {
      if (active) setWaveforms(new Map());
    });
    return () => {
      active = false;
    };
  }, [cues, files]);
  const mount = useRef<HTMLDivElement>(null),
    timeline = useRef<Timeline>(undefined),
    items = useRef(new DataSet<DataItem>());
  const callbacks = useRef({ onSelect, onMove, onMarkerMove, onScrub, onZoomApi, onCueContextMenu });
  useEffect(() => {
    callbacks.current = { onSelect, onMove, onMarkerMove, onScrub, onZoomApi, onCueContextMenu };
  }, [onSelect, onMove, onMarkerMove, onScrub, onZoomApi, onCueContextMenu]);
  useEffect(() => {
    const container = mount.current;
    if (!container) return;
    const options: TimelineOptions = {
      height: "100%",
      min: 0,
      start: 0,
      end: 5000,
      zoomMin: 250,
      zoomMax: 3600000,
      showCurrentTime: false,
      showMajorLabels: false,
      stack: true,
      multiselect: false,
      selectable: true,
      orientation: "top",
      groupOrder: "order",
      editable: {
        add: false,
        remove: false,
        updateTime: true,
        updateGroup: false,
      },
      snap: (date) => new Date(Math.max(0, Math.round(Number(date) / 10) * 10)),
      template: (item) => cueContent(String(item.content ?? ""), waveformContent.current.get(String(item.id))),
      format: {
        minorLabels: (date) => `${(Number(date) / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} s`,
      },
      onMove: (item, done) => {
        const original = items.current.get(item.id!);
        if (!original || original.editable === false) {
          done(null);
          return;
        }
        const start = Number(item.start);
        const previousLength = original?.end == null ? undefined : Number(original.end) - Number(original.start);
        const length = item.end == null ? undefined : Number(item.end) - start;
        done(null);
        callbacks.current.onMove(
          String(item.id),
          Math.max(0, start / 1000),
          length !== undefined && length !== previousLength ? Math.max(0, length / 1000) : undefined,
        );
      },
    };
    const view = new Timeline(container, items.current, [], options);
    timeline.current = view;
    callbacks.current.onZoomApi?.({
      zoomIn: () => view.zoomIn(0.4, { animation: false }),
      zoomOut: () => view.zoomOut(0.4, { animation: false }),
    });
    view.on("select", (event) =>
      callbacks.current.onSelect(event.items[0] === undefined ? "" : String(event.items[0])),
    );
    view.on("timechanged", ({ id, time }: { id: string; time: Date }) => {
      if (id.startsWith("marker:")) callbacks.current.onMarkerMove(id.slice(7), Number(time) / 1000);
    });
    view.on("timechange", ({ id, time }: { id: string; time: Date }) => {
      if (id === "timeline-playhead") callbacks.current.onScrub(Number(time) / 1000);
    });
    view.on("click", (event: { what?: string | null; time?: Date }) => {
      if ((event.what === "axis" || event.what === "background") && event.time)
        callbacks.current.onScrub(Math.max(0, Number(event.time) / 1000));
    });
    view.on("contextmenu", (event: { item?: unknown; event?: MouseEvent }) => {
      if (event.item == null || !event.event) return;
      event.event.preventDefault();
      const id = String(event.item);
      callbacks.current.onSelect(id);
      callbacks.current.onCueContextMenu?.(id, { x: event.event.clientX, y: event.event.clientY });
    });
    let scrubbing = false;
    const timeAtClientX = (clientX: number) => {
      const axis = container.querySelector(".vis-panel.vis-center") ?? container.querySelector(".vis-panel.vis-top");
      if (!axis) return;
      const rect = axis.getBoundingClientRect();
      if (rect.width <= 0) return;
      const win = view.getWindow();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ms = win.start.getTime() + ratio * (win.end.getTime() - win.start.getTime());
      callbacks.current.onScrub(Math.max(0, ms / 1000));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      container.focus({ preventScroll: true });
      const target = event.target as Element | null;
      if (!target || target.closest(".vis-custom-time") || !target.closest(".vis-panel.vis-top")) return;
      scrubbing = true;
      event.preventDefault();
      event.stopPropagation();
      try {
        container.setPointerCapture(event.pointerId);
      } catch {}
      timeAtClientX(event.clientX);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!scrubbing) return;
      event.stopPropagation();
      timeAtClientX(event.clientX);
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!scrubbing) return;
      scrubbing = false;
      try {
        if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      } catch {}
    };
    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("pointermove", onPointerMove, true);
    container.addEventListener("pointerup", onPointerEnd, true);
    container.addEventListener("pointercancel", onPointerEnd, true);
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) view.redraw();
    });
    observer.observe(container);
    return () => {
      callbacks.current.onZoomApi?.(null);
      observer.disconnect();
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("pointermove", onPointerMove, true);
      container.removeEventListener("pointerup", onPointerEnd, true);
      container.removeEventListener("pointercancel", onPointerEnd, true);
      timeline.current = undefined;
      view.destroy();
    };
  }, [locale]);
  const hasPlayhead = playhead !== undefined;
  useEffect(() => {
    const view = timeline.current;
    if (!view || !hasPlayhead) return;
    view.addCustomTime(new Date(0), "timeline-playhead");
    view.setCustomTimeTitle(tr("Timeline playhead"), "timeline-playhead");
    return () => {
      if (timeline.current === view) view.removeCustomTime("timeline-playhead");
    };
  }, [hasPlayhead, locale]);
  useEffect(() => {
    if (playhead !== undefined) timeline.current?.setCustomTime(new Date(playhead * 1000), "timeline-playhead");
  }, [playhead, locale]);
  useEffect(() => {
    const ids = new Set(cues.map((cue) => cue.node.id));
    waveformContent.current = waveforms;
    const groups = new Map([...lanes].map(([id, name]) => ["lane:" + id, name]));
    items.current.remove(items.current.getIds().filter((id) => !ids.has(String(id))));
    items.current.update(
      cues.map((cue): DataItem => {
        const group = cueLane(cue, lanes);
        groups.set(group.id, group.name);
        return {
          id: cue.node.id,
          group: group.id,
          content: nameOf(cue.node),
          start: new Date(cue.atSeconds * 1000),
          end: cue.durationSeconds > 0 ? new Date((cue.atSeconds + cue.durationSeconds) * 1000) : undefined,
          type: cue.durationSeconds > 0 ? "range" : "box",
          className: `timeline-cue ${cue.role}`,
          editable: cue.trackLocked ? false : { updateTime: true, updateGroup: false, remove: false },
        };
      }),
    );
    timeline.current?.setGroups(
      [...groups].map(([id, name], order) => ({
        id,
        order,
        content: escapedContent(name),
      })),
    );
  }, [cues, lanes, locale, nameOf, waveforms]);
  useEffect(() => {
    timeline.current?.setSelection(selected ? [selected] : []);
  }, [selected]);
  useEffect(() => {
    const view = timeline.current;
    if (!view) return;
    for (const marker of markers) {
      const key = `marker:${marker.id}`;
      view.addCustomTime(new Date(marker.timeSeconds * 1000), key);
      view.setCustomTimeTitle(marker.note || tr("Timeline marker"), key);
    }
    return () => {
      if (timeline.current === view) for (const marker of markers) view.removeCustomTime(`marker:${marker.id}`);
    };
  }, [markers, locale]);
  useEffect(() => {
    if (markerFocus) timeline.current?.moveTo(markerFocus.timeSeconds * 1000, { animation: false });
  }, [markerFocus]);
  useEffect(() => {
    const seconds = Math.max(
      5,
      ...markers.map((marker) => marker.timeSeconds),
      ...cues.map((cue) => cue.atSeconds + cue.durationSeconds),
    );
    timeline.current?.setWindow(0, seconds * 1100, { animation: false });
  }, [fit]);
  return <div ref={mount} className="timeline-canvas" role="region" aria-label={tr("Cue timeline")} tabIndex={0} />;
}

function useTimelinePlayhead(
  session: EditorSession,
  timelineId: string | undefined,
  compilation: unknown,
  ready: boolean,
  onError: (issue: string) => void,
) {
  const [position, setPosition] = useState<{ timelineId: string; seconds: number }>();
  const lastPosition = useRef<{ timelineId: string; seconds: number }>(undefined);
  const scope = useRef<{ controller: AbortController; pending?: number; running: boolean }>(undefined);
  useEffect(() => {
    const active = { controller: new AbortController(), running: false };
    scope.current = active;
    return () => {
      active.controller.abort();
      session.clearTimelineSample();
    };
  }, [session, timelineId]);
  const request = useCallback(
    (seconds: number) => {
      const active = scope.current;
      if (!timelineId || !active || active.controller.signal.aborted) return;
      lastPosition.current = { timelineId, seconds };
      setPosition(lastPosition.current);
      active.pending = seconds;
      if (active.running) return;
      active.running = true;
      void (async () => {
        while (active.pending !== undefined && !active.controller.signal.aborted) {
          const time = active.pending;
          active.pending = undefined;
          try {
            await session.sampleTimeline(timelineId, time, active.controller.signal);
            if (!active.controller.signal.aborted && active.pending === undefined) onError("");
          } catch (error) {
            if (!(error instanceof Error && error.name === "AbortError") && !active.controller.signal.aborted)
              onError(tr(error instanceof Error ? error.message : String(error)));
          }
        }
        active.running = false;
      })();
    },
    [session, timelineId, onError],
  );
  useEffect(() => {
    if (!ready || !compilation) return;
    const selected = lastPosition.current;
    if (!selected || selected.timelineId !== timelineId) return;
    const frame = requestAnimationFrame(() => request(selected.seconds));
    return () => cancelAnimationFrame(frame);
  }, [compilation, ready, timelineId, request]);
  return { seconds: position?.timelineId === timelineId ? (position?.seconds ?? 0) : 0, request };
}

function SceneSequence({
  session,
  text,
  selected,
  locale,
}: {
  session: EditorSession;
  text: string;
  selected: string | undefined;
  locale: string;
}) {
  const statements = useMemo(
    () => nativeStatements(text).filter((entry) => nativeStatementIsVisible(entry.node)),
    [text],
  );
  return (
    <ol className="timeline-scene-sequence" aria-label={tr("Scene")}>
      {statements.map((entry, index) => (
        <li key={entry.id}>
          <button type="button" aria-pressed={entry.id === selected} onClick={() => session.select(entry.line)}>
            <span>{index + 1}</span>
            <strong>{nativeNodeLabel(entry.node)}</strong>
            <small>{nativeNodeExcerpt(entry.node, locale)}</small>
          </button>
        </li>
      ))}
    </ol>
  );
}

function CueInspectorDock({
  title,
  onClose,
  children,
}: {
  title: string | undefined;
  onClose(): void;
  children: ReactNode;
}) {
  const inspectorHost = useContext(TimelineInspectorHost);
  const workspace = useContext(TimelineWorkspaceContext);
  const inspecting = Boolean(title);
  useEffect(() => {
    workspace?.setCueInspecting(inspecting);
  }, [workspace, inspecting]);
  useEffect(() => () => workspace?.setCueInspecting(false), [workspace]);
  if (!title) return null;
  if (!inspectorHost)
    return (
      <div className="timeline-cue-inspector">
        <header className="author-panel-header">
          <h2>{title}</h2>
          <button type="button" className="author-icon-button" aria-label={tr("Close")} title={tr("Close")} onClick={onClose}>
            <X aria-hidden />
          </button>
        </header>
        {children}
      </div>
    );
  return createPortal(
    <DockPanel title={title} onClose={onClose} className="author-cue-panel">
      <div className="timeline-cue-inspector">{children}</div>
    </DockPanel>,
    inspectorHost,
  );
}

export function TimelineEditor({
  session,
  scope,
  groupSelection,
  onSelectCue,
}: {
  session: EditorSession;
  scope?: readonly string[];
  groupSelection?: readonly string[] | undefined;
  onSelectCue?(sceneId: string, nodeId: string | null): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { i18n } = useStudioI18n();
  const doc = session.document();
  const workspaceContext = useContext(TimelineWorkspaceContext);
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;
  const [fit, setFit] = useState(0),
    [command, setCommand] = useState("Talk"),
    [sourceChoice, setSourceChoice] = useState(""),
    [showImport, setShowImport] = useState(false),
    [source, setSource] = useState(""),
    [issue, setIssue] = useState(""),
    [scrubIssue, setScrubIssue] = useState(""),
    [busy, setBusy] = useState(false),
    [zoomApi, setZoomApi] = useState<{ zoomIn(): void; zoomOut(): void } | null>(null),
    [contextMenu, setContextMenu] = useState<{ cueId: string; x: number; y: number } | null>(null);
  useEffect(() => setContextMenu(null), [state.active]);
  const toolbarHost = useContext(TimelineToolbarHost);
  const [showOptions, setShowOptions] = useState(false);
  const optionsId = useId();
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [mediaSource, setMediaSource] = useState<string>();
  const mediaListId = useId();
  const availableMedia = useMemo(
    () => state.files.filter((file) => mediaFileKind(file) === mediaKind),
    [state.files, mediaKind],
  );
  const mediaToInsert = (mediaSource ?? availableMedia[0]?.path ?? "").trim();
  const [activeTimeline, setActiveTimeline] = useState<{ sceneId: string; id: string; statement?: string }>();
  const [markerId, setMarkerId] = useState("");
  const [markerFocus, setMarkerFocus] = useState<{ timeSeconds: number }>();
  const scene = useMemo(() => {
    try {
      return parseAltairSceneDocument(doc?.text ?? "");
    } catch {
      return undefined;
    }
  }, [doc?.text]);
  const sceneId = scene?.id;
  const selectionId = state.authoringSelection?.sceneId === sceneId ? state.authoringSelection?.nodeId : null;
  const selectCue = useCallback((id: string) => {
    if (!sceneId) return;
    if (onSelectCue) onSelectCue(sceneId, id || null);
    else if (id) session.setAuthoringSelection(sceneId, [id], id);
    else {
      const previous = session.getSnapshot().authoringSelection;
      if (previous?.sceneId === sceneId && previous.nodeId)
        session.setAuthoringSelection(sceneId, previous.lines, previous.cursor, null);
    }
    if (id) workspaceContextRef.current?.openInspector();
  }, [onSelectCue, sceneId, session]);
  const groupIds = useMemo(() => {
    if (!scene) return [];
    const ids = new Set(
      groupSelection?.length
        ? groupSelection
        : scope?.length
          ? scope
          : state.authoringSelection?.sceneId === scene.id
            ? state.authoringSelection.lines
            : [],
    );
    if (!ids.size) return [];
    const containsSelection = (node: AltairAuthoredNode): boolean =>
      ids.has(node.id) || (node.children?.some(containsSelection) ?? false);
    return scene.nodes.filter(containsSelection).map((node) => node.id);
  }, [scene, scope, groupSelection, state.authoringSelection]);
  const allTimelines = scene?.nodes.filter(isTimeline) ?? [];
  const inferred = useMemo(() => scene && inferredSceneTimeline(scene), [scene]);
  const scoped = scope?.length ? allTimelines.filter((node) => scope.includes(node.id)) : [];
  const timelines = scoped.length ? scoped : allTimelines;
  const preferred =
    activeTimeline && activeTimeline.sceneId === scene?.id && activeTimeline.statement === state.selectedNodeId
      ? timelines.find((node) => node.id === activeTimeline.id)
      : undefined;
  const overview = !preferred && !scoped.length ? inferred : undefined;
  const ownsSelection = (node: AltairAuthoredNode): boolean =>
    node.id === selectionId || Boolean(node.children?.some(ownsSelection));
  const current = preferred ?? (selectionId ? timelines.find(ownsSelection) : undefined)
    ?? overview ?? timelines.find((node) => node.id === state.selectedNodeId) ?? timelines[0] ?? inferred;
  const viewTimeline = overview ?? current;
  const playhead = useTimelinePlayhead(
    session,
    viewTimeline?.id,
    state.compilation,
    Boolean(!state.compiling && state.preview?.ready),
    setScrubIssue,
  );
  const workspace = useMemo(() => {
    try {
      return readNativeWorkspace(state.documents);
    } catch {
      return undefined;
    }
  }, [state.documents]);
  const sources = useMemo(() => (workspace ? listReusableTimelines(workspace) : []), [workspace]);
  const sourceByKey = useMemo(() => new Map(sources.map((source) => [sourceKey(source), source])), [sources]);
  const nameOf = useMemo(
    () => (node: AltairAuthoredNode) => {
      if (isMediaClip(node)) return tr(node.arguments.mediaKind === "video" ? "Video clip" : "Image clip");
      if (isAdjustment(node)) return tr(node.arguments.mode === "mask" ? "Layer mask" : "Adjustment layer");
      if (!isTimelineReference(node)) return nativeNodeLabel(node);
      return sourceByKey.get(referenceKey(node))?.name ?? tr("Timeline reference");
    },
    [sourceByKey],
  );
  const choices = sources.filter((source) => source.sceneId !== scene?.id || source.nodeId !== current?.id);
  const insertSource = choices.find((source) => sourceKey(source) === sourceChoice) ?? choices[0];
  const sourceOptions = choices.map((source) => (
    <option key={sourceKey(source)} value={sourceKey(source)}>
      {sourceName(source)}
    </option>
  ));
  const manifest = session.document(NATIVE_PROJECT_PATH)?.text;
  const timing = useMemo<TimelineTimingContext>(() => {
    if (workspace) return createTimelineTimingContext(workspace);
    if (!manifest) return {};
    try {
      const project = parseAltairProjectDocument(manifest);
      return { runtime: project.runtime, assets: project.assets, locale: project.locales[0] };
    } catch {
      return {};
    }
  }, [workspace, manifest]);
  const cues = useMemo(() => {
    try {
      return current ? timelineCues(current, timing) : [];
    } catch {
      return [];
    }
  }, [current, timing]);
  const sceneView = useMemo(() => {
    if (!overview) return;
    try {
      return sceneTrackCues(overview, timing);
    } catch {
      return;
    }
  }, [overview, timing]);
  const displayCues = sceneView?.cues ?? cues;
  const chartSelection = displayCues.find((cue) => cue.node.id === selectionId)?.node.id ?? "";
  const scopeStart = sceneView?.roots.find((cue) => cue.node.id === current?.id)?.atSeconds ?? 0;
  const cue = cues.find((cue) => cue.node.id === selectionId);
  const selected = cue?.node.id ?? "";
  const scrubDuration = Math.min(
    1800,
    Math.max(
      0,
      Number(viewTimeline?.arguments.durationSeconds) || 0,
      ...displayCues.map((entry) => entry.atSeconds + entry.durationSeconds),
    ),
  );
  const frameRate = Math.max(1, Number(timing.runtime?.targetFrameRate) || 30);
  const scrub = useCallback(
    (seconds: number) => {
      if (!state.preview?.ready) return;
      const snapped = Math.round(seconds * frameRate) / frameRate;
      playhead.request(Math.max(0, Math.min(scrubDuration, snapped)));
    },
    [state.preview?.ready, frameRate, scrubDuration, playhead.request],
  );
  const playheadSeconds = current && scrubDuration > 0 ? Math.min(playhead.seconds, scrubDuration) : 0;
  const transportActionsRef = useRef({
    scrub: (_seconds: number) => {},
    stepFrame: (_delta: -1 | 1, _secondsStep?: number) => {},
    seekStart: () => {},
    seekEnd: () => {},
    clearSample: () => {},
  });
  transportActionsRef.current = {
    scrub,
    stepFrame: (delta, secondsStep) => {
      const increment = secondsStep ?? 1 / frameRate;
      scrub(playheadSeconds + delta * increment);
    },
    seekStart: () => scrub(0),
    seekEnd: () => scrub(scrubDuration),
    clearSample: () => session.clearTimelineSample(),
  };
  const setWorkspaceTransport = workspaceContext?.setTransport;
  useEffect(() => {
    if (!setWorkspaceTransport) return;
    if (!viewTimeline || scrubDuration <= 0) {
      setWorkspaceTransport(null);
      return;
    }
    setWorkspaceTransport({
      timelineId: viewTimeline.id,
      seconds: playheadSeconds,
      duration: scrubDuration,
      frameRate,
      ready: Boolean(state.preview?.ready),
      scrub: (seconds) => transportActionsRef.current.scrub(seconds),
      stepFrame: (delta, secondsStep) => transportActionsRef.current.stepFrame(delta, secondsStep),
      seekStart: () => transportActionsRef.current.seekStart(),
      seekEnd: () => transportActionsRef.current.seekEnd(),
      clearSample: () => transportActionsRef.current.clearSample(),
    });
  }, [setWorkspaceTransport, viewTimeline?.id, playheadSeconds, scrubDuration, frameRate, state.preview?.ready]);
  useEffect(() => () => setWorkspaceTransport?.(null), [setWorkspaceTransport]);
  const markers = useMemo(() => timelineMarkers(current), [current]);
  const chartMarkers = useMemo(() => scopeStart
    ? markers.map((marker) => ({ ...marker, timeSeconds: marker.timeSeconds + scopeStart }))
    : markers, [markers, scopeStart]);
  const chartMarkerFocus = useMemo(() => markerFocus &&
    ({ timeSeconds: markerFocus.timeSeconds + scopeStart }), [markerFocus, scopeStart]);
  const activeMarker = markers.find((marker) => marker.id === markerId) ?? markers[0];
  const reference = cue && isTimelineReference(cue.node) ? cue.node : undefined;
  const referencedSource = reference && sourceByKey.get(referenceKey(reference));
  const sourceTimeline = reference && resolveTimelineReference(reference, timing);
  const playback =
    sourceTimeline && reference
      ? timelineInstanceWindow(reference, timelineCueDuration(sourceTimeline.node, timing))
      : undefined;
  const validateReferences = (next: AltairAuthoredNode) => {
    if (!workspace || !scene) return;
    const updated = {
      ...workspace,
      scenes: workspace.scenes.map((entry) =>
        entry.id === scene.id
          ? { ...entry, nodes: entry.nodes.map((node) => (node.id === next.id ? next : node)) }
          : entry,
      ),
    };
    timelineCues(next, createTimelineTimingContext(updated));
  };
  const openSource = async (source: TimelineSource) => {
    const path = workspace?.project.scenes.find((scene) => scene.id === source.sceneId)?.path;
    const document = path && session.document(path);
    const statement = document && nativeStatements(document.text).find((statement) => statement.id === source.nodeId);
    if (!path || !statement) throw Error(tr("Timeline command is missing"));
    await session.activate(path, statement.line);
    session.setAuthoringSelection(source.sceneId, [source.nodeId], source.nodeId);
    setActiveTimeline({ sceneId: source.sceneId, id: source.nodeId, statement: session.getSnapshot().selectedNodeId });
    if (scope?.length) session.requestTool("timeline");
    setFit((value) => value + 1);
  };
  const subtitleLane = typeof cue?.track.laneId === "string" ? cue.track.laneId : undefined;
  const subtitles = useMemo(() => {
    try {
      return timelineSubRip(cues, timing, subtitleLane);
    } catch {
      return "";
    }
  }, [cues, timing, subtitleLane]);
  const lanes = useMemo(() => (current ? timelineLanes(current) : []), [current]);
  const laneNames = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane.name])), [lanes]);
  const trackRows = useMemo(() => {
    const tracks = new Map<
      string,
      {
        id: string;
        name: string;
        laneId?: string;
        laneIndex: number;
        hasAudio: boolean;
        hasVisual: boolean;
        legacyGains: Set<number>;
      }
    >();
    for (const [index, lane] of lanes.entries()) {
      const id = `lane:${lane.id}`;
      tracks.set(id, {
        id,
        name: lane.name,
        laneId: lane.id,
        laneIndex: index,
        hasAudio: false,
        hasVisual: false,
        legacyGains: new Set(),
      });
    }
    for (const item of cues) {
      const { id, name } = cueLane(item, laneNames);
      const row = tracks.get(id) ?? {
        id,
        name,
        laneIndex: -1,
        hasAudio: false,
        hasVisual: false,
        legacyGains: new Set<number>(),
      };
      if (
        item.audioOnly ||
        (isTimelineReference(item.node) && item.node.arguments.channels !== "picture") ||
        (isMediaClip(item.node) &&
          item.node.arguments.mediaKind === "video" &&
          item.node.arguments.audioEnabled !== false)
      ) {
        row.hasAudio = true;
        row.legacyGains.add(Number(item.node.arguments.trackVolume ?? 1));
      }
      if (!item.audioOnly) row.hasVisual = true;
      tracks.set(id, row);
    }
    return [...tracks.values()];
  }, [lanes, cues, laneNames, i18n.resolvedLanguage]);
  const anchor = cue?.anchor;
  const dialogueDuration = cue && durationField(cue.node)?.key === "advanceAfterSeconds";
  const minimumDuration = cue && (isMediaClip(cue.node) || isAdjustment(cue.node)) ? 0.001 : 0;
  const anchorTargets = useMemo(() => {
    const byId = new Map(cues.map((item) => [item.node.id, item]));
    return cues.filter((candidate) => {
      let item: TimelineCue | undefined = candidate;
      while (item) {
        if (item.node.id === selected) return false;
        item = item.anchor ? byId.get(item.anchor.nodeId) : undefined;
      }
      return true;
    });
  }, [cues, selected]);
  const available = nativeCommands.filter(
    (command) =>
      ["Talk", "ChatTalk", "Wait"].includes(command.name) ||
      (["camera", "stage", "audio", "timing", "transition", "character", "media"].includes(command.category) &&
        command.name !== "Timeline"),
  );
  const change = (update: (node: AltairAuthoredNode) => AltairAuthoredNode) => {
    if (current)
      try {
        if (current === inferred) session.groupTimelineCommands(current.children!.map((node) => node.id), update);
        else session.editNode(current.id, update);
        setIssue("");
        return true;
      } catch (error) {
        setIssue(error instanceof Error ? tr(error.message) : String(error));
      }
    return false;
  };
  const snapMarkerTime = (seconds: number) => Math.round(Math.max(0, seconds) * frameRate) / frameRate;
  const saveMarkers = (update: (previous: TimelineMarker[]) => TimelineMarker[]) =>
    change((node) => ({
      ...node,
      arguments: { ...node.arguments, markers: update(timelineMarkers(node)).map((marker) => ({ ...marker })) },
    }));
  const move = (id: string, start: number, duration?: number) =>
    change((node) => updateCue(node, id, start, duration, undefined, timing));
  const moveChartCue = (id: string, start: number, duration?: number) => {
    const owner = sceneView?.owners.get(id);
    if (!owner && (!sceneView || !allTimelines.length)) {
      move(id, start, duration);
      return;
    }
    try {
      const offset = owner?.start ?? sceneView?.roots.find((cue) => cue.node.id === id)?.atSeconds ?? 0;
      const update = (group: AltairAuthoredNode) =>
        updateCue(group, id, Math.max(0, start - offset), duration, undefined, timing);
      if (owner) session.editNode(owner.timeline.id, update);
      else session.groupTimelineCommands([id], update);
      setIssue("");
    } catch (error) {
      setIssue(error instanceof Error ? tr(error.message) : String(error));
    }
  };
  const link = (next: TimelineCue["anchor"]) => change((node) => linkTimelineCue(node, selected, next, timing));
  const insertCue = (child: AltairAuthoredNode) => {
    if (!current) {
      session.insert(appendTimelineCue(createTimeline(), child, timing));
      const inserted = session.statements().find((statement) => statement.id === session.getSnapshot().selectedNodeId);
      selectCue(inserted?.node.children?.[0]?.id ?? "");
    } else {
      const added = change((node) => {
        const next = appendTimelineCue(node, child, timing, selected || undefined);
        if (isTimelineReference(child)) validateReferences(next);
        return next;
      });
      if (!added) return;
      selectCue(child.id);
    }
    setFit((value) => value + 1);
  };
  const quickInsert = (kind: string) => {
    if (kind === "mediaClip") {
      if (!mediaToInsert) {
        setCommand("mediaClip");
        setShowOptions(true);
        return;
      }
      insertCue({
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name: "mediaClip" },
        schemaVersion: 1,
        arguments: {
          source: mediaToInsert,
          mediaKind,
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
      });
      return;
    }
    if (kind === "propertyClip") {
      insertCue({
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name: "propertyClip" },
        schemaVersion: 1,
        arguments: {
          target: "scene-camera",
          keep: true,
          clip: {
            durationSeconds: 1,
            tracks: [
              {
                channel: "panOffsetX",
                points: [
                  { timeSeconds: 0, value: 0 },
                  { timeSeconds: 1, value: 0, ease: "linear" },
                ],
              },
            ],
          },
        },
      });
      return;
    }
    if (kind === "adjustment" || kind === "mask") {
      insertCue({
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name: "adjustment" },
        schemaVersion: 1,
        arguments: {
          ...adjustmentDefaults,
          mode: kind,
          shape: kind === "mask" ? "ellipse" : "full",
          ...(kind === "adjustment" ? { scope: "below" } : {}),
        },
      });
      return;
    }
    if (kind === "timelineRef") {
      if (insertSource)
        insertCue({
          id: crypto.randomUUID(),
          type: { plugin: "haneoka.altair", name: "timelineRef" },
          schemaVersion: 1,
          arguments: { timeline: { sceneId: insertSource.sceneId, nodeId: insertSource.nodeId } },
        });
      return;
    }
    const definition = nativeCommands.find((item) => item.name === kind);
    if (!definition && kind !== "audioClip") return;
    const child: AltairAuthoredNode =
      kind === "audioClip"
        ? {
            id: crypto.randomUUID(),
            type: { plugin: "haneoka.altair", name: "audioClip" },
            schemaVersion: 1,
            arguments: {
              source: state.files.find((file) => isAudioFile(file.path))?.path ?? "",
              trackName: tr("Audio track"),
              category: "Se",
              offsetSeconds: 0,
              durationSeconds: 5,
              playbackRate: 1,
              volume: 1,
              trackVolume: 1,
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
              loop: false,
              muted: false,
            },
          }
        : definition!.initial();
    insertCue(child);
  };
  const add = () => quickInsert(command);
  const duplicateCue = (targetCue: TimelineCue) => {
    if (!current || !sceneId || targetCue.trackLocked) return;
    let clonedId = "";
    const added = change((node) => {
      const clone = cloneAltairNodeGroup([targetCue.node], sceneId, sceneId)[0]!;
      clonedId = clone.id;
      const appended = appendTimelineCue(node, clone, timing, targetCue.node.id);
      const laneId = typeof targetCue.track.laneId === "string" ? targetCue.track.laneId : undefined;
      const next = laneId ? assignCueLane(appended, clone.id, laneId, timing) : appended;
      if (isTimelineReference(clone)) validateReferences(next);
      return next;
    });
    if (!added) return;
    selectCue(clonedId);
    setFit((value) => value + 1);
  };
  const addMarkerAtPlayhead = () => {
    if (!current) return;
    const seconds = snapMarkerTime(playheadSeconds - scopeStart);
    const existing = markers.find((marker) => snapMarkerTime(marker.timeSeconds) === seconds);
    if (existing) {
      setMarkerId(existing.id);
      return;
    }
    const marker = {
      id: crypto.randomUUID(),
      timeSeconds: seconds,
      note: "",
    };
    if (saveMarkers((previous) => [...previous, marker])) setMarkerId(marker.id);
  };
  const selectedStatement: EditorStatement | undefined = cue
    ? {
        id: cue.node.id,
        node: cue.node,
        line: state.line,
        name: nameOf(cue.node),
        kind: "command",
        content: "",
        raw: serializeAuthoredText(cue.node),
        arguments: [],
      }
    : undefined;
  const importSource = async () => {
    setBusy(true);
    try {
      const group = await importTimelineScript(source);
      session.insertGroup(group);
      selectCue("");
      setShowImport(false);
      setSource("");
      setFit((value) => value + 1);
      setIssue("");
    } catch (error) {
      setIssue(String(error));
    } finally {
      setBusy(false);
    }
  };
  const createNewTimeline = () => {
    if (!scene) return;
    session.insert(createTimeline());
    setActiveTimeline(undefined);
    selectCue("");
    setFit((value) => value + 1);
  };
  const contextCue = contextMenu ? cues.find((entry) => entry.node.id === contextMenu.cueId) : undefined;
  const contextReference = contextCue && isTimelineReference(contextCue.node) ? contextCue.node : undefined;
  const contextReferencedSource = contextReference && sourceByKey.get(referenceKey(contextReference));
  const contextIsVideo = Boolean(
    contextCue && isMediaClip(contextCue.node) && contextCue.node.arguments.mediaKind === "video",
  );
  const contextLinked = Boolean(
    contextCue &&
    contextIsVideo &&
    current?.children?.some((child) => isAudioClip(child) && child.arguments.linkedMediaId === contextCue.node.id),
  );
  const contextAudioDisabled = Boolean(
    contextCue && contextIsVideo && !contextLinked && contextCue.node.arguments.audioEnabled === false,
  );
  const onTimelineKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "Escape") {
      if (contextMenu) {
        event.preventDefault();
        setContextMenu(null);
      } else if (showOptions) {
        event.preventDefault();
        setShowOptions(false);
      } else if (selected) {
        event.preventDefault();
        selectCue("");
      }
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && current && scrubDuration > 0 && state.preview?.ready) {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      scrub(playheadSeconds + delta * (event.shiftKey ? 1 : 1 / frameRate));
      return;
    }
    if ((event.key === "Home" || event.key === "End") && current && scrubDuration > 0 && state.preview?.ready) {
      event.preventDefault();
      scrub(event.key === "Home" ? 0 : scrubDuration);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && cue && !cue.trackLocked) {
      event.preventDefault();
      if (
        change((node) =>
          event.shiftKey ? rippleDeleteCue(node, cue.node.id, timing) : removeCue(node, cue.node.id, timing),
        )
      )
        selectCue("");
      return;
    }
    if ((event.key === "+" || event.key === "=") && zoomApi) {
      event.preventDefault();
      zoomApi.zoomIn();
      return;
    }
    if (event.key === "-" && zoomApi) {
      event.preventDefault();
      zoomApi.zoomOut();
      return;
    }
    if (!event.repeat && event.key.toLowerCase() === "m" && current) {
      event.preventDefault();
      addMarkerAtPlayhead();
    }
  };
  const toolbar = (
    <div className="timeline-primary-tools" role="group" aria-label={tr("Timeline actions")}>
      <div className="timeline-scope-group">
        <select
          aria-label={tr("Active timeline")}
          value={viewTimeline?.id ?? ""}
          onChange={(event) => {
            if (event.currentTarget.value === inferred?.id) {
              setActiveTimeline(undefined);
              setFit((value) => value + 1);
              return;
            }
            const statement = session.statements().find((item) => item.id === event.target.value);
            if (statement) session.select(statement.line);
            if (scene)
              setActiveTimeline({
                sceneId: scene.id,
                id: event.currentTarget.value,
                statement: session.getSnapshot().selectedNodeId,
              });
            selectCue(event.currentTarget.value);
            setFit((value) => value + 1);
          }}
        >
          {inferred && <option value={inferred.id}>{tr("Scene")}</option>}
          {!timelines.length && !inferred && <option value="">{tr("No timeline yet")}</option>}
          {timelines.map((node, index) => (
            <option key={node.id} value={node.id}>
              {(typeof node.arguments.title === "string" && node.arguments.title) || `${tr("Timeline")} ${index + 1}`}
            </option>
          ))}
        </select>
      </div>
      <div className="timeline-edit-group" role="toolbar" aria-label={tr("Timeline")}>
        <DropdownMenu.Root dir={i18n.dir()}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="author-icon-button"
              aria-label={tr("Add cue")}
              title={tr("Add cue")}
              disabled={!scene}
            >
              <Plus aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="editor-file-menu" align="start" sideOffset={6}>
              <DropdownMenu.Item onSelect={() => quickInsert("mediaClip")}>{tr("Media clip")}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("audioClip")}>{tr("Audio clip")}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("propertyClip")}>
                {tr("Camera keyframes")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("adjustment")}>
                {tr("Adjustment layer")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("mask")}>{tr("Layer mask")}</DropdownMenu.Item>
              <DropdownMenu.Item disabled={!choices.length} onSelect={() => quickInsert("timelineRef")}>
                {tr("Timeline reference")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("Talk")}>{tr("command.Talk")}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => quickInsert("Wait")}>{tr("command.Wait")}</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={createNewTimeline}>{tr("New timeline")}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => setShowOptions(true)}>{tr("More commands")}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className="author-icon-button"
          aria-label={tr("Duplicate cue")}
          title={tr("Duplicate cue")}
          disabled={!cue || cue.trackLocked}
          onClick={() => cue && duplicateCue(cue)}
        >
          <Copy aria-hidden />
        </button>
        <button
          type="button"
          className="author-icon-button"
          aria-label={tr("Remove cue")}
          title={tr("Remove cue")}
          disabled={!cue || cue.trackLocked}
          onClick={() => {
            if (cue && change((node) => removeCue(node, cue.node.id, timing))) selectCue("");
          }}
        >
          <Trash2 aria-hidden />
        </button>
        <button
          type="button"
          className="author-icon-button"
          aria-label={tr("Add marker")}
          title={tr("Add marker")}
          disabled={!current}
          onClick={addMarkerAtPlayhead}
        >
          <Star aria-hidden />
        </button>
        <DropdownMenu.Root dir={i18n.dir()}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="author-button author-cue-menu-trigger"
              aria-label={tr("Timeline commands")}
              title={tr("Timeline commands")}
              disabled={!displayCues.length}
            >
              <Layers aria-hidden />
              <span>{displayCues.length}</span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="editor-file-menu timeline-cues-menu" align="start" sideOffset={6}>
              {displayCues.map((entry) => (
                <DropdownMenu.Item key={entry.node.id} onSelect={() => selectCue(entry.node.id)}>
                  <span>
                    {entry.atSeconds.toFixed(2)} s · {nameOf(entry.node)}
                  </span>
                  <span>
                    {[
                      cueLane(entry, laneNames).name,
                      entry.trackLocked && tr("authoring.locked"),
                      entry.playbackMuted && tr("Muted"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className="author-icon-button timeline-zoom-direct"
          aria-label={tr("Zoom out")}
          title={tr("Zoom out")}
          disabled={!current || !zoomApi}
          onClick={() => zoomApi?.zoomOut()}
        >
          <ZoomOut aria-hidden />
        </button>
        <button
          type="button"
          className="author-icon-button timeline-zoom-direct"
          aria-label={tr("Zoom in")}
          title={tr("Zoom in")}
          disabled={!current || !zoomApi}
          onClick={() => zoomApi?.zoomIn()}
        >
          <ZoomIn aria-hidden />
        </button>
        <button
          type="button"
          className="author-icon-button timeline-zoom-direct"
          aria-label={tr("Fit to view")}
          title={tr("Fit to view")}
          disabled={!current}
          onClick={() => setFit((value) => value + 1)}
        >
          <Maximize aria-hidden />
        </button>
        <DropdownMenu.Root dir={i18n.dir()}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="author-icon-button timeline-zoom-menu"
              aria-label={tr("Timeline zoom")}
              title={tr("Timeline zoom")}
              disabled={!current}
            >
              <ZoomIn aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="editor-file-menu" align="end" sideOffset={6}>
              <DropdownMenu.Item disabled={!zoomApi} onSelect={() => zoomApi?.zoomOut()}>
                {tr("Zoom out")}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!zoomApi} onSelect={() => zoomApi?.zoomIn()}>
                {tr("Zoom in")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => setFit((value) => value + 1)}>
                {tr("Fit to view")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className="author-icon-button"
          aria-label={tr("Settings")}
          title={tr("Settings")}
          aria-pressed={showOptions}
          aria-expanded={showOptions}
          aria-controls={optionsId}
          onClick={() => setShowOptions((open) => !open)}
        >
          <Settings2 aria-hidden />
        </button>
      </div>
    </div>
  );
  return (
    <section className="timeline-workbench" onKeyDown={onTimelineKey}>
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {!scene ? (
        <div className="empty-panel">{tr("Open a target scene first")}</div>
      ) : (
        <>
          <div className="timeline-edit-options" id={optionsId} hidden={!showOptions}>
            <div className="timeline-options-head">
              <strong>{tr("Settings")}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label={tr("Close")}
                onClick={() => setShowOptions(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="timeline-toolbar">
              <button type="button" className="secondary-button" disabled={!scene} onClick={createNewTimeline}>
                <Plus size={14} />
                {tr("New timeline")}
              </button>
              <button
                className="secondary-button"
                disabled={!groupIds.length}
                onClick={async () => {
                  try {
                    await session.groupTimelineCommands(groupIds);
                    setActiveTimeline(undefined);
                    selectCue("");
                    setFit((value) => value + 1);
                    setIssue("");
                  } catch (error) {
                    setIssue(error instanceof Error ? error.message : String(error));
                  }
                }}
              >
                {tr("Group selected commands")}
              </button>
              <button className="secondary-button" disabled={!scene} onClick={() => setShowImport(true)}>
                <Import size={14} />
                {tr("Import cues")}
              </button>
              {subtitles && (
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={tr("Download subtitles")}
                  onClick={() =>
                    downloadStudioFile(new Blob([subtitles], { type: "application/x-subrip" }), "timeline.srt")
                  }
                >
                  SRT
                </button>
              )}
            </div>
            {current && <AudioMixExport node={current} session={session} cues={cues} timing={timing} />}
            {current && (
              <details className="audio-mix-settings">
                <summary>{tr("Timeline markers")}</summary>
                <div className="timeline-toolbar">
                  <button type="button" className="secondary-button" onClick={addMarkerAtPlayhead}>
                    {tr("Add marker")}
                  </button>
                  {activeMarker && (
                    <>
                      <select
                        aria-label={tr("Timeline marker")}
                        value={activeMarker.id}
                        onChange={(event) => {
                          const value = markers.find((marker) => marker.id === event.currentTarget.value);
                          if (value) {
                            setMarkerId(value.id);
                            setMarkerFocus({ timeSeconds: value.timeSeconds });
                          }
                        }}
                      >
                        {markers.map((marker) => (
                          <option key={marker.id} value={marker.id}>
                            {marker.timeSeconds.toFixed(3)} s {marker.note}
                          </option>
                        ))}
                      </select>
                      <label>
                        {tr("Marker time (s)")}{" "}
                        <NumberInput
                          min="0"
                          step={1 / frameRate}
                          value={activeMarker.timeSeconds}
                          onCommit={(seconds) =>
                            saveMarkers((previous) =>
                              previous.map((marker) =>
                                marker.id === activeMarker.id
                                  ? { ...marker, timeSeconds: snapMarkerTime(seconds) }
                                  : marker,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        {tr("Marker note")}{" "}
                        <input
                          key={`${activeMarker.id}:${activeMarker.note}`}
                          defaultValue={activeMarker.note}
                          onBlur={(event) => {
                            const note = event.currentTarget.value.trim();
                            if (note !== activeMarker.note)
                              saveMarkers((previous) =>
                                previous.map((marker) =>
                                  marker.id === activeMarker.id ? { ...marker, note } : marker,
                                ),
                              );
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setMarkerFocus({ timeSeconds: activeMarker.timeSeconds })}
                      >
                        {tr("Go to marker")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          saveMarkers((previous) => previous.filter((marker) => marker.id !== activeMarker.id))
                        }
                      >
                        {tr("Delete marker")}
                      </button>
                    </>
                  )}
                </div>
              </details>
            )}
            <div className="timeline-settings">
              <select aria-label={tr("Command")} value={command} onChange={(event) => setCommand(event.target.value)}>
                <option value="mediaClip">{tr("Media clip")}</option>
                <option value="audioClip">{tr("Audio clip")}</option>
                <option value="propertyClip">{tr("Camera keyframes")}</option>
                <option value="adjustment">{tr("Adjustment layer")}</option>
                <option value="mask">{tr("Layer mask")}</option>
                <option value="timelineRef" disabled={!choices.length}>
                  {tr("Timeline reference")}
                </option>
                {available.map((command) => (
                  <option key={command.name} value={command.name}>
                    {command.label}
                  </option>
                ))}
              </select>
              {command === "mediaClip" && (
                <>
                  <label>
                    {tr("Media kind")}
                    <select
                      value={mediaKind}
                      onChange={(event) => {
                        setMediaKind(event.target.value as MediaKind);
                        setMediaSource(undefined);
                      }}
                    >
                      <option value="image">{tr("Image clip")}</option>
                      <option value="video">{tr("Video clip")}</option>
                    </select>
                  </label>
                  <label>
                    {tr("Media source")}
                    <input
                      list={mediaListId}
                      value={mediaSource ?? availableMedia[0]?.path ?? ""}
                      onChange={(event) => setMediaSource(event.target.value)}
                    />
                    <datalist id={mediaListId}>
                      {availableMedia.map((file) => (
                        <option key={file.path} value={file.path} />
                      ))}
                    </datalist>
                  </label>
                </>
              )}
              {command === "timelineRef" && (
                <label>
                  {tr("Timeline to insert")}
                  <select
                    value={insertSource ? sourceKey(insertSource) : ""}
                    onChange={(event) => setSourceChoice(event.target.value)}
                  >
                    {sourceOptions}
                  </select>
                </label>
              )}
              <button
                className="secondary-button"
                disabled={(command === "timelineRef" && !insertSource) || (command === "mediaClip" && !mediaToInsert)}
                onClick={add}
              >
                <Plus size={14} />
                {tr("Add cue")}
              </button>
              {current && (
                <>
                  <label>
                    {tr("Timeline name")}
                    <input
                      key={JSON.stringify([current.id, current.arguments.title])}
                      defaultValue={typeof current.arguments.title === "string" ? current.arguments.title : ""}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      onBlur={(event) => {
                        const title = event.currentTarget.value.trim();
                        if (title !== (current.arguments.title ?? ""))
                          change((node) => {
                            const { title: previous, ...args } = node.arguments;
                            return { ...node, arguments: title ? { ...args, title } : args };
                          });
                      }}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current.arguments.libraryOnly === true}
                      onChange={(event) =>
                        change((node) => ({
                          ...node,
                          arguments: { ...node.arguments, libraryOnly: event.target.checked },
                        }))
                      }
                    />
                    {tr("Play only when referenced")}
                  </label>
                  <label>
                    {tr("Minimum duration (s)")}
                    <NumberInput
                      min="0"
                      step="0.1"
                      value={Number((Number(current.arguments.durationSeconds) || 0).toFixed(3))}
                      onCommit={(value) => {
                        if (value >= 0)
                          change((node) => ({
                            ...node,
                            arguments: {
                              ...node.arguments,
                              durationSeconds: value,
                            },
                          }));
                      }}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current.arguments.waitForPrevious === true}
                      onChange={(event) =>
                        change((node) => ({
                          ...node,
                          arguments: {
                            ...node.arguments,
                            waitForPrevious: event.target.checked,
                          },
                        }))
                      }
                    />
                    {tr("Wait for previous timeline")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current.arguments.waitForCompletion === true}
                      onChange={(event) =>
                        change((node) => ({
                          ...node,
                          arguments: { ...node.arguments, waitForCompletion: event.target.checked },
                        }))
                      }
                    />
                    {tr("Wait for timeline to finish")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current.arguments.cancelOnManualAdvance === true}
                      onChange={(event) =>
                        change((node) => ({
                          ...node,
                          arguments: {
                            ...node.arguments,
                            cancelOnManualAdvance: event.target.checked,
                          },
                        }))
                      }
                    />
                    {tr("Cancel on advance")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={current.arguments.rippleScope === "timeline"}
                      onChange={(event) => {
                        const timeline = event.currentTarget.checked;
                        change((node) => {
                          const { rippleScope: _, ...rest } = node.arguments;
                          return { ...node, arguments: timeline ? { ...rest, rippleScope: "timeline" } : rest };
                        });
                      }}
                    />
                    {tr("Ripple across tracks")}
                  </label>
                </>
              )}
            </div>
            {current && (
              <details key={current.id} className="audio-mix-settings">
                <summary>{tr("Timeline tracks")}</summary>
                <form
                  className="timeline-settings"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
                    if (!name) return;
                    change((node) => addTimelineLane(node, name));
                    event.currentTarget.reset();
                  }}
                >
                  <input name="name" aria-label={tr("New track name")} placeholder={tr("New track name")} required />
                  <button className="secondary-button" type="submit">
                    <Plus size={14} />
                    {tr("Add track")}
                  </button>
                </form>
                {trackRows.map(({ id, name, laneId, laneIndex, hasAudio, hasVisual, legacyGains }) => {
                  const mix = timelineTrackState(current, id);
                  const set = (patch: Parameters<typeof setTimelineTrackState>[2]) =>
                    change((node) => setTimelineTrackState(node, id, patch));
                  return (
                    <div key={id} className="timeline-settings" role="group" aria-label={name}>
                      {laneId ? (
                        <>
                          <input
                            key={name}
                            aria-label={tr("Track name")}
                            defaultValue={name}
                            disabled={mix.locked}
                            onBlur={(event) => {
                              const next = event.currentTarget.value.trim();
                              event.currentTarget.value = next || name;
                              if (next && next !== name) change((node) => renameTimelineLane(node, laneId, next));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") event.currentTarget.value = name;
                              if (event.key === "Enter" || event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <button
                            className="icon-button"
                            aria-label={tr("Move up")}
                            title={tr("Move up")}
                            disabled={mix.locked || laneIndex === 0}
                            onClick={() => change((node) => moveTimelineLane(node, laneId, -1))}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={tr("Move down")}
                            title={tr("Move down")}
                            disabled={mix.locked || laneIndex === lanes.length - 1}
                            onClick={() => change((node) => moveTimelineLane(node, laneId, 1))}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={tr("Remove track")}
                            title={tr("Remove track")}
                            disabled={mix.locked}
                            onClick={() => change((node) => removeTimelineLane(node, laneId, timing))}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      ) : (
                        <strong>{name}</strong>
                      )}
                      <label>
                        <input
                          type="checkbox"
                          checked={mix.locked}
                          onChange={(event) => set({ locked: event.target.checked })}
                        />
                        {tr("Lock track")}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={mix.muted}
                          onChange={(event) => set({ muted: event.target.checked })}
                        />
                        {tr(hasAudio && !hasVisual ? "Mute track" : "Hide track")}
                      </label>
                      {hasAudio && (
                        <>
                          <label>
                            <input
                              type="checkbox"
                              checked={mix.solo}
                              onChange={(event) => set({ solo: event.target.checked })}
                            />
                            {tr("Solo track")}
                          </label>
                          <label>
                            {tr("Track volume")}
                            <NumberInput
                              min="0"
                              max="1"
                              step="0.05"
                              value={mix.gain}
                              placeholder={legacyGains.size === 1 ? String([...legacyGains][0]) : tr("Per clip")}
                              onClear={() => set({ gain: undefined })}
                              onCommit={(gain) => {
                                if (gain >= 0 && gain <= 1) set({ gain });
                              }}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  );
                })}
              </details>
            )}
          </div>
          <div className="timeline-body">
            <div className="timeline-track-area">
              {current && scrubDuration > 0 && (
                <input
                  type="range"
                  className="timeline-playhead-sr"
                  aria-label={tr("Timeline playhead")}
                  min={0}
                  max={scrubDuration}
                  step={1 / frameRate}
                  value={playheadSeconds}
                  disabled={!state.preview?.ready}
                  onChange={(event) => scrub(event.currentTarget.valueAsNumber)}
                />
              )}
              {!current && doc ? (
                <SceneSequence
                  session={session}
                  text={doc.text}
                  selected={state.selectedNodeId}
                  locale={timing.locale ?? "und"}
                />
              ) : (
                <CueChart
                  markers={chartMarkers}
                  markerFocus={chartMarkerFocus}
                  onMarkerMove={(id, seconds) =>
                    saveMarkers((previous) =>
                      previous.map((marker) =>
                        marker.id === id ? { ...marker, timeSeconds: snapMarkerTime(seconds - scopeStart) } : marker,
                      ),
                    )
                  }
                  key={viewTimeline?.id ?? "empty"}
                  cues={displayCues}
                  nameOf={nameOf}
                  lanes={laneNames}
                  selected={chartSelection}
                  onSelect={selectCue}
                  onMove={moveChartCue}
                  fit={fit}
                  locale={i18n.resolvedLanguage ?? "en"}
                  files={state.files}
                  playhead={current && scrubDuration > 0 ? playheadSeconds : undefined}
                  onScrub={scrub}
                  onZoomApi={setZoomApi}
                  onCueContextMenu={(cueId, point) => setContextMenu({ cueId, ...point })}
                />
              )}
            </div>
            <DropdownMenu.Root
              dir={i18n.dir()}
              open={Boolean(contextMenu && contextCue)}
              onOpenChange={(open) => {
                if (!open) setContextMenu(null);
              }}
            >
              <DropdownMenu.Trigger asChild>
                <span
                  aria-hidden
                  style={{
                    position: "fixed",
                    left: contextMenu?.x ?? 0,
                    top: contextMenu?.y ?? 0,
                    width: 1,
                    height: 1,
                    pointerEvents: "none",
                    opacity: 0,
                  }}
                />
              </DropdownMenu.Trigger>
              {contextCue && (
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="editor-file-menu" align="start" sideOffset={4}>
                    <DropdownMenu.Item onSelect={() => selectCue(contextCue.node.id)}>
                      {tr("Properties")}
                    </DropdownMenu.Item>
                    {contextReference && (
                      <DropdownMenu.Item
                        disabled={!contextReferencedSource}
                        onSelect={() =>
                          contextReferencedSource &&
                          void openSource(contextReferencedSource).catch((error) => setIssue(String(error)))
                        }
                      >
                        {tr("Edit source timeline")}
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      disabled={contextCue.trackLocked}
                      onSelect={() => duplicateCue(contextCue)}
                    >
                      {tr("Duplicate cue")}
                    </DropdownMenu.Item>
                    {contextIsVideo && (
                      <DropdownMenu.Item
                        disabled={contextCue.trackLocked || contextAudioDisabled}
                        onSelect={() =>
                          change((node) =>
                            contextLinked
                              ? linkTimelineMediaAudio(node, contextCue.node.id, timing)
                              : splitTimelineMediaAudio(node, contextCue.node.id, timing),
                          )
                        }
                      >
                        {tr(contextLinked ? "Reconnect video audio" : "Separate video audio")}
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      disabled={
                        contextCue.trackLocked || !current || gapBeforeCue(current, cues, contextCue) <= 0.000001
                      }
                      onSelect={() => change((node) => closeCueGap(node, contextCue.node.id, timing))}
                    >
                      {tr("Close preceding gap")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      disabled={contextCue.trackLocked}
                      onSelect={() => {
                        if (
                          change((node) => rippleDeleteCue(node, contextCue.node.id, timing)) &&
                          selected === contextCue.node.id
                        )
                          selectCue("");
                      }}
                    >
                      {tr("Ripple delete")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={contextCue.trackLocked}
                      onSelect={() => {
                        if (
                          change((node) => removeCue(node, contextCue.node.id, timing)) &&
                          selected === contextCue.node.id
                        )
                          selectCue("");
                      }}
                    >
                      {tr("Remove cue")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              )}
            </DropdownMenu.Root>
            <CueInspectorDock title={cue && nameOf(cue.node)} onClose={() => {
              selectCue("");
              workspaceContext?.closeInspector();
            }}>
              {reference && (
                <button
                  className="secondary-button"
                  disabled={!referencedSource}
                  onClick={() =>
                    referencedSource && void openSource(referencedSource).catch((error) => setIssue(String(error)))
                  }
                >
                  {tr("Edit source timeline")}
                </button>
              )}
              <fieldset disabled={cue?.trackLocked === true} style={{ display: "contents" }}>
                {cue && (
                  <div className="timeline-timing" key={cue.node.id}>
                    {reference && (
                      <>
                        <label style={{ gridColumn: "1 / -1" }}>
                          {tr("Source timeline")}
                          <select
                            value={referenceKey(reference)}
                            onChange={(event) => {
                              const next = choices.find((candidate) => sourceKey(candidate) === event.target.value);
                              if (!next || !current) return;
                              try {
                                const timeline = { sceneId: next.sceneId, nodeId: next.nodeId };
                                validateReferences({
                                  ...current,
                                  children: current.children?.map((child) =>
                                    child.id === reference.id
                                      ? { ...child, arguments: { ...child.arguments, timeline } }
                                      : child,
                                  ),
                                });
                                session.editArgument(reference.id, "timeline", timeline);
                                setIssue("");
                              } catch (error) {
                                setIssue(error instanceof Error ? tr(error.message) : String(error));
                              }
                            }}
                          >
                            {!referencedSource && (
                              <option value={referenceKey(reference)}>{tr("Missing source timeline")}</option>
                            )}
                            {sourceOptions}
                          </select>
                        </label>
                        {playback && (
                          <>
                            <label>
                              {tr("Instance channels")}
                              <select
                                value={String(reference.arguments.channels ?? "both")}
                                onChange={(event) => {
                                  const channels = event.target.value as "both" | "audio" | "picture";
                                  change((node) => updateTimelineInstance(node, reference.id, { channels }, timing));
                                }}
                              >
                                <option value="both">{tr("Picture and sound")}</option>
                                <option value="picture">{tr("Picture only")}</option>
                                <option value="audio">{tr("Sound only")}</option>
                              </select>
                            </label>
                            {reference.arguments.channels !== "picture" && (
                              <label>
                                {tr("Instance volume")}
                                <NumberInput
                                  value={Number(reference.arguments.gain ?? 1)}
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  onCommit={(gain) => {
                                    if (gain >= 0 && gain <= 1)
                                      change((node) => updateTimelineInstance(node, reference.id, { gain }, timing));
                                  }}
                                />
                              </label>
                            )}
                            <label>
                              {tr("Source in (s)")}
                              <NumberInput
                                min="0"
                                max={playback.end}
                                step="0.001"
                                value={playback.start}
                                onCommit={(value) =>
                                  value >= 0 &&
                                  value < playback.end &&
                                  change((node) =>
                                    updateTimelineInstance(node, reference.id, { sourceInSeconds: value }, timing),
                                  )
                                }
                                onClear={() =>
                                  change((node) =>
                                    updateTimelineInstance(node, reference.id, { sourceInSeconds: undefined }, timing),
                                  )
                                }
                              />
                            </label>
                            <label>
                              {tr("Source out (s)")}
                              <NumberInput
                                min={playback.start}
                                max={playback.sourceSeconds}
                                step="0.001"
                                value={
                                  typeof reference.arguments.sourceOutSeconds === "number" ? playback.end : undefined
                                }
                                placeholder={String(playback.sourceSeconds)}
                                onCommit={(value) =>
                                  value > playback.start &&
                                  value <= playback.sourceSeconds &&
                                  change((node) =>
                                    updateTimelineInstance(node, reference.id, { sourceOutSeconds: value }, timing),
                                  )
                                }
                                onClear={() =>
                                  change((node) =>
                                    updateTimelineInstance(node, reference.id, { sourceOutSeconds: undefined }, timing),
                                  )
                                }
                              />
                            </label>
                            <label>
                              {tr("Playback rate")} (×)
                              <NumberInput
                                min="0.001"
                                step="0.01"
                                value={playback.rate}
                                onCommit={(value) =>
                                  value > 0 &&
                                  change((node) =>
                                    updateTimelineInstance(node, reference.id, { playbackRate: value }, timing),
                                  )
                                }
                              />
                            </label>
                            <label>
                              {tr("Loop")}
                              <input
                                type="checkbox"
                                checked={Boolean(playback.loop)}
                                disabled={playback.end <= playback.start}
                                onChange={(event) => {
                                  const loopDurationSeconds = event.currentTarget.checked
                                    ? playback.duration * 2
                                    : undefined;
                                  change((node) =>
                                    updateTimelineInstance(
                                      node,
                                      reference.id,
                                      { loopDurationSeconds, loopOffsetSeconds: undefined },
                                      timing,
                                    ),
                                  );
                                }}
                              />
                            </label>
                            {playback.loop && (
                              <label>
                                {tr("Loop duration (s)")}
                                <NumberInput
                                  min="0.001"
                                  step="0.01"
                                  value={playback.duration}
                                  onCommit={(value) =>
                                    value > 0 &&
                                    change((node) =>
                                      updateTimelineInstance(
                                        node,
                                        reference.id,
                                        { loopDurationSeconds: value },
                                        timing,
                                      ),
                                    )
                                  }
                                />
                              </label>
                            )}
                            <button
                              className="secondary-button"
                              disabled={
                                reference.arguments.sourceInSeconds === undefined &&
                                reference.arguments.sourceOutSeconds === undefined &&
                                reference.arguments.playbackRate === undefined &&
                                !playback.loop
                              }
                              onClick={() =>
                                change((node) =>
                                  updateTimelineInstance(
                                    node,
                                    reference.id,
                                    {
                                      sourceInSeconds: undefined,
                                      sourceOutSeconds: undefined,
                                      playbackRate: undefined,
                                      loopDurationSeconds: undefined,
                                      loopOffsetSeconds: undefined,
                                    },
                                    timing,
                                  ),
                                )
                              }
                            >
                              {tr("Reset trim and speed")}
                            </button>
                            {reference.arguments.channels !== "audio" && (
                              <>
                                <label>
                                  {tr("Independent stage")}
                                  <input
                                    type="checkbox"
                                    checked={Boolean(reference.arguments.composition)}
                                    onChange={(event) => {
                                      const layout = state.project?.runtime.layout;
                                      const ratio =
                                        layout &&
                                        typeof layout === "object" &&
                                        !Array.isArray(layout) &&
                                        typeof layout.designViewportAspect === "number"
                                          ? layout.designViewportAspect
                                          : 16 / 9;
                                      const composition = event.currentTarget.checked
                                        ? { aspectRatio: ratio }
                                        : undefined;
                                      change((node) =>
                                        updateTimelineInstance(node, reference.id, { composition }, timing),
                                      );
                                    }}
                                  />
                                </label>
                                <TimelineCompositionFields
                                  appearance={reference.arguments.composition}
                                  durationSeconds={cue.durationSeconds}
                                  update={(composition) =>
                                    change((node) =>
                                      updateTimelineInstance(node, reference.id, { composition }, timing),
                                    )
                                  }
                                />
                              </>
                            )}
                          </>
                        )}
                        <label style={{ gridColumn: "1 / -1" }}>
                          {tr("Character bindings (source → instance)")}
                          <StructuredTextInput
                            value={reference.arguments.bindings ?? {}}
                            onChange={(value) => {
                              const bindings = value ?? {};
                              if (
                                typeof bindings !== "object" ||
                                Array.isArray(bindings) ||
                                Object.entries(bindings).some(
                                  ([from, to]) => !from.trim() || typeof to !== "string" || !to.trim(),
                                )
                              )
                                throw Error(tr("Enter a source character and an instance character for each binding."));
                              session.editNode(reference.id, (node) => {
                                const { bindings: previous, ...args } = node.arguments;
                                return {
                                  ...node,
                                  arguments: Object.keys(bindings).length ? { ...args, bindings } : args,
                                };
                              });
                            }}
                          />
                        </label>
                      </>
                    )}
                    <label>
                      {tr("Start (s)")}
                      <NumberInput
                        min={scopeStart}
                        step="0.01"
                        value={cue.atSeconds + scopeStart}
                        onCommit={(value) => value >= scopeStart && move(cue.node.id, value - scopeStart)}
                      />
                    </label>
                    <label>
                      {dialogueDuration
                        ? tr(cue.estimated ? "Estimated duration (s)" : "Fixed duration (s)")
                        : tr("Duration (s)")}
                      <NumberInput
                        min={minimumDuration}
                        step={minimumDuration || 0.01}
                        disabled={!durationField(cue.node)}
                        value={cue.durationSeconds}
                        onCommit={(value) => value >= minimumDuration && move(cue.node.id, cue.atSeconds, value)}
                      />
                    </label>
                    {dialogueDuration && !cue.estimated && (
                      <button
                        className="secondary-button"
                        onClick={() => change((node) => clearCueDurationOverride(node, cue.node.id, timing))}
                      >
                        {tr("Restore automatic duration")}
                      </button>
                    )}
                    <label>
                      {tr("Track")}
                      <select
                        value={
                          typeof cue.track.laneId === "string" && laneNames.has(cue.track.laneId)
                            ? cue.track.laneId
                            : ""
                        }
                        onChange={(event) =>
                          change((node) => assignCueLane(node, cue.node.id, event.target.value || undefined, timing))
                        }
                      >
                        <option value="">
                          {tr("Automatic")}
                          {cue.trackId.startsWith("lane:") ? "" : " · " + cueLane(cue, laneNames).name}
                        </option>
                        {lanes.map((lane) => (
                          <option
                            key={lane.id}
                            value={lane.id}
                            disabled={Boolean(current && timelineTrackState(current, `lane:${lane.id}`).locked)}
                          >
                            {lane.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {tr("Link to cue")}
                      <select
                        style={{ minWidth: 0, width: "100%" }}
                        value={anchor?.nodeId ?? ""}
                        onChange={(event) =>
                          link(
                            event.target.value
                              ? {
                                  nodeId: event.target.value,
                                  point: anchor?.point ?? "end",
                                  offsetSeconds: anchor?.offsetSeconds ?? 0,
                                }
                              : undefined,
                          )
                        }
                      >
                        <option value="">{tr("None")}</option>
                        {anchorTargets.map((target) => (
                          <option key={target.node.id} value={target.node.id}>
                            {target.atSeconds.toFixed(2)} s ·{" "}
                            {nativeNodeExcerpt(target.node, timing.locale ?? "und") || nameOf(target.node)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {anchor && (
                      <>
                        <label>
                          {tr("Link point")}
                          <select
                            value={anchor.point}
                            onChange={(event) =>
                              link({ ...anchor, point: event.target.value === "start" ? "start" : "end" })
                            }
                          >
                            <option value="start">{tr("Cue start")}</option>
                            <option value="end">{tr("Cue end")}</option>
                          </select>
                        </label>
                        <label>
                          {tr("Link offset (s)")}
                          <NumberInput
                            min="0"
                            step="0.01"
                            value={anchor.offsetSeconds}
                            onCommit={(value) => value >= 0 && link({ ...anchor, offsetSeconds: value })}
                          />
                        </label>
                      </>
                    )}
                    <label>
                      {tr("Cue lifetime")}
                      <select
                        value={cue.role}
                        onChange={(event) =>
                          change((node) =>
                            updateCue(
                              node,
                              cue.node.id,
                              cue.atSeconds,
                              undefined,
                              event.target.value as "event" | "lifetime",
                              timing,
                            ),
                          )
                        }
                      >
                        <option value="lifetime">{tr("Wait for completion")}</option>
                        <option value="event">{tr("Independent event")}</option>
                      </select>
                    </label>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        change((node) => removeCue(node, cue.node.id, timing));
                        selectCue("");
                      }}
                    >
                      <Trash2 size={14} />
                      {tr("Remove cue")}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!current || gapBeforeCue(current, cues, cue) <= 0.000001}
                      onClick={() => change((node) => closeCueGap(node, cue.node.id, timing))}
                    >
                      {tr("Close preceding gap")}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        if (change((node) => rippleDeleteCue(node, cue.node.id, timing))) selectCue("");
                      }}
                    >
                      {tr("Ripple delete")}
                    </button>
                  </div>
                )}
                {cue && isMediaClip(cue.node) ? (
                  <MediaFields
                    node={cue.node}
                    files={state.files}
                    linked={Boolean(
                      current?.children?.some(
                        (child) => isAudioClip(child) && child.arguments.linkedMediaId === cue.node.id,
                      ),
                    )}
                    update={(patch) =>
                      session.editNode(cue.node.id, (node) => ({ ...node, arguments: { ...node.arguments, ...patch } }))
                    }
                    split={() => change((node) => splitTimelineMediaAudio(node, cue.node.id, timing))}
                    reconnect={() => change((node) => linkTimelineMediaAudio(node, cue.node.id, timing))}
                  />
                ) : cue && isAdjustment(cue.node) ? (
                  <AdjustmentFields
                    key={`adjustment:${cue.node.id}`}
                    node={cue.node}
                    roots={scene.nodes}
                    files={state.files}
                    update={(key, value) => {
                      if (value !== undefined) session.editArgument(cue.node.id, key, value);
                      else
                        session.editNode(cue.node.id, (node) => {
                          const args = { ...node.arguments };
                          delete args[key];
                          if (key === "maskSource") delete args.maskChannel;
                          return { ...node, arguments: args };
                        });
                    }}
                  />
                ) : (
                  !reference && <NativeInspector session={session} statement={selectedStatement} hideHeader hideTimedAdvance />
                )}
                {cue && isAudioClip(cue.node) && (
                  <div className="timeline-timing">
                    <ClipGainFields
                      args={cue.node.arguments}
                      update={(value) => session.editArgument(cue.node.id, "gainAnimation", value)}
                    />
                  </div>
                )}
                {cue && (reference || isMediaClip(cue.node) || isAdjustment(cue.node)) && (
                  <CommandDataFields node={cue.node} session={session} />
                )}
              </fieldset>
            </CueInspectorDock>
          </div>
        </>
      )}
      {(issue || scrubIssue) && (
        <p role="alert" className="home-error">
          {issue || scrubIssue}
        </p>
      )}
      <Dialog.Root open={showImport} onOpenChange={setShowImport}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content timeline-import-dialog">
            <Dialog.Title>{tr("Import cues")}</Dialog.Title>
            <Dialog.Description>
              {tr("Paste a WebGAL or community camera script. Commands are stored in the native project format.")}
            </Dialog.Description>
            <textarea
              aria-label={tr("Source script")}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              rows={12}
            />
            {issue && <p role="alert">{issue}</p>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowImport(false)}>
                {tr("Cancel")}
              </button>
              <button className="primary-button" disabled={!source.trim() || busy} onClick={() => void importSource()}>
                {tr("Import")}
              </button>
            </div>
            <Dialog.Close className="icon-button modal-close" aria-label={tr("Close")}>
              <X size={18} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
