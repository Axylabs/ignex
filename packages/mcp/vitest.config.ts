import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * MCP vitest config — lets `bun run test` work from the MCP package cwd.
 * Order matters: `@ignus/cli/route` must precede `@ignus/cli` (prefix matching).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignus/cli/route": alias("../cli/src/route.ts"),
      "@ignus/cli": alias("../cli/src/index.ts"),
      "@ignus/compiler": alias("../compiler/src/index.ts"),
      "@ignus/native": alias("../native/src/index.ts"),
      "@ignus/core": alias("../core/src/index.ts"),
      "@ignus/shared": alias("../shared/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
