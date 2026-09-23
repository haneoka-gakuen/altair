import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => resolve(packageRoot, "src", file);
const localVegaProtocol = resolve(packageRoot, ".dependencies/vega/packages/protocol/src");

export default defineConfig({
  resolve: {
    alias: existsSync(localVegaProtocol)
      ? {
          "@haneoka/vega-protocol": resolve(localVegaProtocol, "index.ts"),
        }
      : {},
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: source("index.ts"),
        host: source("host.ts"),
        model: source("model.ts"),
        documents: source("documents-entry.ts"),
        plugins: source("plugins.ts"),
        protocol: source("protocol.ts"),
        "resource-browser": source("resource-browser.ts"),
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    minify: false,
    rollupOptions: {
      external: ["semver", "yaml"],
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
