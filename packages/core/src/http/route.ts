/**
 * @fileoverview Schema-first typed route definitions (`get` / `post` / …).
 *
 * Route files export a handler wrapped in an HTTP method helper. The route
 * path is inferred from the filename by the compiler (not passed here); the
 * optional second argument is a validation schema (TypeBox `TSchema`, a
 * Standard Schema, or a raw object).
 *
 * Example:
 * ```ts
 * import { get } from "@ignex/core/http";
 * import { Type } from "typebox";
 *
 * export default get(async (ctx) => ctx.json({ q: ctx.query.q }), {
 *   query: Type.Object({ q: Type.String() }),
 * });
 * ```
 *
 * The schemas type the handler's `ctx` (`params`, `query`, `body`) and the
 * allowed return value via {@link RouteHandler}.
 */

import type { Static, TSchema } from "typebox";
import type { HookFn } from "../lifecycle/hooks";
import type { AnySchema, MaybePromise, StandardSchemaV1 } from "../types";
import type { LazyBody } from "./body";
import type { IgnexContext } from "./context";

/** Any schema-shaped object accepted by the route helpers. */
export type SchemaLike = AnySchema | object;

/**
 * A route-local AFTER hook: runs once the handler produced a `Response`, with
 * the final ctx. May replace the response (`Response` or `{ response }`),
 * replace the ctx (`{ ctx }`), halt with `{ ok: false, response }`, or return
 * `undefined` to pass through untouched (the common case for logging/audit).
 */
export type AfterHookFn = (
  ctx: IgnexContext,
  response: Response,
) => MaybePromise<
  | Response
  | { ok: false; response: Response }
  | { ctx?: IgnexContext; response?: Response }
  | undefined
>;

/**
 * Route-local hook chain — the general per-route guard/middleware mechanism.
 * `before` hooks run in order right before the handler (each may halt with a
 * `Response`, e.g. 401/403); `after` hooks run right after the handler with
 * the response, before the global afterHandle stage.
 *
 * Attach via a route file's `export const config = { before, after }` or by
 * attaching `handler.config` (the app's own guard templates do the latter).
 * Entries are plain functions; the runtime normalizes them like any hook.
 */
export interface RouteLocalHooks {
  /** Run in order before the handler. `HookFn` = `(ctx) => {ok,ctx}|{ok:false,response}`. */
  before?: readonly HookFn[];
  /** Run in order after the handler, threading ctx + response. */
  after?: readonly AfterHookFn[];
}

/**
 * OpenAPI operation decoration, mirroring Elysia's `DocumentDecoration`
 * (a subset of the OpenAPI OperationObject). Consumed only by the OpenAPI
 * generator — never validated at runtime.
 */
export type RouteDetail = {
  summary?: string;
  description?: string;
  tags?: string[];
  /** Pass `true` to hide the route from the OpenAPI document. */
  hide?: boolean;
  operationId?: string;
  deprecated?: boolean;
  security?: unknown;
  /** Any other OpenAPI OperationObject field (e.g. response overrides). */
  [key: string]: unknown;
};

/** The per-route input/output schemas accepted by the route DSL helpers. */
export type RouteSchemas = {
  body?: SchemaLike;
  query?: SchemaLike;
  params?: SchemaLike;
  headers?: SchemaLike;
  /** Cookie-header schemas are supported by the compiler and the interpreted router. */
  cookie?: SchemaLike;
  response?: SchemaLike | Record<number, SchemaLike>;
  /**
   * OpenAPI operation decoration (summary/tags/hide/…). Not validated.
   * Targets interpreted `createRouter()` registrations; AOT route files
   * attach `detail` via `export const config = { detail }` instead.
   */
  detail?: RouteDetail;
};

/**
 * @deprecated Alias of {@link RouteSchemas} kept for back-compat. Prefer
 * `RouteSchemas` for body-capable methods.
 */
export type BodyRouteSchemas = RouteSchemas;
/**
 * @deprecated Alias of `Omit<RouteSchemas, "body">` kept for back-compat.
 * Prefer the inline `Omit` for body-less methods.
 */
export type NoBodyRouteSchemas = Omit<RouteSchemas, "body">;

// `any` in the conditional types below is intentional: it must match a
// Standard Schema of any input type to infer its *output* (the value the
// schema validates/produces). Replacing it with `unknown` would stop the
// conditional from matching concrete schemas.
type InferSchema<T> =
  T extends StandardSchemaV1<any, infer Output>
    ? Output
    : T extends TSchema
      ? Static<T>
      : T extends { static: infer S }
        ? S
        : unknown;

type InferBody<S> = S extends { body: infer X } ? InferSchema<X> : unknown;

type InferQuery<S> = S extends { query: infer X } ? InferSchema<X> : URLSearchParams;

type InferParams<S> = S extends { params: infer X } ? InferSchema<X> : Record<string, string>;

type LooksLikeSchema<T> =
  T extends StandardSchemaV1<any, any>
    ? true
    : T extends { "~standard": unknown }
      ? true
      : T extends TSchema
        ? true
        : T extends { static: unknown }
          ? true
          : T extends { type: string }
            ? true
            : false;

type InferResponse<S> = S extends { response: infer R }
  ? LooksLikeSchema<R> extends true
    ? InferSchema<R>
    : R extends Record<string, infer V>
      ? InferSchema<V>
      : unknown
  : unknown;

type TypedLazyBody<B> = {
  json<T = B>(): Promise<T>;
  form<T = B extends Record<string, unknown> ? B : Record<string, string>>(): Promise<T>;
  multipart<T = B extends Record<string, unknown> ? B : Record<string, unknown>>(): Promise<T>;
} & LazyBody;

/**
 * The handler context for a route with its schema inferred: `params`/`query`
 * and a typed `body` (with typed `json`/`form`/`multipart` accessors).
 */
export type RouteContext<S extends Partial<RouteSchemas>> = Omit<
  IgnexContext<InferParams<S>, InferQuery<S>, InferBody<S>>,
  "body" | "query"
> & {
  body: TypedLazyBody<InferBody<S>>;
  query: InferQuery<S>;
};

/**
 * The allowed return value of a route handler.
 *
 * All forms below are valid in BOTH the interpreted (`createApp`) and the
 * AOT-compiled pipeline, but they are NOT equal at compile time. Prefer the
 * forms that let the compiler optimize the response at build time:
 *
 * 1. `ctx.json(data)` / `ctx.text(data)` / `ctx.html(data)` — the compiler
 *    replaces these with precompiled `jsonReply`/`textReply`/`htmlReply`
 *    helpers that encode the body ONCE (`TextEncoder`), set an exact
 *    `content-length` (so compression never buffers), and route through the
 *    precompiled `fast-json-stringify` serializer when a response schema is
 *    present. **This is the default recommended form.**
 * 2. A plain value (`InferResponse<S>`) matching the `response` schema — the
 *    compiled `__finalize` serializes it with the precompiled serializer.
 *    Compile-time-constant literals are additionally hoisted to zero-cost
 *    frozen response bodies.
 * 3. `{ status, body }` ({@link StatusBodyResult}) — multi-status responses,
 *    serialized against the schema for that status.
 *
 * Returning a raw `Response` (e.g. `Response.json(...)` or `new Response(...)`)
 * is a passthrough: the compiled pipeline leaves it untouched. This is needed
 * for streams, files, SSE, redirects and proxies, but it BYPASSES the
 * compile-time optimizations above (no pre-encoding, no `content-length`,
 * no schema serializer). Prefer `ctx.*` / plain values unless you must build
 * a `Response` yourself.
 */
type RouteResult<S extends Partial<RouteSchemas>> = MaybePromise<
  Response | InferResponse<S> | StatusBodyResult<S>
>;

/**
 * Multi-status response wrapper `{ status, body }` — the compiled runtime
 * serializes `body` against the response schema for the matching status (each
 * status key maps to its own schema, so `status: 201` types `body` as the
 * 201 schema's output, not the union).
 */
type StatusBodyResult<S extends Partial<RouteSchemas>> = S extends { response: infer R }
  ? R extends Record<number, unknown>
    ? { [K in keyof R]: { status: K; body: InferSchema<R[K]> } }[keyof R]
    : { status: number; body: InferResponse<S> }
  : { status: number; body: InferResponse<S> };

/**
 * A route handler: receives the schema-typed {@link RouteContext} and returns
 * a response.
 *
 * Prefer returning `ctx.json(...)` / `ctx.text(...)` or a plain value
 * validated against the `response` schema — both are AOT-optimized at compile
 * time (pre-encoded body, exact `content-length`, precompiled serializer).
 * Returning a raw `Response` is a passthrough and skips those optimizations;
 * reserve it for streams, files, SSE, redirects and proxies (see
 * {@link RouteResult} for the full contract).
 */
export type RouteHandler<S extends Partial<RouteSchemas>> = (
  ctx: RouteContext<S>,
) => RouteResult<S>;

/**
 * Backward-compatible handler type.
 */
export type Handler<B = unknown, Q = URLSearchParams, P = Record<string, string>> = (
  ctx: IgnexContext<P, Q, B>,
) => MaybePromise<unknown>;

type AnyFunction = (...args: any[]) => any;

const attachSchema = <T extends AnyFunction>(fn: T, schemaOrPath?: unknown): T => {
  // Runtime compatibility: if an old path string is passed, ignore it.
  if (schemaOrPath == null || typeof schemaOrPath === "string") {
    return fn;
  }

  Object.defineProperty(fn, "schema", {
    value: schemaOrPath,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  return fn;
};

/**
 * Route-method factory. Each exported helper (`get`/`post`/…) is a one-line
 * instantiation of this curried factory; the bound schema constraint is what
 * differs — body-less methods use `NoBodyRouteSchemas`, body methods use
 * `BodyRouteSchemas`. Per-method type inference is preserved.
 */
const defineMethod =
  <S extends Partial<RouteSchemas>>() =>
  <const T extends S>(fn: RouteHandler<T>, schema?: T): RouteHandler<T> =>
    attachSchema(fn, schema);

/** Path is inferred from filename. Second parameter is a schema object. */
export const get = defineMethod<NoBodyRouteSchemas>();

/** Path is inferred from filename. Second parameter is a schema object. */
export const post = defineMethod<BodyRouteSchemas>();

/** Path is inferred from filename. Second parameter is a schema object. */
export const put = defineMethod<BodyRouteSchemas>();

/** Path is inferred from filename. Second parameter is a schema object. */
export const patch = defineMethod<BodyRouteSchemas>();

/** Path is inferred from filename. Second parameter is a schema object. */
export const del = defineMethod<BodyRouteSchemas>();

/** Path is inferred from filename. Second parameter is a schema object. */
export const all = defineMethod<BodyRouteSchemas>();

/**
 * Path is inferred from filename. Second parameter is a schema object.
 * `HEAD` is fully supported end-to-end: route files ending in `.head.ts` are
 * discovered by the compiler and the runtime maps `GET` routes to automatic
 * `HEAD` responses when no explicit `HEAD` route exists.
 */
export const head = defineMethod<NoBodyRouteSchemas>();

/**
 * Path is inferred from filename. Second parameter is a schema object.
 * `OPTIONS` is fully supported end-to-end: `.options.ts` route files are
 * discovered by the compiler and the runtime emits an automatic 204
 * `Allow`-listing `OPTIONS` response when no explicit route exists.
 *
 * NOTE: there are intentionally no `connect`/`trace` helpers. Bun's native
 * route table only accepts the standard `HTTP_METHODS` subset; shipping DSL
 * helpers that can't be routed would create unroutable route files.
 */
export const options = defineMethod<NoBodyRouteSchemas>();
