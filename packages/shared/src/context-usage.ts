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
 * Every member must mirror the matching `IgnusContext` field in `@ignus/core`.
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

  cookie: boolean;
  server: boolean;
  set: boolean;

  sendFile: boolean;
  proxy: boolean;
  forward: boolean;
  cache: boolean;
  loader: boolean;
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

  cookie: false,
  server: false,
  set: false,

  sendFile: false,
  proxy: false,
  forward: false,
  cache: false,
  loader: false,
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

  cookie: true,
  server: true,
  set: true,

  sendFile: true,
  proxy: true,
  forward: true,
  cache: true,
  loader: true,
});
