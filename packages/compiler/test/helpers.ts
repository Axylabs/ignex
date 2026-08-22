import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The repo root (ignus) — hosts @ignex workspace links under node_modules. */
const repoRoot = resolve(fixturesDir, "../../../..");

export interface FixtureLayout {
  routesDir: string;
  outDir: string;
}

/**
 * Copy a committed fixture directory into a fresh temp dir so builds never
 * write into the repository.
 *
 * The fixture routes import `@ignex/core` / `typebox`, but vitest's module
 * runner (vite-node) resolves packages relative to the importing file and
 * cannot reach the repo's per-package node_modules from a /tmp dir — which
 * silently degraded schema extraction. A minimal `node_modules` tree of
 * symlinks into the repo makes the compiler's precompilation path work.
 */
export const materializeFixture = (name: string): FixtureLayout => {
  const outDir = mkdtempSync(join(tmpdir(), "ignex-compiler-"));
  const routesDir = join(outDir, "routes");
  mkdirSync(routesDir, { recursive: true });
  cpSync(join(fixturesDir, name), routesDir, { recursive: true });

  try {
    const nm = join(outDir, "node_modules");
    mkdirSync(join(nm, "@ignex"), { recursive: true });
    symlinkSync(
      join(repoRoot, "node_modules", "@ignex", "core"),
      join(nm, "@ignex", "core"),
      "dir",
    );
    symlinkSync(
      join(repoRoot, "packages", "compiler", "node_modules", "typebox"),
      join(nm, "typebox"),
      "dir",
    );
  } catch {
    // Some CI sandboxes block symlinks — the build still works (AST fallback).
  }
  return { routesDir, outDir };
};

/** Absolute path of a committed fixture file (e.g. an app config). */
export const fixturePath = (name: string, file: string): string => join(fixturesDir, name, file);
