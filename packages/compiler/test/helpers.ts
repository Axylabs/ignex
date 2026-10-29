import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompilerOptions } from "../src/types";

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

  // A shared NON-route `lib/` (app boilerplate such as the withGuards guard
  // template) is copied next to `routes/` — route files import it via
  // `../../lib/...`, and the compiler never scans it as route modules.
  const libDir = join(fixturesDir, "lib");
  if (existsSync(libDir)) {
    cpSync(libDir, join(outDir, "lib"), { recursive: true });
  }

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

/**
 * The default `CompilerOptions` the end-to-end suites build fixtures with:
 * nothing enabled that would make assertions depend on minification, source
 * maps or incremental caching, and every precompile step ON so the compiled
 * validator/serializer paths are exercised rather than the runtime fallbacks.
 *
 * Shared by the six suites that materialize a fixture and compile it — the copy
 * that used to live in each of them silently diverged whenever one suite gained
 * a flag.
 */
export const baseOptions = (
  layout: FixtureLayout,
  extra: Partial<CompilerOptions> = {},
): Partial<CompilerOptions> => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,
  precompileValidators: true,
  precompileSerializers: true,
  ...extra,
});

/**
 * `baseOptions` with every generator AND both precompile steps switched off —
 * the shape the codegen-shape suites use when they assert on the emitted server
 * text alone (no artifacts, no precompiled validator/serializer modules).
 */
export const minimalOptions = (
  layout: FixtureLayout,
  extra: Partial<CompilerOptions> = {},
): Partial<CompilerOptions> => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
  precompileValidators: false,
  precompileSerializers: false,
  ...extra,
});
