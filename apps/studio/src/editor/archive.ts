import { tr } from "./i18n";
import { zip, unzip } from "fflate";
import type { EditorSession } from "./session";
import type { ProjectFile } from "./library";
export async function exportProjectZip(session: EditorSession): Promise<void> {
  session.validateDocuments();
  const state = session.getSnapshot(),
    data: Record<string, Uint8Array> = Object.create(null);
  for (const file of state.files) {
    const doc = session.document(file.path);
    data[file.path] = doc ? new TextEncoder().encode(doc.text) : new Uint8Array(await file.blob.arrayBuffer());
  }
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(data, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data))),
  );
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" })),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.name.replace(/[\\/:*?"<>|]/gu, "_") + ".zip";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function importProjectZip(file: File): Promise<readonly ProjectFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let total = 0;
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      bytes,
      {
        filter(entry) {
          if (entry.name.endsWith("/")) return false;
          if (
            entry.name.startsWith("/") ||
            entry.name.includes("\\") ||
            entry.name.split("/").some((part) => part === ".." || part === "." || !part)
          )
            throw new Error(tr("The archive contains an invalid path"));
          total += entry.originalSize;
          if (total > 2 * 1024 * 1024 * 1024) throw new Error(tr("The project exceeds 2 GB"));
          return true;
        },
      },
      (error, entries) => (error ? reject(error) : resolve(entries)),
    ),
  );
  const paths = Object.keys(entries),
    prefix =
      paths.every((path) => path.includes("/") && path.split("/")[0] === paths[0]?.split("/")[0]) &&
      !paths[0]?.startsWith("game/")
        ? paths[0]!.split("/")[0]!.length + 1
        : 0;
  return paths.map((path) => ({
    path: path.slice(prefix),
    blob: new Blob([entries[path]! as Uint8Array<ArrayBuffer>]),
  }));
}
