import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
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