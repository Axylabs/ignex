import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flux/shared": alias("../shared/src/index.ts"),
      "@flux/core": alias("../core/src/index.ts"),
      "@flux/native": alias("../native/src/index.ts"),
      "@flux/compiler": alias("../compiler/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
