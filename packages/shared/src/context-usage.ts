/**
 * Shared context usage flags used by both compiler and runtime.
 *
 * This removes duplicated ContextUsage definitions between:
 * - src/compiler/types.ts
 * - src/core/types.ts
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
