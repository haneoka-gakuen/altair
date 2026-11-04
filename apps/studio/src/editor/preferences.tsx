import { useSyncExternalStore } from "react";
import { tr } from "./i18n";
export interface EditorPreferences {
  theme: "auto" | "light" | "dark";
  fontSize: number;
  wordWrap: boolean;
  tabSize: number;
  minimap: boolean;
}
const key = "altair.editor-preferences.v1",
  listeners = new Set<() => void>();
let preferences: EditorPreferences = { theme: "auto", fontSize: 14, wordWrap: true, tabSize: 2, minimap: false };
try {
  const value = JSON.parse(localStorage.getItem(key) || "null");
  if (value) preferences = { ...preferences, ...value };
} catch {}
const media = matchMedia("(prefers-color-scheme: dark)");
function apply() {
  if (document.documentElement.dataset.studioHosted === "true") return;
  document.documentElement.dataset.theme =
    preferences.theme === "auto" ? (media.matches ? "dark" : "light") : preferences.theme;
}
media.addEventListener("change", apply);
apply();
export function useEditorPreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => preferences,
  );
}
function update(patch: Partial<EditorPreferences>) {
  preferences = { ...preferences, ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {}
  apply();
  for (const listener of listeners) listener();
}
export function InterfaceSettings() {
  const current = useEditorPreferences();
  return (
    <section className="editor-preferences">
      <h3>{tr("Interface settings")}</h3>
      <label className="field">
        {tr("Color theme")}
        <select value={current.theme} onChange={(e) => update({ theme: e.target.value as EditorPreferences["theme"] })}>
          <option value="auto">{tr("Follow device theme")}</option>
          <option value="light">{tr("Light")}</option>
          <option value="dark">{tr("Dark")}</option>
        </select>
      </label>
      <label className="field">
        {tr("Editor font size")}
        <input
          type="number"
          min={10}
          max={32}
          value={current.fontSize}
          onChange={(e) => {
            const fontSize = e.target.valueAsNumber;
            if (Number.isFinite(fontSize) && fontSize >= 10 && fontSize <= 32) update({ fontSize });
          }}
        />
      </label>
      <label className="field">
        {tr("Tab size")}
        <select value={current.tabSize} onChange={(e) => update({ tabSize: Number(e.target.value) })}>
          <option value={2}>2</option>
          <option value={4}>4</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={current.wordWrap} onChange={(e) => update({ wordWrap: e.target.checked })} />
        {tr("Word wrap")}
      </label>
      <label>
        <input type="checkbox" checked={current.minimap} onChange={(e) => update({ minimap: e.target.checked })} />
        {tr("Minimap")}
      </label>
      <button
        onClick={() => {
          localStorage.removeItem("altair.layout.columns");
          localStorage.removeItem("altair.layout.left");
          location.reload();
        }}
      >
        {tr("Reset panel layout")}
      </button>
    </section>
  );
}
export function readPanelLayout(key: string, fallback: Record<string, number>): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(`altair.layout.${key}`) || "null");
    if (value && Object.keys(fallback).every((id) => typeof value[id] === "number" && value[id] > 0)) return value;
  } catch {}
  return fallback;
}
export function savePanelLayout(key: string, value: Record<string, number>) {
  try {
    localStorage.setItem(`altair.layout.${key}`, JSON.stringify(value));
  } catch {}
}
