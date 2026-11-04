import { useMemo, useState, useSyncExternalStore } from "react";
import { Plus, Search, Star } from "lucide-react";
import type { AltairAuthoredNode, JsonObject } from "@haneoka/altair/documents";
import { importWebGal, webGalCommandToAuthoredNode } from "@haneoka/altair-plugin-webgal";
import { nativeCommands, nativeStatements } from "./native-project";
import { sessionCommandLibrary, insertLibraryCommand } from "./command-library";
import { EDITOR_COMMANDS } from "./commands";
import { TaskSheet } from "./authoring/TaskSheet";
import type { EditorSession } from "./session";
import { tr, useStudioI18n } from "./i18n";

export function NativeCommandPalette({
  session,
  after,
  onClose,
  onInserted,
}: {
  session: EditorSession;
  after: string | null;
  onClose(): void;
  onInserted(): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { i18n } = useStudioI18n();
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [issue, setIssue] = useState("");
  const library = sessionCommandLibrary(session);
  const entries = useMemo(() => {
    const core = (name: string, label: string, argumentsValue: JsonObject = {}) => ({
      id: `core:${name}`,
      label: tr(label),
      category: "flow",
      initial: (): AltairAuthoredNode => ({
        id: crypto.randomUUID(),
        type: { plugin: "haneoka.altair", name },
        schemaVersion: 1,
        arguments: argumentsValue,
      }),
    });
    const current = state.project?.entrySceneId ?? "";
    return [
      ...nativeCommands.map((command) => ({
        id: `adv:${command.name}`,
        label: command.label,
        category: command.category,
        initial: command.initial,
      })),
      core("dialogue", "Dialogue visibility", { enabled: true }),
      core("jump", "Jump to scene", { target: { sceneId: current } }),
      core("call", "Call scene", { target: { sceneId: current } }),
      core("return", "Return"),
      core("end", "End story"),
      core("setVariable", "Set variable", { name: "value", value: 0 }),
      ...EDITOR_COMMANDS.filter((command) => command.name !== "comment").map((command) => ({
        id: `webgal:${command.name}`,
        label: command.name,
        category: "WebGAL",
        initial: (): AltairAuthoredNode => {
          const imported = importWebGal(command.initial, {
            localeIndex: Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(state.project?.meta.locale ?? "ja")),
          });
          const value = imported.project.scenes[0]?.commands[0];
          if (!value) throw new Error(tr("Missing statement"));
          return webGalCommandToAuthoredNode(value);
        },
      })),
    ];
  }, [i18n.language, state.project?.entrySceneId, state.project?.meta.locale]);
  const categories = ["all", "favorites", ...new Set(entries.map((entry) => entry.category))];
  const labels: Record<string, string> = {
    all: "All",
    favorites: "Favorites",
    dialogue: "Dialogue",
    character: "Character",
    stage: "Stage",
    camera: "Camera",
    audio: "Audio",
    transition: "Transitions",
    chat: "Phone",
    flow: "Flow",
    timing: "Timing",
    media: "Media",
    system: "System",
  };
  const line = () =>
    after
      ? (nativeStatements(session.document()?.text ?? "").find((statement) => statement.id === after)?.line ??
        state.line)
      : 0;
  const insert = (node: AltairAuthoredNode) => {
    try {
      insertLibraryCommand(session, node, line());
      onInserted();
      onClose();
    } catch (error) {
      setIssue(tr(error instanceof Error ? error.message : String(error)));
    }
  };
  return (
    <TaskSheet title={tr("authoring.insertCommand")} wide onClose={onClose}>
      <label className="author-search">
        <Search aria-hidden />
        <input
          type="search"
          aria-label={tr("authoring.searchCommands")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="author-command-categories" role="group" aria-label={tr("Command categories")}>
        {categories.map((value) => (
          <button
            type="button"
            className="author-button author-button--tonal"
            key={value}
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {value === "favorites" && <Star aria-hidden />}
            {labels[value] ? tr(labels[value]!) : value}
          </button>
        ))}
      </div>
      <div className="author-command-list">
        {library.groups
          .filter(
            (group) =>
              (category === "all" || category === "favorites") &&
              group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
              (category !== "favorites" || library.favoriteGroups?.includes(group.id)),
          )
          .map((group) => (
            <button
              type="button"
              className="author-button"
              key={group.id}
              onClick={() => {
                try {
                  session.insertGroup(group, line());
                  onInserted();
                  onClose();
                } catch (error) {
                  setIssue(String(error));
                }
              }}
            >
              <Plus aria-hidden />
              {group.name}
            </button>
          ))}
        {entries
          .filter(
            (entry) =>
              (category === "all" ||
                category === entry.category ||
                (category === "favorites" &&
                  library.favorites.some(
                    (type) =>
                      entry.id ===
                      `${type.plugin === "haneoka.altair-adv" ? "adv" : type.plugin === "haneoka.altair" ? "core" : "webgal"}:${type.name.replace(/^effect\./u, "")}`,
                  ))) &&
              (entry.label + " " + entry.id).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
          .map((entry) => (
            <button type="button" className="author-button" key={entry.id} onClick={() => insert(entry.initial())}>
              <Plus aria-hidden />
              {entry.label}
            </button>
          ))}
      </div>
      {issue && <p role="alert">{issue}</p>}
    </TaskSheet>
  );
}
