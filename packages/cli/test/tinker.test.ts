/**
 * `ignex tinker` — REPL context loading.
 *
 * The REPL itself is interactive (node:repl over stdin) and hard to drive in
 * vitest; the CONTEXT loading (db.ts / env.ts / nova events resolution) is
 * pure and exercised against throwaway temp projects.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ignex-cli-tinker-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Symlink the workspace packages so temp-project imports resolve. */
function linkWorkspace(dir: string): void {
  mkdirSync(join(dir, "node_modules", "@ignex"), { recursive: true });
  symlinkSync(join(process.cwd(), "packages/core"), join(dir, "node_modules", "@ignex/core"));
  symlinkSync(join(process.cwd(), "packages/native"), join(dir, "node_modules", "@ignex/native"));
  symlinkSync(join(process.cwd(), "packages/shared"), join(dir, "node_modules", "@ignex/shared"));
}

describe("tinker context loading", () => {
  it("boots into the REPL without a db.ts (no crash, hints shown)", async () => {
    const dir = tmpProject();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-db-app" }));
    mkdirSync(join(dir, "src"));
    linkWorkspace(dir);

    // Run tinker with stdin closed-ish: a piped expression then .exit.
    const { spawnSync } = await import("node:child_process");
    const cli = join(process.cwd(), "packages/cli/bin/ignex.js");
    const res = spawnSync("bun", [cli, "tinker", "--no-db", "--root", dir], {
      input: "1 + 1;\n.exit\n",
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("No src/db.ts found");
    expect(res.stdout).toContain("ignex>");
  });

  it("declares tinker in the command registry with a --no-db flag", async () => {
    const { findCommand } = await import("../src/commands/registry.js");
    const cmd = findCommand("tinker");
    expect(cmd?.name).toBe("tinker");
    expect(cmd?.aliases).toContain("repl");
    expect(cmd?.options).toContain("--no-db");
  });
});
