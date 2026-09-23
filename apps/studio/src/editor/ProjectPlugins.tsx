import { useSyncExternalStore } from "react";
import { parseAltairProjectDocument, serializeAltairDocument } from "@haneoka/altair";
import { STUDIO_PLUGIN_CATALOG } from "../studio-plugin-catalog";
import { tr } from "./i18n";
import { NATIVE_PROJECT_PATH } from "./native-project";
import type { EditorSession } from "./session";

export function ProjectPlugins({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const document = state.documents.find((document) => document.path === NATIVE_PROJECT_PATH);
  if (!document) return null;
  let project;
  try {
    project = parseAltairProjectDocument(document.text);
  } catch {
    return null;
  }
  const plugins = [
    ...project.plugins,
    ...(state.project?.plugins ?? []).filter(
      (plugin) => !project.plugins.some((declared) => declared.id === plugin.id),
    ),
  ];
  const metadata = (id: string, version: string) =>
    STUDIO_PLUGIN_CATALOG.plugins.find((entry) => entry.id === id && entry.version === version);
  const name = (id: string) => {
    const plugin = plugins.find((plugin) => plugin.id === id);
    return plugin ? (metadata(id, plugin.version)?.name ?? id) : id;
  };
  return (
    <section className="project-plugins">
      <h3>{tr("Project plugins")}</h3>
      <p>{tr("Editors and runtime features are provided by the enabled plugins.")}</p>
      <ul>
        {plugins.map((plugin) => {
          const entry = metadata(plugin.id, plugin.version);
          const dependants = plugins.filter(
            (other) =>
              other.id !== plugin.id &&
              other.enabled !== false &&
              Object.hasOwn({ ...metadata(other.id, other.version)?.dependencies, ...other.dependencies }, plugin.id),
          );
          const missing = Object.keys({ ...entry?.dependencies, ...plugin.dependencies }).filter(
            (id) => !plugins.some((plugin) => plugin.id === id && plugin.enabled !== false),
          );
          const enabled = plugin.enabled !== false;
          const disabled = enabled ? plugin.required === true || dependants.length > 0 : missing.length > 0;
          const reason = enabled
            ? dependants.length
              ? tr("Required by {{plugins}}", { plugins: dependants.map((plugin) => name(plugin.id)).join(", ") })
              : plugin.required
                ? tr("Required by this project")
                : ""
            : missing.length
              ? tr("Enable dependencies first: {{plugins}}", { plugins: missing.map(name).join(", ") })
              : "";
          return (
            <li key={plugin.id}>
              <label>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={disabled}
                  onChange={(event) =>
                    session.update(
                      document.path,
                      serializeAltairDocument(
                        {
                          ...project,
                          plugins: project.plugins.map((value) =>
                            value.id === plugin.id ? { ...value, enabled: event.target.checked } : value,
                          ),
                        },
                        document.text,
                      ),
                    )
                  }
                />
                <span>
                  <strong>{entry?.name ?? plugin.id}</strong>
                  <small>
                    {plugin.version} · {plugin.id}
                  </small>
                  {reason && <small>{reason}</small>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
