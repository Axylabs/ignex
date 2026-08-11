/**
 * @fileoverview Codegen: route table emission (Bun native router) + the 405
 * allowed-methods lookup. Four passes: explicit keys → `__wrap` → auto-HEAD →
 * auto-OPTIONS.
 */

import type { CompilerOptions, RouteDef } from "../../types";
import {
  allowRegExp,
  BUN_ALL_METHODS,
  routeHandlerName,
  wildcardNames,
  wildcardPrefix,
} from "./identifiers";
import { generateRouteCode } from "./routes";
import type { CodegenState } from "./state";

export const stageRouteTable = (
  state: CodegenState,
  routes: readonly RouteDef[],
  opts: CompilerOptions,
): void => {
  const { helpers, functions } = state;
  const { routeEntries, explicitKeys, allowMethodsByPattern, wildcardsByPath } = state;

  const addAllowed = (method: string, path: string) => {
    const set = allowMethodsByPattern.get(path) ?? new Set<string>();
    set.add(method);
    allowMethodsByPattern.set(path, set);
  };

  const addRouteEntry = (method: string, path: string, expr: string) => {
    const existing = routeEntries.get(path);
    const methods = existing ?? new Map<string, string>();
    if (!existing) {
      routeEntries.set(path, methods);
    }
    if (!methods.has(method)) {
      methods.set(method, expr);
    }
    addAllowed(method, path);
  };

  // First pass: collect explicit keys (and emit each route's core function).
  for (const route of routes) {
    generateRouteCode(state, route, opts);

    const path = route.source.path;
    wildcardsByPath.set(path, wildcardNames(route.source.path));

    if (route.source.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        explicitKeys.add(`${method} ${path}`);
      }
    } else {
      // WS routes upgrade on a GET request — register under GET so auto
      // HEAD/OPTIONS and 405 handling treat them like a plain GET route.
      const keyMethod = route.source.method === "WS" ? "GET" : route.source.method;
      explicitKeys.add(`${keyMethod} ${path}`);
    }
  }

  // Second pass: emit explicit routes wrapped with __wrap for error handling.
  for (const route of routes) {
    helpers.markUsed("__wrap");

    const path = route.source.path;
    const wildcards = JSON.stringify(wildcardNames(route.source.path));
    const prefix = JSON.stringify(wildcardPrefix(route.source.path));
    const handler = routeHandlerName(route);

    if (route.source.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        addRouteEntry(method, path, `__wrap(${handler}, ${wildcards}, ${prefix})`);
      }
    } else {
      const method = route.source.method === "WS" ? "GET" : route.source.method;
      addRouteEntry(method, path, `__wrap(${handler}, ${wildcards}, ${prefix})`);
    }
  }

  // Third pass: automatic HEAD for GET routes.
  for (const route of routes) {
    if (route.source.method !== "GET" && route.source.method !== "ALL") continue;

    const path = route.source.path;
    const wildcards = JSON.stringify(wildcardNames(route.source.path));
    const prefix = JSON.stringify(wildcardPrefix(route.source.path));
    const headKey = `HEAD ${path}`;

    if (!explicitKeys.has(headKey)) {
      helpers.markUsed("__head");
      addRouteEntry("HEAD", path, `__head(${routeHandlerName(route)}, ${wildcards}, ${prefix})`);
    }
  }

  // Fourth pass: automatic OPTIONS handlers for CORS preflight.
  for (const path of allowMethodsByPattern.keys()) {
    const key = `OPTIONS ${path}`;
    const wildcards = JSON.stringify(wildcardsByPath.get(path) ?? []);
    const prefix = JSON.stringify(wildcardPrefix(path));

    if (!explicitKeys.has(key)) {
      helpers.markUsed("__optionsHandler");
      addRouteEntry("OPTIONS", path, `__wrap(__optionsHandler, ${wildcards}, ${prefix})`);
    }
  }

  // Build the __allowed lookup for 405 responses. Static paths get an O(1)
  // object lookup; only dynamic patterns (with :params or *wildcards) need a
  // regex scan, so the hot 404/405 path avoids scanning every route.
  const allowedStatic: string[] = [];
  const allowedDynamic: string[] = [];

  for (const [path, set] of allowMethodsByPattern.entries()) {
    const allow = JSON.stringify([...set].join(","));
    const entry = `{ re: new RegExp(${JSON.stringify(allowRegExp(path))}), allow: ${allow} }`;

    if (path.includes(":") || path.includes("*")) {
      allowedDynamic.push(entry);
    } else {
      allowedStatic.push(`${JSON.stringify(path)}: ${allow}`);
    }
  }

  const routeLines: string[] = [];
  for (const [path, methods] of routeEntries) {
    if (methods.size === 1) {
      // Explicitly guard the single-entry read instead of `[...entries()][0]!` —
      // the `size === 1` check above should guarantee it, but a non-null
      // assertion would silently corrupt output if the guard ever changed.
      const entry = methods.entries().next().value;
      if (entry) {
        const [method, expr] = entry;
        routeLines.push(`  ${JSON.stringify(path)}: { ${method}: ${expr} },`);
      }
    } else {
      const methodEntries = [...methods.entries()].map(([m, e]) => `    ${m}: ${e},`).join("\n");
      routeLines.push(`  ${JSON.stringify(path)}: {\n${methodEntries}\n  },`);
    }
  }
  functions.push(`const __routes = {\n${routeLines.join("\n")}\n};`);

  // Emit allowed-methods lookup for 405 (__allowFor / __fallback are helpers).
  functions.push(`const __allowedStatic = Object.freeze({ ${allowedStatic.join(", ")} });`);
  functions.push(`const __allowedDynamic = [${allowedDynamic.join(",")}];`);
  helpers.markUsed("__allowFor");
  helpers.markUsed("__fallback");
};
