import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every suite shares one real MySQL database, so files must not interleave.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
