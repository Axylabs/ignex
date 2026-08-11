/**
 * @fileoverview Runtime (bun/node) detection shared across CLI commands.
 *
 * `detectRuntime` resolves the executable that runs the generated server;
 * `normalizeRuntime` maps a user preference to a runtime family for
 * scaffolding (create).
 */

import { spawnSync } from "node:child_process";
import { warn } from "./logger.js";

/** True when `command` resolves on PATH and its `--version` invocation succeeds. */
export function commandExists(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Normalize a user-supplied runtime preference (`bun` default, `node` opt-in). */
export function normalizeRuntime(input?: string): "bun" | "node" {
  return input?.toLowerCase() === "node" ? "node" : "bun";
}

/**
 * Resolve the executable used to run the generated server.
 *
 * `--runtime node` resolves a real `node` binary from PATH — never
 * `process.execPath`, which is the Bun binary when the CLI itself runs under
 * Bun. `--runtime bun` prefers Bun with a node fallback; `auto` (default)
 * prefers Bun, then node, then the current runtime.
 */
export function detectRuntime(preferred?: string): string {
  if (preferred === "node") {
    if (commandExists("node")) return "node";
    warn("node not found, falling back to the current runtime");
    return process.execPath;
  }

  if (preferred === "bun") {
    if (process.versions.bun || commandExists("bun")) return "bun";
    warn("bun not found, falling back to node");
    return process.execPath;
  }

  if (preferred !== undefined && preferred !== "auto") {
    warn(`Unknown runtime "${preferred}", defaulting to auto-detection`);
  }

  if (process.versions.bun) return "bun";
  if (commandExists("bun")) return "bun";
  if (commandExists("node")) return "node";
  return process.execPath;
}
