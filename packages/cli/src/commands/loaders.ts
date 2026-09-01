/**
 * @fileoverview Lazy command loaders.
 *
 * The root citty app and `ignex help` both resolve command definitions from
 * this map. Every entry is a dynamic import so `ignex` boots without loading
 * the compiler/core/mcp stacks until a command actually needs them.
 */

import type { CommandDef } from "citty";

/**
 * A lazily-loaded command module. Every command file exports its
 * `defineCommand` definition as `default`; `CommandDef<any>` is used so typed
 * definitions (whose `args`/`run` close over a specific `ArgsDef`) are
 * assignable regardless of their concrete arg shape.
 */
type LoadableCommand = { default: CommandDef<any> };

/** Command name → lazy loader. Keys must match registry rows 1:1. */
export const loaders: Record<string, () => Promise<LoadableCommand>> = {
  create: () => import("./create.js"),
  route: () => import("./route.js"),
  event: () => import("./event.js"),
  hook: () => import("./hook.js"),
  model: () => import("./model.js"),
  resource: () => import("./resource.js"),
  hotroute: () => import("./hotroute.js"),
  factory: () => import("./factory.js"),
  migrate: () => import("./migrate.js"),
  seed: () => import("./seed.js"),
  dev: () => import("./dev.js"),
  build: () => import("./build.js"),
  doctor: () => import("./doctor.js"),
  info: () => import("./info.js"),
  "route:list": () => import("./route-list.js"),
  tinker: () => import("./tinker.js"),
  "queue:work": () => import("./queue-work.js"),
  "schedule:run": () => import("./schedule-run.js"),
  ops: () => import("./ops.js"),
  sdk: () => import("./sdk.js"),
  help: () => import("./help.js"),
  completions: () => import("./completions.js"),
  mcp: () => import("./mcp.js"),
  _complete: () => import("./complete.js"),
};

/**
 * Resolve a command definition (default export) by registry name or alias.
 *
 * @returns The citty command definition, or `undefined` for unknown names.
 */
export async function loadCommand(nameOrAlias: string): Promise<CommandDef<any> | undefined> {
  const { findCommand } = await import("./registry.js");
  const row = findCommand(nameOrAlias);
  if (!row) return undefined;
  return (await loaders[row.name]?.())?.default;
}
