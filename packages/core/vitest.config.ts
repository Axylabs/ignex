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
      "@ignex/shared": alias("../shared/src/index.ts"),
      "@ignex/native": alias("../native/src/index.ts"),
      // Order matters: Vite prefix-replaces aliases, so the specific subpath
      // must come before the package root (`@ignex/core/http` must not match
      // `@ignex/core` first) — mirrors the root vitest.config.ts.
      "@ignex/core/http": alias("../core/src/http/route.ts"),
      "@ignex/core": alias("../core/src/index.ts"),
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
