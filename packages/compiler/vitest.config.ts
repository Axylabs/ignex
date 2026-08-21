import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ignex/shared": alias("../shared/src/index.ts"),
      // Order matters: Vite prefix-replaces aliases, so the specific subpaths
      // must come before the package root (`@ignex/core/http` must not match
      // `@ignex/core` first) — route fixture modules import these.
      "@ignex/core/http": alias("../core/src/http/route.ts"),
      "@ignex/core/jobs": alias("../core/src/jobs.ts"),
      "@ignex/core/content": alias("../core/src/content/index.ts"),
      "@ignex/core/openapi": alias("../core/src/openapi.ts"),
      "@ignex/core/config": alias("../core/src/platform/config.ts"),
      "@ignex/core/env": alias("../core/src/platform/env-config.ts"),
      "@ignex/core/*": alias("../core/src/*"),
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
