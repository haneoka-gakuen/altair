import type { JsonValue } from "@haneoka/altair";
import { useMemo, useState, useSyncExternalStore } from "react";
import { tr, useStudioI18n } from "./i18n";
import { routePrompts, savedExportRoutes, type ExportRoute, type RouteAnswer, type RoutePrompt } from "./export-route";
import type { EditorSession } from "./session";

export function ExportRouteEditor({
  session,
  route,
  change,
  replay,
  onError,
  disabled,
}: {
  session: EditorSession;
  route?: ExportRoute;
  change(route?: ExportRoute): void;
  replay(): void;
  onError(error: unknown): void;
  disabled: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { i18n } = useStudioI18n();
  const [saving, setSaving] = useState(false);
  const [variable, setVariable] = useState("");
  const [variableValue, setVariableValue] = useState("");

  const project = state.project,
    compilation = state.compilation;
  const saved = useMemo(() => savedExportRoutes(project), [project]);
  const prompts = useMemo(
    () => (project && compilation ? routePrompts(project, compilation) : []),
    [project, compilation, i18n.resolvedLanguage],
  );
  if (!project || !compilation) return null;
  const create = () => change({ id: crypto.randomUUID(), name: "", sceneId: compilation.sceneId, answers: {} });
  const current = saved.find((item) => item.id === route?.id);
  const stale = route && Object.keys(route.answers).filter((key) => !prompts.some((prompt) => prompt.id === key));
  const updateVisit = (prompt: RoutePrompt, index: number, value?: RouteAnswer) => {
    if (!route) return;
    const values = [...(route.answers[prompt.id] ?? [])];
    if (value === undefined) values.splice(index, 1);
    else values[index] = value;
    change({ ...route, answers: { ...route.answers, [prompt.id]: values } });
  };
  const save = async (remove = false) => {
    if (!route) return;
    setSaving(true);
    try {
      await session.saveExportRoute(route, remove);
      if (remove) change(undefined);
      else change({ ...route, name: route.name.trim() });
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="export-route-editor">
      <label className="field">
        <span>{tr("Export route")}</span>
        <select
          value={route?.id ?? ""}
          disabled={saving}
          onChange={(event) => {
            if (event.target.value === "new") create();
            else change(saved.find((item) => item.id === event.target.value));
          }}
        >
          <option value="">{tr("Current scene")}</option>
          {saved.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          {route && !current && <option value={route.id}>{route.name || tr("New route")}</option>}
          <option value="new">{tr("New route")}…</option>
        </select>
      </label>
      {route && (
        <details open className="export-route-settings">
          <summary>{tr("Route settings")}</summary>
          <label className="field">
            <span>{tr("Route name")}</span>
            <input value={route.name} onChange={(event) => change({ ...route, name: event.target.value })} />
          </label>
          <label className="field">
            <span>{tr("Starting scene")}</span>
            <select value={route.sceneId} onChange={(event) => change({ ...route, sceneId: event.target.value })}>
              {!project.scenes.some((scene) => scene.id === route.sceneId) && (
                <option value={route.sceneId}>{tr("Route scene is missing")}</option>
              )}
              {project.scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.name}
                </option>
              ))}
            </select>
          </label>
          {project.scenes.map((scene) => {
            const inScene = prompts.filter((p) => p.sceneId === scene.id);
            if (!inScene.length) return null;
            return (
              <fieldset key={scene.id}>
                <legend>{scene.name}</legend>
                {inScene.map((prompt) => {
                  const values = route.answers[prompt.id] ?? [];
                  return (
                    <div key={prompt.id}>
                      {(values.length ? values : [undefined]).map((value, index) => (
                        <div className="export-route-visit" key={index}>
                          <label className="field">
                            <span>
                              {prompt.label}
                              {index > 0 ? " · " + tr("Visit {{number}}", { number: index + 1 }) : ""}
                            </span>
                            {prompt.options ? (
                              <select
                                value={value ?? ""}
                                onChange={(event) =>
                                  updateVisit(
                                    prompt,
                                    index,
                                    event.target.value === "" ? undefined : Number(event.target.value),
                                  )
                                }
                              >
                                <option value="">{tr("Select a choice")}</option>
                                {value !== undefined && !prompt.options.some((option) => option.value === value) && (
                                  <option value={value}>{tr("The saved choice is unavailable")}</option>
                                )}
                                {prompt.options.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type={prompt.numeric ? "number" : "text"}
                                value={value ?? ""}
                                onChange={(event) =>
                                  updateVisit(
                                    prompt,
                                    index,
                                    prompt.numeric && event.target.value !== ""
                                      ? Number(event.target.value)
                                      : event.target.value,
                                  )
                                }
                              />
                            )}
                          </label>
                          {values.length > 0 && (
                            <button
                              type="button"
                              className="secondary-button"
                              aria-label={tr("Remove visit")}
                              onClick={() => updateVisit(prompt, index)}
                            >
                              {tr("Remove")}
                            </button>
                          )}
                        </div>
                      ))}
                      {values.length > 0 && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => updateVisit(prompt, values.length, values[values.length - 1])}
                        >
                          {tr("Add visit")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
          {stale && stale.length > 0 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                change({
                  ...route,
                  answers: Object.fromEntries(Object.entries(route.answers).filter(([key]) => !stale.includes(key))),
                })
              }
            >
              {tr("Remove missing choices")}
            </button>
          )}
          <details className="export-route-settings">
            <summary>{tr("Initial variables")}</summary>
            {Object.entries(route.variables ?? {}).map(([name, value]) => (
              <div className="export-route-visit" key={name}>
                <span>
                  {name} = {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={tr("Remove variable {{name}}", { name })}
                  onClick={() => {
                    const variables = { ...route.variables };
                    delete variables[name];
                    change({ ...route, variables });
                  }}
                >
                  {tr("Remove")}
                </button>
              </div>
            ))}
            <label className="field">
              <span>{tr("Variable")}</span>
              <input value={variable} onChange={(event) => setVariable(event.target.value)} />
            </label>
            <label className="field">
              <span>{tr("Value")}</span>
              <input value={variableValue} onChange={(event) => setVariableValue(event.target.value)} />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!variable.trim()}
              onClick={() => {
                let value: JsonValue = variableValue;
                try {
                  value = JSON.parse(variableValue) as JsonValue;
                } catch {
                  /* Plain text is a string value. */
                }
                change({ ...route, variables: { ...route.variables, [variable.trim()]: value } });
                setVariable("");
                setVariableValue("");
              }}
            >
              {tr("Set variable")}
            </button>
          </details>
          <div className="export-route-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={saving || !route.name.trim()}
              onClick={() => void save()}
            >
              {tr("Save route")}
            </button>
            {current && (
              <button type="button" className="secondary-button" disabled={saving} onClick={() => void save(true)}>
                {tr("Delete route")}
              </button>
            )}
            <button type="button" className="secondary-button" disabled={saving || disabled} onClick={replay}>
              {tr("Play route")}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
