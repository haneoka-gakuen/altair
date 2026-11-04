import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { editWebGalStatement, parseWebGalScene } from "@haneoka/altair-plugin-webgal";
import type { EditorSession } from "./session";
import { tr } from "./i18n";

const fields = [
  ["Game_key", "Game key", "text"],
  ["Title_img", "Title background", "background"],
  ["Title_bgm", "Title music", "bgm"],
  ["Game_Logo", "Game logo", "background"],
  ["Enable_Appreciation", "Gallery", "boolean"],
  ["Enable_Continue", "Continue", "boolean"],
  ["Enable_flowchart", "Flowchart", "boolean"],
  ["Legacy_Expression_Blend_Mode", "Legacy expression blending", "boolean"],
  ["Cubism_Memory_Reserved_Size_MB", "Cubism memory (MB)", "number"],
  ["Steam_AppID", "Steam App ID", "text"],
] as const;
export function GameSettings({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    listId = useId();
  const path = state.files.find((file) => /(?:^|\/)config\.txt$/iu.test(file.path))?.path;
  const loaded = state.documents.find((document) => document.path === path),
    file = state.files.find((file) => file.path === path);
  const [source, setSource] = useState(""),
    [issue, setIssue] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (loaded) setSource(loaded.text);
    else if (file)
      void file.blob
        .text()
        .then((text) => {
          if (active) setSource(text);
        })
        .catch((error) => {
          if (active) setIssue(String(error));
        });
    return () => {
      active = false;
    };
  }, [loaded?.text, file?.blob]);
  if (!path) return null;
  const statements = parseWebGalScene(source).statements;
  const commit = async (key: string, value: string) => {
    setBusy(true);
    setIssue("");
    try {
      await session.activate(path);
      session.lifetimeSignal.throwIfAborted();
      const document = session.document(path);
      if (!document) throw new Error(tr("File is missing"));
      const existing = parseWebGalScene(document.text).statements.find(
        (statement) => statement.name.toLowerCase() === key.toLowerCase(),
      );
      let next: string;
      if (existing) next = editWebGalStatement(document.text, existing, { content: value });
      else {
        const initial = `${key}:;`;
        next = `${document.text.trimEnd()}\n${editWebGalStatement(initial, parseWebGalScene(initial).statements[0]!, { content: value })}\n`;
      }
      session.update(path, next);
      setSource(next);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="project-game-settings">
      <summary>{tr("WebGAL game configuration")}</summary>
      <div className="stack">
        {fields.map(([key, label, kind]) => {
          const value =
            statements.find((statement) => statement.name.toLowerCase() === key.toLowerCase())?.content ?? "";
          if (kind === "boolean")
            return (
              <label className="row" key={key}>
                <input
                  type="checkbox"
                  checked={value ? value === "true" : ["Enable_Appreciation", "Enable_Continue"].includes(key)}
                  disabled={busy}
                  onChange={(event) => void commit(key, String(event.target.checked))}
                />
                {tr(label)}
              </label>
            );
          const assets =
            kind === "background" || kind === "bgm"
              ? state.files
                  .filter((file) => file.path.includes(`/${kind}/`))
                  .map((file) => file.path.split(`/${kind}/`).slice(1).join(`/${kind}/`))
              : [];
          return (
            <label className="field" key={key}>
              <span>{tr(label)}</span>
              <input
                key={value}
                type={kind === "number" ? "number" : "text"}
                min={kind === "number" ? 0 : undefined}
                defaultValue={value}
                disabled={busy}
                list={assets.length ? `${listId}-${key}` : undefined}
                onBlur={(event) => {
                  if (event.target.value !== value) void commit(key, event.target.value);
                }}
              />
              {assets.length > 0 && (
                <datalist id={`${listId}-${key}`}>
                  {assets.map((asset) => (
                    <option key={asset} value={asset} />
                  ))}
                </datalist>
              )}
            </label>
          );
        })}
        {issue && <p role="alert">{issue}</p>}
      </div>
    </details>
  );
}
