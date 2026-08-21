/**
 * @fileoverview Interpreted router — Bun-native `routes` for `createApp`.
 *
 * The interpreted counterpart of the compiler's `stageRouteTable` +
 * `assembleCoreFn` (`compiler/src/phases/codegen/routetable.ts` +
 * `routes/handler.ts`). It registers routes, builds a Bun-native `routes`
 * object (Rust path/method matching — no JS trie, no per-request string
 * scan), and wraps each handler in the same guarded lifecycle as the compiled
 * `core` fn: empty stage chains cost an `if`, not a Promise + microtask.
 *
 * `createApp({ router })` serves the result through
 * `Bun.serve({ routes, fetch })` with the same 404/405/OPTIONS fallback as the
 * compiled `__fallback`, so interpreted apps get the routing story AOT apps
 * get — without a build step.
 */

import { runHooks } from "../lifecycle/lifecycle";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, MaybePromise } from "../types";
import type { ContextOptions, IgnexContext, IgnexServer } from "./context";
import { createContext } from "./context";
import { finalizeResponse, jsonReply } from "./finalize";
import { applySet } from "./headers";
import type { RouteDetail, RouteSchemas } from "./route";
import { runObserveStage, runPostStage, runPreStage, validateSchema } from "./route-stages";
import { extractParams, extractServer, pathToRegex } from "./router-utils";

const EMPTY_PARAMS = Object.freeze({});

/** Standard HTTP methods accepted by Bun's native route table. */
export type RouterMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** A wrapped route handler as registered in the Bun-native `routes` table. */
type RouteHandlerFn = (req: Request, a?: unknown, b?: unknown) => Promise<Response>;

/** A registered route. `schema` enables runtime validation per part. */
export interface RouteRegistration {
  readonly method: RouterMethod;
  /** Route path — Bun syntax (`/api/users/:id`, `/files/*`). */
  readonly path: string;
  readonly handler: (ctx: IgnexContext) => MaybePromise<unknown>;
  readonly schema?: RouteSchemas;
  /** OpenAPI decoration (summary/tags/hide/…); not used for validation. */
  readonly detail?: RouteDetail;
}

/** Lifecycle + context wiring injected by `createApp` at bind time. */
export interface RouterBindOptions {
  /** start → request → parse → transform (run before validation). */
  readonly preParseStages?: readonly HookContainer[];
  readonly beforeHandle?: readonly HookContainer[];
  readonly afterHandle?: readonly HookContainer[];
  readonly mapResponse?: readonly HookContainer[];
  readonly afterResponse?: readonly HookContainer[];
  readonly error?: readonly HookContainer[];
  readonly exposeErrors?: boolean;
  readonly ctx?: ContextOptions;
}

interface BoundStages {
  readonly preParse: readonly HookContainer[];
  readonly beforeHandle: readonly HookContainer[];
  readonly pre: readonly HookContainer[];
  readonly afterHandle: readonly HookContainer[];
  readonly mapResponse: readonly HookContainer[];
  readonly afterResponse: readonly HookContainer[];
  readonly error: readonly HookContainer[];
}

interface AllowedEntry {
  readonly re: RegExp;
  readonly allow: string;
}

/** The interpreted router returned by {@link createRouter}. */
export interface IgnexRouter {
  get(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  post(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  put(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  patch(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  delete(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  options(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  head(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  /** Register `handler` for every standard method on `path`. */
  all(path: string, handler: RouteRegistration["handler"], schema?: RouteSchemas): IgnexRouter;
  /** Generic registration (or pass a `RouteRegistration`). */
  route(
    method: RouterMethod | RouteRegistration,
    path?: string,
    handler?: RouteRegistration["handler"],
    schema?: RouteSchemas,
  ): IgnexRouter;
  /**
   * Snapshot of every registered route (method/path/handler/schema/detail).
   * Used by introspection tooling — e.g. the `openapi()` plugin enumerates
   * routes to build the runtime OpenAPI document.
   */
  listRoutes(): readonly RouteRegistration[];
  /**
   * Inject lifecycle stages + context options. Called by `createApp` once the
   * app lifecycle is composed; returns `this` for chaining.
   */
  bind(options: RouterBindOptions): this;
  /**
   * Build the Bun-native `routes` object for `Bun.serve({ routes })`. Each
   * value is a wrapped handler `(req, params?, server?) => Promise<Response>`.
   * Auto-registers `HEAD` for `GET` routes and a default `OPTIONS` handler.
   */
  buildRoutes(): Record<string, Record<string, RouteHandlerFn>>;
  /**
   * Fallback fetch for unmatched requests (404/405/OPTIONS) — mirrors the
   * compiled `__fallback`. Used as `Bun.serve({ fetch })` and by `dispatch`.
   */
  fetch(req: Request, server?: IgnexServer): Promise<Response>;
  /**
   * Dispatch a request through the registry (JS matching). Used by
   * `createApp().handler()` for non-`serve` callers; `serve()` uses Bun's
   * native `routes` instead.
   */
  dispatch(req: Request, server?: IgnexServer): Promise<Response>;
}

/**
 * Create an interpreted router for `createApp({ router })`.
 *
 * Register routes with the fluent method helpers (`get`/`post`/`put`/…),
 * then pass the router to {@link createApp}. `serve()` builds a Bun-native
 * `routes` table (Rust path/method matching) with a 404/405/OPTIONS fallback;
 * `handler()` dispatches through the registry for non-`serve` callers.
 *
 * ```ts
 * const router = createRouter()
 *   .get("/health", (ctx) => ctx.json({ ok: true }))
 *   .post("/users", usersBody, { body: userSchema });
 * const app = createApp({ router, plugins: [cors()] });
 * ```
 */
export const createRouter = (): IgnexRouter => {
  const registrations: RouteRegistration[] = [];
  let stages: BoundStages | undefined;
  let ctxOptions: ContextOptions | undefined;
  let exposeErrors = false;
  let allowedStatic: Record<string, string> = Object.create(null);
  let allowedDynamic: AllowedEntry[] = [];

  const ensureBound = (): BoundStages =>
    stages ?? {
      preParse: [],
      beforeHandle: [],
      pre: [],
      afterHandle: [],
      mapResponse: [],
      afterResponse: [],
      error: [],
    };

  const handleError = async (err: unknown, ctx: IgnexContext | undefined): Promise<Response> => {
    const s = ensureBound();
    let target = ctx;
    if (!target) {
      target = createContext(new Request("http://ignex.local/"), EMPTY_PARAMS, ctxOptions ?? {});
    }
    try {
      const r = await runHooks(s.error, target, err);
      if (r.response) return applySet(r.response, r.ctx?.set ?? target.set);
    } catch {
      // An error-stage hook that throws must not mask the original error.
    }
    return errorToResponse(err, exposeErrors);
  };

  /** Run the full per-request lifecycle for a matched route (guarded stages). */
  const runRoute = async (
    reg: RouteRegistration,
    initialCtx: IgnexContext,
    req: Request,
  ): Promise<Response> => {
    const s = ensureBound();
    let ctx = initialCtx;

    // A pre-aborted request is short-circuited before any work (matches the
    // interpreted runLifecycle): the handler and hooks never run.
    if (req.signal.aborted) return new Response(null, { status: 200 });

    // start → request → parse → transform (before validation).
    const pre = await runPreStage(s.preParse, ctx);
    if (pre.halt) return pre.halt;
    ctx = pre.ctx;

    // Runtime schema validation (no-op when the route has no schema).
    if (reg.schema) await validateSchema(reg.schema, ctx, req);

    const before = await runPreStage(s.beforeHandle, ctx);
    if (before.halt) return before.halt;
    ctx = before.ctx;

    const result = await reg.handler(ctx);
    let response = finalizeResponse(result, ctx, undefined, jsonReply);

    // afterHandle → mapResponse (may replace ctx and/or the response).
    ({ ctx, response } = await runPostStage(s.afterHandle, ctx, response));
    ({ ctx, response } = await runPostStage(s.mapResponse, ctx, response));
    await runObserveStage(s.afterResponse, ctx, response);

    // Single outer applySet (headers/status/cookies exactly once).
    return applySet(response, ctx.set);
  };

  /** Per-route wrapper — the interpreted equivalent of the compiled `core` fn. */
  const wrap = (reg: RouteRegistration): RouteHandlerFn => {
    return async (req, a, b) => {
      const params = extractParams(req, a, b);
      const server = extractServer(a, b);
      let ctx: IgnexContext | undefined;
      try {
        ctx = createContext(req, params ?? EMPTY_PARAMS, { ...ctxOptions, route: reg.path });
        ctx.server = server ?? null;
        return await runRoute(reg, ctx, req);
      } catch (err) {
        return handleError(err, ctx);
      }
    };
  };

  /** Auto-HEAD wrapper — mirrors the compiled `__head`. */
  const wrapHead =
    (wrapped: (req: Request, a?: unknown, b?: unknown) => Promise<Response>) =>
    async (req: Request, a?: unknown, b?: unknown): Promise<Response> => {
      const res = await wrapped(req, a, b);
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      return new Response(null, { status: res.status, statusText: res.statusText, headers });
    };

  /** Allow-listing for a path (mirrors compiled `__allowFor`). */
  const allowFor = (pathname: string): string | undefined => {
    const exact = allowedStatic[pathname];
    if (exact) return exact;
    for (const entry of allowedDynamic) {
      if (entry.re.test(pathname)) return entry.allow;
    }
    return undefined;
  };

  /** OPTIONS handler (mirrors compiled `__optionsHandler`). */
  const optionsHandler = async (
    req: Request,
    server: IgnexServer | undefined,
  ): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const allow = allowFor(pathname) ?? "OPTIONS";

    const ctx = createContext(req, EMPTY_PARAMS, ctxOptions ?? {});
    ctx.server = server ?? null;

    const s = ensureBound();
    // Run the full pre-handler chain so plugins/hooks apply to preflight too.
    const pre = await runPreStage(s.pre, ctx);
    const response = pre.halt ?? applySet(new Response(null, { status: 204 }), pre.ctx.set);

    const headers = new Headers(response.headers);
    if (!headers.has("access-control-allow-methods")) headers.set("Allow", allow);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  /** Build one path's method table (auto-HEAD + auto-OPTIONS). */
  const buildPathTable = (regs: readonly RouteRegistration[]): Record<string, RouteHandlerFn> => {
    const table: Record<string, RouteHandlerFn> = {};
    let hasGet = false;
    let hasHead = false;
    let hasOptions = false;
    let getReg: RouteRegistration | undefined;
    for (const reg of regs) {
      table[reg.method] = wrap(reg);
      if (reg.method === "GET") {
        hasGet = true;
        getReg = reg;
      } else if (reg.method === "HEAD") {
        hasHead = true;
      } else if (reg.method === "OPTIONS") {
        hasOptions = true;
      }
    }
    if (hasGet && !hasHead && getReg) table.HEAD = wrapHead(wrap(getReg));
    if (!hasOptions) {
      table.OPTIONS = (req: Request, _a?: unknown, b?: unknown) =>
        optionsHandler(req, extractServer(_a, b));
    }
    return table;
  };

  /** Run the lifecycle over a 404/405 fallback response (mirrors compiled). */
  const finalizeFallback = async (
    req: Request,
    server: IgnexServer | undefined,
    response: Response,
  ): Promise<Response> => {
    const s = ensureBound();
    if (
      s.pre.length === 0 &&
      s.afterHandle.length === 0 &&
      s.mapResponse.length === 0 &&
      s.afterResponse.length === 0
    ) {
      return response;
    }
    const ctx = createContext(req, EMPTY_PARAMS, ctxOptions ?? {});
    ctx.server = server ?? null;

    const pre = await runPreStage(s.pre, ctx);
    if (pre.halt) return pre.halt;

    // The fallback path threads the response through the post stages but keeps
    // the pre-stage ctx for the final applySet (matches the compiled __fallback).
    const post = await runPostStage([...s.afterHandle, ...s.mapResponse], pre.ctx, response);
    await runObserveStage(s.afterResponse, pre.ctx, post.response);
    return applySet(post.response, pre.ctx.set);
  };

  /** True when a registered method answers the request method (auto-HEAD → GET). */
  const methodMatches = (regMethod: RouterMethod, method: string): boolean =>
    regMethod === method || (method === "HEAD" && regMethod === "GET");

  /**
   * Decode a captured path segment, keeping the raw (undecoded) text when the
   * percent-encoding is malformed — a client URIError must not become a 500.
   */
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  /** Capture named params from a dynamic match, or `undefined` when no match. */
  const matchDynamic = (
    reg: RouteRegistration,
    pathname: string,
  ): Record<string, string> | undefined => {
    const { re, keys } = pathToRegex(reg.path);
    const m = re.exec(pathname);
    if (!m) return undefined;
    return Object.fromEntries(keys.map((k, i) => [k, safeDecode(m[i + 1] ?? "")]));
  };

  /** Pass 1 — exact static-path match for `method` (Bun-native specificity). */
  const findExact = (method: string, pathname: string): RouteRegistration | undefined => {
    for (const reg of registrations) {
      if (methodMatches(reg.method, method) && reg.path === pathname) return reg;
    }
    return undefined;
  };

  /** Pass 2 — first dynamic pattern match for `method`, in registration order. */
  const findDynamic = (
    method: string,
    pathname: string,
  ): { reg: RouteRegistration; params: Record<string, string> } | undefined => {
    for (const reg of registrations) {
      if (!methodMatches(reg.method, method)) continue;
      const captured = matchDynamic(reg, pathname);
      if (captured !== undefined) return { reg, params: captured };
    }
    return undefined;
  };

  /** Rebuild the 405 allow-lists from the current registrations. */
  const rebuildAllowed = (): void => {
    const byPath = new Map<string, Set<RouterMethod>>();
    for (const reg of registrations) {
      const set = byPath.get(reg.path) ?? new Set<RouterMethod>();
      set.add(reg.method);
      byPath.set(reg.path, set);
    }
    const staticMap: Record<string, string> = Object.create(null);
    const dynamic: AllowedEntry[] = [];
    for (const [path, methods] of byPath) {
      // Bun auto-answers HEAD for GET routes and OPTIONS on every path.
      const effective = new Set(methods);
      if (effective.has("GET")) effective.add("HEAD");
      effective.add("OPTIONS");
      const allow = [...effective].sort().join(",");
      if (path.includes(":") || path.includes("*")) {
        dynamic.push({ re: pathToRegex(path).re, allow });
      } else {
        staticMap[path] = allow;
      }
    }
    allowedStatic = staticMap;
    allowedDynamic = dynamic;
  };

  const register = (
    method: RouterMethod,
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
  ): IgnexRouter => {
    // exactOptionalPropertyTypes: only include `schema`/`detail` when defined.
    // `detail` is split out of the schema object into its own registration
    // slot (it decorates the operation, it is not a validated schema part).
    const { detail, ...schemaParts } = schema ?? {};
    const hasSchema = Object.keys(schemaParts).length > 0;
    const reg: RouteRegistration = {
      method,
      path,
      handler,
      ...(hasSchema ? { schema: schemaParts as RouteSchemas } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
    registrations.push(reg);
    // Keep the 405 allow-lists current at registration time so `dispatch` /
    // `fetch` / `optionsHandler` resolve allows without a prior `buildRoutes()`.
    rebuildAllowed();
    return router;
  };

  const router: IgnexRouter = {
    get: (path, handler, schema) => register("GET", path, handler, schema),
    post: (path, handler, schema) => register("POST", path, handler, schema),
    put: (path, handler, schema) => register("PUT", path, handler, schema),
    patch: (path, handler, schema) => register("PATCH", path, handler, schema),
    delete: (path, handler, schema) => register("DELETE", path, handler, schema),
    options: (path, handler, schema) => register("OPTIONS", path, handler, schema),
    head: (path, handler, schema) => register("HEAD", path, handler, schema),
    all: (path, handler, schema) => {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
        register(m, path, handler, schema);
      }
      return router;
    },
    route: (methodOrReg, path, handler, schema) => {
      if (typeof methodOrReg === "string") {
        if (handler === undefined) {
          throw new Error("router.route(method, path, handler) requires a handler");
        }
        return register(methodOrReg as RouterMethod, path as string, handler, schema);
      }
      registrations.push(methodOrReg);
      rebuildAllowed();
      return router;
    },
    listRoutes: () => registrations.slice(),
    bind: (options) => {
      const preParse = [...(options.preParseStages ?? [])];
      stages = {
        preParse,
        beforeHandle: [...(options.beforeHandle ?? [])],
        pre: [...preParse, ...(options.beforeHandle ?? [])],
        afterHandle: [...(options.afterHandle ?? [])],
        mapResponse: [...(options.mapResponse ?? [])],
        afterResponse: [...(options.afterResponse ?? [])],
        error: [...(options.error ?? [])],
      };
      ctxOptions = options.ctx;
      exposeErrors = options.exposeErrors ?? false;
      return router;
    },
    buildRoutes: () => {
      const routes: Record<string, Record<string, RouteHandlerFn>> = {};
      const byPath = new Map<string, RouteRegistration[]>();
      for (const reg of registrations) {
        const arr = byPath.get(reg.path) ?? [];
        arr.push(reg);
        byPath.set(reg.path, arr);
      }
      for (const [path, regs] of byPath) routes[path] = buildPathTable(regs);
      rebuildAllowed();
      return routes;
    },
    fetch: async (req, server) => {
      const { pathname } = new URL(req.url);

      if (req.method === "OPTIONS") {
        return optionsHandler(req, server);
      }

      const allow = allowFor(pathname);
      const status = allow ? 405 : 404;
      const code = allow ? "METHOD_NOT_ALLOWED" : "NOT_FOUND";
      const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
      if (allow) headers.Allow = allow;

      const response = new Response(
        JSON.stringify({ error: allow ? "Method Not Allowed" : "Not Found", status, code }),
        { status, headers },
      );

      // Run the lifecycle so plugins/hooks (e.g. CORS, security) apply to
      // 404/405 responses too — matching interpreted + compiled behavior.
      return finalizeFallback(req, server, response);
    },
    dispatch: async (req, server) => {
      const { pathname } = new URL(req.url);
      const method = req.method === "HEAD" ? "GET" : req.method;

      // Exact static path first, then dynamic patterns in registration order.
      const exact = findExact(method, pathname);
      let matched = exact;
      let params: Record<string, string> | undefined;
      if (matched === undefined) {
        const dynamic = findDynamic(method, pathname);
        if (dynamic !== undefined) {
          matched = dynamic.reg;
          params = dynamic.params;
        }
      }

      if (matched === undefined) return router.fetch(req, server);
      const wrapped = wrap(matched);
      // Auto-HEAD: when HEAD maps to a GET route (no explicit HEAD route), the
      // body must be stripped — mirrors the compiled `__head`.
      const finalWrapped =
        req.method === "HEAD" && matched.method === "GET" ? wrapHead(wrapped) : wrapped;
      return finalWrapped(req, params, server);
    },
  };

  return router;
};
