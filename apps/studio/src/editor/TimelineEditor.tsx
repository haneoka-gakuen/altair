import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Import, Maximize, Trash2, X } from "lucide-react";
import { DataSet } from "vis-data";
import { Timeline, type DataItem, type TimelineOptions } from "vis-timeline/peer";
import "vis-timeline/styles/vis-timeline-graph2d.css";
import { parseAltairSceneDocument, serializeAuthoredText, type AltairAuthoredNode } from "@haneoka/altair";
import { NativeInspector } from "./NativeInspector";
import { nativeCommands, nativeNodeLabel, type EditorStatement } from "./native-project";
import type { EditorSession } from "./session";
import {
  createTimeline,
  cueDuration,
  durationField,
  importTimelineScript,
  isTimeline,
  removeCue,
  timelineCues,
  updateCue,
  type TimelineCue,
} from "./timeline-model";
import { tr, useStudioI18n } from "./i18n";

const nameOf = nativeNodeLabel;
const laneOf = (node: AltairAuthoredNode) =>
  String(
    node.arguments.targetName ||
      nativeCommands.find((command) => command.name === node.type.name)?.category ||
      tr("Stage"),
  );
const escapedContent = (text: string) => {
  const element = document.createElement("span");
  element.textContent = text;
  return element.innerHTML;
};

function CueChart({
  cues,
  selected,
  onSelect,
  onMove,
  fit,
  locale,
}: {
  cues: readonly TimelineCue[];
  selected: string;
  onSelect: (id: string) => void;
  onMove: (id: string, start: number, duration?: number) => void;
  fit: number;
  locale: string;
}) {
  const mount = useRef<HTMLDivElement>(null),
    timeline = useRef<Timeline>(undefined),
    items = useRef(new DataSet<DataItem>());
  const callbacks = useRef({ onSelect, onMove });
  useEffect(() => {
    callbacks.current = { onSelect, onMove };
  }, [onSelect, onMove]);
  useEffect(() => {
    if (!mount.current) return;
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
      editable: {
        add: false,
        remove: false,
        updateTime: true,
        updateGroup: false,
      },
      snap: (date) => new Date(Math.max(0, Math.round(Number(date) / 10) * 10)),
      format: {
        minorLabels: (date) => `${(Number(date) / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} s`,
      },
      onMove: (item, done) => {
        const start = Math.max(0, Number(item.start) / 1000),
          duration = item.end === undefined ? undefined : Math.max(0, Number(item.end) / 1000 - start);
        callbacks.current.onMove(String(item.id), start, duration);
        done(item);
      },
    };
    const view = new Timeline(mount.current, items.current, [], options);
    timeline.current = view;
    view.on("select", (event) =>
      callbacks.current.onSelect(event.items[0] === undefined ? "" : String(event.items[0])),
    );
    return () => {
      timeline.current = undefined;
      view.destroy();
    };
  }, [locale]);
  useEffect(() => {
    const ids = new Set(cues.map((cue) => cue.node.id));
    items.current.remove(items.current.getIds().filter((id) => !ids.has(String(id))));
    items.current.update(
      cues.map((cue) => ({
        id: cue.node.id,
        group: laneOf(cue.node),
        content: escapedContent(nameOf(cue.node)),
        start: new Date(cue.atSeconds * 1000),
        end: cue.durationSeconds > 0 ? new Date((cue.atSeconds + cue.durationSeconds) * 1000) : undefined,
        type: cue.durationSeconds > 0 ? "range" : "box",
        className: `timeline-cue ${cue.role}`,
      })),
    );
    timeline.current?.setGroups(
      [...new Set(cues.map((cue) => laneOf(cue.node)))].map((id) => ({
        id,
        content: escapedContent(tr(id)),
      })),
    );
  }, [cues, locale]);
  useEffect(() => {
    timeline.current?.setSelection(selected ? [selected] : []);
  }, [selected]);
  useEffect(() => {
    const seconds = Math.max(5, ...cues.map((cue) => cue.atSeconds + cue.durationSeconds));
    timeline.current?.setWindow(0, seconds * 1100, { animation: false });
  }, [fit]);
  return <div ref={mount} className="timeline-canvas" aria-label={tr("Cue timeline")} />;
}

export function TimelineEditor({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { i18n } = useStudioI18n();
  const doc = session.document();
  const [selected, setSelected] = useState(""),
    [fit, setFit] = useState(0),
    [command, setCommand] = useState("Pan"),
    [showImport, setShowImport] = useState(false),
    [source, setSource] = useState(""),
    [issue, setIssue] = useState(""),
    [busy, setBusy] = useState(false);
  const scene = useMemo(() => {
    try {
      return parseAltairSceneDocument(doc?.text ?? "");
    } catch {
      return undefined;
    }
  }, [doc?.text]);
  const timelines = scene?.nodes.filter(isTimeline) ?? [];
  const current = timelines.find((node) => node.id === state.selectedNodeId) ?? timelines[0];
  const cues = useMemo(() => {
    try {
      return current ? timelineCues(current) : [];
    } catch {
      return [];
    }
  }, [current]);
  const cue = cues.find((cue) => cue.node.id === selected);
  const available = nativeCommands.filter(
    (command) =>
      ["camera", "stage", "audio", "timing", "transition", "character"].includes(command.category) &&
      command.name !== "Timeline",
  );
  const change = (update: (node: AltairAuthoredNode) => AltairAuthoredNode) => {
    if (current)
      try {
        session.editNode(current.id, update);
        setIssue("");
      } catch (error) {
        setIssue(String(error));
      }
  };
  const move = (id: string, start: number, duration?: number) => change((node) => updateCue(node, id, start, duration));
  const add = () => {
    const definition = nativeCommands.find((item) => item.name === command);
    if (!definition) return;
    const child = definition.initial();
    if (!current) {
      session.insert(createTimeline([child]));
      const inserted = session.statements().find((statement) => statement.id === session.getSnapshot().selectedNodeId);
      setSelected(inserted?.node.children?.[0]?.id ?? "");
      setFit((value) => value + 1);
      return;
    }
    change((node) => ({
      ...node,
      children: [...(node.children ?? []), child],
      arguments: {
        ...node.arguments,
        tracks: [
          ...(Array.isArray(node.arguments.tracks) ? node.arguments.tracks : []),
          { nodeId: child.id, atSeconds: 0, role: "lifetime" },
        ],
      },
    }));
    setSelected(child.id);
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
      setSelected("");
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
  return (
    <section className="timeline-workbench">
      <div className="timeline-toolbar">
        <select
          aria-label={tr("Active timeline")}
          value={current?.id ?? ""}
          onChange={(event) => {
            const statement = session.statements().find((item) => item.id === event.target.value);
            if (statement) session.select(statement.line);
            setSelected("");
            setFit((value) => value + 1);
          }}
        >
          {!timelines.length && <option value="">{tr("No timeline yet")}</option>}
          {timelines.map((node, index) => (
            <option key={node.id} value={node.id}>
              {tr("Timeline")} {index + 1}
            </option>
          ))}
        </select>
        <button
          className="secondary-button"
          disabled={!scene}
          onClick={() => {
            session.insert(createTimeline());
            setSelected("");
            setFit((value) => value + 1);
          }}
        >
          <Plus size={14} />
          {tr("New timeline")}
        </button>
        <button className="secondary-button" disabled={!scene} onClick={() => setShowImport(true)}>
          <Import size={14} />
          {tr("Import cues")}
        </button>
        <button className="icon-button" aria-label={tr("Fit to view")} onClick={() => setFit((value) => value + 1)}>
          <Maximize size={16} />
        </button>
      </div>
      {!scene ? (
        <div className="empty-panel">{tr("Open a target scene first")}</div>
      ) : (
        <>
          <div className="timeline-settings">
            <select aria-label={tr("Command")} value={command} onChange={(event) => setCommand(event.target.value)}>
              {available.map((command) => (
                <option key={command.name} value={command.name}>
                  {command.label}
                </option>
              ))}
            </select>
            <button className="secondary-button" onClick={add}>
              <Plus size={14} />
              {tr("Add cue")}
            </button>
            {current && (
              <>
                <label>
                  {tr("Minimum duration (s)")}
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={Number((Number(current.arguments.durationSeconds) || 0).toFixed(3))}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value) && value >= 0)
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
              </>
            )}
          </div>
          <div className="timeline-body">
            <div className="timeline-track-area">
              <CueChart
                key={current?.id ?? "empty"}
                cues={cues}
                selected={selected}
                onSelect={setSelected}
                onMove={move}
                fit={fit}
                locale={i18n.resolvedLanguage ?? "en"}
              />
              <div className="timeline-cue-list" aria-label={tr("Timeline commands")}>
                {cues.map((cue) => (
                  <button
                    key={cue.node.id}
                    className={selected === cue.node.id ? "selected" : ""}
                    onClick={() => setSelected(cue.node.id)}
                  >
                    <span>{cue.atSeconds.toFixed(2)} s</span>
                    {nameOf(cue.node)}
                    <small>{laneOf(cue.node)}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="timeline-cue-inspector">
              {cue && (
                <div className="timeline-timing">
                  <label>
                    {tr("Start (s)")}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={cue.atSeconds}
                      onChange={(event) => move(cue.node.id, Number(event.target.value))}
                    />
                  </label>
                  <label>
                    {tr("Duration (s)")}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={!durationField(cue.node)}
                      value={cue.durationSeconds}
                      onChange={(event) => move(cue.node.id, cue.atSeconds, Number(event.target.value))}
                    />
                  </label>
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
                      change((node) => removeCue(node, cue.node.id));
                      setSelected("");
                    }}
                  >
                    <Trash2 size={14} />
                    {tr("Remove cue")}
                  </button>
                </div>
              )}
              <NativeInspector session={session} statement={selectedStatement} />
            </div>
          </div>
        </>
      )}
      {issue && (
        <p role="alert" className="home-error">
          {issue}
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
