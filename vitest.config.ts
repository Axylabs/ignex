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
      "@ignex/core/env": alias("packages/core/src/platform/env-config.ts"),
      "@ignex/core/*": alias("packages/core/src/*"),
      "@ignex/core": alias("packages/core/src/index.ts"),
      "@ignex/compiler": alias("packages/compiler/src/index.ts"),
      "@ignex/native": alias("packages/native/src/index.ts"),
      "@ignex/mcp": alias("packages/mcp/src/index.ts"),
      "@ignex/test-utils": alias("packages/test-utils/src/index.ts"),
      // Nova is a workspace package; subpaths resolve through its exports map
      // (public/*.ts) — explicit aliases keep vitest deterministic.
      "@ignex/nova/server": alias("packages/nova/public/server.ts"),
      "@ignex/nova/client": alias("packages/nova/public/client.ts"),
      "@ignex/nova/nats": alias("packages/nova/public/nats.ts"),
      "@ignex/nova/events": alias("packages/nova/public/events.ts"),
      "@ignex/nova/bindings": alias("packages/nova/public/bindings.ts"),
      "@ignex/nova/generate": alias("packages/nova/public/generate.ts"),
      "@ignex/nova/internal": alias("packages/nova/public/internal.ts"),
      "@ignex/nova": alias("packages/nova/index.ts"),
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
        // quality job deliberately.
        lines: 70,
        functions: 60,
        statements: 65,
        branches: 50,
      },
    },
  },
});
