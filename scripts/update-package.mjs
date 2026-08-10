import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

pkg.dependencies ??= {};
pkg.devDependencies ??= {};
pkg.scripts ??= {};

const removeDeps = [
  "acorn",
  "just-debounce",
  "just-throttle",
  "memoizee",
  "p-retry",
  "dequal",
  "p-timeout",
];

for (const dep of removeDeps) {
  delete pkg.dependencies[dep];
}

delete pkg.devDependencies["@types/memoizee"];

Object.assign(pkg.dependencies, {
  pino: "^9.0.0",
  "set-cookie-parser": "^2.7.0",
});

Object.assign(pkg.devDependencies, {
  "@biomejs/biome": "^2.5.4",
  "@types/bun": "^1.3.14",
  "@types/cookie": "^1.0.0",
  "@types/set-cookie-parser": "^2.4.10",
  typescript: "^5.9.0",
  vitest: "^4.1.10",
});

Object.assign(pkg.scripts, {
  typecheck: "tsc --noEmit",
  lint: "biome check .",
  "lint:fix": "biome check --write .",
  test: "vitest run",
  "test:watch": "vitest",
  build: "bun run builder.ts",
  smoke: "bun run dist/__server.js",
});

writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
