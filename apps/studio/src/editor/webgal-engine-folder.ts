import type {
  AltairBrowserWorkspaceService,
  AltairBrowserWorkspaceSnapshot,
} from "@haneoka/altair-plugin-workspace-browser";
import type { ProjectArchive } from "./archive";
import { abortableOperation } from "./abortable-operation";

const signature = (snapshot: AltairBrowserWorkspaceSnapshot) =>
  JSON.stringify([
    [...snapshot.files]
      .map((file) => [file.path, file.size, file.lastModified])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    [...(snapshot.directories ?? [])].sort(),
  ]);
/** Copy one selected read-only engine folder into an editor-owned, stable byte snapshot. */
export async function readWebGalEngineFolder(
  workspace: AltairBrowserWorkspaceService,
  signal?: AbortSignal,
): Promise<ProjectArchive> {
  signal?.throwIfAborted();
  const captured = workspace.current,
    original = signature(captured),
    files = [];
  if (captured.files.length + (captured.directories?.length ?? 0) > 20_000)
    throw new Error("The engine folder contains too many entries");
  if (captured.files.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 * 1024)
    throw new Error("The installed engine exceeds 512 MB");
  for (const entry of captured.files) {
    signal?.throwIfAborted();
    const file = await workspace.file(entry.path, { signal });
    if (file.size !== entry.size || file.lastModified !== entry.lastModified)
      throw new Error("The engine folder changed while importing. Select it again.");
    const bytes = await abortableOperation(() => file.arrayBuffer(), [signal]);
    files.push({ path: entry.path, blob: new Blob([bytes], { type: file.type }) });
  }
  signal?.throwIfAborted();
  if (workspace.directory && signature(await workspace.refresh({ signal })) !== original)
    throw new Error("The engine folder changed while importing. Select it again.");
  return { files, directories: captured.directories ?? [] };
}
