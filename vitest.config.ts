import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Root vitest config — used for cross-package test runs (`test:all`).
 * Each package may still ship its own `vitest.config.ts` for targeted runs;
 * this one provides deterministic workspace aliases so source-only packages
 * resolve without requiring `node_modules` symlinks.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ignex/shared": alias("packages/shared/src/index.ts"),
      // Order matters: Vite prefix-replaces aliases, so the specific subpath
      // must come before the package root (`@ignex/core/http` must not match
      // `@ignex/core` first).
      "@ignex/core/http": alias("packages/core/src/http/route.ts"),
      "@ignex/core/jobs": alias("packages/core/src/jobs.ts"),
      "@ignex/core/content": alias("packages/core/src/content/index.ts"),
      "@ignex/core/openapi": alias("packages/core/src/openapi.ts"),
      "@ignex/core/config": alias("packages/core/src/platform/config.ts"),
      "@ignex/core/*": alias("packages/core/src/*"),
      "@ignex/core": alias("packages/core/src/index.ts"),
      "@ignex/compiler": alias("packages/compiler/src/index.ts"),
      "@ignex/native": alias("packages/native/src/index.ts"),
      "@ignex/mcp": alias("packages/mcp/src/index.ts"),
      "@ignex/test-utils": alias("packages/test-utils/src/index.ts"),
      castrum: alias("packages/native/src/vendor/castrum.d.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts", "packages/native/src/vendor/**", "packages/app/**"],
      thresholds: {
        lines: 60,
        functions: 50,
        statements: 55,
        branches: 40,
      },
    },
  },
});
