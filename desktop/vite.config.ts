import { defineConfig } from "vite";

// Tauri sert le dossier dist/ ; en développement, il se branche sur ce serveur.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, sourcemap: false },
});
