import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Native vitest config — lets `bun run test` work from the native package
 * cwd (the root config's include pattern is root-relative and misses this
 * package when run from `packages/native`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignex/shared": alias("../shared/src/index.ts"),
      "@ignex/core": alias("../core/src/index.ts"),
      "@ignex/native": alias("../native/src/index.ts"),
      "@ignex/test-utils": alias("../test-utils/src/index.ts"),
      // Keep the Rust addon out of unit tests (fallbacks only) unless
      // IGNEX_NATIVE_PATH is explicitly set — matches the root config.
      castrum: alias("../native/src/vendor/castrum.d.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
