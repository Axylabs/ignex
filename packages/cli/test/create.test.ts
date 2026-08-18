/**
 * Tests for `ignex create` — focused on the `--root` target directory flag
 * (defaults, traversal guard) rather than the full scaffold surface.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCreate } from "../src/commands/create.js";

/** Create a throwaway parent dir for one test. */
function tmpParent(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-create-"));
}

describe("ignex create --root", () => {
  it("scaffolds the app under --root instead of cwd", async () => {
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

      const target = join(base, "demo");
      expect(existsSync(join(target, "package.json"))).toBe(true);
      expect(existsSync(join(target, "src/routes/index.get.ts"))).toBe(true);
      // The `openapi` feature now installs the `openapi()` plugin (app.config)
      // instead of a broken `openapi.json.get.ts` route that served an empty spec.
      expect(existsSync(join(target, "src/routes/openapi.json.get.ts"))).toBe(false);
      expect(existsSync(join(target, "src/app.config.ts"))).toBe(true);
      expect(readFileSync(join(target, "src/app.config.ts"), "utf8")).toContain("openapi()");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal project names even with --root", async () => {
    const base = tmpParent();
    const originalExitCode = process.exitCode;
    try {
      await runCreate(["..", "--root", base, "--yes", "--no-install", "--no-git"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
