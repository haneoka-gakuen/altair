import { useEffect, useState } from "react";
import type { VegaJsonValue } from "@haneoka/vega-protocol";
import type { StudioPreviewBridge, StudioAudioStatus } from "../preview-bridge";
import type { EditorSession } from "./session";
import { tr } from "./i18n";
export function RuntimeDebugger({
  bridge,
  session,
  ready,
  expanded = false,
}: {
  bridge: StudioPreviewBridge;
  session: EditorSession;
  ready: boolean;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded),
    [tab, setTab] = useState("variables"),
    [variables, setVariables] = useState<Record<string, VegaJsonValue>>({}),
    [logs, setLogs] = useState<string[]>([]),
    [issue, setIssue] = useState("");
  const [audio, setAudio] = useState<StudioAudioStatus>();
  const [stage, setStage] = useState<VegaJsonValue>();
  const [name, setName] = useState(""),
    [value, setValue] = useState("null"),
    [revision, setRevision] = useState(0);
  const refresh = async () => {
    if (tab === "stage") {
      setStage(await bridge.stageSnapshot());
      return;
    }
    if (tab === "audio") {
      setAudio(await bridge.audioStatus());
      return;
    }
    const result = await bridge.variables();
    if (result && typeof result === "object" && !Array.isArray(result)) setVariables(result);
  };
  useEffect(() => {
    if (!ready || !open) return;
    let active = true;
    const stop = bridge.onEvent((event) => {
      if (event.event === "runtime.diagnostic")
        setLogs((old) => [...old.slice(-199), `${event.level}: ${event.message}`]);
      if (event.event === "runtime.state") {
        const snapshot = event.snapshot as Record<string, VegaJsonValue>;
        const vars = snapshot.variables;
        if (vars && typeof vars === "object" && !Array.isArray(vars)) setVariables(vars);
      }
    });
    void refresh().catch((error) => {
      if (active) setIssue(String(error));
    });
    return () => {
      active = false;
      stop();
    };
  }, [bridge, ready, open, revision, tab]);
  const run = async (action: () => Promise<unknown>) => {
    setIssue("");
    try {
      await action();
      setRevision((v) => v + 1);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <details className="runtime-debugger" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{tr("Preview debugger")}</summary>
      <div className="preview-toolbar">
        <button disabled={!ready} onClick={() => void run(() => bridge.step())}>
          {tr("Step")}
        </button>
        <button disabled={!ready} onClick={() => void run(() => bridge.continue())}>
          {tr("Continue")}
        </button>
        <button
          disabled={!ready}
          onClick={() =>
            void run(async () => {
              const index = session.runtimeIndex(),
                points = bridge.configuredBreakpoints ?? [];
              await bridge.setBreakpoints(
                points.some((p) => p.commandIndex === index)
                  ? points.filter((p) => p.commandIndex !== index)
                  : [...points, { commandIndex: index }],
              );
            })
          }
        >
          {tr("Toggle breakpoint")}
        </button>
        <select aria-label={tr("Debugger view")} value={tab} onChange={(e) => setTab(e.target.value)}>
          <option value="variables">{tr("Variables")}</option>
          <option value="console">{tr("Console")}</option>
          <option value="breakpoints">{tr("Breakpoints")}</option>
          <option value="audio">{tr("Audio")}</option>
          <option value="stage">{tr("Stage")}</option>
        </select>
      </div>
      {tab === "variables" && (
        <>
          <table>
            <thead>
              <tr>
                <th>{tr("Variable")}</th>
                <th>{tr("Value")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(variables).map(([key, val]) => (
                <tr key={key}>
                  <td>
                    <button
                      onClick={() => {
                        setName(key);
                        setValue(JSON.stringify(val));
                      }}
                    >
                      {key}
                    </button>
                  </td>
                  <td>
                    <code>{JSON.stringify(val)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="runtime-debugger__edit"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const parsed = JSON.parse(value) as VegaJsonValue;
                await bridge.setVariable(name, parsed);
                await refresh();
              });
            }}
          >
            <input required aria-label={tr("Variable")} value={name} onChange={(e) => setName(e.target.value)} />
            <input required aria-label={tr("Value")} value={value} onChange={(e) => setValue(e.target.value)} />
            <button disabled={!ready}>{tr("Apply")}</button>
          </form>
        </>
      )}
      {tab === "audio" && (
        <div className="runtime-audio-status">
          <button
            className="secondary-button"
            disabled={!ready}
            onClick={() =>
              void refresh().catch((error) => setIssue(tr(error instanceof Error ? error.message : String(error))))
            }
          >
            {tr("Refresh audio")}
          </button>
          <table>
            <caption>
              {tr("Web Audio")} ·{" "}
              {tr(
                ({ running: "Running", suspended: "Suspended", closed: "Closed" } as Record<string, string>)[
                  audio?.device ?? ""
                ] ?? "Loading",
              )}
            </caption>
            <thead>
              <tr>
                <th>{tr("Audio track")}</th>
                <th>{tr("State")}</th>
                <th>{tr("Position (s)")}</th>
                <th>{tr("Volume")}</th>
                <th>{tr("Recorded")}</th>
              </tr>
            </thead>
            <tbody>
              {audio?.channels.map((channel, index) => (
                <tr key={`${channel.category}:${channel.name}:${index}`}>
                  <td>
                    {channel.name}
                    <small>{channel.backend}</small>
                  </td>
                  <td>{tr(channel.playing ? "Playing" : "Stopped")}</td>
                  <td>{channel.position.toFixed(2)}</td>
                  <td>{channel.volume.toFixed(2)}</td>
                  <td>{tr(channel.captured ? "Yes" : "No")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "stage" && (
        <>
          <button className="secondary-button" disabled={!ready} onClick={() => void run(refresh)}>
            {tr("Refresh stage snapshot")}
          </button>
          <pre className="runtime-stage-snapshot">{stage ? JSON.stringify(stage, null, 2) : ""}</pre>
        </>
      )}
      {tab === "console" && (
        <>
          <button onClick={() => setLogs([])}>{tr("Clear console")}</button>
          <pre>{logs.join("\n")}</pre>
        </>
      )}
      {tab === "breakpoints" && (
        <ul>
          {(bridge.configuredBreakpoints ?? []).map((point) => (
            <li key={`${point.sceneId}:${point.commandIndex}`}>
              <button
                onClick={() =>
                  void run(() => bridge.setBreakpoints((bridge.configuredBreakpoints ?? []).filter((p) => p !== point)))
                }
              >
                {point.commandIndex + 1} ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {issue && <p role="alert">{issue}</p>}
    </details>
  );
}
