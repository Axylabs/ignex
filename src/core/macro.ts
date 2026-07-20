/**
 * @fileoverview Macro System — Custom lifecycle extensions.
 * Allows plugins to define custom route-level configuration.
 */

import type { FluxContext } from "./context";
import type { LifeCycleStore, HookContainer } from "./types";

export interface MacroContext {
  onRequest?: (ctx: FluxContext) => void;
  beforeHandle?: (ctx: FluxContext) => void;
  afterHandle?: (ctx: FluxContext, response: Response) => void;
  afterResponse?: (ctx: FluxContext, response: Response) => void;
}

export type MacroFn = (value: unknown, ctx: MacroContext) => void;

export interface MacroDefinition {
  name: string;
  fn: MacroFn;
}

export const createMacroRegistry = () => {
  const macros = new Map<string, MacroFn>();

  return {
    register(name: string, fn: MacroFn) {
      macros.set(name, fn);
      return this;
    },

    apply(routeConfig: Record<string, unknown>, lifecycle: LifeCycleStore): LifeCycleStore {
      const macroCtx: MacroContext = {};

      for (const [key, value] of Object.entries(routeConfig)) {
        const macro = macros.get(key);
        if (macro && value !== undefined) {
          macro(value, macroCtx);
        }
      }

      // Convert macro context hooks to lifecycle hooks
      const hooks: HookContainer[] = [];
      if (macroCtx.beforeHandle) hooks.push({ fn: macroCtx.beforeHandle, scope: "local" });
      if (macroCtx.afterHandle) hooks.push({ fn: macroCtx.afterHandle, scope: "local" });

      return {
        ...lifecycle,
        beforeHandle: [...lifecycle.beforeHandle, ...hooks],
      };
    },

    has(name: string): boolean { return macros.has(name); },
    get size(): number { return macros.size; },
  };
};

// ============================================================================
// Built-in Macros
// ============================================================================

export const authMacro: MacroDefinition = {
  name: "auth",
  fn(value, ctx) {
    if (value === true) {
      ctx.beforeHandle = (c: FluxContext) => {
        if (!c.headers.get("authorization")) {
          c.setState("__halt", Response.json({ error: "Unauthorized" }, { status: 401 }));        }
      };
    }
  },
};

export const cacheMacro: MacroDefinition = {
  name: "cache",
  fn(value, ctx) {
    if (typeof value === "number") {
      ctx.afterHandle = (_c: FluxContext, response: Response) => {
        response.headers.set("cache-control", `public, max-age=${value}`);
      };
    }
  },
};