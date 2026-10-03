import { useId, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, FileText, Folder, MoreVertical } from "lucide-react";
import type { ProjectFile } from "./library";
import { tr, useStudioI18n } from "./i18n";
import "./file-tree.css";

interface FileNode {
  path: string;
  name: string;
  file?: ProjectFile;
  children: Map<string, FileNode>;
}
export function FileTree({
  files,
  active,
  query,
  onOpen,
  onMove,
  directories = [],
  dirtyPaths,
  disabled,
  canPaste,
  onCopy,
  onCut,
  onDuplicate,
  onPaste,
  onNewDirectory,
  onDelete,
}: {
  files: readonly ProjectFile[];
  active: string;
  query: string;
  onOpen(path: string): void;
  onMove(path: string): void;
  directories?: readonly string[];
  dirtyPaths?: ReadonlySet<string>;
  disabled?: boolean;
  canPaste?: boolean;
  onCopy(path: string): void;
  onCut(path: string): void;
  onDuplicate(path: string): void;
  onPaste(directory: string): void;
  onNewDirectory(directory: string): void;
  onDelete(path: string): void;
}) {
  const { i18n } = useStudioI18n();
  const treeId = useId();
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const regionId = (path: string) => `${treeId}-folder-${encodeURIComponent(path)}`;
  const toggleFolder = (path: string) =>
    setClosedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const roots = useMemo(() => {
    const roots = new Map<string, FileNode>();
    for (const entry of [
      ...directories.map((path) => ({ path, file: undefined })),
      ...files.map((file) => ({ path: file.path, file })),
    ]) {
      if (!entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      let nodes = roots,
        path = "";
      const parts = entry.path.split("/");
      for (const [index, name] of parts.entries()) {
        path = path ? `${path}/${name}` : name;
        let node = nodes.get(name);
        if (!node) {
          node = { path, name, children: new Map() };
          nodes.set(name, node);
        }
        if (index === parts.length - 1 && entry.file) node.file = entry.file;
        nodes = node.children;
      }
    }
    return roots;
  }, [files, query, directories]);
  const menu = (node: FileNode) => (
    <DropdownMenu.Root dir={i18n.dir()}>
      <DropdownMenu.Trigger
        className="icon-button"
        aria-label={tr("Actions for {{path}}", { path: node.path })}
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreVertical size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="editor-file-menu" align="end">
          <DropdownMenu.Item disabled={node.path === "project.yaml"} onSelect={() => onMove(node.path)}>
            {tr("Rename or move")}
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={node.path === "project.yaml"} onSelect={() => onCopy(node.path)}>
            {tr("Copy file or folder")}
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={node.path === "project.yaml"} onSelect={() => onCut(node.path)}>
            {tr("Cut file or folder")}
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={node.path === "project.yaml"} onSelect={() => onDuplicate(node.path)}>
            {tr("Duplicate file or folder")}
          </DropdownMenu.Item>
          {!node.file && (
            <>
              <DropdownMenu.Item disabled={!canPaste} onSelect={() => onPaste(node.path)}>
                {tr("Paste into folder")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => onNewDirectory(node.path)}>{tr("New folder")}</DropdownMenu.Item>
            </>
          )}
          <DropdownMenu.Item disabled={node.path === "project.yaml"} onSelect={() => onDelete(node.path)}>
            {tr("Delete file or folder")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  const render = (nodes: Map<string, FileNode>) =>
    [...nodes.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, i18n.resolvedLanguage))
      .map((node) =>
        node.file ? (
          <div className="file-tree-row" key={node.path}>
            <button
              className={node.path === active ? "file-item active" : "file-item"}
              onClick={() => onOpen(node.path)}
              title={node.path}
            >
              <FileText size={14} />
              <span>{node.name}</span>
              {dirtyPaths?.has(node.path) && <span className="dirty-dot" aria-label={tr("Unsaved changes")} />}
            </button>
            {menu(node)}
          </div>
        ) : (
          <div className="file-tree-folder" key={node.path}>
            <div className="file-tree-folder-heading">
              <button
                type="button"
                className="file-tree-toggle"
                id={`${regionId(node.path)}-trigger`}
                aria-expanded={!closedFolders.has(node.path)}
                aria-controls={regionId(node.path)}
                onClick={() => toggleFolder(node.path)}
                title={node.path}
              >
                <ChevronRight size={16} className="file-tree-chevron" aria-hidden="true" />
                <Folder size={16} aria-hidden="true" />
                <span>{node.name}</span>
              </button>
              {menu(node)}
            </div>
            <div
              id={regionId(node.path)}
              role="region"
              aria-labelledby={`${regionId(node.path)}-trigger`}
              className="file-tree-children"
              hidden={closedFolders.has(node.path)}
            >
              {render(node.children)}
            </div>
          </div>
        ),
      );
  return <div className="file-tree">{render(roots)}</div>;
}
