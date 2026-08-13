/**
 * @fileoverview Pure, unit-testable helpers for the `dev` (watch) command.
 *
 * Kept free of side effects so the watch/spawn/rebuild logic can be tested
 * without spawning real processes.
 */

import { isAbsolute, resolve } from "node:path";

const LOCKFILES = new Set(["bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

/** Normalize `outDir` to an absolute, slash-normalized path with no trailing slash. */
export const normalizeOutDir = (outDir: string, root: string): string =>
  (isAbsolute(outDir) ? outDir : resolve(root, outDir)).replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * True when a watched path should NOT trigger a rebuild.
 *
 * `filename` may be relative (recursive watch reports paths relative to the
 * watched root) or absolute. It is resolved against `root`, so build output
 * outside the project root (an absolute or `../` outDir) is also ignored —
 * this prevents the build output from re-triggering the watcher in a loop.
 */
export function shouldIgnore(filename: string, outDir: string, root: string): boolean {
  const absOut = normalizeOutDir(outDir, root);
  const absFile = (isAbsolute(filename) ? filename : resolve(root, filename)).replaceAll("\\", "/");
  const basename = absFile.split("/").pop() ?? "";

  return (
    absFile.includes("/node_modules/") ||
    absFile.startsWith(`${absOut}/`) ||
    absFile === absOut ||
    absFile.includes("/.git/") ||
    absFile.includes("/dist/") ||
    absFile.endsWith(".log") ||
    absFile.endsWith(".ignex-cache.json") ||
    LOCKFILES.has(basename)
  );
}

/** True when `value` is a valid TCP port number (1–65535). */
export function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}
