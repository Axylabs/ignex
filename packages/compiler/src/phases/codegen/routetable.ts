/**
 * @fileoverview Codegen: route table emission (Bun native router) + the 405
 * allowed-methods lookup. Four passes: explicit keys → `__wrap` → auto-HEAD →
 * auto-OPTIONS.
 */

import type { CompilerOptions, RouteIR } from "../../types";
import {
  allowRegExp,
  BUN_ALL_METHODS,
  headConstName,
  routeHandlerName,
  wildcardNames,
  wildcardPrefix,
} from "./identifiers";
import { generateRouteCode } from "./routes/generate";
import type { CodegenState, WrapVariant } from "./state";

type AddRouteEntry = (method: string, path: string, expr: string) => void;

/** Pass 1: emit each route's core function and collect explicit table keys. */
const emitExplicitPass = (
  state: CodegenState,
  routes: readonly RouteIR[],
  opts: CompilerOptions,
  explicitKeys: Set<string>,
  wildcardsByPath: Map<string, string[]>,
): void => {
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
};

/**
 * The table-bound entry for a route. Precedence:
 * 1. `staticResponses` — a pre-built frozen `Response` bound as a VALUE; Bun
 *    serves it natively in Rust (zero per-request JS, native auto-HEAD).
 * 2. The statically-proven wrapper variant recorded in pass 1.
 * Unrecorded routes (WS, or any future early-return path) fall back to the
 * generic runtime-checked `__wrap` — exact prior behavior.
 */
const wrapExpr = (
  state: CodegenState,
  route: RouteIR,
  wildcards: string,
  prefix: string,
): string => {
  const handler = routeHandlerName(route);

  const staticRes = state.staticResponses.get(handler);
  if (staticRes) return staticRes;

  const variant: WrapVariant | undefined = state.wrapVariants.get(handler);
  if (variant === "static-sync") return `__wrapStaticSync(${handler})`;
  if (variant === "static") return `__wrapStatic(${handler})`;
  return `__wrap(${handler}, ${wildcards}, ${prefix})`;
};

/** Pass 2: emit explicit routes wrapped with their recorded variant. */
const emitWrappedPass = (
  state: CodegenState,
  routes: readonly RouteIR[],
  addRouteEntry: AddRouteEntry,
): void => {
  for (const route of routes) {
    const path = route.source.path;
    const wildcards = JSON.stringify(wildcardNames(route.source.path));
    const prefix = JSON.stringify(wildcardPrefix(route.source.path));

    if (route.source.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        addRouteEntry(method, path, wrapExpr(state, route, wildcards, prefix));
      }
    } else {
      const method = route.source.method === "WS" ? "GET" : route.source.method;
      addRouteEntry(method, path, wrapExpr(state, route, wildcards, prefix));
    }
  }
};

/** Pass 3: automatic HEAD handlers for GET routes (unless explicit). */
const emitAutoHeadPass = (
  state: CodegenState,
  routes: readonly RouteIR[],
  explicitKeys: Set<string>,
  addRouteEntry: AddRouteEntry,
): void => {
  for (const route of routes) {
    if (route.source.method !== "GET" && route.source.method !== "ALL") continue;

    const path = route.source.path;
    const wildcards = JSON.stringify(wildcardNames(route.source.path));
    const prefix = JSON.stringify(wildcardPrefix(route.source.path));
    const headKey = `HEAD ${path}`;

    if (!explicitKeys.has(headKey)) {
      // Constant-hoisted GETs whose table entry IS the pre-built Response
      // need no HEAD handler at all — Bun strips the body of HEAD requests
      // to table-bound Response values natively. Dedup members resolve to
      // the leader's ref; heat-captured constants keep their emitted HEAD fn.
      const ref = route.decisions.dedupGroup ?? route.codegen.handlerRef;
      let expr: string;
      if (state.constantGets.has(ref) && state.staticResponses.has(`GET_${ref}`)) {
        continue;
      }
      if (state.constantGets.has(ref)) {
        expr = headConstName(ref);
      } else if (wildcardNames(path).length === 0) {
        expr = `__headStatic(${routeHandlerName(route)})`;
      } else {
        expr = `__head(${routeHandlerName(route)}, ${wildcards}, ${prefix})`;
      }
      addRouteEntry("HEAD", path, expr);
    }
  }
};

/** Pass 4: automatic OPTIONS handlers for CORS preflight (unless explicit). */
const emitAutoOptionsPass = (
  allowMethodsByPattern: Map<string, Set<string>>,
  explicitKeys: Set<string>,
  wildcardsByPath: Map<string, string[]>,
  addRouteEntry: AddRouteEntry,
): void => {
  for (const path of allowMethodsByPattern.keys()) {
    const key = `OPTIONS ${path}`;
    const wildcards = JSON.stringify(wildcardsByPath.get(path) ?? []);
    const prefix = JSON.stringify(wildcardPrefix(path));

    if (!explicitKeys.has(key)) {
      addRouteEntry("OPTIONS", path, `__wrap(__optionsHandler, ${wildcards}, ${prefix})`);
    }
  }
};

export const stageRouteTable = (
  state: CodegenState,
  routes: readonly RouteIR[],
  opts: CompilerOptions,
): void => {
  const { functions } = state;
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

  // Passes: explicit keys → wrapped entries → auto HEAD → auto OPTIONS.
  emitExplicitPass(state, routes, opts, explicitKeys, wildcardsByPath);
  emitWrappedPass(state, routes, addRouteEntry);
  emitAutoHeadPass(state, routes, explicitKeys, addRouteEntry);
  emitAutoOptionsPass(allowMethodsByPattern, explicitKeys, wildcardsByPath, addRouteEntry);

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

  // Emit allowed-methods lookup for 405 responses.
  functions.push(`const __allowedStatic = Object.freeze({ ${allowedStatic.join(", ")} });`);
  functions.push(`const __allowedDynamic = [${allowedDynamic.join(",")}];`);
};
