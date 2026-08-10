/**
 * Macro System
 *
 * Fixed:
 * - afterHandle can return Response
 * - afterHandle hooks are placed in afterHandle lifecycle
 */

import { type JwtAuthOptions, jwtAuth } from "./auth";
import type { FluxContext } from "./context";
import { createCsrfGuard } from "./csrf";
import { envSecret } from "./env";
import type { HookFn } from "./hooks";
import { type SessionManagerOptions, withSession } from "./session";
import type { HookContainer, LifeCycleStore } from "./types";

export interface MacroContext {
  onRequest?: (ctx: FluxContext) => Response | void | Promise<Response | void>;
  beforeHandle?: (ctx: FluxContext) => Response | void | Promise<Response | void>;
  afterHandle?: (
    ctx: FluxContext,
    response: Response,
  ) => Response | void | Promise<Response | void>;
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

      const requestHooks: HookContainer[] = [];
      const beforeHooks: HookContainer[] = [];
      const afterHooks: HookContainer[] = [];

      if (macroCtx.onRequest) {
        requestHooks.push({ fn: macroCtx.onRequest, scope: "local" });
      }

      if (macroCtx.beforeHandle) {
        beforeHooks.push({ fn: macroCtx.beforeHandle, scope: "local" });
      }

      if (macroCtx.afterHandle) {
        afterHooks.push({ fn: macroCtx.afterHandle, scope: "local" });
      }

      return {
        ...lifecycle,
        request: [...lifecycle.request, ...requestHooks],
        beforeHandle: [...lifecycle.beforeHandle, ...beforeHooks],
        afterHandle: [...lifecycle.afterHandle, ...afterHooks],
      };
    },

    has(name: string): boolean {
      return macros.has(name);
    },

    get size(): number {
      return macros.size;
    },
  };
};

export const authMacro: MacroDefinition = {
  name: "auth",
  fn(value, ctx) {
    if (value === true) {
      ctx.beforeHandle = (c: FluxContext) => {
        if (!c.headers.get("authorization")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      };
    }
  },
};

export const cacheMacro: MacroDefinition = {
  name: "cache",
  fn(value, ctx) {
    if (typeof value === "number") {
      ctx.afterHandle = (_c: FluxContext, response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("cache-control", `public, max-age=${value}`);

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };
    }
  },
};

/** Convert a `HookFn`-shaped guard into the macro `beforeHandle` shape. */
const asBeforeHandle =
  (hook: HookFn) =>
  async (ctx: FluxContext): Promise<Response | void> => {
    const result = await hook(ctx);
    return result.ok ? undefined : result.response;
  };

export const csrfMacro: MacroDefinition = {
  name: "csrf",
  fn(value, ctx) {
    if (value === true || typeof value === "string") {
      const secret = typeof value === "string" ? value : envSecret("CSRF_SECRET");
      const hook = createCsrfGuard({ secret });
      ctx.beforeHandle = asBeforeHandle(hook);
    }
  },
};

export const sessionMacro: MacroDefinition = {
  name: "session",
  fn(value, ctx) {
    if (value && typeof value === "object") {
      const hook = withSession(value as SessionManagerOptions);
      ctx.beforeHandle = asBeforeHandle(hook);
    }
  },
};

export const jwtMacro: MacroDefinition = {
  name: "jwt",
  fn(value, ctx) {
    if (typeof value === "string") {
      const hook = jwtAuth({ secret: value });
      ctx.beforeHandle = asBeforeHandle(hook);
    } else if (value && typeof value === "object") {
      const hook = jwtAuth(value as JwtAuthOptions);
      ctx.beforeHandle = asBeforeHandle(hook);
    }
  },
};
