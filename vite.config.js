import { defineConfig } from "vite";

const isCodespaces = process.env.CODESPACES === "true";

export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    hmr: isCodespaces ? false : undefined,
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web", "onnxruntime-web/all"],
  },
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});