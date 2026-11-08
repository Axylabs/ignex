/**
 * @fileoverview Plugin Registry — the init/close lifecycle driver.
 *
 * Tracks registered plugins and named hooks, and runs every plugin's `init` /
 * `close` lifecycle with `allSettled` semantics so one plugin's failure never
 * skips the rest.
 */

import { reportPluginBootFailure } from "../../platform/boot-failure";
import type { HookFn } from "../hooks";
import type { IgnexPlugin, PluginContext } from "./types";

/**
 * Create an empty {@link PluginContext}.
 *
 * `initAll`/`closeAll` run every plugin's lifecycle with `allSettled`, so a
 * single plugin's failure never skips the rest (`closeAll` runs in reverse
 * registration order — onion cleanup).
 */
export const createPluginContext = (): PluginContext => {
  const hooks = new Map<string, HookFn[]>();
  const plugins: IgnexPlugin[] = [];

  return {
    plugins,
    hooks,
    addHook(name, hook) {
      const existing = hooks.get(name) ?? [];
      existing.push(hook);
      hooks.set(name, existing);
    },
    getHooks(name) {
      return hooks.get(name) ?? [];
    },
    register(plugin) {
      plugins.push(plugin);
    },
    async initAll() {
      // Registration order is the dependency contract. Run every plugin even
      // after a failure, but never run dependent initializers concurrently.
      const failures: Error[] = [];
      for (const plugin of plugins) {
        try {
          await plugin.init?.();
        } catch (error) {
          failures.push(reportPluginBootFailure(plugin.name ?? "anonymous plugin", error));
        }
      }
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, `${failures.length} plugin(s) failed to initialize`);
      }
    },
    async closeAll() {
      // Reverse (onion) order: last registered closes first. allSettled ensures
      // one plugin's close failure never skips the remaining plugins' cleanup.
      const results = await Promise.allSettled([...plugins].reverse().map((p) => p.close?.()));
      for (const r of results) {
        if (r.status === "rejected") console.error("[ignex] plugin close failed:", r.reason);
      }
    },
  };
};
