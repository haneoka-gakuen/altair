import { readdir, readFile, writeFile, cp, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../apps/studio"),
  source = resolve(root, "dist-player"),
  destination = resolve(root, "dist/player");
async function files(directory, prefix = "") {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + item.name;
    if (item.isDirectory()) result.push(...(await files(resolve(directory, item.name), path + "/")));
    else result.push(path);
  }
  return result;
}
const entries = await files(source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(
  resolve(root, "dist/player-bundle.json"),
  JSON.stringify({ version: 1, files: entries, entry: "player.html" }),
);
