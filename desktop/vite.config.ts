import { defineConfig } from "vite";

// Interface d'Eclipse Desktop : servie par Tauri (application) ou par le moteur (`eclipse web`, navigateur).
export default defineConfig({
  base: "./",
  clearScreen: false,
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1500 },
});
