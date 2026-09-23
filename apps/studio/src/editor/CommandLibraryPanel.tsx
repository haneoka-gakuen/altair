import { tr } from "./i18n";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Download, Upload, Plus, Star, Trash2, X } from "lucide-react";
import {
  altairCommandTypeKey,
  parseAltairSceneDocument,
  parseAltairProjectDocument,
  serializeAltairCommandLibrary,
  type AltairCommandLibrary,
  type AltairAuthoredNode,
} from "@haneoka/altair";
import { nativeCommands, nativeNodeLabel, NATIVE_PROJECT_PATH, nativeScenePath } from "./native-project";
import {
  COMMAND_LIBRARY_PATH,
  emptyCommandLibrary,
  importCommandLibrary,
  mergeCommandLibraries,
  saveCommandLibrary,
  insertLibraryCommand,
} from "./command-library";
import { parseAltairCommandLibrary } from "@haneoka/altair";
import type { EditorSession } from "./session";
import { readLocalizedText } from "./localized-text";
export function CommandLibraryPanel({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const importInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot),
    document = session.document();
  const [tab, setTab] = useState("groups"),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [name, setName] = useState(""),
    [asDefault, setAsDefault] = useState(false),
    [picked, setPicked] = useState<Set<string>>(() => new Set(state.selectedNodeId ? [state.selectedNodeId] : [])),
    [issue, setIssue] = useState(""),
    [busy, setBusy] = useState(false),
    [pendingDelete, setPendingDelete] = useState("");
  const librarySource = state.documents.find((doc) => doc.path === COMMAND_LIBRARY_PATH)?.text;
  const parsed = useMemo(() => {
    try {
      return {
        value: librarySource ? parseAltairCommandLibrary(librarySource) : emptyCommandLibrary(),
        error: "",
      };
    } catch (error) {
      return { value: emptyCommandLibrary(), error: String(error) };
    }
  }, [librarySource]);
  const library = parsed.value;
  let locale = "und";
  try {
    locale = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)?.text ?? "").locales[0] ?? "und";
  } catch {}
  const summary = (node: AltairAuthoredNode) => {
    const command = nativeCommands.find(
      (command) => node.type.plugin === "haneoka.altair-adv" && command.name === node.type.name,
    );
    const value = node.arguments[command?.primaryField ?? "text"];
    return readLocalizedText(value, locale) || nativeNodeLabel(node);
  };
  const scene = useMemo(() => {
    try {
      return document && nativeScenePath(document.path) ? parseAltairSceneDocument(document.text) : undefined;
    } catch {
      return undefined;
    }
  }, [document]);
  const groups = library.groups.filter((group) => group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const group = groups.find((group) => group.id === selected) ?? groups[0];
  const favoriteKeys = new Set(library.favorites.map(altairCommandTypeKey));
  const run = (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setIssue("");
    void Promise.resolve()
      .then(action)
      .catch((error) => setIssue(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const save = (next: AltairCommandLibrary) => saveCommandLibrary(session, next);
  const capture = () =>
    run(async () => {
      if (!scene || !name.trim()) return;
      const project = parseAltairProjectDocument(session.document(NATIVE_PROJECT_PATH)?.text ?? "");
      const nodes = scene.nodes.filter((node) => picked.has(node.id));
      if (!nodes.length) throw new Error(tr("Select at least one statement"));
      const id = crypto.randomUUID();
      await save({
        ...library,
        ...(asDefault && nodes.length === 1
          ? {
              defaults: [
                ...(library.defaults ?? []).filter(
                  (item) => altairCommandTypeKey(item.type) !== altairCommandTypeKey(nodes[0]!.type),
                ),
                { type: nodes[0]!.type, groupId: id },
              ],
            }
          : {}),
        groups: [
          ...library.groups,
          {
            id,
            name: name.trim(),
            sourceSceneId: scene.id,
            nodes,
            plugins: project.plugins,
          },
        ],
      });
      setSelected(id);
      setName("");
      setAsDefault(false);
      setTab("groups");
    });
  const exportFile = () => {
    const url = URL.createObjectURL(
      new Blob([serializeAltairCommandLibrary(library)], {
        type: "application/yaml",
      }),
    );
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = "commands.yaml";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content command-library-dialog" aria-busy={busy}>
          <header className="library-header">
            <div>
              <Dialog.Title>{tr("Command library")}</Dialog.Title>
              <Dialog.Description>{tr("Save reusable statement groups for other scenes.")}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label={tr("Close command library")}>
              <X size={18} />
            </Dialog.Close>
          </header>
          <Tabs.Root value={tab} onValueChange={setTab}>
            <Tabs.List className="library-tabs">
              <Tabs.Trigger value="groups">{tr("Groups")}</Tabs.Trigger>
              <Tabs.Trigger value="favorites">{tr("Favorite commands")}</Tabs.Trigger>
              <Tabs.Trigger value="capture" disabled={!scene}>
                {tr("Add from current scene")}
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="groups">
              <div className="library-toolbar">
                <input
                  type="search"
                  aria-label={tr("Search groups")}
                  placeholder={tr("Search groups")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="secondary-button"
                  disabled={busy || !!parsed.error}
                  onClick={() => importInput.current?.click()}
                >
                  <Upload size={14} />
                  {tr("Import")}
                </button>
                <input
                  type="file"
                  ref={importInput}
                  hidden
                  accept=".yaml,.yml,.json"
                  disabled={busy || !!parsed.error}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file)
                      run(async () => {
                        const imported = importCommandLibrary(await file.text());
                        await save(mergeCommandLibraries(library, imported));
                      });
                  }}
                />
                <button className="secondary-button" disabled={busy || !!parsed.error} onClick={exportFile}>
                  <Download size={14} />
                  {tr("Export")}
                </button>
              </div>
              <div className="library-browser">
                <nav aria-label={tr("Groups")}>
                  {groups.map((item) => (
                    <button
                      key={item.id}
                      aria-current={item.id === group?.id ? "true" : undefined}
                      onClick={() => {
                        setSelected(item.id);
                        setPendingDelete("");
                      }}
                    >
                      <strong>{item.name}</strong>
                      <small>
                        {tr("{{count}} statements", {
                          count: item.nodes.length,
                        })}
                      </small>
                    </button>
                  ))}
                  {!groups.length && (
                    <div className="empty-panel">{query ? tr("No matching groups") : tr("No saved groups yet")}</div>
                  )}
                </nav>
                <section className="library-detail">
                  {group ? (
                    <>
                      <header>
                        <input
                          key={group.id + group.name}
                          aria-label={tr("Group name")}
                          defaultValue={group.name}
                          onBlur={(event) => {
                            const name = event.target.value.trim();
                            if (name && name !== group.name)
                              run(() =>
                                save({
                                  ...library,
                                  groups: library.groups.map((item) =>
                                    item.id === group.id ? { ...item, name } : item,
                                  ),
                                }),
                              );
                          }}
                        />
                        <button
                          className="icon-button"
                          aria-label={tr("Favorite group")}
                          aria-pressed={library.favoriteGroups?.includes(group.id) ?? false}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              save({
                                ...library,
                                favoriteGroups: library.favoriteGroups?.includes(group.id)
                                  ? library.favoriteGroups.filter((id) => id !== group.id)
                                  : [...(library.favoriteGroups ?? []), group.id],
                              }),
                            )
                          }
                        >
                          <Star size={15} fill={library.favoriteGroups?.includes(group.id) ? "currentColor" : "none"} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={tr("Delete group")}
                          disabled={busy}
                          onClick={() => setPendingDelete(group.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </header>
                      <ol>
                        {group.nodes.map((node, index) => (
                          <li key={node.id}>
                            <span>{index + 1}</span>
                            <div>
                              <strong>{nativeNodeLabel(node)}</strong>
                              <p className="library-node-summary">{summary(node)}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      {pendingDelete === group.id ? (
                        <div className="library-confirm" role="alert">
                          <span>{tr("Delete “{{name}}”?", { name: group.name })}</span>
                          <button onClick={() => setPendingDelete("")}>{tr("Cancel")}</button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await save({
                                  ...library,
                                  groups: library.groups.filter((item) => item.id !== group.id),
                                  defaults: library.defaults?.filter((item) => item.groupId !== group.id),
                                  favoriteGroups: library.favoriteGroups?.filter((id) => id !== group.id),
                                });
                                setPendingDelete("");
                              })
                            }
                          >
                            {tr("Delete")}
                          </button>
                        </div>
                      ) : (
                        <footer>
                          <span>
                            {tr("{{count}} statements", {
                              count: group.nodes.length,
                            })}
                          </span>
                          {library.defaults?.some((item) => item.groupId === group.id) && (
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  save({
                                    ...library,
                                    defaults: library.defaults?.filter((item) => item.groupId !== group.id),
                                  }),
                                )
                              }
                            >
                              {tr("Restore command default")}
                            </button>
                          )}
                          <button
                            className="primary-button"
                            disabled={busy || !scene || !group.nodes.length || !!parsed.error}
                            onClick={() =>
                              run(() => {
                                session.insertGroup(group);
                                onClose();
                              })
                            }
                          >
                            {tr("Insert into scene")}
                          </button>
                        </footer>
                      )}
                    </>
                  ) : (
                    <div className="empty-panel">{tr("Select a group to view its contents")}</div>
                  )}
                </section>
              </div>
            </Tabs.Content>
            <Tabs.Content value="capture">
              <div className="library-capture">
                <label className="field">
                  <span>{tr("Group name")}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={tr("For example: character entrance and greeting")}
                  />
                </label>
                <label className="toggle-field">
                  <input
                    type="checkbox"
                    checked={asDefault && picked.size === 1}
                    disabled={picked.size !== 1}
                    onChange={(event) => setAsDefault(event.target.checked)}
                  />
                  <span>{tr("Also use as the default for this command")}</span>
                </label>
                <div className="library-selection">
                  <span>{tr("{{count}} selected", { count: picked.size })}</span>
                  <button onClick={() => setPicked(new Set(scene?.nodes.map((node) => node.id)))}>
                    {tr("Select all")}
                  </button>
                  <button onClick={() => setPicked(new Set())}>{tr("Clear")}</button>
                </div>
                <ol>
                  {scene?.nodes.map((node, index) => (
                    <li key={node.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={picked.has(node.id)}
                          onChange={(event) =>
                            setPicked((previous) => {
                              const next = new Set(previous);
                              event.target.checked ? next.add(node.id) : next.delete(node.id);
                              return next;
                            })
                          }
                        />
                        <span>
                          {index + 1}. {nativeNodeLabel(node)}
                        </span>
                        <span className="library-node-summary">{summary(node)}</span>
                      </label>
                    </li>
                  ))}
                </ol>
                <footer>
                  <button
                    className="primary-button"
                    disabled={busy || !name.trim() || !picked.size || !!parsed.error}
                    onClick={capture}
                  >
                    <Plus size={14} />
                    {tr("Save group")}
                  </button>
                </footer>
              </div>
            </Tabs.Content>
            <Tabs.Content value="favorites">
              <div className="library-favorites">
                {library.groups
                  .filter((group) => library.favoriteGroups?.includes(group.id))
                  .map((group) => (
                    <div key={group.id}>
                      <button
                        aria-label={tr("Remove {{p0}} from favorites", {
                          p0: group.name,
                        })}
                        aria-pressed="true"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            save({
                              ...library,
                              favoriteGroups: library.favoriteGroups?.filter((id) => id !== group.id),
                            }),
                          )
                        }
                      >
                        <Star size={15} fill="currentColor" />
                      </button>
                      <button
                        disabled={!scene || busy}
                        onClick={() =>
                          run(() => {
                            session.insertGroup(group);
                            onClose();
                          })
                        }
                      >
                        {group.name}
                      </button>
                    </div>
                  ))}
                {nativeCommands.map((command) => {
                  const type = {
                      plugin: "haneoka.altair-adv",
                      name: command.name,
                    },
                    key = altairCommandTypeKey(type),
                    favorite = favoriteKeys.has(key);
                  return (
                    <div key={key}>
                      <button
                        aria-label={`${favorite ? tr("Remove from favorites") : tr("Add to favorites")}${command.label}`}
                        aria-pressed={favorite}
                        disabled={busy || !!parsed.error}
                        onClick={() =>
                          run(() =>
                            save({
                              ...library,
                              favorites: favorite
                                ? library.favorites.filter((item) => altairCommandTypeKey(item) !== key)
                                : [...library.favorites, type],
                            }),
                          )
                        }
                      >
                        <Star size={15} fill={favorite ? "currentColor" : "none"} />
                      </button>
                      <button
                        disabled={!scene}
                        onClick={() => {
                          insertLibraryCommand(session, command.initial());
                          onClose();
                        }}
                      >
                        {command.label}
                      </button>
                    </div>
                  );
                })}
              </div>
            </Tabs.Content>
          </Tabs.Root>
          {(issue || parsed.error) && (
            <p className="library-error" role="alert">
              {issue || parsed.error}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
