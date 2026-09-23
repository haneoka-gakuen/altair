import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const studioRoot = fileURLToPath(new URL(".", import.meta.url));
const studioRequire = createRequire(new URL("./package.json", import.meta.url));
const packageFile = (entry: string): string => {
  let directory = dirname(entry);
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Package metadata is unavailable for ${entry}`);
    directory = parent;
  }
  return resolve(directory, "package.json");
};
const pixiPackageFile = packageFile(studioRequire.resolve("pixi.js"));
const pixiPackage = JSON.parse(readFileSync(pixiPackageFile, "utf8"));
const pixiRequire = createRequire(pixiPackageFile);
const pixiAliases = Object.fromEntries(
  ["pixi.js", ...Object.keys(pixiPackage.dependencies)].map((name) => {
    const metadata = packageFile(pixiRequire.resolve(name));
    const manifest = JSON.parse(readFileSync(metadata, "utf8"));
    return [name, resolve(dirname(metadata), manifest.module ?? manifest.main)];
  }),
);
const localVega = resolve(studioRoot, "../../.dependencies/vega/src");
const localVegaProtocol = resolve(studioRoot, "../../.dependencies/vega/packages/protocol/src");
const localWebGalPlugin = resolve(studioRoot, "../../.dependencies/altair-plugin-webgal/src/index.ts");

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    dedupe: ["three", "react", "react-dom"],
    alias: Object.entries({
      ...pixiAliases,
      "@haneoka/altair/documents": resolve(studioRoot, "../../src/documents-entry.ts"),
      "@haneoka/altair/host": resolve(studioRoot, "../../src/host.ts"),
      "@haneoka/altair/model": resolve(studioRoot, "../../src/model.ts"),
      "@haneoka/altair/plugins": resolve(studioRoot, "../../src/plugins.ts"),
      "@haneoka/altair/protocol": resolve(studioRoot, "../../src/protocol.ts"),
      "@haneoka/altair": resolve(studioRoot, "../../src/index.ts"),
      "@haneoka/altair-preview-client": resolve(studioRoot, "../../packages/preview-client/src/index.ts"),
      ...(existsSync(localVega)
        ? {
            "@haneoka/vega/engine": resolve(localVega, "engine-entry.ts"),
            "@haneoka/vega/preview": resolve(localVega, "preview-entry.ts"),
          }
        : {}),
      ...(existsSync(localWebGalPlugin)
        ? {
            "@haneoka/altair-plugin-webgal": localWebGalPlugin,
          }
        : {}),
      ...(existsSync(localVegaProtocol)
        ? {
            "@haneoka/vega-protocol/opcodes": resolve(localVegaProtocol, "opcodes.ts"),
            "@haneoka/vega-protocol/coordinates": resolve(localVegaProtocol, "coordinates.ts"),
            "@haneoka/vega-protocol": resolve(localVegaProtocol, "index.ts"),
          }
        : {}),
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
      ignored: ["**/dist/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/monaco-editor/")) return "monaco";
          if (id.includes("/pixi.js/")) return "pixi";
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
