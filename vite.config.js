import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});