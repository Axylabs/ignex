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

import { debugStageEnd } from "../debug/tracer";
import { runHooks, runTimed } from "../lifecycle/lifecycle";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, MaybePromise } from "../types";
import type { ContextOptions, IgnexContext, IgnexServer } from "./context";
import { createContext } from "./context";
import { finalizeResponse, jsonReply } from "./finalize";
import { applySet } from "./headers";
import type { RouteDetail, RouteLocalHooks, RouteSchemas } from "./route";
import { runObserveStage, runPostStage, runPreStage, validateSchema } from "./route-stages";
import { compiledPathFor, extractParams, extractServer, pathToRegex } from "./router-utils";

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
  /** Route-local before/after hook chain (the general guard mechanism). */
  readonly config?: RouteLocalHooks;
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
  /** Mutable: an incremental registration can widen a path's method set. */
  allow: string;
}

/** The interpreted router returned by {@link createRouter}. */
export interface IgnexRouter {
  get(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  post(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  put(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  patch(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  delete(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  options(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  head(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
  /** Register `handler` for every standard method on `path`. */
  all(
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter;
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
  /** Dynamic-path allow entries, addressable by pattern for in-place updates. */
  const dynamicAllow = new Map<string, AllowedEntry>();
  /** path → registered methods (incremental; avoids per-registration rebuilds). */
  const methodsByPath = new Map<string, Set<RouterMethod>>();
  /** Exact static paths → registrations in FIRST-registration order (dispatch index). */
  const exactIndex = new Map<string, RouteRegistration[]>();
  /** Dynamic-path registrations (contains `:` or `*`) in registration order. */
  const dynamicRegs: RouteRegistration[] = [];
  /** First registration per `METHOD\0path` — duplicate detection in O(1). */
  const firstByMethodPath = new Map<string, RouteRegistration>();

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
      const r = await runTimed("error", "lifecycle", () => runHooks(s.error, target, err));
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

    // start → request → parse → transform (before validation). The request
    // stage is what creates the trace (the debugbar plugin's onRequest runs
    // inside it), so its waterfall row is recorded once the chain returns.
    const pre = await runPreStage(s.preParse, ctx, "request");
    debugStageEnd("request");
    if (pre.halt) return pre.halt;
    ctx = pre.ctx;

    // Runtime schema validation (no-op when the route has no schema).
    if (reg.schema) await validateSchema(reg.schema, ctx, req);

    const before = await runPreStage(s.beforeHandle, ctx, "beforeHandle");
    if (before.halt) return before.halt;
    ctx = before.ctx;

    // Route-local before chain (the general guard mechanism): runs closest to
    // the handler, after the global beforeHandle stage.
    const localBefore = reg.config?.before ?? [];
    if (localBefore.length > 0) {
      const local = await runPreStage(
        localBefore.map((fn) => (typeof fn === "function" ? { fn } : fn)),
        ctx,
        "route.before",
      );
      if (local.halt) return local.halt;
      ctx = local.ctx;
    }

    const __raw = runTimed("handler", "lifecycle", () => reg.handler(ctx));
    const result = __raw instanceof Promise ? await __raw : __raw;
    let response = finalizeResponse(result, ctx, undefined, jsonReply);

    // Route-local after chain: may replace ctx and/or the response.
    const localAfter = reg.config?.after ?? [];
    if (localAfter.length > 0) {
      ({ ctx, response } = await runPostStage(
        localAfter.map((fn) => (typeof fn === "function" ? { fn } : fn)),
        ctx,
        response,
        "route.after",
      ));
    }

    // afterHandle → mapResponse (may replace ctx and/or the response).
    ({ ctx, response } = await runPostStage(s.afterHandle, ctx, response, "afterHandle"));
    ({ ctx, response } = await runPostStage(s.mapResponse, ctx, response, "mapResponse"));
    await runObserveStage(s.afterResponse, ctx, response, "afterResponse");

    // Single outer applySet (headers/status/cookies exactly once).
    return applySet(response, ctx.set);
  };

  /** Per-route wrapper — the interpreted equivalent of the compiled `core` fn. */
  const wrap = (reg: RouteRegistration): RouteHandlerFn => {
    // Composed ONCE per route at registration: the context options are
    // app-invariant, so only the route pattern differs. Spreading per request
    // cost a `copyDataProperties` object build on every single request.
    const routeCtxOptions = { ...ctxOptions, route: reg.path };

    return async (req, a, b) => {
      const params = extractParams(req, a, b);
      const server = extractServer(a, b);
      let ctx: IgnexContext | undefined;
      try {
        ctx = createContext(req, params ?? EMPTY_PARAMS, routeCtxOptions);
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
    const pre = await runPreStage(s.pre, ctx, "request");
    debugStageEnd("request");
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

    const pre = await runPreStage(s.pre, ctx, "request");
    debugStageEnd("request");
    if (pre.halt) return pre.halt;

    // The fallback path threads the response through the post stages but keeps
    // the pre-stage ctx for the final applySet (matches the compiled __fallback).
    const post = await runPostStage(
      [...s.afterHandle, ...s.mapResponse],
      pre.ctx,
      response,
      "response",
    );
    await runObserveStage(s.afterResponse, pre.ctx, post.response, "afterResponse");
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
    // Memoized: route paths are a finite registration-time set — recompiling
    // the regex per request was pure waste on the interpreted hot path.
    const { re, keys } = compiledPathFor(reg.path);
    const m = re.exec(pathname);
    if (!m) return undefined;
    return Object.fromEntries(keys.map((k, i) => [k, safeDecode(m[i + 1] ?? "")]));
  };

  /** Pass 1 — indexed exact static-path match for `method` (Bun-native specificity). */
  const findExact = (method: string, pathname: string): RouteRegistration | undefined => {
    const bucket = exactIndex.get(pathname);
    if (!bucket) return undefined;
    for (const reg of bucket) {
      if (methodMatches(reg.method, method)) return reg;
    }
    return undefined;
  };

  /** Pass 2 — first dynamic pattern match for `method`, in registration order. */
  const findDynamic = (
    method: string,
    pathname: string,
  ): { reg: RouteRegistration; params: Record<string, string> } | undefined => {
    // Static paths never match a pattern, and pass 1 already covered them —
    // scanning only dynamic registrations keeps pass 2 proportional to the
    // dynamic route count.
    for (const reg of dynamicRegs) {
      if (!methodMatches(reg.method, method)) continue;
      const captured = matchDynamic(reg, pathname);
      if (captured !== undefined) return { reg, params: captured };
    }
    return undefined;
  };

  /** Recompute one path's allow header from its registered methods. */
  const recomputeAllow = (path: string): void => {
    const raw = methodsByPath.get(path);
    if (!raw) return;
    // Bun auto-answers HEAD for GET routes and OPTIONS on every path.
    const effective = new Set(raw);
    if (effective.has("GET")) effective.add("HEAD");
    effective.add("OPTIONS");
    const allow = [...effective].sort().join(",");
    if (path.includes(":") || path.includes("*")) {
      const existing = dynamicAllow.get(path);
      if (existing) {
        existing.allow = allow;
      } else {
        const entry: AllowedEntry = { re: pathToRegex(path).re, allow };
        dynamicAllow.set(path, entry);
        allowedDynamic.push(entry);
      }
    } else {
      allowedStatic[path] = allow;
    }
  };

  /** Rebuild the 405 allow-lists from the current registrations (bulk form). */
  const rebuildAllowed = (): void => {
    methodsByPath.clear();
    dynamicAllow.clear();
    allowedStatic = Object.create(null);
    allowedDynamic = [];
    for (const reg of registrations) {
      let set = methodsByPath.get(reg.path);
      if (!set) {
        set = new Set<RouterMethod>();
        methodsByPath.set(reg.path, set);
      }
      set.add(reg.method);
    }
    for (const path of methodsByPath.keys()) recomputeAllow(path);
  };

  const register = (
    method: RouterMethod,
    path: string,
    handler: RouteRegistration["handler"],
    schema?: RouteSchemas,
    config?: RouteLocalHooks,
  ): IgnexRouter => {
    // exactOptionalPropertyTypes: only include `schema`/`detail`/`config` when
    // defined. `detail` is split out of the schema object into its own
    // registration slot (it decorates the operation, it is not a validated
    // schema part). Route-local `before`/`after` declared in the schema are
    // hoisted into the registration's `config` (the same chain the compiled
    // pipeline reads from `handler.config`).
    const { detail, before, after, ...schemaParts } = schema ?? {};
    const hasSchema = Object.keys(schemaParts).length > 0;
    const localHooks: RouteLocalHooks | undefined =
      before?.length || after?.length
        ? { ...(before?.length ? { before } : {}), ...(after?.length ? { after } : {}) }
        : undefined;
    const reg: RouteRegistration = {
      method,
      path,
      handler,
      ...(hasSchema ? { schema: schemaParts as RouteSchemas } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(localHooks !== undefined ? { config: { ...config, ...localHooks } } : {}),
    };
    registrations.push(reg);
    // Duplicate method+path: `Bun.serve`'s table keeps the LAST registration
    // while programmatic dispatch returns the FIRST — the two entry points
    // would run different handlers for the same route. Warn so the conflict
    // is surfaced instead of silently diverging.
    const dupKey = `${method}\u0000${path}`;
    if (firstByMethodPath.has(dupKey)) {
      console.warn(
        `[ignex] duplicate route registration: ${method} ${path} — the served table uses the LAST handler, dispatch() the FIRST. Remove one of the registrations.`,
      );
    } else {
      firstByMethodPath.set(dupKey, reg);
    }
    // Index + incremental allow-list maintenance: keep `dispatch` / `fetch` /
    // `optionsHandler` correct without a full rebuild per registration.
    const isDynamic = path.includes(":") || path.includes("*");
    if (isDynamic) dynamicRegs.push(reg);
    let bucket = exactIndex.get(path);
    if (!bucket) {
      bucket = [];
      exactIndex.set(path, bucket);
    }
    bucket.push(reg);
    let methods = methodsByPath.get(path);
    if (!methods) {
      methods = new Set<RouterMethod>();
      methodsByPath.set(path, methods);
    }
    methods.add(method);
    recomputeAllow(path);
    return router;
  };

  const router: IgnexRouter = {
    get: (path, handler, schema, config) => register("GET", path, handler, schema, config),
    post: (path, handler, schema, config) => register("POST", path, handler, schema, config),
    put: (path, handler, schema, config) => register("PUT", path, handler, schema, config),
    patch: (path, handler, schema, config) => register("PATCH", path, handler, schema, config),
    delete: (path, handler, schema, config) => register("DELETE", path, handler, schema, config),
    options: (path, handler, schema, config) => register("OPTIONS", path, handler, schema, config),
    head: (path, handler, schema, config) => register("HEAD", path, handler, schema, config),
    all: (path, handler, schema, config) => {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
        register(m, path, handler, schema, config);
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
      const regMethod = methodOrReg.method;
      const regPath = methodOrReg.path;
      const dupKey = `${regMethod}\u0000${regPath}`;
      if (!firstByMethodPath.has(dupKey)) firstByMethodPath.set(dupKey, methodOrReg);
      if (regPath.includes(":") || regPath.includes("*")) dynamicRegs.push(methodOrReg);
      let bucket = exactIndex.get(regPath);
      if (!bucket) {
        bucket = [];
        exactIndex.set(regPath, bucket);
      }
      bucket.push(methodOrReg);
      let methods = methodsByPath.get(regPath);
      if (!methods) {
        methods = new Set<RouterMethod>();
        methodsByPath.set(regPath, methods);
      }
      methods.add(regMethod);
      recomputeAllow(regPath);
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
