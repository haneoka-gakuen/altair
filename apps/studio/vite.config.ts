import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const studioRoot = fileURLToPath(new URL(".", import.meta.url));
const localVega = resolve(studioRoot, "../../.dependencies/vega/src");
const localVegaProtocol = resolve(studioRoot, "../../.dependencies/vega/packages/protocol/src");
const localWebGalPlugin = resolve(
  studioRoot,
  "../../.dependencies/altair-plugin-webgal/src/index.ts",
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
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
            "@haneoka/vega-protocol": resolve(localVegaProtocol, "index.ts"),
          }
        : {}),
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/monaco-editor/")) return "monaco";
          if (id.includes("/pixi.js/")) return "pixi";
          if (id.includes("/three/")) return "three";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
