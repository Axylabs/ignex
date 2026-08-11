import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ignus/shared": alias("../shared/src/index.ts"),
      "@ignus/core": alias("../core/src/index.ts"),
      "@ignus/native": alias("../native/src/index.ts"),
      "@ignus/compiler": alias("../compiler/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
