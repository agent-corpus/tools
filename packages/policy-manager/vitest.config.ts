import { defineConfig } from "vitest/config";

export default defineConfig({
  // Windows runners are slower at the many short git processes these tests start.
  test: {
    setupFiles: ["./test/isolation.ts"],
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 60_000 : 10_000,
  },
});
