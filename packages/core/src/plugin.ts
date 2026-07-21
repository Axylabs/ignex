/**
 * @fileoverview Plugin Architecture v3.1
 * Lifecycle hooks, extensibility, composable plugins.
 */

import type { FluxContext } from "./context";
import type { HookFn } from "./hooks";
import type { HookContainer, LifeCycleStore } from "./types";

// ============================================================================
// Plugin Interface
// ============================================================================

export interface FluxPlugin {
  readonly name: string;
  readonly version?: string;

  // Lifecycle
  init?(): MaybePromise<void>;
  close?(): MaybePromise<void>;

  // Request lifecycle
  onRequest?(ctx: FluxContext): MaybePromise<FluxContext | Response>;
  onResponse?(ctx: FluxContext, response: Response): MaybePromise<Response>;
  onError?(error: Error, ctx: FluxContext): MaybePromise<Response | void>;
}

type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Plugin Registry
// ============================================================================

export interface PluginContext {
  plugins: FluxPlugin[];
  hooks: Map<string, HookFn[]>;
  addHook(name: string, hook: HookFn): void;
  getHooks(name: string): readonly HookFn[];
  register(plugin: FluxPlugin): void;
  initAll(): Promise<void>;
  closeAll(): Promise<void>;
}

export const createPluginContext = (): PluginContext => {
  const hooks = new Map<string, HookFn[]>();
  const plugins: FluxPlugin[] = [];

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
      for (const p of plugins) await p.init?.();
    },
    async closeAll() {
      for (const p of plugins) await p.close?.();
    },
  };
};

// ============================================================================
// Plugin Composition
// ============================================================================

export const composePlugins = (...plugins: FluxPlugin[]): FluxPlugin => ({
  name: plugins.map((p) => p.name).join("+"),
  async init() {
    for (const p of plugins) await p.init?.();
  },
  async close() {
    for (const p of [...plugins].reverse()) await p.close?.();
  },
  async onRequest(ctx) {
    let current = ctx;
    for (const p of plugins) {
      const result = await p.onRequest?.(current);
      if (result instanceof Response) return result;
      if (result) current = result;
    }
    return current;
  },
  async onResponse(ctx, response) {
    let current = response;
    for (const p of [...plugins].reverse()) {
      current = (await p.onResponse?.(ctx, current)) ?? current;
    }
    return current;
  },
  async onError(error, ctx) {
    for (const p of plugins) {
      const result = await p.onError?.(error, ctx);
      if (result instanceof Response) return result;
    }
  },
});

// ============================================================================
// Plugin -> Lifecycle Bridge
// ============================================================================

function isFluxPlugin(value: unknown): value is FluxPlugin {
  return typeof value === "object" && value !== null && "name" in value;
}

export const pluginsToLifeCycle = (
  plugins: unknown[],
): Partial<LifeCycleStore> => {
  const list = (plugins ?? [])
    .flat()
    .filter(isFluxPlugin);

  const request: HookContainer[] = list
    .filter((p) => typeof p.onRequest === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: FluxContext) => {
        const result = await p.onRequest!(ctx);
        if (result instanceof Response) {
          return { response: result };
        }
        if (result) {
          return { ctx: result };
        }
        return { ctx };
      },
    }));

  const afterHandle: HookContainer[] = list
    .filter((p) => typeof p.onResponse === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: FluxContext, response: Response) => {
        const result = await p.onResponse!(ctx, response);
        if (result instanceof Response) {
          return { response: result };
        }
        return {};
      },
    }));

  const error: HookContainer[] = list
    .filter((p) => typeof p.onError === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: FluxContext, error: unknown) => {
        const result = await p.onError!(error as Error, ctx);
        if (result instanceof Response) {
          return { response: result };
        }
        return {};
      },
    }));

  return {
    request,
    afterHandle,
    error,
  };
};