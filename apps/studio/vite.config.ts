import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const studioRoot = fileURLToPath(new URL(".", import.meta.url));
const studioRequire = createRequire(new URL("./package.json", import.meta.url));
const studioPackage = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const packageFile = (entry: string): string => {
  let directory = dirname(entry);
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Package metadata is unavailable for ${entry}`);
    directory = parent;
  }
  return resolve(directory, "package.json");
};
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    dedupe: Object.keys(studioPackage.dependencies),
    alias: Object.entries({
      "@haneoka/altair/documents": resolve(studioRoot, "../../src/documents-entry.ts"),
      "@haneoka/altair/host": resolve(studioRoot, "../../src/host.ts"),
      "@haneoka/altair/model": resolve(studioRoot, "../../src/model.ts"),
      "@haneoka/altair/plugins": resolve(studioRoot, "../../src/plugins.ts"),
      "@haneoka/altair/protocol": resolve(studioRoot, "../../src/protocol.ts"),
      "@haneoka/altair": resolve(studioRoot, "../../src/index.ts"),
      "@haneoka/altair-preview-client": resolve(studioRoot, "../../packages/preview-client/src/index.ts"),
    }).map(([specifier, replacement]) => ({
      find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      replacement,
    })),
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(studioRoot),
        dirname(packageFile(studioRequire.resolve("@haneoka/vega-theme-haneoka"))),
      ],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    watch: {
      // Linked package builds can rewrite hundreds of generated modules at
      // once. Source aliases above remain hot-reloadable; build output does not.
      ignored: ["**/dist/**", "**/.dependencies/**"],
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("vite/preload-helper") || id.includes("vite/modulepreload-polyfill")) return "preload-helper";
          if (id.includes("/monaco-editor/") && !id.includes("/nls/lang/") && !id.includes("?worker")) return "monaco";
          if (id.includes("/three/")) return "three";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
