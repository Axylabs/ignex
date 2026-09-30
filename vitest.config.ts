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
      "@ignex/core/debug": alias("packages/core/src/debug/index.ts"),
      "@ignex/core/env": alias("packages/core/src/platform/env-config.ts"),
      "@ignex/core/*": alias("packages/core/src/*"),
      "@ignex/core": alias("packages/core/src/index.ts"),
      "@ignex/compiler": alias("packages/compiler/src/index.ts"),
      "@ignex/native": alias("packages/native/src/index.ts"),
      "@ignex/mcp": alias("packages/mcp/src/index.ts"),
      "@ignex/test-utils": alias("packages/test-utils/src/index.ts"),
      // Schema fixtures are materialized into /tmp (outside any package), so a
      // bare `typebox` import can't resolve via node_modules — alias it to a
      // real install (the compiler's copy). Subpath first (`typebox/value`),
      // mirroring the @ignex subpath pattern.
      "typebox/value": alias("packages/compiler/node_modules/typebox/build/value/index.mjs"),
      typebox: alias("packages/compiler/node_modules/typebox/build/index.mjs"),
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
        // Raised 2026-08-19 after the hardening pass (aggregate was ~75-77%
        // statements/lines). These are the CI floor — drift below fails the
        // quality job deliberately. Measured 2026-09-29 on Linux with NO addon
        // (the condition the CI `quality` lane runs under, which is why the
        // native numbers below are fallback-mode figures): 77.5 lines /
        // 75.3 statements / 75.9 functions / 66.1 branches.
        lines: 70,
        functions: 60,
        statements: 65,
        branches: 50,
        // Per-package floors. The aggregate alone let a single package rot
        // underneath a healthy tree average (`native` sat at 57.7% lines,
        // `cli` at 63.0% while the tree reported 77.5%). Each floor is the
        // 2026-09-29 measurement minus a small margin, and these are the
        // authoritative gates — `packages/test-utils` is deliberately absent
        // because it is private test scaffolding, not a published surface.
        "packages/core/src/**": { lines: 82, statements: 80, functions: 79, branches: 70 },
        "packages/compiler/src/**": { lines: 84, statements: 81, functions: 86, branches: 69 },
        "packages/shared/src/**": { lines: 95, statements: 92, functions: 95, branches: 84 },
        "packages/cli/src/**": { lines: 60, statements: 58, functions: 62, branches: 54 },
        "packages/mcp/src/**": { lines: 68, statements: 66, functions: 46, branches: 53 },
        "packages/native/src/**": { lines: 54, statements: 51, functions: 48, branches: 33 },
      },
    },
  },
});
