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
      "@flux/shared": alias("packages/shared/src/index.ts"),
      // Order matters: Vite prefix-replaces aliases, so the specific subpath
      // must come before the package root (`@flux/core/http` must not match
      // `@flux/core` first).
      "@flux/core/http": alias("packages/core/src/http/route.ts"),
      "@flux/core/*": alias("packages/core/src/*"),
      "@flux/core": alias("packages/core/src/index.ts"),
      "@flux/compiler": alias("packages/compiler/src/index.ts"),
      "@flux/native": alias("packages/native/src/index.ts"),
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
