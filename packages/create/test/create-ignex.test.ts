/**
 * Integration test for the `create-ignex` shim — it must resolve `@ignex/cli`
 * from its own dependency and forward to `ignex create` end to end (spawns a
 * real child process).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "create-ignex.js");

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("create-ignex shim", () => {
  it("forwards to `ignex create` and scaffolds the app", () => {
    const cwd = mkdtempSync(join(tmpdir(), "create-ignex-"));
    dirs.push(cwd);

    const result = spawnSync(
      "bun",
      // `cors` selects the plugins feature path (src/plugins/index.ts +
      // app.config plugins array) — the TDZ regression lived there.
      [BIN, "demo", "--features", "openapi,cors", "--yes", "--no-install", "--no-git"],
      { cwd, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(cwd, "demo", "package.json"))).toBe(true);
    expect(existsSync(join(cwd, "demo", "src/routes/index.get.ts"))).toBe(true);
    expect(existsSync(join(cwd, "demo", "src/plugins/index.ts"))).toBe(true);
    // The plugins import must be aliased — never `export const plugins = [...plugins]`.
    const config = readFileSync(join(cwd, "demo", "src/app.config.ts"), "utf8");
    expect(config).toContain('import { plugins as appPlugins } from "./plugins/index.js";');
    expect(config).not.toContain("...plugins,");
    // The debugbar dev dashboard ships in every scaffold.
    expect(config).toContain("debugbar()");
  });
});
