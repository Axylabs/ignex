/**
 * @fileoverview Plugin Registry — the init/close lifecycle driver.
 *
 * Tracks registered plugins and named hooks, and runs every plugin's `init` /
 * `close` lifecycle with `allSettled` semantics so one plugin's failure never
 * skips the rest.
 */

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
      // Run every plugin's init even if one fails; report failures but don't
      // leave later plugins un-initialized. If any init failed, rethrow so
      // callers can fail CLOSED (`createApp({ strictInit: true })` never binds
      // the listener) — `Promise.allSettled` guarantees later plugins still
      // ran regardless.
      const results = await Promise.allSettled(plugins.map((p) => p.init?.()));
      const failures: unknown[] = [];
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[ignex] plugin init failed:", r.reason);
          failures.push(r.reason);
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
