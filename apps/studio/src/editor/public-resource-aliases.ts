import type { EditorPublicAsset } from "./resource-manifest.js";

/**
 * Model JSON resolves relative files without inheriting its URL query.
 * Bind those exact URLs to the selected manifest's pinned members while
 * leaving model bytes, texture indices, and provider paths intact.
 */
export function publicResourceAliases(
  asset: Pick<EditorPublicAsset, "scope" | "members">,
): readonly (readonly [string, string])[] {
  const aliases = new Map<string, string>();
  const add = (alias: string, source: string): void => {
    const previous = aliases.get(alias);
    if (previous !== undefined && previous !== source) {
      throw new TypeError(`Ambiguous public resource alias: ${alias}`);
    }
    aliases.set(alias, source);
  };
  for (const member of asset.members) {
    const source = new URL(member.source);
    if (!["https:", "http:"].includes(source.protocol) || source.username || source.password) {
      throw new TypeError("Invalid public resource member URL");
    }
    add(source.href, source.href);
    if (asset.scope.provider !== "haneoka") continue;
    const [, tree, server] = source.pathname.split("/");
    if (
      source.origin !== asset.scope.origin ||
      !["assets", "runtime", "objects"].includes(tree ?? "") ||
      server !== asset.scope.server ||
      source.searchParams.getAll("release").length !== 1 ||
      source.searchParams.get("release") !== asset.scope.releaseId
    ) {
      throw new TypeError("Public resource member must use the selected server and release query");
    }
    const unpinned = new URL(source);
    unpinned.searchParams.delete("release");
    add(unpinned.href, source.href);
    // Relative references also drop any other query and fragment on the base.
    unpinned.search = "";
    unpinned.hash = "";
    add(unpinned.href, source.href);
  }
  return Object.freeze([...aliases].map(([alias, source]) => Object.freeze([alias, source] as const)));
}
