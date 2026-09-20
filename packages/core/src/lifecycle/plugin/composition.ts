/**
 * @fileoverview Plugin Composition — onion-order plugin aggregation.
 *
 * `composePlugins` fuses a plugin list into a single plugin whose stages run
 * in the same order the app lifecycle would run them. Also home to the
 * route-pattern matcher compiler (`createPatternMatcher`), the ONCE-per-plugin
 * pathname gate used by the lifecycle bridge.
 */

import type { IgnexPlugin, RoutePattern } from "./types";

/**
 * Compose multiple plugins into one, running their stages in onion order.
 *
 * `init` runs in registration order; `close`/`onResponse` in reverse.
 */
export const composePlugins = (...plugins: IgnexPlugin[]): IgnexPlugin => ({
  name: plugins.map((p) => p.name).join("+"),
  routes(router) {
    for (const p of plugins) p.routes?.(router);
  },
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

const escapeRegExpChars = (src: string): string => src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a route pattern into a pathname matcher, ONCE per plugin:
 *  - `string` — exact (`"/health"`), prefix-wildcard (`"/api/admin/*"`, which
 *    also matches `/api/admin` itself), or internal wildcard (`"/files/*.ts"`).
 *    `"*"` matches every pathname.
 *  - `RegExp` — tested against the pathname (`lastIndex` reset so global/sticky
 *    flags never corrupt repeated tests).
 *  - `(pathname) => boolean` — a custom predicate.
 */
export const createPatternMatcher = (pattern?: RoutePattern): ((pathname: string) => boolean) => {
  if (pattern === undefined) return () => true;
  if (typeof pattern === "function") return pattern;
  if (pattern instanceof RegExp) {
    const re = pattern;
    return (pathname: string) => {
      re.lastIndex = 0;
      return re.test(pathname);
    };
  }
  if (pattern === "*") return () => true;
  if (!pattern.includes("*")) return (pathname: string) => pathname === pattern;

  const body = pattern.replace(/\/\*$/, "");
  if (body !== pattern) {
    // Trailing `/*` (or `*`) — prefix scope: the base path AND everything
    // below it match (`/api/admin`, `/api/admin/x`, `/api/admin/x/y`).
    const re = new RegExp(`^${escapeRegExpChars(body)}(?:/.*)?$`);
    return (pathname: string) => re.test(pathname);
  }
  // Internal wildcards: each `*` matches any run of non-slash chars.
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExpChars).join("[^/]*")}$`);
  return (pathname: string) => re.test(pathname);
};
