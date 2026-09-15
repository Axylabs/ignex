/**
 * Shared context usage flags used by both compiler and runtime.
 *
 * This removes duplicated ContextUsage definitions between:
 * - src/compiler/types.ts
 * - src/core/types.ts
 */

/**
 * Bitmap of request-context capabilities actually used by a route handler.
 *
 * Shared by compiler and runtime: the compiler statically computes which
 * `ctx` members a handler touches and records them in this record, and the
 * generated server uses it to emit only the context plumbing the routes need.
 * Every member must mirror the matching `IgnexContext` field in `@ignex/core`.
 */
export interface ContextUsage {
  body: boolean;
  params: boolean;
  query: boolean;
  file: boolean;
  headers: boolean;
  state: boolean;

  json: boolean;
  text: boolean;
  html: boolean;
  redirect: boolean;
  stream: boolean;
  empty: boolean;
  status: boolean;

  req: boolean;
  url: boolean;
  /**
   * `ctx.method`. Distinct from {@link url} on purpose: the two used to share
   * one flag, so a handler that only read `ctx.method` got a specialized
   * context carrying `url` and NOT `method` — reading `undefined` at runtime.
   */
  method: boolean;
  /**
   * `ctx.path`. Distinct from {@link url} for the same reason as `method`: it
   * shared the `url` flag while nothing emitted a `path` member, so
   * `ctx.path` was `undefined` on a specialized route.
   */
  path: boolean;

  cookie: boolean;
  server: boolean;
  set: boolean;

  sendFile: boolean;
  proxy: boolean;
  forward: boolean;
  cache: boolean;
  loader: boolean;
  /** `ctx.debug` (the debugbar tracing API) was read. */
  debug: boolean;
}

/** A `ContextUsage` with every capability disabled (frozen). */
export const EMPTY_USAGE: ContextUsage = Object.freeze({
  body: false,
  params: false,
  query: false,
  file: false,
  headers: false,
  state: false,

  json: false,
  text: false,
  html: false,
  redirect: false,
  stream: false,
  empty: false,
  status: false,

  req: false,
  url: false,
  method: false,
  path: false,

  cookie: false,
  server: false,
  set: false,

  sendFile: false,
  proxy: false,
  forward: false,
  cache: false,
  loader: false,
  debug: false,
});

/** A `ContextUsage` with every capability enabled (frozen). */
export const FULL_USAGE: ContextUsage = Object.freeze({
  body: true,
  params: true,
  query: true,
  file: true,
  headers: true,
  state: true,

  json: true,
  text: true,
  html: true,
  redirect: true,
  stream: true,
  empty: true,
  status: true,

  req: true,
  url: true,
  method: true,
  path: true,

  cookie: true,
  server: true,
  set: true,

  sendFile: true,
  proxy: true,
  forward: true,
  cache: true,
  loader: true,
  debug: true,
});
