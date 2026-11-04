import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  base: "./",
  resolve: { dedupe: ["three"] },
  build: {
    outDir: "dist-player",
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "player.html") },
  },
});
