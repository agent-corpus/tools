import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  esbuild: { jsx: "automatic" },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
