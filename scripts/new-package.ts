#!/usr/bin/env bun
/**
 * Workspace package scaffolder — `bun scripts/new-package.ts <name>`.
 *
 * Creates `packages/<name>/` following the ignus monorepo conventions
 * (source-only: exports point at `src/*.ts`, no build step). Reduces the
 * boilerplate of hand-copying package.json/tsconfig/test conventions when
 * adding a new workspace package.
 *
 * Next steps after scaffolding:
 *   - add an alias to `vitest.config.ts` if the package imports other
 *     `@ignus/*` packages from source,
 *   - `bun run --cwd packages/<name> test`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun scripts/new-package.ts <name>");
  process.exit(1);
}

const safe = input
  .replace(/^@ignus\//, "")
  .replace(/[^a-z0-9-]/gi, "-")
  .toLowerCase();
const pkgName = `@ignus/${safe}`;
const root = resolve(import.meta.dir, "..");
const dir = join(root, "packages", safe);

if (existsSync(dir)) {
  console.error(`Package ${pkgName} already exists at ${dir}`);
  process.exit(1);
}

mkdirSync(join(dir, "src"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });

const packageJson = {
  name: pkgName,
  version: "0.1.0",
  license: "MIT",
  type: "module",
  main: "./src/index.ts",
  module: "./src/index.ts",
  types: "./src/index.ts",
  files: ["src"],
  engines: { bun: ">=1.4" },
  scripts: {
    typecheck: "tsc --noEmit -p ../../tsconfig.json",
    test: "vitest run",
  },
  description: `${safe} package for Ignus.`,
  exports: { ".": "./src/index.ts" },
  devDependencies: {
    typescript: "^7.0.2",
    vitest: "^4.1.10",
  },
};

const indexSource = `/**
 * ${pkgName}
 */
export const VERSION = "0.1.0";
`;

const testSource = `import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("${safe}", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
`;

const readme = `# ${pkgName}

> ${safe} package for Ignus.

## Development

\`\`\`sh
bun run --cwd packages/${safe} test
bun run --cwd packages/${safe} typecheck
\`\`\`
`;

writeFileSync(join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(join(dir, "src/index.ts"), indexSource);
writeFileSync(join(dir, "test/index.test.ts"), testSource);
writeFileSync(join(dir, "README.md"), readme);

console.log(`✔ Created ${pkgName} at packages/${safe}`);
console.log("Next steps:");
console.log(
  "  - Add an alias to vitest.config.ts if this package imports other @ignus packages from source.",
);
console.log(`  - Run: bun run --cwd packages/${safe} test`);
