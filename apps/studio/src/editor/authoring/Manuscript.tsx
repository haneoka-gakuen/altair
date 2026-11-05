import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AlertCircle,
  Clapperboard,
  ClipboardPaste,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  FolderOpen,
  Image,
  ListPlus,
  Lock,
  Music,
  PersonStanding,
  Plus,
  Puzzle,
  ScrollText,
  Settings2,
  Sparkles,
  Shirt,
  SlidersHorizontal,
  Smile,
  Trash2,
  Video,
  X,
} from "@haneoka/altair-ui-react";
import { useStudioI18n } from "../i18n";
import { CastPicker, type CastPickerTab } from "./CastPicker";
import { StageDock } from "./StageDock";
import { TaskSheet } from "./TaskSheet";
import { DockPanel } from "./DockPanel";
import "./workbench.css";
import "./studio.css";

export type LineId = string;
export type LockField = "text" | "cast" | "motion" | "face" | "camera" | "audio" | "stage" | "timing";
export type NoteKind = "costume" | "motion" | "face" | "camera" | "audio" | "stage" | "timing" | "other";
export type CastOptionGroup = "costume" | "motion" | "face";

export interface CastRef {
  castId: string;
  displayName: string;
  avatar?: string;
}

/** Direction attached to a line, already phrased for the author ("Wave", "Push in on Anon"). */
export interface StudioNote {
  id: string;
  kind: NoteKind;
  label: string;
  castId?: string;
}

export interface StudioIssue {
  id: string;
  severity: "error" | "missing" | "unsupported";
  message: string;
  sceneId?: string;
  lineId?: LineId;
}

export interface StudioLine {
  id: LineId;
  kind: "speech" | "direction";
  /** Empty for narration. */
  speakers: CastRef[];
  speakerLabel?: string;
  /** Dialogue for speech lines; the author-facing summary for direction lines. */
  text: string;
  emotion?: string;
  notes: StudioNote[];
  locked: Partial<Record<LockField, boolean>>;
  issues: StudioIssue[];
}

export interface StudioScene {
  id: string;
  title: string;
  chapter?: string;
  lines: StudioLine[];
}

export interface StudioModel {
  /** At least one scene; `activeSceneId` names one of them. */
  scenes: StudioScene[];
  activeSceneId: string;
  cast: CastRef[];
  issues: StudioIssue[];
  playback: { ready: boolean; playing: boolean; lineId: LineId | null; position: number; length: number };
}

export type StudioChange =
  | { kind: "text"; text: string }
  | { kind: "speakers"; speakers: string[] }
  | { kind: "cast-option"; castId: string; group: CastOptionGroup; optionId: string }
  | { kind: "lock"; field: LockField; locked: boolean }
  | { kind: "remove-note"; noteId: string }
  | { kind: "delete" };

/** One undo step. The bridge skips locked targets and reports how many it kept. */
export interface StudioTransaction {
  sceneId: string;
  lines: LineId[];
  change: StudioChange;
}

export interface CastOption {
  id: string;
  group: CastOptionGroup;
  label: string;
  thumb?: string;
  selected?: boolean;
}

export interface CastOptionsRequest {
  sceneId: string;
  castId: string;
  group: CastOptionGroup;
  query: string;
  lines: LineId[];
}

export interface StudioBridge {
  edit(transaction: StudioTransaction): { skippedLocked: number };
  insertAfter(
    sceneId: string,
    after: LineId | null,
    line: { kind: "speech"; speakers: string[]; text: string },
  ): LineId;
  openScene(sceneId: string): void;
  options(request: CastOptionsRequest, signal: AbortSignal): Promise<CastOption[]>;
  seek(sceneId: string, lineId: LineId): void;
  play(sceneId: string, from: LineId): void;
  stop(): void;
  resume(): void;
  restart(): void;
  seekIndex(index: number): void;
  undo(): void;
  redo(): void;
}

export interface StudioSelection {
  sceneId: string;
  lines: LineId[];
  cursor: LineId | null;
}

/** A work surface that replaces the manuscript column; the stage stays mounted. */
export interface StudioDestination {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

export interface AuthoringWorkspaceProps {
  model: StudioModel;
  bridge: StudioBridge;
  /** VegaThree preview in surface-only mode; fills the frame. */
  stage: ReactNode;
  /** Native width / height of the stage. */
  stageAspect: number;
  /** Controlled source of the same document, used when `sourceEditor` is absent. */
  source?: { text: string; onChange(text: string): void };
  sourceEditor?: ReactNode;
  scriptView?: "script" | "source";
  onScriptViewChange?(view: "script" | "source"): void;
  destination?: string;
  inspectRequest?: string;
  timeline?: ReactNode;
  storyboard?: ReactNode;
  assistant?: ReactNode;
  toolRequest?: { id: string; key: "assistant" | "storyboard" };
  diagnostics?: ReactNode;
  previewTools?: ReactNode;
  destinations?: StudioDestination[];
  onDestinationChange?(id: string): void;
  /** Controlled selection. When present it is the only selection the workspace shows. */
  selection?: StudioSelection;
  onSelectionChange?(sceneId: string, lines: LineId[], cursor?: LineId | null): void;
  /** Opens the full command palette (schemas, favourites, statement groups) inserting after `after`. */
  onInsert?(sceneId: string, after: LineId | null): void;
  /** Native property editor for one or more lines. */
  renderInspector?(sceneId: string, lines: LineId[]): ReactNode;
  onLibrary?(): void;
  onHistory?(): void;
  onImport?(): void;
  onAssets?(): void;
  onTools?(): void;
  onPasteText?(text: string): void;
  notify?(message: string): void;
}

type Sheet =
  | { kind: "cast"; castId: string | null; lines: LineId[]; tab: CastPickerTab }
  | { kind: "inspect"; lines: LineId[]; nodeIds?: string[] }
  | { kind: "locks" | "timeline" | "storyboard" | "assistant" | "issues" | "paste" };

const SCRIPT = "script";
const NO_SELECTION = { lines: [] as LineId[], cursor: null as LineId | null };
const LOCK_FIELDS: LockField[] = ["text", "cast", "motion", "face", "camera", "audio", "stage", "timing"];
const FIELD_LABEL: Record<LockField, string> = {
  text: "authoring.field.text",
  cast: "Character",
  motion: "Motion",
  face: "Expression",
  camera: "Camera",
  audio: "Audio",
  stage: "Stage",
  timing: "Timeline",
};
const NOTE_LOCK: Record<NoteKind, LockField | null> = {
  costume: "cast",
  motion: "motion",
  face: "face",
  camera: "camera",
  audio: "audio",
  stage: "stage",
  timing: "timing",
  other: null,
};
const NOTE_ICON = {
  costume: Shirt,
  motion: PersonStanding,
  face: Smile,
  camera: Video,
  audio: Music,
  stage: Image,
  timing: Clock,
  other: Puzzle,
};
const LONG_PRESS_MS = 450;

const isTextTarget = (target: EventTarget) =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable='true'], .author-source") !== null;

export function AuthoringWorkspace(props: AuthoringWorkspaceProps) {
  const {
    model,
    bridge,
    stage,
    stageAspect,
    source,
    sourceEditor,
    timeline,
    storyboard,
    assistant,
    diagnostics,
    previewTools,
    destinations = [],
    onInsert,
    renderInspector,
    onLibrary,
    onHistory,
    onImport,
    onAssets,
    onTools,
    onPasteText,
    onSelectionChange,
    notify,
  } = props;
  const { t } = useStudioI18n();
  const scene = model.scenes.find((candidate) => candidate.id === model.activeSceneId)!;
  const [localView, setLocalView] = useState<"script" | "source">("script");
  const view = props.scriptView ?? localView;
  const setView = (next: "script" | "source") => {
    setLocalView(next);
    props.onScriptViewChange?.(next);
  };
  const [localDestination, setLocalDestination] = useState(SCRIPT);
  const destination = props.destination ?? localDestination;
  const setDestination = (next: string) => {
    setLocalDestination(next);
    props.onDestinationChange?.(next);
  };
  const [visited, setVisited] = useState<string[]>([]);
  const [director, setDirector] = useState(true);
  const [stageCollapsed, setStageCollapsed] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  useEffect(() => {
    if (!props.toolRequest) return;
    setSheet({ kind: props.toolRequest.key });
    setPanelCollapsed(false);
    setStageCollapsed(false);
  }, [props.toolRequest?.id]);
  const [localSelection, setLocalSelection] = useState(NO_SELECTION);
  const [touchSelecting, setTouchSelecting] = useState(false);
  const [editing, setEditing] = useState<LineId | null>(null);
  const [pasteText, setPasteText] = useState("");
  const drafts = useRef(new Map<LineId, string>());
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const anchor = useRef<LineId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<LineId | null>(null);
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  const byId = useMemo(() => new Map(scene.lines.map((line) => [line.id, line])), [scene.lines]);
  const indexOf = useMemo(() => new Map(scene.lines.map((line, index) => [line.id, index])), [scene.lines]);
  const selectionSource = props.selection
    ? props.selection.sceneId === scene.id
      ? props.selection
      : NO_SELECTION
    : localSelection;
  const selected = selectionSource.lines.filter((id) => byId.has(id));
  const current = selectionSource.cursor && byId.has(selectionSource.cursor) ? selectionSource.cursor : null;
  const hasSource = Boolean(sourceEditor || source);
  const issueCount = model.issues.length;
  const activeDestination =
    destination === SCRIPT || destinations.some((item) => item.id === destination) ? destination : SCRIPT;
  const lastLine = scene.lines[scene.lines.length - 1];

  const select = (lines: LineId[], cursor: LineId | null) => {
    setSheet((open) => (open?.kind === "inspect" && open.nodeIds ? { ...open, nodeIds: undefined } : open));
    if (!props.selection) setLocalSelection({ lines, cursor });
    onSelectionChange?.(scene.id, lines, cursor);
  };

  useEffect(() => {
    if (!props.selection) setLocalSelection(NO_SELECTION);
    anchor.current = null;
    setEditing(null);
    setTouchSelecting(false);
    setSheet((open) => (open?.kind === "cast" || open?.kind === "inspect" ? null : open));
  }, [scene.id]);
  useEffect(() => {
    if (!props.inspectRequest) return;
    setPanelCollapsed(false);
    setSheet({ kind: "inspect", lines: [], nodeIds: [props.inspectRequest] });
    setDestination(SCRIPT);
    setView("script");
  }, [props.inspectRequest]);

  useEffect(() => {
    if (pendingFocus.current && byId.has(pendingFocus.current)) {
      const id = pendingFocus.current;
      pendingFocus.current = null;
      anchor.current = id;
      select([id], id);
      requestAnimationFrame(() => focusLine(id));
    }
  }, [byId]);

  useEffect(() => {
    if (current && !model.playback.playing) bridge.seek(scene.id, current);
  }, [bridge, scene.id, current]);
  useEffect(() => {
    if (current)
      listRef.current
        ?.querySelector<HTMLElement>(`[data-line="${CSS.escape(current)}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scene.id, current]);

  const apply = (lines: LineId[], change: StudioChange) => {
    try {
      const { skippedLocked } = bridge.edit({ sceneId: scene.id, lines, change });
      if (skippedLocked > 0) notify?.(t("authoring.skippedLocked", { count: skippedLocked }));
      return skippedLocked === 0;
    } catch (error) {
      notify?.(t(error instanceof Error ? error.message : String(error)));
      return false;
    }
  };

  const commit = (id: LineId) => {
    const draft = drafts.current.get(id);
    if (draft === undefined) return;
    if (draft === byId.get(id)?.text || apply([id], { kind: "text", text: draft })) drafts.current.delete(id);
  };

  /** Commits the open line before anything else takes focus or changes scope. */
  const flush = () => {
    if (!editing) return;
    commit(editing);
    setEditing(null);
  };

  const openSheet = (next: Sheet) => {
    flush();
    if ((next.kind === "storyboard" || next.kind === "timeline") && destination !== SCRIPT) {
      bridge.openScene(scene.id);
      setDestination(SCRIPT);
    }
    setPanelCollapsed(false);
    setSheet(next);
  };
  const closePanel = () => {
    setSheet(null);
    setPanelCollapsed(true);
  };

  const goTo = (id: string) => {
    flush();
    setSheet(null);
    setDestination(id);
    if (id !== SCRIPT && !visited.includes(id)) setVisited((list) => [...list, id]);
  };

  const focusLine = (id: LineId) =>
    listRef.current?.querySelector<HTMLElement>(`[data-line="${CSS.escape(id)}"] [data-cell="text"]`)?.focus();

  const targets = (id: LineId) => (selected.includes(id) && selected.length > 1 ? selected : [id]);

  const choose = (id: LineId, mode: "replace" | "toggle" | "range") => {
    const from = anchor.current && byId.has(anchor.current) ? anchor.current : current;
    if (mode === "range" && from) {
      const start = Math.min(indexOf.get(from)!, indexOf.get(id)!);
      const end = Math.max(indexOf.get(from)!, indexOf.get(id)!);
      select(
        scene.lines.slice(start, end + 1).map((line) => line.id),
        id,
      );
      return;
    }
    anchor.current = id;
    if (mode === "toggle")
      select(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id], id);
    else select([id], id);
  };

  const startEditing = (line: StudioLine) => {
    if (line.kind !== "speech") return;
    if (line.locked.text) {
      notify?.(t("authoring.skippedLocked", { count: 1 }));
      return;
    }
    if (!drafts.current.has(line.id)) drafts.current.set(line.id, line.text);
    setEditing(line.id);
  };

  const inspect = (line: StudioLine, nodeId?: string) => {
    if (renderInspector) {
      if (!selected.includes(line.id) || (nodeId && selected.length > 1)) select([line.id], line.id);
      openSheet({ kind: "inspect", lines: targets(line.id), ...(nodeId ? { nodeIds: [nodeId] } : {}) });
    }
  };

  const play = () => {
    flush();
    const from = current ?? scene.lines[0]?.id;
    if (from) bridge.play(scene.id, from);
  };

  const addLine = (after: LineId | null, speakers: string[]) => {
    try {
      const id = bridge.insertAfter(scene.id, after, { kind: "speech", speakers, text: "" });
      drafts.current.set(id, "");
      anchor.current = id;
      select([id], id);
      setEditing(id);
    } catch (error) {
      notify?.(t(error instanceof Error ? error.message : String(error)));
    }
  };

  const insertAfter = current ?? lastLine?.id ?? null;
  const insertCommand = () => {
    flush();
    onInsert!(scene.id, insertAfter);
  };

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  const openCast = (line: StudioLine, castId: string | null, tab: CastPickerTab) => {
    if (!selected.includes(line.id)) select([line.id], line.id);
    openSheet({ kind: "cast", castId, lines: targets(line.id), tab });
  };

  const onWorkbenchKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const target = event.target as Element;
    if (target.closest(".author-sheet, .author-panel")) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      play();
      return;
    }
    if (isTextTarget(target)) return;
    const row = target.closest<HTMLElement>("[data-line]");
    if (event.key === " " && !target.closest("button, a, summary")) {
      event.preventDefault();
      if (model.playback.playing) bridge.stop();
      else bridge.resume();
    } else if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) bridge.redo();
      else bridge.undo();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      bridge.redo();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && row) {
      event.preventDefault();
      const next = scene.lines[indexOf.get(row.dataset.line!)! + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        choose(next.id, event.shiftKey ? "range" : "replace");
        focusLine(next.id);
      }
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && row) {
      const cells = [...row.querySelectorAll<HTMLElement>("[data-nav]")];
      const next = cells[cells.indexOf(target as HTMLElement) + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    } else if ((event.key === "Enter" || event.key === "F2") && row && !target.closest("button")) {
      event.preventDefault();
      const line = byId.get(row.dataset.line!)!;
      if (line.kind === "speech") startEditing(line);
      else inspect(line);
    } else if (event.key === "Escape" && selected.length > 0) {
      select(current ? [current] : [], current);
      setTouchSelecting(false);
    }
  };

  const tools = (
    <>
      {onAssets && (
        <button
          type="button"
          className="author-icon-button"
          aria-label={t("Assets")}
          title={t("Assets")}
          onClick={() => {
            flush();
            onAssets();
          }}
        >
          <FolderOpen aria-hidden />
        </button>
      )}
      {onTools && (
        <button
          type="button"
          className="author-icon-button"
          aria-label={t("Properties")}
          title={t("Properties")}
          onClick={() => {
            flush();
            onTools();
          }}
        >
          <Settings2 aria-hidden />
        </button>
      )}
      {onLibrary && (
        <button
          type="button"
          className="author-button"
          onClick={() => {
            flush();
            onLibrary();
          }}
        >
          {t("Command library")}
        </button>
      )}
      {onHistory && (
        <button
          type="button"
          className="author-button"
          onClick={() => {
            flush();
            onHistory();
          }}
        >
          {t("Version history")}
        </button>
      )}
      {previewTools}
      <button
        type="button"
        className="author-icon-button"
        aria-pressed={director}
        aria-label={t("authoring.director")}
        title={t("authoring.director")}
        onClick={() => setDirector((value) => !value)}
      >
        <Clapperboard aria-hidden />
      </button>
      {timeline && (
        <button
          type="button"
          className="author-icon-button"
          aria-label={t("Timeline")}
          title={t("Timeline")}
          onClick={() => openSheet({ kind: "timeline" })}
        >
          <Clock aria-hidden />
        </button>
      )}
      {assistant && (
        <button type="button" className="author-button" onClick={() => openSheet({ kind: "assistant" })}>
          <Sparkles aria-hidden />
          {t("ai.assistant")}
        </button>
      )}
      {storyboard && (
        <button
          type="button"
          className="author-icon-button"
          aria-label={t("Storyboard")}
          title={t("Storyboard")}
          onClick={() => openSheet({ kind: "storyboard" })}
        >
          <Film aria-hidden />
        </button>
      )}
      {(issueCount > 0 || diagnostics) && (
        <button
          type="button"
          className="author-icon-button author-issue-button"
          aria-label={t("authoring.issues")}
          title={t("authoring.issues")}
          onClick={() => openSheet({ kind: "issues" })}
        >
          <AlertCircle aria-hidden />
          {issueCount > 0 && <span className="author-badge">{issueCount}</span>}
        </button>
      )}
    </>
  );

  const sheetLines =
    sheet?.kind === "cast" || sheet?.kind === "inspect"
      ? (selected.length ? selected : sheet.lines)
          .map((id) => byId.get(id))
          .filter((line): line is StudioLine => line !== undefined)
      : [];
  const playingId = model.playback.playing ? model.playback.lineId : null;
  const inspectorIds = sheet?.kind === "inspect" ? (sheet.nodeIds ?? sheetLines.map((line) => line.id)) : [];
  const rowFocus = current ?? scene.lines[0]?.id;
  const selecting = view === "script" && (selected.length > 1 || touchSelecting);
  const activePanel = !panelCollapsed && sheet && sheet.kind !== "paste" && sheet.kind !== "timeline";
  const inspectorNavigation = (
    <>
      {([-1, 1] as const).map((step) => {
        const next = scene.lines[(current ? indexOf.get(current)! : 0) + step];
        const label = t(step < 0 ? "Previous line" : "Next line");
        return (
          <button
            type="button"
            key={step}
            className="author-icon-button"
            aria-label={label}
            title={label}
            disabled={!next}
            onClick={() => choose(next!.id, "replace")}
          >
            {step < 0 ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
          </button>
        );
      })}
    </>
  );

  return (
    <div
      className={`${destinations.length > 0 ? "author-workbench has-destinations" : "author-workbench"}${sheet?.kind === "timeline" ? " has-timeline" : ""}${activePanel ? " has-active-panel" : ""}`}
      onKeyDown={onWorkbenchKey}
    >
      {destinations.length > 0 && (
        <nav className="author-destinations" aria-label={t("authoring.destinations")}>
          {[{ id: SCRIPT, label: t("authoring.script"), icon: <ScrollText /> }, ...destinations].map((item) => (
            <button
              key={item.id}
              type="button"
              className="author-destination-button"
              aria-current={activeDestination === item.id ? "page" : undefined}
              onClick={() => goTo(item.id)}
            >
              <span className="author-destination-icon" aria-hidden>
                {item.icon}
              </span>
              <span className="author-destination-label">{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="author-work">
        <section className="author-manuscript" aria-label={t("authoring.script")} hidden={activeDestination !== SCRIPT}>
          <div className="author-manuscript-head">
            {model.scenes.length > 1 ? (
              <select
                className="author-scene-select"
                aria-label={t("Scene")}
                value={scene.id}
                onChange={(event) => {
                  flush();
                  bridge.openScene(event.target.value);
                }}
              >
                {model.scenes.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.chapter ? `${option.chapter} / ${option.title}` : option.title}
                  </option>
                ))}
              </select>
            ) : (
              <h2 className="author-scene-title">{scene.title}</h2>
            )}
            {hasSource && (
              <div className="author-segmented" role="tablist">
                <button type="button" role="tab" aria-selected={view === "script"} onClick={() => setView("script")}>
                  {t("authoring.script")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "source"}
                  onClick={() => {
                    flush();
                    setView("source");
                  }}
                >
                  {t("authoring.source")}
                </button>
              </div>
            )}
          </div>

          {view === "source" ? (
            <div className="author-source">
              {sourceEditor ?? (
                <textarea
                  className="author-source-text"
                  spellCheck={false}
                  aria-label={t("authoring.source")}
                  value={source!.text}
                  onChange={(event) => source!.onChange(event.target.value)}
                />
              )}
            </div>
          ) : scene.lines.length === 0 ? (
            <div className="author-empty">
              <button type="button" className="author-button author-button--filled" onClick={() => addLine(null, [])}>
                <Plus aria-hidden />
                {t("authoring.addLine")}
              </button>
              {onPasteText && (
                <button
                  type="button"
                  className="author-button author-button--tonal"
                  onClick={() => openSheet({ kind: "paste" })}
                >
                  <ClipboardPaste aria-hidden />
                  {t("authoring.pasteText")}
                </button>
              )}
              {onImport && (
                <button type="button" className="author-button author-button--tonal" onClick={onImport}>
                  <FolderOpen aria-hidden />
                  {t("Import")}
                </button>
              )}
            </div>
          ) : (
            <div ref={listRef} className="author-lines-scroll" onScroll={cancelPress}>
              <div
                className={director ? "author-lines is-directing" : "author-lines"}
                role="grid"
                aria-multiselectable
                aria-label={scene.title}
                aria-rowcount={scene.lines.length}
              >
                {scene.lines.map((line, index) => {
                  const isSelected = selected.includes(line.id);
                  const lockedFields = LOCK_FIELDS.filter((field) => line.locked[field]);
                  const classes = ["author-line", `author-line--${line.kind}`];
                  if (isSelected) classes.push("is-selected");
                  if (line.issues.length > 0) classes.push("has-issue");
                  if (line.id === playingId) classes.push("is-playing");
                  const speakerNames =
                    line.speakerLabel ??
                    (line.speakers.map((speaker) => speaker.displayName).join(t("authoring.speakerJoin")) ||
                      t("Narration"));
                  return (
                    <div
                      key={line.id}
                      data-line={line.id}
                      className={classes.join(" ")}
                      role="row"
                      aria-rowindex={index + 1}
                      aria-selected={isSelected}
                      onPointerDown={(event) => {
                        if (event.pointerType !== "touch") return;
                        cancelPress();
                        press.current = {
                          x: event.clientX,
                          y: event.clientY,
                          timer: window.setTimeout(() => {
                            press.current = null;
                            pressed.current = true;
                            setTouchSelecting(true);
                            choose(line.id, "toggle");
                          }, LONG_PRESS_MS),
                        };
                      }}
                      onPointerMove={(event) => {
                        if (
                          press.current &&
                          Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10
                        )
                          cancelPress();
                      }}
                      onPointerUp={cancelPress}
                      onPointerCancel={cancelPress}
                      onContextMenu={(event) => {
                        if (pressed.current) event.preventDefault();
                      }}
                      onClick={(event) => {
                        if (pressed.current) {
                          pressed.current = false;
                          return;
                        }
                        if ((event.target as Element).closest("button, textarea")) return;
                        if (event.shiftKey) choose(line.id, "range");
                        else if (event.ctrlKey || event.metaKey || touchSelecting) choose(line.id, "toggle");
                        else if (
                          current === line.id &&
                          selected.length === 1 &&
                          line.kind === "speech" &&
                          (event.target as Element).closest(".author-line-text")
                        )
                          startEditing(line);
                        else choose(line.id, "replace");
                      }}
                      onDoubleClick={(event) => {
                        if ((event.target as Element).closest("button, textarea")) return;
                        if (line.kind === "speech") startEditing(line);
                        else inspect(line);
                      }}
                    >
                      <span className="author-line-gutter" role="gridcell">
                        {line.issues.length > 0 ? (
                          <AlertCircle aria-label={t("authoring.issues")} />
                        ) : lockedFields.length > 0 ? (
                          <Lock aria-label={t("authoring.locked")} />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <span className="author-line-who" role="gridcell">
                        {line.kind === "speech" ? (
                          <button
                            type="button"
                            className="author-speaker"
                            data-nav
                            tabIndex={-1}
                            onClick={() => openCast(line, line.speakers[0]?.castId ?? null, "character")}
                          >
                            {speakerNames}
                            {line.emotion && <span className="author-emotion">{line.emotion}</span>}
                          </button>
                        ) : (
                          <span className="author-direction-mark">
                            <Image aria-hidden />
                          </span>
                        )}
                      </span>
                      <div className="author-line-body" role="gridcell">
                        {editing === line.id ? (
                          <LineEditor
                            initial={drafts.current.get(line.id) ?? line.text}
                            label={speakerNames}
                            onDraft={(text) => drafts.current.set(line.id, text)}
                            onDone={(how) => {
                              const text = drafts.current.get(line.id) ?? line.text;
                              commit(line.id);
                              setEditing(null);
                              if (how === "next" && text.trim())
                                addLine(
                                  line.id,
                                  line.speakers.map((speaker) => speaker.castId),
                                );
                              else if (how === "done") focusLine(line.id);
                            }}
                            onCancel={() => {
                              drafts.current.delete(line.id);
                              setEditing(null);
                              focusLine(line.id);
                            }}
                          />
                        ) : (
                          <p
                            className="author-line-text"
                            data-cell="text"
                            data-nav
                            tabIndex={line.id === rowFocus ? 0 : -1}
                          >
                            {line.text}
                          </p>
                        )}
                        {lockedFields.length > 0 && (
                          <p className="author-line-locks">
                            <Lock aria-hidden />
                            {t("authoring.lineLocked", {
                              fields: lockedFields.map((field) => t(FIELD_LABEL[field])).join(t("authoring.listJoin")),
                            })}
                          </p>
                        )}
                        {director && line.notes.length > 0 && (
                          <ul className="author-notes">
                            {line.notes.map((note) => {
                              const Icon = NOTE_ICON[note.kind];
                              const lockField = NOTE_LOCK[note.kind];
                              const locked = lockField !== null && line.locked[lockField] === true;
                              const pickable =
                                note.castId !== undefined &&
                                (note.kind === "costume" || note.kind === "motion" || note.kind === "face");
                              const opens = pickable || renderInspector !== undefined || timeline !== undefined;
                              return (
                                <li key={note.id} className={locked ? "author-note is-locked" : "author-note"}>
                                  {opens ? (
                                    <button
                                      type="button"
                                      className="author-note-main"
                                      data-nav
                                      tabIndex={-1}
                                      onClick={() => {
                                        if (pickable) openCast(line, note.castId!, note.kind as CastOptionGroup);
                                        else if (renderInspector) inspect(line, note.id);
                                        else {
                                          choose(line.id, "replace");
                                          openSheet({ kind: "timeline" });
                                        }
                                      }}
                                    >
                                      <Icon aria-hidden />
                                      {note.label}
                                      {locked && <Lock aria-label={t("authoring.locked")} />}
                                    </button>
                                  ) : (
                                    <span className="author-note-main">
                                      <Icon aria-hidden />
                                      {note.label}
                                      {locked && <Lock aria-label={t("authoring.locked")} />}
                                    </span>
                                  )}
                                  {!locked && (
                                    <button
                                      type="button"
                                      className="author-note-remove"
                                      data-nav
                                      tabIndex={-1}
                                      aria-label={t("authoring.removeNote", { label: note.label })}
                                      onClick={() => apply([line.id], { kind: "remove-note", noteId: note.id })}
                                    >
                                      <X aria-hidden />
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <span className="author-line-actions" role="gridcell">
                        {renderInspector && (
                          <button
                            type="button"
                            className="author-icon-button"
                            data-nav
                            tabIndex={-1}
                            aria-label={t("authoring.details")}
                            title={t("authoring.details")}
                            onClick={() => inspect(line)}
                          >
                            <SlidersHorizontal aria-hidden />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {view === "script" && (
            <div className="author-manuscript-foot">
              {selecting ? (
                <div className="author-selection" role="toolbar" aria-label={t("Selected")}>
                  <span className="author-selection-count">
                    {t("authoring.selectedCount", { count: selected.length })}
                  </span>
                  {selected.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="author-icon-button"
                        aria-label={t("Character")}
                        title={t("Character")}
                        onClick={() => {
                          const first = byId.get(selected[0]!)!;
                          openSheet({
                            kind: "cast",
                            castId: first.speakers[0]?.castId ?? null,
                            lines: selected,
                            tab: "character",
                          });
                        }}
                      >
                        <Shirt aria-hidden />
                      </button>
                      {renderInspector && (
                        <button
                          type="button"
                          className="author-icon-button"
                          aria-label={t("authoring.details")}
                          title={t("authoring.details")}
                          onClick={() => openSheet({ kind: "inspect", lines: selected })}
                        >
                          <SlidersHorizontal aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        className="author-icon-button"
                        aria-label={t("authoring.locks")}
                        title={t("authoring.locks")}
                        onClick={() => openSheet({ kind: "locks" })}
                      >
                        <Lock aria-hidden />
                      </button>
                      {timeline && (
                        <button
                          type="button"
                          className="author-icon-button"
                          aria-label={t("Timeline")}
                          title={t("Timeline")}
                          onClick={() => openSheet({ kind: "timeline" })}
                        >
                          <Clock aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        className="author-icon-button"
                        aria-label={t("Delete")}
                        title={t("Delete")}
                        onClick={() => {
                          if (apply(selected, { kind: "delete" })) select([], null);
                        }}
                      >
                        <Trash2 aria-hidden />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="author-icon-button"
                    aria-label={t("authoring.clearSelection")}
                    title={t("authoring.clearSelection")}
                    onClick={() => {
                      select(current ? [current] : [], current);
                      setTouchSelecting(false);
                    }}
                  >
                    <X aria-hidden />
                  </button>
                </div>
              ) : (
                <div className="author-insert">
                  <button
                    type="button"
                    className="author-button author-button--tonal"
                    onClick={() => {
                      flush();
                      addLine(
                        insertAfter,
                        insertAfter ? byId.get(insertAfter)!.speakers.map((speaker) => speaker.castId) : [],
                      );
                    }}
                  >
                    <Plus aria-hidden />
                    {t("authoring.addLine")}
                  </button>
                  {onInsert && (
                    <button type="button" className="author-button author-button--tonal" onClick={insertCommand}>
                      <ListPlus aria-hidden />
                      {t("authoring.insertCommand")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {destinations
          .filter((item) => visited.includes(item.id) || item.id === activeDestination)
          .map((item) => (
            <section
              key={item.id}
              className="author-destination"
              aria-label={item.label}
              hidden={activeDestination !== item.id}
            >
              {item.content}
            </section>
          ))}
      </div>

      <div
        className="author-companion"
        data-has-panel={!panelCollapsed && (Boolean(sheet && sheet.kind !== "paste") || selected.length > 0)}
      >
        <StageDock
          key="stage"
          stage={stage}
          aspect={stageAspect}
          collapsed={stageCollapsed}
          playing={model.playback.playing}
          position={Math.max(
            0,
            scene.lines.findIndex((line) => line.id === (model.playback.lineId ?? current)),
          )}
          length={scene.lines.length}
          canPlay={scene.lines.length > 0 && model.playback.ready}
          speakers={current ? byId.get(current)!.speakers : []}
          tools={tools}
          onToggleCollapsed={() => setStageCollapsed((value) => !value)}
          onPlay={play}
          onResume={() => bridge.resume()}
          onRestart={() => bridge.restart()}
          onSeek={(index) => {
            const line = scene.lines[index];
            if (line) bridge.seek(scene.id, line.id);
          }}
          onStop={() => bridge.stop()}
        />

        <div className="author-inspector" data-panel={sheet?.kind ?? "inspect"}>
          {!panelCollapsed && (!sheet || sheet.kind === "timeline") && renderInspector && selected.length > 0 && (
            <DockPanel title={t("Properties")} actions={inspectorNavigation} onClose={closePanel}>
              {renderInspector(scene.id, selected)}
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "cast" && sheetLines.length > 0 && (
            <DockPanel
              title={
                sheetLines.length > 1 ? t("authoring.selectedCount", { count: sheetLines.length }) : t("Character")
              }
              onClose={closePanel}
            >
              <CastPicker
                key={`${scene.id}:${sheetLines.map((line) => line.id).join(",")}`}
                bridge={bridge}
                sceneId={scene.id}
                cast={model.cast}
                castId={sheet.castId}
                lines={sheetLines}
                initialTab={sheet.tab}
                onApply={(change) =>
                  apply(
                    sheetLines.map((line) => line.id),
                    change,
                  )
                }
                onAdd={
                  onAssets
                    ? () => {
                        setSheet(null);
                        onAssets();
                      }
                    : undefined
                }
              />
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "inspect" && renderInspector && inspectorIds.length > 0 && (
            <DockPanel
              title={
                sheetLines.length > 1
                  ? t("authoring.selectedCount", { count: sheetLines.length })
                  : t("authoring.details")
              }
              onClose={closePanel}
              actions={inspectorNavigation}
            >
              {renderInspector(scene.id, inspectorIds)}
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "locks" && (
            <DockPanel title={t("authoring.locks")} onClose={closePanel}>
              <div className="author-lock-grid">
                {LOCK_FIELDS.map((field) => {
                  const count = selected.filter((id) => byId.get(id)!.locked[field]).length;
                  const all = selected.length > 0 && count === selected.length;
                  return (
                    <button
                      key={field}
                      type="button"
                      className="author-lock-toggle"
                      aria-pressed={all ? true : count > 0 ? "mixed" : false}
                      onClick={() => apply(selected, { kind: "lock", field, locked: !all })}
                    >
                      <Lock aria-hidden />
                      {t(FIELD_LABEL[field])}
                    </button>
                  );
                })}
              </div>
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "assistant" && (
            <DockPanel title={t("ai.assistant")} onClose={closePanel}>
              {assistant}
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "storyboard" && (
            <DockPanel title={t("Storyboard")} onClose={closePanel}>
              {storyboard}
            </DockPanel>
          )}
          {!panelCollapsed && sheet?.kind === "issues" && (
            <DockPanel title={t("authoring.issues")} onClose={closePanel}>
              <ul className="author-issues">
                {model.issues.map((issue) => (
                  <li key={issue.id}>
                    {issue.lineId ? (
                      <button
                        type="button"
                        className={`author-issue author-issue--${issue.severity}`}
                        onClick={() => {
                          const lineId = issue.lineId!;
                          setSheet(null);
                          setView("script");
                          setDestination(SCRIPT);
                          if (issue.sceneId && issue.sceneId !== scene.id) {
                            pendingFocus.current = lineId;
                            bridge.openScene(issue.sceneId);
                          } else {
                            choose(lineId, "replace");
                            requestAnimationFrame(() => focusLine(lineId));
                          }
                        }}
                      >
                        <AlertCircle aria-hidden />
                        {issue.message}
                      </button>
                    ) : (
                      <p className={`author-issue author-issue--${issue.severity}`}>
                        <AlertCircle aria-hidden />
                        {issue.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {diagnostics}
            </DockPanel>
          )}
        </div>
      </div>
      {sheet?.kind === "timeline" && (
        <DockPanel timeline title={t("Timeline")} onClose={() => setSheet(null)}>
          {timeline}
        </DockPanel>
      )}
      {sheet?.kind === "paste" && (
        <TaskSheet title={t("authoring.pasteText")} onClose={() => setSheet(null)}>
          <form
            className="author-paste"
            onSubmit={(event) => {
              event.preventDefault();
              onPasteText!(pasteText);
              setPasteText("");
              setSheet(null);
            }}
          >
            <textarea
              aria-label={t("authoring.pasteText")}
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <button type="submit" className="author-button author-button--filled" disabled={!pasteText.trim()}>
              {t("authoring.pasteTextAction")}
            </button>
          </form>
        </TaskSheet>
      )}
    </div>
  );
}

interface LineEditorProps {
  initial: string;
  label: string;
  onDraft(text: string): void;
  /** "next": Enter, continue with a new line; "done": explicit finish; "blur": focus left. */
  onDone(how: "next" | "done" | "blur"): void;
  onCancel(): void;
}

function LineEditor({ initial, label, onDraft, onDone, onCancel }: LineEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const field = ref.current!;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const finish = (how: "next" | "done" | "blur") => {
    if (done.current) return;
    done.current = true;
    onDone(how);
  };

  return (
    <textarea
      ref={ref}
      className="author-line-input"
      rows={1}
      aria-label={label}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        onDraft(event.target.value);
      }}
      onBlur={() => finish("blur")}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          finish("next");
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}
