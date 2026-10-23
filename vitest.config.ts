import { defineConfig } from "vitest/config";

// App unit tests only: sync-server/ has its own suite, which runs in the
// Workers runtime (cd sync-server && npm test).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
