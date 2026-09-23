import { tr } from "./i18n";
import {
  parseAltairCommandLibrary,
  parseAuthoredText,
  altairCommandTypeKey,
  serializeAltairCommandLibrary,
  type AltairCommandLibrary,
  type AltairCommandGroup,
  type AltairAuthoredNode,
} from "@haneoka/altair";
import {
  importWebGal,
  parseWebGalScene,
  WEBGAL_BUILTIN_COMMAND_NAMES,
  parseWebGalCraftCommandLibrary,
  webGalCommandToAuthoredNode,
} from "@haneoka/altair-plugin-webgal";
import type { EditorSession } from "./session";
export const COMMAND_LIBRARY_PATH = "library/commands.yaml";
export const emptyCommandLibrary = (): AltairCommandLibrary => ({
  format: "commandLibrary",
  version: 1,
  groups: [],
  favorites: [],
});
export function sessionCommandLibrary(session: EditorSession): AltairCommandLibrary {
  const document = session.document(COMMAND_LIBRARY_PATH);
  return document ? parseAltairCommandLibrary(document.text) : emptyCommandLibrary();
}
export async function saveCommandLibrary(session: EditorSession, value: AltairCommandLibrary): Promise<void> {
  const text = serializeAltairCommandLibrary(
    parseAltairCommandLibrary(value),
    session.document(COMMAND_LIBRARY_PATH)?.text,
  );
  if (session.document(COMMAND_LIBRARY_PATH)) {
    session.update(COMMAND_LIBRARY_PATH, text);
    await session.save();
  } else await session.addFile(COMMAND_LIBRARY_PATH, new Blob([text], { type: "application/yaml" }), { open: false });
}
export function importCommandLibrary(text: string): AltairCommandLibrary {
  const data = parseAuthoredText(text);
  if (data && typeof data === "object" && !Array.isArray(data) && data.format === "commandLibrary")
    return parseAltairCommandLibrary(data);
  const craft = parseWebGalCraftCommandLibrary(data);
  const convert = (id: string, name: string, rawTexts: readonly string[]): AltairCommandGroup => {
    const sceneId = crypto.randomUUID();
    const imported = importWebGal(rawTexts.join("\n"), {
      sceneId,
      title: name,
    });
    const errors = imported.diagnostics.filter((item) => item.severity === "error");
    if (errors.length) throw new Error(`${name}：${errors.map((item) => item.message).join("\n")}`);
    return {
      id,
      name,
      sourceSceneId: sceneId,
      nodes: imported.project.scenes[0]!.commands.map(webGalCommandToAuthoredNode),
      plugins: imported.project.plugins ?? [],
    };
  };
  const groups = craft.groups.map((group) => convert(group.id, group.name, group.rawTexts));
  const defaults: NonNullable<AltairCommandLibrary["defaults"]>[number][] = [];
  const favorites: NonNullable<AltairCommandLibrary["favoriteGroups"]>[number][] = [];
  const byName = new Map<string, AltairCommandGroup>();
  for (const raw of Object.values(craft.defaults)) {
    const statement = parseWebGalScene(raw).statements.find((statement) => statement.kind !== "comment");
    if (!statement) continue;
    const name = statement.kind === "dialogue" ? "say" : statement.name.toLowerCase();
    const group = convert(crypto.randomUUID(), tr("Default \u00B7 {{p0}}", { p0: name }), [raw]);
    groups.push(group);
    byName.set(name, group);
    const first = group.nodes[0];
    if (first) {
      const key = altairCommandTypeKey(first.type),
        prior = defaults.findIndex((item) => altairCommandTypeKey(item.type) === key);
      if (prior >= 0) defaults.splice(prior, 1);
      defaults.push({ type: first.type, groupId: group.id });
    }
  }
  for (const favorite of craft.favoriteCommandIds) {
    const name = favorite.toLowerCase();
    if (!(WEBGAL_BUILTIN_COMMAND_NAMES as readonly string[]).includes(name)) continue;
    let group = byName.get(name);
    if (!group) {
      group = convert(crypto.randomUUID(), favorite, [`${favorite}:;`]);
      groups.push(group);
      byName.set(name, group);
    }
    if (!favorites.includes(group.id)) favorites.push(group.id);
  }
  return parseAltairCommandLibrary({
    ...emptyCommandLibrary(),
    groups,
    defaults,
    favoriteGroups: favorites,
    extensions: {
      webgalCraft: {
        defaults: craft.defaults,
        favoriteCommandIds: craft.favoriteCommandIds,
        activeCategory: craft.activeCategory,
      },
    },
  });
}
export function mergeCommandLibraries(
  current: AltairCommandLibrary,
  imported: AltairCommandLibrary,
): AltairCommandLibrary {
  const ids = new Set(current.groups.map((group) => group.id)),
    remapped = new Map<string, string>();
  const groups = imported.groups.map((group) => {
    const id = ids.has(group.id) ? crypto.randomUUID() : group.id;
    ids.add(id);
    remapped.set(group.id, id);
    return { ...group, id };
  });
  const favorites = new Map(
    [...current.favorites, ...imported.favorites].map((type) => [altairCommandTypeKey(type), type]),
  );
  const defaults = new Map((current.defaults ?? []).map((item) => [altairCommandTypeKey(item.type), item]));
  for (const item of imported.defaults ?? [])
    defaults.set(altairCommandTypeKey(item.type), {
      ...item,
      groupId: remapped.get(item.groupId)!,
    });
  return parseAltairCommandLibrary({
    ...current,
    ...imported,
    groups: [...current.groups, ...groups],
    favorites: [...favorites.values()],
    defaults: [...defaults.values()],
    favoriteGroups: [
      ...new Set([
        ...(current.favoriteGroups ?? []),
        ...(imported.favoriteGroups ?? []).map((id) => remapped.get(id)!),
      ]),
    ],
  });
}
export function insertLibraryCommand(session: EditorSession, node: AltairAuthoredNode, afterLine?: number): void {
  const library = sessionCommandLibrary(session),
    key = altairCommandTypeKey(node.type);
  const saved = library.defaults?.find((item) => altairCommandTypeKey(item.type) === key);
  const group = library.groups.find((group) => group.id === saved?.groupId);
  if (group) session.insertGroup(group, afterLine);
  else session.insert(node, afterLine);
}
