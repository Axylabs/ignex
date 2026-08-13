import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * CLI vitest config — lets `bun run test` work from the CLI package cwd
 * (the root config's include pattern is root-relative and misses this
 * package when run from `packages/cli`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignex/shared": alias("../shared/src/index.ts"),
      "@ignex/core": alias("../core/src/index.ts"),
      "@ignex/native": alias("../native/src/index.ts"),
      "@ignex/compiler": alias("../compiler/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
