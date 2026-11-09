import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone build for the AI conversation prototype. It shares product modules through "@/"
// (dictation comparison, mistake distance, navigation symbols) but is not part of the site build.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5179 },
  preview: { host: "127.0.0.1", port: 5179 },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, target: "es2022" },
});
