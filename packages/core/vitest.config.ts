import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Core vitest config — lets `bun run test` work from the core package cwd
 * (the root config's include pattern is root-relative and misses this
 * package when run from `packages/core`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignus/shared": alias("../shared/src/index.ts"),
      "@ignus/native": alias("../native/src/index.ts"),
      // Order matters: Vite prefix-replaces aliases, so the specific subpath
      // must come before the package root (`@ignus/core/http` must not match
      // `@ignus/core` first) — mirrors the root vitest.config.ts.
      "@ignus/core/http": alias("../core/src/http/route.ts"),
      "@ignus/core": alias("../core/src/index.ts"),
      // Keep the Rust addon out of unit tests (fallbacks only) unless
      // IGNUS_NATIVE_PATH is explicitly set — matches the root config.
      castrum: alias("../native/src/vendor/castrum.d.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
