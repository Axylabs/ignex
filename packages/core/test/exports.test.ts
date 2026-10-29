/**
 * Import-surface drift guard for `@ignex/core`.
 *
 * Several implemented + tested features historically lived only in internal
 * domain barrels and were unreachable from the public entry. This test locks
 * the public surface so those symbols (durable jobs, i18n dir helpers,
 * hookToPlugin, the OpenAPI generator) stay exported, and so the `./jobs`
 * subpath resolves.
 *
 * It also pins the OTHER half of the same contract: every published subpath
 * must have a matching alias in the root `vitest.config.ts`, or the subpath
 * resolves under `tsc` and in a real install but blows up in the test run.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as jobs from "@ignex/core/jobs";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/** The root vitest config — where `@ignex/core/*` aliases are declared. */
const rootVitestConfig = readFileSync(
  fileURLToPath(new URL("../../../vitest.config.ts", import.meta.url)),
  "utf8",
);

/** Every subpath `@ignex/core` publishes, as importable specifiers. */
const publishedSpecifiers = (): string[] => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { exports: Record<string, string> };
  return Object.keys(pkg.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => (key === "." ? "@ignex/core" : `@ignex/core${key.slice(1)}`));
};

describe("@ignex/core public surface", () => {
  it("exposes the durable-jobs API from the barrel", () => {
    expect(typeof core.createDurableJobQueue).toBe("function");
    expect(typeof core.createFileJobStore).toBe("function");
    expect(typeof core.createSqliteJobStore).toBe("function");
    expect(typeof core.newJobId).toBe("function");
  });

  it("exposes the i18n directory + middleware helpers", () => {
    expect(typeof core.loadCatalogDir).toBe("function");
    expect(typeof core.createI18nFromDir).toBe("function");
    expect(typeof core.withI18n).toBe("function");
  });

  it("exposes hookToPlugin and the OpenAPI generator", () => {
    expect(typeof core.hookToPlugin).toBe("function");
    expect(typeof core.generateOpenAPI).toBe("function");
  });

  it("resolves the @ignex/core/jobs subpath with a complete surface", () => {
    expect(typeof jobs.createJobQueue).toBe("function");
    expect(typeof jobs.withRetry).toBe("function");
    expect(typeof jobs.createDurableJobQueue).toBe("function");
    expect(typeof jobs.createFileJobStore).toBe("function");
    expect(typeof jobs.createSqliteJobStore).toBe("function");
  });

  it("aliases every published subpath for the test runner", () => {
    const missing = publishedSpecifiers().filter(
      (spec) => !rootVitestConfig.includes(`"${spec}":`),
    );
    expect(missing).toEqual([]);
  });
});
