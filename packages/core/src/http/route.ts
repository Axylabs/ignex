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
 * import { Type } from "@sinclair/typebox";
 *
 * export default get(async (ctx) => ctx.json({ q: ctx.query.q }), {
 *   query: Type.Object({ q: Type.String() }),
 * });
 * ```
 *
 * The schemas type the handler's `ctx` (`params`, `query`, `body`) and the
 * allowed return value via {@link RouteHandler}.
 */

import type { AnySchema, MaybePromise, StandardSchemaV1 } from "../types";
import type { LazyBody } from "./body";
import type { IgnexContext } from "./context";

/** Any schema-shaped object accepted by the route helpers. */
export type SchemaLike = AnySchema | object;

/** The per-route input/output schemas accepted by the route DSL helpers. */
export type RouteSchemas = {
  body?: SchemaLike;
  query?: SchemaLike;
  params?: SchemaLike;
  headers?: SchemaLike;
  response?: SchemaLike | Record<number, SchemaLike>;
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
 * a response (or a plain value validated against the response schema).
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
