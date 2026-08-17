import { defineConfig } from "vitest/config";

/**
 * create-ignex vitest config — lets `bun run test` work from the package cwd.
 * The test spawns a real child process (the shim), so no source aliases are
 * needed; the workspace symlink resolves `@ignex/cli` at runtime.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
