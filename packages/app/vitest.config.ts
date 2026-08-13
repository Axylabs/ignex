import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ignex/shared": alias("../shared/src/index.ts"),
      "@ignex/core": alias("../core/src/index.ts"),
      "@ignex/native": alias("../native/src/index.ts"),
      "@ignex/compiler": alias("../compiler/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
