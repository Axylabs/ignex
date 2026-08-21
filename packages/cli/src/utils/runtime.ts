/**
 * @fileoverview Runtime (bun) detection shared across CLI commands.
 *
 * The generated server is Bun-only (`Bun.serve` is emitted with no Node
 * shim), so `bun` is the only runtime. `detectRuntime` resolves the
 * executable that runs the generated server; `normalizeRuntime` maps a user
 * preference to the runtime family for scaffolding (create) — always bun.
 */

import { commandExistsBun } from "./bun-compat.js";
import { warn } from "./logger.js";

/** True when `command` resolves on PATH and its `--version` invocation succeeds. */
export function commandExists(command: string): boolean {
  return commandExistsBun(command);
}

/**
 * Normalize a user-supplied runtime preference. The generated server requires
 * Bun, so `node` is not a supported target — a `--runtime node` request warns
 * and falls back to bun (never scaffolds a server that cannot boot).
 */
export function normalizeRuntime(input?: string): "bun" {
  if (input?.toLowerCase() === "node") {
    warn(
      "--runtime node is not supported: the generated server requires Bun (Bun.serve is emitted with no Node shim). Defaulting to bun.",
    );
  }
  return "bun";
}

/**
 * Resolve the executable used to run the generated server (always Bun).
 *
 * `auto` (default) prefers Bun, then falls back to the current runtime when
 * Bun is unavailable on PATH (edge case — the CLI itself requires Bun).
 */
export function detectRuntime(preferred?: string): string {
  if (preferred === "node") {
    warn(
      "--runtime node is not supported: the generated server requires Bun. Running with bun instead.",
    );
  }

  if (preferred === "bun") {
    if (process.versions.bun || commandExists("bun")) return "bun";
    warn("bun not found, falling back to the current runtime");
    return process.execPath;
  }

  if (preferred !== undefined && preferred !== "auto" && preferred !== "node") {
    warn(`Unknown runtime "${preferred}", defaulting to auto-detection`);
  }

  if (process.versions.bun) return "bun";
  if (commandExists("bun")) return "bun";
  return process.execPath;
}
