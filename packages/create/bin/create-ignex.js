#!/usr/bin/env node
/**
 * create-ignex — the `npm create ignex` / `bun create ignex` entry point.
 *
 * Ignex is Bun-first and `@ignex/cli` ships source-only TypeScript, so this
 * thin shim re-executes the real CLI through Bun. It requires Bun >= 1.4 and
 * forwards every argument to `ignex create`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** True when a `bun` binary resolves on PATH. */
function hasBun() {
  try {
    return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// When running under Bun itself (`bun create ignex`) use the current binary;
// otherwise fall back to a `bun` on PATH.
const runner = process.versions.bun ? process.execPath : "bun";

if (!process.versions.bun && !hasBun()) {
  console.error("create-ignex requires Bun (https://bun.sh). Install it and try again.");
  process.exit(1);
}

let cliBin;
try {
  cliBin = require.resolve("@ignex/cli/bin/ignex.js");
} catch {
  console.error("Could not resolve @ignex/cli. Try: bunx @ignex/cli@latest create <name>");
  process.exit(1);
}

const result = spawnSync(runner, [cliBin, "create", ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
