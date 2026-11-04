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
  parents?: readonly FileNode[];
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
  selected,
  onSelect,
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
  selected?: ReadonlySet<string>;
  onSelect?(path: string): void;
}) {
  const { i18n } = useStudioI18n();
  const treeId = useId();
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const regionId = (path: string) => `${treeId}-folder-${encodeURIComponent(path)}`;
  const toggleFolder = (path: string, parents: readonly FileNode[] = []) =>
    setClosedFolders((current) => {
      const next = new Set(current);
      const closed = next.has(path) || parents.some((parent) => next.has(parent.path));
      parents.forEach((parent) => next.delete(parent.path));
      if (closed) next.delete(path);
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
  const menuItems = (node: FileNode) => (
    <>
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
    </>
  );
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
          {menuItems(node)}
          {!!node.parents?.length && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>
                {tr("Parent folders")}
                <ChevronRight size={16} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="editor-file-menu">
                  {node.parents.map((parent) => (
                    <DropdownMenu.Sub key={parent.path}>
                      <DropdownMenu.SubTrigger title={parent.path}>
                        {parent.path}
                        <ChevronRight size={16} />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent className="editor-file-menu">
                          {menuItems(parent)}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  const compact = (node: FileNode): FileNode => {
    const parents: FileNode[] = [],
      names = [node.name];
    let current = node;
    while (!current.file && current.children.size === 1) {
      const next = current.children.values().next().value!;
      if (next.file) break;
      parents.push(current);
      names.push(next.name);
      current = next;
    }
    return parents.length
      ? { ...current, parents, name: names.length > 3 ? `${names[0]}/…/${names.at(-1)}` : names.join("/") }
      : node;
  };
  const selection = (node: FileNode) =>
    selected && (
      <label className="file-tree-selection">
        <input
          type="checkbox"
          aria-label={tr("Select {{path}}", { path: node.path })}
          checked={selected.has(node.path)}
          disabled={disabled || node.path === "project.yaml"}
          onChange={() => onSelect?.(node.path)}
        />
      </label>
    );
  const render = (nodes: Map<string, FileNode>) =>
    [...nodes.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, i18n.resolvedLanguage))
      .map((original) => {
        const node = compact(original);
        const closed = closedFolders.has(node.path) || !!node.parents?.some((parent) => closedFolders.has(parent.path));
        return node.file ? (
          <div className="file-tree-row" key={node.path}>
            {selection(node)}
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
              {selection(node)}
              <button
                type="button"
                className="file-tree-toggle"
                id={`${regionId(node.path)}-trigger`}
                aria-expanded={!closed}
                aria-controls={regionId(node.path)}
                onClick={() => toggleFolder(node.path, node.parents)}
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
              hidden={closed}
            >
              {render(node.children)}
            </div>
          </div>
        );
      });
  return <div className="file-tree">{render(roots)}</div>;
}
