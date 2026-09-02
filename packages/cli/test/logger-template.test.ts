/**
 * Tests for the `logger` feature's global app logger — the scaffolded
 * `src/lib/logger.ts` (a pino-backed `log` importable from any route/hook)
 * and its presence in `ignex create` output.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseFeatures, runCreate } from "../src/commands/create.js";
import { loggerLibTemplate } from "../src/templates/logger.js";
import { FEATURE_NAMES } from "../src/types.js";

/** Create a throwaway parent dir for one test. */
function tmpParent(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-logger-"));
}

test("FEATURE_NAMES includes logger", () => {
  expect(FEATURE_NAMES).toContain("logger");
});

test("parseFeatures resolves logger", () => {
  expect(parseFeatures("logger")).toEqual(new Set(["logger"]));
});

test("loggerLibTemplate exports the extendable app logger from @ignex/core", () => {
  const code = loggerLibTemplate();
  expect(code).toContain('import { createAppLogger } from "@ignex/core";');
  expect(code).toContain('import { env } from "../config/env.js";');
  expect(code).toContain("export const log = createAppLogger({");
  expect(code).toContain("level: env.LOG_LEVEL,");
  expect(code).toContain('pretty: env.NODE_ENV !== "production",');
  expect(code).toContain("createAppLogger");
});

test("ignex create writes src/lib/logger.ts when the logger feature is selected", async () => {
  const base = tmpParent();
  try {
    await runCreate([
      "demo",
      "--root",
      base,
      "--features",
      "logger,openapi",
      "--yes",
      "--no-install",
      "--no-git",
    ]);

    const file = join(base, "demo/src/lib/logger.ts");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("createAppLogger");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ignex create omits src/lib/logger.ts without the logger feature", async () => {
  const base = tmpParent();
  try {
    await runCreate([
      "demo",
      "--root",
      base,
      "--features",
      "openapi",
      "--yes",
      "--no-install",
      "--no-git",
    ]);

    expect(existsSync(join(base, "demo/src/lib/logger.ts"))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
