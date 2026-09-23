import type { StoryProject, StoryProjectPlugin } from "@haneoka/altair";
import type { AltairMarketplaceService, AltairPluginCatalog } from "@haneoka/altair-plugin-marketplace";
import { useMemo, useState, type ReactNode } from "react";
import type { StudioProjectFile } from "./folder-workspace";
import { PluginManager } from "./PluginManager";
import { StudioIcon, type StudioIconName } from "./StudioIcon";
import type { StudioSourceDocument } from "./studio-workspace";
import { useStudioI18n } from "./i18n";

interface ResourceTreeNode<T> {
  readonly name: string;
  readonly path: string;
  readonly children: readonly ResourceTreeNode<T>[];
  readonly value?: T;
}

const ASSET_ICONS = Object.freeze({
  image: "image",
  audio: "audio",
  video: "video",
  model: "model",
  data: "data",
  font: "font",
  other: "file",
  scene: "scene",
}) satisfies Readonly<Record<StudioProjectFile["kind"], StudioIconName>>;

const resourceTree = <T,>(values: readonly T[], pathFor: (value: T) => string): readonly ResourceTreeNode<T>[] => {
  interface MutableTreeNode {
    name: string;
    path: string;
    children: Map<string, MutableTreeNode>;
    value?: T;
  }

  const root = new Map<string, MutableTreeNode>();
  for (const value of values) {
    const sourcePath = pathFor(value)
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const parts = sourcePath.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";
    for (const [index, name] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const node = parent.get(name) ?? {
        name,
        path: currentPath,
        children: new Map<string, MutableTreeNode>(),
      };
      if (index === parts.length - 1) node.value = value;
      parent.set(name, node);
      parent = node.children;
    }
  }

  const freeze = (nodes: ReadonlyMap<string, MutableTreeNode>): readonly ResourceTreeNode<T>[] =>
    [...nodes.values()]
      .sort((left, right) => {
        const leftDirectory = left.children.size > 0 && left.value === undefined;
        const rightDirectory = right.children.size > 0 && right.value === undefined;
        if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      })
      .map((node) => ({
        name: node.name,
        path: node.path,
        children: freeze(node.children),
        ...(node.value === undefined ? {} : { value: node.value }),
      }));

  return freeze(root);
};

export interface ResourceExplorerProps {
  readonly documents: readonly StudioSourceDocument[];
  readonly files: readonly StudioProjectFile[];
  readonly assetUrls: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly pluginCatalog: AltairPluginCatalog;
  readonly project: StoryProject | null;
  readonly marketplace?: AltairMarketplaceService;
  readonly selectedSceneId: string;
  readonly onImport: () => void;
  readonly onOpenScene: (sceneId: string) => void;
  readonly onPluginCatalogAdd: (catalog: AltairPluginCatalog) => void;
  readonly onPluginsChange: (plugins: readonly StoryProjectPlugin[]) => void | Promise<void>;
  readonly onRefresh: () => void;
}

export function ResourceExplorer({
  documents,
  files,
  assetUrls,
  busy,
  pluginCatalog,
  marketplace,
  project,
  selectedSceneId,
  onImport,
  onOpenScene,
  onPluginCatalogAdd,
  onPluginsChange,
  onRefresh,
}: ResourceExplorerProps) {
  const { t } = useStudioI18n();
  const [tab, setTab] = useState<"assets" | "scenes" | "plugins">("assets");
  const [selectedAssetPath, setSelectedAssetPath] = useState("");
  const assets = useMemo(() => files.filter(({ kind }) => kind !== "scene"), [files]);
  const assetsByPath = useMemo(() => new Map(assets.map((asset) => [asset.path, asset] as const)), [assets]);
  const assetTree = useMemo(() => resourceTree(assets, ({ displayPath }) => displayPath), [assets]);
  const sourceTree = useMemo(() => resourceTree(documents, ({ path }) => path), [documents]);
  const selectedAsset = assetsByPath.get(selectedAssetPath);
  const selectedAssetUrl = selectedAsset ? assetUrls.get(selectedAsset.path) : undefined;
  const assetIcon = (entry: StudioProjectFile): StudioIconName => ASSET_ICONS[entry.kind];
  const renderAssets = (nodes: readonly ResourceTreeNode<StudioProjectFile>[]): ReactNode =>
    nodes.map((node) =>
      node.value ? (
        <button
          aria-current={selectedAssetPath === node.value.path ? "true" : undefined}
          className={selectedAssetPath === node.value.path ? "tree-item active" : "tree-item"}
          key={node.path}
          onClick={() => setSelectedAssetPath(node.value?.path ?? "")}
          title={node.value.path}
        >
          <span className="asset-kind">
            <StudioIcon name={assetIcon(node.value)} />
          </span>
          <span className="tree-label">{node.name}</span>
        </button>
      ) : (
        <details className="resource-folder" key={node.path} open>
          <summary>
            <StudioIcon name="chevron-right" />
            <span className="tree-label">{node.name}</span>
          </summary>
          <div>{renderAssets(node.children)}</div>
        </details>
      ),
    );
  const renderSources = (nodes: readonly ResourceTreeNode<StudioSourceDocument>[]): ReactNode =>
    nodes.map((node) =>
      node.value ? (
        <button
          className={selectedSceneId === node.value.id ? "tree-item active" : "tree-item"}
          key={node.path}
          onClick={() => onOpenScene(node.value?.id ?? "")}
          title={node.value.path}
        >
          <StudioIcon name="scene" />
          <span className="tree-label">{node.name}</span>
        </button>
      ) : (
        <details className="resource-folder" key={node.path} open>
          <summary>
            <StudioIcon name="chevron-right" />
            <span className="tree-label">{node.name}</span>
          </summary>
          <div>{renderSources(node.children)}</div>
        </details>
      ),
    );

  return (
    <aside aria-label={t("resources")} className="resource-rail">
      <div className="rail-title">
        <span>{t("resources")}</span>
        <span className="rail-actions">
          <button aria-label={t("refresh")} disabled={busy} onClick={onRefresh}>
            <StudioIcon name="refresh" />
          </button>
          <button aria-label={t("openProject")} disabled={busy} onClick={onImport}>
            <StudioIcon name="folder-open" />
          </button>
        </span>
      </div>
      <div aria-label="Project explorer view" className="rail-tabs" role="tablist">
        <button
          aria-selected={tab === "assets"}
          className={tab === "assets" ? "selected" : ""}
          onClick={() => setTab("assets")}
          role="tab"
        >
          {t("assets")}
        </button>
        <button
          aria-selected={tab === "scenes"}
          className={tab === "scenes" ? "selected" : ""}
          onClick={() => setTab("scenes")}
          role="tab"
        >
          {t("scenes")}
        </button>
        <button
          aria-selected={tab === "plugins"}
          className={tab === "plugins" ? "selected" : ""}
          onClick={() => setTab("plugins")}
          role="tab"
        >
          {t("extensions")}
        </button>
      </div>
      {tab === "plugins" ? (
        <PluginManager
          catalog={pluginCatalog}
          marketplace={marketplace}
          onCatalogAdd={onPluginCatalogAdd}
          onPluginsChange={onPluginsChange}
          project={project}
        />
      ) : tab === "scenes" ? (
        <>
          <h2>{t("scenes")}</h2>
          {project?.scenes.map((scene) => (
            <button
              aria-current={selectedSceneId === scene.id ? "page" : undefined}
              className={selectedSceneId === scene.id ? "tree-item active" : "tree-item"}
              key={scene.id}
              onClick={() => onOpenScene(scene.id)}
            >
              <StudioIcon name="scene" />
              <span className="tree-label">{scene.name}</span>
              <small>{scene.commands.length}</small>
            </button>
          ))}
          <h2>{t("sourceFiles")}</h2>
          <div className="resource-tree">{renderSources(sourceTree)}</div>
        </>
      ) : assets.length ? (
        <>
          <div className="resource-tree">{renderAssets(assetTree)}</div>
          {selectedAsset && (
            <div className="asset-preview">
              <header>
                <b>{selectedAsset.name}</b>
                <small>{selectedAsset.kind}</small>
              </header>
              {selectedAsset.kind === "image" && selectedAssetUrl ? (
                <img alt="" src={selectedAssetUrl} />
              ) : selectedAsset.kind === "audio" && selectedAssetUrl ? (
                <audio controls src={selectedAssetUrl} />
              ) : selectedAsset.kind === "video" && selectedAssetUrl ? (
                <video controls src={selectedAssetUrl} />
              ) : (
                <code>{selectedAsset.path}</code>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="tree-empty">{t("noAssets")}</p>
      )}
    </aside>
  );
}
