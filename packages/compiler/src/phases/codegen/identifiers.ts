/**
 * @fileoverview Codegen: generated-identifier naming conventions.
 *
 * Every name the emitter produces for a route/helper lives here so naming
 * stays consistent and is easy to change in one place.
 */

import type { RouteDef } from "../../types";

export const handlerImportName = (route: RouteDef): string => `handler_${route.codegen.handlerRef}`;

export const methodHandlerName = (route: RouteDef): string =>
  `${route.source.method}_${route.codegen.handlerRef}`;

export const constantBodyVar = (route: RouteDef): string => `BODY_${route.codegen.handlerRef}`;

export const constantInitVar = (route: RouteDef): string => `INIT_${route.codegen.handlerRef}`;

export const hookIdent = (name: string): string => `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

export const cacheVar = (route: RouteDef): string => `CACHE_${route.codegen.handlerRef}`;

export const coreHandlerName = (route: RouteDef, hasCache: boolean): string =>
  hasCache ? `core_${route.codegen.handlerRef}` : methodHandlerName(route);

export const validatorImportName = (route: RouteDef, kind: string): string =>
  `validate_${route.codegen.handlerRef}_${kind}`;

export const serializerImportName = (route: RouteDef, status: string): string =>
  `serialize_${route.codegen.handlerRef}_${status}`;

export const routeReplyFn = (route: RouteDef): string => {
  if (route.analysis.responseType === "text") return "textReply";
  if (route.analysis.responseType === "html") return "htmlReply";
  if (route.analysis.responseType === "stream") return "streamReply";
  return "jsonReply";
};

/** Extract `*name` wildcard identifiers from a path. */
export const wildcardNames = (path: string): string[] =>
  Array.from(path.matchAll(/\*([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);

/**
 * Static URL prefix before the first wildcard segment (e.g. `/files/` for
 * `/files/*path`). Bun does not expose wildcard captures in `req.params` on
 * some versions (verified on Bun 1.4), so the generated `__wrap` derives the
 * captured suffix by stripping this prefix from the request path.
 */
export const wildcardPrefix = (path: string): string => {
  const idx = path.indexOf("*");
  return idx === -1 ? "" : path.slice(0, idx);
};

// ── Route-table naming ───────────────────────────────────────────

export const BUN_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source for an exact-path matcher with `:param`/`*wildcard` segments. */
export const allowRegExp = (path: string): string => {
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment.startsWith("*")) return ".*";
      return escapeRegExp(segment);
    })
    .join("/");

  return `^${pattern}$`;
};

/** Handler name used in the route table, honoring deduplication. */
export const routeHandlerName = (route: RouteDef): string =>
  route.decisions.dedupGroup
    ? `${route.source.method}_${route.decisions.dedupGroup}`
    : methodHandlerName(route);
