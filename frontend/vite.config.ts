import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false },
  server: { allowedHosts: true },
  test: {
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    teardownTimeout: 2000,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
} as Parameters<typeof defineConfig>[0]);
