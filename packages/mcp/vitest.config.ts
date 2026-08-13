import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * MCP vitest config — lets `bun run test` work from the MCP package cwd.
 * Order matters: `@ignex/cli/route` must precede `@ignex/cli` (prefix matching).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignex/cli/route": alias("../cli/src/route.ts"),
      "@ignex/cli": alias("../cli/src/index.ts"),
      "@ignex/compiler": alias("../compiler/src/index.ts"),
      "@ignex/native": alias("../native/src/index.ts"),
      "@ignex/core": alias("../core/src/index.ts"),
      "@ignex/shared": alias("../shared/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
