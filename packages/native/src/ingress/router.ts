/**
 * @fileoverview Per-route native ingress router (`createNativeIngressRouter`) —
 * the "one super solution" over the global pipeline: each route in the table
 * compiles a DEDICATED native pipeline pruned to EXACTLY that route's stages
 * (castrum's `createIngressRouter` model), plus the LEAN native-stack responder
 * route kind wired through `createNativeRoute`/`nativeRouteHandler`.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */

import type { NativeRouteResponder } from "../native-handler";
import { nativeRouteHandler } from "../native-handler";
import type { NativeIngressOptions } from "../pipeline";
import { createNativeRoute } from "../route";
import type { NativeRoutePlan } from "../route-wire";
import type { NativeIngress, NativeIngressRuntime } from "./factory";
import { createNativeIngress } from "./factory";
import { safeDecodeParam } from "./verdict";

/** Per-route spec for {@link createNativeIngressRouter}. */
export interface NativeIngressRouterRoute {
  /** Per-route ingress options — compiled into a DEDICATED native pipeline. */
  options?: NativeIngressOptions;
  /**
   * A LEAN native-stack responder route (synced from castrum's router `native`
   * kind): the route-wire v3 per-route stack (`createNativeRoute` over
   * `castrum_route_*`) runs ONLY the stages in `plan`
   * (parseQuery/parseCookies/requireJsonBody/validateBody) in ONE native
   * call — no CORS/rate-limit/security/IP/metadata envelope. On a verdict
   * failure the route rejects (400 non-JSON / 422 schema); on success the
   * responder builds the 2xx from the decoded snapshot. Wired for `methods`
   * (default `['GET']`). When set, `options` for this route is ignored.
   */
  native?: {
    /** The route-wire v3 plan (parse/validate stages + limits). */
    plan: NativeRoutePlan;
    /** The JS 2xx builder (receives the decoded query/cookies/body snapshot). */
    handler: NativeRouteResponder;
    /** HTTP methods to wire (default `['GET']`). */
    methods?: ReadonlyArray<string>;
    /** Read the body for `requireJsonBody`/`validateBody` (default false). */
    readBody?: boolean;
  };
}

/** Options for {@link createNativeIngressRouter}. */
export interface CreateNativeIngressRouterOptions {
  /** Route table: path → per-route ingress options. */
  routes: Record<string, NativeIngressRouterRoute>;
  /** Shared runtime (security headers / output buffer) applied to every route. */
  runtime?: NativeIngressRuntime;
  /**
   * Responder for non-terminal (OK) requests — the app's own handler. The
   * router serves the pipeline's terminal decision (CORS/429/413/400/422)
   * and delegates the OK path to this. Default: a JSON `{"ok":true}` 200.
   */
  fallback?: (req: Request) => Response | Promise<Response>;
  /** Pre-warm every compiled route's pipeline at construction. Default: false. */
  warmOnCreate?: boolean;
}

/** A compiled per-route native ingress router. */
export interface NativeIngressRouter {
  /** Per-path compiled pre-flight instances (null when a path could not compile). */
  routeHandlers: Record<string, NativeIngress | null>;
  /** Bun.serve-compatible route table (each method → the pre-flight handler). */
  routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;
  /** Path matcher (`:param` / `*` dynamic routes), most-specific-first. */
  match(pathname: string): { path: string; params: Record<string, string> } | undefined;
  /** Pre-warm every compiled route (JIT the pipeline + FFI call). */
  prewarm(): Promise<void>;
}

const ROUTER_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Compile a `:param` / `*` route path into a RegExp + param names. */
function compileRoutePath(path: string): { re: RegExp; params: string[]; staticSegments: number } {
  const params: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg === "*") return "(?:/(.*))?";
      if (seg.startsWith(":")) {
        params.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${src}\\/?$`), params, staticSegments: path.split("/").length };
}

/**
 * Compile a route table into per-route native ingress pipelines. Each route
 * with `options` compiles its OWN `createNativeIngress` — a dedicated
 * `IngressInner` pruned to that route's stages + per-route header plan (routes
 * needing nothing gather ZERO headers). `routes` is Bun.serve-compatible;
 * `match`/`prewarm` mirror castrum's `createIngressRouter`.
 */
export const createNativeIngressRouter = (
  options: CreateNativeIngressRouterOptions,
): NativeIngressRouter | null => {
  const runtime = options.runtime ?? {};
  const fallback =
    options.fallback ?? ((_req: Request): Response => new Response('{"ok":true}', { status: 200 }));

  const compiled: Record<string, NativeIngress | null> = {};
  const routeTable: Record<
    string,
    Record<string, (req: Request) => Response | Promise<Response>>
  > = {};

  for (const [path, spec] of Object.entries(options.routes)) {
    // LEAN native-stack responder route: the route-wire v3 stack runs ONLY the
    // plan's stages (no full IngressInner, no CORS/rate-limit/security). The
    // compiled route is injected into the pure responder factory (the compile
    // touches the dlopen layer here).
    if (spec.native) {
      const nativeRoute = createNativeRoute(spec.native.plan);
      if (nativeRoute === null) continue; // addon lacks the route surface → skip
      const handler = nativeRouteHandler(
        nativeRoute,
        spec.native.handler,
        spec.native.readBody !== undefined ? { readBody: spec.native.readBody } : {},
      );
      const methods: Record<string, (req: Request) => Response | Promise<Response>> = {};
      for (const m of spec.native.methods ?? ["GET"]) methods[m] = handler;
      routeTable[path] = methods;
      compiled[path] = null;
      continue;
    }

    const ingress = createNativeIngress(spec.options ?? {}, runtime);
    compiled[path] = ingress;
    if (!ingress) continue;
    // Per-route pre-flight handler: serve the pipeline's terminal decision,
    // else delegate the OK path to the app's fallback responder.
    const handler = async (req: Request): Promise<Response> => {
      // Sync fast path: the C-ABI core returns the outcome directly, so branch
      // on Promise instead of awaiting unconditionally — avoids a per-request
      // await suspension + microtask (the async fn still yields to Bun.serve).
      const outcome = ingress.preprocess(req);
      const { terminal, response } = outcome instanceof Promise ? await outcome : outcome;
      return terminal && response ? response : fallback(req);
    };
    const methods: Record<string, (req: Request) => Response | Promise<Response>> = {};
    for (const m of ROUTER_METHODS) methods[m] = handler;
    routeTable[path] = methods;
  }

  // Most-specific-first matcher (static segments desc, then fewer params).
  const patterns = Object.entries(compiled)
    .filter(([, ing]) => ing !== null)
    .map(([path]) => ({ path, ...compileRoutePath(path) }))
    .sort((a, b) => b.staticSegments - a.staticSegments || a.params.length - b.params.length);

  const match = (
    pathname: string,
  ): { path: string; params: Record<string, string> } | undefined => {
    for (const p of patterns) {
      const m = p.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < p.params.length; i++)
        params[p.params[i] as string] = safeDecodeParam(m[i + 1] ?? "");
      return { path: p.path, params };
    }
    return undefined;
  };

  const prewarm = async (): Promise<void> => {
    const probe = new Request("http://localhost:0/prewarm", { method: "GET" });
    for (const ing of Object.values(compiled)) {
      if (ing) await ing.preprocess(probe);
    }
  };

  if (options.warmOnCreate) void prewarm();

  return { routeHandlers: compiled, routes: routeTable, match, prewarm };
};
