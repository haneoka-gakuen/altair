import { useEffect, useMemo, useState } from "react";
import type { JsonObject, JsonValue } from "@haneoka/altair";
import {
  extractRuntimeVariables,
  formatRuntimeValue,
  runtimeScalarSummary,
} from "./runtime-state";
import { StudioIcon } from "./StudioIcon";

export interface DebugBreakpoint {
  readonly sceneId: string;
  readonly sceneName: string;
  readonly line: number;
  readonly commandIndex: number;
}

export interface RuntimeLogEntry {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly source: "studio" | "runtime";
}

export interface StageInspection {
  readonly target: string;
  readonly referenceFrame: JsonValue | null;
  readonly transform: JsonValue | null;
  readonly busy: boolean;
  readonly error: string;
}

export interface DebugPanelProps {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly snapshot: JsonValue | null;
  readonly executionState: string;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly logs: readonly RuntimeLogEntry[];
  readonly stage: StageInspection;
  readonly onClearLogs: () => void;
  readonly onContinue: () => void;
  readonly onInspectStage: (target: string) => void;
  readonly onPause: () => void;
  readonly onRefresh: () => void;
  readonly onRemoveBreakpoint: (breakpoint: DebugBreakpoint) => void;
  readonly onSetTransform: (target: string, transform: JsonObject, commit: boolean) => void;
  readonly onStep: () => void;
}

type DebugMode = "console" | "variables" | "stage" | "state" | "breakpoints";

const isObject = (value: JsonValue): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function DebugPanel({
  connected,
  busy,
  error,
  snapshot,
  executionState,
  breakpoints,
  logs,
  stage,
  onClearLogs,
  onContinue,
  onInspectStage,
  onPause,
  onRefresh,
  onRemoveBreakpoint,
  onSetTransform,
  onStep,
}: DebugPanelProps) {
  const [mode, setMode] = useState<DebugMode>("console");
  const [filter, setFilter] = useState("");
  const [stageTarget, setStageTarget] = useState("stage");
  const [transformText, setTransformText] = useState("{}");
  const [transformError, setTransformError] = useState("");
  const variables = useMemo(() => extractRuntimeVariables(snapshot), [snapshot]);
  const filteredVariables = variables.filter((variable) =>
    `${variable.scope} ${variable.name} ${variable.path}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const summary = runtimeScalarSummary(snapshot);

  useEffect(() => {
    if (stage.target) setStageTarget(stage.target);
    if (stage.transform !== null) {
      setTransformText(JSON.stringify(stage.transform, null, 2));
      setTransformError("");
    }
  }, [stage.target, stage.transform]);

  const applyTransform = (commit: boolean): void => {
    try {
      const parsed = JSON.parse(transformText) as JsonValue;
      if (!isObject(parsed)) throw new TypeError("Transform must be a JSON object");
      setTransformError("");
      onSetTransform(stageTarget.trim() || "stage", parsed, commit);
    } catch (parseError) {
      setTransformError(parseError instanceof Error ? parseError.message : String(parseError));
    }
  };

  return (
    <section aria-label="Preview debugger" className="debug-panel">
      <div className="debug-toolbar">
        <div aria-label="Debugger view" className="debug-tabs" role="group">
          {(["console", "variables", "stage", "state", "breakpoints"] as const).map((item) => (
            <button
              aria-pressed={mode === item}
              className={mode === item ? "selected" : ""}
              key={item}
              onClick={() => setMode(item)}
            >
              {item === "state" ? "Runtime state" : item[0]!.toUpperCase() + item.slice(1)}
              {item === "breakpoints" && breakpoints.length ? ` (${breakpoints.length})` : ""}
            </button>
          ))}
        </div>
        <span aria-live="polite" className={connected ? "runtime-connected" : "runtime-offline"}>
          {connected ? `${executionState}${busy ? " · busy" : ""}` : "runtime unavailable"}
        </span>
        <div aria-label="Runtime execution controls" className="debug-controls" role="group">
          <button disabled={!connected || busy} onClick={onPause} title="Pause runtime">
            <StudioIcon name="pause" />
            Pause
          </button>
          <button disabled={!connected || busy} onClick={onContinue} title="Continue runtime">
            <StudioIcon name="play" />
            Continue
          </button>
          <button disabled={!connected || busy} onClick={onStep} title="Run one command">
            <StudioIcon name="step-forward" />
            Step
          </button>
          <button disabled={!connected || busy} onClick={onRefresh} title="Capture runtime snapshot">
            <StudioIcon name="refresh" />
            Snapshot
          </button>
        </div>
      </div>
      {(error || stage.error || transformError) && (
        <div className="debug-error" role="alert">
          {error || stage.error || transformError}
        </div>
      )}

      {mode === "console" ? (
        <div className="console-view">
          <div className="debug-section-heading">
            <span>{logs.length} runtime/editor event{logs.length === 1 ? "" : "s"}</span>
            <button disabled={!logs.length} onClick={onClearLogs} title="Clear event log">
              <StudioIcon name="trash" />
              Clear
            </button>
          </div>
          {logs.length ? (
            <ol aria-label="Runtime event log">
              {logs.map((entry) => (
                <li className={`log-${entry.level}`} key={entry.id}>
                  <span>{entry.source}</span>
                  <code>{entry.message}</code>
                </li>
              ))}
            </ol>
          ) : (
            <div className="debug-empty compact">
              Runtime events and diagnostics appear here after the preview connects.
            </div>
          )}
        </div>
      ) : mode === "variables" ? (
        <section aria-labelledby="runtime-variables-heading" className="variables-view">
          <header>
            <div>
              <h2 id="runtime-variables-heading">Runtime variables</h2>
              <p>Values come from the connected Vega snapshot and retain their complete JSON path.</p>
            </div>
            <label>
              <span className="sr-only">Filter runtime variables</span>
              <input
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter variables"
                type="search"
                value={filter}
              />
            </label>
          </header>
          {snapshot === null ? (
            <div className="debug-empty compact">
              Connect Vega and capture a snapshot to inspect variables.
            </div>
          ) : filteredVariables.length ? (
            <div className="variable-table" role="table" aria-rowcount={filteredVariables.length}>
              <div className="variable-row variable-heading" role="row">
                <span role="columnheader">Scope</span>
                <span role="columnheader">Name</span>
                <span role="columnheader">Value</span>
                <span role="columnheader">Path</span>
              </div>
              {filteredVariables.map((variable) => (
                <div className="variable-row" key={variable.path} role="row">
                  <span role="cell">{variable.scope}</span>
                  <b role="cell">{variable.name}</b>
                  <code role="cell">{formatRuntimeValue(variable.value)}</code>
                  <small role="cell">{variable.path}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="debug-empty compact">
              {variables.length
                ? "No variables match this filter."
                : "This snapshot contains no runtime variable store."}
            </div>
          )}
        </section>
      ) : mode === "stage" ? (
        <section aria-labelledby="stage-inspector-heading" className="stage-inspector">
          <div className="stage-query">
            <div>
              <h2 id="stage-inspector-heading">Stage reference and transform</h2>
              <p>Query the exact runtime box and edit its current transform.</p>
            </div>
            <label>
              Target
              <input
                onChange={(event) => setStageTarget(event.target.value)}
                spellCheck={false}
                value={stageTarget}
              />
            </label>
            <button
              disabled={!connected || stage.busy || !stageTarget.trim()}
              onClick={() => onInspectStage(stageTarget.trim())}
              title="Inspect stage target"
            >
              <StudioIcon name="search" />
              Query
            </button>
          </div>
          <div className="stage-columns">
            <div>
              <span>Reference frame</span>
              <pre tabIndex={0}>
                {stage.referenceFrame === null
                  ? "No reference frame queried."
                  : JSON.stringify(stage.referenceFrame, null, 2)}
              </pre>
            </div>
            <div>
              <span>Transform JSON</span>
              <textarea
                aria-label="Stage transform JSON"
                onChange={(event) => setTransformText(event.target.value)}
                spellCheck={false}
                value={transformText}
              />
              <div className="stage-actions">
                <button disabled={!connected || stage.busy} onClick={() => applyTransform(false)}>
                  Preview transform
                </button>
                <button disabled={!connected || stage.busy} onClick={() => applyTransform(true)}>
                  Commit transform
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : mode === "breakpoints" ? (
        <section aria-labelledby="breakpoints-heading" className="breakpoints-view">
          <div className="debug-section-heading">
            <div>
              <h2 id="breakpoints-heading">Command breakpoints</h2>
              <p>Toggle the current source line from the authoring toolbar.</p>
            </div>
          </div>
          {breakpoints.length ? (
            <ol>
              {breakpoints.map((breakpoint) => (
                <li key={`${breakpoint.sceneId}:${breakpoint.commandIndex}`}>
                  <button
                    aria-label={`Remove breakpoint from ${breakpoint.sceneName} line ${breakpoint.line}`}
                    onClick={() => onRemoveBreakpoint(breakpoint)}
                  >
                    <StudioIcon name="trash" />
                  </button>
                  <b>{breakpoint.sceneName}</b>
                  <span>line {breakpoint.line}</span>
                  <code>command {breakpoint.commandIndex + 1}</code>
                </li>
              ))}
            </ol>
          ) : (
            <div className="debug-empty compact">No breakpoints are set.</div>
          )}
        </section>
      ) : (
        <section aria-labelledby="runtime-state-heading" className="runtime-state-view">
          <header>
            <div>
              <h2 id="runtime-state-heading">Runtime snapshot</h2>
              <p>Exact JSON returned by Vega’s revisioned preview session.</p>
            </div>
          </header>
          {summary.length > 0 && (
            <dl className="runtime-summary">
              {summary.map(({ key, value }) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {snapshot === null ? (
            <div className="debug-empty compact">No runtime snapshot has been captured.</div>
          ) : (
            <pre tabIndex={0}>{JSON.stringify(snapshot, null, 2)}</pre>
          )}
        </section>
      )}
    </section>
  );
}
