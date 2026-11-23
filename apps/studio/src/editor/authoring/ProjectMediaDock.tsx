import { useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Download,
  Folder,
  Image,
  MoreVertical,
  Music,
  Plus,
  Search,
  Sparkles,
  Upload,
  UserRound,
  Video,
  X,
} from "@haneoka/altair-ui-react";
import { tr, useStudioI18n } from "../i18n";
import type { EditorSession } from "../session";
import {
  formatMediaSize,
  type MediaInsertOverride,
  type ProjectMediaCategory,
  type ProjectMediaFilter,
  type ProjectMediaItem,
} from "./project-media";

const CATEGORIES: ReadonlyArray<{ id: ProjectMediaFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "background", label: "Background" },
  { id: "character", label: "Characters" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "effect", label: "Effects" },
];

function MediaCategoryIcon({ category }: { category: ProjectMediaCategory }) {
  switch (category) {
    case "character":
      return <UserRound aria-hidden />;
    case "video":
      return <Video aria-hidden />;
    case "audio":
      return <Music aria-hidden />;
    case "effect":
      return <Sparkles aria-hidden />;
    case "background":
    case "image":
      return <Image aria-hidden />;
  }
}

export function ProjectMediaDock({
  items,
  selectedId,
  usedAssets,
  importing = false,
  onSelect,
  onInsert,
  onImportFiles,
  onServerAssets,
  onImportAssetPack,
  onOpenFiles,
}: {
  items: readonly ProjectMediaItem[];
  selectedId: string | null;
  usedAssets: ReadonlySet<string>;
  importing?: boolean;
  onSelect(item: ProjectMediaItem): void;
  onInsert(item: ProjectMediaItem): void;
  onImportFiles(files: FileList): void;
  onServerAssets(): void;
  onImportAssetPack(): void;
  onOpenFiles(): void;
}) {
  const { i18n } = useStudioI18n();
  const [category, setCategory] = useState<ProjectMediaFilter>("all");
  const [query, setQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => {
    const map = new Map<ProjectMediaFilter, number>();
    map.set("all", items.length);
    for (const item of items) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!q) return true;
      return `${item.label} ${item.subtitle} ${item.path ?? ""} ${item.resourceRef ?? ""}`
        .toLocaleLowerCase()
        .includes(q);
    });
  }, [items, category, query]);

  const visualItems = visible.filter((item) => item.category !== "audio" && item.category !== "effect");
  const rowItems = visible.filter((item) => item.category === "audio" || item.category === "effect");
  const hasRealMedia = items.some((item) => !item.builtin);

  const isInSelection = (item: ProjectMediaItem) =>
    Boolean((item.path && usedAssets.has(item.path)) || (item.resourceRef && usedAssets.has(item.resourceRef)));

  return (
    <div className="author-media-dock">
      <input
        ref={fileInputRef}
        hidden
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        aria-label={tr("Import files")}
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files?.length) onImportFiles(files);
          event.currentTarget.value = "";
        }}
      />

      <div className="author-media-toolbar">
        <label className="author-media-search">
          <Search aria-hidden />
          <input
            type="search"
            value={query}
            aria-label={tr("Search assets")}
            placeholder={tr("Search assets")}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="author-icon-button"
              aria-label={tr("Close")}
              title={tr("Close")}
              onClick={() => setQuery("")}
            >
              <X aria-hidden />
            </button>
          )}
        </label>

        <button
          type="button"
          className="author-icon-button"
          disabled={importing}
          aria-label={tr("Import files")}
          title={tr("Import files")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden />
        </button>

        <button
          type="button"
          className="author-icon-button"
          disabled={importing}
          aria-label={tr("Import from server")}
          title={tr("Import from server")}
          onClick={onServerAssets}
        >
          <Download aria-hidden />
        </button>

        <DropdownMenu.Root dir={i18n.dir()}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="author-icon-button"
              aria-label={tr("Media actions")}
              title={tr("Media actions")}
            >
              <MoreVertical aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="editor-file-menu" align="end" sideOffset={6}>
              <DropdownMenu.Item disabled={importing} onSelect={() => fileInputRef.current?.click()}>
                {tr("Import files")}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={importing} onSelect={onServerAssets}>
                {tr("Import from server")}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={importing} onSelect={onImportAssetPack}>
                {tr("Import asset pack")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={onOpenFiles}>{tr("Project files")}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="author-media-categories" role="tablist" aria-label={tr("Media categories")}>
        {CATEGORIES.map((entry) => {
          const count = counts.get(entry.id) ?? 0;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={category === entry.id}
              className="author-media-chip"
              onClick={() => setCategory(entry.id)}
            >
              <span>{tr(entry.label)}</span>
              {entry.id !== "all" && count > 0 && <span className="author-media-chip-count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="author-media-content">
        {visible.length === 0 ? (
          <div className="author-media-empty">
            <p>{tr(hasRealMedia || query.trim() ? "authoring.noOptions" : "No project media yet")}</p>
          </div>
        ) : (
          <>
            {visualItems.length > 0 && (
              <div className="author-media-grid" role="list" aria-label={tr("Project media")}>
                {visualItems.map((item) => {
                  const selected = selectedId === item.id;
                  const used = isInSelection(item);
                  return (
                    <div
                      key={item.id}
                      role="listitem"
                      className="author-media-card"
                      data-selected={selected || undefined}
                      data-in-selection={used || undefined}
                    >
                      <button
                        type="button"
                        className="author-media-card-main"
                        aria-pressed={selected}
                        title={item.subtitle}
                        onClick={() => onSelect(item)}
                        onDoubleClick={() => onInsert(item)}
                      >
                        <span className="author-media-thumb">
                          {item.thumbUrl ? (
                            <img src={item.thumbUrl} alt="" loading="lazy" />
                          ) : (
                            <MediaCategoryIcon category={item.category} />
                          )}
                          {used && <span className="author-media-used-dot" title={tr("Used in selection")} />}
                        </span>
                        <span className="author-media-card-meta">
                          <span className="author-media-label">{item.label}</span>
                          <span className="author-media-sub">{item.subtitle}</span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {rowItems.length > 0 && (
              <div className="author-media-list" role="list" aria-label={tr("Media")}>
                {rowItems.map((item) => {
                  const selected = selectedId === item.id;
                  const used = isInSelection(item);
                  return (
                    <div
                      key={item.id}
                      role="listitem"
                      className="author-media-row"
                      data-selected={selected || undefined}
                      data-in-selection={used || undefined}
                    >
                      <button
                        type="button"
                        className="author-media-row-main"
                        aria-pressed={selected}
                        title={item.subtitle}
                        onClick={() => onSelect(item)}
                        onDoubleClick={() => onInsert(item)}
                      >
                        <span className="author-media-row-icon">
                          <MediaCategoryIcon category={item.category} />
                        </span>
                        <span className="author-media-card-meta">
                          <span className="author-media-label">{item.label}</span>
                          <span className="author-media-sub">{item.subtitle}</span>
                        </span>
                        {used && <span className="author-media-used-dot" title={tr("Used in selection")} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectMediaInspector({
  session,
  item,
  onInsert,
  onRevealFile,
}: {
  session: EditorSession;
  item: ProjectMediaItem;
  onInsert(item: ProjectMediaItem, override?: MediaInsertOverride): void;
  onRevealFile?(path: string): void;
}) {
  const fileUrl = item.path ? session.url(item.path) : undefined;
  const canImageVariants = item.mediaKind === "image" && Boolean(item.path || item.resourceRef);
  const canAudioVariants = item.category === "audio";

  return (
    <div className="author-asset-inspector">
      <div className="author-asset-preview">
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt={item.label} />
        ) : item.mediaKind === "video" && fileUrl ? (
          <video src={fileUrl} controls preload="metadata" />
        ) : item.mediaKind === "audio" && fileUrl ? (
          <audio src={fileUrl} controls preload="metadata" />
        ) : (
          <MediaCategoryIcon category={item.category} />
        )}
      </div>

      <div className="author-asset-actions">
        <button
          type="button"
          className="author-button author-button--filled"
          onClick={() => onInsert(item)}
        >
          <Plus aria-hidden />
          {tr("Insert into timeline")}
        </button>

        {canImageVariants && item.category !== "background" && (
          <button
            type="button"
            className="author-button author-button--tonal"
            onClick={() => onInsert(item, "background")}
          >
            <Image aria-hidden />
            {tr("Insert as background")}
          </button>
        )}

        {canImageVariants && item.category === "background" && (
          <button
            type="button"
            className="author-button author-button--tonal"
            onClick={() => onInsert(item, "imageClip")}
          >
            <Image aria-hidden />
            {tr("Insert as image clip")}
          </button>
        )}

        {canAudioVariants && (
          <>
            <button
              type="button"
              className="author-button author-button--tonal"
              onClick={() => onInsert(item, "bgm")}
            >
              <Music aria-hidden />
              {tr("Insert as BGM")}
            </button>
            <button
              type="button"
              className="author-button author-button--tonal"
              onClick={() => onInsert(item, "se")}
            >
              <Music aria-hidden />
              {tr("Insert as sound effect")}
            </button>
          </>
        )}

        {item.path && onRevealFile && (
          <button
            type="button"
            className="author-button author-button--tonal"
            onClick={() => onRevealFile(item.path!)}
          >
            <Folder aria-hidden />
            {tr("Reveal in files")}
          </button>
        )}
      </div>

      <dl className="author-asset-meta">
        {item.path ? (
          <div>
            <dt>{tr("File path")}</dt>
            <dd>{item.path}</dd>
          </div>
        ) : item.resourceRef ? (
          <div>
            <dt>{tr("Source ID")}</dt>
            <dd>{item.resourceRef}</dd>
          </div>
        ) : null}
        {item.file && (
          <>
            <div>
              <dt>{tr("Media type")}</dt>
              <dd>{item.file.blob.type || tr("Unknown")}</dd>
            </div>
            <div>
              <dt>{tr("File size")}</dt>
              <dd>{formatMediaSize(item.file.blob.size)}</dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}
