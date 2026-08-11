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
 * import { get } from "@flux/core/http";
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
import type { FluxContext } from "./context";

/** Any schema-shaped object accepted by the route helpers. */
export type SchemaLike = AnySchema | object;

export type RouteSchemas = {
  body?: SchemaLike;
  query?: SchemaLike;
  params?: SchemaLike;
  headers?: SchemaLike;
  response?: SchemaLike | Record<number, SchemaLike>;
};

export type BodyRouteSchemas = RouteSchemas;
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

export type RouteContext<S extends Partial<RouteSchemas>> = Omit<
  FluxContext<InferParams<S>, InferQuery<S>, InferBody<S>>,
  "body" | "query"
> & {
  body: TypedLazyBody<InferBody<S>>;
  query: InferQuery<S>;
};

type RouteResult<S extends Partial<RouteSchemas>> = MaybePromise<Response | InferResponse<S>>;

export type RouteHandler<S extends Partial<RouteSchemas>> = (
  ctx: RouteContext<S>,
) => RouteResult<S>;

/**
 * Backward-compatible handler type.
 */
export type Handler<B = unknown, Q = URLSearchParams, P = Record<string, string>> = (
  ctx: FluxContext<P, Q, B>,
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

/** Path is inferred from filename. Second parameter is a schema object. */
export function get<const S extends NoBodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}

/** Path is inferred from filename. Second parameter is a schema object. */
export function post<const S extends BodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}

/** Path is inferred from filename. Second parameter is a schema object. */
export function put<const S extends BodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}

/** Path is inferred from filename. Second parameter is a schema object. */
export function patch<const S extends BodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}

/** Path is inferred from filename. Second parameter is a schema object. */
export function del<const S extends BodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}

/** Path is inferred from filename. Second parameter is a schema object. */
export function all<const S extends BodyRouteSchemas = {}>(
  fn: RouteHandler<S>,
  schema?: S,
): RouteHandler<S> {
  return attachSchema(fn, schema);
}
